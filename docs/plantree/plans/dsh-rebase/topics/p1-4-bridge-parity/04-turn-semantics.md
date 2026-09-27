# P1-4 分片 04 · 回合语义（插话、重试、附件）、其余事件与主进程只读回放

Role: detail shard。上位：[P1-4 方案](../p1-4-bridge-parity.md)。回答调研问题 4、5、6。我方行号指 worktree HEAD `941ab5b1`；DSH 事实见[分片 02](02-dsh-facts.md)。本分片是设计，还没有实现和运行过。

## 1 Ctrl+Enter 插话（D4）

**v1.0.3 的语义**

- `worker.interject` 只是一个「在下一个边界停下」的信号，消息本身留在渲染层的队列里（`workerRpc.ts:589-607`）。
- native 的做法（`agent-loop/index.ts:348-374`）：当前这一轮（一次模型调用加它的工具）照常跑完，然后 run 结束，发 `session.completed {stopCause:'interjected'}`（`:1309-1318`）；委托出去的子代理不等待。
- 决策 046：worker 没有回合时，回 `{interjected:false, turnActive:false}`，Main 据此清掉忙碌锁（`WorkerManager.ts:2124-2130`）。

**DSH 上的做法（推荐 A）**

- `interject()` 分两种情况：
  - bridge 没有回合（`this.turn` 为空，且 agent 处于 `idle`）→ 回 `{interjected:false, turnActive:false}`。
  - 否则置位 `interjectRequested`，回 `{interjected:true, turnActive:true}`。goal 续跑、后台任务唤醒这类合成回合也算在内。
- 在本回合的 `session/event` `step/end` 回调里，如果标志已置位，**同步**调用 `agent.cancel({kind:'hook', reason:'aiclient-interject'}, {keepInbox:true})`。
  - 回合机器在 `step/end` 之后紧接着同步检查中止信号（`dsh-agent-loop/lib/index.js:976-982`），所以下一步还来不及 claim 输入，回合就以 `aborted{hook}` 结束了。
  - `keepInbox` 保住已经 inject 进来的后台任务通知等内容。
  - 落盘的结束原因能和用户 Stop（`{kind:'user'}`）区分开，历史投影可以准确还原出 `stopCause`（分片 03 §1）。
  - **只在本步成功结算时才 cancel**：本步最后的结算是 `assistant/message`（而不是 `assistant/attempt`）时才动手。如果本步已经失败，`step/end` 仍然会在 finally 里追加；这时候 cancel 会让 `turn()` 的 catch 把错误读成 `aborted{hook}`（`dsh-agent-loop/lib/index.js:993-1009`），失败就被伪装成了插话。
- `turn/end` 的映射：
  - `aborted{hook,'aiclient-interject'}` → `session.completed {stopCause:'interjected'}`，然后 `idle`；
  - `completed`，且标志已置位（插话到达时已经是最后一步）→ 同样映射；
  - 其他结局照常映射，标志清零。
- **与 native 的差异**：DSH 的后台子代理、后台任务不受这次 cancel 影响（推断，`keepInbox` 只影响收件箱；需要看 dsh-jobs 的所有权）；goal 回合会被暂停（`dsh-goal-round-driver/README.md:53`），P1-7 的 goal 条要能显示这一点。
- **需实测**：在监听回调里同步调用 `cancel`，是否可能被别处同步追加事件重入（`Session.append` 禁止发布期间重入，`dsh-session/lib/index.js:1412`）。`cancel` 带 `keepInbox` 时不会追加事件，推断是安全的。

**备选**

- B：用 `agent/pre-step` 拒绝下一步，回合以 `blocked` 结束。缺点有三：已经 claim 的 inject 通知会被吞掉（`dsh-agent/lib/types/runtime-types.d.ts:267-281`）；`blocked` 也可能来自 goal 的竞态栅栏或其他插件，落盘记录有歧义；要把输入重新放回收件箱，还得在 waterfall 里改收件箱，这是没验证过的用法。
- C：改用 DSH 原生的 `steer`，插话直接进入当前回合的下一步。这是产品语义变化：协议要能带上消息正文，渲染层的排队条、`stopCause` 流程、决策 046 都要改。可以作为以后的增强另立项。

## 2 重试上一轮（D3，需用户拍板）

**v1.0.3 的语义**（T135 / 决策 045）

- `mode:'retry'`，`text` 为空，不带附件（`workerRpc.ts:433-457`、`:1015-1022`）。
- 从失败前的上下文重跑，不追加用户消息；已完成的工具轮保留（`retry.ts:1-14`）。
- 没有被中断的回合可以重跑时，拒绝 `WORKER_RETRY_UNAVAILABLE`，此时不发任何事件（`nativeWorkerRuntime.ts:408-431`）。
- 渲染层把 `running` 当作已受理的证据，因为重试没有用户回显（`ChatComposer.tsx:1861-1866`）；被拒时，原消息放回输入框（`MessageTimeline.tsx:445-453`）。

**DSH 的事实**

- 失败的尝试记为 `assistant/attempt`，不进模型上下文；已完成的工具轮都在。所以「失败前的上下文」天然就是当前的 surface，不需要移动任何指针。
- 但回合结束之后，开新回合必须至少有一条消息：首批为空时直接判完成（`dsh-agent-loop/lib/index.js:963-965`）；也没有「在回合之外重跑」的接口（分片 02 §3）。

**推荐 A：隐藏的续跑提示**

- **受理条件**
  - bridge 没有回合，agent 空闲；
  - 当前会话最后一个 `turn/end` 的 kind 是 `error` 或 `interrupted`（崩溃），或者 `aborted`（与 native 一致：Stop 之后的回复也不算成功，`retry.ts:46-68`）。
  - 其余情况（`completed`、`blocked`、`max-tokens`、没有回合）一律在发出任何事件之前抛 `WORKER_RETRY_UNAVAILABLE`。
- **执行**
  - 以本次的 `requestId` 开一个 bridge 回合，发 `session.status running`，不回显用户消息。
  - `followup(createUserMessage({content:[{type:'text', text: RETRY_NOTE}], source:{kind:'aiclient-retry', form:'notice', summary:'Retry after a failed request'}}))`。
  - `RETRY_NOTE` 用一句英文，比如「The previous model request failed. Continue from where it stopped.」。
- **模型看到的**：失败前的上下文，加上一条短提示。Stop 之后，已流出的半截正文本来就在上下文里。
- **用户看到的**：提示在直播和历史里都不显示。失败回合的错误占位在历史里也被隐藏（分片 03 §1），观感和 native「失败回复移到旁支」一致。
- **与决策 045 的差异**：模型多看到一条 user 角色的提示，同时也多一次 KV 缓存追加。需要用户确认，可以把「不追加用户消息」改写为「不追加用户可见的消息」。

**备选**

- B：挂起失败的请求。挂一个 agent 级的 `agent/request-error` 监听，在 `dsh-llm-retry` 放弃之后接住失败：先对外发 `session.failed`，但 DSH 的回合保持挂起；用户点「继续」就返回 `{kind:'retry'}`，在同一个 step 里重发；发新消息、Stop、超时则放弃。
  - 优点：真正不加消息。
  - 缺点：挂起期间 agent 一直处于 `running`，goal、后台任务唤醒、压缩、回退都被挡住；要压住这个回合最终的第二个终态；宿主一崩就再也续不上，只能退回 A；Main 的忙碌锁和 Stop 看门狗也要特殊处理。复杂而且脆弱。
- C：分叉到失败回合之前，再重发原消息。会丢掉失败回合里已完成的工具轮，重跑时副作用会重复，违反决策 045 的核心理由。

## 3 图片附件

- **我方现状**
  - `SessionAttachment {kind:'image'|'text', mediaType, data, name?}`（`agentHost.ts:42-49`）。
  - 单个附件 5 MiB（`attachmentIo.ts:36`）；每轮写入会话的字节另有预算（`runtime/plugins/agent-loop/attachments.ts:38-55`）。
  - 图片作为内容块发给模型，文本附件并进正文，格式是 `--- name ---\n…`（`:85-138`）。
  - P1-1 期间带附件的发送一律拒绝，错误码 `WORKER_DSH_UNSUPPORTED`（决策 010）。
- **DSH 上的做法**
  1. 文本附件照 native 的方式并进 text，不用 FileBlock。
  2. 图片调用 `ctx.attachments.admitPromptContent([{type:'text', text}, {type:'image', mediaType, data, name}…])`，得到 `ImageAttachmentRef`，再拼成 `createUserMessage({content:[text 块, {type:'image', attachment}…], source:{kind:'user'}})`。
  3. admit 失败（`AttachmentError` 的格式、大小、像素等错误码）时，在发任何事件之前抛 `WORKER_ATTACHMENT_REJECTED`，带原始错误码和文件名。渲染层按现有「附件被拒」的路径显示（需要对照 `attachment_size_limit` 的文案）。
  4. 我方的限额比 DSH 严（5 MiB 对 20 MiB），留在渲染层和 Main 两道把关。bridge 再查一次单个附件 5 MiB，防止绕过（与 native `attachments.ts:17-38` 同理）。格式两边都是 PNG / JPEG / GIF / WebP。
  5. 回显：`message.started` 带 `attachments: [{kind, mediaType, name}]`。历史从 image 块恢复附件信息，文件名也能恢复。
- **和 `read_image` 的关系**
  - native 的读图是 `read` 工具的图片分支（提交 `7fe97881`）；DSH 是单独的 `read_image` 工具，`read` 只读 UTF-8。
  - 两者都要求路由对应的模型声明支持图片输入。P1-5 生成 `llm-pi-ai` 路由时，要给支持图片的模型写上图片模态（字段名待 P1-5 核对）；否则 `read_image` 会被拒，用户发的图也只会变成占位文本（推断）。
  - 工具行文案（`read_image` 显示为「读取图片」）归 P1-7。工具结果只有图片时，输出 `(image)`。
- **差异**：DSH 会把图片归一化，缩到 2048² 像素预算、目标 4 MiB 以内，模型拿到的是处理过的图；native 直接发原图。

## 4 用量（`usage.updated`）

payload 形状见 `shared/piUsage.ts:40-123`，用 `buildPiUsagePayload` 构造（`:331`），这个函数不依赖 runtime，可以直接复用。

| 我方字段 | DSH 来源 | 说明 |
|---|---|---|
| `input` / `output` / `cacheRead` / `cacheWrite` | `assistant/message.usage` 的 `inputTokens`（不含缓存）/ `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` | DSH 各项互不重叠，与 pi-ai 的 `input` 口径一致 |
| `totalTokens` | `usage.totalTokens`；缺失时取四项之和 | — |
| `reasoning` | `usage.reasoningTokens` | 缺失就不写，沿用该字段的约定 |
| `costUsd` | 无 | P1-5 把定价放进路由或 `modelCatalog`，bridge 按路由算；在那之前给 0，并加 `unreported`（推荐）或者直接不写 |
| `context {tokens, contextWindow, percent}` | `contextPressure.pressureTokens`（最新一次 provider 报告的 prompt 大小），缺失时取本步 input + cacheRead + cacheWrite；窗口取 `session.requestContext().contextWindow` | 与 native「只报告、不估算」的原则一致 |
| `session`（累计） | `sessionProjections.stateOf(session,'tokenUsage').totals`；`turns` 为带 usage 的 step 数 | 投影覆盖整个日志，重启后累计不丢 |
| `pending`（进行中） | 流里的 `usage` chunk，每条消息只发一次 | 用 `buildPiInterimUsagePayload` |
| `unreported` | 本步以 aborted / error 结束、流已开始，但没有 usage | 与 T125 的规则一致 |
| `delegated` | 子会话的用量 | 归 P1-7 |

发送时机：每个带 usage 的 `assistant/message` 发一次，相当于 native 每次 pi turn_end 发一次。

## 5 其余映射

| 项 | 做法 | 子任务 / 边界 |
|---|---|---|
| 思考的起止 | 流里的 `block-start` / `block-end`，blockType 为 `reasoning` → `thinking.started` / `thinking.completed`；step 关闭时如果思考块还开着，补一个 completed | 4d |
| 流式工具参数 | 按 toolCallId 累积 `argumentsDelta`，用 partial JSON 生成摘要，100 ms 节流，参数完整时发完整 input。生成端 `runtime/events/streamingToolArgs.ts` 移到 `src/shared/`（P1-12 会删 runtime） | 4d |
| `execStartedAt` | 在 agent 级挂 `tools/execute`，打时间戳，然后调 `next()`；bash / pwsh 发 `tool.updated {execStartedAt}` | 4d |
| 工具行标志 | `notStarted` / `stopped` / 新增 `outcomeUnknown`，fs 的 `meta` → `review`。`runtimeEvents.ts` 的 `ToolOutcomeDetails` 和 `sessionHistory.ts` 的 tool_result 各加可选字段 `outcomeUnknown`；渲染层工具行加「结果未知（引擎中断）」文案（中英） | 4d（文案很小，不必等 P1-7） |
| 重试横幅 | `llm/retry` → `session.status {retry}`；`llm/retry-started` → 清掉横幅 | 4d；策略归 P1-5 |
| 问答 | 挂 `user-questions/request` answerer → `question.requested`；回答时映射回去（分片 01 §1）；发起方中止时自动撤卡 | 4d；plan 模式的入口归 P1-6 |
| 命令 | `commands()` → `ctx.commands.list(agent)`。`startSend` 里，以 `/` 开头且是已知 DSH 命令的，走 `execute`：先 `running`，结果发 `custom.message`（customType 为 `dsh:command`），然后 `session.completed`、`idle`，不开模型回合；未知的 `/xxx` 仍当作普通提示发出（与 native 一致） | 4d；`/goal` 等的界面归 P1-7 |
| `/compact` | `worker.compact` → `execute(agent,'/compact')`，预算 45 s；`instructions` 非空时拒绝（DSH 不接受参数）。直播：`compaction/summary` 加上替换节点 → system 行「Context summary」（与 `projector.ts:812-830` 一致） | 4d |
| 通知 | 非 `user` 来源、且 `form:'notice'` 的 user 消息 → `custom.message`；实时、历史都显示为系统注记 | 4d；样式归 P1-7 |
| goal / todo / plan / 权限状态 | 新事件 `session.projection {key, view}`（D7）。bootstrap 之后先发一次快照，之后跟随 `onChanged` | 4d 产出，P1-7 消费；权限的 setter 归 P1-6 |
| 每轮 model / effort | bootstrap 时用 `installModelSelection(agent.ctx, ref)`；`startSend` 用 P1-5 提供的 `resolveRoute(model, effort)` 设置 `ref.current`；`message.started.model` 报实际路由。P1-5 落地之前固定用默认路由 | 4d；解析归 P1-5 |
| 失败 | `turn/end error` → `session.failed {error: failure.message, errorCode: failure.code}`。401、配额之类映射到我方的恢复卡，归 P1-5 | 4d / P1-5 |
| 能力清单 | `capabilities`：`skills`（`ctx.skills` 目录数）；`subagents`（定义数）；MCP 看 DSH 是否挂了（`dsh-mcp-resources`），没挂就不写该字段 | 4d |
| `reload` | 仍然不支持。它只服务 pi TUI 切换（`usePresentationSwitch.ts`），P1-1 已禁止 DSH 会话开 TUI | P1-11 |
| 预览（`browser_preview`） | 没有对应物，不发；`present` 工具归 P1-7 | — |
| 权限 setter、`permission.activity`、`allow_session` | 不在 P1-4 范围 | P1-6 |
| 子代理活动 | 不在 P1-4 范围 | P1-7 |

## 6 主进程只读回放（D5）

**要解决的问题**

- 决策 030 的初衷是「只是看一眼，不该占一个 worker slot」。
- 到了 DSH 下又多一条：用恢复来预览，会取写锁，还会往日志追加 `session/end-seed`（P0-6），看一眼就改了日志。
- P1-1 让 DSH 行的预览直接回 `session_replay_unavailable`，于是一律退回恢复。

**推荐 A：宿主读取**

- **宿主控制消息**（叠加在 P1-3 的信封上，和 `ping` / `gc` 同级）：`{host:'readPage', id, stubFile, logicalSessionId, offset, limit}` → `{host:'page', id, page}` 或 `{host:'page', id, error}`。
- **宿主侧**：读桩，校验桩里的 `logicalSessionId`；`sessionQuery.observeSession(dshId, {projectionMode:'none'})`；`projectDshHistory` 投影、分页；最后释放这份观察。
  - 活会话读的是内存快照，所以没有 native 那种「文件落后于 worker」的问题（参见 `SessionReplayReader.ts:22-27`）。
  - 冷会话补上中断收尾，但不写盘。
- **Main 侧**：`CHAT_READ_SESSION_PAGE`（`chat.ts:906-960`）对 DSH 行改走这个请求，照旧广播 `session.history`，mode 为 `branch` 或 `older`；`worker_active` 的判断保留。宿主不在或读取失败时，报 `session_replay_unavailable`，渲染层退回恢复，这是现有的路径。
- **代价**：预览依赖宿主在线；宿主被空闲关停之后，第一次预览要冷启约 0.8 s（P0-6）。

**备选**

- B：Main 自己解码。
  - Electron 39.2.7 的 Node 22.21.1 能解 zstd；不过日志是多个独立帧拼起来的，最后一帧可能残缺，还要处理代际选择、`projectKey` / `encodeSegment` 的路径规则、`sourceEventSeqs` 的存储形式、`KNOWN_SESSION_EVENT_TYPES` 校验。等于把 DSH 的读盘逻辑再实现一遍。
  - DSH 还处在 developer preview，格式一升级这份实现就要跟着改。
  - 在加密机上，Electron 读 `dsh-home` 里的文件能不能拿到明文还不知道，要等 P1-13 核实。
- C：把 DSH 持久化库搬进 Main。这个包是 Cordis 插件，要求 Node ≥ 24（Electron 是 22），依赖 DSH 的模块解析方式，还带原生插件，会把 Main 的打包拖进 DSH 的版本管理。不可行，或者说得不偿失。

**旧 pi 会话与后续边界**

- 旧 pi 会话在 P1-9 之前继续走 `SessionReplayReader`（决策 005）。这条链依赖三个文件：
  - `runtime/plugins/session/codec.ts`（`decodeSession`、`branchEntries`、`SESSION_MAX_BYTES`）；
  - `runtime/plugins/session/legacy.ts`（`convertLegacySession`）；
  - `agent-host/piSessionTimeline.ts`（`projectPiSessionHistory`）。
- P1-9 的转换器（pi → DSH）也需要这条解码链。所以 P1-12 删 `src/runtime` 时，要把这三块搬到 `src/shared/legacyPiSession/`（只保留类型依赖，去掉对 `pi-agent-core` 的运行时依赖），不能删掉。建议在 roadmap 的 P1-12 条目里补登这一句。
