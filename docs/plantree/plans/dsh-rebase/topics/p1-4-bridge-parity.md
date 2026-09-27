# P1-4 bridge 对等：方案与就绪检查

Role: topic。建立：2026-09-26。上位：[roadmap P1-4](../roadmap.md)。依据：[决策 001](../decisions/001-route-b-and-scope.md) 第 3 条、[004](../decisions/004-branch-isolated-dsh-only.md)、[006](../decisions/006-session-identity-stub-file.md)、[010](../decisions/010-p1-1-scope-boundary.md)；[P0-3 映射与缺口](../evidence/p0-3-bridge-2026-09-25.md)、[P0-6 恢复缺口](../evidence/p0-6-shared-host-2026-09-26.md)、[P1-0 v1.0.3 新语义](../evidence/p1-0-sync-main-2026-09-26.md)、[P1-1 方案](p1-1-engine-cutover.md)。明细分片：[01 事件与 RPC 映射全表](p1-4-bridge-parity/01-event-mapping.md) · [02 DSH 源码事实](p1-4-bridge-parity/02-dsh-facts.md) · [03 历史、树、回退与 fork](p1-4-bridge-parity/03-history-tree-rewind.md) · [04 回合语义与其余事件](p1-4-bridge-parity/04-turn-semantics.md) · [05 录制门禁与改动清单](p1-4-bridge-parity/05-gate-and-changes.md)。状态：只读调研（worktree HEAD `941ab5b1`；没有改代码，没有起宿主），**方案待拍板**（§5 的 D1～D8）。DSH 以 `0.1.7-rc.2` 源码为准，下文 DSH 路径都省略前缀 `src/dsh-host/node_modules/@deepseek-ai/`。P1-1 的目标形态按它的方案和决策 005～010 理解。标「推断」「需实测」的结论没有运行验证。

## 1 结论先行

1. **对等能做，但 P1-4 是 P1 里最大的一块。** 粗估产品代码约 3000～3500 行、测试约 2500～3000 行，4～6 人周。
   - 建议切成 a～e 五个子任务（§6）：a 先做，b、c、d 可以并行，e 的骨架和 a 同批做，CI 接入放在收口。
2. **硬约束：bridge 不得往 DSH 日志追加自定义事件类型。**
   - DSH 读盘时遇到它不认识、又没标 `ignorable` 的事件类型，会拒绝打开整个会话（`dsh-session-persistence/lib/index.js:184`）。
   - `Session.append` 没有设置 `ignorable` 的入口（`dsh-session/lib/index.js:1401-1419`）。
   - 所以我方要落盘的信息，只能用 DSH 已有的词汇表达：`turn/end` 的取消原因 `aborted.reason`；用户消息的 `source.kind`（任意非空字符串都合法，`dsh-session/lib/index.js:1162`）；或者写进我方自己的桩文件。
3. **历史投影。**
   - 投影单位：人类消息一条一个 `HistoryMessage`；每个 step（一次模型调用加上它的工具结果）一个 `HistoryMessage`。
   - id 取 DSH 的 `MessageId`，写成 `h:<id>`。fork 种子是原样复制事件的，所以 id 在回退、fork 前后都不变，渲染层现有的合并规则照样成立。
   - 投影写成纯模块 `src/shared/dshHistory/`，不依赖 DSH 包，bridge 和根 vitest 共用。
4. **树与 leaf。**
   - DSH 没有会话内分支（`dsh-session/README.md:190`），所以按消息建链。
   - 回退之后，被放弃的后半段仍留在旧的 DSH 会话里。按桩里记下的 lineage，把几条链并成一棵树，树对话框里「后面的消息仍在树里」这句话才兑现。
   - leaf 是两部分：当前 DSH 会话的最后一条消息，加上 `<dshId>#<lastSeq>`。
5. **回退与 fork。**
   - 回退用决策 006 预留的「桩是可变指针」：
     - 从边界 seq 分叉出种子子会话（`buildForkSeed` 加上带 `seed` 的 `agents.create`）；
     - 原子改写桩里的 `dshSessionId`，并追加 lineage；
     - 索引行、会话键、桩路径都不变。各个崩溃窗口的结局都是一致的（§4.3）。
   - fork 用同一套机制，区别只是写一个新桩。子会话 id 由 Main 预先铸好新的逻辑 id，随 `worker.fork` 下发。
6. **重试上一轮不需要分叉。**
   - DSH 把失败的那次尝试记为 `assistant/attempt`，它本来就不进模型上下文（`dsh-session/lib/types/types.d.ts:339-348`）；已完成的工具轮也都还在。这正是决策 045 要的「失败前的上下文」。
   - 难处在于：DSH 开一个新回合，首批至少要有一条消息；首批为空时直接判回合完成（`dsh-agent-loop/lib/index.js:963-965`）。
   - 推荐追加一条续跑提示：模型看得到，用户看不到，`source.kind` 为 `aiclient-retry`。这偏离了决策 045「不加用户消息」的字面，**需要用户拍板**（D3）。
7. **插话。**
   - DSH 的 `steer` 会把消息插进当前回合，语义和 v1.0.3 不同。
   - 推荐保持 v1.0.3 的语义：在当前 step 的 `step/end` 上同步调用 `cancel({kind:'hook', reason:'aiclient-interject'}, {keepInbox:true})`。回合在步边界收尾，落盘的原因能和普通 Stop 区分开，映射成 `session.completed {stopCause:'interjected'}`。
   - `turnActive` 按 bridge 当前是否持有回合回报。
8. **图片附件。**
   - DSH 的用户消息支持 image 块，但字节要先经 `ctx.attachments` 入库。格式为 PNG / JPEG / WebP / GIF，单张上限 20 MiB（`dsh-attachment-local/README.md:41-49`）。
   - 我方单张 5 MiB，更严，沿用。文本附件照 native 的做法并进正文。
   - 模型路由要声明支持图片输入，图才真的送给模型，`read_image` 也有同样要求。这一项归 P1-5。
9. **用量。**
   - 每个 step 的 `assistant/message.usage` → 已结算的 `usage.updated`；流里的 `usage` chunk → pending。
   - 会话累计取 token-meter 的 `tokenUsage` 投影。
   - 上下文占用取 `request/context.contextWindow` 和 `contextPressure`。
   - DSH 不算费用，`costUsd` 要等 P1-5 提供定价。
10. **主进程只读回放。**
    - 推荐由宿主来读：`ctx.sessionQuery.observeSession` 不取锁、不写盘，冷读时在内存里补上中断收尾；投影复用第 3 条的纯模块。
    - 需要 P1-3 的宿主级通道增加一个只读操作。
    - 不推荐 Main 自己解 zstd，也不推荐把 DSH 的库搬进 Electron：两条路都有格式漂移的风险，还有加密机上读到密文的风险。
    - 旧 pi 会话照旧走 `SessionReplayReader`。P1-12 删 runtime 时，要把 pi 解码链整体搬走，不能删掉，因为 P1-9 的转换器也要用它。
11. **录制门禁**沿用 `guiEventContract` 加 `nativeStreamReplay` 这一对的模式。
    - 用真实 DSH 宿主加假网关录三类金样本：归一化后的 RuntimeEvent 流、原始 DSH 日志、投影结果。
    - 根 vitest 只跑纯回放（渲染层 reducer 和投影）；录制比对单独作为一个 CI 步骤。

## 2 现状

**bridge**

- HEAD 的 `DshSessionRuntime` 只映射了文本、工具行、越界审批和 Stop。
  - 历史和树都返回空（`src/dsh-host/bridge/dshSessionRuntime.ts:400-430`）。
  - `interject` 恒为 false（`:375-377`）。
  - `send` 不看 `mode`、附件、model、effort（`:343-366`）。
  - compact、rewind、reload、fork 都报不支持（`:436-453`）。
  - `turn/end` 失败时，error 字段是一段 JSON 串（`:684-687`）。
- P1-1 落地之后（决策 007、010），bridge 会多出这些：先落盘再写桩、恢复时的错误映射、空页 `initialHistory`、重试和附件的安全拒绝，fork 仍报不支持。P1-4 在这个基础上替换实现，不推倒重来。

**Main 与渲染层依赖什么**（全表见[分片 01](p1-4-bridge-parity/01-event-mapping.md)）

- **Main**
  - 恢复、崩溃重启、fork 目标这三处都必须拿到 `initialHistory`。
  - 每个回合的终态事件之后都读一次 `worker.tree`，用来持久化 leaf（`WorkerManager.ts:3101-3112`、`:3464-3491`）。
  - fork 的逻辑 id 是在 `worker.fork` 返回之后才铸的（`:1774`、`:1797`）。
  - 插话按决策 046 读 `turnActive`（`:2108-2132`）。
- **渲染层**
  - 合并依赖两件事：`h:` id 在多次重读之间保持稳定，以及文本身份（`historyReplayMerge.ts:1-123`）。
  - 树对话框是回退和 fork 的唯一入口（`SessionTreeDialog.tsx:100-145`），文案承诺「后面的消息仍保留为另一分支」（`:157-159`、`:263-266`）。
  - 重试没有用户回显，靠 `running` 状态确认已受理（`ChatComposer.tsx:1861-1866`）。
  - `reload` 只在 pi TUI 切换时使用（`usePresentationSwitch.ts`），P1-1 的方案已经禁止 DSH 会话开 TUI。
- **只读预览**
  - `SessionReplayReader` 只认 pi 和 native 两种格式（`SessionReplayReader.ts:157-207`）。P1-1 之后，DSH 行会退回到「恢复」这条路。
  - 恢复会取写锁，并且每次都往日志追加一个 `session/end-seed`（P0-6 实测）。也就是说，今天仅仅「看一眼」就会改写 DSH 日志。

## 3 DSH 侧事实（要点；逐条出处见[分片 02](p1-4-bridge-parity/02-dsh-facts.md)）

- **日志与分支**
  - 日志只追加、seq 连续。
  - 模型历史由 surface 投影得到：压缩时用 `replace` 遮住旧节点，但不删除它们。
  - 支持从任意 seq 分叉（`buildForkSeed`，`dsh-session/lib/index.js:884`）。没有 rewind，也没有会话内的树。
- **回合结束原因**：`completed`、`aborted{cause}`、`blocked`、`error{LlmFailure}`、`max-tokens`。另外两种只在事后出现：`interrupted` 在恢复或冷读时补写，`forked` 只出现在种子里（`dsh-session/lib/types/types.d.ts:165-208`）。
- **Stop 与失败尝试**
  - 用户 Stop 时，已经流出的前缀会以 `assistant/message {interrupted:true}` 落盘（同文件 `:320-338`）。
  - 失败的尝试记为 `assistant/attempt`。
  - 没来得及派发的工具调用，会补一对 `tool/call` 和 `tool/result`，错误码 `ABORTED_BEFORE_DISPATCH`。
- **回合机器**（`dsh-agent-loop/lib/index.js:936-1025`）
  - 首批为空时，回合直接完成，不开 step。
  - `agent/pre-step` 返回 reject 时，回合以 `blocked` 结束，已经取出的输入会丢失。
  - `cancel(cause, {keepInbox})` 能保住收件箱里的内容。
  - `followup` / `steer` / `inject` 分别对应下一回合、下一步、下一步且不唤醒（`dsh-agent/README.md:47`）。
- **只读读取**
  - `ctx.sessionQuery.observeSession` / `readSession` 优先读活会话，读冷会话时只拿短期读句柄，不改盘（`dsh-session-query/README.md:36-43`、`:107`）。
  - `ctx.sessionProjections` 提供 `todos`、`goal`、`plan`、`permissions`、`sandboxMode`、`tokenUsage`、`contextPressure`、`llmRetry` 等状态。
- **盘上格式**
  - 多个独立 zstd 帧拼接：头一帧，之后每批一帧。存在代际迁移，不支持降级，也没有删除 API（`dsh-session-persistence-jsonl/README.md:74-104`、`:158-164`）。
- **其余接口**：图片入库 `ctx.attachments.admitPromptContent`；命令 `ctx.commands.list/execute`，其中 `/compact` 不带参数；问答 answerer `user-questions/request`；每轮换模型 `installModelSelection`；重试记录 `llm/retry`。

## 4 方案

**4.1 历史投影**（规则见[分片 03 §1](p1-4-bridge-parity/03-history-tree-rewind.md)）

- 纯函数 `projectDshHistory(events)` 生成 `HistoryMessage[]`，分页复用 `paginatePiSessionHistory` 的算法。
- 用户消息按 `source.kind` 分流：
  - `user`：显示成气泡，从 image 块恢复附件的名称和类型；
  - `compact-checkpoint`：显示为「Context summary」系统行；
  - 带 `form:'notice'` 的来源：显示为系统注记；
  - `aiclient-retry` 与其他上下文来源：隐藏。
- `turn/end` 的原因映射到消息上：
  - `aborted{user}` → `stopCause:'user_stop'`；
  - `aborted{hook:aiclient-interject}` → `'interjected'`；
  - `error` → 标记为 incomplete 的助手占位，如果下一回合是重试就不显示；
  - `interrupted` → 系统注记「本轮在引擎中断时未完成」，同一回合里的工具结果按错误码标记 `outcomeUnknown` 或 `notStarted`。
- bridge 在 bootstrap 时用 `observeSession` 做一次全量折叠，之后按 `session/event` 增量折叠。`initialHistory`、`history`、`tree`、`leaf` 都读这份缓存。

**4.2 树与 leaf**（[分片 03 §2](p1-4-bridge-parity/03-history-tree-rewind.md)）

- 节点就是投影出的消息，`parentId` 是同一个 DSH 会话链上的前一条消息。
- 桩里 lineage 列出的各个会话（当前会话加退役会话），把各自的链按 id 合并；共享前缀的 id 相同，自然合在一起。
- `active` 表示在当前会话链上；`forkable` 表示路径上有助手消息；上限 4000 个节点。
- 退役会话是不可变的，按 id 缓存。

**4.3 回退与 fork**（[分片 03 §3～§5](p1-4-bridge-parity/03-history-tree-rewind.md)）

- **边界**
  - 回退到用户消息：边界是上一回合的最后一个事件；这条消息的文本作为 `editorText` 返回。
  - 回退到助手 step：边界是该 step 的 `step/end`。
  - fork：边界是目标节点的最后一个事件。
- **回退顺序**
  1. 在旧 agent 上用 `runMaintenance` 占住空闲期；
  2. `agents.create({sessionId: aiclient-<逻辑 id>.r<n>, seed, inheritedEventCount, meta:{cwd, parentSession, isSeeded:true}})`，再 flush；
  3. 原子改写桩（v2，追加 lineage）；
  4. dispose 旧 handle，把监听切到新 id；
  5. 返回 history、tree、leaf。
- **崩溃窗口**
  - 在第 2、3 步之间崩：桩仍指向旧会话，回退算失败，新会话成了孤儿，交给 P1-3 清理。
  - 在第 3、4 步之间崩：重启后按桩恢复新会话，锁已随进程释放。
  - 两种情况都不会出现「索引、桩、日志三方不一致」。
- **fork**
  - `WorkerForkPayload` 追加可选字段 `targetLogicalSessionId`。Main 把铸 id 挪到 RPC 之前，子会话 id 为 `aiclient-<新逻辑 id>`。
  - 源侧建好子会话后立即 dispose，释放写锁给目标 slot。
  - 沿用 `.staged` 标记和启动清扫（`WorkerManager.ts:651-710` 按目录处理，对桩同样适用）。
  - discard 时删桩；日志留给 P1-3 当孤儿清理。
- **对 P1-3 日志清理的要求**
  - 引用集合 = 索引行的桩 → 每个桩的 `dshSessionId` 和整条 lineage → 再加上这些会话的子代理子会话（header 的 `parentSession`）。
  - 以下都是孤儿：没有被引用的 `aiclient-*` 会话、只有 header 的会话、被 discard 的 fork。

**4.4～4.7**（[分片 04](p1-4-bridge-parity/04-turn-semantics.md)）

- **重试**
  - 只有在空闲、且最后一个 `turn/end` 是 `error`、`interrupted` 或 `aborted` 时才受理，否则在发出任何事件之前抛 `WORKER_RETRY_UNAVAILABLE`。
  - 受理后 followup 续跑提示，不回显用户消息，发 `running`。
- **插话**：见 §1 第 7 条。
- **附件**：admit 失败时，在发出任何事件之前抛错；回显和历史都带附件元数据。
- **用量**：见 §1 第 9 条。
- **其余事件**
  - `thinking.started/completed`：来自 `block-start` / `block-end`。
  - 工具参数的流式摘要：把生成端移到 shared。
  - `execStartedAt`：挂 `tools/execute`。
  - `llm/retry` → 重试横幅。
  - 问答 answerer；命令列表与执行；`/compact`。
  - 后台任务、goal 的通知 → `custom.message`。
  - goal、todo、plan、权限的状态 → 新事件 `session.projection`，渲染归 P1-7。
  - 每轮的 model / effort 装配到位，路由解析由 P1-5 提供。
  - 失败：`session.failed` 取 `LlmFailure.message` 和 `code`。
- **reload**：保持不支持。它只服务 pi TUI，去留归 P1-11。
- **权限 setter**：仍归 P1-6。当前它们假报 `applied:true`（`piWorkerRpcServer.ts:958-993`），这是已知风险。

**4.8 主进程只读回放**（[分片 04 §6](p1-4-bridge-parity/04-turn-semantics.md)）

- 在 P1-3 的宿主控制消息里加一个只读读取操作：`{host:'readPage', id, stubFile, offset, limit}`。
- 宿主侧依次：读桩 → 校验逻辑 id → `observeSession` → 投影、分页 → 返回 `SessionHistoryPage`。
- Main 的 `CHAT_READ_SESSION_PAGE` 遇到 DSH 行时改走这个操作，照旧广播 `session.history`，mode 为 `branch`。
- 宿主不在，或者读取失败，就报 `session_replay_unavailable`，渲染层退回到恢复。

## 5 需要拍板的决策点

| # | 决策 | 选项 | 推荐 | 理由 | 代价 |
|---|---|---|---|---|---|
| D1 | 历史、树的粒度 | A 按消息投影，树跨 lineage 合并；B 只画当前会话的线性树 | A | 兑现树对话框的文案；id 用 DSH `MessageId`，跨分叉稳定 | 要读退役会话；树的构建要做缓存 |
| D2 | 回退怎么实现 | A 桩指针切换 + 种子子会话；B 回退改成新建一个逻辑会话（fork 语义）；C DSH 会话上不支持回退 | A | 决策 006 预留了这条路；会话键、索引都不动 | 多出退役日志；清理要看 lineage；回退会暂停正在进行的 goal |
| D3 | **重试上一轮（需用户拍板）** | A 隐藏的续跑提示（`aiclient-retry`）；B 用 `agent/request-error` 把失败的请求挂起，等用户点「继续」；C 分叉到失败回合之前，重发原消息 | A | 实现简单、稳健；已完成的工具轮保留；用户看不到这条提示 | 模型多看到一条短的 user 消息，偏离决策 045 的字面。B 不加消息，但回合挂起期间一直算在跑，崩溃后无法续上；C 会丢掉已完成的工具轮，违反决策 045 |
| D4 | 插话语义 | A 保持 v1.0.3：步边界 `cancel(hook)` 收尾；B 在步边界拒绝下一步（`pre-step` reject → `blocked`）；C 改用 DSH 的 `steer`，消息直接进当前回合 | A | 落盘原因可区分；不会吞掉已取出的输入；渲染层不改 | 会让进行中的 goal 暂停。B 在落盘记录上有歧义，还会吞掉插入的通知；C 是产品语义变更，要改协议和渲染层 |
| D5 | 只读回放 | A 宿主读取（`sessionQuery`）+ 共享投影；B Main 自己解 zstd 帧；C 在 Main 里引用 DSH 的持久化库 | A | 格式由 DSH 自己负责；进程是白名单载体；不写盘 | 预览依赖宿主在线（冷启约 0.8 s）；要在 P1-3 加一个宿主操作 |
| D6 | fork 子会话 id | A Main 预铸逻辑 id，随 `worker.fork` 下发；B 由 bridge 自己铸 DSH id | A | 保住决策 006 的「从逻辑 id 反推」 | Main 调整 3 行顺序，RPC 多一个可选字段 |
| D7 | goal、todo 等状态的线协议 | A 新增 `session.projection {key, view}`；B 复用 `custom.entry` | A | 有类型、后到的覆盖先到的；同一个版本发布，没有兼容问题 | 事件联合类型多一个成员 |
| D8 | 中断回合怎么展示 | A 历史里加系统注记，已流出的半截正文只留在渲染层内存里；B 由 Main 把半截正文落成本地注记 | A | 现有合并规则会保留没对上的运行期消息，不需要改动 | 重开窗口之后，半截正文就看不到了 |

除了 D3，其余各项都可以按工作方式先自主决定，每条单独写一份决策，标「待审批」，编号接续。D2 A 会改变回退时的实际行为，需要把树对话框里「Pi 会话文件不截断」的文案改成与引擎无关的说法（放在 P1-4b 一起改）。

## 6 子任务切分与改动清单（明细见[分片 05](p1-4-bridge-parity/05-gate-and-changes.md)）

| 子任务 | 内容 | 主要文件 | 约（产品 / 测试） | 依赖 |
|---|---|---|---|---|
| P1-4a 历史投影与只读回放 | 纯投影模块；bridge 历史缓存；`initialHistory`、`history`、`tree`（单会话线性）、`leaf`；中断与 `TOOL_OUTCOME_UNKNOWN` 进历史；宿主 `readPage` 与 Main 的 DSH 预览 | `src/shared/dshHistory/*`（新）、`dshSessionRuntime.ts`、`bridge/historyCache.ts`（新）、`bridge.js`、`chat.ts`、P1-3 的宿主控制与 supervisor | 900 / 800 | P1-1；`readPage` 依赖 P1-3 |
| P1-4b 回退、fork 与树 | 桩 v2 加 lineage；指针切换式回退；fork 与接受 / 丢弃；跨 lineage 的树；给 P1-3 的引用集合接口 | `dshSessionRuntime.ts`、`bridge/lineage.ts`（新）、`dshHistory/tree.ts`、`workerRpc.ts`、`WorkerManager.ts`、`SessionTreeDialog` 的文案 | 650 / 550 | a |
| P1-4c v1.0.3 语义 | 插话与 `turnActive`；重试续跑；图片与文本附件；回显带附件元数据 | `dshSessionRuntime.ts`、`bridge/attachments.ts`（新）、`dshHistory/projection.ts` 的隐藏规则 | 350 / 450 | a；D3 拍板 |
| P1-4d 其余事件 | 用量；思考起止；流式参数；`execStartedAt`；工具行标志；`outcomeUnknown` 的类型与文案；重试横幅；问答；命令与 `/compact`；通知；`session.projection`；每轮 model / effort；失败映射；能力清单 | `dshSessionRuntime.ts`（拆成 `bridge/*.ts`）、`runtimeEvents.ts`、`sessionHistory.ts`、`shared/streamingToolArgs*`、渲染层工具行一处 | 900 / 700 | a；费用与路由依赖 P1-5 |
| P1-4e 录制门禁 | `bridge-record.ts` 的场景与归一化；三类金样本；渲染层回放测试；投影金样本测试；假网关新增场景；CI 步骤 | `src/dsh-host/bridge-record.ts`（新）、`src/shared/__tests__/fixtures/dsh*.json`、`dshStreamReplay.test.ts`（新）、`fake-gateway.mjs`、`build.yml` | 700 / 与金样本同步 | 骨架和 a 同批；各子任务各自补场景；CI 接入在收口 |

**顺序与边界**

- **顺序**：P1-3（通道）→ a（与 e 的骨架同批）→ b、c、d 并行，并行代理最多 2 个 → e 收口，全量测试只跑一次。
- **P1-3**：通道、`readPage` 的承载、日志清理（按 §4.3 的引用集合）。Stop 升级时用的种子分叉续聊（P1-3 D5 的选项 C）复用 P1-4b 的机制。
- **P1-5**：路由解析（每轮 model / effort）、图片模态、定价（`costUsd`）、重试策略、`LlmFailure` 映射到登录、额度等错误。
- **P1-6**：权限 setter、`permission.activity`、四档与 `allow_session`；P1-4 只透传 DSH 的越界审批。
- **P1-7**：goal 条、todo 卡、jobs 面板、子代理面板（`subagent.activity` 由 P1-7 产出）、DSH 工具名的行文案（如 `read_image`、`job_*`、`update_goal`）、`present` 工具。
- **P1-9**：转换器复用 pi 解码链；pi 会话里的分支可以转成 lineage。
- **P1-11**：`reload`。
- **P1-12**：把 pi 解码链（`runtime/plugins/session/codec.ts`、`legacy.ts`，`agent-host/piSessionTimeline.ts`）搬到 shared，不删；native 的金样本随 runtime 一起退役。

## 7 测试与门禁（[分片 05 §1～§3](p1-4-bridge-parity/05-gate-and-changes.md)）

- **纯单测**（根 vitest，不装 DSH 包）
  - 投影与树：用录下的 DSH 原始日志作输入，比对金样本。
  - bridge：用假 `DshBridgeContext`，覆盖重试受理规则、插话、附件拒绝、fork 与回退的崩溃窗口（注入失败点）、桩 v1 到 v2 的读取。
  - 渲染层：`dshStreamReplay.test.ts` 把录到的流灌进真实 reducer，断言用户最终看到的内容。
- **录制门禁**
  - `node src/dsh-host/bridge-record.ts --check` 起真实宿主和假网关，逐个场景录制并归一化，再和金样本做 diff。
  - 场景包括流式、工具、审批、思考、失败后重试、插话、Stop、图片、`/compact`、后台任务通知、todo / goal、SIGKILL 后恢复、回退、fork、只读回放。
  - 需要归一化的内容：丢掉 `seq`、`timestamp`；UUID 换成 `id-N`；路径换成占位符；epoch 换成 `<ms>`；用量里的数字清零；同一块内连续的 delta 合并。
  - 金样本只在收口时重录。
- **CI**
  - 在 `build.yml` 的 gate 里加一步：`src/dsh-host` 执行 `npm ci`，取随包 node，然后跑 `--check`。
  - 另加一个分支 / 手动触发的 workflow；推送前需要用户确认。
- **退出判据建议细化为：**
  - 录制门禁进 CI；
  - 开发机 GUI 点验以下场景：重开会话见历史、崩溃重启见中断注记、回退、fork、失败后「继续」、Ctrl+Enter、发图、用量环、`/compact`。

## 8 风险与未覆盖

- **需实测**（前两项是 P1-4c / P1-4b 开工前要先做的小实验，单个脚本，先 `free -m` 确认内存）：
  - 在 `session/event` 监听里同步调用 `cancel`，是否安全、是否来得及赶在下一步 claim 之前。
  - 带 seed 的 `agents.create` 之后，flush 能否保证已落盘；dispose 之后，同一宿主里能否马上 resume。
  - `observeSession` 读 2000 条消息的会话，耗时和内存各是多少。
  - 假网关分块的确定性。
- **行为差异**
  - DSH 会把图片归一化（2048² 像素预算、4 MiB 目标），模型收到的是缩小后的图。
  - 回退、fork 会让进行中的 goal 暂停或失去武装（`dsh-goal-round-driver/README.md:53`、`:57`）。
  - 回退会 dispose 旧 agent，它名下的后台任务随之结束。建议有后台任务时拒绝回退。
- **临时状态**：DSH 发起的回合（goal 续跑、后台任务唤醒）Main 并不知道，它的 busy 锁和 Stop 看门狗对这类回合只能部分覆盖，需要和 P1-3 / P1-7 一起看。
- **格式漂移**：DSH 升级会改事件词表或日志代际。金样本 diff 是第一道警报；D5 A 把读盘交给了 DSH 自己。
- **无法核实**：官方 DSH 客户端的重试和回退交互。`dsh-web-app` 没有安装，无从对照。
