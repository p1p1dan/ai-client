# 决策 106：P1-4d1 直播映射的实现取舍

日期：2026-09-28。**状态：用户 2026-09-28 批准（[决策 110](110-user-rulings-2026-09-28-batch2.md)）。** 依据：[决策 099](099-p1-4d-scope-dsh-data-only.md)（逐条对照）；[P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) §4.2、§6.1 的 P1-4d1 行、§8；决策 [072](072-renderer-data-channels.md) 第 3、4 条，[081](081-loop-guard-implementation-choices.md)、[088](088-permission-gate-wiring-choices.md) 的「留给后续」；[P1-7 分片 03 §6](../topics/p1-7-renderer/03-panels.md)（轮次头与通知表）；[P1-5 分片 03 §5](../topics/p1-5-models-and-credentials/03-design.md)（失败码表，P1-5c 同批）。改动留在工作区，由编排者复跑后提交。

下面列的都是 099 没有写死、由本次实现定下的地方。

修订注记（2026-09-28，P1-7a）：第 36 条的空气泡过渡态已由轮次头替换，第 27 条的通知行与第 40 条的 `AutoTurnHead`、提示词导航条跳过轮次头已落地；第 41 条里的 `goalActivation` 提前在 P1-7a 做了（`execStartedAt`、`jobs`、子代理用量与重试仍归 P1-7b）。见[决策 118](118-p1-7a-goal-todo-round-choices.md) 第 9、21～23 条（待审批）。

修订注记（2026-09-28，P1-7b）：第 41 条里的 `execStartedAt`、`jobs` 已落地；子代理的用量（`usage.updated.delegated`）与重试横幅（第 21 条）没有做，记为遗留。见[决策 119](119-p1-7b-jobs-subagents-choices.md) 第 10、13 条（待审批）。

修订注记（2026-09-28，P1-7c）：第 42 条的四个失败码（`PROVIDER_UNAUTHORIZED`、`PROVIDER_RATE_LIMITED`、`NETWORK_ERROR`、`PROVIDER_ERROR`）有了自己的失败卡；第 14、16 条（`ABORTED` → 已停止、卡片被拒不标红）由新的词表测试补例核对，代码不变。见[决策 120](120-p1-7c-tool-rows-choices.md) 第 1 条 l、第 26 条（待审批）。

## 规则

### 一、模块

1. **直播翻译单独成文件**：`bridge/liveEvents.ts`（`DshLiveEvents`）承接 `session/event` 与 `agent/assistant-stream` 到 RuntimeEvent 的全部映射；`dshSessionRuntime.ts` 只留回合、会话身份、闸门，通过一个 host 接口把事件交给它。文本与工具行的原有行为不变。
2. **直播与历史共用的规则放在 shared 纯模块**，保证重开会话看到的就是直播看到的：
   - `src/shared/dshNotices.ts`：通知与轮次头的来源表（沿用 P1-7 方案里的文件名）；
   - `src/shared/dshFileReview.ts`：差异卡到审阅记录；
   - `dshToolOutcomeFlags`（`shared/dshHistory/projection.ts`）：工具行标志。
3. **bridge 包只能收 `src/dsh-host/bridge/`、`src/agent-host/`、`src/shared/` 的源码**（`BRIDGE_ENTRIES`）。所以 loop guard 的两个名字 `aiclient-turn-ceiling`、`LoopGuard` 在 `shared/dshHistory/types.ts` 各留一份副本，测试钉住与 `loopGuard/constants.ts`、`permissionHost` 的一致。

### 二、用量（099 第 1 条）

4. **已结算**：每个带 `usage` 的 `assistant/message` 发一条；**进行中**：流里的 `usage` chunk 每步发一条，只含 prompt 侧（`buildPiInterimUsagePayload`）。
   - pi-ai 适配器只在流结束时给 usage，所以 DSH 会话里「进行中」几乎与「已结算」同时到。流式期间回合头上的 ↑ 看不到；1.0.x 在首字节就有。这是适配器自身的行为，不补估算。
5. **上下文占用**：
   - 取 `contextPressure.projectedTokens`，即 DSH 给占用显示用的「下一次请求」的大小；没有就退到 `pressureTokens`，再退到本步 prompt 三项之和；
   - 窗口取 `contextPressure.contextWindow`（最新的 `request/context`）；没有窗口就不带 `context`；
   - 百分比由 bridge 按 tokens / 窗口算。
6. **会话累计**：
   - 四个数取 `tokenUsage` 投影；
   - `turns` 是日志里「带 usage 的 step 数」，由历史 fold 计数，与 `tokenUsage` 同一份日志；
   - `toolResults` 为 0，`costUsd` 为 0；委派用量 `delegated` 不做，归 P1-7b。
7. **被 Stop 截断、没有 usage 的 step**：发一条 `unreported`，沿用 T125 的做法。数字为 0，界面显示「未知」而不是 0。
8. **投影服务**用 `ctx.get('sessionProjections')` 读，不加进 bridge 行的 `inject`，行的启动不必等它。没有这个服务或者读失败，只少这一条的 `context` / `session`。

### 三、思考（第 2 条）

9. `block-start` / `block-end`（blockType 为 `reasoning`）映射为 `thinking.started` / `thinking.completed`：
   - blockId 沿用已有的 `<messageId>-r<index>`；
   - `reasoning-delta` 先于 `block-start` 到达时，补发 started；
   - step 结束时还开着的思考，补发 completed。

### 四、流式工具参数（第 14 条）

10. **大小**：
    - bytes 是已收到的原始 JSON 的 UTF-8 字节数；
    - lines 数的是 JSON 字符串里转义的换行 `\n`，经 `countStreamingLines` 计算；转义的反斜杠不算。
11. **节流**：同一调用 100 ms 至多一次，沿用 1.0.x 的 `TOOL_ARG_COALESCE_MS`；大小没变不发。
12. **完整参数**：在流里这个调用块结束时发出（`block-end` 带的是 DSH 组装好的调用），不等 durable `tool/call`；之后的 `tool/call` 参数相同，不再重发。
13. **录制归一化**：丢掉参数流式期间的 `tool.updated`，因为有没有这一条取决于两次 delta 之间的墙钟；`tool.started` 上的大小保留，它由假网关的分块决定。

### 五、直播工具行标志（第 5 条，072、088 的交接）

14. 直播与历史用同一个函数读 `tool/result.error`：
    - `ABORTED_BEFORE_DISPATCH`、`TOOL_NOT_STARTED`：未执行。Stop 收卡后的调用也是这个（088）；
    - `ABORTED`：已停止，任何工具都算（072：DSH 的 bash 不带 `meta.aborted`）；旧的 `meta.aborted` 照样认；
    - `TOOL_OUTCOME_UNKNOWN`：结果未知；
    - `error.name` 为 `PermissionDenial` 或 `LoopGuard`：已拒绝，即我方闸门的拒绝和 500 步收尾里的拒绝。
15. 有标志或审阅时，`tool.completed.output` 是 `{content, details}`；否则仍是字符串。
16. **用户在卡片上拒绝的调用**，行上已有权限词「已拒绝」，结果词也是「已拒绝」，中文会重复。所以 `ToolRows.tsx` 在这种情况下不画结果词。这一行也不再是红色：N5 的规矩是没执行就不算失败。

### 六、会话改动审阅（第 6 条）

17. 只用 DSH 的差异卡，不再读文件：
    - 新建（`write` 且 `operation:'create'`）记为 added：DSH 对新建不存 hunk，补丁取调用参数 `content` 的全文，从第 1 行起，1.0.x 的格式，含「文件末尾无换行」；
    - 更新和 `edit` 记为 modified：补丁是每个 hunk 的新旧文本做行级比较（`textDiff.ts`），hunk 之间用不带行号的 `@@` 分隔。DSH 只存 hunk 的文本，不存它在文件里的起始行，审阅面板于是不显示行号，而不是显示错的行号。
18. 路径取调用的 `file_path`（没有时取 hunk 的 path）。限额沿用 1.0.x：文件 256 KiB 或 4000 行、补丁 64 KiB，超了记 `too-large`；含 NUL 记 `binary`。
19. 失败的调用没有审阅；迁移会话优先用 `meta.aiclient.piDetails.review`。
    - 有审阅的 `edit` / `write`，中栏的行只留摘要，差异在右侧审阅栏，与 1.0.x 相同（`6be1d70a`）。

### 七、重试横幅（第 3 条）

20. `llm/retry` 映射为带 `retry` 的 `session.status running`：
    - `attempt` 取 `retry`，`maxRetries` 取 `maxRetries`。`always` 模式没有上限，给 0，这是横幅认的「未知」哨兵；
    - `errorStatus` 取 `failure.status`，`error` 取 `failure.code`，`retryAt` 为事件时间加 `delayMs`；
    - `llm/retry-started` 发不带 `retry` 的 running，横幅随之撤下。
21. 子代理的重试记在子会话日志里，本会话收不到，归 P1-7b。

### 八、失败与结束原因（第 4 条，081 交接，P1-5c 失败码表）

22. `session.failed.error` 取 `LlmFailure.message`；没有 message 用 code，两者都没有才退回原来的 JSON。
23. **失败码表补全**（`shared/dshFailureCodes.ts`，P1-5b 建的表）：
    - `INVALID_REQUEST`、`EMPTY_RESPONSE`、`PI_AI_ERROR` 映射为 `PROVIDER_ERROR`；
    - 我方 loop guard 的 `tool_call_repetition` 原样透传，渲染层有它的专门卡片（081 交接的「透传 `error.code`」）；
    - `UNKNOWN`、`UNSUPPORTED_CONTENT`、`IMAGE_OFFLOAD_REQUIRED` 不映射，显示通用卡加 DSH 的原句。
24. **渲染层失败卡**：`TIMEOUT`、`CONTEXT_TOO_LARGE`、`MODEL_NOT_CONFIGURED` 与已有的 timeout、context_too_large、model_missing 卡意思完全一致，直接读那三张卡，不加新文案；`PROVIDER_UNAUTHORIZED`、`PROVIDER_RATE_LIMITED`、`NETWORK_ERROR`、`PROVIDER_ERROR` 仍是通用卡，文案归 P1-7c。
25. `aborted{reason:{kind:'hook', reason:'aiclient-turn-ceiling'}}` 映射为 `session.completed{stopCause:'turn_limit'}`；其余 `aborted` 仍是 `session.stopped`。`blocked`、`max-tokens` 由原来的 failed 改为 completed，与分片 01 的表一致。

### 九、通知（第 7 条）

26. 来源表（`src/shared/dshNotices.ts`）：
    - 显示：`tool-jobs`、`subagent-settled`（取 summary）、`agent-message`（取转达的正文），以及不认识的 notice 形式来源（前向兼容，DSH 以后新增的通知不会凭空消失）；
    - 隐藏：`tool-goal`、`model-selection`、`repeat-tool-reminder`、`plan-mode`、`aiclient-loop-guard`、`aiclient-retry`，以及一切非 notice 形式的上下文。
27. 直播发 `custom.message {messageId:'dsh-notice-<seq>', customType:'dsh:<来源>', content}`；历史是 system 行。
    - P1-7a 画轻量行之前，直播行按现有 `custom.message` 的画法，第一行会显示 customType；重开会话后只剩正文。

### 十、自主回合的轮次头（第 8 条，072 第 3 条）

28. **规则**：
    - 一个回合的首批输入（到这个回合的第一个模型事件为止）里，第一条「能自己开回合」的消息，即 `goal`、`tool-jobs`、`subagent-settled`、`agent-message`，成为这个回合的头；
    - 同一批里有用户的提示词或 retry 续跑，这个回合属于用户，那条消息改为通知，或者按表隐藏；
    - 首批之后到的，一律是通知；
    - 直播只在 bridge 没有自己的回合，也就是 DSH 自己开的回合里出头。
29. **`origin` 形状**：`{kind:'goal', round, maxRounds?}`，maxRounds 取日志里最近一次 `goal/change`；`{kind:'job'}`；`{kind:'subagent', childSessionId?}`；`{kind:'agent-message', childSessionId?}`。
    - P1-7 草案里的 `jobId`、`label` 在 DSH 的消息来源里没有，改用正文里的 `source.summary`。
30. **头的正文**：summary 或转达的消息；goal 轮没有正文，它的消息体是给模型的续跑提示词。
31. `message.started.origin`、`HistoryMessage.origin`、`ChatMessage.origin` 都是可选字段，`chatSessions.ts` 只透传，不改状态结构。

### 十一、「重复 resume」（第 13 条，P1-1 点验遗留）

32. **查清的事实**：
    - 发送被拒、失败后点「继续」时，输入框 `unbindHost()`，下一次发送走 resume；Main 的暖路径（slot 还活着）重读第一页，发 `session.resumed`、`session.history(initial)`、`idle`（`WorkerManager.resumeSession`）；
    - P1-4a 之后这一页不再为空。渲染层用 `historyReplayMerge` 合并：已水合的 `h:` 行换成新页；与历史同文本的用户气泡、纯文本回复折叠成一份。**时间线不会被盖掉**；
    - 但带工具行的回复、通知、没有正文的轮次头，文本层对不上，会被留下并排到最后，结果是**重复且错序**。这就是 `historyReplayMerge.test.ts` 早就钉住的 L6，1.0.x 同样有；
    - 另外，往上翻过的较早页会被收回到最新一页，再往上翻可以重新读回来。
33. **修法：按直播 id 精确合并**：
    - 历史投影给每一行标上它在直播里的 id（`HistoryMessage.liveMessageId`）：`dsh-user-<seq>`、`dsh-notice-<seq>`、`dsh-<会话>-t<回合>-s<步>`；只在 bridge 自己的缓存和只读预览里标；
    - 合并时先按这个 id 折叠：resume 前就在的直播副本让位给历史行，位置按历史，不看块的类型；
    - 还在等待的消息（未答的卡或问题、没有结果的调用）不这样折叠；例外是宿主重启后的重放（`mode:'refresh'`），发这些消息的引擎已经不在了，它们不会再有结果，一律让位给历史行（例如结果未知的工具行）；
    - 带附件的直播副本替换它的历史行，附件信息不丢。
34. 没有改的：宿主历史缓存重置后重读又失败时，页为空，空页会让渲染层丢掉全部 `h:` 行，这是空页的既有合并规则。这种情况只出现在回退后重读失败，而回退本身已用这一页替换了时间线，暖 resume 不会带来新的损失。

### 十二、录制场景（决策 100，4e-1）

35. 新增 `think`、`usage`、`job-notice` 三个场景定义，没有写金样本：
    - 假网关新增 `P1-THINK`（一个思考块再回答）、`P1-USAGE`（一个工具步再回答，带缓存读写）、`P1-JOBNOTICE`（后台任务比回合晚结束，通知唤醒一个没人发的回合，再作答）；
    - 脚本多拿一个参数：模型上次回复之后收到的文本，`P1-JOBNOTICE` 靠它认出唤醒；
    - 后台命令 `sleep 3`，保证通知在回合结束之后才到；
    - `job-notice` 按 requestId 分开两个回合，唤醒回合的是 bridge 自己的 `dsh-turn-<会话>-2`。

## 取舍

- 全部用 DSH 自己的数据，不估算：没有 usage 就标「未知」，没有行号就不显示行号，没有 jobId 就不编造。
- 直播与历史走同一张表、同一个函数，重开会话看到的与直播一致；直播 id 进历史，是为了让暖 resume 对得上号。
- 渲染层只动了必需的四处：`chatSessions.ts` 两个可选字段透传；`historyReplayMerge.ts` 的精确 id 合并；失败卡的三个别名；卡片被拒时去掉重复的「已拒绝」。轮次头与通知的轻量画法仍归 P1-7a。

## 待用户拍板

36. **goal 轮在 P1-7a 之前显示为空的用户气泡**（第 30 条）。回合分组是对的，只是外观未完成。也可以先给一行英文占位，但那是 app 自己写进对话的文案，要走翻译。
37. **卡片被拒的调用不再标红**（第 16 条），行上是中性色的「写入 … · 已拒绝」。1.0.x 是红色。
38. **DSH 会话的审阅补丁没有行号**（第 17 条），hunk 之间只有 `@@` 分隔。
39. **DSH 会话的 ↑ 用量要等流结束才出现**（第 4 条），1.0.x 在首字节就有。

## 留给后续

40. P1-7a：轮次头 `AutoTurnHead`、通知轻量行；`PromptNavRail`、`turnCopy` 认 `origin`。
41. P1-7b：`execStartedAt`、`goalActivation`、`jobs`、子代理的用量与重试。
42. P1-7c：`PROVIDER_UNAUTHORIZED`、`PROVIDER_RATE_LIMITED`、`NETWORK_ERROR`、`PROVIDER_ERROR` 的失败卡文案。
43. P1-4c1：输入框在 DSH 回合失败后不必 `unbindHost()`，slot 是好的；那样「继续」就不会触发暖 resume。本次没有改 `ChatComposer.tsx`。**已在 P1-4c1 落地**（[决策 111](111-p1-4c1-turn-semantics-choices.md) 第 14 条）。
44. 同一步里一次失败的尝试已经流出了文字、DSH 自动重试时，直播里旧的半截文字会留在同一块里，后面接上新尝试的文字；历史里是对的。pi-ai 的失败多在出字之前，本次没有处理。
45. 金样本：18 个既有场景的 `stream.*`、`rpc.*` 全部要重录，`log.*` 不变；三个新场景第一次录。差异清单见交回报告。
