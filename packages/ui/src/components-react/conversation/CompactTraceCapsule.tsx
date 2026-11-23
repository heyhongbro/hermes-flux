/**
 * 移动端紧凑轨迹胶囊与子代理状态条 (CompactTraceCapsule)
 *
 * 【设计意图 (Why)】
 *   移动竖屏视口宽度有限，桌面端逐行平铺思考过程与多步工具调用会迅速淹没对话正文。
 *   本组件在 `compactTrace` 模式下将单条助手消息的：
 *   1. `thought` + 常规 `toolCalls` 收敛为 1 枚 34px 单行纯哑光胶囊（默认折叠，点击按 CSS Grid
 *      `0fr ↔ 1fr` 平滑展开阅读）；
 *   2. 子代理委派调用 (`delegate_task` / `subagent` / `invoke_subagent` / `spawn_agent` /
 *      `ask_side_agent`) 收敛为独立 42px 叠放头像状态条，点击触发详情抽屉查看子代理输出与中断。
 *
 * 【防范的历史坑 (Pitfall)】
 *   流式期间正文与思考由宿主 `tokenStreamWriter` 直接按 `#msg-thought-<id>` 写入 DOM，
 *   工具由 `toolPatchQueue` 直接查找 `#msg-tools-<id>`。若折叠态使用条件渲染销毁这两个 DOM 锚点，
 *   折叠状态下流式内容会丢失！因此内部必须常驻挂载 `#msg-thought-<id>` 与 `#msg-tools-<id>`，
 *   通过外层 Grid `grid-template-rows: 0fr / 1fr` 收折隐藏。
 *
 * 【约束与规则 (Rules)】
 *   - 零硬编码色值与字体、零硬编码中文文案（全走 `t()`）；
 *   - 纯函数 `partitionMobileTools` 独立导出，供单测直接检验子代理切分不变量。
 */

import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { classifyToolName } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import type { ConversationToolVM } from './types.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { ToolCapsule } from './ToolCapsule.js';
import { useNow } from './useNow.js';
import { ActivityIndicator } from '../primitives/ActivityIndicator.js';
import { parseSubagentToolArgs } from '../mobile/mobileShellModel.js';

const SUBAGENT_TOOL_RE = /(?:^|_|-)(?:delegate_task|subagent|invoke_subagent|spawn_agent|ask_side_agent)(?:$|_|-)/i;

export function isSubagentTool(tool: ConversationToolVM): boolean {
  if (SUBAGENT_TOOL_RE.test(tool.name || '')) return true;
  return classifyToolName(tool.name || '').kind === 'agent';
}

export function partitionMobileTools(tools: readonly ConversationToolVM[]): {
  standardTools: ConversationToolVM[];
  subagentTools: ConversationToolVM[];
} {
  const standardTools: ConversationToolVM[] = [];
  const subagentTools: ConversationToolVM[] = [];
  for (const tool of tools) {
    if (isSubagentTool(tool)) {
      subagentTools.push(tool);
    } else {
      standardTools.push(tool);
    }
  }
  return { standardTools, subagentTools };
}

function summarizeSubagentTarget(tool: ConversationToolVM): string {
  return parseSubagentToolArgs(tool.name, tool.args, t('tool.agent')).summary;
}

export interface CompactTraceCapsuleProps {
  messageId: string;
  thought?: string;
  thoughtDurationMs?: number;
  tools: ConversationToolVM[];
  isStreaming: boolean;
  knownFiles?: readonly string[];
  onOpenSubagentDetail?: (payload: { messageId: string; tools: ConversationToolVM[] }) => void;
}

export function CompactTraceCapsule({
  messageId,
  thought,
  thoughtDurationMs,
  tools,
  isStreaming,
  knownFiles,
  onOpenSubagentDetail,
}: CompactTraceCapsuleProps): React.ReactElement | null {
  const [expanded, setExpanded] = React.useState(false);

  const { standardTools, subagentTools } = React.useMemo(
    () => partitionMobileTools(tools),
    [tools],
  );

  const hasThought = Boolean(thought && thought.trim().length > 0);
  const hasStandardTools = standardTools.length > 0;
  const hasTrace = hasThought || hasStandardTools;
  const hasRunningStandard = standardTools.some((tool) => tool.status === 'running');
  const hasRunningSubagent = subagentTools.some((tool) => tool.status === 'running');
  const now = useNow(hasRunningStandard);

  if (!hasTrace && subagentTools.length === 0) {
    if (!isStreaming) return null;
    // 流式首帧预置 #msg-thought-<id> 与 #msg-tools-<id> 隐藏容器，确保直写锚点就绪
    return (
      <div className="m-trace-anchors" aria-hidden="true">
        <div id={`msg-thought-${messageId}`} className="conv-row__thought m-hidden-anchor" />
        <div id={`msg-tools-${messageId}`} className="conv-tools m-hidden-anchor" />
      </div>
    );
  }

  let traceSummary: string;
  if (hasRunningStandard || (isStreaming && hasThought && !hasStandardTools)) {
    traceSummary = t('mobile.trace.runningSummary');
  } else if (hasThought && hasStandardTools) {
    const sec = ((thoughtDurationMs ?? 800) / 1000).toFixed(1);
    traceSummary = t('mobile.trace.thoughtAndTools', { sec, count: standardTools.length });
  } else if (hasThought) {
    traceSummary = thoughtDurationMs
      ? t('mobile.trace.thoughtOnly', { sec: (thoughtDurationMs / 1000).toFixed(1) })
      : t('mobile.trace.thoughtDefault');
  } else {
    traceSummary = t('mobile.trace.toolsOnly', { count: standardTools.length });
  }

  const subagentSummary = subagentTools.length === 0
    ? ''
    : hasRunningSubagent
      ? t('mobile.trace.subagentRunning')
      : subagentTools.length > 1
        ? t('mobile.trace.subagentMulti', { count: subagentTools.length })
        : t('mobile.trace.subagentSingle', { name: summarizeSubagentTarget(subagentTools[0]) });

  return (
    <div className="m-trace-stack" data-mobile-trace={messageId}>
      {hasTrace ? (
        <div className="m-trace-capsule" data-open={expanded ? 'true' : 'false'}>
          <button
            type="button"
            className="m-trace-pill"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
          >
            {hasRunningStandard || (isStreaming && hasThought && !hasStandardTools) ? (
              <span className="m-trace-dot" aria-hidden="true" />
            ) : null}
            <span className="m-trace-pill__label">{traceSummary}</span>
            <ChevronRight size={14} className="m-trace-pill__chevron" aria-hidden="true" />
          </button>

          <div className="m-trace-drawer" data-open={expanded ? 'true' : 'false'}>
            <div className="m-trace-drawer__inner">
              {hasThought || isStreaming ? (
                <div className="m-trace-thought-box">
                  <MarkdownBlock
                    content={thought || ''}
                    anchorId={`msg-thought-${messageId}`}
                    className="conv-row__thought"
                    knownFiles={knownFiles}
                  />
                </div>
              ) : null}
              <div className="conv-tools" id={`msg-tools-${messageId}`}>
                {standardTools.map((tool) => (
                  <ToolCapsule key={tool.id} tool={tool} now={now} />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="m-trace-anchors" aria-hidden="true">
          <div id={`msg-thought-${messageId}`} className="conv-row__thought m-hidden-anchor" />
          <div id={`msg-tools-${messageId}`} className="conv-tools m-hidden-anchor" />
        </div>
      )}

      {subagentTools.length > 0 ? (
        <button
          type="button"
          className="m-subagent-bar"
          onClick={() => onOpenSubagentDetail?.({ messageId, tools: subagentTools })}
        >
          <span className="m-subagent-avatars" aria-hidden="true">
            {subagentTools.slice(0, 3).map((tool, index) => (
              <span key={tool.id || index} className="m-subagent-avatar-chip">
                {summarizeSubagentTarget(tool).slice(0, 1).toUpperCase()}
              </span>
            ))}
          </span>
          <span className="m-subagent-bar__label">{subagentSummary}</span>
          {hasRunningSubagent ? (
            <ActivityIndicator
              state="running"
              placement="inline"
              entityKind="bot"
              variant="prolate-lattice"
            />
          ) : (
            <ChevronRight size={14} className="m-trace-pill__chevron" aria-hidden="true" />
          )}
        </button>
      ) : null}
    </div>
  );
}
