/**
 * Desktop 渲染进程日志等级解析与双通道落盘适配器 (packages/desktop/src/renderer/logBridge.ts)
 */

import {
  addLogSink,
  parseLogLevel,
  type LogLevel,
  type LogRecord,
} from '@hermes-flux/core';
import type { HermesDesktopBridge } from '../preload/index.js';

export const LOG_LEVEL_STORAGE_KEY = 'hermes_flux_log_level';

export interface ConsoleLoggerLike {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

/**
 * 解析渲染进程初始日志等级：优先 URL `?log=` 查询参数，其次持久化 storage，默认 `'info'`。
 */
export function resolveInitialLogLevel(
  search?: string,
  storage?: Pick<Storage, 'getItem'> | null,
): LogLevel {
  const query = typeof search === 'string' ? search.trim() : '';
  if (query) {
    try {
      const param = new URLSearchParams(query.startsWith('?') ? query : `?${query}`).get('log');
      const parsed = param ? parseLogLevel(param) : null;
      if (parsed) return parsed;
    // gate-degrade: URLSearchParams 异常时继续回退本地存储与默认等级
    } catch {
      // fall through to storage
    }
  }
  if (storage) {
    try {
      const raw = storage.getItem(LOG_LEVEL_STORAGE_KEY);
      const parsed = raw ? parseLogLevel(raw) : null;
      if (parsed) return parsed;
    // gate-degrade: 隐私模式下 localStorage 不可读时回退默认 'info'
    } catch {
      return 'info';
    }
  }
  return 'info';
}

/**
 * 注册渲染进程控制台与主进程文件（`desktopApi.appendLog`）双通道日志 sink。
 */
export function registerRendererLogSinks(opts: {
  readonly desktopApi?: Pick<HermesDesktopBridge, 'appendLog'> | null;
  readonly fileMinLevel: LogLevel;
  readonly consoleImpl?: ConsoleLoggerLike;
}): { readonly sinkCount: number; dispose: () => void } {
  const targetConsole = opts.consoleImpl ?? console;
  const levelMap: Record<LogRecord['level'], (...args: unknown[]) => void> = {
    error: (...args) => targetConsole.error(...args),
    warn: (...args) => targetConsole.warn(...args),
    debug: (...args) => targetConsole.debug(...args),
    trace: (...args) => targetConsole.debug(...args),
    info: (...args) => targetConsole.log(...args),
  };

  const unsubs: Array<() => void> = [];
  unsubs.push(
    addLogSink((entry) => {
      levelMap[entry.level](`[Flux ${entry.scope}]`, entry.message, entry.data ?? '');
    }),
  );

  const appendLog = opts.desktopApi?.appendLog;
  if (typeof appendLog === 'function') {
    unsubs.push(
      addLogSink((entry) => {
        appendLog(entry);
      }, opts.fileMinLevel),
    );
  }

  return {
    sinkCount: unsubs.length,
    dispose: () => {
      for (const unsub of unsubs) {
        unsub();
      }
      unsubs.length = 0;
    },
  };
}
