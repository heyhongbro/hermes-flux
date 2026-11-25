# 不变量映射表（Invariant Map）

> **本文件由 `scripts/verify/invariant-map.mjs --render` 生成，禁止手工修改。**
> 单一真值源是 [`invariants.json`](invariants.json)；改内容请改 JSON 再重新生成。
> 设计说明见 [`testing-strategy.md`](testing-strategy.md) 第五章。

## 为什么用 JSON 而不是手写表格

旧版 Markdown 表格有三个结构性缺陷，导致它无法被机器校验：

1. **编号撞号**：两个不同文件都自称「定理 30~34」，同号异义让任何比对失效；
2. **区间写法**：`INV-12~16` 在文本上是一个 token，做不了差集；
3. **7 处「同上」**：多条不变量共用一个路径，无法判断某一条是否真被守护。

JSON 版本强制每条给出唯一 `id`、被测源码 `source`、`symbol` 与单一 `test` 路径，
于是「新增逻辑 − 已登记项」这个差集才在数学上可计算。

## 校验规则

| 规则 | 判定 |
|---|---|
| id 唯一且匹配 `INV-<AREA>-<NN>` | 违者 FAIL |
| `test` 为单一真实路径 | 违者 FAIL |
| `test` 文件内含 `fc.assert` | 违者 FAIL |
| `source` 为真实源码路径 | 违者 FAIL |
| `source`+`symbol` 组合唯一 | 违者 FAIL |

## 总览（76 条，覆盖 18 个领域）

### ATTACH（5 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-ATTACH-01` | 迟滞响应不串台（令牌不匹配的 settle 不改变字段） | `packages/core/src/models/providerAttachFlow.ts` → `reduceAttachFlow#settle` | `provider-attach-flow-formal.test.mjs` | 旧的开启结果写到新目标行上 |
| `INV-ATTACH-02` | 提交中不可重入（重复 submit 不得覆盖在途令牌与草稿） | `packages/core/src/models/providerAttachFlow.ts` → `reduceAttachFlow#submit` | `provider-attach-flow-formal.test.mjs` | 连续点击覆盖在途令牌或草稿，导致旧响应串台或重发写坏配置 |
| `INV-ATTACH-03` | 失败不丢用户输入 | `packages/core/src/models/providerAttachFlow.ts` → `reduceAttachFlow#needs-key-failure` | `provider-attach-flow-formal.test.mjs` | 失败后密钥草稿被清空，用户要重新输入 |
| `INV-ATTACH-04` | 取消恒生效且 busy 只由 submitting 决定 | `packages/core/src/models/providerAttachFlow.ts` → `reduceAttachFlow#cancel` | `provider-attach-flow-formal.test.mjs` | 取消失效；或不该忙的时候锁死界面 |
| `INV-ATTACH-05` | 目录收敛只挂仍为 absent 的同一格子 | `packages/core/src/models/providerAttachFlow.ts` → `reconcileAttachFlow` | `provider-attach-flow-formal.test.mjs` | 用户刚打开的补密钥条瞬间消失 |

### BOT（3 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-BOT-01` | 领域绝对隔离（普通会话不得污染 Bot 卡片） | `packages/core/src/agent/agentPresence.ts` → `syncActiveSessionToBot` | `bot-activity-formal.test.mjs` | 普通会话的活动覆盖专职 Bot 主工位卡片 |
| `INV-BOT-02` | 时间戳归一化完备性 | `packages/core/src/agent/agentPresence.ts` → `normalizeTimestamp` | `bot-activity-formal.test.mjs` | 秒级/毫秒级/ISO 混用导致排序错乱 |
| `INV-BOT-03` | 时间全序非递增单调性 | `packages/core/src/agent/agentPresence.ts` → `applyBotActivity` | `bot-activity-formal.test.mjs` | Bot 列表顺序抖动 |

### CACHE（8 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-CACHE-01` | 围栏不误删 | `packages/core/src/cache/cacheMerge.ts` → `mergeRemoteWindow#fence` | `cache-fence-formal.test.mjs` | 拉取在途写入被远端快照误删，用户刚发的消息消失 |
| `INV-CACHE-02` | 上限不越界 | `packages/core/src/cache/cacheMerge.ts` → `evictToCap` | `cache-fence-formal.test.mjs` | 通道行数超过 messageCap，内存无界增长 |
| `INV-CACHE-03` | 截断有界 | `packages/core/src/cache/cacheMerge.ts` → `applyTruncation` | `cache-fence-formal.test.mjs` | 截断后残留 orderKey > target 的幽灵行 |
| `INV-CACHE-04` | 窗口合并幂等 | `packages/core/src/cache/cacheMerge.ts` → `mergeRemoteWindow#idempotent` | `cache-fence-formal.test.mjs` | 重复应用同一远端快照产生重复行 |
| `INV-CACHE-05` | pending 不可删 | `packages/core/src/cache/cacheMerge.ts` → `mergeRemoteWindow#pending-survives` | `cache-fence-formal.test.mjs` | 未确认的消息在窗口合并中被清掉 |
| `INV-CACHE-06` | 在途展示序不撞号且强保序 | `packages/core/src/cache/cacheMerge.ts` → `mergeRemoteWindow#displaySeq` | `cache-fence-formal.test.mjs` | 拉取在途期间生成的 displaySeq 与远端冲突，界面错序 |
| `INV-CACHE-07` | appendRows 同键展示序不漂移 | `packages/core/src/cache/cacheMerge.ts` → `appendRows` | `cache-fence-formal.test.mjs` | 重复追加同一批消息时 displaySeq 重新计算，行跳动 |
| `INV-CACHE-08` | 更早分片展示序精确切片 | `packages/core/src/cache/cacheMerge.ts` → `sortByDisplayAsc` | `cache-fence-formal.test.mjs` | 按 orderKey 翻页取 displaySeq 不连续，历史消息顺序错乱 |

### CONN（3 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-CONN-01` | 认证失效与手动断连在连接相位归约中的绝对支配律（unconfigured > manual/auth-offline > transient reconnect） | `packages/core/src/rpc/connectionPhase.ts` → `resolveConnectionPhase#auth-dominance` | `connection-phase-formal.test.mjs` | 401 密码失效或用户主动断开后界面仍虚假显示重连胶囊并死循环撞墙重试 |
| `INV-CONN-02` | 7态连接相位全序覆盖与 sync 优先级单调律 | `packages/core/src/rpc/connectionPhase.ts` → `resolveConnectionPhase` | `connection-phase-formal.test.mjs` | HANDSHAKING 或 RECONNECTING 被错误归约为已连接或完全断网，导致标题栏与输入舱状态撕裂 |
| `INV-CONN-03` | 冷启动退避重试时延有界且单调非降 | `packages/core/src/rpc/connectionPhase.ts` → `computeColdStartRetryDelayMs` | `connection-phase-formal.test.mjs` | 冷启动网络未就绪时退避越界卡死或零延迟风暴重试打爆电池与网关 |

### FS（6 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-FS-01` | 文件树目录优先与码点确定性全序幂等 | `packages/core/src/fs/fileTreeService.ts` → `sortFileTreeNodes` | `file-tree-formal.test.mjs` | 文件树受系统 locale 影响乱序或目录/文件混排，每次刷新条目上下跳动 |
| `INV-FS-02` | 扁平路径建树守恒、去重收敛与同构幂等 | `packages/core/src/fs/fileTreeService.ts` → `buildTreeFromFlatPaths` | `file-tree-formal.test.mjs` | 补全结果或会话文件树出现重复目录节点或斜杠分裂 |
| `INV-FS-03` | 子目录懒加载合并保持非目标子树完整与幂等 | `packages/core/src/fs/fileTreeService.ts` → `mergeDirectoryChildren` | `file-tree-formal.test.mjs` | 展开一个子目录把用户已展开的其他目录重置或清空 |
| `INV-FS-04` | 文件树过滤完备性（无空祖先残留且命中叶/祖先路径可回溯） | `packages/core/src/fs/fileTreeService.ts` → `filterFileTree` | `file-tree-formal.test.mjs` | 过滤关键字后留下大量空文件夹或漏掉深层匹配文件 |
| `INV-FS-05` | 二进制文件与超大文件预览阻断单调性（二进制恒优先于体积上限拦截且绝不误杀图片） | `packages/core/src/fs/fileService.ts` → `evaluateFilePreviewGuard` | `file-tree-formal.test.mjs` | .exe 等二进制文件被当作文本渲染成乱码，或超大文件直接撑爆前端 DOM 表格 |
| `INV-FS-06` | 项目目录 picker 单段命名清洗、POSIX shell 安全引用与锁定根目录不可重命名守卫 | `packages/core/src/fs/directoryPickerService.ts` → `validateDirectoryName` | `file-tree-formal.test.mjs` | 目录创建或重命名遭 `..`/控制字符/`.env` 注入越界，或误改 `/`/locked_root 破坏工作区 |

### LEARN（2 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-LEARN-01` | 学习星图去重清洗、注释剥离与中心辐射视窗几何有界完备 | `packages/core/src/learning/learningConstellation.ts` → `buildConstellationGraph` | `learning-constellation-formal.test.mjs` | 记忆节点标题残存半截 HTML 注释或全连通边爆表造成移动端星图堆叠不可点 |
| `INV-LEARN-02` | 全量认知星图确定性无重叠布局（全节点无分页落图、绝对碰撞分离与技能关联统计有界一致） | `packages/core/src/learning/constellationLayout.ts` → `layoutFullConstellationGraph` | `learning-constellation-formal.test.mjs` | 星图节点相互遮挡不可点、跨 Bot 刷新顺序偏移抖动、或技能列表计数与星图不一致 |

### MSG（1 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-MSG-01` | 用户消息附件清单与多模态分片往返解析无损收敛且去重 | `packages/core/src/session/messageAttachments.ts` → `extractMessageAttachments` | `message-attachments-formal.test.mjs` | 发送图片或文件后用户气泡不显示附件缩略图与文件名，或仅发附件无正文时被静默丢弃 |

### ORG（7 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-ORG-01` | Bot 终身主工位（Forever Chat）物理免疫（hidden/isForeverChat 永不归档、永不移入容器） | `packages/core/src/organization/reducer.ts` → `resolveEntityContainer#forever-chat-immunity` | `conversation-org-formal.test.mjs` | Bot 终身主工位被错误标记完成或拖入项目/自定义文件夹，破坏主工位物理隔离 |
| `INV-ORG-02` | 单归属容器优先级裁决收敛（__none__ 哨兵阻断 cwd 自动匹配，显式归属优先于路径匹配） | `packages/core/src/organization/reducer.ts` → `resolveEntityContainer#precedence` | `conversation-org-formal.test.mjs` | 用户显式移回未分类后刷新又被 cwd 重新吸回项目，或跨自定义文件夹发生多归属分裂 |
| `INV-ORG-03` | 项目路径最长前缀匹配与严格目录边界防溢出（排除已归档项目） | `packages/core/src/organization/pathMatch.ts` → `matchProjectByCwd#longest-prefix` | `conversation-org-formal.test.mjs` | /work/app-v2 误匹配 /work/app、父项目抢占子项目或已归档项目继续吸纳新会话 |
| `INV-ORG-04` | 删除自定义文件夹非破坏性守恒（仅清除目标文件夹映射，100% 保留实体与他目录归属） | `packages/core/src/organization/reducer.ts` → `deleteFolderInMeta#non-destructive` | `conversation-org-formal.test.mjs` | 删除自定义文件夹导致内部普通会话或群聊被误删，或残留悬空指向 |
| `INV-ORG-05` | 群聊完成态往返收敛与强幂等 | `packages/core/src/organization/reducer.ts` → `setRoomDoneInMeta#round-trip` | `conversation-org-formal.test.mjs` | 标记群聊已完成再恢复进行中后误清他群状态，或重复点击写入不一致 |
| `INV-ORG-06` | ui_meta 三路 CAS 合并双端并发保序且零悬空引用 | `packages/core/src/organization/reducer.ts` → `mergeFoldersMetaForCas#disjoint-preserve` | `conversation-org-formal.test.mjs` | 多端并发新建文件夹或移动会话时 CAS 重试互相覆盖，或产生指向已删目录的幽灵键 |
| `INV-ORG-07` | 僵尸归属键清理完备性与二次清理强幂等 | `packages/core/src/organization/reducer.ts` → `pruneStaleOrgKeys#idempotent` | `conversation-org-formal.test.mjs` | 已删会话或已解散群聊长期残留幽灵映射，或垃圾回收误删有效/未加载项 |

### PAGE（2 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-PAGE-01` | 分页游标单调不减且不越界 | `packages/core/src/session/olderBatchMerge.ts` → `planOlderPagination` | `older-pagination-formal.test.mjs` | 翻页重复加载或跳过消息 |
| `INV-PAGE-02` | 父段不丢失且二次合并强幂等 | `packages/core/src/session/olderBatchMerge.ts` → `planOlderBatchPrependMergeDetailed` | `older-pagination-formal.test.mjs` | 向上翻页后父会话血缘行丢失；重复合并产生重复键 |

### RAIL（5 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-RAIL-01` | 三权分立互斥（Bot/Group/Session 正交隔离） | `packages/ui/src/components-react/leftRailModel.ts` → `buildLeftRailModel#orthogonal` | `unified-session-list-formal.test.mjs` | 左轨同时出现同一会话的两种身份 |
| `INV-RAIL-02` | 普通会话时间全序降序单调 | `packages/ui/src/components-react/leftRailModel.ts` → `buildLeftRailModel#ordering` | `unified-session-list-formal.test.mjs` | 左轨时间倒序错乱 |
| `INV-RAIL-03` | 墓碑强制驱逐不可侵犯 | `packages/ui/src/components-react/leftRailModel.ts` → `buildLeftRailModel#tombstone` | `unified-session-list-formal.test.mjs` | 已归档项复活 |
| `INV-RAIL-04` | 多源编排强幂等 | `packages/ui/src/components-react/leftRailModel.ts` → `buildLeftRailModel#idempotent` | `unified-session-list-formal.test.mjs` | 二次编排输出不恒等，界面每次刷新都变化 |
| `INV-RAIL-05` | 全失败防御不可致空 | `packages/ui/src/components-react/leftRailModel.ts` → `buildLeftRailModel#failure-not-empty` | `unified-session-list-formal.test.mjs` | 网络失败时本地已有会话被抹除 |

### SESSION（6 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-SESSION-01` | 会话/代际变更必须丢弃写入 | `packages/core/src/session/guardedRun.ts` → `runGuarded` | `run-guard-formal.test.mjs` | 切换会话后旧写入污染新会话内容 |
| `INV-SESSION-02` | 反复删除收敛且失败保留已成功剪枝 | `packages/core/src/session/SessionLifecycleService.ts` → `deleteSessions` | `session-lifecycle-formal.test.mjs` | 重复删除产生不同结果；部分失败时已成功的清理被回滚 |
| `INV-SESSION-03` | 陈旧全量快照不得复活已删会话 | `packages/core/src/session/SessionLifecycleService.ts` → `deleteSessions#tombstone` | `session-lifecycle-formal.test.mjs` | 慢响应返回的旧快照把已删会话挂回界面（防复活墓碑失效） |
| `INV-SESSION-04` | 跨 Profile 去重强幂等 | `packages/core/src/session/sessionMerge.ts` → `dedupeSessions#idempotent` | `session-merge-formal.test.mjs` | 合并产生重复消息 |
| `INV-SESSION-05` | 失败不可致空（Failure Is Not Empty） | `packages/core/src/session/sessionMerge.ts` → `mergeSessions` | `session-merge-formal.test.mjs` | 网络失败时清空界面，用户看到空列表而不是旧数据 |
| `INV-SESSION-06` | 去重结果时间全序降序单调 | `packages/core/src/session/sessionMerge.ts` → `dedupeSessions#ordering` | `session-merge-formal.test.mjs` | 会话列表时间倒序错乱 |

### STAGE（4 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-STAGE-01` | 回滚乐观截断往返恒等 | `packages/desktop/src/renderer/rollbackTransaction.ts` → `applyOptimisticCut` | `interactive-stage-formal.test.mjs` | 截断后内容错乱，回滚无法还原原状 |
| `INV-STAGE-02` | 截断锚点排他性与临时 id 零逃逸 | `packages/desktop/src/renderer/rollbackTransaction.ts` → `resolveRollbackTarget` | `interactive-stage-formal.test.mjs` | 回滚锚点错位；客户端临时 id 泄漏到服务端触发 4018 |
| `INV-STAGE-03` | 流式工具状态机收敛 | `packages/core/src/session/eventReducer.ts` → `reduceEvent` | `interactive-stage-formal.test.mjs` | 工具卡状态不收敛，幽灵工具残留 |
| `INV-STAGE-04` | @ 路由排他性与 cleanText 不残留 token | `packages/desktop/src/renderer/mentionToken.ts` → `parseMentionToken` | `interactive-stage-formal.test.mjs` | 通道类型错配；正文里残留 @token 原文 |

### STREAM（6 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-STREAM-01` | 流式直写锚点存在性：流式末条助手行恒有 #msg-content-*，非流式全空行恒不占位 | `packages/ui/src/components-react/conversation/MessageRow.tsx` → `MessageRow#streamingAnchor` | `streaming-anchor-formal.test.mjs` | 流式正文一次性铺满：空助手行被判空抹掉锚点，tokenStreamWriter 直写全程空转 |
| `INV-STREAM-02` | 多会话流注册表严格保持 storedSessionId <-> messageId 1:1 双射 | `packages/core/src/session/liveStreamSync.ts` → `LiveStreamRegistry` | `live-stream-sync-formal.test.mjs` | 多端或并发会话流覆盖/迁移后出现双绑与跨会话 token 串台污染 |
| `INV-STREAM-03` | LiveStreamRegistry.acceptDelta 按 (turnId, segment, offset) 去重与幂等 | `packages/core/src/session/liveStreamSync.ts` → `LiveStreamRegistry.acceptDelta` | `live-stream-sync-formal.test.mjs` | 重连/对账或双端并行帧重复送达导致流式文本重复拼接 |
| `INV-STREAM-04` | reconcileInflightText 仅向前对账，绝不回退已领先的本地流 | `packages/core/src/session/liveStreamSync.ts` → `LiveStreamRegistry.reconcileInflightText` | `live-stream-sync-formal.test.mjs` | 较慢的 inflight.assistant 快照覆盖已超前的流式正文，引发界面文字倒流 |
| `INV-STREAM-05` | 远端用户气泡插入规划幂等且精准定位在流式助手行前 | `packages/core/src/session/liveStreamSync.ts` → `planRemoteUserPromptInsert` | `live-stream-sync-formal.test.mjs` | 多端同步用户提问时在观察端重复生成多条相同用户气泡 |
| `INV-STREAM-06` | 看门狗超时裁决遵循先探活后收口，hard-limit 无条件止损 | `packages/core/src/session/liveStreamSync.ts` → `decideWatchdogProbeAction` | `live-stream-sync-formal.test.mjs` | 长耗时工具或深思考期间无 delta 静默超过 60s 即被前端看门狗误杀为离线闲置 |

### SUBAGENT（7 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-SUBAGENT-01` | 跨会话子代理列表代际围栏防串台（sessionGeneration 检查阻塞慢响应回写） | `packages/core/src/subagent/subagentStore.ts` → `syncSessionSubagents` | `subagentStatusInvariants.test.mjs` | A 会话慢速返回的 subagent.list 覆盖用户已切换到的 B 会话状态，导致状态栏显示错误会话的子 Agent |
| `INV-SUBAGENT-02` | 子代理状态机单调格与终态不可逆吸收律（completed/failed/error/timeout/interrupted 永不退回 queued/running） | `packages/core/src/subagent/subagentStore.ts` → `mergeSubagentRecord` | `subagentStatusInvariants.test.mjs` | 晚到的 subagent.progress/tool 帧或陈旧列表快照把已结束子 Agent 重新激活为运行中，导致中断按钮错开与幽灵计时 |
| `INV-SUBAGENT-03` | 多源合并 1:1 无歧义别名解析与并发同源不误并保证 | `packages/core/src/subagent/subagentStore.ts` → `reconcileSubagentRecords` | `subagentStatusInvariants.test.mjs` | 并发同 delegation_id 下多子任务缺 task_index 时被错误合并成同一行，丢失执行进度与日志 |
| `INV-SUBAGENT-04` | 上下文用量与明细 Fail-Safe 保持不变量（transient RPC 报错绝不清零上一次有效用量） | `packages/core/src/session/sessionStatusStore.ts` → `applyUsageError` | `subagentStatusInvariants.test.mjs` | 网络抖动或 RPC 临时失败把状态栏已渲染的上下文进度条与 token 读数清零归白 |
| `INV-SUBAGENT-05` | 右侧停靠区四态互斥与切会话退避幽灵下钻不变量（closed/status/subagent/files 互斥且切会话必退出 subagent） | `packages/core/src/session/sessionStatusStore.ts` → `reduceRightPodMode` | `subagentStatusInvariants.test.mjs` | 状态栏与文件树同时抢占右侧栏，或切换会话后右侧仍展示旧会话子 Agent 详情页并向错误会话发送 steer |
| `INV-SUBAGENT-06` | RingBuffer 有界日志环形缓冲守恒（条数严格 <= maxLogCapacity 且保留最新尾部） | `packages/core/src/subagent/ringBuffer.ts` → `RingBuffer#push` | `subagentStatusInvariants.test.mjs` | 长耗时子 Agent 持续输出实时日志导致前端内存无界膨胀 |
| `INV-SUBAGENT-07` | subagent.list 同步失败 Fail-Safe 守恒（列表拉取异常不清空已有内存与扫描子任务并显式记录 syncError） | `packages/core/src/subagent/subagentStore.ts` → `applyListSyncError` | `subagentStatusInvariants.test.mjs` | subagent.list 单次超时或报错后把状态栏已有的运行中/历史子 Agent 列表整页抹白 |

### SWITCH（1 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-SWITCH-01` | 替补默认模型候选排除目标与不可用提供商 | `packages/core/src/models/providerViews.ts` → `collectReplacementModels` | `provider-attach-flow-formal.test.mjs` | 把正在关闭的提供商或未开启/空模型提供商塞进替补列表，导致切换后 BOT 无模型可用 |

### TIME（2 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-TIME-01` | 时间格式化确定性 | `packages/ui/src/components-react/leftRailModel.ts` → `formatLeftRailTime#deterministic` | `rail-time-format-formal.test.mjs` | 同一时间戳重复渲染出不同文案，界面抖动 |
| `INV-TIME-02` | 时间分桶单调且非法输入安全降级 | `packages/ui/src/components-react/leftRailModel.ts` → `formatLeftRailTime#buckets` | `rail-time-format-formal.test.mjs` | 未来时刻落入昨前桶；非法时间戳抛错或复活旧值 |

### TURN（2 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-TURN-01` | 看门狗时序参数恒满足夹取与单调（含空时钟回落） | `packages/core/src/turn/slidingWatchdog.ts` → `constructor#clamp` | `sliding-watchdog-formal.test.mjs` | 时钟注入为 null 时回合一开始就崩在熔断器；或上下限倒挂把 30 分钟保险丝缩成几秒 |
| `INV-TURN-02` | 看门狗权威续期不得复活 idle/disarmed，且绝对受 hardLimitMs 封顶 | `packages/core/src/turn/slidingWatchdog.ts` → `SlidingActiveWatchdog.renewIdle` | `live-stream-sync-formal.test.mjs` | 已撤防或已完成看门狗被幽灵续期，或重置 turnStartedAt 导致硬上限失效无限挂死 |

### VIEW（6 条）

| 编号 | 主题 | 源码锚点 | 守护测试 | 失效模式 |
|---|---|---|---|---|
| `INV-VIEW-01` | 跨会话恢复决策忠实于快照（贴底 / 锚点 / 标量） | `packages/core/src/viewport/sessionScrollMemory.ts` → `planSessionEnter` | `session-scroll-memory-formal.test.mjs` | 切回会话时贴底态被旧像素位置覆盖，或回溯位置丢失，表现为白屏或跳到别处 |
| `INV-VIEW-02` | 会话记忆容量有界且最新会话必留 | `packages/core/src/viewport/sessionScrollMemory.ts` → `recordSnapshot#lru` | `session-scroll-memory-formal.test.mjs` | 记忆无限增长吃内存；或刚离开的会话被淘汰，切回即丢位置 |
| `INV-VIEW-03` | 基准行高中位数恒被夹在有效区间内 | `packages/core/src/viewport/adaptiveMedianEstimator.ts` → `addSample#median-clamp` | `viewport-estimator-formal.test.mjs` | 离屏占位高度或超大代码块把基准行高拉偏，长会话滚动条滑块剧烈缩放 |
| `INV-VIEW-04` | 渲染期视口裁决忠实于进入计划与常规两条语义 | `packages/core/src/viewport/renderScrollDecision.ts` → `decideViewportPin` | `render-scroll-decision-formal.test.mjs` | 进入期误捕获旧 DOM 把上一会话位置写进新会话记忆；或回溯态被误判贴底，切回即跳到最新消息 |
| `INV-VIEW-05` | 回到底部按钮显隐只由离底距离与门控决定 | `packages/core/src/viewport/scrollEndMachine.ts` → `decideScrollEndVisibility` | `scroll-end-machine-formal.test.mjs` | 平滑末段按钮闪烁；或已到底仍显示按钮 |
| `INV-VIEW-06` | 切会话/断连取消平滑会话且不写 instant | `packages/core/src/viewport/scrollEndMachine.ts` → `reduceSmoothScrollSession` | `scroll-end-machine-formal.test.mjs` | 切回会话位置飞到半路；旧流残留滚动事件污染新会话进入计划 |

## 尚未覆盖的领域（刻意登记为空）

以下领域当前没有任何形式化不变量。新增这些领域的可判定逻辑时应先补映射，
否则它属于「没有被任何性质守护的新逻辑」：

- `core/src/queue/`（写入队列）
- `core/src/group/`（群聊研讨室）

