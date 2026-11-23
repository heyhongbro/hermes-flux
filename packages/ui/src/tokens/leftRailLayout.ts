/**
 * 左侧栏布局样式偏好（Dual Rail 双轨分栏 vs Grouped 分组列表）唯一真值表与持久化。
 *
 * 【设计意图 (Why)】
 *   桌面端新增“参考移动端首页、无独立 BOT 边栏、按 BOT / 群聊 / 普通会话三段分组展示”的
 *   单栏会话布局（grouped），并与既有“微轨 + 上下文抽屉”双轨布局（dual-rail）并存可切换。
 *   将枚举、默认值、持久化 Key、局部折叠状态与根节点属性写入收敛在零 DOM/React 依赖的 tokens 层，
 *   确保设置中心、状态初始化、左轨快照、顶栏对齐与样式规则消费同一份真值。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 隐私模式或无权限下访问 localStorage 会抛 SecurityError，读写必须降级为默认值而不阻塞界面；
 *   2. 脏数据（手改或旧版本残留）不得直接落入 data-left-rail-layout，必须先经过白名单收敛；
 *   3. 分组折叠状态持久化若被篡改为非布尔值或损坏 JSON，必须优雅回落到全展开。
 *
 * 【约束与规则 (Rules)】
 *   1. 存储键统一使用 hermes_flux_* 前缀；
 *   2. 未知值、空值、非字符串一律收敛为 DEFAULT_LEFT_RAIL_LAYOUT（'dual-rail'）；
 *   3. 本文件严格零 React / DOM 运行时依赖，可在 Node 单测中直接验证。
 */

export const LEFT_RAIL_LAYOUTS = ['dual-rail', 'grouped'] as const;

export type LeftRailLayoutMode = (typeof LEFT_RAIL_LAYOUTS)[number];

export const DEFAULT_LEFT_RAIL_LAYOUT: LeftRailLayoutMode = 'dual-rail';

export const LEFT_RAIL_LAYOUT_STORAGE_KEY = 'hermes_flux_left_rail_layout';

export const GROUPED_RAIL_SECTIONS_STORAGE_KEY = 'hermes_flux_grouped_rail_sections';

export interface GroupedRailSectionsState {
  bots: boolean;
  groups: boolean;
  sessions: boolean;
}

export const DEFAULT_GROUPED_RAIL_SECTIONS: GroupedRailSectionsState = Object.freeze({
  bots: true,
  groups: true,
  sessions: true,
});

const LAYOUT_SET = new Set<string>(LEFT_RAIL_LAYOUTS);

/** 应用左侧栏布局属性所需的最小 DOM 根接口（不依赖完整 HTMLElement）。 */
export type LeftRailLayoutRootTarget = {
  setAttribute(name: string, value: string): void;
};

/**
 * 把任意输入收敛为合法的左侧栏布局档位。
 * 【规则】未知值、空值、非字符串一律回落到默认值（'dual-rail'）。
 */
export function resolveLeftRailLayout(value: string | null | undefined): LeftRailLayoutMode {
  // SAFETY: [narrowed-by] LAYOUT_SET.has() 已证明该字符串是左侧栏布局真值表成员
  return typeof value === 'string' && LAYOUT_SET.has(value)
    ? (value as LeftRailLayoutMode)
    : DEFAULT_LEFT_RAIL_LAYOUT;
}

/** 从 localStorage 读取左侧栏布局偏好，缺失或不可用时安全回落默认值。 */
export function loadLeftRailLayout(): LeftRailLayoutMode {
  let raw: string | null = null;
  try {
    raw =
      typeof localStorage === 'undefined'
        ? null
        : localStorage.getItem(LEFT_RAIL_LAYOUT_STORAGE_KEY);
  // gate-degrade: 隐私模式下读取 localStorage 会抛错，缺失偏好回落默认值属可选增强失败
  } catch {
    raw = null;
  }
  return resolveLeftRailLayout(raw);
}

/** 将左侧栏布局偏好持久化到 localStorage（异常时不阻断界面交互）。 */
export function saveLeftRailLayout(mode: LeftRailLayoutMode): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LEFT_RAIL_LAYOUT_STORAGE_KEY, resolveLeftRailLayout(mode));
    }
  // gate-degrade: 写入失败时偏好仅在当前内存会话生效，不阻断渲染
  } catch {
    // 写入失败不影响当前渲染
  }
}

/** 将左侧栏布局模式同步到根节点 `data-left-rail-layout`，供桌面顶栏与 CSS 几何选择器消费。 */
export function applyLeftRailLayout(
  mode: LeftRailLayoutMode | string | null | undefined,
  root: LeftRailLayoutRootTarget | null = typeof document === 'undefined' ? null : document.documentElement,
): LeftRailLayoutMode {
  const resolved = resolveLeftRailLayout(mode);
  if (!root) return resolved;
  root.setAttribute('data-left-rail-layout', resolved);
  return resolved;
}

/** 从 localStorage 读取分组模式各区块展开状态；仅接受明确布尔值，异常时默认全展开。 */
export function loadGroupedRailSections(): GroupedRailSectionsState {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_GROUPED_RAIL_SECTIONS };
    const raw = localStorage.getItem(GROUPED_RAIL_SECTIONS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GROUPED_RAIL_SECTIONS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_GROUPED_RAIL_SECTIONS };
    const record = parsed as Record<string, unknown>;
    return {
      bots: typeof record.bots === 'boolean' ? record.bots : true,
      groups: typeof record.groups === 'boolean' ? record.groups : true,
      sessions: typeof record.sessions === 'boolean' ? record.sessions : true,
    };
  // gate-degrade: 分组折叠缓存损坏或被策略禁用时安全回落全展开，不得阻断启动
  } catch {
    return { ...DEFAULT_GROUPED_RAIL_SECTIONS };
  }
}

/** 将分组模式各区块展开状态写入 localStorage。 */
export function saveGroupedRailSections(sections: GroupedRailSectionsState): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        GROUPED_RAIL_SECTIONS_STORAGE_KEY,
        JSON.stringify({
          bots: Boolean(sections.bots),
          groups: Boolean(sections.groups),
          sessions: Boolean(sections.sessions),
        }),
      );
    }
  // gate-degrade: 折叠状态落盘失败可降级，内存态仍实时响应
  } catch {
    // 写入失败不影响当前渲染
  }
}
