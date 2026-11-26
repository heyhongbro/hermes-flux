/**
 * 回合分组
 *
 * 设计意图(Why)：
 *   单聊中同角色连续消息共享头像与页脚；群聊中不同发送者即使都是 assistant 也必须断开回合。
 *   同时在同一回合内统一提取成果物：正文已原地呈现的文件引用替换为紧凑小卡片，
 *   未在正文出现过的隐式成果物（如静默 MEDIA:/工具图）仅渲染在末条助手消息时间页脚正上方。
 *
 * 防范的历史坑(Pitfall)：
 *   1. 历史实现只比较 role，导致群聊第二位 Agent 的头像被误判为同回合而隐藏；
 *   2. 此前将 TurnDeliverables 放在最后一条 MessageRow 之后，导致成果物被推到时间戳页脚下方；
 *   3. 正文已链接展示过的文件若底部再重复渲染一次，造成双份冗余卡片。
 *
 * 约束与规则(Rules)：
 *   memo 包裹，流式期间不因无关 props 重渲染；本组件只做结构编排，提取逻辑全部委托 Core 纯函数。
 */

import * as React from 'react';
import {
  extractTurnDeliverables,
  findInlineReferencedDeliverableKeys,
  normalizeDeliverableKey,
  type DeliverableItem,
  type DeliverableMessageInput,
} from '@hermes-flux/core';
import type { ConversationMessageVM, ConversationMode, ConversationToolVM } from './types.js';
import {
  consolidateMobileTurnTraces,
  type ConsolidatedMobileTurnRow,
} from './CompactTraceCapsule.js';
import { MessageRow } from './MessageRow.js';
import { TurnDeliverables } from './TurnDeliverables.js';
import type { MediaLightboxItem } from './MediaLightbox.js';

const EMPTY_DELIVERABLES: DeliverableItem[] = [];
const EMPTY_STRINGS: string[] = [];
const EMPTY_IMAGES: MediaLightboxItem[] = [];

export interface TurnGroupProps {
  messages: ConversationMessageVM[];
  mode: ConversationMode;
  /** 语言标识：memo 后也必须让已挂载消息随语言切换重新渲染。 */
  locale?: string;
  isLastTurn: boolean;
  isStreaming: boolean;
  /** 会话内 Agent 真实读写过的文件（决定正文里的文件引用是否可点击） */
  knownFiles?: readonly string[];
  /** 经父目录物理核验确认存在的文件路径集合 */
  verifiedDeliverablePaths?: readonly string[];
  /** 来自 SubagentStore 的显式写入路径集合 */
  subagentWrittenPaths?: readonly string[];
  readOnly?: boolean;
  onOpenSubagent?: (subagentId: string) => void;
  onCopyMessage?: (content: string) => void;
  compactTrace?: boolean;
  onOpenSubagentDetail?: (payload: { messageId: string; tools: ConversationToolVM[] }) => void;
  resolveMediaUrl?: (pathOrUrl: string) => Promise<string | null>;
  onOpenFile?: (filePath: string, previewUrl?: string) => void;
  onOpenMediaLightbox?: (items: readonly MediaLightboxItem[], initialIndex: number) => void;
}

const areEqual = (prev: TurnGroupProps, next: TurnGroupProps): boolean => {
  if (
    prev.mode !== next.mode ||
    prev.isLastTurn !== next.isLastTurn ||
    prev.isStreaming !== next.isStreaming ||
    prev.readOnly !== next.readOnly ||
    prev.onOpenSubagent !== next.onOpenSubagent ||
    prev.onCopyMessage !== next.onCopyMessage ||
    prev.compactTrace !== next.compactTrace ||
    prev.onOpenSubagentDetail !== next.onOpenSubagentDetail ||
    prev.resolveMediaUrl !== next.resolveMediaUrl ||
    prev.onOpenFile !== next.onOpenFile ||
    prev.onOpenMediaLightbox !== next.onOpenMediaLightbox
  ) {
    return false;
  }
  if (prev.locale !== next.locale) return false;
  // knownFiles / verifiedDeliverablePaths / subagentWrittenPaths 在列表层按引用缓存
  if (
    prev.knownFiles !== next.knownFiles ||
    prev.verifiedDeliverablePaths !== next.verifiedDeliverablePaths ||
    prev.subagentWrittenPaths !== next.subagentWrittenPaths
  ) {
    return false;
  }
  if (prev.messages.length !== next.messages.length) return false;
  for (let i = 0; i < prev.messages.length; i++) {
    const a = prev.messages[i];
    const b = next.messages[i];
    if (a === b) continue;
    if (a.id !== b.id || a.content !== b.content || a.thought !== b.thought || a.status !== b.status) return false;
    if (a.displayKind !== b.displayKind || a.displayMetadata !== b.displayMetadata || a.attachments !== b.attachments) return false;
    if (
      a.rowId !== b.rowId ||
      a.sender !== b.sender ||
      a.timestamp !== b.timestamp ||
      a.model !== b.model ||
      a.durationMs !== b.durationMs ||
      a.thoughtDurationMs !== b.thoughtDurationMs
    ) {
      return false;
    }
    if ((a.toolCalls?.length ?? 0) !== (b.toolCalls?.length ?? 0)) return false;
    if (a.toolCalls && b.toolCalls) {
      for (let j = 0; j < a.toolCalls.length; j++) {
        const ta = a.toolCalls[j];
        const tb = b.toolCalls[j];
        if (ta === tb) continue;
        if (
          ta.status !== tb.status ||
          ta.output !== tb.output ||
          ta.name !== tb.name ||
          ta.args !== tb.args ||
          ta.rawArgs !== tb.rawArgs ||
          ta.durationMs !== tb.durationMs ||
          ta.subagentId !== tb.subagentId ||
          ta.imagePath !== tb.imagePath ||
          ta.inlineDiff !== tb.inlineDiff ||
          ta.riskInfo !== tb.riskInfo
        ) {
          return false;
        }
      }
    }
  }
  return true;
};

/**
 * 回合内工具收敛
 * 【设计意图 (Why)】网关历史把每一轮「模型输出 + 工具调用」落成独立的 assistant 行，
 * 历史回放时每个工具各占一行、散落在正文之间；实时流式只有一个 message，天然收敛成
 * 一个执行清单。这里把同一回合的工具合并到首条消息，让历史与实时形态一致。
 * 【防范的历史坑 (Pitfall)】正在流式的回合不聚合：工具区仍靠 #msg-tools-<id> 增量直写，
 * 合并会让锚点与消息错位。
 * 【约束与规则 (Rules)】只做视图变换，不改入参；单工具或非 assistant 回合原样返回。
 */
function aggregateTurnTools(
  messages: ConversationMessageVM[],
  isStreaming: boolean
): ConversationMessageVM[] {
  if (isStreaming || messages.length <= 1 || messages[0]?.role !== 'assistant') return messages;
  const merged: ConversationToolVM[] = [];
  for (const message of messages) {
    if (message.toolCalls?.length) merged.push(...message.toolCalls);
  }
  if (merged.length <= 1) return messages;
  return messages.map((message, index) =>
    index === 0 ? { ...message, toolCalls: merged } : { ...message, toolCalls: [] }
  );
}

function toDeliverableInputs(messages: readonly ConversationMessageVM[]): DeliverableMessageInput[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      status: tc.status,
      args: tc.args,
      rawArgs: tc.rawArgs,
      output: tc.output,
      imagePath: tc.imagePath,
      inlineDiff: tc.inlineDiff,
    })),
    attachments: m.attachments?.map((att) => ({
      id: att.id,
      name: att.name,
      type: att.type,
      previewUrl: att.previewUrl,
    })),
  }));
}

export const TurnGroup = React.memo(function TurnGroup({
  messages,
  mode,
  locale,
  isLastTurn,
  isStreaming,
  knownFiles,
  verifiedDeliverablePaths,
  subagentWrittenPaths,
  readOnly,
  onOpenSubagent,
  onCopyMessage,
  compactTrace,
  onOpenSubagentDetail,
  resolveMediaUrl,
  onOpenFile,
  onOpenMediaLightbox,
}: TurnGroupProps): React.ReactElement {
  const renderedRows = React.useMemo<ConsolidatedMobileTurnRow[]>(() => {
    if (compactTrace) {
      return consolidateMobileTurnTraces(messages, isStreaming);
    }
    return aggregateTurnTools(messages, isStreaming).map((message) => ({ message }));
  }, [messages, isStreaming, compactTrace]);
  const lastIndex = renderedRows.length - 1;
  const isAssistantTurn = messages[0]?.role === 'assistant';

  const hasDelegationTool = React.useMemo(
    () =>
      messages.some((m) =>
        m.toolCalls?.some((tc) => Boolean(tc.subagentId || tc.delegationId || /delegate|subagent/i.test(tc.name || ''))),
      ),
    [messages],
  );

  const turnDeliverables = React.useMemo(() => {
    if (!isAssistantTurn || readOnly) return EMPTY_DELIVERABLES;
    const mayNeedDeliverableScan =
      Boolean(verifiedDeliverablePaths?.length) ||
      Boolean(subagentWrittenPaths?.length && hasDelegationTool) ||
      messages.some((m) =>
        Boolean(
          m.toolCalls?.length ||
            m.attachments?.length ||
            (m.content && (m.content.includes('MEDIA:') || m.content.includes(']('))),
        ),
      );
    if (!mayNeedDeliverableScan) return EMPTY_DELIVERABLES;
    const inputs = toDeliverableInputs(messages);
    return extractTurnDeliverables(inputs, {
      verifiedExistingPaths: verifiedDeliverablePaths,
      subagentWrittenPaths: hasDelegationTool ? subagentWrittenPaths : undefined,
    });
  }, [isAssistantTurn, readOnly, messages, verifiedDeliverablePaths, hasDelegationTool, subagentWrittenPaths]);

  const deliverableFiles = React.useMemo(
    () => (turnDeliverables.length === 0 ? EMPTY_STRINGS : turnDeliverables.map((d) => d.path)),
    [turnDeliverables],
  );

  const turnImages = React.useMemo<MediaLightboxItem[]>(
    () =>
      turnDeliverables.length === 0
        ? EMPTY_IMAGES
        : turnDeliverables
            .filter((d) => d.kind === 'image')
            .map((img) => ({
              id: img.id,
              src: img.previewUrl || img.path,
              path: img.path,
              name: img.name,
              alt: img.name,
            })),
    [turnDeliverables],
  );

  const unmentionedDeliverables = React.useMemo(() => {
    if (turnDeliverables.length === 0) return EMPTY_DELIVERABLES;
    const inlineKeys = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.content) {
        for (const k of findInlineReferencedDeliverableKeys(msg.content, turnDeliverables)) {
          inlineKeys.add(k);
        }
      }
    }
    return turnDeliverables.filter((d) => !inlineKeys.has(normalizeDeliverableKey(d.path)));
  }, [messages, turnDeliverables]);

  const implicitDeliverablesSlot =
    isAssistantTurn && !readOnly && unmentionedDeliverables.length > 0 ? (
      <TurnDeliverables
        messages={messages}
        deliverables={unmentionedDeliverables}
        allTurnImages={turnImages}
        isStreaming={isStreaming}
        resolveMediaUrl={resolveMediaUrl}
        onOpenFile={onOpenFile}
        onOpenMediaLightbox={onOpenMediaLightbox}
      />
    ) : null;

  return (
    <div
      className="conv-turn"
      data-conv-turn={messages[0]?.id ?? ''}
      data-conv-turn-last={isLastTurn ? 'true' : 'false'}
      data-conv-streaming={isStreaming ? 'true' : 'false'}
    >
      {renderedRows.map((row, index) => (
        <MessageRow
          key={row.message.id}
          message={row.message}
          isFirstInTurn={index === 0}
          isLastInTurn={index === lastIndex}
          mode={mode}
          locale={locale}
          isStreaming={isStreaming && index === lastIndex}
          knownFiles={knownFiles}
          deliverableFiles={deliverableFiles}
          turnImages={turnImages}
          beforeFooterSlot={index === lastIndex ? implicitDeliverablesSlot : undefined}
          readOnly={readOnly}
          onOpenSubagent={onOpenSubagent}
          onCopyMessage={onCopyMessage}
          compactTrace={compactTrace}
          traceSteps={row.traceSteps}
          onOpenSubagentDetail={onOpenSubagentDetail}
          resolveMediaUrl={resolveMediaUrl}
          onOpenFile={onOpenFile}
          onOpenMediaLightbox={onOpenMediaLightbox}
        />
      ))}
    </div>
  );
}, areEqual);

export function groupTurns(messages: ConversationMessageVM[]): ConversationMessageVM[][] {
  const turns: ConversationMessageVM[][] = [];
  for (const message of messages) {
    const current = turns[turns.length - 1];
    const previous = current?.[current.length - 1];
    const differentSender = Boolean(previous?.sender && message.sender && previous.sender !== message.sender);
    if (!previous || previous.role !== message.role || differentSender) {
      turns.push([message]);
    } else {
      current.push(message);
    }
  }
  return turns;
}
