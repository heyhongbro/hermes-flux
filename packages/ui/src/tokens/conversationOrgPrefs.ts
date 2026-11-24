/**
 * 会话组织偏好与折叠态本地存储模块（Workspace Organization Preferences）
 *
 * 设计意图 (Why)：
 *   把「显示已完成区」「发送新消息自动恢复进行中」两项工作台显示偏好，
 *   以及桌面端左轨/移动端主页各项目/自定义文件夹/已完成区的折叠状态，
 *   以纯函数 + SSR 安全存储的方式统一收口到 @hermes-flux/ui Tokens，供全端共用。
 *
 * 防范历史坑 (Pitfall)：
 *   1. `done` 区默认折叠（未记录时返回 `true`），而项目与自定义文件夹默认展开（未记录时返回 `false`）；
 *   2. 不可信 JSON 或旧版损坏值必须稳健回落为默认值，严禁抛出语法异常阻断首屏挂载。
 *
 * 约束与规则 (Rules)：
 *   - `localStorage` 不存在时（Node SSR / 测试环境）安全返回默认对象并静默跳过持久化；
 *   - 两个偏好开关仅存于客户端本地偏好，不与网关 `projects` 或 `ui_meta` 混存。
 */

export interface ConversationOrgPrefs {
  /** 是否在左轨/首页底部展示「已完成」归档分区 */
  showDoneSection: boolean;
  /** 向处于「已完成」状态的普通会话或群聊发新消息时，是否自动恢复为进行中 */
  autoReopenOnSend: boolean;
  /** 在会话栏中隐藏文件夹（及其内部会话）的项目 ID 列表；不影响关联该项目但位于其它位置的会话 */
  hiddenProjectIds: string[];
}

export type OrgContainerCollapseState = Record<string, boolean>;

export interface OrgPrefsStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function getPrefsStorage(storage?: OrgPrefsStorage): OrgPrefsStorage | undefined {
  if (storage) return storage;
  return typeof localStorage !== 'undefined' ? localStorage : undefined;
}

const EMPTY_HIDDEN_PROJECT_IDS: string[] = [];
Object.freeze(EMPTY_HIDDEN_PROJECT_IDS);

export const DEFAULT_CONVERSATION_ORG_PREFS: Readonly<ConversationOrgPrefs> = Object.freeze({
  showDoneSection: true,
  autoReopenOnSend: true,
  hiddenProjectIds: EMPTY_HIDDEN_PROJECT_IDS,
});

export const CONVERSATION_ORG_PREFS_STORAGE_KEY = 'hermes_flux_conversation_org_prefs';
export const ORG_CONTAINER_COLLAPSE_STORAGE_KEY = 'hermes_flux_org_container_collapse';
export const DONE_CONTAINER_ID = 'done';

function normalizeHiddenProjectIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const next: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const clean = item.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    next.push(clean);
  }
  return next;
}

/**
 * 解析并归一化会话组织偏好对象
 */
export function resolveConversationOrgPrefs(raw: unknown): ConversationOrgPrefs {
  if (!raw || typeof raw !== 'object') {
    return {
      showDoneSection: DEFAULT_CONVERSATION_ORG_PREFS.showDoneSection,
      autoReopenOnSend: DEFAULT_CONVERSATION_ORG_PREFS.autoReopenOnSend,
      hiddenProjectIds: [],
    };
  }
  const candidate = raw as Record<string, unknown>;
  return {
    showDoneSection:
      typeof candidate.showDoneSection === 'boolean'
        ? candidate.showDoneSection
        : DEFAULT_CONVERSATION_ORG_PREFS.showDoneSection,
    autoReopenOnSend:
      typeof candidate.autoReopenOnSend === 'boolean'
        ? candidate.autoReopenOnSend
        : DEFAULT_CONVERSATION_ORG_PREFS.autoReopenOnSend,
    hiddenProjectIds: normalizeHiddenProjectIds(candidate.hiddenProjectIds),
  };
}

/**
 * 判断指定项目是否在会话栏中被隐藏其项目文件夹。
 */
export function isProjectHidden(
  prefs: Pick<ConversationOrgPrefs, 'hiddenProjectIds'> | undefined,
  projectId: string,
): boolean {
  const cleanId = projectId.trim();
  if (!cleanId || !prefs?.hiddenProjectIds) return false;
  return prefs.hiddenProjectIds.some((id) => id.trim() === cleanId);
}

/**
 * 返回切换单个项目会话栏文件夹可见性后的新偏好快照（纯函数）。
 */
export function setProjectVisibility(
  prefs: Partial<ConversationOrgPrefs> | undefined,
  projectId: string,
  visible: boolean,
): ConversationOrgPrefs {
  const normalized = resolveConversationOrgPrefs(prefs);
  const cleanId = projectId.trim();
  if (!cleanId) return normalized;
  const hiddenProjectIds = visible
    ? normalized.hiddenProjectIds.filter((id) => id !== cleanId)
    : normalized.hiddenProjectIds.includes(cleanId)
      ? normalized.hiddenProjectIds
      : [...normalized.hiddenProjectIds, cleanId];
  return {
    ...normalized,
    hiddenProjectIds,
  };
}

/**
 * 从 localStorage 读取会话组织偏好（SSR 安全）
 */
export function loadConversationOrgPrefs(storage?: OrgPrefsStorage): ConversationOrgPrefs {
  const store = getPrefsStorage(storage);
  if (!store) return { ...DEFAULT_CONVERSATION_ORG_PREFS };
  try {
    const raw = store.getItem(CONVERSATION_ORG_PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONVERSATION_ORG_PREFS };
    return resolveConversationOrgPrefs(JSON.parse(raw));
  // gate-degrade: 无痕模式或损坏的本地缓存回退为默认展示偏好，不得阻塞启动
  } catch {
    return { ...DEFAULT_CONVERSATION_ORG_PREFS };
  }
}

/**
 * 持久化会话组织偏好到 localStorage
 */
export function saveConversationOrgPrefs(prefs: ConversationOrgPrefs, storage?: OrgPrefsStorage): void {
  const store = getPrefsStorage(storage);
  if (!store) return;
  try {
    const normalized = resolveConversationOrgPrefs(prefs);
    store.setItem(CONVERSATION_ORG_PREFS_STORAGE_KEY, JSON.stringify(normalized));
  // gate-degrade: 存储配额耗尽或安全策略受限时静默保留当前内存偏好
  } catch {
  }
}

/**
 * 解析容器折叠映射表
 */
export function resolveOrgContainerCollapseState(raw: unknown): OrgContainerCollapseState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const next: OrgContainerCollapseState = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'boolean' && key.trim().length > 0) {
      next[key] = value;
    }
  }
  return next;
}

/**
 * 从 localStorage 读取容器折叠映射表
 */
export function loadOrgContainerCollapseState(storage?: OrgPrefsStorage): OrgContainerCollapseState {
  const store = getPrefsStorage(storage);
  if (!store) return {};
  try {
    const raw = store.getItem(ORG_CONTAINER_COLLAPSE_STORAGE_KEY);
    if (!raw) return {};
    return resolveOrgContainerCollapseState(JSON.parse(raw));
  // gate-degrade: 无本地读取权限或 JSON 损坏时回退为空折叠表（done 仍默认折叠）
  } catch {
    return {};
  }
}

/**
 * 持久化容器折叠映射表到 localStorage
 */
export function saveOrgContainerCollapseState(state: OrgContainerCollapseState, storage?: OrgPrefsStorage): void {
  const store = getPrefsStorage(storage);
  if (!store) return;
  try {
    const normalized = resolveOrgContainerCollapseState(state);
    store.setItem(ORG_CONTAINER_COLLAPSE_STORAGE_KEY, JSON.stringify(normalized));
  // gate-degrade: 写入 localStorage 失败仅影响下次重启记忆，不影响当前会话状态
  } catch {
  }
}

/**
 * 查询某容器当前是否处于折叠态。
 * `done` 区默认折叠，其余项目/自定义文件夹默认展开。
 */
export function isOrgContainerCollapsed(
  state: OrgContainerCollapseState | undefined,
  containerId: string,
): boolean {
  if (state && typeof state[containerId] === 'boolean') {
    return state[containerId];
  }
  return containerId === DONE_CONTAINER_ID;
}

/**
 * 返回更新某容器折叠态后的新映射表（纯函数）
 */
export function setOrgContainerCollapsed(
  state: OrgContainerCollapseState,
  containerId: string,
  collapsed: boolean,
): OrgContainerCollapseState {
  return {
    ...state,
    [containerId]: collapsed,
  };
}
