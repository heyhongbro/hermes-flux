/**
 * 文件预览派生资源协调器 (packages/desktop/src/renderer/services/previewAssetCoordinator.ts)
 *
 * 【设计意图 (Why)】
 *   统一编排 InspectionPod / MobileInspector 中 HTML、SVG、Markdown 三类可渲染文档的
 *   相对路径子资源解析与生命周期清理：
 *   1. HTML (`.html`/`.htm`)：Tier 1 向宿主注册 `hermes-preview://` 或 `/__preview/`
 *      特权预览会话，iframe 保持 `sandbox="allow-scripts"` 原生解析 `./`/`../`/`/`；
 *      若宿主不支持特权协议或注册失败，自动降级为 Tier 2 `buildInlinedHtmlPreview`
 *      生成只读派生 `srcdoc`；
 *   2. SVG (`.svg`)：通过 `buildInlinedSvgPreview` 将内部 `<image href>` 内联为派生 Data URL；
 *   3. Markdown (`.md`/`.markdown`)：委托共享内核 `handleMarkdownPreviewClick` 与
 *      `hydrateMarkdownPreviewAssets` 完成点击导航、灯箱与 DOM 异步水合。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 严格保持非破坏性：绝不修改 `openFile.content`、磁盘文件或远端文件，只更新 `openFile.preview`
 *      派生投影，确保 Raw 查看、复制、搜索与下载始终拿到原始源码；
 *   2. 快速切换/关闭页签竞态：每次异步解析绑定递增 revision 与原文快照，过期结果必须主动吊销
 *      刚生成的 `previewToken` 且不得回写旧状态；
 *   3. Markdown DOM 水合直接就地设置 `src`/`srcset` 属性，不触发 `render()`，防止滚动重置或闪屏。
 *
 * 【约束与规则 (Rules)】
 *   - 外部 `http(s)://` CDN 不经过本协调器代理，保留直连；
 *   - 关闭页签时主动调用 `revokeOpenFilePreview` 回收主进程/开发服务器会话内存。
 */

import {
  buildInlinedHtmlPreview,
  buildInlinedSvgPreview,
  isPreviewAssetPathAllowed,
  resolveEffectivePreviewScopeRoot,
  resolvePreviewAsset,
  type HermesGatewayClient,
} from '@hermes-flux/core';
export { resolveEffectivePreviewScopeRoot as resolveEffectiveScopeRoot };
import {
  handleMarkdownPreviewClick,
  hydrateMarkdownPreviewAssets,
  SAFE_HYDRATE_MEDIA_URL_RE,
  type MediaLightboxItem,
} from '@hermes-flux/ui';
import type { HermesDesktopBridge } from '../../preload/index.js';
import { resolveActiveWorkspaceCwd, type AppState } from '../state/appState.js';

export interface PreviewAssetCoordinatorDeps {
  getState: () => AppState;
  render: () => void;
  getDesktopApi: () => HermesDesktopBridge | undefined;
  getGatewayClient: () => HermesGatewayClient | null;
  resolveMediaUrl?: (pathOrUrl: string) => Promise<string | null>;
  onOpenFilePreview?: (targetPath: string) => Promise<void>;
  onOpenMediaLightbox?: (items: readonly MediaLightboxItem[], initialIndex: number) => void;
  maxBundledAssets?: number;
  maxBundledAssetBytes?: number;
  maxBundledTotalBytes?: number;
}

export interface PreviewAssetCoordinator {
  prepareOpenFilePreview(filePath: string): Promise<void>;
  revokeOpenFilePreview(filePath: string): void;
  revokeAll(): void;
  bindMarkdownContainer(mdEl: HTMLElement): void;
}

export function createPreviewAssetCoordinator(
  deps: PreviewAssetCoordinatorDeps,
): PreviewAssetCoordinator {
  const previewTokens = new Map<string, string>();
  const prepareRevisions = new Map<string, number>();

  const readEffectiveProfile = (state: AppState): string | undefined =>
    state.activeFocus?.type === 'group' ? undefined : state.profileName || undefined;

  const resolveWorkspaceRootForState = (state: AppState): string => {
    const cwd = resolveActiveWorkspaceCwd(state);
    if (cwd) return cwd;
    return state.fileTreeState?.status === 'ready' ? state.fileTreeState.rootPath || '' : '';
  };

  function revokeTokenSilently(token: string): void {
    const api = deps.getDesktopApi();
    if (typeof api?.revokePreviewSession === 'function') {
      void api.revokePreviewSession(token).catch((err) => {
        console.warn('[previewAssetCoordinator] revokePreviewSession failed:', err);
      });
    }
  }

  function revokeOpenFilePreview(filePath: string): void {
    if (!filePath) return;
    prepareRevisions.set(filePath, (prepareRevisions.get(filePath) ?? 0) + 1);
    const activeToken = previewTokens.get(filePath);
    if (activeToken) {
      previewTokens.delete(filePath);
      revokeTokenSilently(activeToken);
    }
  }

  function revokeAll(): void {
    for (const filePath of Array.from(previewTokens.keys())) {
      revokeOpenFilePreview(filePath);
    }
  }

  async function prepareOpenFilePreview(filePath: string): Promise<void> {
    if (!filePath) return;
    const state = deps.getState();
    const openFile = state.openFiles.find((f) => f.path === filePath);
    if (
      !openFile ||
      openFile.isLoading ||
      openFile.isBinary ||
      openFile.isTooLarge ||
      openFile.isVideo ||
      openFile.source === 'fallback'
    ) {
      return;
    }

    const cleanPath = openFile.path.split(/[?#]/)[0];
    const dotIdx = cleanPath.lastIndexOf('.');
    const ext = dotIdx >= 0 ? cleanPath.slice(dotIdx + 1).toLowerCase() : '';
    const isHtml = ext === 'html' || ext === 'htm';
    const isSvg = ext === 'svg';
    const isMarkdown = ext === 'md' || ext === 'markdown';
    if (!isHtml && !isSvg && !isMarkdown) return;

    const rev = (prepareRevisions.get(filePath) ?? 0) + 1;
    prepareRevisions.set(filePath, rev);

    const globalWorkspaceRoot = resolveWorkspaceRootForState(state);
    const workspaceRoot = resolveEffectivePreviewScopeRoot(filePath, globalWorkspaceRoot);
    const entryContent = openFile.content;
    const entrySource = openFile.source;
    const gatewayUrl = state.gatewayUrl || undefined;
    const profile = readEffectiveProfile(state);
    const sessionId = state.activeSessionId || undefined;
    const desktopApi = deps.getDesktopApi();

    const findCurrentTarget = () => {
      if (prepareRevisions.get(filePath) !== rev) return undefined;
      const curState = deps.getState();
      const target = curState.openFiles.find((f) => f.path === filePath);
      if (!target || target.content !== entryContent) return undefined;
      return target;
    };

    if (isMarkdown) {
      openFile.preview = {
        ...openFile.preview,
        workspaceRoot: workspaceRoot || openFile.preview?.workspaceRoot,
        revision: rev,
      };
      return;
    }

    if (!entryContent.trim()) return;

    if (isHtml) {
      if (typeof desktopApi?.registerPreviewSession === 'function') {
        try {
          const reg = await desktopApi.registerPreviewSession({
            entryPath: filePath,
            entryContent,
            workspaceRoot: globalWorkspaceRoot || undefined,
            gatewayUrl,
            profile,
            sessionId,
            source: entrySource,
          });
          if (reg && reg.entryUrl) {
            const currentTarget = findCurrentTarget();
            if (!currentTarget) {
              revokeTokenSilently(reg.token);
              return;
            }
            const prevToken = previewTokens.get(filePath);
            if (prevToken && prevToken !== reg.token) {
              revokeTokenSilently(prevToken);
            }
            previewTokens.set(filePath, reg.token);
            currentTarget.preview = {
              ...currentTarget.preview,
              frameUrl: reg.entryUrl,
              previewToken: reg.token,
              inlinedHtml: undefined,
              workspaceRoot: workspaceRoot || undefined,
              revision: rev,
            };
            deps.render();
            return;
          }
        } catch (err) {
          console.warn('[previewAssetCoordinator] registerPreviewSession failed, falling back to Tier 2:', err);
        }
      }

      if (prepareRevisions.get(filePath) !== rev) return;

      const bundled = await buildInlinedHtmlPreview(entryContent, {
        documentPath: filePath,
        workspaceRoot: workspaceRoot || undefined,
        enforceWorkspaceScope: Boolean(workspaceRoot),
        platformBridge: desktopApi ?? null,
        gatewayUrl,
        profile,
        sessionId,
        sourceHint: entrySource,
        messages: state.messages,
        maxAssets: deps.maxBundledAssets,
        maxAssetBytes: deps.maxBundledAssetBytes,
        maxTotalBytes: deps.maxBundledTotalBytes,
      });

      const currentTarget = findCurrentTarget();
      if (!currentTarget) return;
      if (bundled.inlinedCount > 0 || bundled.html !== entryContent) {
        currentTarget.preview = {
          ...currentTarget.preview,
          frameUrl: undefined,
          previewToken: undefined,
          inlinedHtml: bundled.html,
          workspaceRoot: workspaceRoot || undefined,
          revision: rev,
        };
        deps.render();
      }
      return;
    }

    const svgResult = await buildInlinedSvgPreview(entryContent, {
      documentPath: filePath,
      workspaceRoot: workspaceRoot || undefined,
      enforceWorkspaceScope: Boolean(workspaceRoot),
      platformBridge: desktopApi ?? null,
      gatewayUrl,
      profile,
      sessionId,
      sourceHint: entrySource,
      messages: state.messages,
      maxAssets: deps.maxBundledAssets,
      maxAssetBytes: deps.maxBundledAssetBytes,
      maxTotalBytes: deps.maxBundledTotalBytes,
    });
    const currentTarget = findCurrentTarget();
    if (!currentTarget || !svgResult || (svgResult.inlinedCount <= 0 && svgResult.failedRefs.length === 0)) return;
    currentTarget.preview = {
      ...currentTarget.preview,
      inlinedImageUrl: svgResult.dataUrl,
      workspaceRoot: workspaceRoot || undefined,
      revision: rev,
    };
    deps.render();
  }

  function bindMarkdownContainer(mdEl: HTMLElement): void {
    mdEl.onclick = (e) => {
      handleMarkdownPreviewClick(e, mdEl, {
        onOpenFile: deps.onOpenFilePreview
          ? (nextFile) => {
              void deps.onOpenFilePreview!(nextFile);
            }
          : undefined,
        onOpenMediaLightbox: deps.onOpenMediaLightbox,
      });
    };

    const readAttr = (name: string): string =>
      typeof mdEl.getAttribute === 'function' ? mdEl.getAttribute(name) || '' : '';
    const docPath = readAttr('data-doc-path');
    const state = deps.getState();
    const initialOpenFile = docPath ? state.openFiles.find((f) => f.path === docPath) : undefined;
    const initialContent = initialOpenFile?.content;
    const rawWorkspaceRoot =
      readAttr('data-workspace-root') ||
      initialOpenFile?.preview?.workspaceRoot ||
      resolveWorkspaceRootForState(state);
    const workspaceRoot = resolveEffectivePreviewScopeRoot(docPath, rawWorkspaceRoot);

    const isStale = (): boolean => {
      if (!docPath) return false;
      const curFile = deps.getState().openFiles.find((f) => f.path === docPath);
      return !curFile || curFile.content !== initialContent;
    };

    hydrateMarkdownPreviewAssets({
      root: mdEl,
      isCancelled: isStale,
      resolveAssetUrl: async (assetPath, allowVideoStreamUrl) => {
        if (
          !isPreviewAssetPathAllowed(assetPath, {
            workspaceRoot: workspaceRoot || undefined,
            enforceWorkspaceScope: Boolean(docPath || workspaceRoot),
          })
        ) {
          return null;
        }
        const curFile = docPath ? deps.getState().openFiles.find((f) => f.path === docPath) : undefined;
        const cachedUrl = curFile?.preview?.resolvedAssets?.[assetPath];
        if (cachedUrl && SAFE_HYDRATE_MEDIA_URL_RE.test(cachedUrl)) {
          return cachedUrl;
        }
        try {
          if (!allowVideoStreamUrl && deps.resolveMediaUrl) {
            const mediaHit = await deps.resolveMediaUrl(assetPath);
            if (mediaHit && SAFE_HYDRATE_MEDIA_URL_RE.test(mediaHit)) {
              recordResolvedAsset(docPath, workspaceRoot, assetPath, mediaHit);
              return mediaHit;
            }
          }
          const latestState = deps.getState();
          const res = await resolvePreviewAsset(assetPath, {
            platformBridge: deps.getDesktopApi() ?? null,
            gatewayUrl: latestState.gatewayUrl || undefined,
            profile: readEffectiveProfile(latestState),
            sessionId: latestState.activeSessionId || undefined,
            workspaceRoot: workspaceRoot || undefined,
            enforceWorkspaceScope: Boolean(workspaceRoot),
            messages: latestState.messages,
            sourceHint: curFile?.source,
            allowVideoStreamUrl,
          });
          const candidateUrl = res.ok && res.dataUrl ? res.dataUrl : '';
          if (candidateUrl && SAFE_HYDRATE_MEDIA_URL_RE.test(candidateUrl)) {
            recordResolvedAsset(docPath, workspaceRoot, assetPath, candidateUrl);
            return candidateUrl;
          }
          return null;
        } catch (err) {
          console.warn('[previewAssetCoordinator] asset hydration failed:', assetPath, err);
          return null;
        }
      },
    });
  }

  function recordResolvedAsset(
    docPath: string,
    workspaceRoot: string,
    assetPath: string,
    finalUrl: string,
  ): void {
    if (!docPath) return;
    const targetFile = deps.getState().openFiles.find((f) => f.path === docPath);
    if (!targetFile) return;
    targetFile.preview = {
      ...targetFile.preview,
      workspaceRoot: workspaceRoot || targetFile.preview?.workspaceRoot,
      resolvedAssets: {
        ...targetFile.preview?.resolvedAssets,
        [assetPath]: finalUrl,
      },
    };
  }

  return {
    prepareOpenFilePreview,
    revokeOpenFilePreview,
    revokeAll,
    bindMarkdownContainer,
  };
}
