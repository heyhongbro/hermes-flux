/**
 * 技能与节点 Markdown 正文及 YAML Frontmatter 共享视图组件 (SkillMarkdownView)
 *
 * 【设计意图 (Why)】
 *   消除 `SkillDetailDialog`（设置中心技能市场）与 `ConstellationNodeDetailDialog`（认知星图大弹窗）
 *   在 YAML frontmatter 解析卡片、双视图（`rendered` / `raw`）切换呈现上的逻辑与样式重复：
 *   1. 全站统一复用唯一 `<MarkdownBlock>` 呈现清洗后的 Markdown 正文；
 *   2. 严格保留 frontmatter 独立信息卡；仅有 frontmatter 而无正文时不回落渲染带分割线的全文，避免错乱。
 */

import * as React from 'react';
import { splitSkillMarkdownFrontmatter } from '@hermes-flux/core';
import { MarkdownBlock } from '../conversation/MarkdownBlock.js';

export type SkillMarkdownViewMode = 'rendered' | 'raw';

export interface SkillMarkdownViewProps {
  markdown: string;
  viewMode: SkillMarkdownViewMode;
  fallbackToRawPreWhenNoFrontmatter?: boolean;
}

export function SkillMarkdownView({
  markdown,
  viewMode,
  fallbackToRawPreWhenNoFrontmatter = false,
}: SkillMarkdownViewProps): React.ReactElement {
  const parsed = React.useMemo(() => splitSkillMarkdownFrontmatter(markdown), [markdown]);

  if (viewMode === 'raw') {
    return (
      <pre
        data-skill-markdown-raw="true"
        className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-panel bg-code p-4 font-code text-aux leading-normal text-foreground"
      >
        {markdown}
      </pre>
    );
  }

  return (
    <div data-skill-markdown-rendered="true" className="flex flex-col gap-4">
      {parsed.frontmatter.length > 0 ? (
        <div className="flex shrink-0 flex-col gap-1 rounded-panel surface-raised px-3 py-2">
          {parsed.frontmatter.map((entry) => (
            <div key={entry.key} className="flex items-baseline gap-3 text-caption">
              <span className="shrink-0 font-code text-muted-foreground">{entry.key}</span>
              <span className="min-w-0 flex-1 break-words text-foreground">{entry.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {parsed.body.trim() ? (
        <MarkdownBlock content={parsed.body} className="text-body" />
      ) : fallbackToRawPreWhenNoFrontmatter && parsed.frontmatter.length === 0 ? (
        <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-panel bg-code p-4 font-code text-aux leading-normal text-foreground">
          {markdown}
        </pre>
      ) : null}
    </div>
  );
}
