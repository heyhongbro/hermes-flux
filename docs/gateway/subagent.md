# 子代理委派

> 本文件由 `npm run contract:doc` 从网关契约、探针结果与源码调用点自动生成，请勿手工编辑。
> 契约快照：e3cf16a3d983… · 同步于 2026-11-12T09:29:35.736Z

| 方法 | 入参（契约） | 出参（契约） | 调用点 | 真实探针 |
| --- | --- | --- | --- | --- |
| `session.transcript` | `profile` `session_id` `subagent_id` `cursor` `limit` `order` `inline_images` | `session_id` `rows` `next_cursor` `reset` `subagent_id` `available` `running` `child_session_id` | `packages/core/src/rpc/client.ts:1304`<br>`packages/core/src/subagent/subagentStore.ts:1202` | 跳过：实测网关 0.23.2 返回 -32601，客户端自动降级走 REST fetchSessionMessages 与 subagent.tail，离线探针显式跳过并由降级不变量单测守护 |
| `spawn_tree.list` | `profile` `session_id` `cross_session` `limit` | `entries` | `packages/core/src/rpc/client.ts:1316` | 跳过：历史衍生树索引依赖持久化磁盘记录，离线探针显式跳过，由非活跃会话 4001 隔离单测与不变量证明守护 |
| `spawn_tree.load` | `profile` `path` | `session_id` `started_at` `finished_at` `label` `subagents` | `packages/core/src/rpc/client.ts:1324` | 跳过：历史衍生树按路径读取依赖磁盘树文件，离线探针显式跳过，由标准化合并单测与形式化不变量守护 |
| `subagent.interrupt` | `session_id` `profile` `subagent_id` | `found` `subagent_id` | `packages/core/src/subagent/subagentStore.ts:922` | ✅ 0.22.5 |
| `subagent.list` | `session_id` `profile` | `subagents` `delegations` | `packages/core/src/subagent/subagentStore.ts:1003` | ✅ 0.22.5 |
| `subagent.steer` | `session_id` `profile` `subagent_id` `text` | `status` `subagent_id` `text` | `packages/core/src/subagent/subagentStore.ts:850` | ✅ 0.22.5 |
| `subagent.tail` | `session_id` `profile` `subagent_id` | `subagent_id` `available` `text` `truncated` | `packages/core/src/subagent/subagentStore.ts:1323` | ✅ 0.22.5 |

## 明细

### `session.transcript`

- 参数类型：`StoredTranscriptParams`
- 结果类型：`StoredTranscriptResult`
- 真实探针：跳过 —— 实测网关 0.23.2 返回 -32601，客户端自动降级走 REST fetchSessionMessages 与 subagent.tail，离线探针显式跳过并由降级不变量单测守护
- 调用点：
  - `packages/core/src/rpc/client.ts:1304`
  - `packages/core/src/subagent/subagentStore.ts:1202`

### `spawn_tree.list`

- 参数类型：`SpawnTreeListParams`
- 结果类型：`SpawnTreeListResult`
- 真实探针：跳过 —— 历史衍生树索引依赖持久化磁盘记录，离线探针显式跳过，由非活跃会话 4001 隔离单测与不变量证明守护
- 调用点：
  - `packages/core/src/rpc/client.ts:1316`

### `spawn_tree.load`

- 参数类型：`SpawnTreeLoadParams`
- 结果类型：`SpawnTreeLoadResult`
- 真实探针：跳过 —— 历史衍生树按路径读取依赖磁盘树文件，离线探针显式跳过，由标准化合并单测与形式化不变量守护
- 调用点：
  - `packages/core/src/rpc/client.ts:1324`

### `subagent.interrupt`

- 参数类型：`SubagentIdParams`
- 结果类型：`SubagentInterruptResult`
- 真实探针：已通过（网关 0.22.5，录制于 2026-11-01T01:59:35.303Z）
- 本次探针走的是守卫分支：错误码 `4001`（属于正确行为，不是失败）
- 调用点：
  - `packages/core/src/subagent/subagentStore.ts:922`

### `subagent.list`

- 参数类型：`SessionParams`
- 结果类型：`SubagentListResult`
- 真实探针：已通过（网关 0.22.5，录制于 2026-11-01T01:59:35.303Z）
- 本次探针走的是守卫分支：错误码 `4001`（属于正确行为，不是失败）
- 调用点：
  - `packages/core/src/subagent/subagentStore.ts:1003`

### `subagent.steer`

- 参数类型：`SubagentSteerParams`
- 结果类型：`SubagentSteerResult`
- 真实探针：已通过（网关 0.22.5，录制于 2026-11-01T01:59:35.303Z）
- 本次探针走的是守卫分支：错误码 `4001`（属于正确行为，不是失败）
- 调用点：
  - `packages/core/src/subagent/subagentStore.ts:850`

### `subagent.tail`

- 参数类型：`SubagentIdParams`
- 结果类型：`SubagentTailResult`
- 真实探针：已通过（网关 0.22.5，录制于 2026-11-01T01:59:35.303Z）
- 本次探针走的是守卫分支：错误码 `4001`（属于正确行为，不是失败）
- 调用点：
  - `packages/core/src/subagent/subagentStore.ts:1323`

