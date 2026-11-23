/**
 * 移动端「记忆与学习 — 认知星图 (Your Constellation)」交互组件 (MobileConstellationPanel)
 *
 * 【设计意图 (Why)】
 *   对齐官方 App 的记忆与学习界面设计：
 *   1. 将来自网关 `learning.frames` 的自学习记忆与提炼技能合成为「认知星图」主卡：
 *      顶栏显示星图图标、标题、`All/Memories/Skills` 筛选与节点总数；
 *   2. 中部画布以当前选中条目为核心，绘制语义/共学/同域 SVG 连线并环绕排布关联节点，
 *      支持点按任意星点平滑切换居中焦点，同时提供簇分页按钮遍历全部节点；
 *   3. 底部预览条即时展示核心记忆/技能全文摘要、类型、使用次数 (`xN uses`) 与日期，
 *      点击右箭头下钻内联详情阅读页，按 `learning.detail` / `learning.edit` / `learning.delete`
 *      支持查看完整正文、复制、在线编辑保存与两步确认删除。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 星图卡片严禁使用硬编码颜色或刺眼高饱和发光阴影，连线与聚焦圈统一消费 `--border` / `--primary`；
 *   2. 节点按钮与翻页/操作按钮热区严格 `>= 44px`，画布声明 `.m-no-swipe` 避免与三屏切换冲突；
 *   3. 详情编辑/删除状态严格按当前选中 `id` 校验，防止快速切换星点时旧详情串台。
 */

import * as React from 'react';
import {
  ArrowLeft,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Network,
  Pencil,
  RotateCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  layoutConstellationWindow,
  type LearningDetailState,
  type LearningFilterKind,
  type LearningLoadState,
} from '@hermes-flux/core';
import { t } from '../../i18n/index.js';

export interface MobileConstellationPanelProps {
  learningState: LearningLoadState;
  learningDetail: LearningDetailState;
  onRefresh: () => void;
  onSelectNodeDetail: (id: string) => void;
  onSaveEdit?: (id: string, content: string) => Promise<{ ok: boolean; message?: string }>;
  onDeleteNode?: (id: string) => Promise<{ ok: boolean; message?: string }>;
  onCopyText?: (text: string) => void;
  footerHint?: string;
}

export function MobileConstellationPanel({
  learningState,
  learningDetail,
  onRefresh,
  onSelectNodeDetail,
  onSaveEdit,
  onDeleteNode,
  onCopyText,
  footerHint,
}: MobileConstellationPanelProps): React.ReactElement {
  const [filter, setFilter] = React.useState<LearningFilterKind>('all');
  const [selectedId, setSelectedId] = React.useState<string | undefined>(undefined);
  const [page, setPage] = React.useState(0);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [editDraft, setEditDraft] = React.useState('');
  const [actionBusy, setActionBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState('');
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const layout = React.useMemo(() => {
    if (learningState.status !== 'ready') return null;
    return layoutConstellationWindow(learningState.graph, {
      selectedId,
      filter,
      page,
      maxRingNodes: 6,
    });
  }, [learningState, selectedId, filter, page]);

  const activeNode = layout?.activeNode ?? null;
  const latestActiveIdRef = React.useRef<string | undefined>(undefined);
  latestActiveIdRef.current = activeNode?.id;

  React.useEffect(() => {
    setEditing(false);
    setConfirmDelete(false);
    setActionError('');
  }, [activeNode?.id]);

  if (learningState.status === 'idle' || learningState.status === 'loading') {
    return (
      <div className="m-constellation-wrap" data-testid="mobile-constellation-loading">
        <div className="m-constellation-card m-constellation-card--state">
          <p className="m-constellation__state-text">{t('mobile.memory.loading')}</p>
        </div>
        {footerHint ? <p className="m-constellation__footer-hint">{footerHint}</p> : null}
      </div>
    );
  }

  if (learningState.status === 'error') {
    return (
      <div className="m-constellation-wrap" data-testid="mobile-constellation-error">
        <div className="m-constellation-card m-constellation-card--state">
          <p className="m-constellation__state-text">
            {learningState.message || t('mobile.memory.loadError')}
          </p>
          <button type="button" className="m-secondary-btn" onClick={onRefresh}>
            {t('bot.retry')}
          </button>
        </div>
        {footerHint ? <p className="m-constellation__footer-hint">{footerHint}</p> : null}
      </div>
    );
  }

  const graph = learningState.graph;
  if (graph.nodes.length === 0) {
    return (
      <div className="m-constellation-wrap" data-testid="mobile-constellation-empty">
        <div className="m-constellation-card m-constellation-card--state">
          <p className="m-constellation__state-text">{t('mobile.inspector.emptyMemory')}</p>
          <button type="button" className="m-secondary-btn" onClick={onRefresh}>
            {t('mobile.memory.refreshAria')}
          </button>
        </div>
        {footerHint ? <p className="m-constellation__footer-hint">{footerHint}</p> : null}
      </div>
    );
  }

  const resolvedDetail =
    activeNode && learningDetail.status === 'ready' && learningDetail.id === activeNode.id
      ? learningDetail
      : null;
  const detailLoading =
    Boolean(activeNode && learningDetail.status === 'loading' && learningDetail.id === activeNode.id);
  const detailError =
    activeNode && learningDetail.status === 'error' && learningDetail.id === activeNode.id
      ? learningDetail.message
      : '';
  const detailContent = resolvedDetail?.content || activeNode?.preview || '';

  const startEdit = (): void => {
    setEditDraft(detailContent);
    setActionError('');
    setConfirmDelete(false);
    setEditing(true);
  };

  const handleSave = async (): Promise<void> => {
    if (!activeNode || !onSaveEdit || actionBusy) return;
    const targetId = activeNode.id;
    setActionBusy(true);
    setActionError('');
    try {
      const res = await onSaveEdit(targetId, editDraft);
      if (latestActiveIdRef.current !== targetId) return;
      if (res.ok) {
        setEditing(false);
      } else {
        setActionError(res.message || t('settings.loadFailed'));
      }
    } finally {
      setActionBusy(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!activeNode || !onDeleteNode || actionBusy) return;
    const targetId = activeNode.id;
    setActionBusy(true);
    setActionError('');
    try {
      const res = await onDeleteNode(targetId);
      if (res.ok) {
        setConfirmDelete(false);
        setDetailOpen(false);
        setSelectedId(undefined);
      } else if (latestActiveIdRef.current === targetId) {
        setActionError(res.message || t('settings.loadFailed'));
      }
    } finally {
      setActionBusy(false);
    }
  };

  if (detailOpen && activeNode) {
    const kindLabel =
      activeNode.kind === 'skill' ? t('mobile.memory.kindSkill') : t('mobile.memory.kindMemory');
    const canEdit = Boolean(onSaveEdit && !editing && !detailLoading && !detailError && resolvedDetail);
    return (
      <div className="m-constellation-wrap" data-testid="mobile-constellation-detail">
        <div className="m-constellation-card m-constellation-detail">
          <div className="m-constellation-detail__bar">
            <button
              type="button"
              className="m-icon-btn"
              data-testid="mobile-constellation-detail-back"
              aria-label={t('mobile.inspector.backToList')}
              disabled={actionBusy}
              onClick={() => {
                setDetailOpen(false);
                setEditing(false);
                setConfirmDelete(false);
              }}
            >
              <ArrowLeft size={18} />
            </button>
            <div className="m-constellation-detail__titles">
              <div className="m-constellation-detail__title">{activeNode.label}</div>
              <div className="m-constellation-detail__meta">
                {kindLabel} · {t('mobile.memory.usesCount', { count: activeNode.uses })}
                {activeNode.date ? ` · ${activeNode.date}` : ''}
              </div>
            </div>
            <div className="m-constellation-detail__actions">
              {onCopyText ? (
                <button
                  type="button"
                  className="m-icon-btn"
                  aria-label={t('mobile.inspector.copyContent')}
                  onClick={() => onCopyText(detailContent)}
                >
                  <Copy size={16} />
                </button>
              ) : null}
              {canEdit ? (
                <button
                  type="button"
                  className="m-icon-btn"
                  data-testid="mobile-constellation-edit"
                  aria-label={t('mobile.memory.editBtn')}
                  disabled={actionBusy}
                  onClick={startEdit}
                >
                  <Pencil size={16} />
                </button>
              ) : null}
              {onDeleteNode && !editing ? (
                <button
                  type="button"
                  className="m-icon-btn"
                  data-testid="mobile-constellation-delete"
                  aria-label={t('mobile.memory.deleteBtn')}
                  disabled={actionBusy}
                  onClick={() => setConfirmDelete((prev) => !prev)}
                >
                  <Trash2 size={16} />
                </button>
              ) : null}
            </div>
          </div>

          {actionError ? (
            <div className="m-bot-banner m-bot-banner--error" role="alert">
              <span className="m-bot-banner__text">{actionError}</span>
            </div>
          ) : null}

          {confirmDelete ? (
            <div className="m-bot-banner m-bot-banner--warn" role="status">
              <span className="m-bot-banner__text">{t('mobile.memory.deleteConfirmTitle')}</span>
              <div className="m-settings-btn-row">
                <button
                  type="button"
                  className="m-secondary-btn"
                  disabled={actionBusy}
                  onClick={() => setConfirmDelete(false)}
                >
                  {t('mobile.memory.cancelEditBtn')}
                </button>
                <button
                  type="button"
                  className="m-danger-btn"
                  data-testid="mobile-constellation-delete-confirm"
                  disabled={actionBusy}
                  onClick={() => void handleDelete()}
                >
                  {t('mobile.memory.deleteConfirmBtn')}
                </button>
              </div>
            </div>
          ) : null}

          {detailLoading ? (
            <p className="m-constellation__state-text">{t('mobile.memory.detailLoading')}</p>
          ) : detailError ? (
            <div className="m-bot-banner m-bot-banner--error" role="alert">
              <span className="m-bot-banner__text">{detailError}</span>
              <button
                type="button"
                className="m-secondary-btn"
                onClick={() => onSelectNodeDetail(activeNode.id)}
              >
                {t('bot.retry')}
              </button>
            </div>
          ) : editing ? (
            <div className="m-constellation-detail__editor-wrap">
              <textarea
                className="m-matte-input m-bot-soul-editor m-constellation__editor"
                value={editDraft}
                disabled={actionBusy}
                onChange={(e) => setEditDraft(e.target.value)}
              />
              <div className="m-settings-btn-row">
                <button
                  type="button"
                  className="m-secondary-btn"
                  disabled={actionBusy}
                  onClick={() => setEditing(false)}
                >
                  {t('mobile.memory.cancelEditBtn')}
                </button>
                <button
                  type="button"
                  className="m-primary-btn"
                  data-testid="mobile-constellation-save"
                  disabled={actionBusy}
                  onClick={() => void handleSave()}
                >
                  <Check size={15} aria-hidden="true" />
                  <span>{actionBusy ? t('mobile.memory.savingBtn') : t('mobile.memory.saveBtn')}</span>
                </button>
              </div>
            </div>
          ) : (
            <pre className="m-constellation-detail__body">{detailContent}</pre>
          )}
        </div>
        {footerHint ? <p className="m-constellation__footer-hint">{footerHint}</p> : null}
      </div>
    );
  }

  const resolvedLayout = layout!;
  const posMap = new Map(resolvedLayout.positionedNodes.map((n) => [n.id, n]));
  const filterOptions: Array<{ id: LearningFilterKind; label: string }> = [
    { id: 'all', label: `${t('mobile.memory.filterAll')} (${graph.nodes.length})` },
    { id: 'memory', label: `${t('mobile.memory.filterMemory')} (${graph.totalMemories})` },
    { id: 'skill', label: `${t('mobile.memory.filterSkill')} (${graph.totalSkills})` },
  ];

  return (
    <div className="m-constellation-wrap" data-testid="mobile-constellation-panel">
      <div className="m-constellation-card">
        <div className="m-constellation__header">
          <div className="m-constellation__title-wrap">
            <Network size={16} className="m-constellation__title-icon" aria-hidden="true" />
            <span className="m-constellation__title">{t('mobile.memory.constellationTitle')}</span>
          </div>
          <div className="m-constellation__header-right">
            <span className="m-constellation__count">{graph.nodes.length}</span>
            <button
              type="button"
              className="m-icon-btn"
              data-testid="mobile-constellation-refresh"
              aria-label={t('mobile.memory.refreshAria')}
              onClick={onRefresh}
            >
              <RotateCw size={15} />
            </button>
          </div>
        </div>

        <div className="m-constellation__filters" role="group">
          {filterOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className="m-settings-chip-btn"
              data-active={filter === opt.id ? 'true' : 'false'}
              onClick={() => {
                setFilter(opt.id);
                setPage(0);
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {!activeNode ? (
          <div className="m-constellation-card--state">
            <p className="m-constellation__state-text">{t('mobile.memory.emptyFilter')}</p>
          </div>
        ) : (
          <>
            <div className="m-constellation__stage m-no-swipe" data-gesture-ignore="pan-x">
              <svg
                className="m-constellation__lines"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {resolvedLayout.visibleEdges.map((edge) => {
                  const src = posMap.get(edge.source)!;
                  const dst = posMap.get(edge.target)!;
                  const activeEdge = src.isCenter || dst.isCenter;
                  return (
                    <line
                      key={`${edge.source}-${edge.target}`}
                      x1={src.x}
                      y1={src.y}
                      x2={dst.x}
                      y2={dst.y}
                      className="m-constellation__edge"
                      data-active={activeEdge ? 'true' : 'false'}
                      data-kind={edge.kind}
                    />
                  );
                })}
              </svg>

              {resolvedLayout.positionedNodes.map((node) => {
                const Icon = node.kind === 'skill' ? Sparkles : Brain;
                return (
                  <button
                    key={node.id}
                    type="button"
                    className="m-constellation-node"
                    data-testid={`mobile-constellation-node-${node.id}`}
                    data-center={node.isCenter ? 'true' : 'false'}
                    data-kind={node.kind}
                    style={{ left: `${node.x}%`, top: `${node.y}%` }}
                    onClick={() => {
                      setSelectedId(node.id);
                      setPage(0);
                    }}
                  >
                    <span className="m-constellation-node__circle" aria-hidden="true">
                      <Icon size={16} strokeWidth={1.85} />
                    </span>
                    <span className="m-constellation-node__label">{node.label}</span>
                  </button>
                );
              })}
            </div>

            {resolvedLayout.totalPages > 1 ? (
              <div className="m-constellation__pager">
                <button
                  type="button"
                  className="m-icon-btn"
                  aria-label={t('mobile.memory.prevPageAria')}
                  disabled={resolvedLayout.currentPage === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="m-constellation__page-label">
                  {resolvedLayout.currentPage + 1} / {resolvedLayout.totalPages}
                </span>
                <button
                  type="button"
                  className="m-icon-btn"
                  aria-label={t('mobile.memory.nextPageAria')}
                  disabled={resolvedLayout.currentPage >= resolvedLayout.totalPages - 1}
                  onClick={() => setPage((p) => Math.min(resolvedLayout.totalPages - 1, p + 1))}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            ) : null}

            <button
              type="button"
              className="m-constellation__preview"
              data-testid="mobile-constellation-open-detail"
              aria-label={t('mobile.memory.openDetailAria')}
              onClick={() => {
                setDetailOpen(true);
                onSelectNodeDetail(activeNode.id);
              }}
            >
              <span className="m-constellation__preview-body">
                <span className="m-constellation__preview-title">{activeNode.fullLabel}</span>
                <span className="m-constellation__preview-meta">
                  {activeNode.kind === 'skill'
                    ? t('mobile.memory.kindSkill')
                    : t('mobile.memory.kindMemory')}
                  {' · '}
                  {t('mobile.memory.usesCount', { count: activeNode.uses })}
                </span>
                {activeNode.date ? (
                  <span className="m-constellation__preview-date">{activeNode.date}</span>
                ) : null}
              </span>
              <ChevronRight size={16} className="m-constellation__preview-chevron" aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      {footerHint ? <p className="m-constellation__footer-hint">{footerHint}</p> : null}
    </div>
  );
}
