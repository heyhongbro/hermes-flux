/**
 * Connections (`connection.request` / `connection.update` / `pending_connection`) 强类型解析器
 *
 * 【设计意图 (Why)】
 *   网关推送的事件帧与恢复快照均为 `Record<string, unknown>`。在 Core 层将其转换为强类型
 *   `ConnectionRequestPayload` 与 `ConnectionUpdatePayload`，禁止使用 `as unknown as` 强转，
 *   保证字段契约漂移时可安全归一化而不破坏前端渲染。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁类型逃逸断言；
 *   - 仅提取契约定义字段，非法 target 自动跳过。
 */

import type {
  ConnectionOperationTarget,
  ConnectionRequestPayload,
  ConnectionUpdatePayload,
  SessionOwner,
  AccountOwner,
} from '../rpc/types.js';
import type {
  CatalogAppState,
  CatalogApproved,
  CatalogScan,
  CatalogScanStatus,
  CatalogServerError,
  CatalogTier,
  ConnectionActor,
  ConnectionDisplay,
  ConnectionSettleReason,
  ConnectionTargetAction,
  ConnectionTargetEnvField,
  ConnectionTargetKind,
  ConnectionTargetLaunch,
  ConnectionTargetLaunchKind,
  ConnectionTargetState,
  InstallPhase,
} from '../rpc/contracts/gateway-contract.generated.js';

const TARGET_KINDS = new Set<ConnectionTargetKind>(['connector', 'mcp', 'plugin', 'skill']);
const TARGET_ACTIONS = new Set<ConnectionTargetAction>(['authorize', 'connect', 'enable', 'install', 'reconnect']);
const TARGET_STATES = new Set<ConnectionTargetState>([
  'pending',
  'initiated',
  'connected',
  'skipped',
  'failed',
  'expired',
  'not_connected',
]);
const LAUNCH_KINDS = new Set<ConnectionTargetLaunchKind>(['remote', 'stdio']);
const CATALOG_TIERS = new Set<CatalogTier>(['official', 'verified', 'community']);
const SCAN_STATUSES = new Set<CatalogScanStatus>(['passed', 'warnings', 'failed']);
const APP_STATES = new Set<CatalogAppState>(['present', 'missing_app', 'app_not_running', 'unknown']);
const INSTALL_PHASES = new Set<InstallPhase>(['downloading', 'python_packages', 'loading_tools']);
const SETTLE_REASONS = new Set<ConnectionSettleReason>(['all_resolved', 'continue', 'deadline', 'interrupt']);
const ACTORS = new Set<ConnectionActor>(['user', 'backend_watcher', 'clock']);

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asOptStr(v: unknown): string | null | undefined {
  if (v === null) return null;
  return typeof v === 'string' ? v : undefined;
}

function asOptBool(v: unknown): boolean | null | undefined {
  if (v === null) return null;
  return typeof v === 'boolean' ? v : undefined;
}

function asNum(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asStringArray(v: unknown): string[] | null | undefined {
  if (v === null) return null;
  if (!Array.isArray(v)) return undefined;
  return v.filter((item): item is string => typeof item === 'string');
}

function inSet<T extends string>(v: unknown, set: ReadonlySet<T>): T | undefined {
  if (typeof v !== 'string') return undefined;
  for (const candidate of set) {
    if (candidate === v) return candidate;
  }
  return undefined;
}

function parseEnvFields(raw: unknown): ConnectionTargetEnvField[] | null | undefined {
  if (raw === null) return null;
  if (!Array.isArray(raw)) return undefined;
  const out: ConnectionTargetEnvField[] = [];
  for (const item of raw) {
    const rec = asRec(item);
    if (!rec) continue;
    const name = asStr(rec.name);
    if (!name) continue;
    out.push({
      name,
      required: typeof rec.required === 'boolean' ? rec.required : true,
      secret: typeof rec.secret === 'boolean' ? rec.secret : true,
      default: asStr(rec.default),
      ...(asOptStr(rec.prompt) !== undefined ? { prompt: asOptStr(rec.prompt) } : {}),
    });
  }
  return out;
}

function parseLaunch(raw: unknown): ConnectionTargetLaunch | null | undefined {
  if (raw === null) return null;
  const rec = asRec(raw);
  if (!rec) return undefined;
  const kind = inSet(rec.kind, LAUNCH_KINDS);
  const target = asStr(rec.target);
  if (!kind || !target) return undefined;
  const env = asStringArray(rec.env);
  const cwd = asOptStr(rec.cwd);
  return {
    kind,
    target,
    ...(env !== undefined ? { env } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

function parseScan(raw: unknown): CatalogScan | null | undefined {
  if (raw === null) return null;
  const rec = asRec(raw);
  if (!rec) return undefined;
  const status = inSet(rec.status, SCAN_STATUSES);
  const summary = asStr(rec.summary);
  if (!status) return undefined;
  return { status, summary };
}

function parseApproved(raw: unknown): CatalogApproved | null | undefined {
  if (raw === null) return null;
  const rec = asRec(raw);
  if (!rec) return undefined;
  return {
    force: rec.force === true,
    enable: rec.enable === true,
    ...(asOptStr(rec.ref) !== undefined ? { ref: asOptStr(rec.ref) } : {}),
  };
}

function parseServerErrors(raw: unknown): CatalogServerError[] | null | undefined {
  if (raw === null) return null;
  if (!Array.isArray(raw)) return undefined;
  const out: CatalogServerError[] = [];
  for (const item of raw) {
    const rec = asRec(item);
    if (!rec) continue;
    const name = asStr(rec.name);
    const error = asStr(rec.error);
    if (!name && !error) continue;
    out.push({ name, error });
  }
  return out;
}

/** 解析单个 `ConnectionOperationTarget` 结构体。 */
export function parseConnectionOperationTarget(raw: unknown): ConnectionOperationTarget | null {
  const rec = asRec(raw);
  if (!rec) return null;
  const name = asStr(rec.name);
  const kind = inSet(rec.kind, TARGET_KINDS);
  const action = inSet(rec.action, TARGET_ACTIONS);
  const state = inSet(rec.state, TARGET_STATES);
  if (!name || !kind || !action || !state) return null;

  const target: ConnectionOperationTarget = { name, kind, action, state };

  const resolved = asOptBool(rec.resolved);
  if (resolved !== undefined) target.resolved = resolved;
  const detail = asOptStr(rec.detail);
  if (detail !== undefined) target.detail = detail;
  const instructions = asOptStr(rec.instructions);
  if (instructions !== undefined) target.instructions = instructions;
  const discoveryError = asOptStr(rec.discovery_error);
  if (discoveryError !== undefined) target.discovery_error = discoveryError;
  const connectUrl = asOptStr(rec.connect_url);
  if (connectUrl !== undefined) target.connect_url = connectUrl;
  const connectionId = asOptStr(rec.connection_id);
  if (connectionId !== undefined) target.connection_id = connectionId;
  const alias = asOptStr(rec.alias);
  if (alias !== undefined) target.alias = alias;
  const attempt = asOptStr(rec.attempt);
  if (attempt !== undefined) target.attempt = attempt;
  const requiredEnv = parseEnvFields(rec.required_env);
  if (requiredEnv !== undefined) target.required_env = requiredEnv;
  const launch = parseLaunch(rec.launch);
  if (launch !== undefined) target.launch = launch;
  const tools = asStringArray(rec.tools);
  if (tools !== undefined) target.tools = tools;
  const hint = asOptStr(rec.hint);
  if (hint !== undefined) target.hint = hint;
  const display = asOptStr(rec.display);
  if (display !== undefined) target.display = display;
  const description = asOptStr(rec.description);
  if (description !== undefined) target.description = description;
  if (rec.tier === null) target.tier = null;
  else {
    const tier = inSet(rec.tier, CATALOG_TIERS);
    if (tier) target.tier = tier;
  }
  const platforms = asStringArray(rec.platforms);
  if (platforms !== undefined) target.platforms = platforms;
  const repo = asOptStr(rec.repo);
  if (repo !== undefined) target.repo = repo;
  const sha = asOptStr(rec.sha);
  if (sha !== undefined) target.sha = sha;
  const subdir = asOptStr(rec.subdir);
  if (subdir !== undefined) target.subdir = subdir;
  const scan = parseScan(rec.scan);
  if (scan !== undefined) target.scan = scan;
  const requiresHermes = asOptStr(rec.requires_hermes);
  if (requiresHermes !== undefined) target.requires_hermes = requiresHermes;
  const hasDesktopHalf = asOptBool(rec.has_desktop_half);
  if (hasDesktopHalf !== undefined) target.has_desktop_half = hasDesktopHalf;
  const targetProfile = asOptStr(rec.target_profile);
  if (targetProfile !== undefined) target.target_profile = targetProfile;
  if (rec.app_state === null) target.app_state = null;
  else {
    const appState = inSet(rec.app_state, APP_STATES);
    if (appState) target.app_state = appState;
  }
  const skill = asOptStr(rec.skill);
  if (skill !== undefined) target.skill = skill;
  if (rec.phase === null) target.phase = null;
  else {
    const phase = inSet(rec.phase, INSTALL_PHASES);
    if (phase) target.phase = phase;
  }
  const approved = parseApproved(rec.approved);
  if (approved !== undefined) target.approved = approved;
  const enabled = asOptBool(rec.enabled);
  if (enabled !== undefined) target.enabled = enabled;
  const missingEnv = asStringArray(rec.missing_env);
  if (missingEnv !== undefined) target.missing_env = missingEnv;
  const serverErrors = parseServerErrors(rec.server_errors);
  if (serverErrors !== undefined) target.server_errors = serverErrors;
  const alreadyInstalled = asOptBool(rec.already_installed);
  if (alreadyInstalled !== undefined) target.already_installed = alreadyInstalled;

  return target;
}

function parseTargets(raw: unknown): ConnectionOperationTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: ConnectionOperationTarget[] = [];
  for (const item of raw) {
    const parsed = parseConnectionOperationTarget(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseDisplay(raw: unknown): ConnectionDisplay | null | undefined {
  if (raw === null) return null;
  const rec = asRec(raw);
  if (!rec) return undefined;
  const suggested = asStringArray(rec.suggested);
  return suggested ? { suggested } : { suggested: [] };
}

function parseOwner(raw: unknown): SessionOwner | AccountOwner {
  const rec = asRec(raw);
  if (rec && rec.type === 'session') {
    const sessionId = asStr(rec.session_id);
    if (sessionId) return { type: 'session', session_id: sessionId };
  }
  return { type: 'account' };
}

/** 解析 `connection.request` 或 `session.resume.pending_connection` 载荷。 */
export function parseConnectionRequestPayload(raw: unknown): ConnectionRequestPayload | null {
  const rec = asRec(raw);
  if (!rec) return null;
  const opId = asStr(rec.op_id);
  if (!opId) return null;
  const toolCallId = asOptStr(rec.tool_call_id);
  const display = parseDisplay(rec.display);
  return {
    op_id: opId,
    seq: asNum(rec.seq, 0),
    deadline_at: asNum(rec.deadline_at, 0),
    timeout_seconds: asNum(rec.timeout_seconds, 300),
    targets: parseTargets(rec.targets),
    ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
    ...(display !== undefined ? { display } : {}),
  };
}

/** 解析 `connection.update` 载荷。 */
export function parseConnectionUpdatePayload(raw: unknown): ConnectionUpdatePayload | null {
  const rec = asRec(raw);
  if (!rec) return null;
  const opId = asStr(rec.op_id);
  if (!opId) return null;
  const out: ConnectionUpdatePayload = {
    op_id: opId,
    seq: asNum(rec.seq, 0),
    deadline_at: asNum(rec.deadline_at, 0),
    settled: rec.settled === true,
    targets: parseTargets(rec.targets),
    owner: parseOwner(rec.owner),
  };
  if (rec.settled_at === null) out.settled_at = null;
  else if (typeof rec.settled_at === 'number' && Number.isFinite(rec.settled_at)) {
    out.settled_at = rec.settled_at;
  }
  if (rec.settled_by === null) out.settled_by = null;
  else {
    const settledBy = inSet(rec.settled_by, SETTLE_REASONS);
    if (settledBy) out.settled_by = settledBy;
  }
  const target = asOptStr(rec.target);
  if (target !== undefined) out.target = target;
  if (rec.from === null) out.from = null;
  else {
    const from = inSet(rec.from, TARGET_STATES);
    if (from) out.from = from;
  }
  if (rec.to === null) out.to = null;
  else {
    const to = inSet(rec.to, TARGET_STATES);
    if (to) out.to = to;
  }
  if (rec.actor === null) out.actor = null;
  else {
    const actor = inSet(rec.actor, ACTORS);
    if (actor) out.actor = actor;
  }
  const detail = asOptStr(rec.detail);
  if (detail !== undefined) out.detail = detail;
  return out;
}
