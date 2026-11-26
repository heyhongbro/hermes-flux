/**
 * 移动端紧凑轨迹胶囊与子代理状态条 (CompactTraceCapsule)
 *
 * 【设计意图 (Why)】
 *   移动竖屏视口宽度有限，桌面端逐行平铺思考过程与多步工具调用会迅速淹没对话正文。
 *   本组件在 `compactTrace` 模式下将单条助手消息的：
 *   1. `thought` + 常规 `toolCalls` 收敛为 1 枚 33px 单行纯哑光胶囊（默认折叠，点击按 CSS Grid
 *      `0fr ↔ 1fr` 平滑展开阅读）；
 *   2. 子代理委派调用 (`delegate_task` / `subagent` / `invoke_subagent` / `spawn_agent` /
 *      `ask_side_agent`) 收敛为独立 >=44px 叠放头像状态条，点击触发详情抽屉查看子代理输出与中断。
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
import { classifyToolName, isTimelineKind } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import type { ConversationMessageVM, ConversationToolVM } from './types.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { ToolCapsule } from './ToolCapsule.js';
import { useNow } from './useNow.js';
import { ActivityIndicator } from '../primitives/ActivityIndicator.js';
import { parseSubagentToolArgs } from '../mobile/mobileShellModel.js';

const SUBAGENT_TOOL_RE = /(?:^|_|-)(?:delegate_task|subagent|invoke_subagent|spawn_agent|ask_side_agent)(?:$|_|-)/i;

export interface CompactTraceStep {
  id: string;
  thought?: string;
  thoughtDurationMs?: number;
  tools: ConversationToolVM[];
}

export interface ConsolidatedMobileTurnRow {
  message: ConversationMessageVM;
  traceSteps?: CompactTraceStep[];
}

/**
 * 移动端回合内连续推理/工具轨迹合并（纯函数）。
 *
 * 【设计意图 (Why)】
 *   网关历史把同一助手回合的每次「思考 / 工具调用 / 最终答复」落盘成多条独立 assistant 行，
 *   桌面端靠 `aggregateTurnTools` 把工具并回首行后，移动端仍会为后续每条仅含 `thought` 的行
 *   各渲染一枚「已记录推理过程」胶囊，造成满屏十余条重复胶囊淹没正文。
 *   本函数按时间顺序把同一连续片段内的思考与工具步骤收敛为单一 `traceSteps` 分组，
 *   挂到紧随其后的正文载具行（或末条轨迹行）上只画 1 枚折叠胶囊。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 正在流式的末条消息严禁参与合并：实时直写锚点 `#msg-thought-<id>` 与 `#msg-tools-<id>`
 *      必须稳定留在末行 DOM 上，否则流式阶段内容会丢失；
 *   2. 遇到压缩标记、时间线事件或带附件的助手行必须充当屏障先行冲刷已累计轨迹，
 *      不可跨越屏障吞并顺序；
 *   3. 群聊/单聊若由前置轨迹行携带 `sender`/`senderAvatar`，合并到后续正文行时必须保留首行发送者信息。
 *
 * 【约束与规则 (Rules)】
 *   - 仅做只读视图投影，不修改输入数组及消息对象；
 *   - 严格按原始时间顺序保留每一步的思考与工具配对。
 */
export function consolidateMobileTurnTraces(
  messages: readonly ConversationMessageVM[],
  isStreaming: boolean,
): ConsolidatedMobileTurnRow[] {
  if (messages.length <= 1 || messages[0]?.role !== 'assistant') {
    return messages.map((message) => ({ message }));
  }

  const settledSource = isStreaming ? messages.slice(0, -1) : messages;
  const rows: ConsolidatedMobileTurnRow[] = [];
  let pendingSteps: CompactTraceStep[] = [];
  let firstPendingMsg: ConversationMessageVM | null = null;
  let lastPendingMsg: ConversationMessageVM | null = null;

  const flushPendingAsTraceRow = (): void => {
    if (pendingSteps.length === 0 || !lastPendingMsg) return;
    const carrier: ConversationMessageVM =
      lastPendingMsg.sender || (!firstPendingMsg?.sender && !firstPendingMsg?.senderAvatar)
        ? lastPendingMsg
        : {
            ...lastPendingMsg,
            sender: lastPendingMsg.sender ?? firstPendingMsg?.sender,
            senderAvatar: lastPendingMsg.senderAvatar ?? firstPendingMsg?.senderAvatar,
          };
    rows.push({
      message: carrier,
      traceSteps: pendingSteps,
    });
    pendingSteps = [];
    firstPendingMsg = null;
    lastPendingMsg = null;
  };

  for (const msg of settledSource) {
    const dk = msg.displayKind ?? 'user';
    const isBarrier =
      dk === 'compaction' ||
      isTimelineKind(dk) ||
      Boolean(msg.attachments && msg.attachments.length > 0);
    if (isBarrier) {
      flushPendingAsTraceRow();
      rows.push({ message: msg });
      continue;
    }

    const hasThought = Boolean(msg.thought && msg.thought.trim().length > 0);
    const hasTools = Boolean(msg.toolCalls && msg.toolCalls.length > 0);
    const hasContent = Boolean(msg.content && msg.content.trim().length > 0);

    if (hasThought || hasTools) {
      if (!firstPendingMsg) firstPendingMsg = msg;
      lastPendingMsg = msg;
      pendingSteps.push({
        id: msg.id,
        thought: hasThought ? msg.thought : undefined,
        thoughtDurationMs: msg.thoughtDurationMs,
        tools: msg.toolCalls ?? [],
      });
    }

    if (hasContent) {
      const carrier: ConversationMessageVM =
        pendingSteps.length > 0 && !msg.sender && (firstPendingMsg?.sender || firstPendingMsg?.senderAvatar)
          ? {
              ...msg,
              sender: msg.sender ?? firstPendingMsg?.sender,
              senderAvatar: msg.senderAvatar ?? firstPendingMsg?.senderAvatar,
            }
          : msg;
      rows.push({
        message: carrier,
        traceSteps: pendingSteps.length > 0 ? pendingSteps : undefined,
      });
      pendingSteps = [];
      firstPendingMsg = null;
      lastPendingMsg = null;
    }
  }

  flushPendingAsTraceRow();

  if (isStreaming) {
    rows.push({ message: messages[messages.length - 1] });
  } else if (rows.length === 0) {
    rows.push({ message: messages[messages.length - 1] });
  }

  return rows;
}

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
  /** 多步合并轨迹步骤；缺省或单步时退化为传统单锚点胶囊以保障流式直写不失联 */
  steps?: readonly CompactTraceStep[];
  isStreaming: boolean;
  readOnly?: boolean;
  knownFiles?: readonly string[];
  onOpenSubagentDetail?: (payload: { messageId: string; tools: ConversationToolVM[] }) => void;
}

export function CompactTraceCapsule({
  messageId,
  thought,
  thoughtDurationMs,
  tools,
  steps,
  isStreaming,
  readOnly = false,
  knownFiles,
  onOpenSubagentDetail,
}: CompactTraceCapsuleProps): React.ReactElement | null {
  const [expanded, setExpanded] = React.useState(false);

  const effectiveSteps = React.useMemo<readonly CompactTraceStep[]>(() => {
    if (steps && steps.length > 0) return steps;
    return [{ id: messageId, thought, thoughtDurationMs, tools }];
  }, [steps, messageId, thought, thoughtDurationMs, tools]);

  const {
    partitionedSteps,
    standardTools,
    subagentTools,
    thoughtCount,
    totalThoughtDurationMs,
  } = React.useMemo(() => {
    const pSteps: Array<{
      step: CompactTraceStep;
      hasThought: boolean;
      standardTools: ConversationToolVM[];
    }> = [];
    const allStandard: ConversationToolVM[] = [];
    const allSubagent: ConversationToolVM[] = [];
    let tCount = 0;
    let totalDurMs = 0;

    for (const step of effectiveSteps) {
      const part = partitionMobileTools(step.tools);
      const stepHasThought = Boolean(step.thought && step.thought.trim().length > 0);
      if (stepHasThought) {
        tCount += 1;
        if (typeof step.thoughtDurationMs === 'number' && Number.isFinite(step.thoughtDurationMs) && step.thoughtDurationMs > 0) {
          totalDurMs += step.thoughtDurationMs;
        }
      }
      allStandard.push(...part.standardTools);
      allSubagent.push(...part.subagentTools);
      pSteps.push({
        step,
        hasThought: stepHasThought,
        standardTools: part.standardTools,
      });
    }

    return {
      partitionedSteps: pSteps,
      standardTools: allStandard,
      subagentTools: allSubagent,
      thoughtCount: tCount,
      totalThoughtDurationMs: totalDurMs,
    };
  }, [effectiveSteps]);

  const hasThought = thoughtCount > 0;
  const hasStandardTools = standardTools.length > 0;
  const hasTrace = hasThought || hasStandardTools;
  const hasRunningStandard = standardTools.some((tool) => tool.status === 'running');
  const hasRunningSubagent = subagentTools.some((tool) => tool.status === 'running');
  const now = useNow(hasRunningStandard);

  const showTraceCapsule = hasTrace || isStreaming;
  if (!showTraceCapsule && subagentTools.length === 0) {
    return null;
  }

  const isTraceEmpty = !hasTrace;
  const isStackEmpty = !hasTrace && subagentTools.length === 0;
  const showRunningTraceIndicator = hasRunningStandard || (isStreaming && (!hasStandardTools || !hasTrace));

  let traceSummary: string;
  if (showRunningTraceIndicator) {
    traceSummary = t('mobile.trace.runningSummary');
  } else if (hasThought && hasStandardTools) {
    if (totalThoughtDurationMs > 0) {
      const sec = (totalThoughtDurationMs / 1000).toFixed(1);
      traceSummary = t('mobile.trace.thoughtAndTools', { sec, count: standardTools.length });
    } else {
      traceSummary = t('mobile.trace.thoughtAndToolsNoTime', { count: standardTools.length });
    }
  } else if (hasThought) {
    if (totalThoughtDurationMs > 0) {
      traceSummary = t('mobile.trace.thoughtOnly', { sec: (totalThoughtDurationMs / 1000).toFixed(1) });
    } else if (thoughtCount > 1) {
      traceSummary = t('mobile.trace.thoughtMulti', { count: thoughtCount });
    } else {
      traceSummary = t('mobile.trace.thoughtDefault');
    }
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

  const isMultiStep = effectiveSteps.length > 1;
  const firstStep = partitionedSteps[0];
  const singleStepThought = firstStep.step.thought || '';
  const singleStepHasThought = firstStep.hasThought;

  return (
    <div
      className="m-trace-stack"
      data-mobile-trace={messageId}
      data-mobile-trace-empty={isStackEmpty ? 'true' : 'false'}
    >
      {showTraceCapsule ? (
        <div
          className="m-trace-capsule"
          data-open={expanded ? 'true' : 'false'}
          data-mobile-trace-empty={isTraceEmpty ? 'true' : 'false'}
        >
          <button
            type="button"
            className="m-trace-pill"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
          >
            {showRunningTraceIndicator ? (
              <ActivityIndicator
                state="running"
                placement="inline"
                entityKind="session"
                variant="prolate-lattice"
                className="m-trace-pill__indicator"
              />
            ) : null}
            <span className="m-trace-pill__label">{traceSummary}</span>
            <ChevronRight size={14} className="m-trace-pill__chevron" aria-hidden="true" />
          </button>

          <div className="m-trace-drawer" data-open={expanded ? 'true' : 'false'}>
            <div className="m-trace-drawer__inner">
              {isMultiStep ? (
                partitionedSteps
                  .filter((entry) => entry.hasThought || entry.standardTools.length > 0)
                  .map((entry, idx) => (
                    <div key={entry.step.id || idx} className="m-trace-step">
                      {entry.hasThought ? (
                        <div className="m-trace-thought-box">
                          <MarkdownBlock
                            content={entry.step.thought || ''}
                            className="conv-row__thought"
                            knownFiles={knownFiles}
                          />
                        </div>
                      ) : null}
                      {entry.standardTools.length > 0 ? (
                        <div className="conv-tools">
                          {entry.standardTools.map((tool) => (
                            <ToolCapsule key={tool.id} tool={tool} now={now} actionEnabled={!readOnly} />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))
              ) : isStreaming ? (
                <>
                  <div className="m-trace-thought-box">
                    <MarkdownBlock
                      key="thought-streaming"
                      content={singleStepThought}
                      anchorId={`msg-thought-${messageId}`}
                      className="conv-row__thought"
                      knownFiles={knownFiles}
                    />
                  </div>
                  <div key="tools-streaming" className="conv-tools" id={`msg-tools-${messageId}`} />
                </>
              ) : (
                <>
                  {singleStepHasThought ? (
                    <div className="m-trace-thought-box">
                      <MarkdownBlock
                        key="thought-settled"
                        content={singleStepThought}
                        anchorId={`msg-thought-${messageId}`}
                        className="conv-row__thought"
                        knownFiles={knownFiles}
                      />
                    </div>
                  ) : null}
                  <div key="tools-settled" className="conv-tools" id={`msg-tools-${messageId}`}>
                    {standardTools.map((tool) => (
                      <ToolCapsule key={tool.id} tool={tool} now={now} actionEnabled={!readOnly} />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="m-hidden-anchor" aria-hidden="true">
          <div id={`msg-thought-${messageId}`} className="conv-row__thought" />
          <div id={`msg-tools-${messageId}`} className="conv-tools" />
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
