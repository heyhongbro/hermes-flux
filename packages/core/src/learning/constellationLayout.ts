/**
 * 认知星图全量拓扑布局与技能清单派生 (packages/core/src/learning/constellationLayout.ts)
 *
 * 【设计意图 (Why)】
 *   取消窄屏分页截断后，需要将全部节点（Skill + Memory）一次性稳定排布到可缩放/可拖拽的二维星图画布：
 *   1. 按节点种类与被调用次数 (`uses`) 映射可视化半径（高频技能显著突显，Memory 维持轻量）；
 *   2. 按类别聚类初始化于黄金角螺旋环，再用确定性弹簧斥力与硬碰撞消除迭代收敛，确保大星图既紧凑又永不重叠；
 *   3. 同步从图谱派生排序后的「技能清单」及其关联技能/记忆索引，供星图下方列表与放大详情弹窗直接消费。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 禁止使用 `Math.random()` 初始化坐标，否则每次重渲染或快照切换节点位置都会抖动；
 *   2. 节点外圈需预留徽标与标题标签空间，硬碰撞最小间距 (`rA + rB + padding`) 不足会导致文字互相遮挡；
 *   3. 所有坐标计算必须是纯函数并产出有限数值 (`Number.isFinite`)，即使遇到极端调用次数或空图也不得产生 `NaN`。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM / React 依赖，零随机数；
 *   - 成对节点间距恒满足非负有界碰撞下限，坐标围绕画布原点正数化输出 `(0 .. width, 0 .. height)`。
 */

import type {
  ConstellationEdge,
  ConstellationGraph,
  ConstellationNode,
  LearningFilterKind,
} from './learningConstellation.js';

export interface FullPositionedNode extends ConstellationNode {
  x: number;
  y: number;
  radius: number;
  degree: number;
  skillLinkCount: number;
  isSelected: boolean;
  isNeighbor: boolean;
}

export interface FullConstellationLayout {
  nodes: FullPositionedNode[];
  edges: ConstellationEdge[];
  width: number;
  height: number;
  activeNode: ConstellationNode | null;
  connectedIds: string[];
  skillLinkCount: number;
  totalUses: number;
}

export interface ConstellationSkillSummary {
  node: ConstellationNode;
  skillName: string;
  uses: number;
  relatedSkillIds: string[];
  relatedMemoryIds: string[];
  linkCount: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const DEFAULT_CANVAS_WIDTH = 640;
const DEFAULT_CANVAS_HEIGHT = 440;
const DEFAULT_PADDING = 92;
const HARD_MIN_GAP_PX = 36;
const RELAX_TARGET_GAP_PX = 68;

function sanitizeUses(uses: number): number {
  return typeof uses === 'number' && Number.isFinite(uses) && uses > 0 ? Math.floor(uses) : 0;
}

/** 根据节点类型与调用次数计算确定性星图圆半径（px）。 */
export function computeConstellationNodeRadius(kind: ConstellationNode['kind'], uses: number): number {
  const safeUses = sanitizeUses(uses);
  const growth = Math.log2(safeUses + 1);
  if (kind === 'skill') {
    return Math.round(22 + Math.min(18, growth * 4.2));
  }
  return Math.round(18 + Math.min(8, growth * 2.4));
}

function roundCoord(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(2));
}

function isSkillToSkillEdge(edge: ConstellationEdge, nodeMap: ReadonlyMap<string, ConstellationNode>): boolean {
  if (edge.kind === 'skill-link') return true;
  const a = nodeMap.get(edge.source);
  const b = nodeMap.get(edge.target);
  return Boolean(a && b && a.kind === 'skill' && b.kind === 'skill');
}

function idealEdgeDistance(kind: ConstellationEdge['kind']): number {
  switch (kind) {
    case 'skill-link':
      return 165;
    case 'mention':
      return 185;
    case 'same-bucket':
      return 205;
    case 'same-category':
    default:
      return 215;
  }
}

/**
 * 为认知星图计算非分页全量二维确定性力导向布局。
 */
export function layoutFullConstellationGraph(
  graph: ConstellationGraph,
  options: {
    selectedId?: string;
    filter?: LearningFilterKind;
    padding?: number;
  } = {},
): FullConstellationLayout {
  const filter = options.filter ?? 'all';
  const padding =
    typeof options.padding === 'number' && Number.isFinite(options.padding) && options.padding >= 24
      ? options.padding
      : DEFAULT_PADDING;

  const filteredNodes =
    filter === 'all' ? graph.nodes : graph.nodes.filter((node) => node.kind === filter);

  if (filteredNodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      width: DEFAULT_CANVAS_WIDTH,
      height: DEFAULT_CANVAS_HEIGHT,
      activeNode: null,
      connectedIds: [],
      skillLinkCount: 0,
      totalUses: 0,
    };
  }

  const nodeMap = new Map<string, ConstellationNode>();
  for (const node of filteredNodes) {
    nodeMap.set(node.id, node);
  }

  const visibleEdges: ConstellationEdge[] = [];
  const degreeMap = new Map<string, number>();
  const skillLinkMap = new Map<string, number>();
  let totalSkillLinks = 0;

  for (const edge of graph.edges) {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target) || edge.source === edge.target) {
      continue;
    }
    visibleEdges.push(edge);
    degreeMap.set(edge.source, (degreeMap.get(edge.source) ?? 0) + 1);
    degreeMap.set(edge.target, (degreeMap.get(edge.target) ?? 0) + 1);
    if (isSkillToSkillEdge(edge, nodeMap)) {
      totalSkillLinks += 1;
      skillLinkMap.set(edge.source, (skillLinkMap.get(edge.source) ?? 0) + 1);
      skillLinkMap.set(edge.target, (skillLinkMap.get(edge.target) ?? 0) + 1);
    }
  }

  const matchedSelected = options.selectedId ? nodeMap.get(options.selectedId) : undefined;
  let activeNode: ConstellationNode = matchedSelected ?? filteredNodes[0];
  if (!matchedSelected) {
    const sortedDefaults = [...filteredNodes].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'skill' ? -1 : 1;
      const usesDiff = sanitizeUses(b.uses) - sanitizeUses(a.uses);
      if (usesDiff !== 0) return usesDiff;
      const degDiff = (degreeMap.get(b.id) ?? 0) - (degreeMap.get(a.id) ?? 0);
      if (degDiff !== 0) return degDiff;
      return a.id.localeCompare(b.id);
    });
    activeNode = sortedDefaults[0];
  }

  const connectedSet = new Set<string>();
  for (const edge of visibleEdges) {
    if (edge.source === activeNode.id) connectedSet.add(edge.target);
    else if (edge.target === activeNode.id) connectedSet.add(edge.source);
  }

  // 1. 按类别聚集并做确定性初始排布
  const clusters = new Map<string, ConstellationNode[]>();
  for (const node of filteredNodes) {
    const key = (node.category || node.kind).trim() || node.kind;
    const group = clusters.get(key);
    if (group) group.push(node);
    else clusters.set(key, [node]);
  }

  const orderedClusters = Array.from(clusters.entries()).sort((a, b) => {
    const usesA = a[1].reduce((sum, n) => sum + sanitizeUses(n.uses), 0);
    const usesB = b[1].reduce((sum, n) => sum + sanitizeUses(n.uses), 0);
    if (usesB !== usesA) return usesB - usesA;
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return a[0].localeCompare(b[0]);
  });

  const count = filteredNodes.length;
  const radii = new Array<number>(count);
  const posX = new Array<number>(count);
  const posY = new Array<number>(count);
  const indexById = new Map<string, number>();
  const orderedNodes: ConstellationNode[] = [];

  const globalSpread = Math.max(120, Math.sqrt(count) * 76);

  orderedClusters.forEach(([, members], clusterIdx) => {
    const sortedMembers = [...members].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'skill' ? -1 : 1;
      const usesDiff = sanitizeUses(b.uses) - sanitizeUses(a.uses);
      if (usesDiff !== 0) return usesDiff;
      return a.id.localeCompare(b.id);
    });

    const clusterAngle = clusterIdx * GOLDEN_ANGLE;
    const clusterRadius =
      clusterIdx === 0 ? 0 : globalSpread * (0.38 + 0.62 * Math.sqrt(clusterIdx / Math.max(1, orderedClusters.length)));
    const cx = Math.cos(clusterAngle) * clusterRadius;
    const cy = Math.sin(clusterAngle) * clusterRadius;

    sortedMembers.forEach((node, memberIdx) => {
      const idx = orderedNodes.length;
      orderedNodes.push(node);
      indexById.set(node.id, idx);
      radii[idx] = computeConstellationNodeRadius(node.kind, node.uses);

      if (memberIdx === 0) {
        posX[idx] = cx;
        posY[idx] = cy;
      } else {
        const localAngle = memberIdx * GOLDEN_ANGLE + clusterIdx * 0.7;
        const localDist = 86 + Math.sqrt(memberIdx) * 52;
        posX[idx] = cx + Math.cos(localAngle) * localDist;
        posY[idx] = cy + Math.sin(localAngle) * localDist;
      }
    });
  });

  const edgePairs: Array<{ a: number; b: number; ideal: number; strength: number }> = [];
  for (const edge of visibleEdges) {
    const a = indexById.get(edge.source);
    const b = indexById.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    edgePairs.push({
      a,
      b,
      ideal: idealEdgeDistance(edge.kind),
      strength: edge.kind === 'skill-link' ? 0.14 : edge.kind === 'mention' ? 0.1 : 0.06,
    });
  }

  // 2. 确定性弹簧斥力松弛（多节点只围绕质心平稳聚拢，避免飞散或堆叠）
  const dispX = new Float64Array(count);
  const dispY = new Float64Array(count);
  const iterations = count <= 1 ? 0 : Math.min(48, 24 + count);

  for (let iter = 0; iter < iterations; iter++) {
    dispX.fill(0);
    dispY.fill(0);
    const stepScale = 1 - (iter / iterations) * 0.55;

    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let dx = posX[j] - posX[i];
        let dy = posY[j] - posY[i];
        let distSq = dx * dx + dy * dy;
        if (distSq < 1e-4) {
          const fallbackAngle = (i * 1.618 + j * 2.718) % (Math.PI * 2);
          dx = Math.cos(fallbackAngle);
          dy = Math.sin(fallbackAngle);
          distSq = 1;
        }
        const dist = Math.sqrt(distSq);
        const minSep = radii[i] + radii[j] + RELAX_TARGET_GAP_PX;
        if (dist < minSep) {
          const push = ((minSep - dist) / dist) * 0.42;
          const fx = dx * push;
          const fy = dy * push;
          dispX[i] -= fx;
          dispY[i] -= fy;
          dispX[j] += fx;
          dispY[j] += fy;
        } else if (dist < minSep * 1.9) {
          const soft = 260 / Math.max(distSq, 100);
          const fx = (dx / dist) * soft;
          const fy = (dy / dist) * soft;
          dispX[i] -= fx;
          dispY[i] -= fy;
          dispX[j] += fx;
          dispY[j] += fy;
        }
      }
    }

    for (const pair of edgePairs) {
      const dx = posX[pair.b] - posX[pair.a];
      const dy = posY[pair.b] - posY[pair.a];
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-4) continue;
      const pull = ((dist - pair.ideal) * pair.strength) / dist;
      const fx = dx * pull;
      const fy = dy * pull;
      dispX[pair.a] += fx;
      dispY[pair.a] += fy;
      dispX[pair.b] -= fx;
      dispY[pair.b] -= fy;
    }

    for (let i = 0; i < count; i++) {
      // 轻向心力让离散集群维持在舒适视野内
      dispX[i] -= posX[i] * 0.032;
      dispY[i] -= posY[i] * 0.032;

      const mag = Math.hypot(dispX[i], dispY[i]);
      const maxMove = 42 * stepScale;
      if (mag > maxMove && mag > 0) {
        dispX[i] = (dispX[i] / mag) * maxMove;
        dispY[i] = (dispY[i] / mag) * maxMove;
      }
      posX[i] += dispX[i];
      posY[i] += dispY[i];
    }
  }

  // 3. 刚性非重叠约束扫掠：保证任意两颗星点圆心距 >= rA + rB + HARD_MIN_GAP_PX
  for (let pass = 0; pass < 36; pass++) {
    let adjusted = false;
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let dx = posX[j] - posX[i];
        let dy = posY[j] - posY[i];
        let dist = Math.hypot(dx, dy);
        const minDist = radii[i] + radii[j] + HARD_MIN_GAP_PX;
        if (dist >= minDist) continue;
        if (dist < 1e-4) {
          const angle = (i * GOLDEN_ANGLE + j * 1.1) % (Math.PI * 2);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          dist = 1;
        }
        const delta = (minDist - dist) * 0.52;
        const nx = (dx / dist) * delta;
        const ny = (dy / dist) * delta;
        posX[i] -= nx;
        posY[i] -= ny;
        posX[j] += nx;
        posY[j] += ny;
        adjusted = true;
      }
    }
    if (!adjusted) break;
  }

  // 4. 原点归正并投影成 FullPositionedNode
  let minLeft = Infinity;
  let minTop = Infinity;
  for (let i = 0; i < count; i++) {
    minLeft = Math.min(minLeft, posX[i] - radii[i]);
    minTop = Math.min(minTop, posY[i] - radii[i]);
  }
  const shiftX = padding - (Number.isFinite(minLeft) ? minLeft : 0);
  const shiftY = padding - (Number.isFinite(minTop) ? minTop : 0);

  let maxRight = 0;
  let maxBottom = 0;
  let totalUses = 0;

  const finalNodesById = new Map<string, FullPositionedNode>();
  for (let i = 0; i < count; i++) {
    const node = orderedNodes[i];
    const x = roundCoord(posX[i] + shiftX);
    const y = roundCoord(posY[i] + shiftY);
    const r = radii[i];
    maxRight = Math.max(maxRight, x + r);
    maxBottom = Math.max(maxBottom, y + r);
    const uses = sanitizeUses(node.uses);
    totalUses += uses;

    finalNodesById.set(node.id, {
      ...node,
      uses,
      x,
      y,
      radius: r,
      degree: degreeMap.get(node.id) ?? 0,
      skillLinkCount: skillLinkMap.get(node.id) ?? 0,
      isSelected: node.id === activeNode.id,
      isNeighbor: connectedSet.has(node.id),
    });
  }

  // 保持与 filteredNodes 一致的顺序，并将选中节点置于最后以便 SVG 后绘制居顶
  const positionedNodes: FullPositionedNode[] = [];
  let selectedPositioned: FullPositionedNode | null = null;
  for (const node of filteredNodes) {
    const pos = finalNodesById.get(node.id);
    if (!pos) continue;
    if (pos.isSelected) selectedPositioned = pos;
    else positionedNodes.push(pos);
  }
  if (selectedPositioned) positionedNodes.push(selectedPositioned);

  const width = Math.max(DEFAULT_CANVAS_WIDTH, Math.ceil(maxRight + padding));
  const height = Math.max(DEFAULT_CANVAS_HEIGHT, Math.ceil(maxBottom + padding));

  return {
    nodes: positionedNodes,
    edges: visibleEdges,
    width,
    height,
    activeNode,
    connectedIds: Array.from(connectedSet),
    skillLinkCount: totalSkillLinks,
    totalUses,
  };
}

/**
 * 从认知星图派生按被调用次数与关联度排序的技能清单（供星图下方列表直接展示）。
 */
export function extractConstellationSkillList(graph: ConstellationGraph): ConstellationSkillSummary[] {
  const nodeMap = new Map<string, ConstellationNode>();
  for (const node of graph.nodes) {
    nodeMap.set(node.id, node);
  }

  const relatedSkillsByNode = new Map<string, Set<string>>();
  const relatedMemoriesByNode = new Map<string, Set<string>>();

  const recordRelation = (ownerId: string, neighbor: ConstellationNode): void => {
    const targetMap = neighbor.kind === 'skill' ? relatedSkillsByNode : relatedMemoriesByNode;
    let bucket = targetMap.get(ownerId);
    if (!bucket) {
      bucket = new Set<string>();
      targetMap.set(ownerId, bucket);
    }
    bucket.add(neighbor.id);
  };

  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    const src = nodeMap.get(edge.source);
    const dst = nodeMap.get(edge.target);
    if (!src || !dst) continue;
    if (src.kind === 'skill') recordRelation(src.id, dst);
    if (dst.kind === 'skill') recordRelation(dst.id, src);
  }

  const summaries: ConstellationSkillSummary[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'skill') continue;
    const relatedSkillIds = Array.from(relatedSkillsByNode.get(node.id) ?? []);
    const relatedMemoryIds = Array.from(relatedMemoriesByNode.get(node.id) ?? []);
    const uses = sanitizeUses(node.uses);
    summaries.push({
      node: { ...node, uses },
      skillName: (node.skillName || node.id.replace(/^skill:/i, '')).trim() || node.id,
      uses,
      relatedSkillIds,
      relatedMemoryIds,
      linkCount: relatedSkillIds.length,
    });
  }

  summaries.sort((a, b) => {
    const usesDiff = b.uses - a.uses;
    if (usesDiff !== 0) return usesDiff;
    const linkDiff = b.linkCount - a.linkCount;
    if (linkDiff !== 0) return linkDiff;
    const labelDiff = a.node.label.localeCompare(b.node.label);
    if (labelDiff !== 0) return labelDiff;
    return a.node.id.localeCompare(b.node.id);
  });

  return summaries;
}
