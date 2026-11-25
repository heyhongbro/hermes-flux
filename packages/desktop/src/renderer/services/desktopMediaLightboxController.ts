/**
 * 桌面端悬浮媒体预览灯箱控制器 (DesktopMediaLightboxController)
 *
 * 【设计意图 (Why)】
 *   集中管理桌面端独立 React 孤岛 `#react-desktop-lightbox-host` 的挂载、更新与销毁，
 *   让渲染协调器 (`renderCoordinator.ts`) 与文件/成果物服务解耦并严格守在 1500 行门禁以内。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 热替换或切换主视图导致 DOM 重建时，`desktopLightboxHost.isConnected` 会变 false，
 *      此时必须重建宿主节点并卸掉旧 React 根，防止无头节点持续悬挂内存或点击无响应；
 *   2. 必须在顶层协调器 `dispose()` 时同步卸载 React 根并清空引用。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁出现 `as any`；
 *   - 仅操作专属 `#react-desktop-lightbox-host` 孤岛容器，禁止侵入消息流宿主 DOM。
 */

import { mountMediaLightbox, type MediaLightboxItem } from '@hermes-flux/ui';

export interface DesktopMediaLightboxControllerDeps {
  onDownloadMediaItem?: (item: MediaLightboxItem) => void;
  resolveMediaUrl?: (pathOrUrl: string) => Promise<string | null>;
}

export interface DesktopMediaLightboxController {
  open(items: readonly MediaLightboxItem[], initialIndex: number): void;
  close(): void;
  dispose(): void;
}

/** 创建桌面端媒体预览灯箱生命周期控制器。 */
export function createDesktopMediaLightboxController(
  deps: DesktopMediaLightboxControllerDeps,
): DesktopMediaLightboxController {
  let lightboxState: { items: readonly MediaLightboxItem[]; initialIndex: number } | null = null;
  let lightboxMount: ReturnType<typeof mountMediaLightbox> | null = null;
  let lightboxHost: HTMLElement | null = null;

  function sync(): void {
    if (typeof document === 'undefined' || !document.body) return;
    if (!lightboxState && !lightboxMount) return;

    let host = lightboxHost;
    if (!host || !host.isConnected) {
      host = document.getElementById('react-desktop-lightbox-host');
      if (!host) {
        host = document.createElement('div');
        host.id = 'react-desktop-lightbox-host';
        host.dataset.fluxIsland = 'true';
        host.style.display = 'contents';
        document.body.appendChild(host);
      }
      lightboxHost = host;
      lightboxMount?.unmount();
      lightboxMount = null;
    }

    if (!lightboxMount) {
      lightboxMount = mountMediaLightbox(host, () =>
        lightboxState
          ? {
              items: lightboxState.items,
              initialIndex: lightboxState.initialIndex,
              onClose: close,
              onDownload: deps.onDownloadMediaItem,
              resolveMediaUrl: deps.resolveMediaUrl,
            }
          : null,
      );
      return;
    }
    lightboxMount.update();
  }

  function open(items: readonly MediaLightboxItem[], initialIndex: number): void {
    if (!items || items.length === 0) return;
    lightboxState = { items, initialIndex };
    sync();
  }

  function close(): void {
    lightboxState = null;
    sync();
  }

  function dispose(): void {
    if (lightboxMount) {
      lightboxMount.unmount();
      lightboxMount = null;
    }
    lightboxHost?.remove?.();
    lightboxHost = null;
    lightboxState = null;
  }

  return { open, close, dispose };
}
