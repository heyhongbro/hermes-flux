/**
 * 桌面与移动端共享的项目工作目录树选择器 (ProjectDirectoryPicker)
 *
 * 【设计意图 (Why)】
 *   消除用户在「设置 → 项目」里盲输 `cwd` 绝对路径的高门槛交互。
 *   提供单一共享的懒加载树形目录选择器，支持逐层展开、关键字筛选、点击选中目录
 *   （自动回填项目名）、直接新建子文件夹以及就地重命名文件夹，保证桌面弹窗与移动设置页
 *   100% 复用同一组件、状态逻辑与交互语义。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `SettingsModal` 与 `MobileSettingsPage` 将新建项目控件包裹在 `<form>` 内，
 *      组件内严禁嵌套 `<form>`，新建/重命名行内表单必须用容器 `onKeyDown` + `type="button"` 提交，
 *      否则按回车或点击确认会误触外层新建项目提交；
 *   2. 严禁把 `<Button>` 嵌套进 `<button>`：展开箭头、选中行主区与新建/重命名动作必须是兄弟按钮；
 *   3. 严格遵守 4px 整数网格与语义 Design Token，移动端 `variant="mobile"` 保证 >=44px 触控热区且禁用 `xs`。
 *
 * 【约束与规则 (Rules)】
 *   - 零直接网络或宿主 fs 调用，全部通过 `onBrowse` / `onCreateDirectory` / `onRenameDirectory` 回调注入；
 *   - 失败显式展示 `role="alert"` 横幅，绝不伪造成功态或静默降级。
 */

import * as React from 'react';
import {
  Check,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  X,
} from 'lucide-react';
import {
  extractParentDirectoryPath,
  isPathWithinDirectory,
  isProtectedRootDirectory,
  normalizePathForMatch,
  normalizeWorkspacePath,
  validateDirectoryName,
  type BrowseProjectDirectoryResult,
  type ProjectDirectoryEntry,
  type ProjectDirectorySource,
} from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import { Button } from '../primitives/Button.js';
import { Input } from '../primitives/Input.js';
import { Tooltip } from '../primitives/Tooltip.js';
import type { SettingsActions } from './settingsModel.js';

export interface ProjectDirectoryPickerProps {
  value: string;
  disabled?: boolean;
  isConnected?: boolean;
  variant?: 'desktop' | 'mobile';
  onBrowse?: SettingsActions['onBrowseProjectDirectory'];
  onCreateDirectory?: SettingsActions['onCreateProjectDirectory'];
  onRenameDirectory?: SettingsActions['onRenameProjectDirectory'];
  onSelectPath: (path: string, folderName: string) => void;
  onPathRenamed?: (oldPath: string, newPath: string) => void;
}

interface RootDirectoryMeta {
  currentPath: string;
  rootPath: string;
  lockedRoot: string | null;
  defaultCwd: string | null;
  source: ProjectDirectorySource;
  canCreate: boolean;
  canRename: boolean;
}

type InlineEditMode =
  | { type: 'create'; parentPath: string }
  | { type: 'rename'; targetPath: string; originalName: string };

const DEPTH_PADDING_CLASSES = ['pl-2', 'pl-6', 'pl-10', 'pl-14', 'pl-16'] as const;
const MAX_AUTO_EXPAND_HOPS = 8;

function resolveDepthPaddingClass(depth: number): string {
  const safeIdx = Math.max(0, Math.min(depth, DEPTH_PADDING_CLASSES.length - 1));
  return DEPTH_PADDING_CLASSES[safeIdx];
}

function mapDirectoryError(rawError: string): string {
  switch (rawError) {
    case 'INVALID_DIR_NAME:empty':
      return t('settings.dirPickerErrEmpty');
    case 'INVALID_DIR_NAME:invalid_chars':
      return t('settings.dirPickerErrInvalidChars');
    case 'INVALID_DIR_NAME:reserved':
      return t('settings.dirPickerErrReserved');
    case 'INVALID_DIR_NAME:secret':
      return t('settings.dirPickerErrSecret');
    case 'TARGET_EXISTS':
      return t('settings.dirPickerErrTargetExists');
    case 'PROTECTED_ROOT_DIRECTORY':
      return t('settings.dirPickerErrProtectedRoot');
    case 'PATH_OUTSIDE_LOCKED_ROOT':
    case 'PATH_OUTSIDE_ROOT':
      return t('settings.dirPickerErrOutsideRoot');
    default:
      return t('settings.dirPickerErrLoadFailed', { error: rawError });
  }
}

function collectAncestorDirectories(rootPath: string, targetPath: string): string[] {
  const normRoot = normalizeWorkspacePath(rootPath);
  const normTarget = normalizeWorkspacePath(targetPath);
  if (!normRoot || !normTarget) return [];
  const rootMatch = normalizePathForMatch(normRoot);
  const targetMatch = normalizePathForMatch(normTarget);
  if (!isPathWithinDirectory(targetMatch, rootMatch)) return [];

  const chain: string[] = [];
  let cursor = normTarget;
  let hops = 0;
  while (cursor && hops < MAX_AUTO_EXPAND_HOPS) {
    const cursorMatch = normalizePathForMatch(cursor);
    if (cursorMatch === rootMatch) break;
    const parent = extractParentDirectoryPath(cursor);
    if (!parent || parent === cursor) break;
    chain.unshift(cursor);
    cursor = parent;
    hops += 1;
  }
  return [normRoot, ...chain];
}

export function remapPathPrefix(pathValue: string, oldPrefix: string, newPrefix: string): string {
  const normVal = normalizeWorkspacePath(pathValue);
  const normOld = normalizeWorkspacePath(oldPrefix);
  if (normVal === normOld) return newPrefix;
  if (normVal.startsWith(`${normOld}/`)) {
    return `${newPrefix}${normVal.slice(normOld.length)}`;
  }
  return normVal;
}

export function ProjectDirectoryPicker({
  value,
  disabled = false,
  isConnected = true,
  variant = 'desktop',
  onBrowse,
  onCreateDirectory,
  onRenameDirectory,
  onSelectPath,
  onPathRenamed,
}: ProjectDirectoryPickerProps): React.ReactElement | null {
  const isMobile = variant === 'mobile';
  const [rootMeta, setRootMeta] = React.useState<RootDirectoryMeta | null>(null);
  const [childrenByPath, setChildrenByPath] = React.useState<Record<string, ProjectDirectoryEntry[]>>({});
  const [expandedPaths, setExpandedPaths] = React.useState<string[]>([]);
  const [loadingPaths, setLoadingPaths] = React.useState<string[]>([]);
  const [filterText, setFilterText] = React.useState('');
  const [errorText, setErrorText] = React.useState<string | null>(null);
  const [inlineMode, setInlineMode] = React.useState<InlineEditMode | null>(null);
  const [inlineDraft, setInlineDraft] = React.useState('');
  const [inlineBusy, setInlineBusy] = React.useState(false);

  const mountedRef = React.useRef(true);
  const loadSeqRef = React.useRef(0);
  const valueRef = React.useRef(value);
  valueRef.current = value;

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const prevConnectedRef = React.useRef(isConnected);
  React.useEffect(() => {
    if (prevConnectedRef.current && !isConnected) {
      setRootMeta(null);
      setChildrenByPath({});
      setExpandedPaths([]);
      setLoadingPaths([]);
      setInlineMode(null);
      setInlineDraft('');
      setErrorText(null);
    }
    prevConnectedRef.current = isConnected;
  }, [isConnected]);

  const loadDirectory = React.useCallback(
    async (
      dirPath: string,
      options?: { expand?: boolean; expandInitialTarget?: boolean },
    ): Promise<BrowseProjectDirectoryResult | null> => {
      if (!onBrowse) return null;
      const reqId = ++loadSeqRef.current;
      const loadingKey = normalizeWorkspacePath(dirPath) || '__root__';
      setLoadingPaths((prev) => (prev.includes(loadingKey) ? prev : [...prev, loadingKey]));
      setErrorText(null);
      try {
        const result = await onBrowse(dirPath || undefined);
        if (!mountedRef.current) return null;
        if (!result.ok) {
          setErrorText(mapDirectoryError(result.error));
          return result;
        }

        const currentPath = normalizeWorkspacePath(result.currentPath);
        setChildrenByPath((prev) => ({ ...prev, [currentPath]: result.entries }));

        if (!dirPath || !rootMeta) {
          setRootMeta({
            currentPath,
            rootPath: normalizeWorkspacePath(result.rootPath || currentPath),
            lockedRoot: result.lockedRoot ? normalizeWorkspacePath(result.lockedRoot) : null,
            defaultCwd: result.defaultCwd ? normalizeWorkspacePath(result.defaultCwd) : null,
            source: result.source,
            canCreate: result.canCreate,
            canRename: result.canRename,
          });
        }

        if (options?.expand || !dirPath) {
          setExpandedPaths((prev) => (prev.includes(currentPath) ? prev : [...prev, currentPath]));
        }

        if (options?.expandInitialTarget && reqId === loadSeqRef.current) {
          const seedTarget = normalizeWorkspacePath(valueRef.current || result.defaultCwd || '');
          const ancestors = collectAncestorDirectories(currentPath, seedTarget).filter(
            (ancestor) => ancestor !== currentPath && ancestor !== normalizeWorkspacePath(valueRef.current || ''),
          );
          for (const ancestor of ancestors) {
            if (!mountedRef.current) break;
            const subRes = await onBrowse(ancestor);
            if (!mountedRef.current) break;
            if (subRes.ok) {
              const normSub = normalizeWorkspacePath(subRes.currentPath || ancestor);
              setChildrenByPath((prev) => ({ ...prev, [normSub]: subRes.entries }));
              setExpandedPaths((prev) => (prev.includes(normSub) ? prev : [...prev, normSub]));
            }
          }
        }
        return result;
      } catch (err) {
        if (mountedRef.current) {
          setErrorText(mapDirectoryError(err instanceof Error ? err.message : String(err)));
        }
        return null;
      } finally {
        if (mountedRef.current) {
          setLoadingPaths((prev) => prev.filter((item) => item !== loadingKey));
        }
      }
    },
    [onBrowse, rootMeta],
  );

  React.useEffect(() => {
    if (!onBrowse || !isConnected) return;
    if (rootMeta) return;
    void loadDirectory('', { expand: true, expandInitialTarget: true });
  }, [isConnected, loadDirectory, onBrowse, rootMeta]);

  if (!onBrowse) {
    return null;
  }

  const normalizedSelected = normalizeWorkspacePath(value);
  const rootPath = rootMeta?.currentPath || '';
  const filterQuery = filterText.trim().toLowerCase();
  const rootLoading = loadingPaths.includes('__root__') || (Boolean(rootPath) && loadingPaths.includes(rootPath));
  const createSupported = Boolean(onCreateDirectory && (rootMeta?.canCreate ?? true));
  const renameSupported = Boolean(onRenameDirectory && (rootMeta?.canRename ?? false));

  const resolveActiveCreateParent = (): string => {
    if (normalizedSelected && childrenByPath[normalizedSelected]) {
      return normalizedSelected;
    }
    return rootPath;
  };

  const entryMatchesFilter = (entry: ProjectDirectoryEntry, depth = 0): boolean => {
    if (!filterQuery) return true;
    if (entry.name.toLowerCase().includes(filterQuery)) return true;
    if (depth >= 8) return false;
    const children = childrenByPath[entry.path];
    return Array.isArray(children) ? children.some((child) => entryMatchesFilter(child, depth + 1)) : false;
  };

  const handleToggleExpand = async (dirPath: string): Promise<void> => {
    const norm = normalizeWorkspacePath(dirPath);
    if (!norm) return;
    if (expandedPaths.includes(norm)) {
      setExpandedPaths((prev) => prev.filter((item) => item !== norm));
      return;
    }
    setExpandedPaths((prev) => [...prev, norm]);
    if (!childrenByPath[norm]) {
      await loadDirectory(norm, { expand: true });
    }
  };

  const handleStartCreate = (parentPath: string): void => {
    const normParent = normalizeWorkspacePath(parentPath);
    if (!normParent || disabled) return;
    setErrorText(null);
    setInlineMode({ type: 'create', parentPath: normParent });
    setInlineDraft('');
    if (!expandedPaths.includes(normParent)) {
      setExpandedPaths((prev) => [...prev, normParent]);
    }
  };

  const handleStartRename = (entry: ProjectDirectoryEntry): void => {
    if (disabled) return;
    setErrorText(null);
    setInlineMode({ type: 'rename', targetPath: entry.path, originalName: entry.name });
    setInlineDraft(entry.name);
  };

  const handleCommitInline = async (): Promise<void> => {
    if (!inlineMode || inlineBusy) return;
    const check = validateDirectoryName(inlineDraft);
    if (!check.ok) {
      setErrorText(mapDirectoryError(`INVALID_DIR_NAME:${check.reason}`));
      return;
    }

    setInlineBusy(true);
    setErrorText(null);
    try {
      if (inlineMode.type === 'create') {
        if (!onCreateDirectory) return;
        const res = await onCreateDirectory(inlineMode.parentPath, check.name, {
          source: rootMeta?.source,
          lockedRoot: rootMeta?.lockedRoot ?? null,
        });
        if (!res.ok) {
          setErrorText(mapDirectoryError(res.error));
          return;
        }
        setInlineMode(null);
        setInlineDraft('');
        await loadDirectory(inlineMode.parentPath, { expand: true });
        onSelectPath(res.path, check.name);
      } else {
        if (!onRenameDirectory) return;
        const oldPath = inlineMode.targetPath;
        const res = await onRenameDirectory(oldPath, check.name, {
          source: rootMeta?.source,
          lockedRoot: rootMeta?.lockedRoot ?? null,
        });
        if (!res.ok) {
          setErrorText(mapDirectoryError(res.error));
          return;
        }
        const newPath = normalizeWorkspacePath(res.path);
        const parentPath = extractParentDirectoryPath(newPath) || rootPath;
        setExpandedPaths((prev) => prev.map((p) => remapPathPrefix(p, oldPath, newPath)));
        setChildrenByPath((prev) => {
          const next: Record<string, ProjectDirectoryEntry[]> = {};
          for (const [key, list] of Object.entries(prev)) {
            if (key === oldPath || key.startsWith(`${oldPath}/`)) {
              continue;
            }
            next[key] = list;
          }
          return next;
        });
        setInlineMode(null);
        setInlineDraft('');
        await loadDirectory(parentPath, { expand: true });
        onPathRenamed?.(oldPath, newPath);
      }
    } finally {
      if (mountedRef.current) {
        setInlineBusy(false);
      }
    }
  };

  const renderInlineCreateRow = (parentPath: string, depth: number): React.ReactElement | null => {
    if (inlineMode?.type !== 'create' || inlineMode.parentPath !== parentPath) {
      return null;
    }
    return (
      <div
        className={`flex items-center gap-2 py-1 pr-2 ${resolveDepthPaddingClass(depth)}`}
        data-testid="dir-picker-inline-create"
      >
        <FolderPlus size={14} aria-hidden="true" className="shrink-0 text-primary" />
        <Input
          size={isMobile ? 'default' : 'sm'}
          className="flex-1"
          value={inlineDraft}
          disabled={inlineBusy}
          placeholder={t('settings.dirPickerNewFolderPlaceholder')}
          aria-label={t('settings.dirPickerNewFolderPlaceholder')}
          data-testid="dir-picker-create-input"
          autoFocus
          onChange={(e) => setInlineDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              void handleCommitInline();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setInlineMode(null);
            }
          }}
        />
        <Button
          type="button"
          size={isMobile ? 'icon' : 'icon-xs'}
          className="shrink-0"
          disabled={inlineBusy || !inlineDraft.trim()}
          aria-label={t('settings.dirPickerConfirm')}
          data-testid="dir-picker-create-confirm"
          onClick={() => void handleCommitInline()}
        >
          <Check size={14} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size={isMobile ? 'icon' : 'icon-xs'}
          className="shrink-0"
          disabled={inlineBusy}
          aria-label={t('settings.dirPickerCancel')}
          onClick={() => setInlineMode(null)}
        >
          <X size={14} aria-hidden="true" />
        </Button>
      </div>
    );
  };

  const renderTreeNodes = (parentPath: string, depth: number): React.ReactNode => {
    const entries = (childrenByPath[parentPath] || []).filter((entry) => entryMatchesFilter(entry, depth));
    const createBar = renderInlineCreateRow(parentPath, depth);

    if (entries.length === 0 && !createBar) {
      if (depth === 0) {
        return (
          <div className="px-3 py-3 text-caption text-muted-foreground">
            {rootLoading
              ? t('settings.dirPickerLoading')
              : filterQuery
                ? t('settings.dirPickerNoMatch')
                : t('settings.dirPickerEmpty')}
          </div>
        );
      }
      return null;
    }

    return (
      <>
        {createBar}
        {entries.map((entry) => {
          const isExpanded = expandedPaths.includes(entry.path);
          const isSelected = normalizedSelected === entry.path;
          const isLoadingNode = loadingPaths.includes(entry.path);
          const isRenamingThis = inlineMode?.type === 'rename' && inlineMode.targetPath === entry.path;
          const isProtected = isProtectedRootDirectory(entry.path, rootMeta?.lockedRoot ?? null);

          return (
            <div key={entry.path} data-dir-entry={entry.path}>
              <div
                className={`group flex items-center gap-1 rounded-card pr-1 transition-colors ${resolveDepthPaddingClass(depth)} ${
                  isSelected ? 'bg-card-active text-foreground' : 'hover:bg-card-hover'
                }`}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size={isMobile ? 'icon' : 'icon-xs'}
                  className="shrink-0"
                  disabled={disabled || isLoadingNode}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? t('settings.dirPickerCollapse') : t('settings.dirPickerExpand')}
                  data-dir-expand={entry.path}
                  onClick={() => void handleToggleExpand(entry.path)}
                >
                  <ChevronRight
                    size={14}
                    aria-hidden="true"
                    className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                  />
                </Button>

                {isRenamingThis ? (
                  <div className="flex min-w-0 flex-1 items-center gap-1 py-1">
                    <Input
                      size={isMobile ? 'default' : 'sm'}
                      className="flex-1"
                      value={inlineDraft}
                      disabled={inlineBusy}
                      placeholder={t('settings.dirPickerRenamePlaceholder')}
                      aria-label={t('settings.dirPickerRenamePlaceholder')}
                      data-testid="dir-picker-rename-input"
                      autoFocus
                      onChange={(e) => setInlineDraft(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          e.stopPropagation();
                          void handleCommitInline();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          setInlineMode(null);
                        }
                      }}
                    />
                    <Button
                      type="button"
                      size={isMobile ? 'icon' : 'icon-xs'}
                      className="shrink-0"
                      disabled={inlineBusy || !inlineDraft.trim()}
                      aria-label={t('settings.dirPickerConfirm')}
                      data-testid="dir-picker-rename-confirm"
                      onClick={() => void handleCommitInline()}
                    >
                      <Check size={14} aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size={isMobile ? 'icon' : 'icon-xs'}
                      className="shrink-0"
                      disabled={inlineBusy}
                      aria-label={t('settings.dirPickerCancel')}
                      onClick={() => setInlineMode(null)}
                    >
                      <X size={14} aria-hidden="true" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={disabled}
                      data-dir-select={entry.path}
                      className={`appearance-none border-0 bg-transparent flex min-w-0 flex-1 items-center gap-2 rounded-card px-2 py-1 text-left transition-colors ${
                        isMobile ? 'text-body' : 'min-h-8 text-aux'
                      } ${isSelected ? 'font-medium text-foreground' : 'text-foreground'}`}
                      onClick={() => {
                        setErrorText(null);
                        onSelectPath(entry.path, entry.name);
                      }}
                    >
                      {isExpanded || isSelected ? (
                        <FolderOpen size={14} aria-hidden="true" className="shrink-0 text-primary" />
                      ) : (
                        <Folder size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{entry.name}</span>
                      {isLoadingNode ? (
                        <span className="shrink-0 text-caption text-muted-foreground">…</span>
                      ) : null}
                    </button>

                    <div
                      className={`flex shrink-0 items-center gap-1 transition-opacity ${
                        isMobile ? 'opacity-100' : 'opacity-75 group-hover:opacity-100 focus-within:opacity-100'
                      }`}
                    >
                      {createSupported ? (
                        <Tooltip content={t('settings.dirPickerCreateSubfolder')} placement="top">
                          <span className="inline-flex">
                            <Button
                              type="button"
                              variant="ghost"
                              size={isMobile ? 'icon' : 'icon-xs'}
                              disabled={disabled}
                              aria-label={t('settings.dirPickerCreateSubfolder')}
                              data-dir-create={entry.path}
                              onClick={() => handleStartCreate(entry.path)}
                            >
                              <FolderPlus size={13} aria-hidden="true" />
                            </Button>
                          </span>
                        </Tooltip>
                      ) : null}
                      {renameSupported && !isProtected ? (
                        <Tooltip content={t('settings.dirPickerRenameFolder')} placement="top">
                          <span className="inline-flex">
                            <Button
                              type="button"
                              variant="ghost"
                              size={isMobile ? 'icon' : 'icon-xs'}
                              disabled={disabled}
                              aria-label={t('settings.dirPickerRenameFolder')}
                              data-dir-rename={entry.path}
                              onClick={() => handleStartRename(entry)}
                            >
                              <Pencil size={13} aria-hidden="true" />
                            </Button>
                          </span>
                        </Tooltip>
                      ) : null}
                    </div>
                  </>
                )}
              </div>

              {isExpanded && depth < 6 ? renderTreeNodes(entry.path, depth + 1) : null}
            </div>
          );
        })}
      </>
    );
  };

  return (
    <div
      data-flux-island=""
      className={`flex flex-col gap-2 rounded-panel border border-border-subtle bg-panel p-3${
        isMobile ? ' m-dir-picker--mobile' : ''
      }`}
      data-testid="project-directory-picker"
      data-variant={variant}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-caption font-medium text-muted-foreground">
            {t('settings.dirPickerTitle')}
          </span>
          {rootPath ? (
            <span className="truncate font-code text-caption text-muted-foreground">
              {rootPath}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {createSupported && rootPath ? (
            <Button
              type="button"
              variant="outline"
              size={isMobile ? 'default' : 'sm'}
              disabled={disabled || !isConnected}
              data-testid="dir-picker-new-root-folder"
              onClick={() => handleStartCreate(resolveActiveCreateParent())}
            >
              <FolderPlus size={14} aria-hidden="true" />
              <span>{t('settings.dirPickerNewFolder')}</span>
            </Button>
          ) : null}
          <Tooltip content={t('settings.dirPickerRefresh')} placement="top">
            <span className="inline-flex">
              <Button
                type="button"
                variant="outline"
                size={isMobile ? 'icon' : 'sm'}
                disabled={disabled || !isConnected || rootLoading}
                aria-label={t('settings.dirPickerRefresh')}
                data-testid="dir-picker-refresh"
                onClick={() => void loadDirectory(rootPath || '', { expand: true })}
              >
                <RefreshCw size={14} aria-hidden="true" className={rootLoading ? 'animate-spin' : undefined} />
              </Button>
            </span>
          </Tooltip>
        </div>
      </div>

      <Input
        size={isMobile ? 'default' : 'sm'}
        value={filterText}
        disabled={disabled || !isConnected}
        placeholder={t('settings.dirPickerFilterPlaceholder')}
        aria-label={t('settings.dirPickerFilterPlaceholder')}
        data-testid="dir-picker-filter"
        onChange={(e) => setFilterText(e.currentTarget.value)}
      />

      {errorText ? (
        <div
          role="alert"
          data-testid="dir-picker-error"
          className="flex items-center justify-between gap-2 rounded-card border border-destructive bg-card px-3 py-2 text-caption text-destructive"
        >
          <span className="min-w-0 flex-1 break-words">{errorText}</span>
          <Button
            type="button"
            size={isMobile ? 'default' : 'sm'}
            variant="ghost"
            className="shrink-0"
            onClick={() => void loadDirectory(rootPath || '', { expand: true })}
          >
            {t('settings.retry')}
          </Button>
        </div>
      ) : null}

      <div
        className="max-h-60 overflow-y-auto rounded-card border border-border-subtle bg-card p-1"
        role="tree"
        aria-label={t('settings.dirPickerTitle')}
      >
        {!isConnected && !rootMeta ? (
          <div className="px-3 py-3 text-caption text-muted-foreground">
            {t('settings.projectsOfflineHint')}
          </div>
        ) : rootLoading && !rootPath ? (
          <div className="px-3 py-3 text-caption text-muted-foreground">
            {t('settings.dirPickerLoading')}
          </div>
        ) : (
          renderTreeNodes(rootPath, 0)
        )}
      </div>

      {normalizedSelected ? (
        <div className="truncate font-code text-caption text-muted-foreground">
          {t('settings.dirPickerSelected', { path: normalizedSelected })}
        </div>
      ) : null}
    </div>
  );
}
