# 决策 172：Ctrl+Enter 插话等待送达时，正在运行的回合不再提前结算、折叠（GitHub issue #8）

日期：2026-10-10。**状态：§2（修法）、§3（待送达气泡置灰）为自主决定，待用户审批；§4「撤回」需要改 bridge 协议，未实现，待用户拍板。**

来源：GitHub issue #8（dssaiy，`1.1.0-dsh.8`，Windows 11）。在回合进行中按 Ctrl+Enter 插话，正在运行的工作组立刻折叠成「已工作 2分24秒」，展开后能看到最后一步（工具调用或思考）其实还在执行；同时插话气泡显示「待送达」，下方又出现一个新的转圈和「工作中」。报告人的诉求：

1. 等待期间旧组保持「工作中」，继续显示正在等的输出；
2. 等待期间插话置灰显示「待送达」，并且可以撤回（初步想法，请开发机评估）；
3. 上一步完成、插话送达后，旧组正常折叠，用户消息进入新组，agent 开始对应的输出。

代码提交：`601195fe`。

修订关系：

- [决策 093](093-interject-via-dsh-steer.md)（已批准）：语义不变——插话进 DSH 收件箱的 next-step，在下一个步边界并入当前回合。本决策只改渲染层在「交给 DSH」到「DSH 取走」之间怎么画。
- [决策 111](111-p1-4c1-turn-semantics-choices.md) 第 12 条：「送达之前，气泡排在时间线末尾；送达后，正式的用户行出现在 DSH 实际取走它的位置」——位置不变；改的是待送达气泡不再作为一行用户消息参与切回合。
- [决策 118](118-p1-7a-goal-todo-round-choices.md) 第 24 条（待审批）：待送达气泡的样式补一条，正文与附件名改用 `text-muted-foreground`（§3）。
- [决策 094](094-stop-keeps-inbox.md)：Stop 时还没取走的插话留在收件箱里，气泡照旧留在末尾；它不再开出一个只写着「已工作」的空回合。
- 用户 2026-09-24 裁决（用户自己结束的回合，结算后默认展开）不变：DSH 下插话不写 `stopCause`，所以送达后旧回合按普通结束处理、正常折叠，正是 issue 期望第 3 条。

## 1 根因（HEAD `0ab74404` 上逐条核实）

### 1.1 Ctrl+Enter 的送达路径

| 环节 | 位置 | 做了什么 |
|---|---|---|
| 输入框 | `ChatComposer.tsx:1336-1341` | 入队分支里，`interject` 模式先关计划审阅卡（决策 169 §1 第 4 条），再调 `interjectIntoTurn` |
| | `ChatComposer.tsx:1388-1408` | IPC 之前先发布待回显行：`awaitingDelivery: true`，id 前缀 `pending-user:steer:` |
| | `ChatComposer.tsx:1411-1437` | `chat.interject`；`interjected:false` → 撤掉气泡，按 Enter 排队（`'no-turn'`）；抛错 → 撤掉气泡，草稿留着（`'failed'`）；成功才清草稿 |
| preload / IPC | `src/preload/index.ts:1040-1051`、`src/shared/types/ipc.ts:356`、`src/main/ipc/chat.ts:640-663` | `chat:interject` → `WorkerManager.interject` |
| Main | `WorkerManager.ts:2175-2205` | `worker.interject` RPC；不碰忙碌锁 |
| bridge | `bridgeRpcServer.ts:381-383,700-716` → `dshSessionRuntime.ts:1769-1803` | `steerable()` 判有无回合；`agent.steer(message)`，并在 `steered`（757 行）里记「DSH 消息 id → attemptId」 |
| DSH | `dsh-agent-loop/lib/index.js:800-811`（0.1.7-rc.2） | `steer` = `send(next-step, wakeup)`，同步写一条 `agent/inbox/spliced`（204 行），消息进**持久收件箱** |
| | 同上 `954-991` | 回合循环：当前这一步（模型输出 + 工具执行，1139 行）全部做完、写 `step/end` 之后，下一次 `preStep` 才 `claim` 收件箱（906 行）；next-step 不空时回合不收尾（990 行） |
| | 同上 `1046` | 新一步的第一次尝试把取走的消息写成 `user/message` |
| bridge 回显 | `liveEvents.ts:685-686,774-792,821-840` | `user/message` → `message.started{role:'user', attemptId}`（按 `takeSteered` 找回 attemptId） |
| 渲染层 | `chatSessions.ts:2505-2517`、`2474-2499` | 线上见到回显就 `acknowledgeAttempt`；回显进了 store 之后撤掉待回显行 |

结论：从按下 Ctrl+Enter 到回显之间，**没有任何引擎事件**，消息只是躺在 DSH 的收件箱里；当前这一步照常跑完，DSH 才在下一个步边界取走它。录制场景 `stream.steer.json` 的顺序也是这样：命令执行中插话 → `tool.completed`（14）→ `message.completed`（15）→ 回显 `dsh-user-17`（16-18）→ 第二步。

### 1.2 渲染层为什么在这期间就把回合判成结束

1. `MessageTimeline.tsx:465-476`（修复前）：把所有待回显行（包括待送达的插话）追加在会话消息**末尾**，渲染成 `role:'user'` 的行。
2. `chatTurn.ts:89-93` 的 `groupMessagesIntoTurns`：每一行 user 都开新回合。于是待送达的插话自成一个回合，排在最后；正在跑的回合不再是最后一个。
3. 「这个回合还在跑吗」的全部依据都绑在 `isLastTurn` 上（`MessageTimeline.tsx:879`）：
   - `inFlight`、`streamStartedAt`、`pendingActive`（2131-2143）都要求 `isLastTurn`，`turnActive` 为假；
   - `processSettled = !turnActive && !(isLastTurn && inFlightSession && …)`（2407-2408）为真；
   - 于是工作区是 `worked`，`TurnProgressHead` 以 `settled: true`（1882）调 `turnWorkGroupOpen`（`turnProcessFold.ts:248-252`）；`endedByUser` 为假（2426，DSH 下插话不写 `stopCause`），返回 false → **折叠，头上写「已工作 N 秒」**；
   - 顺带停掉的还有：工具行的计时（2429 与 912 改给 `NO_TOOL_STARTS`）、秒针（907 给 `STATIC_NOW_MS`）、流式思考块的标记（2345）。
4. 待送达行自己那个回合：最后一个、会话在跑，所以是「运行中」，正文为空，`TurnClockRow`（2630）画出转圈和「工作中」；它没有任何计时起点，只有光秃秃的「工作中」。

修复前的取证（新挂载测试 `[I8-1]` 在旧代码上的输出）：按下 Ctrl+Enter 之后，运行中回合的头是 `{"open":false,"summary":"Worked"}`，时间线里有两个回合 `["u1","pending-user:steer:interject-1"]`，后一个的文字是「Also run lint.Awaiting delivery✻ Working」。

### 1.3 issue 根因分析逐条核对

1. **对，行号不符**：确实走 `interjectIntoTurn`，标 `awaitingDelivery: true`，回合不停。dsh.8（`6ca5bf42`）与 HEAD 的行号是调用处 1340、定义 1388、标记 1407，不是 1345 / 1364。
2. **结论对，原因不对**：「`turnProcessFold.ts:251` 的 `turnWorkGroupOpen` 在 settled 且非 endedByUser 时折叠」属实；但 settled 不是「interjection 在 turn 内产生了一个步骤边界」。按下时引擎里什么都没发生；是渲染层自己把待送达气泡当成一行用户消息，切出了一个新回合，旧回合因此不再是最后一个（§1.2）。
3. **对**：最后一步确实还在执行；准确地说，消息此时还在 DSH 收件箱里，连「turn 收到了新消息」都还没发生。
4. **基本对**：新的转圈和「工作中」是待送达气泡自己那个空回合；旧组的最后一步结果会落进旧回合，但旧回合已经折叠，看不到。

### 1.4 为什么现有测试没抓到

- `dshStreamReplay.test.ts` 的 `steer` 场景只断言送达**之后**的分组，以及回显能对上 attemptId。待回显行与 store 的合并写在 `MessageTimeline` 里，录制里也没有插话 RPC 发生的时刻，所以「等待期间」这一段从来没有被构造过；那条用例发布的待回显行也没带 `awaitingDelivery`。
- 「回合是否结算」是 `ChatTurn` 组件里以 `isLastTurn` 为前提的内联判断，没有纯函数可测；挂载测试里没有一条带待送达气泡。
- 录制金样本本身没有问题，不需要重录。

## 2 修法（自主，待审批）

1. **`mergePendingUserRows(authoritative, pending)`**（`src/renderer/stores/pendingUserMessages.ts`，纯函数）：
   - 返回 `rows` 与 `awaitingDelivery` 两份。普通发送的待回显行进 `rows`，照旧开回合（它开的就是回显将要开的那个回合）；待送达的插话进 `awaitingDelivery`，**不参与切回合**。
   - 保留原来的规则：待回显行一直显示，直到回显点名的那条消息进了 store。
   - 没有待回显行时原样返回 store 的数组；只有待送达行时 `rows` 也是 store 的数组本身，所以回合对象的身份不变，`ChatTurn` 的 memo 照常成立。
2. **`MessageTimeline.tsx`**：
   - 回合只由 `rows` 切分；正在跑的回合在等待期间一直是最后一个，于是保持「工作中」、工作组展开、秒针与工具行计时继续走、流式思考照常标记。
   - 待送达气泡画在所有回合（以及发送握手期的 `PendingTurnHead`）之后、历史卡和失败卡之前，用同一个 `UserBubble`，不属于任何回合，没有自己的计时行。
   - 「空会话」的判断把待送达气泡也算在内，与修复前一致。
3. **送达之后**：回显进 store，正式的用户行出现在 DSH 取走它的位置，开新回合；旧回合不再是最后一个，按普通结束结算、折叠成「已工作 N 秒」；新回合以回显的 `message.started` 为计时起点，显示「工作中」和新一步的输出。这正是 issue 期望第 3 条。
4. **各种收尾**：
   - Stop 在送达之前（决策 094）：回合按 Stop 结算（默认展开，2026-09-24 裁决），气泡留在末尾等下一回合；不再多出一个写着「已工作」的空回合。
   - 回合失败：按 DSH 代码（失败后 `kick()` 不唤醒），插话留在收件箱里，与 Stop 相同，等「继续」或下一次发送时一起送出（未实测）。回合上的失败状态归属正在跑的那个回合（它仍是最后一个），不再落到插话的空回合上。
   - 重开对话：历史投影本来就把插话放在两步之间（`rpc.steer.json` 的 `h:id-7`），重开后的分组、工具行、回答与直播送达后一致（新增断言）。
5. **顺带消除的问题**：宿主重启后回显不带 attemptId、待送达气泡收不掉（决策 111「遗留」第一条）时，修复前这个残留气泡永远是最后一个回合，之后**每一个**运行中的回合都会被它判成已结算；现在它只是末尾一个气泡，不再影响任何回合。残留本身没有处理（见 §5）。

## 3 待送达气泡置灰（自主，待审批）

- 现状（决策 118 第 24 条）：同一个气泡外形，虚线边框、不画底色，底部「待送达」前是时钟图标，状态行用 `text-muted-foreground`，悬停提示「会在当前回合的下一步并入」。但**正文仍是正常墨色**（`text-foreground`），附件名也是。
- 改动：待送达时正文与附件名改用 `text-muted-foreground`（`docs/design-system.md` 的次要文字 token，亮 7.20:1、暗 6.70:1）；送达后由回显换成正式气泡，恢复 `text-foreground`。用 `cn(字面量, ink)` 拼接，`text-chat-body` 已注册为字号类，不会吞掉颜色。
- 不加透明度、不换字号、不新增词条。

## 4 撤回（待用户拍板，未实现）

### 4.1 消息在送达前在哪里

在 **DSH 的持久收件箱**（next-step 列表），不在我方队列：`steer` 同步写入 `agent/inbox/spliced`。bridge 只在内存里记「DSH 消息 id → attemptId」（`dshSessionRuntime.ts:757`，会话 dispose 时清空）；Main 不留；渲染层只有一行显示用的待回显行。

所以**只在渲染层撤回是不安全的**：撤掉气泡、把文字放回输入框，消息仍会在下一个步边界送给模型，回显随后又把它画出来。`'no-turn'` / `'failed'` 两条清理路径能复用的只是渲染层这一半。

### 4.2 能否安全撤回

- **有公开 API**：`Agent.inbox.remove(messageId): boolean`（`dsh-agent/lib/types/runtime-types.d.ts:41-82`，README「Durable inbox」一节）。返回「消息是否仍在等待」；删除是持久的取消（写一条带 `outcome:'canceled'` 的 splice，发 `agent/inbox/discarded`）。不依赖 DSH 内部行为。
- **竞态**：宿主是单线程，`remove` 与 `preStep` 的 `claim`（`dsh-agent-loop/lib/index.js:906`）都是同步的，二者原子互斥：
  - `true`：消息没送出、以后也不会有回显 → 渲染层撤掉气泡、把文字放回输入框；
  - `false`：已经被取走（回显马上到，或已经到了）→ 什么都不做，提示「已送达，无法撤回」。
  - 渲染层这边，回显先到、答复后到，或者答复先到，两种顺序结果都一致。
- **限制**：
  - 宿主重启后对应表没了，按 attemptId 找不到消息，只能答「无法撤回」（消息仍在收件箱里，之后照常送达，回显不带 attemptId，见决策 111 遗留）；
  - 带附件的插话，附件已经进了 DSH 的附件库，撤回后留下孤立文件；草稿里的附件在提交时已从输入框移除，要放回输入框，就得在待回显行里一直留着原始草稿。

### 4.3 需要的改动（约 1～1.5 人日）

- bridge：`withdraw(attemptId)`，从 `steered` 反查消息 id，调 `inbox.remove`，成功时删掉对应表里这一项；
- 协议：新增 worker RPC（如 `worker.interject.withdraw {logicalSessionId, attemptId}` → `{withdrawn}`）及校验器、`WorkerManager` 方法、IPC 与 preload；
- 渲染层：待送达气泡状态行加一个「撤回」小按钮（`h-6` ghost），成功后撤掉气泡、把文字放回原对话的输入框；
- 测试：bridge 单测、`workerRpc` 校验、`WorkerManager`、挂载测试；录制新增场景 `steer-withdraw`（命令执行中插话再撤回，断言模型没看到这句；送达后再撤回答 `false`）——新金样本由编排者收口时录。

### 4.4 推荐与需要拍板的问题

推荐做，作为单独一项，用 DSH 公开的 `inbox.remove`；Stop 之后留在收件箱里的插话（决策 094）同样可以撤回，这是目前唯一能收回一句误发插话的办法。需要拍板：

1. 做不做撤回（会改 bridge 协议）；
2. 撤回后文字怎么放回：输入框为空时直接放回，不为空时怎么办（放在前面空一行 / 只提示不放回）；
3. 带附件的插话：撤回时附件是否一并放回（要多留一份草稿），还是只放回文字并提示重新添加附件。

不推荐的替代：把插话先留在渲染层，等「步边界」再 steer。渲染层看不到 DSH 何时 `claim`，`step/end` 之后紧接着就是 `claim`，赶不上就会晚一步送达，有竞态。

## 5 风险

1. **残留的待送达气泡**：宿主重启后回显不带 attemptId（决策 111 遗留），或者某一步被 `agent/pre-step` 拒绝（DSH 文档：被取走的消息既不丢弃也不回显），气泡会一直留在末尾。修复前后都存在；修复后它不再连带把之后的回合判成已结算。
2. **气泡位置**：待送达气泡总在末尾，排在发送握手期的待回显回合之后。极少见的组合（Stop 后留着插话，再按 Enter 发送）里，DSH 先送插话、再送新提示词，回显会让两行在送达时调换一次顺序。
3. **提示语**：Stop 之后气泡的悬停提示仍是「会在当前回合的下一步并入」，此时实际要等下一回合；本决策没有改词条。
4. **提示词导航条**：待送达的插话在送达前不出现在右侧的提示词导航里（它还不是一个回合），送达后出现。

## 6 验证（2026-10-10，开发机逐条跑，一次一个）

- 先写失败的测试：新文件 `interjectionDeliveryMount.test.ts`（happy-dom 挂载真 `MessageTimeline`）在旧代码上 3 项里 2 项失败（`[I8-1]`、`[I8-3]`：时间线多出 `pending-user:steer:interject-1` 一个回合；取证见 §1.2），修复后 3 项通过：
  - `[I8-1]`：插话后只有一个回合；运行中回合的组展开、头上「Working」、全时间线没有「Worked」；气泡在回合之后、正文置灰；命令结束、回显未到时仍是运行中。
  - `[I8-2]`：回显与下一步到达后，旧组折叠、头上「Worked」；新回合是正式气泡（正常墨色）+「Working」。
  - `[I8-3]`：送达前 Stop：仍只有一个回合，气泡留着，「Worked」只出现在旧回合的头上一次。
- `pendingUserMessages.test.ts` 新增 3 项（`mergePendingUserRows`）；`dshStreamReplay.test.ts` 的 `steer` 场景新增 2 项：按录制顺序在「命令执行中」「结果已到、回显未到」「回显已入 store」三个时刻断言回合划分与气泡；重开对话与直播送达后一致。
- 相关文件一起跑（时间线、折叠、输入框静态、store、回放金样本等 27 个文件）：27 个文件、777 项通过。
- `pnpm exec vitest run Static Scan Wiring`：78 个文件、798 项；`pnpm exec vitest run src/shared/__tests__`：35 个文件、541 项。
- `pnpm typecheck` 通过；改动文件 `biome check` 无问题。没有改 `src/dsh-host`、bridge 与协议，不涉及 `typecheck:dsh-host`、bridge-smoke、`bridge-record --check`；录制金样本不需要重录。
- 未做：GUI 点验与整包构建（开发机不跑）；Windows（见 §7）。

## 7 Windows 现场清单（下一个测试包起）

1. 发一个会跑长命令的请求（如「运行 `Start-Sleep 60` 后再回答」），命令执行期间按 Ctrl+Enter 补一句：
   - 运行中的工作组**保持展开**，头上仍是「工作中 N 秒」并继续走秒，工具行的计时继续；
   - 补的这句排在最下面，虚线、无底色、文字发灰，带时钟和「待送达」；
   - **没有**第二个转圈 +「工作中」。
2. 命令结束后：旧组折叠成「已工作 N 秒」；补的这句变成正常气泡，开一个新回合，下面是「工作中」和模型对它的回应。
3. 长思考期间（推理模型思考 30 秒以上）按 Ctrl+Enter：思考块继续流式显示，思考结束、这一步做完之后才发生第 2 条的过渡。
4. 插话后、送达前按 Stop：回合按 Stop 结束（默认展开）；气泡仍是「待送达」；下一次发送时，这句先于新消息送达。
5. 关掉再打开这个对话：插话出现在两步之间，旧回合折叠，与直播送达后一致。

## 8 用户审批

- [ ] §2 修法：待送达的插话不参与切回合，画在时间线末尾；送达时旧回合按普通结束折叠
- [ ] §3 待送达气泡的正文与附件名置灰（补充决策 118 第 24 条）
- [ ] §4 撤回：做不做；文字放回输入框的规则；附件是否一并放回
- [ ] §7 Windows 现场清单
