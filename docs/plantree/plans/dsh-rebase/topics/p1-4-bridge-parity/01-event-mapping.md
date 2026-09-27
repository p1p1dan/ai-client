# P1-4 分片 01 · RuntimeEvent 与 worker RPC 映射全表

Role: detail shard。上位：[P1-4 方案](../p1-4-bridge-parity.md)。回答调研问题 1（事件映射全表），并补充 worker RPC 方法表。我方行号指 worktree HEAD `941ab5b1`，DSH 路径省略前缀 `src/dsh-host/node_modules/@deepseek-ai/`。

## 读法与写法约定

- **四列**：「自有 runtime 何时发」是 native 路径的生产点；「DSH 数据源」是 bridge 可以用的输入；「HEAD bridge」是 P0-3 bridge 的现状；「做法 / 子任务」是本方案的结论。
- **两类来源**：DSH 数据源分成「持久」（`session/event`，可以回放，历史投影也用它）和「实时」（Cordis 进程内事件或 waterfall，只在活会话里有）。
- **缺口**：凡是「HEAD bridge」写「未发」而「做法」不是「不适用」的，都是缺口。
- **语义差异**另起一栏标出。
- **不适用**：「无对应物」表示 DSH 里没有等价的东西，bridge 也不发这个事件。
- **消费方简写**：R = 渲染层 store / 组件；M = Main 的 `WorkerManager` / 索引。

## 1 RuntimeEvent（`src/shared/types/runtimeEvents.ts:15-45`）

| RuntimeEvent（关键字段） | 消费方 | 自有 runtime 何时发 | DSH 数据源 | HEAD bridge | 做法 / 子任务 |
|---|---|---|---|---|---|
| `session.status`：`running` / `idle` / `stopping` | R（状态、忙碌）；M（`reportedStatus`，`WorkerManager.ts:3096-3100`） | run 开始（`projector.ts:277-283`）；收尾（`:895-899`）；Stop（`nativeWorkerRuntime.ts:544-549`） | bridge 自己的 send；持久事件 `turn/start` / `turn/end` | 已发（`dshSessionRuntime.ts:363`、`:370`、`:573`、`:689`） | 保持 |
| `session.status.retry`（`SessionRetryInfo`，`runtimeEvents.ts:130-172`） | R 重试横幅 | provider 重试时（`projector.ts:768-774`）；开流后发不带 retry 的状态清横幅（`:805-811`） | 持久 `llm/retry` {retry, maxRetries, delayMs, failure}；`llm/retry-started`（`dsh-llm-retry/lib/types/types.d.ts:5-45`） | 未发 | P1-4d：`attempt`=retry；`retryAt`=事件 time+delayMs；`errorStatus`=failure.status；`error`=failure.code；`llm/retry-started` 发普通 running。`maxRetries: 0` 时本来就没有重试（P1-5 定策略） |
| `session.status.liveness` / `.recovery` / `.disconnectReason` | R | native 看门狗；文件修复；Main 回收 | 无看门狗；DSH 修残帧不对外报告；回收由 Main 负责 | 未发 | 无对应物，不发；`disconnectReason` 仍由 Main 发 |
| `message.started` user（`attemptId`、`attachments`） | R（撤掉乐观气泡、附件 chip） | 用户消息开始（`projector.ts:513-542`） | 持久 `user/message`，且 id 等于本轮 followup 的 id | 已发，不带附件（`:577-595`） | P1-4c：加 `attachments` 元数据。**重试续跑消息不回显**（T135：重试没有用户回显，`ChatComposer.tsx:1861-1866`）。非 `user` 来源一律不回显 |
| `message.started` assistant（`model`） | R 元数据行 | 首个内容出现时（`projector.ts:296-310`） | 实时 `agent/assistant-stream` 的 start {turn, step}；路由取 `agent/request` 的结果或 `request/context` | 已发，但 `model` 是默认路由（`:494-510`） | P1-4d：`model` 取实际路由（每轮切模型之后会变） |
| `message.delta` | R | 文本快照的增量（`projector.ts:339-356`） | 实时 chunk `text-delta`；持久 `assistant/message` 补发 | 已发（`:530-536`、`:596-618`） | 保持 |
| `message.completed` | R | `closeAssistant`（`projector.ts:487-508`） | 持久 `step/end`、`turn/end` | 已发 | 保持 |
| `thinking.started` / `thinking.completed` | R 思考块起止 | 首个思考增量 / 转为正文或关闭（`projector.ts:325-350`、`:493-499`） | 实时 chunk `block-start` / `block-end`，其中 blockType 为 `reasoning`（`dsh-llm/lib/types/types.d.ts:417-453`） | 未发 | P1-4d |
| `thinking.delta` | R | `projector.ts:333-337` | chunk `reasoning-delta` | 已发（`:537-545`） | 保持 |
| `tool.started`（input 可为 `__streaming` 摘要） | R 工具行 | 参数开始流式时（`projector.ts:391-405`）；执行开始时（`:619-628`） | 实时首个带 name 的 `tool-call-delta`；持久 `tool/call` | 已发，但 input 固定为 `{__streaming:{bytes:0,lines:0}}`（`:546-559`） | P1-4d：累积 `argumentsDelta`，生成摘要并按 100 ms 节流，与 `projector.ts:378-429` 对齐。生成端 `runtime/events/streamingToolArgs.ts` 移到 shared |
| `tool.updated`（input / `status` / `execStartedAt`） | R 行内参数、T146 计时 | 参数完整时；执行开始；bash 的 `onUpdate`（`projector.ts:603-666`） | 持久 `tool/call`：派发时追加，**早于审批**（`dsh-agent-loop/lib/index.js:680-688`）；实时 `tools/execute` waterfall 是真正开始执行（`dsh-tools/lib/types/index.d.ts:58`）；DSH 没有工具进度事件 | 部分：`tool/call` 时发 updated（`:633-638`） | P1-4d：在 agent 级挂 `tools/execute`，打 `execStartedAt`。`status` 行没有来源，不发。**语义差异**：DSH 的 bash 超时从派发算起，还是从执行算起，需要对照 |
| `tool.completed`（ok、output / error；details：`review` / `refused` / `notStarted` / `stopped`） | R 工具行、会话改动审阅 | 执行结束（`projector.ts:668-693`）；没跑过的行补 notStarted（`:467-486`） | 持久 `tool/result`：`message.isError`、`content`、`error.code`、`meta`（`dsh-session/lib/types/types.d.ts:361-388`）。错误码有 `ABORTED_BEFORE_DISPATCH`（Stop 时还没派发的调用）、`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`（崩溃或 fork 补写）。bash 的 `meta` 带 `exitCode`、`aborted`（`dsh-tool-bash/lib/index.js:301-320`）；fs 的 `meta` 带差异卡 | 已发，但只有纯文本，丢了 details 和图片（`:641-661`） | P1-4d：<br>• `notStarted` ← 前两个错误码；<br>• `stopped` ← bash `meta.aborted`；<br>• 新增 `outcomeUnknown` ← `TOOL_OUTCOME_UNKNOWN`（`ToolOutcomeDetails` 和 `HistoryBlock` 各加一个可选字段，渲染层一句文案）；<br>• `review` ← fs `meta`（形状转换待对照）；<br>• 只有图片的结果写 `(image)`（`projector.ts:130-135`）。<br>bash 非零退出码保持 ok（native 同样只在末尾加 exit 标记，`plugins/tools/index.ts:589`） |
| `custom.message` / `custom.entry` | R 系统行（`chatSessions.ts:1491-1504`） | pi 扩展的 custom 消息；会话 custom 条目 | 持久 `command/done` 的文本；非 `user` 来源、且 `form:'notice'` 的 `user/message`（`tool-jobs` 后台任务通知、`tool-goal` 收尾通知） | 未发 | P1-4d：customType 取 `dsh:<来源>`，内容取 `source.summary`。样式归 P1-7 |
| `permission.requested` / `permission.resolved` | R 权限卡；M | 我方权限插件的 approve | 实时 `approval/request` waterfall，只在越出沙箱时触发 | 已发，只有允许 / 拒绝（`:701-736`） | 保持；逐次审批、四档、`allow_session` 归 P1-6 |
| `question.requested` / `question.resolved` | R 问答卡 | `ask` 工具（`runtime/worker/questionPrompt.ts`） | 实时 `user-questions/request` waterfall（`dsh-user-questions/lib/types/types.d.ts:80`），比如 plan-mode 的方案确认 | 未接（`respondQuestion` 恒 false，`:386-388`） | P1-4d：挂 answerer。字段对应：<br>• `questions[{id, question, header, options, multiSelect}]` 与我方 `QuestionItem` 一一对应；<br>• 回答时，我方 answers 按 `", "` 拆回 `selected[]`，`response` 对应 `custom`，`cancel`（跳过）对应每题 `{id, selected: []}`（`dsh-user-questions/README.md:39`）。<br>多选标签里本身带逗号时有损 |
| `preview.requested` | M 预览窗 | `browser_preview` 工具 | 无同名工具；`present` / `deliverables/presented` 的语义不同 | 未发 | 无对应物；`present` 归 P1-7 |
| `usage.updated`（`PiUsagePayload`，`shared/piUsage.ts:82-123`） | R 元数据、上下文占用环、费用 | 流式中的临时值（`projector.ts:443-450`）；每个 pi turn_end 的已结算值（`:694-753`）；子代理（`:850-869`） | 持久：`assistant/message.usage`（每步）、`request/context.contextWindow`；实时：chunk `usage`；投影：`tokenUsage`、`contextPressure`（`dsh-token-meter/lib/types/usage-projection.d.ts`） | 未发 | P1-4d，细则见[分片 04 §4](04-turn-semantics.md)。`costUsd` 要等 P1-5 给定价；`delegated` 归 P1-7 |
| `permission.activity` | R 审计行 | 我方权限插件（`runtime/plugins/permissions/activity.ts`） | DSH 的 `approval/asked` / `approval/decided` 只写日志 | 未发 | 归 P1-6，由移植后的权限插件发 |
| `subagent.activity` | R 子代理面板 | 子代理插件 | `subagent/*`、子会话事件、`tool-workflow/*` | 未发 | 归 P1-7 |
| `session.completed` / `failed` / `stopped`（`error`、`errorCode`、`stopCause`，`runtimeEvents.ts:725-773`） | R；M（清锁、同步 leaf，`WorkerManager.ts:3101-3112`） | `projector.finish`（`:871-900`）；插话见 `agent-loop/index.ts:1309-1318` | 持久 `turn/end.reason`（`dsh-session/lib/types/types.d.ts:165-208`） | 已发，但失败时 error 是一段 JSON 串（`:679-688`） | P1-4c / P1-4d：<br>• `completed`、`blocked`、`max-tokens` → completed；<br>• `aborted{user}` → stopped；<br>• `aborted{hook,'aiclient-interject'}` 和「标志已置位时的 completed」→ completed，带 `stopCause:'interjected'`；<br>• `error{LlmFailure}` → failed，`error`=message，`errorCode`=code；<br>• `interrupted` / `forked` 不会实时出现 |
| `session.created` / `resumed` / `history` / `updated` / `stderr` | R；M | Main 产生 | — | — | 不经 bridge；history 的内容由 bridge 的 `history()` 提供（P1-4a） |
| `host.ready` / `host.error` | — | 已经没有生产者（遗留） | — | — | 不适用 |
| **新增** `session.projection {key, view}` | P1-7 渲染层 | — | `ctx.sessionProjections.snapshot` / `onChanged`：`goal`、`todos`、`plan`、`permissions`、`sandboxMode` | — | P1-4d 定线协议并发出，P1-7 负责消费（决策点 D7） |

## 2 语义差异与没有对应物的项（汇总）

1. **中断回合**：`turn/end interrupted` 只在恢复或冷读时补写，实时收不到（P0-6）。展示只能靠历史投影；实时那一轮的失败由 Main 在宿主退出时发出。
2. **失败尝试**：DSH 的失败尝试不进模型上下文，也不在 surface 上；native 的失败回复会留在旁支。重试的映射见分片 04 §2。
3. **插话**：DSH 没有「停在下一个边界」这种原语，要用 cancel 的 hook 原因组合出来（分片 04 §1）。
4. **审批**：DSH 只在越出沙箱时审批，四档归 P1-6。卡片的动作 id 仍是「写入工作区文件」，文案误导的问题也归 P1-6。
5. **工具计时**：`tool/call` 早于审批，拿它当开始时间会把审批等待也算进去，所以改用 `tools/execute`。
6. **图片**：DSH 在入库时就把图片归一化（缩小、重新编码）；native 直接发原始字节。
7. **费用**：DSH 不计价；native 用 pi 的模型表计价。

## 3 worker RPC 方法（`PiWorkerRuntime`，`src/agent-host/piWorkerRpcServer.ts:110-147`）

| 方法 | HEAD bridge | P1-1 之后（决策 010） | P1-4 做法 | 子任务 |
|---|---|---|---|---|
| `bootstrap` | 不带 `initialHistory`；leaf 为空；`capabilities: {}` | 先落盘再写桩；空页 `initialHistory`；错误映射 | 投影出的 `initialHistory`（80 条一页）、真实 leaf、能力清单（技能数等）、实际路由 | a / d |
| `startSend` | 只取 text | `mode:'retry'` → `WORKER_RETRY_UNAVAILABLE`；带附件 → `WORKER_DSH_UNSUPPORTED` | 重试续跑（D3）、附件、每轮 model / effort、以 `/` 开头的已知 DSH 命令 | c / d |
| `history` / `tree` | 空 | 空 | 投影与跨 lineage 的树 | a / b |
| `commands` | 空列表 | 同 | `ctx.commands.list(agent)` → `WorkerSlashCommandInfo`，source 取 `dsh-command` | d |
| `compact` | 不支持 | 同 | 执行 `/compact`，不带参数；`instructions` 非空时拒绝；预算用 `WORKER_COMPACT_BUDGET_MS` | d |
| `rewind` | 不支持 | 同 | 指针切换式回退（D2） | b |
| `reload` | 不支持 | 同（TUI 护栏使它到不了） | 保持不支持，归 P1-11 | — |
| `fork` / `acceptFork` / `discardFork` | 不支持 | Main 侧切到 DSH，bridge 仍报不支持 | 种子子会话、`targetLogicalSessionId`、`.staged` 标记（D6） | b |
| `stop` | `cancel({kind:'user'})` | 同 | 保持；在 goal 回合里 Stop 会暂停 goal（DSH 规则） | — |
| `interject` | 恒 false | 同 | 标志位 + 步边界 cancel(hook)；`turnActive`（D4） | c |
| `respondPermission` | 已接 | 同 | 保持 | — |
| `respondQuestion` | 恒 false | 同 | answerer | d |
| `respondPreview` | 恒 false | 同 | 保持 false（没有生产者） | — |
| `setPermissions` / `setPermissionGear` / `setPermissionTier` | 空操作，但 RPC 仍回 `applied:true` | 同 | 归 P1-6（在那之前是已知风险） | — |
| import / utility | 抛错 | 同 | 归 P1-9 / P1-15 | — |
