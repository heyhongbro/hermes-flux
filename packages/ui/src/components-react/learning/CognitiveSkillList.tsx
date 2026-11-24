/**
 * 星图下方技能清单面板 (CognitiveSkillList)
 *
 * 【设计意图 (Why)】
 *   星图聚焦空间拓扑与关联，技能清单承载高频检索与按调用次数/关联度快速筛选：
 *   - 展示技能名、分类/简介、被调用次数 (`xN`) 与关联技能数；
 *   - 点击整张技能卡片直接开启大尺寸详情阅读/源码弹窗，右侧定位按钮可在上方星图中居中高亮对应节点。
 */

import * as React from 'react';
import { LocateFixed, Search, Sparkles } from 'lucide-react';
import type { ConstellationNode, ConstellationSkillSummary } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import { Tooltip } from '../primitives/Tooltip.js';

export type SkillListSortMode = 'uses' | 'links' | 'name';

export interface CognitiveSkillListProps {
  skills: readonly ConstellationSkillSummary[];
  selectedNodeId?: string;
  testIdPrefix: string;
  onOpenSkillDetail: (node: ConstellationNode) => void;
  onFocusSkillOnMap: (nodeId: string) => void;
}

export function CognitiveSkillList({
  skills,
  selectedNodeId,
  testIdPrefix,
  onOpenSkillDetail,
  onFocusSkillOnMap,
}: CognitiveSkillListProps): React.ReactElement {
  const [query, setQuery] = React.useState('');
  const [sortBy, setSortBy] = React.useState<SkillListSortMode>('uses');

  const totalCalls = React.useMemo(
    () => skills.reduce((sum, item) => sum + item.uses, 0),
    [skills],
  );

  const visibleSkills = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? skills.filter(
          (item) =>
            item.skillName.toLowerCase().includes(needle) ||
            item.node.label.toLowerCase().includes(needle) ||
            item.node.category.toLowerCase().includes(needle) ||
            (item.node.description || item.node.preview).toLowerCase().includes(needle),
        )
      : [...skills];

    filtered.sort((a, b) => {
      if (sortBy === 'links') {
        return b.linkCount - a.linkCount || b.uses - a.uses || a.node.label.localeCompare(b.node.label);
      }
      if (sortBy === 'name') {
        return a.node.label.localeCompare(b.node.label) || b.uses - a.uses;
      }
      return b.uses - a.uses || b.linkCount - a.linkCount || a.node.label.localeCompare(b.node.label);
    });
    return filtered;
  }, [skills, query, sortBy]);

  const sortOptions: ReadonlyArray<{ id: SkillListSortMode; label: string }> = [
    { id: 'uses', label: t('mobile.memory.skillListSortUses') },
    { id: 'links', label: t('mobile.memory.skillListSortLinks') },
    { id: 'name', label: t('mobile.memory.skillListSortName') },
  ];

  return (
    <section
      className="constellation-card"
      data-testid={`${testIdPrefix}-skill-list`}
      aria-label={t('mobile.memory.skillListTitle', { count: skills.length })}
    >
      <div className="constellation-skills-head">
        <div className="constellation-header__left">
          <Sparkles size={15} className="constellation-header__icon" aria-hidden="true" />
          <span className="constellation-header__title">
            {t('mobile.memory.skillListTitle', { count: skills.length })}
          </span>
        </div>
        <span className="constellation-stats">
          {t('mobile.memory.totalCallsCount', { count: totalCalls })}
        </span>
      </div>

      {skills.length > 0 ? (
        <div className="constellation-skills-controls">
          <div className="constellation-skills-search">
            <Search size={14} className="constellation-skills-search__icon" aria-hidden="true" />
            <input
              type="search"
              className="constellation-skills-search__input"
              data-testid={`${testIdPrefix}-skill-search`}
              value={query}
              placeholder={t('mobile.memory.skillListSearchPlaceholder')}
              aria-label={t('mobile.memory.skillListSearchPlaceholder')}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="constellation-filters" role="group">
            {sortOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className="constellation-chip"
                data-testid={`${testIdPrefix}-skill-sort-${opt.id}`}
                data-active={sortBy === opt.id ? 'true' : 'false'}
                onClick={() => setSortBy(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {visibleSkills.length === 0 ? (
        <div className="constellation-card constellation-card--state">
          <p className="constellation-state__text">{t('mobile.memory.skillListEmpty')}</p>
        </div>
      ) : (
        <div className="constellation-skill-grid">
          {visibleSkills.map((item) => {
            const desc = (item.node.description || item.node.preview || '').trim();
            const showDesc = desc && desc !== item.node.label;
            const isSelected = selectedNodeId === item.node.id;
            return (
              <div
                key={item.node.id}
                className="constellation-skill-row"
                data-selected={isSelected ? 'true' : 'false'}
              >
                <button
                  type="button"
                  className="constellation-skill-row__main"
                  data-testid={`${testIdPrefix}-skill-item-${item.node.id}`}
                  onClick={() => onOpenSkillDetail(item.node)}
                >
                  <span className="constellation-skill-row__top">
                    <span className="constellation-skill-row__name">{item.node.label}</span>
                    <span className="constellation-skill-row__uses">{`x${item.uses}`}</span>
                  </span>
                  {showDesc ? (
                    <span className="constellation-skill-row__desc">{desc}</span>
                  ) : null}
                  <span className="constellation-skill-row__meta">
                    {item.node.category ? <span>{item.node.category}</span> : null}
                    <span>·</span>
                    <span>{t('mobile.memory.skillLinksCount', { count: item.linkCount })}</span>
                  </span>
                </button>
                <Tooltip content={t('mobile.memory.focusOnMapAria')} placement="top">
                  <button
                    type="button"
                    className="constellation-skill-row__focus"
                    data-testid={`${testIdPrefix}-skill-focus-${item.node.id}`}
                    aria-label={t('mobile.memory.focusOnMapAria')}
                    onClick={() => onFocusSkillOnMap(item.node.id)}
                  >
                    <LocateFixed size={15} aria-hidden="true" />
                  </button>
                </Tooltip>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
