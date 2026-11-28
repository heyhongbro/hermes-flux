/**
 * 渲染层媒体解析器、会话可点击文件集合推导与成果物实证协调服务 (Media Resolver & Deliverable Coordinator)
 *
 * 【设计意图 (Why)】
 *   1. 将“远端网关文件/图片/视频路径 -> 可直接挂入 <img>/<video> 的安全 Data URL”解析逻辑从
 *      `renderer/index.ts` 中完全剥离，提供有界 LRU 缓存与并发去重；
 *   2. 将 `resolveSessionKnownFiles` 与 `createSessionDeliverableCoordinator` 收拢于此：
 *      - 在零网络开销下通过 Tier A（写工具/imagePath/inlineDiff/subagent.files_written/MEDIA:）
 *        + 锁 1（同回合脚本交叉印证）立即产出成果物；
 *      - 对剩余正则候选路径通过 Core `createDirectoryPathVerifier` 按父目录批量物理核验，
 *        确认真实存在后再补充晋升为行内小卡片与成果物列表项，杜绝假路径与只读污染。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 禁止渲染层裸用 `fetch()` 直接抓网关受保护资源；
 *   2. 同路径并发加载必须合并 in-flight；
 *   3. 切会话/切网关时异步核验回调必须校对当前会话作用域，防止跨会话串台写入 `verifiedPaths`。
 *
 * 【约束与规则 (Rules)】
 *   - 内存缓存严格有界，避免长会话 Data URL 或目录快照无限增长；
 *   - 仅返回 `data:` / `blob:` / `http(s)://` 安全协议 URL，其余回退 `null`。
 */

import {
  createDirectoryPathVerifier,
  detectPreviewAssetMime,
  encodeUtf8ToBase64,
  extractSessionDeliverables,
  extractUnverifiedCandidatePaths,
  joinWorkspacePath,
  normalizeDeliverableKey,
  resolveFileContent,
  resolvePreviewAsset,
  type DeliverableItem,
  type DeliverableMessageInput,
  type HermesGatewayClient,
} from '@hermes-flux/core';
import { collectTouchedFiles, type MessageViewModel } from '@hermes-flux/ui';
import {
  resolveActiveViewportKey,
  resolveActiveWorkspaceCwd,
  type AppState,
} from '../state/appState.js';
import type { HermesDesktopBridge } from '../../preload/index.js';

export interface MediaResolverDeps {
  getState: () => AppState;
  getDesktopApi: () => HermesDesktopBridge | undefined;
  getGatewayClient: () => HermesGatewayClient | null;
  getClientForGateway?: (gatewayId?: string) => HermesGatewayClient | null;
  getGatewayUrlForGateway?: (gatewayId?: string) => string;
}

export interface MediaResolver {
  resolveMediaUrl(pathOrUrl: string): Promise<string | null>;
}

const MAX_CACHE_ENTRIES = 64;
const DIRECT_RENDERABLE_RE = /^(?:data:image\/|data:video\/|data:audio\/|blob:|hermes-(?:media|preview):\/\/)/i;
const SAFE_RESULT_RE = /^(?:data:image\/|data:video\/|data:audio\/|https?:\/\/|blob:|hermes-(?:media|preview):\/\/)/i;

function isRelativeMediaPath(rawPath: string): boolean {
  if (!rawPath) return false;
  if (/^(?:https?:\/\/|data:|blob:|hermes-(?:media|preview):\/\/)/i.test(rawPath)) return false;
  if (rawPath.startsWith('/') || rawPath.startsWith('~/') || rawPath.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(rawPath)) {
    return false;
  }
  return true;
}

function normalizeMediaTarget(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!/^file:\/\//i.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    const decoded = decodeURIComponent(parsed.pathname || '');
    return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
  // gate-degrade: 非法 file:// URL 保持原样交由下游判定
  } catch {
    return trimmed;
  }
}

function resolveGatewayHttpOrigin(rawGatewayUrl: string): string {
  const trimmed = (rawGatewayUrl || '').trim();
  if (!trimmed) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const httpUrl = withScheme.replace(/^ws(s?):\/\//i, 'http$1://');
  try {
    return new URL(httpUrl).origin.toLowerCase();
  // gate-degrade: URL 解析失败时回退为去尾斜杠字符串
  } catch {
    return httpUrl.replace(/\/+$/, '').toLowerCase();
  }
}

function resolveHttpUrlOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin.toLowerCase();
  // gate-degrade: URL 解析失败返回空串交由下游直连
  } catch {
    return '';
  }
}

function resolveScopedMediaProfile(state: AppState, targetGatewayId?: string): string | undefined {
  if (state.activeFocus?.type === 'bot' && state.activeFocus.botName) {
    return state.activeFocus.botName;
  }
  if (state.activeFocus?.type === 'group') {
    return undefined;
  }
  const activeSession = Array.isArray(state.sessions)
    ? state.sessions.find(
        (s) => s.id === state.activeSessionId && (!targetGatewayId || !s.gatewayId || s.gatewayId === targetGatewayId),
      )
    : undefined;
  if (activeSession?.botName) {
    return activeSession.botName;
  }
  const rawProfile = (state.profileName || '').trim();
  if (!rawProfile || rawProfile === 'default') {
    return rawProfile || undefined;
  }
  if (
    Array.isArray(state.profiles) &&
    state.profiles.length > 0 &&
    targetGatewayId &&
    (state.gatewayCount ?? 1) > 1
  ) {
    const scopedProfiles = state.profiles.filter((p) => !p.gatewayId || p.gatewayId === targetGatewayId);
    const validOnTarget = scopedProfiles.some((p) => p.name.trim().toLowerCase() === rawProfile.toLowerCase());
    if (!validOnTarget) {
      return undefined;
    }
  }
  return rawProfile;
}

/**
 * 构建带并发去重与有界 LRU 缓存的跨端媒体解析器。
 */
export function createMediaResolver(deps: MediaResolverDeps): MediaResolver {
  const cache = new Map<string, string>();
  const inflight = new Map<string, Promise<string | null>>();

  async function resolveMediaUrl(pathOrUrl: string): Promise<string | null> {
    const clean = normalizeMediaTarget(pathOrUrl);
    if (!clean) return null;
    if (DIRECT_RENDERABLE_RE.test(clean)) return clean;

    const state = deps.getState();
    const targetGatewayId = state.activeFocus?.gatewayId || state.activeGatewayId;
    const targetGatewayUrl = (
      deps.getGatewayUrlForGateway?.(targetGatewayId) ||
      state.gatewayUrl ||
      ''
    ).trim();
    const gwOrigin = resolveGatewayHttpOrigin(targetGatewayUrl);
    const isHttp = /^https?:\/\//i.test(clean);
    if (isHttp) {
      const cleanOrigin = resolveHttpUrlOrigin(clean);
      if (!gwOrigin || !cleanOrigin || cleanOrigin !== gwOrigin) {
        return clean;
      }
    }

    const effectiveProfile = resolveScopedMediaProfile(state, targetGatewayId);
    const scopeAnchor = targetGatewayId || targetGatewayUrl || '';
    const cacheKey = `${scopeAnchor}|${effectiveProfile || ''}|${state.activeSessionId}|${clean}`;
    const hit = cache.get(cacheKey);
    if (hit) {
      cache.delete(cacheKey);
      cache.set(cacheKey, hit);
      return hit;
    }

    const existingPromise = inflight.get(cacheKey);
    if (existingPromise) return existingPromise;

    const task = (async (): Promise<string | null> => {
      try {
        const cleanNoQuery = clean.split(/[?#]/)[0].toLowerCase();
        const detectedMime = detectPreviewAssetMime(cleanNoQuery);
        const workspaceCwd = resolveActiveWorkspaceCwd(state) || undefined;
        let out = '';
        if (detectedMime && (detectedMime.startsWith('audio/') || detectedMime.startsWith('image/'))) {
          const previewRes = await resolvePreviewAsset(clean, {
            platformBridge: deps.getDesktopApi() ?? null,
            gatewayUrl: targetGatewayUrl,
            profile: effectiveProfile,
            sessionId: state.activeSessionId || undefined,
            workspaceRoot: workspaceCwd,
            messages: state.messages,
          });
          out = (previewRes.dataUrl || '').trim();
          if (!out && workspaceCwd && isRelativeMediaPath(clean)) {
            const joined = joinWorkspacePath(workspaceCwd, clean);
            if (joined && joined !== clean) {
              const joinedRes = await resolvePreviewAsset(joined, {
                platformBridge: deps.getDesktopApi() ?? null,
                gatewayUrl: targetGatewayUrl,
                profile: effectiveProfile,
                sessionId: state.activeSessionId || undefined,
                workspaceRoot: workspaceCwd,
                messages: state.messages,
              });
              out = (joinedRes.dataUrl || '').trim();
            }
          }
        } else {
          const resolveNonAudio = async (targetPath: string): Promise<string> => {
            const resolved = await resolveFileContent(targetPath, {
              platformBridge: deps.getDesktopApi() ?? null,
              gatewayClient: deps.getClientForGateway
                ? deps.getClientForGateway(targetGatewayId)
                : deps.getGatewayClient(),
              gatewayUrl: targetGatewayUrl,
              profile: effectiveProfile,
              sessionId: state.activeSessionId || undefined,
              messages: state.messages,
            });
            if (resolved.isTooLarge || resolved.isDirectory || resolved.source === 'fallback') {
              return '';
            }
            let content = resolved.content.trim();
            if (cleanNoQuery.endsWith('.svg') && content && !content.startsWith('data:') && content.includes('<svg')) {
              content = `data:image/svg+xml;base64,${encodeUtf8ToBase64(content)}`;
            }
            return content;
          };
          out = await resolveNonAudio(clean);
          if (!SAFE_RESULT_RE.test(out) && workspaceCwd && isRelativeMediaPath(clean)) {
            const joined = joinWorkspacePath(workspaceCwd, clean);
            if (joined && joined !== clean) {
              out = await resolveNonAudio(joined);
            }
          }
        }
        if (!SAFE_RESULT_RE.test(out)) return null;
        if (cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest) cache.delete(oldest);
        }
        cache.set(cacheKey, out);
        return out;
      } catch (err) {
        console.warn('[mediaResolver] resolveMediaUrl failed:', clean, err);
        return null;
      } finally {
        inflight.delete(cacheKey);
      }
    })();

    inflight.set(cacheKey, task);
    return task;
  }

  return { resolveMediaUrl };
}

function toDeliverableInputs(messages: readonly MessageViewModel[]): DeliverableMessageInput[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      status: tc.status,
      args: tc.args,
      rawArgs: tc.rawArgs,
      output: tc.output,
      imagePath: tc.imagePath,
      inlineDiff: tc.inlineDiff,
    })),
    attachments: m.attachments,
  }));
}

function computeMessageMutationSignature(m: MessageViewModel): string {
  const toolsSig = m.toolCalls
    ? m.toolCalls
        .map(
          (tc) =>
            `${tc.id}:${tc.status}:${tc.output?.length ?? 0}:${tc.args?.length ?? 0}:${tc.imagePath ?? ''}:${tc.inlineDiff?.length ?? 0}`,
        )
        .join('|')
    : '';
  const attsSig = m.attachments
    ? m.attachments.map((att) => `${att.id}:${att.name}:${att.previewUrl ?? ''}`).join('|')
    : '';
  return `${m.id}::${m.content.length}::${toolsSig}::${attsSig}`;
}

export interface SessionKnownFilesOptions {
  getVerifiedPaths?: () => readonly string[];
  getSubagentWrittenPaths?: () => readonly string[];
}

/**
 * 构建带引用记忆的“会话可点击文件路径”解析器：汇总工具读写路径 + 助手真实成果物路径。
 */
export function createSessionKnownFilesResolver(
  getMessages: () => readonly MessageViewModel[],
  options: SessionKnownFilesOptions = {},
): () => readonly string[] {
  let prevSigs: readonly string[] = [];
  let prevContents: readonly string[] = [];
  let prevVerified: readonly string[] | undefined;
  let prevSubagent: readonly string[] | undefined;
  let cached: readonly string[] = [];

  return () => {
    const messages = getMessages();
    const nextSigs = messages.map(computeMessageMutationSignature);
    const nextContents = messages.map((m) => m.content);
    const nextVerified = options.getVerifiedPaths?.();
    const nextSubagent = options.getSubagentWrittenPaths?.();
    const unchanged =
      nextSigs.length === prevSigs.length &&
      nextSigs.every((s, i) => s === prevSigs[i]) &&
      nextContents.every((c, i) => c === prevContents[i]) &&
      nextVerified === prevVerified &&
      nextSubagent === prevSubagent;
    if (unchanged) return cached;

    prevSigs = nextSigs;
    prevContents = nextContents;
    prevVerified = nextVerified;
    prevSubagent = nextSubagent;
    const touched = collectTouchedFiles(messages.flatMap((m) => m.toolCalls ?? []));
    const delivered = extractSessionDeliverables(toDeliverableInputs(messages), {
      verifiedExistingPaths: nextVerified,
      subagentWrittenPaths: nextSubagent,
    }).map((d) => d.path);
    cached = Array.from(new Set([...touched, ...delivered]));
    return cached;
  };
}

export interface SessionDeliverableCoordinatorDeps {
  getState: () => AppState;
  getDesktopApi: () => HermesDesktopBridge | undefined;
  getGatewayUrlForGateway?: (gatewayId?: string) => string;
  getSubagentWrittenPaths?: () => readonly string[];
  onVerifiedPathsUpdated: () => void;
}

export interface SessionDeliverableCoordinator {
  getVerifiedPaths(): readonly string[];
  getSubagentWrittenPaths(): readonly string[];
  getSessionDeliverables(): DeliverableItem[];
  scheduleVerification(): void;
  clear(): void;
}

/**
 * 会话成果物协调器：管理子代理产出汇总、父目录批量物理存在性核验与引用稳定输出。
 */
export function createSessionDeliverableCoordinator(
  deps: SessionDeliverableCoordinatorDeps,
): SessionDeliverableCoordinator {
  const verifier = createDirectoryPathVerifier({
    getPlatformBridge: () => deps.getDesktopApi() ?? null,
  });

  let activeScopeKey = '';
  let verifiedSet = new Set<string>();
  let verifiedPaths: readonly string[] = [];
  let probedMsgCount = -1;
  let probedCwd = '';
  let probedKeys = new Set<string>();

  let cachedSubagentIn: readonly string[] | undefined;
  let cachedSubagentOut: readonly string[] = [];

  let prevDelivScope = '';
  let prevDelivSigs: readonly string[] = [];
  let prevDelivContents: readonly string[] = [];
  let prevDelivVerified: readonly string[] = [];
  let prevDelivSubagent: readonly string[] = [];
  let cachedDeliverables: DeliverableItem[] = [];

  function computeScopeKey(state: AppState): string {
    return `${state.activeGatewayId || state.gatewayUrl || ''}|${state.profileName || ''}|${resolveActiveViewportKey(state)}`;
  }

  function syncScope(state: AppState): string {
    const scopeKey = computeScopeKey(state);
    if (scopeKey !== activeScopeKey) {
      activeScopeKey = scopeKey;
      verifiedSet = new Set<string>();
      verifiedPaths = [];
      probedMsgCount = -1;
      probedCwd = '';
      probedKeys = new Set<string>();
    }
    return scopeKey;
  }

  function getVerifiedPaths(): readonly string[] {
    syncScope(deps.getState());
    return verifiedPaths;
  }

  function getSubagentWrittenPaths(): readonly string[] {
    const raw = deps.getSubagentWrittenPaths?.();
    if (!raw || raw.length === 0) {
      if (cachedSubagentOut.length === 0) return cachedSubagentOut;
      cachedSubagentIn = raw;
      cachedSubagentOut = [];
      return cachedSubagentOut;
    }
    if (raw === cachedSubagentIn) return cachedSubagentOut;
    if (
      raw.length === cachedSubagentOut.length &&
      raw.every((p, i) => p === cachedSubagentOut[i])
    ) {
      cachedSubagentIn = raw;
      return cachedSubagentOut;
    }
    cachedSubagentIn = raw;
    cachedSubagentOut = [...raw];
    return cachedSubagentOut;
  }

  function getSessionDeliverables(): DeliverableItem[] {
    const state = deps.getState();
    const scopeKey = syncScope(state);
    const messages = state.messages ?? [];
    const nextSigs = messages.map(computeMessageMutationSignature);
    const nextContents = messages.map((m) => m.content);
    const subWritten = getSubagentWrittenPaths();
    const unchanged =
      scopeKey === prevDelivScope &&
      nextSigs.length === prevDelivSigs.length &&
      nextSigs.every((s, i) => s === prevDelivSigs[i]) &&
      nextContents.every((c, i) => c === prevDelivContents[i]) &&
      verifiedPaths === prevDelivVerified &&
      subWritten === prevDelivSubagent;
    if (unchanged) return cachedDeliverables;

    prevDelivScope = scopeKey;
    prevDelivSigs = nextSigs;
    prevDelivContents = nextContents;
    prevDelivVerified = verifiedPaths;
    prevDelivSubagent = subWritten;
    cachedDeliverables = extractSessionDeliverables(toDeliverableInputs(messages), {
      verifiedExistingPaths: verifiedPaths,
      subagentWrittenPaths: subWritten,
    });
    return cachedDeliverables;
  }

  function scheduleVerification(): void {
    const state = deps.getState();
    if (state.isStreaming) return;
    const bridge = deps.getDesktopApi();
    if (!bridge) return;
    const messages = state.messages ?? [];
    if (messages.length === 0) return;

    const scopeKey = syncScope(state);
    const cwd = resolveActiveWorkspaceCwd(state) || '';
    if (messages.length !== probedMsgCount || cwd !== probedCwd) {
      probedMsgCount = messages.length;
      probedCwd = cwd;
      probedKeys = new Set<string>();
    }

    const subWritten = getSubagentWrittenPaths();
    const candidates = extractUnverifiedCandidatePaths(toDeliverableInputs(messages), {
      verifiedExistingPaths: verifiedPaths,
      subagentWrittenPaths: subWritten,
    }).filter((p) => {
      const k = normalizeDeliverableKey(p);
      return Boolean(k) && !probedKeys.has(k);
    });

    if (candidates.length === 0) return;
    for (const p of candidates) {
      const k = normalizeDeliverableKey(p);
      if (k) probedKeys.add(k);
    }

    const activeGw = state.activeFocus?.gatewayId || state.activeGatewayId;
    const gw = deps.getGatewayUrlForGateway?.(activeGw) || state.gatewayUrl;
    const profile = state.profileName || undefined;

    void verifier
      .verifyPathsExist(candidates, { gatewayUrl: gw, profile, cwd: cwd || undefined })
      .then((foundPaths) => {
        if (foundPaths.length === 0) return;
        const latestState = deps.getState();
        if (computeScopeKey(latestState) !== scopeKey) return;

        let changed = false;
        for (const p of foundPaths) {
          const key = normalizeDeliverableKey(p);
          if (key && !verifiedSet.has(key)) {
            verifiedSet.add(key);
            changed = true;
          }
        }
        if (changed) {
          verifiedPaths = Array.from(verifiedSet);
          deps.onVerifiedPathsUpdated();
        }
      })
      // gate-degrade: 物理存在性探测异常只记录日志并降级为空，不影响主会话流
      .catch((err) => {
        console.warn('[deliverableCoordinator] path verification failed:', err);
      });
  }

  function clear(): void {
    verifier.clear();
    verifiedSet = new Set<string>();
    verifiedPaths = [];
    probedMsgCount = -1;
    probedCwd = '';
    probedKeys = new Set<string>();
    prevDelivScope = '';
    cachedDeliverables = [];
  }

  return {
    getVerifiedPaths,
    getSubagentWrittenPaths,
    getSessionDeliverables,
    scheduleVerification,
    clear,
  };
}
