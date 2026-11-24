/**
 * 移动端无顶栏检查舱右屏 (MobileInspectorScreen)
 *
 * 【设计意图 (Why)】
 *   提供与桌面右栏同源的产出检视能力，并按竖屏体验极简化：
 *   1. 无顶栏，顶部悬浮单排四栏纯哑光分段胶囊（`成果物 | 变更 | 文件 | 记忆/成员`）与右上角显式
 *      返回对话舞台悬浮钮，既支持任意空白区右滑返回，也提供一眼可见的切回入口；
 *   2. `文件` Tab 直接与桌面 `InspectionPod` 对齐，复用 `@hermes-flux/core` 工作区文件树过滤与懒加载，
 *      点按目录展开、点按文件滑入全屏阅读器（支持代码/Markdown/图片预览、复制与导出下载）；
 *   3. `记忆` Tab（非群聊下）挂载对标官方 App 的认知星图 `MobileConstellationPanel`，
 *      群聊聚焦下保持展示群成员清单；
 *   4. 代码与 Diff 横向滚动区显式声明 `data-gesture-ignore="pan-x"`，避免左右阅读长代码时
 *      误触发三屏手势返回对话舞台。
 */

import * as React from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileCode2,
  FileDiff,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  PanelRightClose,
  RotateCw,
  Search,
  Sparkles,
  Users,
} from 'lucide-react';
import {
  filterFileTree,
  formatFileSize,
  isImageExtension,
  normalizeWorkspacePath,
  type FileTreeLoadState,
  type FileTreeNode,
  type LearningDetailState,
  type LearningLoadState,
} from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import type { LeftRailActiveFocus } from '../leftRailModel.js';
import type { SettingsActions } from '../settings/settingsModel.js';
import type { MobileInspectorTab } from './mobileShellModel.js';
import { MobileConstellationPanel } from './MobileConstellationPanel.js';
import { MobileFloatingBackBar } from './MobileMenuPrimitives.js';
import type { MobileInspectorReaderItem } from './types.js';

export interface MobileInspectorScreenProps {
  activeFocus: LeftRailActiveFocus;
  activeTab: MobileInspectorTab;
  readerOpen: boolean;
  readerItem: MobileInspectorReaderItem | null;
  artifacts: Array<{ id: string; name: string; type: string; size: string; preview?: string }>;
  gitDiffs: Array<{ file: string; additions: number; deletions: number; patch?: string }>;
  openFiles: Array<{ id?: string; path: string; content: string; language?: string; isDiff?: boolean }>;
  fileTreeState: FileTreeLoadState;
  fileTreeExpandedPaths: string[];
  fileTreeFilterQuery: string;
  activeFilePath: string;
  workspaceRootName?: string;
  memories: Array<{ category: string; content: string; updated?: string }>;
  inspectorBotProfile?: string;
  inspectorBotLabel?: string;
  learningState: LearningLoadState;
  learningDetail: LearningDetailState;
  groupMembers: Array<{ name: string; displayName: string; avatar?: string }>;
  onSelectTab: (tab: MobileInspectorTab) => void;
  onOpenItem: (item: MobileInspectorReaderItem) => void;
  onCloseReader: () => void;
  onCopyText: (text: string) => void;
  onBackToStage?: () => void;
  onLoadFileTree: (force?: boolean) => void;
  onToggleFileTreeDir: (dirPath: string) => void;
  onFilterFileTree: (query: string) => void;
  onOpenWorkspaceFile: (filePath: string) => void;
  onDownloadInspectorFile: () => void;
  onEnsureLearning?: (profile: string) => void;
  onRefreshLearning: (profile?: string) => void;
  onLoadLearningDetail: (id: string, profile?: string) => void;
  onEditLearningNode?: (id: string, content: string, profile?: string) => Promise<{ ok: boolean; message?: string }>;
  onDeleteLearningNode?: (id: string, profile?: string) => Promise<{ ok: boolean; message?: string }>;
  onInspectSkill?: SettingsActions['onInspectSkill'];
  onNotify?: SettingsActions['onNotify'];
}

export function MobileInspectorScreen({
  activeFocus,
  activeTab,
  readerOpen,
  readerItem,
  artifacts,
  gitDiffs,
  openFiles,
  fileTreeState,
  fileTreeExpandedPaths,
  fileTreeFilterQuery,
  activeFilePath,
  workspaceRootName,
  inspectorBotProfile,
  inspectorBotLabel,
  learningState,
  learningDetail,
  groupMembers,
  onSelectTab,
  onOpenItem,
  onCloseReader,
  onCopyText,
  onBackToStage,
  onLoadFileTree,
  onToggleFileTreeDir,
  onFilterFileTree,
  onOpenWorkspaceFile,
  onDownloadInspectorFile,
  onEnsureLearning,
  onRefreshLearning,
  onLoadLearningDetail,
  onEditLearningNode,
  onDeleteLearningNode,
  onInspectSkill,
  onNotify,
}: MobileInspectorScreenProps): React.ReactElement {
  const isGroup = activeFocus.type === 'group';
  const tabs: Array<{ id: MobileInspectorTab; label: string }> = [
    { id: 'artifacts', label: t('mobile.inspector.tabArtifacts') },
    { id: 'diffs', label: t('mobile.inspector.tabDiffs') },
    { id: 'files', label: t('mobile.inspector.tabFiles') },
    { id: 'memory', label: isGroup ? t('mobile.inspector.tabMembers') : t('mobile.inspector.tabMemory') },
  ];

  const expandedSet = React.useMemo(
    () => new Set(fileTreeExpandedPaths.map((p) => normalizeWorkspacePath(p))),
    [fileTreeExpandedPaths],
  );
  const normActiveFile = normalizeWorkspacePath(activeFilePath);

  const renderTreeNodes = (
    nodes: readonly FileTreeNode[],
    depth: number,
    forceExpandAll: boolean,
  ): React.ReactNode => {
    return nodes.map((node) => {
      const normPath = normalizeWorkspacePath(node.path);
      const paddingLeft = 10 + depth * 16;
      if (node.isDirectory) {
        const isExpanded = forceExpandAll || expandedSet.has(normPath);
        const FolderGlyph = isExpanded ? FolderOpen : Folder;
        const ChevronGlyph = isExpanded ? ChevronDown : ChevronRight;
        return (
          <React.Fragment key={normPath}>
            <button
              type="button"
              className="m-tree-row m-tree-row--dir"
              data-testid={`mobile-tree-dir-${normPath}`}
              aria-expanded={isExpanded}
              style={{ paddingLeft }}
              onClick={() => onToggleFileTreeDir(normPath)}
            >
              <ChevronGlyph size={14} className="m-tree-row__chevron" aria-hidden="true" />
              <FolderGlyph size={16} className="m-tree-row__icon" aria-hidden="true" />
              <span className="m-tree-row__name">{node.name}</span>
            </button>
            {isExpanded && node.children && node.children.length > 0
              ? renderTreeNodes(node.children, depth + 1, forceExpandAll)
              : null}
          </React.Fragment>
        );
      }

      const isActive = Boolean(normActiveFile) && normActiveFile === normPath;
      const FileGlyph = isImageExtension(node.path) ? ImageIcon : FileCode2;
      const sizeText = formatFileSize(node.size);
      return (
        <button
          key={normPath}
          type="button"
          className="m-tree-row m-tree-row--file"
          data-testid={`mobile-tree-file-${normPath}`}
          data-active={isActive ? 'true' : 'false'}
          style={{ paddingLeft: paddingLeft + 14 }}
          onClick={() => onOpenWorkspaceFile(normPath)}
        >
          <FileGlyph size={16} className="m-tree-row__icon" aria-hidden="true" />
          <span className="m-tree-row__name">{node.name}</span>
          {sizeText ? <span className="m-tree-row__size">{sizeText}</span> : null}
        </button>
      );
    });
  };

  const renderFilesTab = (): React.ReactElement => {
    const query = fileTreeFilterQuery || '';
    const hasFilter = query.trim().length > 0;
    const headerTitle = workspaceRootName || t('inspector.fileTreeTitle');

    let treeBody: React.ReactNode = null;
    if (fileTreeState.status === 'loading' || fileTreeState.status === 'idle') {
      treeBody = (
        <div className="m-inspector__empty" data-testid="mobile-file-tree-loading">
          {t('inspector.fileTreeLoading')}
        </div>
      );
    } else if (fileTreeState.status === 'error') {
      treeBody = (
        <div className="m-inspector__tree-state" data-testid="mobile-file-tree-error">
          <p className="m-inspector__empty">{fileTreeState.message || t('inspector.fileTreeError')}</p>
          <button
            type="button"
            className="m-secondary-btn"
            onClick={() => onLoadFileTree(true)}
          >
            {t('inspector.fileTreeRetry')}
          </button>
        </div>
      );
    } else if (fileTreeState.nodes.length === 0 && openFiles.length === 0) {
      treeBody = <div className="m-inspector__empty">{t('inspector.fileTreeEmpty')}</div>;
    } else if (fileTreeState.nodes.length > 0) {
      const visibleNodes = filterFileTree(fileTreeState.nodes, query);
      if (visibleNodes.length === 0) {
        treeBody = <div className="m-inspector__empty">{t('inspector.fileTreeNoMatch')}</div>;
      } else {
        treeBody = (
          <div className="m-inspector-tree__list" role="tree" aria-label={headerTitle}>
            {renderTreeNodes(visibleNodes, 0, hasFilter)}
          </div>
        );
      }
    } else {
      treeBody = (
        <div className="m-inspector__cards">
          {openFiles.map((file) => (
            <button
              key={file.path}
              type="button"
              className="m-inspector-card"
              onClick={() =>
                onOpenItem({
                  kind: 'files',
                  title: file.path,
                  subtitle: file.language,
                  content: file.content,
                  language: file.language,
                  isDiff: file.isDiff,
                  filePath: file.path,
                  canDownload: true,
                })
              }
            >
              <FileCode2 size={16} className="m-inspector-card__icon" aria-hidden="true" />
              <span className="m-inspector-card__body">
                <span className="m-inspector-card__title">{file.path}</span>
                {file.language ? <span className="m-inspector-card__meta">{file.language}</span> : null}
              </span>
              <ChevronRight size={15} className="m-inspector-card__chevron" aria-hidden="true" />
            </button>
          ))}
        </div>
      );
    }

    return (
      <div className="m-inspector-tree" data-testid="mobile-inspector-files-pane">
        <div className="m-inspector-tree__bar">
          <div className="m-inspector-tree__root">
            <Folder size={15} aria-hidden="true" />
            <span className="m-inspector-tree__root-name">{headerTitle}</span>
          </div>
          <button
            type="button"
            className="m-icon-btn"
            data-testid="mobile-inspector-files-refresh"
            aria-label={t('inspector.fileTreeRefresh')}
            onClick={() => onLoadFileTree(true)}
          >
            <RotateCw size={15} />
          </button>
        </div>

        <div className="m-inspector-tree__search m-no-swipe">
          <Search size={14} className="m-inspector-tree__search-icon" aria-hidden="true" />
          <input
            type="search"
            className="m-matte-input m-inspector-tree__filter-input"
            data-testid="mobile-inspector-files-filter"
            value={query}
            placeholder={t('inspector.fileTreeFilterPlaceholder')}
            aria-label={t('inspector.fileTreeFilterPlaceholder')}
            onChange={(e) => onFilterFileTree(e.target.value)}
          />
        </div>

        {treeBody}
      </div>
    );
  };

  const renderListBody = (): React.ReactElement => {
    if (activeTab === 'artifacts') {
      if (artifacts.length === 0) {
        return <div className="m-inspector__empty">{t('mobile.inspector.emptyArtifacts')}</div>;
      }
      return (
        <div className="m-inspector__cards">
          {artifacts.map((art) => (
            <button
              key={art.id}
              type="button"
              className="m-inspector-card"
              onClick={() =>
                onOpenItem({
                  kind: 'artifacts',
                  title: art.name,
                  subtitle: `${art.type} · ${art.size}`,
                  content: art.preview || '',
                })
              }
            >
              <Sparkles size={16} className="m-inspector-card__icon" aria-hidden="true" />
              <span className="m-inspector-card__body">
                <span className="m-inspector-card__title">{art.name}</span>
                <span className="m-inspector-card__meta">{art.type} · {art.size}</span>
              </span>
              <ChevronRight size={15} className="m-inspector-card__chevron" aria-hidden="true" />
            </button>
          ))}
        </div>
      );
    }

    if (activeTab === 'diffs') {
      if (gitDiffs.length === 0) {
        return <div className="m-inspector__empty">{t('mobile.inspector.emptyDiffs')}</div>;
      }
      return (
        <div className="m-inspector__cards">
          {gitDiffs.map((diff) => (
            <button
              key={diff.file}
              type="button"
              className="m-inspector-card"
              onClick={() =>
                onOpenItem({
                  kind: 'diffs',
                  title: diff.file,
                  subtitle: `+${diff.additions} / -${diff.deletions}`,
                  content: diff.patch || '',
                  isDiff: true,
                })
              }
            >
              <FileDiff size={16} className="m-inspector-card__icon" aria-hidden="true" />
              <span className="m-inspector-card__body">
                <span className="m-inspector-card__title">{diff.file}</span>
                <span className="m-inspector-card__diff-counts">
                  <span className="m-diff-add">+{diff.additions}</span>
                  <span className="m-diff-del">-{diff.deletions}</span>
                </span>
              </span>
              <ChevronRight size={15} className="m-inspector-card__chevron" aria-hidden="true" />
            </button>
          ))}
        </div>
      );
    }

    if (activeTab === 'files') {
      return renderFilesTab();
    }

    if (isGroup) {
      if (groupMembers.length === 0) {
        return <div className="m-inspector__empty">{t('mobile.inspector.emptyMembers')}</div>;
      }
      return (
        <div className="m-inspector__cards">
          {groupMembers.map((member) => (
            <div key={member.name} className="m-inspector-card m-inspector-card--static">
              <Users size={16} className="m-inspector-card__icon" aria-hidden="true" />
              <span className="m-inspector-card__body">
                <span className="m-inspector-card__title">{member.displayName}</span>
                <span className="m-inspector-card__meta">{member.name}</span>
              </span>
            </div>
          ))}
        </div>
      );
    }

    const resolvedBotProfile =
      inspectorBotProfile ||
      (activeFocus.type === 'bot' ? activeFocus.botName : '') ||
      'default';

    return (
      <MobileConstellationPanel
        targetProfile={resolvedBotProfile}
        targetBotLabel={inspectorBotLabel}
        learningState={learningState}
        learningDetail={learningDetail}
        onEnsureLoaded={onEnsureLearning}
        onRefresh={onRefreshLearning}
        onSelectNodeDetail={onLoadLearningDetail}
        onSaveEdit={onEditLearningNode}
        onDeleteNode={onDeleteLearningNode}
        onInspectSkill={onInspectSkill}
        onCopyText={onCopyText}
        onNotify={onNotify}
        footerHint={t('mobile.memory.footerHint')}
      />
    );
  };

  const renderReaderBody = (item: MobileInspectorReaderItem): React.ReactNode => {
    if (item.isBinary || item.isTooLarge) {
      return (
        <div className="m-inspector__tree-state">
          <p className="m-inspector__empty">
            {item.content || t('mobile.inspector.fileBinaryHint')}
          </p>
          {item.canDownload ? (
            <button
              type="button"
              className="m-primary-btn"
              onClick={onDownloadInspectorFile}
            >
              <Download size={16} aria-hidden="true" />
              <span>{t('mobile.inspector.downloadFile')}</span>
            </button>
          ) : null}
        </div>
      );
    }
    const lowerContent = item.content.trim().toLowerCase();
    const isSafeImageSrc =
      lowerContent.startsWith('data:image/') ||
      lowerContent.startsWith('https://') ||
      lowerContent.startsWith('http://') ||
      lowerContent.startsWith('blob:');
    if ((item.isImage && isSafeImageSrc) || lowerContent.startsWith('data:image/')) {
      return (
        <div className="m-inspector__reader-image-wrap">
          <img className="m-inspector__reader-image" src={item.content} alt={item.title} />
        </div>
      );
    }
    return (
      <div className="m-inspector__reader-code-wrap" data-gesture-ignore="pan-x">
        <pre className="m-inspector__reader-code">{item.content}</pre>
      </div>
    );
  };

  return (
    <section
      className="m-pane m-inspector"
      data-testid="mobile-inspector-pane"
      aria-label={t('mobile.inspector.tabFiles')}
    >
      <div className="m-inspector__seg-wrap m-no-swipe">
        <div className="m-inspector__segmented" role="tablist">
          {tabs.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                className="m-inspector__seg-btn"
                data-active={active ? 'true' : 'false'}
                onClick={() => onSelectTab(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        {onBackToStage ? (
          <button
            type="button"
            className="m-float-circle-btn m-inspector__back-stage-btn"
            data-testid="mobile-inspector-back-stage"
            aria-label={t('mobile.inspector.backToStageAria')}
            onClick={onBackToStage}
          >
            <PanelRightClose size={18} strokeWidth={1.85} />
          </button>
        ) : null}
      </div>

      <div className="m-inspector__viewport">
        <div className="m-inspector__list-scroll">{renderListBody()}</div>
      </div>

      <div className="m-inspector__reader m-no-swipe" data-open={readerOpen ? 'true' : 'false'}>
        {readerItem ? (
          <>
            <MobileFloatingBackBar
              onBack={onCloseReader}
              backAriaLabel={t('mobile.inspector.backToList')}
              rightAction={
                <>
                  {readerItem.canDownload ? (
                    <button
                      type="button"
                      className="m-float-circle-btn"
                      data-testid="mobile-inspector-download"
                      aria-label={t('mobile.inspector.downloadFile')}
                      onClick={onDownloadInspectorFile}
                    >
                      <Download size={16} />
                    </button>
                  ) : null}
                  {!readerItem.isImage && !readerItem.isBinary && !readerItem.isTooLarge ? (
                    <button
                      type="button"
                      className="m-float-circle-btn"
                      aria-label={t('mobile.inspector.copyContent')}
                      onClick={() => onCopyText(readerItem.content)}
                    >
                      <Copy size={16} />
                    </button>
                  ) : null}
                </>
              }
            />
            <div className="m-inspector__reader-meta">
              <div className="m-inspector__reader-title">{readerItem.title}</div>
              {readerItem.subtitle ? (
                <div className="m-inspector__reader-sub">{readerItem.subtitle}</div>
              ) : null}
            </div>
            {renderReaderBody(readerItem)}
          </>
        ) : null}
      </div>
    </section>
  );
}
