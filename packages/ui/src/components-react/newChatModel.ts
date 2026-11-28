/**
 * 新建会话弹窗视图模型与纯状态逻辑（zero React / zero DOM）。
 *
 * 【设计意图 (Why)】
 *   重新设计桌面端新建会话交互：参考移动端“先选对象/即兴开聊”理念，兼顾桌面端“单人会话 / 多智能体群聊”
 *   双模式与项目工作区关联。把默认 BOT 解析、初始群成员兜底、成员勾选翻转与提交载荷拼装收口进纯函数，
 *   让测试无需启动浏览器即可按四个象限断言全部边界与提交协议。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 当 `profiles` 未携带 `selectedProfile` 或为空时，不可返回空串导致下游 `session.create` 缺 profile；
 *   2. 群聊成员允许按任意顺序点击勾选，去重与 `< 2 人拦截` 必须在此单点收口，避免渲染层与控制器各判各的；
 *   3. `firstMessage` 保留是否为空的语义：空串允许建空白会话，非空时建完会话/群聊后自动发起首句发送。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁引入 react / DOM / 网络；
 *   - 所有输出均可序列化、纯函数无副作用。
 */

import type { LeftRailFolder, LeftRailProfile } from '../components/LeftRail/types.js';

export type NewChatMode = 'solo' | 'group';

export interface NewChatGatewayOption {
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
}

export interface NewChatProjectOption {
  id: string;
  name: string;
  path?: string;
  archived?: boolean;
  gatewayId?: string;
}

export interface NewChatDialogSnapshot {
  isOpen: boolean;
  initialMode: NewChatMode;
  profiles: LeftRailProfile[];
  projects: NewChatProjectOption[];
  folders?: LeftRailFolder[];
  selectedProfile: string;
  selectedProjectId?: string;
  selectedContainerId?: string;
  gatewayConnected: boolean;
  gateways?: readonly NewChatGatewayOption[];
  defaultGatewayId?: string;
}

export interface NewChatSubmitPayload {
  mode: NewChatMode;
  agent: string;
  members: string[];
  title: string;
  projectId?: string;
  containerId?: string;
  gatewayId?: string;
  firstMessage: string;
}

/** 过滤网关已归档项目，仅保留活跃项目供新建对话选择器消费。 */
export function resolveActiveNewChatProjects(
  projects: readonly NewChatProjectOption[],
): NewChatProjectOption[] {
  return (projects || []).filter((p) => Boolean(p && p.id && !p.archived));
}

export interface NewChatSubmitResult {
  ok: boolean;
  error?: string;
}

export interface NewChatDialogActions {
  onClose: () => void;
  onModeChange?: (mode: NewChatMode) => void;
  onSubmit: (payload: NewChatSubmitPayload) => void | NewChatSubmitResult | Promise<void | NewChatSubmitResult>;
}

export interface NewChatSubmitGate {
  begin(): number | null;
  end(token: number): boolean;
  reset(): void;
  isBusy(): boolean;
}

/**
 * 为新建弹窗提供单调递增的提交令牌锁，防止连击重入与关窗重开后的陈旧 finally 误解锁。
 */
export function createNewChatSubmitGate(): NewChatSubmitGate {
  let busy = false;
  let activeToken = 0;
  let nextToken = 0;

  return {
    begin() {
      if (busy) return null;
      busy = true;
      activeToken = ++nextToken;
      return activeToken;
    },
    end(token: number) {
      if (token !== activeToken) return false;
      busy = false;
      return true;
    },
    reset() {
      activeToken = ++nextToken;
      busy = false;
    },
    isBusy() {
      return busy;
    },
  };
}

export interface NewChatDraftInput {
  mode: NewChatMode;
  selectedBot: string;
  selectedMembers: readonly string[];
  title?: string;
  projectId?: string;
  containerId?: string;
  gatewayId?: string;
  firstMessage?: string;
}

/** 解析新建会话弹窗初始归属网关：优先 defaultGatewayId -> 首台在线网关 -> 列表首项。 */
export function resolveInitialGatewayId(
  gateways?: readonly NewChatGatewayOption[],
  defaultGatewayId?: string,
): string {
  if (!gateways || gateways.length === 0) return '';
  const preferred = (defaultGatewayId || '').trim();
  if (preferred && gateways.some((g) => g.id === preferred)) {
    return preferred;
  }
  return gateways.find((g) => g.connected)?.id || gateways[0].id || '';
}

/** 按网关实例过滤可选智能体；未指定 gatewayId 时返回全量副本。 */
export function filterProfilesForGateway(
  profiles: readonly LeftRailProfile[],
  gatewayId?: string,
): LeftRailProfile[] {
  const gw = (gatewayId || '').trim();
  if (!gw) return [...profiles];
  return profiles.filter((p) => !p.gatewayId || p.gatewayId === gw);
}

/** 按网关实例过滤可选项目；未指定 gatewayId 时返回全量副本。 */
export function filterProjectsForGateway<T extends { gatewayId?: string }>(
  projects: readonly T[],
  gatewayId?: string,
): T[] {
  const gw = (gatewayId || '').trim();
  if (!gw) return [...projects];
  return projects.filter((p) => !p.gatewayId || p.gatewayId === gw);
}

export type NewChatBuildOutcome =
  | { ok: true; payload: NewChatSubmitPayload }
  | { ok: false; reason: 'need-two-members' };

/**
 * 基于已选成员顺序自动生成群聊名称（最多拼接前 3 位，超出部分追加 `+N`；无有效成员时回落默认名称）。
 */
export function buildAutoGroupTitle(
  members: readonly string[],
  profiles: readonly LeftRailProfile[],
  fallbackTitle: string,
): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of members) {
    const clean = raw.trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const matched = profiles.find((p) => p.name.toLowerCase() === lower);
    names.push((matched?.displayName || matched?.name || clean).trim());
  }
  if (names.length === 0) return fallbackTitle;
  const head = names.slice(0, 3).join(' · ');
  return names.length > 3 ? `${head} +${names.length - 3}` : head;
}

/** 解析默认单聊目标 BOT（优先已选 profile -> default 标记 -> 首个成员 -> 'default'）。 */
export function resolveDefaultBotName(
  profiles: readonly LeftRailProfile[],
  selectedProfile?: string,
): string {
  const cleanSelected = (selectedProfile || '').trim();
  if (cleanSelected) {
    const matched = profiles.find((p) => p.name.toLowerCase() === cleanSelected.toLowerCase());
    if (matched) return matched.name;
  }
  const defaultBot = profiles.find((p) => p.isDefault || p.name.toLowerCase() === 'default');
  if (defaultBot) return defaultBot.name;
  if (profiles.length > 0 && profiles[0].name) return profiles[0].name;
  return cleanSelected || 'default';
}

/**
 * 为多智能体群聊预设初始成员列表（去重，最多 2 位：优先当前选中 BOT + 首名其他成员）。
 */
export function resolveInitialGroupMembers(
  profiles: readonly LeftRailProfile[],
  selectedProfile?: string,
): string[] {
  if (profiles.length === 0) return [];
  const primary = resolveDefaultBotName(profiles, selectedProfile);
  const members: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (name: string): void => {
    const key = name.trim();
    if (!key || seen.has(key.toLowerCase())) return;
    seen.add(key.toLowerCase());
    members.push(key);
  };
  pushUnique(primary);
  for (const profile of profiles) {
    if (members.length >= 2) break;
    pushUnique(profile.name);
  }
  return members;
}

/** 切换单个群聊参会 BOT 勾选状态（返回去重后的新数组）。 */
export function toggleGroupMember(current: readonly string[], botName: string): string[] {
  const target = botName.trim();
  if (!target) return [...current];
  const targetLower = target.toLowerCase();
  const exists = current.some((name) => name.toLowerCase() === targetLower);
  if (exists) {
    return current.filter((name) => name.toLowerCase() !== targetLower);
  }
  return [...current, target];
}

/**
 * 校验并对齐预选项目 ID：仅当项目仍存在于列表中时保留，否则回落空串以显示占位文案。
 */
export function resolveValidProjectId(
  projects: readonly NewChatProjectOption[],
  selectedProjectId?: string,
): string {
  const clean = (selectedProjectId || '').trim();
  if (!clean) return '';
  return projects.some((p) => p.id === clean) ? clean : '';
}

/**
 * 异步冷启动 profiles 到达后，在用户尚未手动介入选角时同步默认单聊 BOT 与群聊 >= 2 名初始成员。
 */
export function syncDialogSelectionOnProfiles(params: {
  profiles: readonly LeftRailProfile[];
  selectedProfile?: string;
  currentBot: string;
  currentMembers: readonly string[];
  userTouched: boolean;
}): { nextBot?: string; nextMembers?: string[] } {
  if (params.userTouched || params.profiles.length === 0) return {};
  const nextBot = params.profiles.some((p) => p.name.toLowerCase() === params.currentBot.toLowerCase())
    ? undefined
    : resolveDefaultBotName(params.profiles, params.selectedProfile);
  const validCurrentMembers = params.currentMembers.filter((name) =>
    params.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase()),
  );
  const expectedMembers = resolveInitialGroupMembers(params.profiles, params.selectedProfile);
  const needsMembersSync =
    (validCurrentMembers.length < 2 && expectedMembers.length >= 2) ||
    (validCurrentMembers.length === 0 && expectedMembers.length > 0);
  return {
    ...(nextBot ? { nextBot } : {}),
    ...(needsMembersSync ? { nextMembers: expectedMembers } : {}),
  };
}

/**
 * 判断新建会话输入区按键是否应直接创建并发送首条消息（拦截 Shift+Enter 换行、IME 组合态与禁发状态）。
 */
export function shouldSubmitNewChatComposerKey(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
  canSubmit: boolean;
}): boolean {
  if (input.key !== 'Enter' || input.shiftKey) return false;
  if (input.isComposing || input.keyCode === 229) return false;
  return input.canSubmit;
}

/** 校验草稿并构造统一提交载荷。 */
export function buildNewChatSubmitPayload(draft: NewChatDraftInput): NewChatBuildOutcome {
  const title = (draft.title ?? '').trim();
  const firstMessage = (draft.firstMessage ?? '').trim();
  const projectId = (draft.projectId || '').trim() || undefined;
  const hasExplicitContainer = 'containerId' in draft && draft.containerId !== undefined;
  const containerId = (draft.containerId || '').trim();
  const gatewayId = (draft.gatewayId || '').trim() || undefined;
  const agent = (draft.selectedBot || '').trim() || 'default';

  const seen = new Set<string>();
  const uniqueMembers: string[] = [];
  for (const m of draft.selectedMembers) {
    const clean = m.trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    uniqueMembers.push(clean);
  }

  if (draft.mode === 'group' && uniqueMembers.length < 2) {
    return { ok: false, reason: 'need-two-members' };
  }

  return {
    ok: true,
    payload: {
      mode: draft.mode,
      agent,
      members: draft.mode === 'group' ? uniqueMembers : [],
      title,
      projectId,
      ...(hasExplicitContainer ? { containerId } : {}),
      ...(gatewayId ? { gatewayId } : {}),
      firstMessage,
    },
  };
}
