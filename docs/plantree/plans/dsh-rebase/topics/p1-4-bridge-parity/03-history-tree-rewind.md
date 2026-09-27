# P1-4 分片 03 · 历史投影、树与 leaf、回退与 fork

Role: detail shard。上位：[P1-4 方案](../p1-4-bridge-parity.md)。回答调研问题 2、3。我方行号指 worktree HEAD `941ab5b1`；DSH 事实出处见[分片 02](02-dsh-facts.md)。本分片是设计，还没有实现和运行过。

## 0 我方的历史模型，以及渲染层依赖到哪一步

- **pi / native 的模型**
  - 会话文件是一棵条目树（entry 带 `parentId`），`leaf` 指当前活动路径的末端。
  - 回退只是移动 leaf（`runtime/plugins/session/store.ts:535-561`）：目标是用户消息时，移到它的父节点，并把这条消息的文本作为 `editorText` 返回。
  - 重试上一轮，是把 leaf 移回失败回复之前；失败的回复留在旁支上（`retry.ts:46-86`）。
  - fork 是把活动路径复制成一个新文件（`store.ts:594-640`），路径上必须有助手消息。
- **worker RPC 的契约**
  - `history`：从活动 leaf 往前数的分页，`h:` 前缀的 id，80 条一页（`workerRpc.ts:225-238`；`sessionHistory.ts:217-264`、`:306-316`）。
  - `tree`：节点带 `parentId`、`depth`、`active`、`leaf`、`forkable`（`sessionHistory.ts:171-196`）。
  - `leaf`：`{activeEntryId, fileTailEntryId}`，只用来比较是否相等（`:166-169`）。
- **渲染层真正依赖的**
  - 同一条消息在多次重读之间 id 要保持不变（`historyReplayMerge.ts` 的五道护栏，`:1-123`），合并靠 role 加文本身份。
  - `incomplete` 为真且没有内容时，显示「Response interrupted…」占位（`chatSessions.ts:932-938`）。
  - `stopCause` / `entryId` / `settledAt` / `attachments` 是可选字段（`:939-964`）。
  - 树只在树对话框里用：列出节点，对单个节点「回到这里」或「从这里分叉」（`SessionTreeDialog.tsx:100-145`、`:196-238`）。渲染层不自己遍历分支。
- **Main 依赖的**
  - 每次回合终态之后读一次 `tree.snapshot.leaf`，写进索引的 `piLeaf`（`WorkerManager.ts:3101-3112`、`:3464-3491`）。
  - `piLeaf` 是否存在，被用来区分「写过」和「从没写过」的会话（`chat.ts:83-90`）。
  - 回退结果要求 `sessionFile` 不变（`WorkerManager.ts:1594-1611`）。

## 1 DSH 事件 → `HistoryMessage`（纯函数 `projectDshHistory`）

**输入**：当前 DSH 会话的完整事件数组，seq 从 0 开始连续，包含继承来的前缀（来自 `observeSession().events`）。

**输出**：按时间排序的 `HistoryMessage[]`；分页沿用 `paginatePiSessionHistory` 的算法（`piSessionTimeline.ts:522-551`），把它移到 shared 作为通用函数。

| 事件 | 产出 |
|---|---|
| `turn/start {turn}` | 开一个回合上下文：记下这一回合的第一条用户消息和各 step，供 `turn/end` 用 |
| `user/message`，`source.kind === 'user'` | 一条 user 消息。<br>• id 为 `h:<message.id>`，`entryId` 为 `message.id`，`timestamp` 为事件的 time；<br>• text 取 text 块拼接；<br>• `attachments` 从 image 块取 `mediaType` / `name`（`ImageAttachmentRef` 自带文件名，不需要 native 那种 rider）；<br>• FileBlock 记成 `{kind:'text', mediaType:'text/plain', name}`（推断：我方不产生 FileBlock，只为了兼容外来会话） |
| `user/message`，`compact-checkpoint`（带 `surfaceOp.replace` 的替换节点） | 一条 system 消息，正文为 `Context summary\n\n<摘要>`（与 native 的 `projector.ts:812-830` 以及 `piSessionTimeline.ts:183-199` 一致）。被遮住的旧消息照常显示：界面历史不等于模型的 surface |
| `user/message`，`form:'notice'` 的来源（`tool-jobs`、`tool-goal` 等） | 一条 system 注记，正文取 `source.summary`（120 字以内）。这类注记由 P1-7 定样式；如果 P1-7 决定不显示，改成隐藏 |
| `user/message`，`aiclient-retry` | 隐藏，并把本回合标记为「重试续跑」（见下面的 `turn/end error`） |
| `user/message`，`skill-invocation` | 显示为 user 消息（推断；与 native「展开后的文本就是用户消息」一致，P1-4d 实测后再定） |
| `user/message`，其他来源（`runtime-context`、`agent-instructions`、`skill-catalog`、`goal`、`subagent-settled`、`agent-message`、`plan-mode`、`model-selection`、`repeat-tool-reminder`、`user-approval`、`tool-registry`、`ptc-mode` 等） | 隐藏。它们是模型上下文或内部通报；native 同样隐藏内部消息（`piSessionTimeline.ts:311-316`） |
| `assistant/message {turn, step, message, usage?, interrupted?}` | 每个 step 一条 assistant 消息。<br>• id 为 `h:<message.id>`；`model` 为 `${source.provider}/${source.model}`；<br>• blocks：`reasoning` → thinking，`text` → text，`tool-call` → tool_call（input 为解析后的 arguments，并补 `path` 作为 `file_path` 的别名，沿用 `dshSessionRuntime.ts:187-195`）；<br>• `interrupted` 为真时，设 `incomplete: true`、`stopReason: 'aborted'` |
| `tool/result {message, error?, meta?}` | 并进所属 step 的消息，作为 tool_result。<br>• `ok` = `!isError`；<br>• output 取 text，上限 4000 字（`piSessionTimeline.ts:79`）；只有图片时写 `(image)`；<br>• `isError` 时带 `error`；<br>• 按 `error.code` 设标志：`ABORTED_BEFORE_DISPATCH`、`TOOL_NOT_STARTED` → `notStarted`；`TOOL_OUTCOME_UNKNOWN` → 新增 `outcomeUnknown`；<br>• bash `meta.aborted` → `stopped`；<br>• fs `meta` → `review`（P1-4d）；<br>• `settledAt` 为事件的 time |
| 回合结束时仍没有结果的 `tool-call` 块 | 补一个 `notStarted` 结果（与 `piSessionTimeline.ts:493-520` 一致） |
| `turn/end {kind:'aborted', reason:{kind:'user'}}` | 本回合最后一条 assistant 消息设 `stopCause: 'user_stop'`。如果本回合没有 assistant 消息，补一个 incomplete 占位，id 为 `h:<该回合首条用户消息 id>:end` |
| `turn/end {kind:'aborted', reason:{kind:'hook', reason:'aiclient-interject'}}` | 同上，`stopCause: 'interjected'` |
| `turn/end {kind:'error'}` | 本回合在最后一条用户消息之后没有 assistant 内容时，补占位 `h:<…>:end`，设 `incomplete: true`、`stopReason: 'error'`。如果紧接着的下一回合是「重试续跑」，就不输出这个占位（与 native「失败回复移到旁支」的观感一致） |
| `turn/end {kind:'interrupted'}` | 输出一条 system 注记，id 为 `h:<…>:interrupted`，带 `HistoryNotice`，key 为英文句子「This turn was interrupted when the engine stopped unexpectedly.」，中文由词典翻译（`sessionHistory.ts:28-31`）。本回合最后一条 assistant 消息设 `incomplete`；同样遵循重试时隐藏的规则 |
| `turn/end` 为 `completed` / `blocked` / `max-tokens` / `forked` | 不产出（`max-tokens` 可以设 `stopReason: 'length'`） |
| 其余事件（`request/*`、`system/message`、`developer/message`、`session/end-seed`、`agent/inbox/spliced`、`approval/*`、`sandbox/mode`、`permission/preset`、`plan/mode`、`goal/change`、`todo/write`、`command/*`、`compaction/*`、`llm/retry*`、`image/offload`、`subagent/*`、`tool/ptc-*`、`tool-workflow/*`、`deliverables/presented`、`session/title`、`feedback/*`） | 不产出时间线消息（有些会以实时事件或投影状态出现，见分片 04） |

**id 稳定性**

- DSH 的 `MessageId` 是随机 UUID（`dsh-llm/lib/index.js:37-60`）。fork 种子会原样复制事件对象，所以同一条消息在父会话和子会话里的 id 相同。
- 合成出来的 id 都由「所属用户消息的 id + 后缀」构成，也是稳定的。
- 直播中的 id（`dsh-user-<seq>`、`dsh-<dshId>-t<n>-s<m>`）和历史 id 不同，靠渲染层按文本身份合并，与 native 的情况一样。

**性能**

- bridge 在 bootstrap 时先订阅 `session/event`，再 `observeSession`，然后丢弃 seq 不大于 cursor 的缓冲事件，做一次全量折叠；之后每来一个事件增量折叠。
- 2000 条消息的会话，全量折叠预计是几十毫秒（推断，P1-4a 实测）。Main 每个回合读一次 tree 取 leaf，所以树也要走缓存。

## 2 树与 leaf

- **节点**：投影出来的每条可见消息（user、assistant、system 摘要或注记）都是一个节点。
  - `entryType`：`message` / `compaction` / `notice`；
  - `role`；
  - `preview`：前 96 字，沿用 `piSessionTree.ts:34`；
  - `timestamp`。
- **单个会话的链**：`parentId` 是同一个 DSH 会话里的前一个可见节点；DSH 会话内部没有分支。
- **跨 lineage 合并**：按桩里 `lineage[]` 列出的所有 DSH 会话，逐个投影出链，再按节点 id 合并成一棵树。
  - 子会话继承的前缀和父会话的前缀 id 相同，会自然重合；
  - 父会话在切点之后的部分，就成了兄弟分支。
  - `depth`、`childCount` 用 DFS 算，与 `piSessionTree.ts:146-280` 同法。
- **节点标志**
  - `active`：在当前 DSH 会话的链上。
  - `leaf`：当前链的最后一个节点。
  - `forkable`：从根到该节点的路径上有 assistant。
- **容量**：上限 `PI_SESSION_TREE_BACKEND_LIMIT`（4000）；窗口裁剪沿用 `piSessionTree.ts:265-268` 的算法。
- **退役会话**只读、不会再变，所以它们的投影可以按 DSH 会话 id 缓存；冷读用 `observeSession`，它自带按修订号的缓存。
- **leaf**：`{activeEntryId: 当前链最后一个节点的 id 或 null, fileTailEntryId: '<当前 dshId>#<最后 seq>'}`。日志增长或者指针切换，都会让它变化；Main 只比较是否相等（`WorkerManager.ts:3476-3481`）。

## 3 桩 v2 与 id 规则

- **桩 v1**（决策 006）：`{engine:'dsh', version:1, dshSessionId, logicalSessionId, cwd, createdAt}`。
- **桩 v2** 追加 `lineage: [{dshSessionId, parentDshSessionId?, cutSeq?, reason: 'create'|'rewind'|'fork', at}]`，只增不减。`dshSessionId` 永远等于 lineage 的最后一项。读 v1 桩时，把 lineage 视为 `[{dshSessionId, reason:'create'}]`。写入沿用决策 006 的原子方式：先写临时文件，再改名。
- **DSH 会话 id**
  - 首个会话：`aiclient-<逻辑 id>`（决策 006）。
  - 每次回退：`aiclient-<逻辑 id>.r<n>`，n 从 2 开始；`.` 在路径转义里是安全字符。
  - fork 子会话：`aiclient-<目标逻辑 id>`。
  - 桩丢了的时候：列出 `aiclient-<逻辑 id>` 和 `aiclient-<逻辑 id>.r*`，按 header 的 `parentSession` 链找到最末端的那个，就是当前会话。决策 006 的「可以反推」因此仍然成立。

## 4 回退（D2 A：指针切换）

**边界怎么算**：目标节点 N 属于 lineage 里的某个会话 S，S 可以是当前会话，也可以是退役会话。

| N 的类型 | 边界 seq（包含） | 结果 |
|---|---|---|
| 用户消息，位于回合 T | T 的 `turn/start` 之前的最后一个事件，通常是上一回合的 `turn/end` 或 `session/end-seed`；如果 T 是第一个回合，就没有边界 | 子会话停在上一回合结束处。`editorText` 为 N 的文本（与 native 的 `store.ts:546-559` 一致）。没有边界时，建一个空子会话：不带 seed，但带 `parentSession` 以保留 lineage |
| assistant step（T, s） | 该 step 的 `step/end` | 前缀包含这一步的工具结果。回合如果还开着，由 `buildForkSeed` 补 `forked` 收尾 |
| 压缩摘要节点 | 替换节点所在的 `user/message` 的 seq | 保留这次压缩 |
| 系统注记（中断等） | 所在回合的 `turn/end` | — |

**执行步骤**（bridge 内部，`worker.rewind`；RPC 在 slot 内本来就是串行的，`piWorkerRpcServer.ts:323-336`）

1. **前置检查**
   - bridge 没有持有回合，agent 处于 `idle`；否则抛 `WORKER_SESSION_BUSY`。
   - 当前 agent 名下有后台任务时，拒绝回退，建议错误码 `WORKER_REWIND_JOBS_RUNNING`。原因是 dispose 会结束这些任务（推断）。
2. **占住空闲期**：在旧 agent 上调用 `runMaintenance`。这之后到达的 goal 续跑、后台任务唤醒都会留在旧收件箱里，不会开回合。
3. **取 S 的事件**：当前会话走活快照，退役会话走冷读；然后 `seed = buildForkSeed(events, boundary)`。
4. **建子会话**：`agents.create({sessionId: <新 id>, seed, inheritedEventCount: boundary+1, meta:{cwd, parentSession: S, isSeeded: true}, agentOptions, setup})`，再 `ctx.sessions.flush`。没有边界时，不传 seed 和 `isSeeded`。
5. **原子改写桩**：`dshSessionId` 改为新 id，lineage 追加 `{reason:'rewind', parentDshSessionId: S, cutSeq: boundary}`。
6. **切换**：dispose 旧 agent 的 handle（它的写锁随之释放）；把 `this.dshSessionId` / `this.handle` 和监听过滤条件切到新 id；缓存的 bootstrap 结果里 `piSessionId` 同步更新。
   - 注意：维护期间被挡住的唤醒，会在维护结束时重放（`dsh-agent-loop/lib/index.js:836-842`），可能在旧 agent 上开出一个回合。
   - 办法：在维护任务内部、第 5 步之后，对旧 agent 调 `cancel({kind:'disposed'}, {keepInbox:true})`。取消原因为 `disposed` 时不重放唤醒（同一处代码），然后在任务外 dispose。这一点**需实测**。
7. **返回**：`{sessionFile: 桩（不变）, leaf, history, tree, editorText?, targetEntryId}`，满足 `isWorkerRewindResult`（`workerRpc.ts:1240-1252`）。

**崩溃与失败窗口**

| 在哪一步中断 | 盘上状态 | 重启后 | 结论 |
|---|---|---|---|
| 1～4 之间，或者第 4 步失败 | 桩指向 S，新会话可能已落盘 | 恢复 S | 回退没做成，RPC 报错或 Main 收到崩溃；新会话成了孤儿，交给 P1-3 清理 |
| 5 写临时文件时 | 桩没变（改名是原子的） | 恢复 S | 同上 |
| 5 之后、6 之前 | 桩指向新会话 | 恢复新会话；S 的锁随进程释放 | 回退已生效；Main 的 `rewindSession` 没收到结果，由它现有的「重试 / 报错」路径处理，没有不一致 |
| 6 里 dispose 旧 handle 超时 | 桩指向新会话，旧 agent 残留在内存 | — | 设 3 s 上限；超时就记日志，等宿主重启时回收，功能不受影响 |

- **不变量**：索引行、会话键、桩路径都不变；桩里的 `dshSessionId` 一定对应一份已落盘的日志（先 flush 再改桩，与决策 007 同理）。
- **Main 这边**：`rewindSession`（`WorkerManager.ts:1551-1635`）不需要改动。树对话框的文案不能再写「Pi 会话文件不会被截断」（`SessionTreeDialog.tsx:263-266`），要改成与引擎无关的说法，放在 P1-4b 一起改。

**备选**

- B：回退当作 fork 处理，新开一个逻辑会话。实现最简单，但侧栏会多出会话，和「回到同一个对话的某一点」的产品语义不符。
- C：DSH 会话不支持回退，对话框里把按钮灰掉。这是 1.0.x 功能的倒退。

## 5 fork（D6 A：Main 预铸逻辑 id）

**协议**

- `WorkerForkPayload` 追加可选字段 `targetLogicalSessionId?: string`；`isWorkerForkPayload` 校验它是非空字符串（`workerRpc.ts:522-525`、`:1273-1279`）。
- Main 把 `const sessionId = \`session-fork-${randomUUID()}\``（`WorkerManager.ts:1797`）挪到 `worker.fork` 请求之前（`:1774`），随请求一起下发。碰撞检查照旧。
- native runtime 忽略这个字段，到 P1-12 随 runtime 一起删除。

**bridge 的 `fork({entryId, targetLogicalSessionId})`**

1. 解析 N 所在的 S 和边界（按上面那张表的 fork 列：边界是 N 的最后一个事件）。如果路径上没有 assistant，拒绝，错误码 `session_fork_unmaterialized`（与 native 一致）。
2. 先写 `.staged` 标记：`<子桩>.staged`（与 `STAGED_FORK_MARKER_SUFFIX` 一致，`workerRpc.ts:578`）。
3. `agents.create` 建子会话，id 为 `aiclient-<target>`，带 seed，然后 flush。
4. 原子写子桩（v2，lineage 为 `[{reason:'fork', parentDshSessionId: S, cutSeq}]`）。
5. **立即 dispose 子 agent**，把写锁让给目标 slot：目标 slot 会用子桩 bootstrap，走 `agents.resume`。
6. 返回 `{logicalSessionId, sourceSessionFile: 源桩, sessionFile: 子桩, piSessionId: 子 DSH id, workspacePath, leaf, history}`（`workerRpc.ts:527-535`）。

**accept / discard**

- `acceptFork`：删掉 `.staged` 标记。
- `discardFork`：删子桩和标记；子会话的日志留给 P1-3 的清理，因为 DSH 没有删除 API，路径规则也是 DSH 内部的东西。
- Main 的启动清扫按索引行的目录来扫 `.staged`（`WorkerManager.ts:651-710`），对 `aiclient-sessions/` 同样有效。

**需实测**：第 5 步 dispose 之后，同一宿主里能不能马上 `agents.resume`（写句柄的释放时序）。

**备选**：让 bridge 自己铸 DSH id，比如 `aiclient-fork-<uuid>`。这样做，桩一旦丢失就无法从逻辑 id 反推，违背决策 006。

## 6 给 P1-3（日志清理）的接口

- **引用集合**：从索引行的 `runtimeIdentity` 找到桩，由宿主读桩，展开出 `dshSessionId` 和 lineage 里的全部 id；再加上 header 里 `parentSession` 属于这个集合、且 `origin:'subagent'` 的子代理会话。
- **可以清理的**
  - 没有被引用的 `aiclient-*` 会话：回退或 fork 失败留下的孤儿、被 discard 的 fork、只有 header 的会话（决策 007）。
  - 整个逻辑会话被删除时，它 lineage 里的全部会话，外加桩。
- **不能清理的**：正被持锁的会话（P1-3 自己按「取写锁、删目录」的流程处理，与 P1-3 方案 §3.9 一致）。
- **退役会话要保留**到逻辑会话被删为止，因为树上的旧分支要靠它们（D1 A）。如果以后在意空间，可以把「保留 N 次回退」做成一个设置，本期不做。
