/**
 * Desktop 主进程系统电源与锁屏唤醒监听模块 (packages/desktop/src/main/powerEvents.ts)
 *
 * 【设计意图 (Why)】
 *   笔记本合盖休眠、系统睡眠恢复或屏幕解锁后，底层 TCP/WebSocket 常处于无感知半开态；
 *   若不从主进程 Electron `powerMonitor` 主动捕获 OS 级事件通知渲染层探活，桌面端需苦等
 *   15s~20s 心跳超时才会恢复，期间处于假在线。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 若在 macOS `activate` 重建窗口时重复绑定 `powerMonitor`，关闭并重开窗口会累加监听器；
 *   2. 窗口销毁过程触发 `suspend`/`resume` 时未判空 `isDestroyed()` 会抛出 Object has been destroyed。
 *
 * 【约束与规则 (Rules)】
 *   - 全局只注册一次，通过函数闭包动态获取当前活跃窗口；
 *   - 统一经由单条 IPC 通道 `'system:power-event'` 派发 `'suspend' | 'resume' | 'unlock'`。
 */

export type SystemPowerEventKind = 'suspend' | 'resume' | 'unlock';

export interface PowerMonitorLike {
  on(event: 'suspend' | 'resume' | 'unlock-screen', listener: () => void): void;
  removeListener?(event: 'suspend' | 'resume' | 'unlock-screen', listener: () => void): void;
}

export interface PowerEventTargetWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: 'system:power-event', kind: SystemPowerEventKind): void;
  };
}

/**
 * 向 Electron powerMonitor 注册单次系统电源/锁屏状态监听器并安全转发至主窗口。
 */
export function registerPowerEvents(
  monitor: PowerMonitorLike,
  getMainWindow: () => PowerEventTargetWindow | null,
): () => void {
  const emit = (kind: SystemPowerEventKind): void => {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      return;
    }
    win.webContents.send('system:power-event', kind);
  };

  const onSuspend = (): void => emit('suspend');
  const onResume = (): void => emit('resume');
  const onUnlock = (): void => emit('unlock');

  monitor.on('suspend', onSuspend);
  monitor.on('resume', onResume);
  monitor.on('unlock-screen', onUnlock);

  return () => {
    monitor.removeListener?.('suspend', onSuspend);
    monitor.removeListener?.('resume', onResume);
    monitor.removeListener?.('unlock-screen', onUnlock);
  };
}
