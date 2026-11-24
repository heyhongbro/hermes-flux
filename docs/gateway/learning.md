# 记忆与学习星图

> 本文件由 `npm run contract:doc` 从网关契约、探针结果与源码调用点自动生成，请勿手工编辑。
> 契约快照：e3cf16a3d983… · 同步于 2026-11-12T09:29:35.736Z

| 方法 | 入参（契约） | 出参（契约） | 调用点 | 真实探针 |
| --- | --- | --- | --- | --- |
| `learning.delete` | `id` | `ok` `message` | `packages/desktop/src/renderer/services/learningService.ts:478`<br>`packages/desktop/src/renderer/services/learningService.ts:484` | 跳过：删除学习记忆或技能属于破坏性写操作，禁止在真实网关执行，由学习服务单测与契约白名单守护 |
| `learning.detail` | `id` | `ok` `message` `kind` `id` `label` `content` | `packages/desktop/src/renderer/services/learningService.ts:346`<br>`packages/desktop/src/renderer/services/learningService.ts:354` | ✅ 0.22.5 |
| `learning.edit` | `id` `content` | `ok` `message` | `packages/desktop/src/renderer/services/learningService.ts:428`<br>`packages/desktop/src/renderer/services/learningService.ts:434` | 跳过：修改学习记忆内容属于写操作，禁止在真实网关覆盖用户既有记忆，由学习服务单测与契约白名单守护 |
| `learning.frames` | `cols` `rows` `frames` | `frames` `legend` `categories` `buckets` `summary` `axis` `count` `cols` `rows` | `packages/desktop/src/renderer/services/learningService.ts:233`<br>`packages/desktop/src/renderer/services/learningService.ts:244` | ✅ 0.22.5 |

## 明细

### `learning.delete`

- 参数类型：`LearningNodeParams`
- 结果类型：`LearningMutationResult`
- 真实探针：跳过 —— 删除学习记忆或技能属于破坏性写操作，禁止在真实网关执行，由学习服务单测与契约白名单守护
- 调用点：
  - `packages/desktop/src/renderer/services/learningService.ts:478`
  - `packages/desktop/src/renderer/services/learningService.ts:484`

### `learning.detail`

- 参数类型：`LearningNodeParams`
- 结果类型：`LearningDetailResult`
- 真实探针：已通过（网关 0.22.5，录制于 2026-11-01T01:59:35.303Z）
- 调用点：
  - `packages/desktop/src/renderer/services/learningService.ts:346`
  - `packages/desktop/src/renderer/services/learningService.ts:354`

### `learning.edit`

- 参数类型：`LearningEditParams`
- 结果类型：`LearningMutationResult`
- 真实探针：跳过 —— 修改学习记忆内容属于写操作，禁止在真实网关覆盖用户既有记忆，由学习服务单测与契约白名单守护
- 调用点：
  - `packages/desktop/src/renderer/services/learningService.ts:428`
  - `packages/desktop/src/renderer/services/learningService.ts:434`

### `learning.frames`

- 参数类型：`LearningFramesParams`
- 结果类型：`LearningFramesResult`
- 真实探针：已通过（网关 0.22.5，录制于 2026-11-01T01:59:35.303Z）
- 调用点：
  - `packages/desktop/src/renderer/services/learningService.ts:233`
  - `packages/desktop/src/renderer/services/learningService.ts:244`

