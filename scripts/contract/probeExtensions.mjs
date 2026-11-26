/**
 * 扩展与模型探针模块拆分子集（保持 probe.mjs 在存量行数上限内）。
 */

export function buildExtensionsProbeModule({ profile, ctx, stamp }) {
  return {
    module: 'extensions',
    // 设置中心的「扩展」与「BOT 能力」：读取与增删测 MCP、技能清单。
    // model.save_key / model.disconnect 是破坏性写操作，绝不进探针（见下方 skip 说明）。
    teardown: async () => {
      if (!ctx.probeMcpName) return;
      try {
        await ctx.call('mcp.servers.remove', { profile, name: ctx.probeMcpName });
      } catch (err) {
        console.log(`  · 清理探针 MCP 失败（可忽略）: ${err.code || err.message}`);
      }
    },
    cases: [
      { method: 'mcp.servers.status', params: () => ({ profile }) },
      { method: 'mcp.catalog', params: () => ({ profile }) },
      {
        method: 'mcp.servers.add',
        params: () => {
          ctx.probeMcpName = `flux-probe-mcp-${stamp()}`;
          return {
            profile,
            name: ctx.probeMcpName,
            config: { command: 'echo', args: ['flux-probe'] },
          };
        },
      },
      {
        method: 'mcp.servers.test',
        params: () => ({ profile, name: ctx.probeMcpName || 'flux-probe-none' }),
        allowCodes: [4001, 4007],
      },
      {
        method: 'mcp.servers.remove',
        params: () => ({ profile, name: ctx.probeMcpName || 'flux-probe-none' }),
        after: () => { ctx.probeMcpName = ''; },
        allowCodes: [4001, 4007],
        destructive: true,
      },
      { method: 'skills.manage', params: () => ({ profile, action: 'list' }) },
      {
        method: 'skills.reload',
        // 热重载会重新扫描磁盘技能目录，属幂等只读重建；输出里含本机绝对路径，由 sanitize 脱敏
        params: () => ({ profile }),
      },
      {
        method: 'model.save_key',
        // 探针会用假密钥覆盖用户真实凭据，且网关无对应"还原"接口——永久禁止真实执行。
        params: () => ({ slug: ctx.probeBot }),
        skip: () => '写操作会覆盖用户真实 API Key 且无法还原，仅由 CDP 场景在无凭据沙箱手工验证',
      },
      {
        method: 'model.disconnect',
        params: () => ({ slug: ctx.probeBot }),
        skip: () => '断开提供商会破坏用户已配置的凭据，禁止在真实网关上执行',
      },
      {
        method: 'reload.env',
        params: () => ({}),
        // 热重载 .env 会立刻改变运行中的凭据状态；用假密钥探针的副作用不可控，永久跳过
        skip: () => '环境热重载会改变运行中的凭据状态，须与 model.save_key 成对执行，禁止单独探针',
      },
    ],
  };
}

export function buildInteractiveProbeModule({ profile, ctx }) {
  return {
    module: 'interactive',
    cases: [
      {
        method: 'client.capabilities',
        params: () => ({ server_requests: true, desktop_local: false }),
        skip: () => '握手能力协商依赖在线支持 hermes-gateway-v1 的会话通道；由 negotiateClientCapabilities 降级单测与契约表守护',
      },
      {
        method: 'approval.pending',
        params: () => ({ session_id: ctx.sessionId, profile }),
        skip: () => '待审批队列探测仅在活跃会话阻塞审批时返回条目；离线探针跳过，由协调器与服务单测守护',
      },
      {
        method: 'approval.received',
        params: () => ({ session_id: ctx.sessionId, profile, request_id: 'probe' }),
        skip: () => '审批送达回执依赖在途阻塞的审批 request_id；离线探针显式跳过',
      },
      {
        method: 'approval.respond',
        params: () => ({ session_id: ctx.sessionId, profile, choice: 'once' }),
        skip: () => '审批答复需真实挂起中的审批请求；由 replyRouter 形式化定理与单测守护',
      },
      {
        method: 'clarify.lock',
        params: () => ({ request_id: 'probe', question_id: 'q1', answer: 'ok', profile }),
        skip: () => '单题锁定依赖活跃 clarify 请求 id；离线探针显式跳过，由 InteractivePromptService 单测守护',
      },
      {
        method: 'clarify.respond',
        params: () => ({ session_id: ctx.sessionId, execution_generation: 0, prompt_id: 'probe', answer: 'ok' }),
        skip: () => 'Canonical clarify 应答需在途挂起 prompt_id；由 replyRouter 契约参数单测守护',
      },
      {
        method: 'request.answer',
        params: () => ({ id: 'probe', result: { outcome: 'cancelled' }, profile }),
        skip: () => '断线补答 WS 反向请求依赖服务端在途挂起条目；由 replyRouter 形式化不变量守护',
      },
      {
        method: 'connectors.operation.wake',
        params: () => ({ profile, op_id: 'probe' }),
        skip: () => '连接操作唤醒依赖真实 OAuth/Install 进行中 op_id；离线探针显式跳过',
      },
      {
        method: 'reload.mcp',
        params: () => ({ confirm: true }),
        skip: () => 'MCP 热重载会影响在线网关活跃会话工具表；离线探针显式跳过，由 mcpOAuthService 单测（含严禁传 profile 与 confirm_required 闭环）守护',
      },
      {
        method: 'mcp.servers.oauth.start',
        params: () => ({ profile, name: 'probe-mcp' }),
        skip: () => 'MCP OAuth 发起需真实外部授权端点且禁传 client_redirect_uri；离线探针显式跳过，由 mcpOAuthService 与契约表守护',
      },
      {
        method: 'mcp.servers.oauth.poll',
        params: () => ({ profile, name: 'probe-mcp', session_id: 'probe' }),
        skip: () => 'MCP OAuth 轮询依赖在途 oauth.start 返回的 session_id；离线探针显式跳过，由 McpOAuthInlinePanel 与服务单测守护',
      },
      {
        method: 'mcp.servers.oauth.cancel',
        params: () => ({ profile, name: 'probe-mcp', session_id: 'probe' }),
        skip: () => 'MCP OAuth 取消依赖在途授权 session_id；离线探针显式跳过，由服务与内联面板清理单测守护',
      },
    ],
  };
}
