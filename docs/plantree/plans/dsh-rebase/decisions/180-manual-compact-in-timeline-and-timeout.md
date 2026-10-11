# 决策 180：手动 `/compact` 进时间线（与自动压缩同一套呈现）、时限放宽到约 10 分钟并可按 Esc / 停止取消；顺带修 CG-4

日期：2026-10-11。**状态：第 1 节为用户裁决（2026-10-11）；第 2 节起为自主决定，待用户审批。**

代码提交：`3fae7aee`（宿主与投影）、`6474468c`（Main）、`4e2b45ef`（时间线、取消与 CG-4）、`32358e89`（录制场景与重录）。

来源：用户 2026-10-11 的三条裁决（经编排者转达，看板 `efe11cd2` 已记录）；真实网关取证 [compaction-real-gateway-2026-10-11](../evidence/compaction-real-gateway-2026-10-11.md) 的 CG-1（GPT 6.1 Sol 两次在 45 s 被取消）与 CG-4（流式段落重复 key）。代码：尚未提交（工作树，HEAD `b8fe11db`）。

修订关系：

- [决策 176](176-session-commands-start-before-run.md)：
  - §3.2 第 1 条（输入框状态行两段「正在启动对话…」「正在压缩上下文…」）：**取代**。两段改在时间线里那一行显示（第 5 节），输入框不再有这一行，`shouldShowStatusLine` 的 `working` 一并删除。
  - §5「启动中 · Stop / Esc：没有回合，输入框不出 Stop，Esc 不发 Stop」与「压缩中 · Stop：Main 当场答 `no_active_turn`，压缩照常完成」：**推翻**。两段都出停止键，Esc 与停止都取消这一次压缩（第 4 节）。Main 的 `stop` 本身不变（仍只管回合）。
  - §3.2 第 3 条（结果一律 toast）：**部分取代**。跑过的压缩（取消、超时、没有有用的摘要、DSH 的其他原因、压缩途中对话停止运行）在时间线那一行说明，不再弹 toast；没跑成的（回合进行中、已在压缩、说明过长或引擎不支持、没有可压缩的内容、对话没能启动、启动前就停止运行）仍是原来的 toast。
  - 「成功才清空输入框，其余留在输入框」：**改为**开始时清空（像发消息一样），只有没跑成时把这一行放回输入框（第 5.6 节）。
- [决策 178](178-compaction-progress-and-send-during-compact.md) §3.1「只翻译回合自己的压缩；`/compact`（`turn: null`）由输入框状态行显示，直播不重复显示」与 §3.3「`/compact` 的摘要行不带 `liveMessageId`」：**取消**。手动压缩同样翻译成 `session.compaction`（`trigger: 'manual'`），摘要行同样带 `liveMessageId: dsh-compaction-<compactionId>`。§5 压缩期间排队不变。
- [决策 113](113-p1-4d2-commands-and-projection-choices.md) 第 8 条（`worker.compact` 不发直播事件）：**推翻**。第 9 条「超过 `WORKER_COMPACT_BUDGET_MS`（45 秒，在 Main 的 60 秒之内）」：**改为** 600 秒 / 630 秒，并新增结果码 `WORKER_COMPACT_CANCELLED`。第 19 条（命令不进历史）：对 `/compact` **部分推翻**——它开始了压缩时，其 `command/run` 投成一行命令（第 5.3 节）；其他命令仍不投。
- [决策 140](140-p1-7e-e2b-choices.md)（成功即在时间线出摘要行）：保持，位置从「时间线末尾追加」改为「运行行原地变成摘要行」。
- [决策 179](179-compact-instructions.md)：摘要行下的说明行规则不变；会话桩的 `compactInstructions` 条目新增可选 `unused: true`（第 5.3 节）。§9 风险 4 里「压缩恰在超时边界提交」的竞态由第 4.3 节修掉。
- 决策 046（没有回合时 Stop 当场答 `no_active_turn`）：不变。取消走单独的 RPC，不经 `stop`。

## 1 用户裁决（2026-10-11）

1. **手动 `/compact` 的时限放宽到约 600 秒**：worker 600 秒，Main 比它多一段余量，保持「worker 先放弃」的顺序；全链路其他相关时限一并核对。依据：取证里 GPT 6.1 Sol 两次都在 45 s 被取消（约 30 token/s），其他模型 15～29 s 成功。
2. **时限一长就必须能中途取消**：压缩进行中按 Esc 或点停止，取消这一次压缩；同会话的 `worker.stop` 排在串行请求链后面，需要一个能越过串行链、中止在途压缩信号的途径（新 RPC 或让 stop 识别在途压缩，自定并写进决策）。取消后对话不变，时间线写明「已取消」。
3. **手动压缩改成与自动压缩同一套时间线呈现（像 Claude Code CLI）**，取代决策 176 挂在输入框上方的状态行：先出现一行命令（`/compact` 及附加说明），下面是「正在启动对话…」（仅未启动时）→「正在压缩上下文… N 秒」（转圈 + 计时 + 可按 Esc 中断的提示），完成后原地变成「上下文摘要」行（含决策 179 的说明行），失败 / 超时 / 取消在这一行写明原因；直播与重开对话一致（重开时命令行可由 DSH 日志的 `command/run` 投影）。压缩期间发消息仍进排队、结束后自动发出；首页拦截、带附件当普通消息不变。
4. （编排者顺带）**CG-4**：`MessageTimeline.tsx` 以段落内容作 React key，重复段落会撞 key；改成稳定且唯一的 key，补测试。

## 2 现状与根因（HEAD `b8fe11db` 上逐条核实）

| 环节 | 位置 | 现状 |
|---|---|---|
| worker 时限 | `workerRpc.ts` `WORKER_COMPACT_BUDGET_MS = 45_000`，bridge `runCompact` 的 `AbortController` | 45 s 到时 `abort()`，答 `WORKER_COMPACT_TIMEOUT` |
| Main 时限 | `WORKER_COMPACT_REQUEST_TIMEOUT_MS = 60_000`，`WorkerManager.compactSession` | 只等，不取消 |
| 取消入口 | `bridgeRpcServer.ts` `receive`：每个请求都排在一条链上 | `worker.stop` 排在 `worker.compact` 后面；而且 Main 的 `stop` 在没有回合时当场答 `no_active_turn`，根本不问 worker |
| 直播 | `liveEvents.ts` `onCompactionStart`：`turn` 不是数字就返回 | 手动压缩没有任何直播事件；输入框状态行是唯一的进行中表示 |
| 投影 | `projection.ts`：`command/run` / `command/done` 跳过；手动压缩的摘要行不带 `liveMessageId` | 重开只有摘要行；失败的手动压缩重开后什么都没有 |
| 闲置回收 | `WorkerManager.isSafeToEvict` 不看 `compacting` | 45 s 时无所谓；10 分钟的压缩可能撞上 15 分钟闲置回收或容量驱逐 |

DSH 侧（0.1.7-rc.2）读到的两个事实，第 4 节依赖它们：

- `dsh-commands` 的 `execute` 用 `withAbort` 包住处理器：信号一 abort，`execute` 立刻以 `signal.reason`（是 `Error` 时原样）拒绝，并写 `command/done {kind:'error', text: reason.message}`；压缩本身稍后才在流被切断后收尾，写 `compaction/end {error}`。所以**中止原因的文字会成为日志里这条命令的回答**——录制样本 `log.compact-cancel.json` 实测：`command/done.text` 与 `compaction/end.error` 都是我们给的原因。
- `dsh-compaction-basic` 的 `compactSurfaceRegion` 在摘要返回后、提交前看一次信号；提交后还有一次 `flush`，期间被中止时 `execute` 照样以中止拒绝，但检查点已经写进日志——原来的 bridge 此时答「超时，对话没有改动」，与磁盘不符。

## 3 时限（第 1 条；数值是用户裁决，余量是自主决定）

| 时限 | 改前 | 改后 | 位置 | 说明 |
|---|---|---|---|---|
| worker 摘要预算 | 45 s | **600 s** | `WORKER_COMPACT_BUDGET_MS` | 到时以「超时」原因 abort |
| worker 中止后等 DSH 收尾 | 无 | **≤ 5 s** | `WORKER_COMPACT_SETTLE_MS`（`compactSettleMs` 可注入） | 等这次压缩的 `compaction/end`，答复在日志之后发出，紧接着的 `/compact` 不会撞上前一次尚未退出的 maintenance |
| Main 等 `worker.compact` | 60 s | **630 s** | `WORKER_COMPACT_REQUEST_TIMEOUT_MS` | 比 worker 多 30 s：盖过 5 s 收尾和读回摘要行；测试钉住「差值 > 收尾时限」 |
| Main 等 `worker.compact.cancel` | — | **5 s** | `WORKER_COMPACT_CANCEL_TIMEOUT_MS` | worker 收到即答 |
| 渲染层再问取消 | — | 每 250 ms，最多 40 次 | `compactRun.ts` | 取消先于压缩到达 Main / worker 时再问（第 4.4 节） |
| 闲置回收 / 容量驱逐 | 不看压缩 | **压缩在途不回收、不驱逐**；结束时 `lastIdleAt` 重新计时 | `isSafeToEvict`、`compactSession` | 15 分钟闲置回收可能在 10 分钟压缩中途触发 |
| 渲染层 `compactSession` IPC | 无超时 | 不变 | — | |
| 宿主心跳（ping/pong） | 控制通道 | 不变 | — | 不经会话请求链，不受影响 |
| 压缩期间排在链上的其他请求（翻页 `worker.history`、斜杠菜单 `worker.commands`、`worker.panels`、权限设置） | Main 默认 10 s | 不变 | — | 压缩期间会在 Main 侧超时、压缩后才被执行（45 s 时已如此，现在更容易遇到），见第 10 节风险 2 |
| 压缩期间发消息 | Main 答 `session_busy`（决策 178） | 不变 | — | 渲染层排队，结束后发出 |

## 4 取消途径（第 2 条，自主决定）

### 4.1 选新 RPC `worker.compact.cancel`，不让 `stop` 识别在途压缩

- `stop` 的语义是「停回合」，Main 在没有回合时当场答 `no_active_turn`（决策 046），渲染层的停止锁、看门狗、`session.stopped` 都围绕回合；让它兼管压缩，要在 Main、worker、渲染层三处给同一个方法加第二种含义，而且 `worker.stop` 本身也得改成越过请求链——它在回合里需要的恰恰是排队语义。
- 新方法只做一件事、只有一个调用方，越过请求链的特殊处理只给它一个：`receive` 收到 `worker.compact.cancel` 当场处理（仍先查代次、载荷、是否已 dispose），不进链。

### 4.2 worker（bridge）

- `DshSessionRuntime.compact` 一进来（第一个 `await` 之前）就登记本次压缩（`compactRun`：`AbortController`、键入的说明、租约、中止原因、DSH 的 `compactionId`、是否已收尾）；同会话第二个 `compact` 当场答 `WORKER_SESSION_BUSY`。
- `cancelCompact()` 同步：有在途压缩且未中止 → 以 `AICLIENT_COMPACT_CANCELLED_REASON`（`'aiclient: /compact was cancelled by the user'`）中止，答 `{cancelled: true}`；否则 `{cancelled: false}`（已被时限中止的也算没有）。
- 时限到：以 `AICLIENT_COMPACT_TIMEOUT_REASON` 中止。两个原因是 `shared/dshHistory/types.ts` 的常量，DSH 把它们记成命令的回答，投影据此分辨（与 `AICLIENT_TURN_CEILING_REASON` 同一做法）。
- 中止后：等这次压缩的 `compaction/end`（≤ 5 s，超出写一行日志照常答复）；然后**看摘要行是否已落地**——落地了就答 `compacted`（取消来晚了，摘要已写成，以磁盘为准）；否则取消答 `WORKER_COMPACT_CANCELLED`（不可重试，「nothing was compacted」），时限答 `WORKER_COMPACT_TIMEOUT`（可重试）。
- 租约（决策 179）期间被取消：不再问 DSH，直接答取消。

### 4.3 请求链上还没轮到的压缩

`BridgeRpcServer` 记下链上尚未开始的 `worker.compact`；取消到达时如果运行时说「没有在途压缩」，就把这些排队的标成已取消，轮到时当场答 `WORKER_COMPACT_CANCELLED`，不调用运行时。只作用于取消到达那一刻已在排队的，之后的 `/compact` 不受影响（`[180-RPC-2]`）。

### 4.4 Main 与渲染层

- Main `WorkerManager.cancelCompact(sessionId)`：条目在压缩（`compacting`）且有槽才转发 `worker.compact.cancel`（5 s），否则 `{cancelled: false}`；转发失败记日志答 `false`，不抛。IPC `chat:cancelCompact`、preload `chat.cancelCompact`。压缩本身的答复照旧经 `compactSession` 原样返回。
- 渲染层 `cancelCompactRun(sessionId)`（`compactRun.ts`）：本窗口的 `/compact` 在途时，Esc（输入框，排在斜杠 / @ 弹层之后、回合的 Stop 之后）与圆形停止键（此时标题「取消压缩」）都调它；`useCompactRunsStore.requestCancel` 记下「正在取消」，同一次只发一次。
  - **启动阶段**（「正在启动对话…」）：不问 Main。启动照常走完（对话已在运行，不白费），然后不再请求压缩，结果「已取消」。
  - **压缩阶段**：问 Main；答 `cancelled: false`（取消先于压缩到达 Main 或 worker）就每 250 ms 再问，直到答 `true` 或这次 `/compact` 结束，最多 40 次。
- 输入框的按钮：没有回合、`/compact` 在途时为「停止（取消压缩）+ 加入队列」（`deriveActionButtons` 的 `compacting`）。

## 5 时间线呈现（第 3 条，自主决定）

### 5.1 行与 id

| 行 | 直播 id | 历史 id / `entryId` | 第一块 | 样式 |
|---|---|---|---|---|
| 命令行 | `dsh-compact-command-<compactionId>` | `h:compact-command-<compactionId>` / `compact-command-<compactionId>` | `<id>:compact-command:0`，文字 `/compact` + 说明 | 与用户气泡同一套类（右侧、80% 宽、`--accent` 面 + `--input` 边），但它是 system 行：不开回合、不进提示词导航、不计入回合「已工作」 |
| 运行行 | `dsh-compaction-<compactionId>` | —（只在直播） | `<id>:compaction-running:0` | 决策 178 的轻量行（`text-meta text-muted-foreground`、`Spinner size-3.5`） |
| 摘要行 | 同上 id，`completed` 后原地变 | 检查点 `h:<MessageId>`，带 `liveMessageId: dsh-compaction-<compactionId>` | `<id>:summary:0`（+ 决策 179 说明行） | 原有「上下文摘要」行 |
| 说明行（没有摘要） | 同上 id，`failed` 后原地变 | `h:compaction-<compactionId>`，带同一 `liveMessageId` | `<id>:compaction-failed:0`，`notice: {key, params}` | 决策 178 的轻量行（`Info` 图标） |

命令行用用户气泡的样子而不是 `/goal` 回答那样的 `SquareSlash` 灰行：它就是用户键入的那一行（Claude Code CLI 也把 `/compact` 作为输入行回显）；但不做成 user 角色，以免它变成一个「回合」——标题、提示词导航、回退 / 分叉目标、轮次计时都按 user 消息工作。

### 5.2 直播（bridge `liveEvents.ts`）

| DSH 事件 | 直播 `session.compaction`（`trigger: 'manual'`，不带 requestId） |
|---|---|
| `compaction/start`（`turn` 不是数字） | `started`，带 `commandMessageId`、`command`（运行时提供键入的说明） |
| 检查点 `user/message`（同一 `compactionId`） | `completed`，`summary` 同投影；说明被用上时带 `instructions` |
| `compaction/end` 无 `error`、未见检查点 | `completed`（只有标题，防止一直转） |
| `compaction/end` 带 `error` | 运行时已知中止原因（取消 / 时限）→ 当场 `failed`；否则等这条命令的 `command/done`（DSH 自己失败时它在 end 之后）→ `failed`。`note = dshCompactNote(原因)`；原因原文写 bridge 日志 `[dsh-bridge] /compact ended without a summary: …` |

`dshCompactNote`（`shared/dshHistory/types.ts`）是 bridge、投影、渲染层共用的一张表：

| 命令的回答 | 键 | 中文 |
|---|---|---|
| `AICLIENT_COMPACT_CANCELLED_REASON` | Compaction cancelled. Nothing was compacted. | 已取消压缩，对话没有改动。 |
| `AICLIENT_COMPACT_TIMEOUT_REASON` | Summarizing took too long, so the compaction was cancelled. Nothing was compacted.（决策 176 原词条） | 生成摘要用时过长，压缩已取消，对话没有改动。 |
| 「could not produce a useful / smaller summary」 | No useful summary could be written, …（决策 176 原词条） | 没能生成有用的摘要，对话没有压缩。这次尝试已记录在会话日志里。 |
| DSH 的「Compaction cancelled.」（agent 被释放） | The compaction did not finish; the context was not compacted. | 压缩没有完成，上下文没有压缩。 |
| 其他句子 | The compaction did not succeed, and nothing was compacted: {{reason}} | 压缩没有成功，对话没有改动：{{reason}}（原句，截 500 字） |
| 没有回答 | The compaction did not succeed, and nothing was compacted. | 压缩没有成功，对话没有改动。 |

`compaction/end` 带 `error` 只在提交之前写（提交阶段失败 DSH 不写带错的 end），所以「对话没有改动」成立。

### 5.3 重开（投影 `projection.ts`）

- `command/run`（`name: 'compact'`）先记下时间；它的 `compaction/start`（无回合，`sourceCommandId` 对上）到来时追加命令行，时间取命令的。没有开始压缩的 `/compact`（「No compactable history yet.」）不出任何行——直播里它也不留行（第 5.5 节）。其他命令仍不投。
- 检查点：手动压缩的摘要行也带 `liveMessageId`。
- `compaction/end` 带 `error`：追加说明行；当时还不知道原因（DSH 自己失败）就先用「没有回答」那句，`command/done` 到了再改成对应的句子。
- 只有 start、日志又往下走了（下一轮、下一次压缩）：补「压缩没有完成」；停在日志末尾的不补（宿主自己的缓存可能正处在压缩中）。
- 命令行的说明来自会话桩：决策 179 的 `compactInstructions` 只记「摘要用上了的说明」；现在压缩一开始（bridge 在 `compaction/start` 进投影之前）就记下键入的说明，标 `unused: true`，摘要真用上时改成不带标记的那条；无论成败，`/compact` 结束时写回桩。投影有两个查找：`compactInstructions`（摘要行下的说明行，只认用上的）与新的 `compactCommandInstructions`（命令行，认全部）；没给后者时退回前者。Main 的预览（`readPage.ts`）、宿主缓存、分叉、金样本对拍都用同一组查找（`compactInstructionsLookups`）。
- 会话分支对话框：两种新节点（命令行、说明行）都是 notice 类节点；回退 / 分叉到它们时按「整次 `/compact`」切——到这次压缩的 `compaction/end` 与命令回答中较晚的一条（`forkSeed.ts` `locate` / `manualCompactEnd`）；决策 178 的自动压缩说明行（`compaction-<id>`）以前在这里找不到节点，顺带补上（切到它的 `compaction/end`）。

### 5.4 渲染层

- 按下回车、通过前置检查（首页拦截、带附件、说明过长、已在压缩、回合进行中——这些仍是原来的 toast，输入框原样）后：清空输入框、滚到底，时间线追加命令行与运行行（`compact-run-<n>`、`compact-run-<n>-command`，`showCompactRun`）；运行行先说「正在启动对话…」（需要启动时）再说「正在压缩上下文…」（`setCompactRunKey`）。
- bridge 的 `started` 到来：这两行原地改成直播 id（`withManualCompactionStarted`，`chatSessions.ts` 的 reducer）；别的窗口、刷新后没有占位行的，在末尾追加两行。`completed` / `failed` 把运行行原地换成摘要行 / 说明行。
- `/compact` 的答复到来（`settleCompactRun`）：
  - 成功且带回摘要行（`h:` 行，带 `liveMessageId`）→ 放在运行行（或 bridge 已变成的直播摘要行）原位；占位命令行若还没被改名，按摘要的 `liveMessageId` 改成 `dsh-compact-command-<id>`。没带回摘要行 → 撤掉占位行，toast「已压缩上下文」（与以前一样）。
  - 跑过但没有摘要 → 运行行还在转的，写成对应说明；bridge 已写的不动（两边同一张表）。
  - 没跑成 → 撤掉占位行（bridge 已命名的行不动），toast，命令放回输入框。
- 运行行的计时与提示（`DshCompactionRow`）：本窗口这次 `/compact` 在压缩阶段时显示「正在压缩上下文… N 秒」（满 60 秒「N 分 M 秒」，每秒刷新，从进入压缩阶段起算），行尾「按 Esc 取消」，按下后变「正在取消…」；启动阶段只显示提示。别的窗口的运行行没有计时和提示（取消只在发起的窗口）。
- 回合结束时把仍在转的压缩行改成「没有完成」（决策 178 §4.4）**不再作用于手动压缩的行**（它不属于回合；`isManualCompactionRow`：占位 id，或桶里有同一压缩的命令行）。
- 摘要行、说明行、命令行都不计入所在回合的「已工作」时长（`bodyMetadata`）。

### 5.5 结局一览

| 结局 | 时间线 | toast | 输入框 |
|---|---|---|---|
| 成功（带回摘要行） | 命令行 + 摘要行（+ 说明行） | 无；说明没用上时「已压缩，但没有用上附加说明」（决策 179） | 已清空 |
| 成功（没带回摘要行） | 无 | 「已压缩上下文」 | 已清空 |
| 取消（任一阶段） | 命令行 + 「已取消压缩，对话没有改动。」 | 无 | 已清空 |
| 超时 / 没有有用的摘要 / DSH 其他原因 | 命令行 + 对应说明 | 无 | 已清空 |
| 压缩途中对话停止运行（`worker_compact_interrupted`） | 命令行 + 决策 176 原句（重开看摘要是否写入） | 无 | 已清空 |
| 回合进行中、已在压缩、说明过长 / 不支持、没有可压缩内容、对话没能启动、启动前停止运行 | 无（占位行撤掉） | 原来的 toast | 命令放回（输入框已有别的内容时不覆盖；已切到别的对话时写进那个对话的草稿） |

### 5.6 输入框

开始即清空，是「像 Claude Code CLI」与「压缩期间写的消息进排队」两条要求的共同结果：命令已经出现在时间线里，输入框里再留一份会和新写的消息混在一起。决策 176 「留在输入框便于再按一次」的用意由「没跑成时放回」保留。

## 6 CG-4：流式段落的 key

- `TurnTextItem` 的已封闭段落以 `key={segment}` 渲染；同一段文字（`---`、「示意如下：」）再次出现时两个子节点同 key，React 每次刷新都告警（取证 2,227 条），并可能丢掉或重复其中一段。
- 改为 `keyedClosedSegments(segments)`（`chatMarkdownPolicy.ts`）：key = 「这段文字之前出现过几次」+ 文字。段落列表只在末尾增长，已有段落的 key 不变（保留原来用内容作 key 的目的：切点移动时前面的段落不重挂），且唯一。
- 测试：纯函数 `[CG4-1]`～`[CG4-3]`；挂载 `TurnTextItem`（导出供测试）流式五次增长，重复段落各出现应有的次数、顺序正确、没有 key 告警 `[CG4-MOUNT]`；把 key 临时改回内容，`[CG4-MOUNT]` 失败（React key warning），改回后通过。`[FB1-7]` 静态钉子随之改写。

## 7 录制场景与假网关

- 假网关（`fake-gateway.mjs`，`dsh-p0-2`）：摘要请求的会话里带 `P1-COMPACT-SLOW` 时，摘要分 60 块、每块间隔 250 ms 流出（约 15 s），供驱动在流式途中取消。
- 新场景 **`compact-cancel`**（独占宿主与工作区，排在最后）：第一轮带 `P1-COMPACT-SLOW`、第二轮列目录 → 带说明 `保留失败经验（P1-COMPACT-CANCEL）` 的 `worker.compact`（不等）→ 等到它的 `started` → `worker.compact.cancel`（答 `{cancelled: true}`，此时压缩仍占着请求链）→ 压缩答 `WORKER_COMPACT_CANCELLED`（不可重试）→ 直播只有 `started`、`failed`（说明「已取消」）→ 桩里 `compactInstructions` 一条 `unused: true` → 第三轮 `P1-AUTOCOMPACT` 答「answered with the full context」（什么都没压）。录制器自查阶段序列与答复，不符就报错。已 `--update --only compact-cancel` 录制。
- `compact`、`compact-instructions` 两个场景改为把压缩期间的直播事件放进流（排在两轮之后），并自查阶段为 `started`、`completed`。

## 8 验证（2026-10-11，开发机，一次一个测试进程，每次先看 `free -m`）

### 8.1 新增与改写的测试

- 投影 `projection.test.ts`：`[180-PROJ-1]`～`[180-PROJ-6]`（命令行与摘要行的直播 id；只键入未用上的说明只上命令行；没有摘要时按 `command/done` 措辞、两种先后都对；没开始压缩的 `/compact` 与其他命令不出行；开始后没收尾、日志往下走补「没有完成」；`dshCompactNote` 表）；`[178-PROJ-1]`、`[179-PROJ-1]` 改写（手动压缩多了命令行、摘要行带直播 id）。先写的投影测试在实现前 7 项失败。
- bridge `liveEvents.test.ts`：`[178-LIVE-4]` 改为「手动压缩同样显示」；新增 `[180-LIVE-1]`～`[180-LIVE-3]`（取消 / 时限 / DSH 失败等 `command/done`），每例用投影核对直播 id 与文字。
- bridge `commandsAndState.test.ts`：`[180-B-01]`～`[180-B-06]`（取消：带原因中止、等 DSH 收尾、不可重试、日志里的回答；摘要已落地按成功答；时限原因与 600 s 默认、Main 余量大于收尾时限；DSH 不收尾时按收尾时限答复；租约期间取消不问 DSH；键入的说明以 `unused` 写进桩、重开的命令行带说明）。假命令服务的 `command/done` 改为与 DSH 一样记 `error.message`，处理器多收一个 `commandId`。
- `bridgeRpcServer.test.ts`：`[180-RPC-1]`～`[180-RPC-3]`（取消在压缩占着链时当场答复、排在其后的 `stop` 仍等；链上排队的压缩被取消后不运行、之后的不受影响；无在途、错代次、坏载荷、无运行时）。
- `forkSeed.test.ts`：`[180-CUT]`。
- Main `WorkerManager.test.ts`：`[180-WM-1]`～`[180-WM-3]`（压缩在途才转发取消、worker 的取消答复原样返回；转发失败答 `false` 不抛；压缩在途不回收、结束后重新计时）。
- 渲染层：`compactCommand.test.ts`（`[CC-180-01]`、`[CC-180-02]`，改写 `[CC-02]`、`[CC-04]`、`[CC-05]`、`[CC-11]`、`[CC-176-02]`、`[CC-176-03]`、`[CC-176-05]`）；`compactStartMount.test.ts`（挂载真 `ChatComposer`：改写 176 / 178 / 179 各例为时间线断言，`[176-C-09]` 改为「启动阶段 Esc 取消」；新增 `[180-C-01]`～`[180-C-05]`：摘要原地替换与命令行改名、直播改名再收敛、压缩阶段 Esc 问 Main 且只问一次、停止键取消与「先答 false 再问」、执行前被拒放回带说明的命令）；`compactTimelineMount.test.ts`（新，挂载真 `MessageTimeline`：命令行是用户气泡样子但不开回合、计时「1 分 15 秒」与「按 Esc 取消 / 正在取消…」、启动阶段只有提示、带原因的说明行中文）；`queueRelease.test.ts`（`[180-AB]`）；`composerStopStatic.test.ts`（`[E-1]`、`[K-3]` 改写）；`sendRefusalWiring.test.ts`、`messageTimelineWiring.test.ts`（`[FB1-7]`）改写；`chatMarkdownPolicy.test.ts`、`turnTextSegmentsMount.test.ts`（CG-4）。
- stores：`manualCompactionRows.test.ts`（新，`[180-S-1]`～`[180-S-4]`）；`chatSessionActions.test.ts` 的 `showCompactionSummary` 两例改为 `showCompactRun` / `settleCompactRun`（`showCompactionSummary` 已无调用方，删除）。
- 金样本：`dshHistoryGolden.test.ts` 场景清单加 `compact-cancel` 并新增其断言，`compact` 的断言改为「命令行 + 摘要行」，投影查找按桩的 `unused` 规则；`dshStreamReplay.test.ts` 改写 `compact`、`compact-instructions` 两个场景、新增 `compact-cancel`，`REOPEN_DIFFERS` 去掉 `compact-instructions`（直播现在也有这两行）。
- 变异检查：把取消改回排在链上、去掉驱逐保护、回合结束也结算手动压缩行、预算改回 45 s，`[180-RPC-1]`～`[180-RPC-3]`、`[180-WM-3]`、`[180-S-3]`、`[180-B-03]` 共 6 项失败；四个文件用备份恢复，`cmp` 与改前一致。

### 8.2 门禁

- `pnpm typecheck`、`typecheck:dsh-host`（`tsc --noEmit -p src/dsh-host/tsconfig.json`）：通过。
- `biome check`：本决策改动与新增的 53 个代码 / 样本文件无问题（`i18n.ts` 只检查，格式问题手工改）。
- `vitest run src/dsh-host`：52 个文件通过、3 个跳过（真宿主集成与 win32），1084 项通过。
- `vitest run scripts`：13 个文件、230 项。
- `vitest run src/renderer/components/chat`：170 个文件、3358 项。
- `vitest run src/renderer/stores`：45 个文件，883 项通过；4 项失败，都是第 9 节等重录的 `dshStreamReplay`。
- `vitest run src/main/services/agent-host src/main/ipc`：53 个文件通过、1 个跳过，862 项。
- `vitest run Static Scan Wiring`：79 个文件、823 项。
- `vitest run src/shared/__tests__ src/shared/dshHistory`：44 个文件，854 项通过（含词条覆盖）；5 项失败，都是第 9 节等重录的 `dshHistoryGolden` 对拍。
- `bridge-smoke.ts`：exit 0。
- `bridge-record.ts --check`（全量 36 个场景）：只有第 9 节的 4 处差异（`rpc.compact`、`stream.compact`、`rpc.compact-instructions`、`stream.compact-instructions`），`log.*` 无差异；新场景 `compact-cancel` 在全量顺序下 0 差异；两次录制（单独与全量）逐字相同。
- 没有起 Electron、没有整包构建；模型请求只走本地假网关。

## 9 需要重录的已有场景

`compact`、`compact-instructions` 的 `rpc` / `stream` 样本因本决策变化（`log` 不变），本决策**没有重录**：

- `rpc.*`：`compact.eventsAfter` 0 → 2；`compact.compacted.result.summary` 多 `liveMessageId: dsh-compaction-id-14`；`history.page.messages` 在摘要行前多一行命令行（`h:compact-command-id-14`，`/compact` 或 `/compact 保留未完成的任务和失败经验（P1-COMPACT-NOTE）`），摘要行多 `liveMessageId`，`totalCount` 6 → 7；`tree` 多一个 notice 节点、叶子后移；`compact-instructions` 重开的 `bootstrap[1].initialHistory` 同样变化。
- `stream.*`：两轮之后多两条 `session.compaction`（`started`，带 `commandMessageId`、`command`；`completed`，带 `summary`，`compact-instructions` 还带 `instructions`）。
- 用 `--check --artifacts` 录到临时目录后临时装进 fixtures 跑过受影响的三个测试文件（438 项全过），随即按备份还原，sha256 与原样本一致。重录前这 9 项会失败：`dshHistoryGolden` 的 `compact` / `compact-instructions` 页、树、重开页对拍 5 项，`dshStreamReplay` 的 `compact` 1 项、`compact-instructions` 2 项、「重开读起来与直播一样」的 `compact-instructions` 1 项。
- 重录：`out-node-runtime/node src/dsh-host/tools/bridge-record.ts --update --only compact,compact-instructions`。

## 10 风险

1. **取消来晚**：摘要已经写成（DSH 在提交后的 `flush` 期间才收到中止），这一次按成功显示摘要行，「已取消」不出现。符合磁盘，但用户按了取消仍看到压缩完成。
2. **压缩期间排在链上的其他请求**：翻页、斜杠菜单、面板、权限设置在 Main 侧 10 s 超时，压缩结束后才被 worker 执行（翻页失败卡、菜单为空等）。45 s 时已有，10 分钟时更容易遇到；本决策不改链的串行（只给取消开口子）。
3. **取消只在发起的窗口**：别的窗口、刷新后的窗口看得到运行行，但没有计时和「按 Esc 取消」；刷新后要取消只能等它结束或结束对话。
4. **10 分钟仍可能不够**：取证估算 GPT 约 30 token/s，600 s 约 1.5 万 token 的摘要；摘要上限仍是 65,536（决策 177 是否下调另议），写满会超时取消（不写盘，安全）。
5. **命令行的说明依赖会话桩**：桩写失败（Windows 上文件占用时 rename 失败）只让重开后的命令行少说明；DSH 自己的客户端看不到这一行。
6. **启动阶段取消**：要等启动走完才显示「已取消」（几秒），启动本身不撤销（对话保持运行）。
7. **没开始压缩的 `/compact` 不留行**：「还没有可以压缩的内容」等仍是 toast，与重开一致（日志里没有可以投的压缩），但与「跑过的在时间线说明」不是同一处。
8. **会话分支里的新节点**：回退 / 分叉到命令行或说明行切在整次 `/compact` 之后；与选摘要行时相同。

## 11 Windows 现场清单（下一个测试包起）

1. 有几轮内容的对话输入 `/compact 保留未完成的任务` 回车：输入框立即清空，时间线末尾出现右侧气泡样子的「/compact 保留未完成的任务」，下面一行转圈「正在压缩上下文… 3 秒 · 按 Esc 取消」，秒数递增，满一分钟显示「1 分 5 秒」。
2. 完成后转圈那一行原地变成「上下文摘要」行，下面「本次压缩的附加说明：…」；命令行仍在上方。关掉再打开对话：两行都在、同样位置、只有一份。
3. 压缩进行中按 Esc：提示变「正在取消…」，随后这一行变成「已取消压缩，对话没有改动。」；再发一条消息，回复正常（没有压缩过）。关掉再打开：命令行与「已取消」仍在。
4. 压缩进行中点输入框右侧的停止键（悬停提示「取消压缩」）：同第 3 条。
5. 重启应用后打开老对话直接 `/compact`：先「正在启动对话… · 按 Esc 取消」，再「正在压缩上下文… N 秒」；在启动阶段按 Esc：启动完成后显示「已取消」，没有发起压缩。
6. 压缩进行中写一句话回车：进入排队条、输入框清空；压缩结束（成功、取消或失败）后自动发出。
7. 公司网关 GPT 6.1 Sol 的 `/compact`（取证 CG-1 的情形）：不再在 45 秒被取消；记录实际耗时与输出 token（取证计划建议补测）。
8. 回合进行中输入 `/compact`：仍是「等这一轮结束后再压缩」，时间线不出行，命令留在输入框。
9. 很短的对话 `/compact`：仍是「还没有可以压缩的内容」toast，时间线不出行，命令放回输入框。
10. 首页输入 `/compact`：仍是「这个命令需要先打开一个对话」；带附件的 `/compact xxx` 仍当普通消息。
11. 长回复里重复出现的段落（如多次「---」「示意如下：」）流式时每段都在、不多不少；开发者工具控制台没有 `Encountered two children with the same key`。
12. 会话分支对话框：有 `/compact` 的对话里能看到命令行、摘要 / 说明行节点；从命令行节点分叉、回退可用。
13. 中文界面下所有新句子完整不截断；暗色主题下命令行气泡、计时与提示可读。

## 12 用户审批

- [x] 第 1 节（用户 2026-10-11 的裁决）
- [ ] 第 3 节时限表：Main 630 s（余量 30 s）、收尾等待 5 s、取消转发 5 s、渲染层每 250 ms 再问最多 40 次；压缩在途不回收不驱逐
- [ ] 4.1 取消用新 RPC `worker.compact.cancel`（越过请求链），不让 `stop` 识别在途压缩
- [ ] 4.2 / 4.3 中止原因写进 DSH 日志；中止后等收尾；摘要已落地按成功；链上排队的压缩也可取消；`WORKER_COMPACT_CANCELLED` 不可重试
- [ ] 4.4 Esc 与停止键在没有回合、`/compact` 在途时取消压缩；启动阶段不问 Main
- [ ] 5.1 命令行用用户气泡的样子但是 system 行（不开回合）；运行 / 说明行沿用决策 178 的轻量行
- [ ] 5.2 / 5.3 手动压缩的直播事件、说明措辞表、命令行由 `command/run` + `compaction/start` 投影、没开始压缩的 `/compact` 不出行、桩条目 `unused`
- [ ] 5.4 计时只在发起窗口、「按 Esc 取消 / 正在取消…」
- [ ] 5.5 / 5.6 结局一览：跑过的在时间线说明、没跑成的 toast 并放回命令；输入框开始即清空
- [ ] 5.3 末条：会话分支里新节点与自动压缩说明行的切点
- [ ] 第 6 节 CG-4 的 key 规则
- [ ] 第 7 节假网关 `P1-COMPACT-SLOW` 与新场景 `compact-cancel`；`compact`、`compact-instructions` 两个场景的流里加入压缩事件（待重录）
- [ ] 第 10 节风险的接受程度
- [ ] 第 11 节 Windows 现场清单
