/**
 * 学习星图领域模型、多 Bot 图谱归一与拓扑构建 (packages/core/src/learning/learningConstellation.ts)
 *
 * 【设计意图 (Why)】
 *   将网关 `/api/learning/graph?profile=...`（REST）或 `learning.frames` / `profiles.describe` 返回的
 *   学习记忆与提炼技能统一归一为严格按 `profile` 隔离的「认知星图 (ConstellationGraph)」：
 *   1. 剥离网关记忆条目头部的 `<!-- observed: ... -->` 元数据注释，呈现干净可读的节点标签与详情正文；
 *   2. 显式保留与推导演化四层关联边：技能↔技能协同（`skill-link`）、记忆提及技能（`mention`）、
 *      同日共学（`same-bucket`）与同域分类（`same-category`）；
 *   3. 导出全量非分页确定性布局（`layoutFullConstellationGraph`）与技能清单派生（`extractConstellationSkillList`），
 *      同时保留历史窄窗分页布局 `layoutConstellationWindow` 以向后兼容既有不变量。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 网关 WS `learning.frames` 不接受 `profile` 参数，若不区分数据源并显式标注 `graph.profile`，
 *      切换不同 Bot 时会被 `default` Bot 的图谱静默串台覆盖；
 *   2. 网关 `node.label` 对带有 `<!-- observed: ... -->` 的记忆会在 24 字符处硬截断，
 *      必须先清洗 `fullLabel` / `body` 再生成摘要标题；
 *   3. 高产桶全连接会形成 $O(n^2)$ 蛛网乱线，必须遵守单节点连接度数上限（WS 推导 4，REST 显式边 12）。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM / React 依赖，不修改输入响应对象；
 *   - 显式携带 `profile` 身份字段供服务层与 UI 层执行零串台围栏校验。
 */

import type {
  LearningBucketRow,
  LearningFramesResult,
  LearningNodeRow,
} from '../rpc/contracts/gateway-contract.generated.js';

export type LearningNodeKind = 'memory' | 'skill';
export type ConstellationEdgeKind = 'skill-link' | 'mention' | 'same-bucket' | 'same-category';
export type LearningFilterKind = 'all' | LearningNodeKind;
export type ConstellationGraphSource = 'rest-graph' | 'ws-frames' | 'profile-skills';

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
  skillName?: string;
  description?: string;
  tags?: string[];
}

export interface ConstellationEdge {
  source: string;
  target: string;
  kind: ConstellationEdgeKind;
  weight?: number;
}

export interface ConstellationGraph {
  profile?: string;
  source?: ConstellationGraphSource;
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
  summary: string[];
  totalSkills: number;
  totalMemories: number;
  totalSkillLinks?: number;
  axisStart: string;
  axisEnd: string;
}

export type LearningLoadState =
  | { status: 'idle' }
  | { status: 'loading'; profile?: string }
  | { status: 'ready'; profile?: string; graph: ConstellationGraph }
  | { status: 'error'; profile?: string; message: string };

export type LearningDetailState =
  | { status: 'idle' }
  | { status: 'loading'; id: string; profile?: string }
  | {
      status: 'ready';
      id: string;
      kind: LearningNodeKind;
      label: string;
      content: string;
      profile?: string;
    }
  | { status: 'error'; id: string; message: string; profile?: string };

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

export interface ProfileSkillSeed {
  id: string;
  label?: string;
  description?: string;
  category?: string;
  uses?: number;
}

const MAX_DISPLAY_LABEL_LEN = 26;
const MAX_EDGES_PER_NODE = 4;
const MAX_REST_EDGES_PER_NODE = 12;

/** 归一化认知星图归属 Profile 标识（空值一律收敛为 `default`）。 */
export function normalizeLearningProfile(profile?: string | null): string {
  const trimmed = typeof profile === 'string' ? profile.trim() : '';
  return trimmed || 'default';
}

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

function deriveSkillName(id: string, explicit?: string): string {
  const clean = (explicit || '').trim();
  if (clean) return clean;
  return id.replace(/^skill:/i, '').trim() || id;
}

function addSkillCrossLinks(
  skills: readonly ConstellationNode[],
  tryAddEdge: (source: string, target: string, kind: ConstellationEdgeKind, cap: number) => void,
  degree: ReadonlyMap<string, number>,
  edgeCap: number,
): void {
  // 1. 技能说明书/摘要互引（skill-link）
  for (let i = 0; i < skills.length; i++) {
    const a = skills[i];
    const haystack = `${a.fullLabel} ${a.description || ''}`.toLowerCase();
    for (let j = 0; j < skills.length; j++) {
      if (i === j) continue;
      const b = skills[j];
      const bId = b.id.toLowerCase();
      const bSkillName = (b.skillName || '').toLowerCase();
      const bLabel = b.label.toLowerCase();
      if (
        (bSkillName.length >= 3 && haystack.includes(bSkillName)) ||
        (bId.length >= 3 && haystack.includes(bId)) ||
        (bLabel.length >= 4 && haystack.includes(bLabel))
      ) {
        tryAddEdge(a.id, b.id, 'skill-link', edgeCap);
      }
    }
  }

  // 2. 同非泛化领域的技能按最高调用中心节点相连（skill-link）
  const byCategory = new Map<string, ConstellationNode[]>();
  for (const sk of skills) {
    const cat = sk.category.trim().toLowerCase();
    if (!cat || cat === 'skill' || cat === 'memory' || cat === 'general' || cat === 'other') continue;
    const bucket = byCategory.get(cat);
    if (bucket) bucket.push(sk);
    else byCategory.set(cat, [sk]);
  }
  const hubs: ConstellationNode[] = [];
  for (const group of byCategory.values()) {
    if (group.length === 0) continue;
    group.sort((a, b) => b.uses - a.uses || a.id.localeCompare(b.id));
    const hub = group[0];
    hubs.push(hub);
    for (let k = 1; k < group.length; k++) {
      if ((degree.get(group[k].id) ?? 0) < edgeCap) {
        tryAddEdge(hub.id, group[k].id, 'skill-link', edgeCap);
      }
    }
  }
  for (let k = 0; k < hubs.length - 1; k++) {
    if ((degree.get(hubs[k].id) ?? 0) < 1 || (degree.get(hubs[k + 1].id) ?? 0) < 1) {
      tryAddEdge(hubs[k].id, hubs[k + 1].id, 'skill-link', edgeCap);
    }
  }
}

/**
 * 将网关 `learning.frames` 原始响应构建为去重、清洗且带语义关联边的星图结构。
 */
export function buildConstellationGraph(result: LearningFramesResult, profile?: string): ConstellationGraph {
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
        rawNode.style === 'memory'
          ? 'memory'
          : rawNode.style === 'skill' || rawNode.style === 'learned-skill' || !id.startsWith('memory:')
            ? 'skill'
            : 'memory';
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
        ...(kind === 'skill' ? { skillName: deriveSkillName(id, rawShortClean) } : {}),
        ...(preview && preview !== label ? { description: preview } : {}),
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

  const tryAddEdge = (source: string, target: string, kind: ConstellationEdgeKind, edgeCap: number): void => {
    if (source === target) return;
    const pairKey = source < target ? `${source}::${target}` : `${target}::${source}`;
    if (edgeKeys.has(pairKey)) return;
    const degA = degree.get(source) ?? 0;
    const degB = degree.get(target) ?? 0;
    if (degA >= edgeCap || degB >= edgeCap) return;
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
      const skName = (sk.skillName || '').toLowerCase();
      const skLabel = sk.label.toLowerCase();
      if (
        haystack.includes(skId) ||
        (skName.length >= 4 && haystack.includes(skName)) ||
        (skLabel.length >= 4 && haystack.includes(skLabel))
      ) {
        tryAddEdge(mem.id, sk.id, 'mention', MAX_EDGES_PER_NODE);
      }
    }
  }

  // 1b. 技能间语义互引与同域耦合（skill-link）
  addSkillCrossLinks(skills, tryAddEdge, degree, MAX_EDGES_PER_NODE);

  // 2. 时序关联：同日共学环形链路
  for (const group of bucketNodeIds) {
    for (let i = 0; i < group.length - 1; i++) {
      tryAddEdge(group[i], group[i + 1], 'same-bucket', MAX_EDGES_PER_NODE);
    }
  }

  // 3. 领域关联：度数稀疏的节点补连同类别最近邻居，避免孤岛
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if ((degree.get(a.id) ?? 0) >= 2) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      if (a.category === b.category) {
        const edgeKind: ConstellationEdgeKind =
          a.kind === 'skill' && b.kind === 'skill' ? 'skill-link' : 'same-category';
        tryAddEdge(a.id, b.id, edgeKind, MAX_EDGES_PER_NODE);
        if ((degree.get(a.id) ?? 0) >= 2) break;
      }
    }
  }

  const totalSkillLinks = edges.filter((e) => e.kind === 'skill-link').length;

  return {
    ...(profile ? { profile: normalizeLearningProfile(profile) } : {}),
    source: 'ws-frames',
    nodes,
    edges,
    summary: Array.isArray(result.summary) ? [...result.summary] : [],
    totalSkills: skills.length,
    totalMemories: memories.length,
    totalSkillLinks,
    axisStart: result.axis?.start || '',
    axisEnd: result.axis?.end || '',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNonNegInt(...candidates: unknown[]): number {
  for (const val of candidates) {
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val > 0 ? Math.floor(val) : 0;
    }
    if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
      const parsed = Number(val.trim());
      if (Number.isFinite(parsed)) return parsed > 0 ? Math.floor(parsed) : 0;
    }
  }
  return 0;
}

function classifyRestEdgeKind(
  rawKind: string,
  srcNode: ConstellationNode,
  dstNode: ConstellationNode,
): ConstellationEdgeKind {
  const lower = rawKind.toLowerCase();
  if (srcNode.kind === 'skill' && dstNode.kind === 'skill') {
    return 'skill-link';
  }
  if (lower.includes('skill') && (lower.includes('link') || lower.includes('relat') || lower.includes('depend'))) {
    return srcNode.kind === 'skill' && dstNode.kind === 'skill' ? 'skill-link' : 'mention';
  }
  if (lower.includes('mention') || lower.includes('use') || lower.includes('ref')) {
    return 'mention';
  }
  if (lower.includes('bucket') || lower.includes('day') || lower.includes('time')) {
    return 'same-bucket';
  }
  if (srcNode.kind !== dstNode.kind) {
    return 'mention';
  }
  return 'same-category';
}

function parseBucketsPayloadAsFrames(inner: Record<string, unknown>): LearningFramesResult {
  const rawBuckets = Array.isArray(inner.buckets) ? inner.buckets : [];
  const buckets: LearningBucketRow[] = [];
  rawBuckets.forEach((rawBucket, bIdx) => {
    const b = asRecord(rawBucket);
    if (!b) return;
    const rawNodes = Array.isArray(b.nodes) ? b.nodes : [];
    const nodes: LearningNodeRow[] = [];
    for (const rawNode of rawNodes) {
      const n = asRecord(rawNode);
      if (!n) continue;
      nodes.push({
        id: asString(n.id),
        glyph: asString(n.glyph),
        label: asString(n.label),
        fullLabel: asString(n.fullLabel) || asString(n.full_label),
        meta: asString(n.meta),
        body: asString(n.body) || asString(n.content),
        style: asString(n.style) || asString(n.kind) || asString(n.type),
      });
    }
    buckets.push({
      index: readNonNegInt(b.index) || bIdx,
      label: asString(b.label),
      date: asString(b.date),
      skills: readNonNegInt(b.skills),
      memories: readNonNegInt(b.memories),
      total: readNonNegInt(b.total) || nodes.length,
      category: asString(b.category) || null,
      color: asString(b.color) || null,
      nodes,
    });
  });

  const axisRec = asRecord(inner.axis);
  const summary = Array.isArray(inner.summary)
    ? inner.summary.map((item) => asString(item)).filter(Boolean)
    : [];

  return {
    frames: [],
    legend: [],
    categories: [],
    buckets,
    summary,
    axis: {
      start: asString(axisRec?.start),
      end: asString(axisRec?.end),
    },
    count: readNonNegInt(inner.count),
    cols: readNonNegInt(inner.cols),
    rows: readNonNegInt(inner.rows),
  };
}

/**
 * 将网关 REST `GET /api/learning/graph?profile=...` 原始载荷归一为指定 Bot 隔离的星图结构。
 * 支持直接传入 `{ nodes, edges }`、`{ graph: { nodes, edges } }` 或兼容 `{ buckets }`。
 */
export function buildConstellationGraphFromRest(payload: unknown, profile?: string): ConstellationGraph {
  const normalizedProfile = normalizeLearningProfile(profile);
  const root = asRecord(payload);
  if (!root) {
    return {
      profile: normalizedProfile,
      source: 'rest-graph',
      nodes: [],
      edges: [],
      summary: [],
      totalSkills: 0,
      totalMemories: 0,
      totalSkillLinks: 0,
      axisStart: '',
      axisEnd: '',
    };
  }

  const inner = asRecord(root.graph) ?? asRecord(root.data) ?? root;
  const resolvedProfile = normalizeLearningProfile(
    asString(inner.profile) || asString(root.profile) || normalizedProfile,
  );

  if (Array.isArray(inner.buckets) && !Array.isArray(inner.nodes)) {
    const framesGraph = buildConstellationGraph(parseBucketsPayloadAsFrames(inner), resolvedProfile);
    return { ...framesGraph, profile: resolvedProfile, source: 'rest-graph' };
  }

  const rawNodes = Array.isArray(inner.nodes) ? inner.nodes : [];
  const rawEdges = Array.isArray(inner.edges)
    ? inner.edges
    : Array.isArray(inner.links)
      ? inner.links
      : [];

  const nodes: ConstellationNode[] = [];
  const nodeMap = new Map<string, ConstellationNode>();
  const relatedSkillDecl = new Map<string, string[]>();

  rawNodes.forEach((rawItem, idx) => {
    const rec = asRecord(rawItem);
    if (!rec) return;
    const id = asString(rec.id) || asString(rec.name) || asString(rec.slug);
    if (!id || nodeMap.has(id)) return;

    const rawKind = (asString(rec.kind) || asString(rec.type) || asString(rec.style)).toLowerCase();
    const kind: LearningNodeKind =
      rawKind === 'skill' || rawKind === 'learned-skill' || (!rawKind.includes('mem') && !id.startsWith('memory:'))
        ? 'skill'
        : 'memory';

    const meta = asString(rec.meta);
    const bodyText =
      asString(rec.fullLabel) ||
      asString(rec.full_label) ||
      asString(rec.description) ||
      asString(rec.summary) ||
      asString(rec.body) ||
      asString(rec.content);
    const rawLabelText = asString(rec.label) || asString(rec.title) || asString(rec.name);
    const cleanedFull = cleanLearningLabel(bodyText || rawLabelText);
    const shortClean = rawLabelText.startsWith('<!--') ? '' : cleanLearningLabel(rawLabelText);
    const label = clipLabel(shortClean || cleanedFull || id);
    const preview = cleanedFull || label;

    const category =
      asString(rec.category) ||
      asString(rec.domain) ||
      asString(rec.group) ||
      extractCategory(undefined, meta, kind);
    const date =
      asString(rec.date) ||
      asString(rec.updated_at) ||
      asString(rec.created_at) ||
      asString(rec.observed);
    const uses = readNonNegInt(
      rec.uses,
      rec.use_count,
      rec.useCount,
      rec.call_count,
      rec.callCount,
      rec.invocations,
      rec.count,
      rec.val,
    ) || parseLearningUses(meta);

    const tags = Array.isArray(rec.tags)
      ? rec.tags.map((item) => asString(item)).filter(Boolean)
      : undefined;

    const explicitSkillName = asString(rec.skill_name) || asString(rec.skillName) || asString(rec.name);
    const node: ConstellationNode = {
      id,
      kind,
      label,
      fullLabel: cleanedFull || label,
      preview,
      category,
      date,
      uses,
      meta: meta || (uses > 0 ? `${category} · x${uses}` : category),
      bucketIndex: typeof rec.bucket_index === 'number' ? rec.bucket_index : idx,
      ...(kind === 'skill' ? { skillName: deriveSkillName(id, explicitSkillName) } : {}),
      ...(asString(rec.description) ? { description: cleanLearningLabel(asString(rec.description)) } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
    };

    nodes.push(node);
    nodeMap.set(id, node);

    if (Array.isArray(rec.related_skills)) {
      const refs = rec.related_skills.map((item) => asString(item)).filter(Boolean);
      if (refs.length > 0) relatedSkillDecl.set(id, refs);
    }
  });

  const skillLookup = new Map<string, string>();
  for (const n of nodes) {
    if (n.kind !== 'skill') continue;
    skillLookup.set(n.id.toLowerCase(), n.id);
    if (n.skillName) skillLookup.set(n.skillName.toLowerCase(), n.id);
    skillLookup.set(n.label.toLowerCase(), n.id);
  }

  const edges: ConstellationEdge[] = [];
  const edgeKeys = new Set<string>();
  const degree = new Map<string, number>();

  const tryAddEdge = (
    source: string,
    target: string,
    kind: ConstellationEdgeKind,
    edgeCap: number,
    weight?: number,
  ): void => {
    if (!source || !target || source === target) return;
    if (!nodeMap.has(source) || !nodeMap.has(target)) return;
    const pairKey = source < target ? `${source}::${target}` : `${target}::${source}`;
    if (edgeKeys.has(pairKey)) return;
    const degA = degree.get(source) ?? 0;
    const degB = degree.get(target) ?? 0;
    if (degA >= edgeCap || degB >= edgeCap) return;
    edgeKeys.add(pairKey);
    degree.set(source, degA + 1);
    degree.set(target, degB + 1);
    edges.push(weight !== undefined ? { source, target, kind, weight } : { source, target, kind });
  };

  // 1. 优先写入网关返回的结构化显式连线
  for (const rawEdge of rawEdges) {
    const rec = asRecord(rawEdge);
    if (!rec) continue;
    const sourceRaw = asString(rec.source) || asString(rec.from);
    const targetRaw = asString(rec.target) || asString(rec.to);
    const srcNode = nodeMap.get(sourceRaw) ?? (sourceRaw ? nodeMap.get(skillLookup.get(sourceRaw.toLowerCase()) || '') : undefined);
    const dstNode = nodeMap.get(targetRaw) ?? (targetRaw ? nodeMap.get(skillLookup.get(targetRaw.toLowerCase()) || '') : undefined);
    if (!srcNode || !dstNode) continue;
    const rawKind = asString(rec.kind) || asString(rec.type) || asString(rec.relation);
    const weight =
      typeof rec.weight === 'number' && Number.isFinite(rec.weight)
        ? rec.weight
        : typeof rec.score === 'number' && Number.isFinite(rec.score)
          ? rec.score
          : undefined;
    tryAddEdge(
      srcNode.id,
      dstNode.id,
      classifyRestEdgeKind(rawKind, srcNode, dstNode),
      MAX_REST_EDGES_PER_NODE,
      weight,
    );
  }

  // 2. frontmatter related_skills 声明边
  for (const [ownerId, refs] of relatedSkillDecl.entries()) {
    for (const ref of refs) {
      const targetId = skillLookup.get(ref.toLowerCase());
      if (targetId) {
        tryAddEdge(ownerId, targetId, 'skill-link', MAX_REST_EDGES_PER_NODE);
      }
    }
  }

  // 3. 补齐语义提及与同域技能关联（仅在节点关联稀疏或尚无技能互连时补充）
  const skills = nodes.filter((n) => n.kind === 'skill');
  const memories = nodes.filter((n) => n.kind === 'memory');
  for (const mem of memories) {
    const haystack = mem.fullLabel.toLowerCase();
    for (const sk of skills) {
      const skId = sk.id.toLowerCase();
      const skName = (sk.skillName || '').toLowerCase();
      const skLabel = sk.label.toLowerCase();
      if (
        haystack.includes(skId) ||
        (skName.length >= 4 && haystack.includes(skName)) ||
        (skLabel.length >= 4 && haystack.includes(skLabel))
      ) {
        tryAddEdge(mem.id, sk.id, 'mention', MAX_REST_EDGES_PER_NODE);
      }
    }
  }
  addSkillCrossLinks(skills, tryAddEdge, degree, MAX_REST_EDGES_PER_NODE);

  const summary = Array.isArray(inner.summary)
    ? inner.summary.map((s) => asString(s)).filter(Boolean)
    : [];
  const axis = asRecord(inner.axis);
  const totalSkillLinks = edges.filter((e) => e.kind === 'skill-link').length;

  return {
    profile: resolvedProfile,
    source: 'rest-graph',
    nodes,
    edges,
    summary,
    totalSkills: skills.length,
    totalMemories: memories.length,
    totalSkillLinks,
    axisStart: asString(axis?.start) || asString(inner.axisStart),
    axisEnd: asString(axis?.end) || asString(inner.axisEnd),
  };
}

/**
 * 在旧版网关 `/api/learning/graph` 对非默认 Bot 返回 404 时，
 * 基于该 Bot 独立 `profiles.describe({ profile })` 技能列表构造严格隔离的技能星图（绝不混入 default Bot 记忆）。
 */
export function buildConstellationGraphFromSkills(
  skillsInput: readonly ProfileSkillSeed[],
  profile: string,
): ConstellationGraph {
  const normalizedProfile = normalizeLearningProfile(profile);
  const nodes: ConstellationNode[] = [];
  const seen = new Set<string>();

  skillsInput.forEach((item, idx) => {
    const skillName = (item.id || '').trim();
    if (!skillName) return;
    const nodeId = skillName.startsWith('skill:') ? skillName : `skill:${skillName}`;
    if (seen.has(nodeId)) return;
    seen.add(nodeId);

    const rawLabel = cleanLearningLabel(item.label || skillName);
    const label = clipLabel(rawLabel || skillName);
    const desc = cleanLearningLabel(item.description || '');
    const category = (item.category || '').trim() || 'skill';
    const uses =
      typeof item.uses === 'number' && Number.isFinite(item.uses) && item.uses > 0
        ? Math.floor(item.uses)
        : 0;

    nodes.push({
      id: nodeId,
      kind: 'skill',
      label,
      fullLabel: desc || rawLabel || skillName,
      preview: desc || rawLabel || skillName,
      category,
      date: '',
      uses,
      meta: uses > 0 ? `${category} · x${uses}` : category,
      bucketIndex: idx,
      skillName: skillName.replace(/^skill:/i, ''),
      ...(desc ? { description: desc } : {}),
    });
  });

  const edges: ConstellationEdge[] = [];
  const edgeKeys = new Set<string>();
  const degree = new Map<string, number>();
  const tryAddEdge = (source: string, target: string, kind: ConstellationEdgeKind, cap: number): void => {
    if (source === target) return;
    const key = source < target ? `${source}::${target}` : `${target}::${source}`;
    if (edgeKeys.has(key)) return;
    const degA = degree.get(source) ?? 0;
    const degB = degree.get(target) ?? 0;
    if (degA >= cap || degB >= cap) return;
    edgeKeys.add(key);
    degree.set(source, degA + 1);
    degree.set(target, degB + 1);
    edges.push({ source, target, kind });
  };

  addSkillCrossLinks(nodes, tryAddEdge, degree, MAX_EDGES_PER_NODE);

  return {
    profile: normalizedProfile,
    source: 'profile-skills',
    nodes,
    edges,
    summary: [],
    totalSkills: nodes.length,
    totalMemories: 0,
    totalSkillLinks: edges.filter((e) => e.kind === 'skill-link').length,
    axisStart: '',
    axisEnd: '',
  };
}

/**
 * 为移动端窄屏渲染计算居中焦距与环绕星图视窗布局（每页展示中心节点 + 最多 6 颗邻近节点）。
 * @deprecated 新版全量星图主推 `layoutFullConstellationGraph`；保留本函数以向后兼容历史不变量 INV-LEARN-01。
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

export * from './constellationLayout.js';
