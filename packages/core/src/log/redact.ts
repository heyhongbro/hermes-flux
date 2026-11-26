/**
 * 日志敏感字段脱敏（单一实现）。
 *
 * 【设计意图 (Why)】
 *   JSON-RPC 的调试日志会原样打印 params。`model.save_key` 的 `api_key`、
 *   登录请求的 `password`、OAuth 回调的 `token` 都在其中——一旦落进
 *   `userData/logs/flux-*.log`，就等同于把明文凭据写到了磁盘上，
 *   而且这类日志经常会被用户随手贴进 issue。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 初版 `log.debug('rpc call', { params })` 直接序列化原始参数，
 *      设置页保存 API Key 时会把它完整写进日志；类型检查、门禁、UI 测试都不会变红。
 *   2. 键名匹配曾只认 snake_case，`accessToken` / `refreshToken` 全部漏网。
 *      因此判定前先归一化（去分隔符 + 小写），再按词尾匹配。
 *   3. `mcp.servers.set_api_key` 的凭据字段叫 `value`，单看键名无法判定。
 *      提供 `extraKeys` 由调用方按 method 补充，禁止在通用规则里猜。
 *
 * 【约束与规则 (Rules)】
 *   - 纯函数，零依赖，不得修改入参；
 *   - 只按 **键名** 判定敏感（大小写与分隔符不敏感），值一律替换为固定掩码；
 *   - 深度上限 8，循环引用返回 '[Circular]'，避免日志本身把进程拖死；
 *   - 数组按下标递归，不把整个数组当成敏感值。
 */

const MASK = '[REDACTED]';

/**
 * 词尾匹配：apiKey / api_key / x-api-key / password / client_secret / accessToken /
 * refreshToken / authorization / cookie。
 * 不匹配 key_env（结尾是 env）、token_count（结尾是 count）、tokens（复数不视为秘密字段）。
 */
const SENSITIVE_SUFFIX = /(?:apikey|password|passwd|passphrase|privatekey|secret|token|authorization|cookie)$/;

const INTERACTIVE_VALUE_SECRET_METHODS: ReadonlySet<string> = new Set([
  'mcp.servers.set_api_key',
  'secret',
  'sudo',
  'display.install.sudo',
  'vault.code',
  'vault.unlock_prompt',
  'vault.save_login',
]);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_SUFFIX.test(key.replace(/[_-]/g, '').toLowerCase());
}

export interface RedactOptions {
  /** 额外按键名脱敏的字段（例如 mcp.servers.set_api_key 的 `value`）。 */
  extraKeys?: readonly string[];
}

export function redactSensitive(value: unknown, options: RedactOptions = {}): unknown {
  const extra = new Set((options.extraKeys ?? []).map((key) => key.toLowerCase()));
  return walk(value, 0, new WeakSet<object>(), extra);
}

/**
 * 将对象直接子节点全部脱敏（用于任意 env var key 映射，如 connection.respond 的 target.env）。
 * 纯函数，不修改入参。
 */
function maskEnvMap(envValue: unknown): unknown {
  if (envValue === null || envValue === undefined) return envValue;
  if (typeof envValue !== 'object') return MASK;
  if (Array.isArray(envValue)) {
    return envValue.map((item) => walk(item, 0, new WeakSet<object>(), new Set(['value'])));
  }
  const masked: Record<string, unknown> = {};
  for (const key of Object.keys(envValue as Record<string, unknown>)) {
    masked[key] = MASK;
  }
  return masked;
}

/**
 * 脱敏交互式请求参数、服务下发参数（如 preview.act.vault）与反向请求响应（secret/sudo/vault/request.answer/connection.respond）。
 *
 * 【设计意图 (Why)】
 *   用户填写的环境变量密钥、sudo 口令、2FA 验证码、Vault 登录凭据与 connection.respond 里的
 *   任意环境变量名，绝不能通过调试日志或契约错误日志落入磁盘 `flux-*.log`。
 *
 * 【规则 (Rules)】
 *   - 绝不修改入参；
 *   - 不得把通用词尾 `value` / `code` 加进全局 `SENSITIVE_SUFFIX`，仅按 method 上下文精确脱敏；
 *   - `connection.respond` 与 `mcp.servers.add` 中名为 `env` 的字典内部全部键值必须无条件掩码。
 */
export function redactInteractivePayload(method: string, payload: unknown): unknown {
  if (payload === null || payload === undefined || typeof payload !== 'object') {
    return INTERACTIVE_VALUE_SECRET_METHODS.has(method) && typeof payload === 'string' && payload.length > 0
      ? MASK
      : payload;
  }

  if (method === 'request.answer') {
    return redactSensitive(payload, { extraKeys: ['result', 'value'] });
  }

  if (method === 'preview.act') {
    return redactSensitive(payload, { extraKeys: ['vault'] });
  }

  if (method === 'connection.respond' || method === 'mcp.servers.add') {
    const base = redactSensitive(payload, { extraKeys: ['value', 'bearer_token'] });
    return maskNestedEnvMaps(base, 0);
  }

  if (INTERACTIVE_VALUE_SECRET_METHODS.has(method)) {
    return redactSensitive(payload, { extraKeys: ['value', 'identifier'] });
  }

  return redactSensitive(payload);
}

function maskNestedEnvMaps(node: unknown, depth: number): unknown {
  if (node === null || node === undefined || typeof node !== 'object' || depth >= 8) {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => maskNestedEnvMaps(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k.toLowerCase() === 'env') {
      out[k] = maskEnvMap(v);
    } else {
      out[k] = maskNestedEnvMaps(v, depth + 1);
    }
  }
  return out;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>, extra: Set<string>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (depth >= 8) return '[Truncated]';

  const record = value as object;
  if (seen.has(record)) return '[Circular]';
  seen.add(record);

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, depth + 1, seen, extra));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const sensitive = extra.has(key.toLowerCase()) || isSensitiveKey(key);
    out[key] = sensitive ? MASK : walk(item, depth + 1, seen, extra);
  }
  return out;
}
