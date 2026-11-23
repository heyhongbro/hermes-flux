/**
 * 学习星图领域模型与拓扑布局计算 (packages/core/src/learning/learningConstellation.ts)
 *
 * 【设计意图 (Why)】
 *   将网关 `learning.frames` / `learning.detail` 返回的离散时间桶记忆（`memory:*`）与提炼技能（`skill`）
 *   归一为结构化的「记忆与学习星图 (Constellation)」，并给出中心聚焦 + 环绕辐射的确定性视窗布局：
 *   1. 剥离网关记忆条目头部的 `<!-- observed: ... -->` 元数据注释，呈现干净可读的中文/英文节点标签；
 *   2. 自动构建三层关联边：记忆正文提及技能名（`mention`）、同一天习得（`same-bucket`）、同域类别（`same-category`）；
 *   3. 居中放置当前激活节点，外环均匀排布最多 `maxRingNodes`（默认 6）颗关联节点并支持翻页浏览全部星图，
 *      在手机小屏下既还原 Hermes 官方 App「Your Constellation」视觉，又避免数十个节点重叠堆砌。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 网关 `node.label` 对带有 `<!-- observed: ... -->` 的记忆会在 24 字符处硬截断（出现 `<!-- observed: 2026-10-…`），
 *      必须先清洗 `fullLabel` / `body` 再生成摘要标题，绝不能把半截 HTML 注释展示给用户；
 *   2. 单个高产日期桶（如 27 Oct 有 18 个节点）若做全连接会产生 $O(n^2)$ 蛛网乱线，必须限制单节点连接数上限；
 *   3. 所有过滤/选点/几何排布必须在纯函数中完成，严禁依赖 DOM 测量，保证 100% 单元测试可测性与确定性。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM / React 依赖，不修改输入 `LearningFramesResult`；
 *   - `x` / `y` 坐标统一输出百分比数值（0~100），由表现层直接定位渲染。
 */

import type { LearningFramesResult } from '../rpc/contracts/gateway-contract.generated.js';

export type LearningNodeKind = 'memory' | 'skill';
export type ConstellationEdgeKind = 'mention' | 'same-bucket' | 'same-category';
export type LearningFilterKind = 'all' | LearningNodeKind;

export interface ConstellationNode {
  id: string;
  kind: LearningNodeKind;
  label: string;
  fullLabel: string;
  preview: string;
  category: string;
  date: string;
  uses: number;
  meta: string;
  bucketIndex: number;
}

export interface ConstellationEdge {
  source: string;
  target: string;
  kind: ConstellationEdgeKind;
}

export interface ConstellationGraph {
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
  summary: string[];
  totalSkills: number;
  totalMemories: number;
  axisStart: string;
  axisEnd: string;
}

export type LearningLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; graph: ConstellationGraph }
  | { status: 'error'; message: string };

export type LearningDetailState =
  | { status: 'idle' }
  | { status: 'loading'; id: string }
  | {
      status: 'ready';
      id: string;
      kind: LearningNodeKind;
      label: string;
      content: string;
    }
  | { status: 'error'; id: string; message: string };

export interface PositionedConstellationNode extends ConstellationNode {
  x: number;
  y: number;
  isCenter: boolean;
}

export interface ConstellationWindowLayout {
  activeNode: ConstellationNode | null;
  positionedNodes: PositionedConstellationNode[];
  visibleEdges: ConstellationEdge[];
  filteredNodes: ConstellationNode[];
  totalPages: number;
  currentPage: number;
}

const MAX_DISPLAY_LABEL_LEN = 26;
const MAX_EDGES_PER_NODE = 4;

/**
 * 清除网关记忆文本开头的 HTML 观测注释（`<!-- observed: ... -->`）并收敛空白符。
 */
export function cleanLearningLabel(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!--[\s\S]*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从网关节点 `meta` 字段中提取技能/记忆复用次数（例如 `"wechat · 20 Oct 2026 · x29"` -> `29`）。
 */
export function parseLearningUses(meta?: string | null): number {
  if (!meta) return 0;
  const match = /(?:^|[\s·])x(\d+)\b/i.exec(meta);
  if (!match) return 0;
  const count = Number(match[1]);
  return Number.isFinite(count) ? count : 0;
}

function clipLabel(text: string): string {
  if (text.length <= MAX_DISPLAY_LABEL_LEN) return text;
  return `${text.slice(0, MAX_DISPLAY_LABEL_LEN - 1)}…`;
}

function extractCategory(bucketCategory: string | null | undefined, meta: string, kind: LearningNodeKind): string {
  const fromBucket = (bucketCategory || '').trim();
  if (fromBucket) return fromBucket;
  const head = meta.split('·')[0].trim();
  return head || kind;
}

/**
 * 将网关 `learning.frames` 原始响应构建为去重、清洗且带语义关联边的星图结构。
 */
export function buildConstellationGraph(result: LearningFramesResult): ConstellationGraph {
  const nodes: ConstellationNode[] = [];
  const seenIds = new Set<string>();
  const bucketNodeIds: string[][] = [];

  for (const bucket of result.buckets || []) {
    const groupIds: string[] = [];
    for (const rawNode of bucket.nodes || []) {
      const id = (rawNode.id || '').trim();
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      const kind: LearningNodeKind =
        rawNode.style === 'skill' || !id.startsWith('memory:') ? 'skill' : 'memory';
      const meta = (rawNode.meta || '').trim();
      const cleanedFull = cleanLearningLabel(rawNode.body || rawNode.fullLabel || rawNode.label || '');
      const rawShortClean = rawNode.label?.startsWith('<!--')
        ? ''
        : cleanLearningLabel(rawNode.label || '');
      const label = clipLabel(rawShortClean || cleanedFull || id);
      const preview = cleanedFull || label;

      const node: ConstellationNode = {
        id,
        kind,
        label,
        fullLabel: cleanedFull || label,
        preview,
        category: extractCategory(bucket.category, meta, kind),
        date: (bucket.date || bucket.label || '').trim(),
        uses: parseLearningUses(meta),
        meta,
        bucketIndex: bucket.index,
      };
      nodes.push(node);
      groupIds.push(id);
    }
    if (groupIds.length > 0) {
      bucketNodeIds.push(groupIds);
    }
  }

  const edges: ConstellationEdge[] = [];
  const edgeKeys = new Set<string>();
  const degree = new Map<string, number>();

  const tryAddEdge = (source: string, target: string, kind: ConstellationEdgeKind, respectCap: boolean): void => {
    const pairKey = source < target ? `${source}::${target}` : `${target}::${source}`;
    if (edgeKeys.has(pairKey)) return;
    const degA = degree.get(source) ?? 0;
    const degB = degree.get(target) ?? 0;
    if (respectCap && (degA >= MAX_EDGES_PER_NODE || degB >= MAX_EDGES_PER_NODE)) {
      return;
    }
    edgeKeys.add(pairKey);
    degree.set(source, degA + 1);
    degree.set(target, degB + 1);
    edges.push({ source, target, kind });
  };

  const skills = nodes.filter((n) => n.kind === 'skill');
  const memories = nodes.filter((n) => n.kind === 'memory');

  // 1. 强关联：记忆文本显式提及某项习得技能名
  for (const mem of memories) {
    const haystack = mem.fullLabel.toLowerCase();
    for (const sk of skills) {
      const skId = sk.id.toLowerCase();
      const skLabel = sk.label.toLowerCase();
      if (haystack.includes(skId) || (skLabel.length >= 4 && haystack.includes(skLabel))) {
        tryAddEdge(mem.id, sk.id, 'mention', true);
      }
    }
  }

  // 2. 时序关联：同日共学环形链路
  for (const group of bucketNodeIds) {
    for (let i = 0; i < group.length - 1; i++) {
      tryAddEdge(group[i], group[i + 1], 'same-bucket', true);
    }
  }

  // 3. 领域关联：度数稀疏的节点补连同类别最近邻居，避免孤岛
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if ((degree.get(a.id) ?? 0) >= 2) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      if (a.category === b.category) {
        tryAddEdge(a.id, b.id, 'same-category', true);
        if ((degree.get(a.id) ?? 0) >= 2) break;
      }
    }
  }

  return {
    nodes,
    edges,
    summary: Array.isArray(result.summary) ? [...result.summary] : [],
    totalSkills: skills.length,
    totalMemories: memories.length,
    axisStart: result.axis?.start || '',
    axisEnd: result.axis?.end || '',
  };
}

/**
 * 为移动端窄屏渲染计算居中焦距与环绕星图视窗布局（每页展示中心节点 + 最多 6 颗邻近节点）。
 */
export function layoutConstellationWindow(
  graph: ConstellationGraph,
  options: {
    selectedId?: string;
    filter?: LearningFilterKind;
    page?: number;
    maxRingNodes?: number;
  } = {},
): ConstellationWindowLayout {
  const filter = options.filter ?? 'all';
  const filteredNodes =
    filter === 'all' ? graph.nodes : graph.nodes.filter((n) => n.kind === filter);

  if (filteredNodes.length === 0) {
    return {
      activeNode: null,
      positionedNodes: [],
      visibleEdges: [],
      filteredNodes: [],
      totalPages: 0,
      currentPage: 0,
    };
  }

  const matched = options.selectedId
    ? filteredNodes.find((n) => n.id === options.selectedId)
    : undefined;
  const activeNode = matched ?? filteredNodes[0];

  const neighborIds = new Set<string>();
  for (const e of graph.edges) {
    if (e.source === activeNode.id) neighborIds.add(e.target);
    else if (e.target === activeNode.id) neighborIds.add(e.source);
  }

  const others = filteredNodes.filter((n) => n.id !== activeNode.id);
  const prioritizedOthers = [
    ...others.filter((n) => neighborIds.has(n.id)),
    ...others.filter((n) => !neighborIds.has(n.id)),
  ];

  const maxRingNodes = Math.max(1, options.maxRingNodes ?? 6);
  const totalPages = Math.max(1, Math.ceil(prioritizedOthers.length / maxRingNodes));
  const currentPage = Math.max(0, Math.min(options.page ?? 0, totalPages - 1));
  const ringNodes = prioritizedOthers.slice(
    currentPage * maxRingNodes,
    (currentPage + 1) * maxRingNodes,
  );

  const positionedNodes: PositionedConstellationNode[] = [
    { ...activeNode, x: 50, y: 48, isCenter: true },
  ];

  const ringCount = ringNodes.length;
  for (let i = 0; i < ringCount; i++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / ringCount;
    const x = Number((50 + 34 * Math.cos(angle)).toFixed(2));
    const y = Number((48 + 30 * Math.sin(angle)).toFixed(2));
    positionedNodes.push({ ...ringNodes[i], x, y, isCenter: false });
  }

  const visibleIds = new Set(positionedNodes.map((n) => n.id));
  const visibleEdges = graph.edges.filter(
    (e) => visibleIds.has(e.source) && visibleIds.has(e.target),
  );

  return {
    activeNode,
    positionedNodes,
    visibleEdges,
    filteredNodes,
    totalPages,
    currentPage,
  };
}
