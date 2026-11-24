/**
 * 跨端统一「认知星图 + 技能清单 + 大号详情窗」共享工作台 (CognitiveStarMapPanel)
 *
 * 【设计意图 (Why)】
 *   遵循 AGENTS.md UI 高抽象复用铁律，桌面端（Bot 配置中枢 / 状态栏直达）与移动端（检查舱记忆页 / Bot Hub）
 *   共享同一套组件树与交互语义，仅通过 `variant: 'desktop' | 'mobile'` 调整触控热区与容器画幅：
 *   1. Profile 串台物理阻断：若当前 `learningState.profile` 与目标 `targetProfile` 不一致，
 *      立即进入加载态并触发 `onEnsureLoaded(targetProfile)`，绝不把默认 Bot 的数据渲染在其它 Bot 名下；
 *   2. 完整关联星图（无分页）：`layoutFullConstellationGraph` 渲染全量技能/记忆节点、技能关联连线与调用次数；
 *   3. 星图下方呈现可搜索/排序的技能清单，点击技能弹出大尺寸详情读/编弹窗并支持关联技能跳转。
 */

import * as React from 'react';
import { Network, RotateCw } from 'lucide-react';
import {
  extractConstellationSkillList,
  layoutFullConstellationGraph,
  normalizeLearningProfile,
  type LearningDetailState,
  type LearningFilterKind,
  type LearningLoadState,
} from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import type { SettingsActions } from '../settings/settingsModel.js';
import { CognitiveSkillList } from './CognitiveSkillList.js';
import { CognitiveStarMapCanvas, type StarMapFocusRequest } from './CognitiveStarMapCanvas.js';
import {
  ConstellationNodeDetailDialog,
  type RelatedSkillChip,
} from './ConstellationNodeDetailDialog.js';

export interface CognitiveStarMapPanelProps {
  targetProfile: string;
  targetBotLabel?: string;
  variant?: 'desktop' | 'mobile';
  testIdPrefix?: string;
  learningState: LearningLoadState;
  learningDetail: LearningDetailState;
  onEnsureLoaded?: (profile: string) => void;
  onRefresh: (profile?: string) => void;
  onSelectNodeDetail: (id: string, profile?: string) => void;
  onSaveEdit?: (id: string, content: string, profile?: string) => Promise<{ ok: boolean; message?: string }>;
  onDeleteNode?: (id: string, profile?: string) => Promise<{ ok: boolean; message?: string }>;
  onInspectSkill?: SettingsActions['onInspectSkill'];
  onCopyText?: (text: string) => void;
  onNotify?: (message: string) => void;
  footerHint?: string;
}

export function CognitiveStarMapPanel({
  targetProfile,
  targetBotLabel,
  variant = 'desktop',
  testIdPrefix = variant === 'mobile' ? 'mobile-constellation' : 'desktop-constellation',
  learningState,
  learningDetail,
  onEnsureLoaded,
  onRefresh,
  onSelectNodeDetail,
  onSaveEdit,
  onDeleteNode,
  onInspectSkill,
  onCopyText,
  onNotify,
  footerHint,
}: CognitiveStarMapPanelProps): React.ReactElement {
  const normalizedProfile = normalizeLearningProfile(targetProfile);
  const [filter, setFilter] = React.useState<LearningFilterKind>('all');
  const [selectedId, setSelectedId] = React.useState<string | undefined>(undefined);
  const [detailNodeId, setDetailNodeId] = React.useState<string | null>(null);
  const [focusRequest, setFocusRequest] = React.useState<StarMapFocusRequest | null>(null);
  const focusSeqRef = React.useRef(0);

  const loadedProfile =
    learningState.status !== 'idle' && learningState.profile
      ? normalizeLearningProfile(learningState.profile)
      : undefined;
  const isProfileMismatch =
    Boolean(loadedProfile && loadedProfile !== normalizedProfile);

  React.useEffect(() => {
    setSelectedId(undefined);
    setDetailNodeId(null);
    setFilter('all');
  }, [normalizedProfile]);

  React.useEffect(() => {
    if (learningState.status === 'idle' || isProfileMismatch) {
      onEnsureLoaded?.(normalizedProfile);
    }
  }, [normalizedProfile, learningState.status, isProfileMismatch, onEnsureLoaded]);

  const effectiveState: LearningLoadState = isProfileMismatch
    ? { status: 'loading', profile: normalizedProfile }
    : learningState;

  const layout = React.useMemo(() => {
    if (effectiveState.status !== 'ready') return null;
    return layoutFullConstellationGraph(effectiveState.graph, {
      selectedId,
      filter,
    });
  }, [effectiveState, selectedId, filter]);

  const skillList = React.useMemo(() => {
    if (effectiveState.status !== 'ready') return [];
    return extractConstellationSkillList(effectiveState.graph);
  }, [effectiveState]);

  React.useEffect(() => {
    if (detailNodeId && effectiveState.status === 'ready') {
      const stillExists = effectiveState.graph.nodes.some((n) => n.id === detailNodeId);
      if (!stillExists) {
        setDetailNodeId(null);
      }
    }
  }, [detailNodeId, effectiveState]);

  const botBadgeLabel = targetBotLabel && targetBotLabel !== normalizedProfile
    ? `${targetBotLabel} (${normalizedProfile})`
    : normalizedProfile;

  if (effectiveState.status === 'idle' || effectiveState.status === 'loading') {
    return (
      <div
        className="constellation-panel"
        data-variant={variant}
        data-flux-island=""
        data-testid={`${testIdPrefix}-loading`}
      >
        <div className="constellation-card constellation-card--state">
          <p className="constellation-state__text m-constellation__state-text">{t('mobile.memory.loading')}</p>
        </div>
        {footerHint ? <p className="constellation-footer-hint">{footerHint}</p> : null}
      </div>
    );
  }

  if (effectiveState.status === 'error') {
    return (
      <div
        className="constellation-panel"
        data-variant={variant}
        data-flux-island=""
        data-testid={`${testIdPrefix}-error`}
      >
        <div className="constellation-card constellation-card--state">
          <p className="constellation-state__text m-constellation__state-text">
            {effectiveState.message || t('mobile.memory.loadError')}
          </p>
          <button
            type="button"
            className="constellation-chip"
            data-testid={`${testIdPrefix}-retry`}
            onClick={() => onRefresh(normalizedProfile)}
          >
            {t('bot.retry')}
          </button>
        </div>
        {footerHint ? <p className="constellation-footer-hint">{footerHint}</p> : null}
      </div>
    );
  }

  const graph = effectiveState.graph;
  if (graph.nodes.length === 0) {
    return (
      <div
        className="constellation-panel"
        data-variant={variant}
        data-flux-island=""
        data-testid={`${testIdPrefix}-empty`}
      >
        <div className="constellation-card constellation-card--state">
          <p className="constellation-state__text m-constellation__state-text">{t('mobile.inspector.emptyMemory')}</p>
          <button
            type="button"
            className="constellation-chip"
            onClick={() => onRefresh(normalizedProfile)}
          >
            {t('mobile.memory.refreshAria')}
          </button>
        </div>
        {footerHint ? <p className="constellation-footer-hint">{footerHint}</p> : null}
      </div>
    );
  }

  const resolvedLayout = layout!;
  const detailNode = detailNodeId
    ? graph.nodes.find((n) => n.id === detailNodeId) ?? null
    : null;

  const relatedSkillChips: RelatedSkillChip[] = [];
  if (detailNode) {
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const relatedIds = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.source === detailNode.id && edge.target !== detailNode.id) relatedIds.add(edge.target);
      else if (edge.target === detailNode.id && edge.source !== detailNode.id) relatedIds.add(edge.source);
    }
    for (const rid of relatedIds) {
      const target = nodeById.get(rid);
      if (target?.kind === 'skill') {
        relatedSkillChips.push({ id: target.id, label: target.label, uses: target.uses });
      }
    }
    relatedSkillChips.sort((a, b) => b.uses - a.uses || a.label.localeCompare(b.label));
  }

  const filterOptions: Array<{ id: LearningFilterKind; label: string }> = [
    { id: 'all', label: `${t('mobile.memory.filterAll')} (${graph.nodes.length})` },
    { id: 'skill', label: `${t('mobile.memory.filterSkill')} (${graph.totalSkills})` },
    { id: 'memory', label: `${t('mobile.memory.filterMemory')} (${graph.totalMemories})` },
  ];

  const openDetailForNode = (nodeId: string): void => {
    setSelectedId(nodeId);
    setDetailNodeId(nodeId);
    onSelectNodeDetail(nodeId, normalizedProfile);
  };

  const handleFocusSkillOnMap = (nodeId: string): void => {
    if (filter === 'memory') setFilter('all');
    setSelectedId(nodeId);
    setFocusRequest({ nodeId, seq: ++focusSeqRef.current });
  };

  const totalSkillLinks =
    typeof graph.totalSkillLinks === 'number'
      ? graph.totalSkillLinks
      : resolvedLayout.skillLinkCount;
  const totalUses = skillList.reduce((acc, item) => acc + item.uses, 0);

  return (
    <div
      className="constellation-panel"
      data-variant={variant}
      data-flux-island=""
      data-profile={normalizedProfile}
      data-testid={`${testIdPrefix}-panel`}
    >
      <div className="constellation-card">
        <div className="constellation-header">
          <div className="constellation-header__left">
            <Network size={16} className="constellation-header__icon" aria-hidden="true" />
            <span className="constellation-header__title">
              {t('mobile.memory.constellationTitle')}
            </span>
            <span className="constellation-bot-badge" data-testid={`${testIdPrefix}-profile-badge`}>
              {botBadgeLabel}
            </span>
          </div>
          <div className="constellation-header__right">
            <span className="constellation-stats">
              {t('mobile.memory.statsSummary', {
                skills: graph.totalSkills,
                memories: graph.totalMemories,
                links: totalSkillLinks,
                uses: totalUses,
              })}
            </span>
            <button
              type="button"
              className="constellation-icon-btn"
              data-testid={`${testIdPrefix}-refresh`}
              aria-label={t('mobile.memory.refreshAria')}
              onClick={() => onRefresh(normalizedProfile)}
            >
              <RotateCw size={15} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="constellation-toolbar">
          <div className="constellation-filters" role="group">
            {filterOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className="constellation-chip"
                data-testid={`${testIdPrefix}-filter-${opt.id}`}
                data-active={filter === opt.id ? 'true' : 'false'}
                onClick={() => setFilter(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {graph.source === 'profile-skills' ? (
          <p className="constellation-state__text" data-testid={`${testIdPrefix}-fallback-hint`}>
            {t('mobile.memory.profileSkillsFallbackHint')}
          </p>
        ) : null}

        <CognitiveStarMapCanvas
          layout={resolvedLayout}
          variant={variant}
          testIdPrefix={testIdPrefix}
          selectedId={selectedId}
          fitTriggerKey={`${normalizedProfile}:${filter}:${graph.nodes.length}:${graph.edges.length}`}
          focusRequest={focusRequest}
          onSelectNode={(nodeId) => setSelectedId(nodeId)}
          onOpenNodeDetail={openDetailForNode}
        />
      </div>

      <CognitiveSkillList
        key={normalizedProfile}
        skills={skillList}
        selectedNodeId={selectedId}
        testIdPrefix={testIdPrefix}
        onOpenSkillDetail={(node) => openDetailForNode(node.id)}
        onFocusSkillOnMap={handleFocusSkillOnMap}
      />

      {footerHint ? <p className="constellation-footer-hint">{footerHint}</p> : null}

      <ConstellationNodeDetailDialog
        open={Boolean(detailNode)}
        variant={variant}
        node={detailNode}
        targetProfile={normalizedProfile}
        learningDetail={learningDetail}
        relatedSkills={relatedSkillChips}
        testIdPrefix={testIdPrefix}
        onClose={() => setDetailNodeId(null)}
        onSelectRelatedNode={openDetailForNode}
        onSelectNodeDetail={onSelectNodeDetail}
        onInspectSkill={onInspectSkill}
        onSaveEdit={onSaveEdit}
        onDeleteNode={onDeleteNode}
        onCopyText={onCopyText}
        onNotify={onNotify}
      />
    </div>
  );
}
