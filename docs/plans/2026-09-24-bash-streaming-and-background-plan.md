# bash 实时输出、后台命令与 Stop 误记成功（D3 / D4 / T130）实施计划

> 日期：2026-09-24　·　主题分支：`feat/bash-streaming-background`（批次 M 快进 main 之后从 main 开）
> **状态：计划定稿，实施暂停**。等 DSH 底座可行性调研（`2026-09-24-dsh-rebase-feasibility-study.md`）出结论后，再决定是在自有 runtime 上做，还是按 DSH 的方式做（用户 2026-09-24）。T130 属于缺陷修复，可以单独提前做（B1 + B2）。
> 范围：三件事都落在 bash 工具上，放在一个分支里做。
> - **D3**：运行中的 bash 行实时显示 stdout/stderr。
> - **D4**：后台命令（`run_in_background` + 读输出 + 停止 + 后台任务条），用户 2026-09-24 已认可这个形态。
> - **T130**：被 Stop 中止的 bash 在 store 里记成了成功。
>
> 原来的 D3 计划文档已经丢失，本文替代它。任务状态以 roadmap 为准。落地时这批任务登记为批次 N，任务号和决策号接着届时 roadmap / decisions 的最大号往下编（T137 / T138 和决策 044 / 045 已被 09-24 的其他事项占用）。

---

## 1. 背景与目标

### 1.1 用户现场

1. **长命令看不到任何输出**。用户跑 1800 秒的命令，界面上一个字都没有。`20f172da` 和 `6e85aff2`（决策 043 规则 5）让运行中的行可以展开，也能看到完整命令和「已耗时 / 超时上限」，但**输出要等命令结束才出现**。
2. **一条 `sleep` 卡住整段对话**。模型执行 `sleep 240; gh run view …`，整个对话被挡了 4 分钟。按 Ctrl+Enter 插话也救不了：插话要等到回合边界才生效，而回合边界在这条工具调用跑完之后（`2026-09-23-ctrl-enter-interject-plan.md`「风险 1」）。
3. **T130**：用 Stop 中止的 bash，在 store 里记成 `toolOk=true`，时间线上显示成已完成（2026-09-24 开发机点验时发现，roadmap:369）。

### 1.2 目标

| 编号 | 目标 | 判据 |
|---|---|---|
| G1 | 运行中的 bash 行展开后，输出持续刷新 | 每秒打一行的命令，展开后能看到逐行出现（刷新频率不超过 4 Hz）；行保持折叠时渲染成本为零 |
| G2 | 实时输出不能拖垮渲染和会话文件 | 每条流式事件只重渲染一个叶子组件；流式片段不写入会话文件，也不写入 trace |
| G3 | 模型可以把命令放到后台，回合不被挡住 | `bash {run_in_background:true}` 立即返回 task id，回合可以正常结束 |
| G4 | 后台命令结束后，模型会被告知 | 下一次请求带上完成通知，内容含尾部输出；不会重复投递；可以按 A1 从日志回放 |
| G5 | 用户能看见并控制后台命令 | 输入框上方的后台任务条显示运行中和已结束的任务、耗时，并有停止按钮 |
| G6 | 后台命令走同一道权限闸，不留孤儿进程 | 与前台用完全相同的 `shellPolicy` / 授权流程；关会话、退出应用、worker 崩溃后不残留进程 |
| G7 | 被 Stop 的 bash 如实记为「已停止」 | 实时和回放两条路径都是 `toolOk=false`，并带结构化的 `stopped` 标记；行显示「终端 … · 已停止」，不标红 |

---

## 2. 现状（以代码为准）

### 2.1 bash 工具

| 事实 | 位置 |
|---|---|
| 只有配置了 shell 才注册 bash（windows-04） | `src/runtime/plugins/tools/index.ts:434` |
| 参数只有 `command`、`timeoutSeconds`（上限 6h）、`timeoutMs`（上限 600s）；默认超时 120s | `tools/index.ts:440-464`，`:47`，`:49` |
| 执行顺序：`checkShellPaths` → `target('bash', …)`（即 `runtimePermissions.authorize`）→ 再查一次路径，防止审批期间路径变化 → `runtimeExec.run` | `tools/index.ts:465-496`，`target()` 在 `:165-202`，`checkShellPaths` 在 `:240-289` |
| **`execute(id, args, signal)` 没接第 4 个参数 `update`**。注册包装层其实已经把它透传下来了 | `tools/index.ts:465` 对照 `:147-162` |
| 输出预算是 `maxOutputBytes: TOOL_OUTPUT_BYTES`（50 KiB），`overflow: 'truncate'` | `tools/index.ts:26`，`:493-494` |
| 结果文本是「stdout + `\n[stderr]\n` + stderr」，Windows 的 OEM 代码页由 `decodeConsoleOutput` 解码 | `tools/index.ts:503-506` |
| 状态尾 `[exit=…; termination]` 在截断之前就预留好字节（tools-03） | `tools/index.ts:523`，`result()` 在 `:754-767` |
| details 只放标量（exitCode / termination / 字节数 / truncated / cleanupError） | `tools/index.ts:510-522` |

### 2.2 exec 宿主（host 插件）

| 事实 | 位置 |
|---|---|
| 产品两种 carrier 都用 `exec.mode = 'pipe'`，`cleanupTimeoutMs = 2000` | `src/runtime/host/worker.ts:65-68` |
| `ExecPlugin.run`：外部 signal 会被转成内部 controller 的 `'aborted'`；如果调用前已经 abort，直接返回 `termination:'aborted'` 的空结果 | `src/runtime/host/exec.ts:41-82` |
| `runPipe.consume`：stdout 和 stderr **共用**一个 `retained` 预算，**只保留头部**，超出的丢弃并置 `truncated`，命令继续跑 | `exec.ts:785-805` |
| 超时走 `stop('timeout')`，abort 走 `stop('aborted'/'disposed')`：先发 SIGTERM，过半个 cleanup 期升级为 SIGKILL，到期强制收尾 | `exec.ts:720-721`，`:757-784` |
| **abort 时 `runPipe` 是 resolve（`termination:'aborted'`），不是 reject** | `exec.ts:739-756`，`:757-784` |
| 进程树清理：POSIX 用 `killGroup(-pid)`（可注入，附录 B1）；Windows 用 `taskkill /PID /T /F`，并且只执行一次 | `exec.ts:488-556` |
| 前台命令的组长正常退出后，仍会把整个组杀掉（因此 `cmd &` 起的子进程活不过这条命令） | `exec.ts:823-835` |
| runner carrier：IPC 断开时，由 runner 杀掉自己的进程组，Windows 下用 taskkill | `src/runtime/host/exec-runner.mjs:15`，`:26-37` |
| 长寿子进程 `spawn()` / `spawnPersistent`：有 `onStdout/onStderr` 回调、`kill()`、`exited`，受 shutdown 统一回收，POSIX 下登记到孤儿回收器。**stdin 永远是 pipe** | `exec.ts:84-120`，`:283-467`（stdio 在 `:306`，reaper 在 `:314-319`） |
| 契约 | `src/runtime/contracts.ts:453-475`（`RuntimeExecRequest`），`:521-535`（`RuntimeSpawnRequest`） |

### 2.3 权限闸

- 计划模式下 bash 只放行 exploration 命令；`accept-edits` 档直接放行 bash。见 `src/runtime/plugins/permissions/index.ts:514-524`、`:578`。
- `isExplorationCommand` 会拒绝单个 `&`，所以模型无法靠在命令里写 `&` 绕过闸门。见 `src/shared/runtimeShellPolicy.ts:3`。
- 授权卡上的动作是结构化标识 `PermissionRequestAction`，bash 对应 `run_command`（T023）。见 `src/shared/types/runtimeEvents.ts:436`、`src/runtime/worker/permissionPrompt.ts:107-120`、渲染层文案 `questionCardModel.ts:864`。

### 2.4 事件链路（runtime → worker → Main → 渲染层）

| 环节 | 事实 | 位置 |
|---|---|---|
| pi 0.84.4 | 工具调用 `update(partial)` 会产生 `tool_execution_update`；**`execute` 只要不抛异常，就是 `isError:false`**；`afterToolCall` 总会执行，并且可以改写 `isError` | `src/runtime/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:452-481`，`:482-516`；`types.d.ts:254` |
| 投影器 | `tool_execution_update` 被投成 `tool.updated`：**每次都带完整 `input: event.args`**，外加 `status`（最后一行，最多 120 字符） | `src/runtime/events/projector.ts:615-639` |
| 投影器 | 参数流式阶段按 `TOOL_ARG_COALESCE_MS = 100` 节流（T101） | `projector.ts:34`，`:392-401` |
| 投影器 | `tool.completed.ok = !isError`；N5 结果标记只复制 `refused` | `projector.ts:640-665`，`:107-114` |
| 生产者现状 | **目前没有任何工具调用 `update`**（grep 过 `src/runtime/plugins`），所以 `tool.updated.status`（T38-c）在 native 下没有生产者，这正是 T053 说的那类问题 | — |
| agent loop | 只在 `message_end` 时 `appendMessage`；trace 只记 `tool_execution_start/end` ⇒ **update 事件天然不落盘、不进 trace** | `src/runtime/plugins/agent-loop/index.ts:878-907` |
| EventsPlugin | 两次运行之间发出的事件不带 requestId，逐个订阅者隔离投递 | `src/runtime/events/index.ts:29-43` |
| Main | `handleWorkerEvent` 每收到一个事件就刷新 `lastUsedAt`，然后广播给所有窗口 | `src/main/services/agent-host/WorkerManager.ts:2818-2865`；`src/main/ipc/chat.ts:92-105` |
| 渲染层 chatSessions | `tool.updated` 没带 input 时直接返回（`:1394`）；`tool.completed` 写 `toolOk: ok`（`:1425`） | `src/renderer/stores/chatSessions.ts:1393-1432` |
| 渲染层 Run 面板 | `tool.updated.status` 是 Run 面板「当前工具进度行」唯一的数据来源 | `workspace-shell/surfaces/contextSurfaceModel.ts:434-436`，`RunSurfaceView.tsx:136-138`，`runPanelModel.ts:212-255` |
| 渲染层诊断环 | 高频事件按前缀折叠 | `src/renderer/components/chat/eventRing.ts:43-47` |
| 渲染层存活 / 进度判定 | `tool.*` 同时计入「进度」和「存活」 | `assistantProgress.ts:310-312`，`:350-370` |

### 2.5 运行中工具行的渲染

- `ToolRowContent`：运行中的行在行尾显示 `RunningToolClock`，它是一个独立叶子，通过 `ToolRowClockContext` 拿到每秒的 tick。这样 tick 不会触发 `deriveToolGroupRows` 重算（决策 043 规则 5，`[ROW-CLOCK-2]`）。见 `ToolRows.tsx:215-217`、`:818-857`；时钟来自 `MessageTimeline.tsx:205-214` 和 `:512`。
- 面板没有高度动画（`TOOL_ROW_PANEL_CLASS`，决策 043 规则 4）；Base UI 因此同步挂载 / 卸载 body，**折叠状态下 body 不存在**。见 `ToolRows.tsx:271-291`。
- 用户点击展开会通知滚动跟随器，并**暂停贴底跟随**（C3）。见 `ToolRows.tsx:326`、`:804-816`，`messageTimelineScroll.ts:127-148`，`MessageTimeline.tsx:600-606`、`:696-718`。
- 按行订阅相邻 store 的先例：`SubagentActivity` 用 `useSubagentActivityStore((s) => s.lanes[id])`；`SubagentDetail` 的局部滚动只在「本来就停在底部」时才跟随。见 `ToolRows.tsx:371`、`:542-585`。
- `deriveToolRowView`：运行中的行，body 只有输入（命令）；`runningStartedAtMs` / `runningTimeoutMs` 已经接好。见 `toolCard.ts:564-645`、`:758-779`；`deriveToolGroupRows` 在 `:811-855`。
- 相邻 store 的写法：纯 reducer（node 环境可测）加 zustand 壳，由 `ChatWorkspace` 负责 `init()`，由 `sessionLifecycle` 负责修剪。例子见 `stores/subagentActivity.ts:26-49`、`ChatWorkspace.tsx:203-209`、`stores/sessionLifecycle.ts:77-97`。

### 2.6 子代理模式（D4 要复用的部分）

- `Task` 立即返回，委派在后台跑。见 `src/runtime/plugins/subagent/index.ts:1286-1367`。
- `TaskWait`：等待有上限（600/900s），可以被插话信号 `runContext.interrupt` 打断，把已结算的标记为已送达。见 `subagent/index.ts:1578-1722`，打断在 `:1650-1658`。
- `TaskStop` 等待有上限。见 `subagent/index.ts:1773-1907`。
- 登记表：并发 10，保留 100 条，`deliveredAt` 防止重复投递。见 `subagent/registry.ts:25`、`:27`、`:83`。
- 结果怎么交给模型：运行结束时 runtime 会等子代理（`collectFinished` 循环），再用带标记的内部消息 `markInternalMessage(…,'subagent-report')` 续跑。见 `agent-loop/index.ts:1046-1098`。
- **子代理会让运行不结束**；插话时不等待（决策 041 规则 1/2）；Stop 会杀掉全部子代理（决策 041 规则 4）。见 `agent-loop/index.ts:911-914`、`:1165-1202`。
- `SubagentRun` 有一个没有生产者的钩子 `resolveToolOutcome`，接在它自己的 `afterToolCall` 上。见 `subagent/run.ts:195-197`、`:305`、`:398-418`。

### 2.7 生命周期与回收

- worker 的 `stop()` 只 abort 当前回合的 controller，然后由 agent loop 调 `agent.abort()` 和 `subagents.abortAll()`。见 `nativeWorkerRuntime.ts:473-495`，`agent-loop/index.ts:911-914`。
- `reload()`（Pi TUI 交接后 CHAT_SEND 会触发）是**先退订事件再销毁整张插件图**。见 `nativeWorkerRuntime.ts:685-706`，退订在 `:703`。`dispose()` 在 `:970-1003`。
- `createRuntime().dispose()` 的第一步是 `runtimeExec.shutdown()`，会杀掉所有 run 和 spawn 起来的子进程。见 `src/runtime/bootstrap.ts:639-676`，`:656`。
- Main 的回收条件 `isSafeToEvict` 只看 `ownerWebContentsId` / `activeRequestId` / `mutationInFlight`。空闲清扫的默认阈值是 15 分钟，容量不够时也会回收空闲会话。见 `WorkerManager.ts:2709-2716`、`:2718-2726`、`:2781-2789`、`:355`。
- 退役窗口里只转发 `permission.resolved` / `question.resolved`（main-host-03）。见 `WorkerManager.ts:2909-2917`。

### 2.8 T130 根因（已坐实）

1. 用户点 Stop，`tools/index.ts:495` 的 `signal` 被 abort；`runPipe` 以 **resolve** `termination:'aborted'` 收尾（`exec.ts:721`、`:757`、`:739-756`）。
2. bash 把它当普通结果返回，文本是 `…\n[exit=null; aborted]`（`tools/index.ts:505-524`），**没有抛异常**。
3. pi 对不抛异常的执行结果一律设 `isError:false`（`agent-loop.js:466-468`）。
4. 投影器写 `ok: !event.isError`，也就是 true（`projector.ts:649`）；渲染层写 `toolOk: true`（`chatSessions.ts:1425`）。回放同样如此：`ok: message.isError !== true`（`src/agent-host/piSessionTimeline.ts:429`）。
5. 对照：read / grep 这些工具在 abort 时会 `throwIfAborted()` 抛出，所以它们一直是 `isError:true`。**只有 bash 例外。**

---

## 3. 设计

### 3.1 D3：流式 bash 输出

**原则**：实时输出是一条**只存在于内存、可以丢失**的旁路。它不进会话文件、不进 trace、不进 chatSessions，结算后的结果完全不变。

#### 3.1.1 runtime

1. **exec 契约**：给 `RuntimeExecRequest` 增加可选的 `onOutput?(stream: 'stdout'|'stderr', chunk: Uint8Array)`。`runPipe.consume` 在做预算判断**之前**，对每个 chunk 调一次（这样头部预算用满之后，尾部仍在更新），外面包 try/catch，回调抛错不能影响命令执行。`host-adapter` 模式下不支持流式的 adapter 可以不调用它，效果就是退化成没有实时输出，这是如实的。
2. **新模块 `plugins/tools/liveOutput.ts`**：
   - `ByteRing`：有界字节环，记录绝对偏移（`totalBytes`），stdout 和 stderr 按到达顺序合并写入，和终端的观感一致。
   - `LiveOutputTail`：前台保留最后 `SHELL_LIVE_TAIL_BYTES = 8 KiB`。取快照时先丢掉开头的 UTF-8 续字节，再用 `decodeConsoleOutput(…, {truncated:true})` 解码。
   - `createLiveOutputPublisher`：节流到 `SHELL_OUTPUT_COALESCE_MS = 250`（最多 4 Hz），带尾沿补发，只有新增了字节才发。时钟和定时器都可注入，便于测试。`stop()` 取消还没发出的定时器。
3. **bash 接上 `update`**：`update(partial)` 里的 `partial = { content:[{type:'text', text: tail}], details:{ liveOutput:{ omittedBytes, totalBytes } } }`。命令结束后调 `publisher.stop()`，不再补发最后一次，因为最终输出由 `tool.completed` 带。
4. **开关**：`AICLIENT_BASH_STREAM`，默认开，设为 `0` 时 bash 完全不调 `update`（工程规范 §6）。从 `flags.ts` 读取，经 `bootstrap.ts` 传入 `ToolsConfig`，和 `STREAM_TOOL_ROWS_ENV` 的做法一样（`flags.ts:64`，`bootstrap.ts:423-425`）。

#### 3.1.2 事件协议：新增 `tool.output`

不复用 `tool.updated`，理由有两条：① `tool.updated` 每次都带完整参数，bash 命令最长 32 KiB，按 4 Hz 算，两跳 IPC 上全是重复字节；② `ToolUpdatedEvent` 的文档明确写了「永远不是正在增长的输出正文」（`runtimeEvents.ts:949-956`）。

```ts
// src/shared/types/runtimeEvents.ts
export interface ToolOutputEvent extends RuntimeEventBase {
  type: 'tool.output';
  sessionId: string;
  payload: {
    messageId: string;
    toolCallId: string;
    /** Latest tail, replaces the previous one (idempotent, self-healing on drops). */
    tail: string;
    /** Bytes produced before `tail` that are not shown. */
    omittedBytes: number;
    totalBytes: number;
  };
}
```

- **投影器**：在 `tool_execution_update` 分支里，`details.liveOutput` 存在就发 `tool.output`（**不带 input**），否则走原来的 `tool.updated` 分支。
- **T053 收口**：`tool.updated.status` 连同投影器里生成它的逻辑一起退役；Run 面板的进度行改为读 `tool.output`（取 tail 最后一个非空行，最多 120 字符），这样 T38-c 第一次有了真实的生产者。
- 采用「整段替换」而不是「增量追加」：事件丢了也能自愈，和 T053「丢事件不可检测」的现状相容。

#### 3.1.3 渲染层

- **相邻 store**：`components/chat/toolLiveOutputModel.ts`（纯 reducer）加 `stores/toolLiveOutput.ts`（zustand 壳）。
  - 数据是 `byCall[toolCallId] = { sessionId, tail, omittedBytes, totalBytes, updatedAt }`。
  - 收到 `tool.output` 就替换；`tool.completed` 时删掉对应条目；该会话出现 `session.completed/failed/stopped` 时清空；会话被修剪时一起删。
  - 上限：最多 32 条（按 `updatedAt` 淘汰），每条 tail 截到 16 KiB（运行时已经限到 8 KiB，这里是防御性的双保险）。
  - `normalizeLiveTail()` 是纯函数：去掉 ANSI CSI 序列；对同一行里的 `\r` 只保留最后一段，让进度条显示成一行。
- **不改 chatSessions**。这是 T-34 以来的红线：流式片段不进消息树，所以 `MessageTimeline`、`ChatTurn` 的 memo、`deriveToolGroupRows` 都不会因为输出事件重算。
- **行视图**：`ToolRowView` 加 `liveOutput?: true`，条件是运行中、bash 家族、并且有 `toolCallId`。视图模型里只放这个标记，不放 tail，思路和时钟的做法一致。
- **叶子组件**：`ToolRowBody` 在输入段下面挂 `<LiveToolOutput toolCallId>`，只有它自己订阅 `byCall[id]`。
  - 显示为 `max-h-72` 的等宽 `<pre>`，`text-code`，`text-muted-foreground`。
  - 有省略时，顶部加一行 `text-meta` 的「已省略前 {{size}} 输出」。
  - 还没有输出时显示「等待输出…」。
  - 局部滚动复用 `SubagentDetail` 的「只在停在底部时跟随」：把它抽成 `useFollowTail()`，两处共用。
- **折叠状态不加任何东西**。T108 刚把行尾的内容收窄，决策 031 / 043 规定行默认折叠；body 不挂载，渲染成本就是零。
- **和滚动跟随器（决策 043 规则 4）的关系**：展开是用户点击触发的，会先暂停页面贴底（C3）；tail 面板有高度上限，填满后页面高度就不再变化；不需要新增任何滚动规则。
- **结算之后**：行 key 从 `live` 切到 `settled`，body 换成最终输出；实时条目在 `tool.completed` 时删除。
- **子代理里的 bash 行**：v1 不显示实时输出。`activityForEvent` 本来就忽略 update 事件（`subagent/records.ts:565-625`），这里保持现状，写入交付说明。

#### 3.1.4 容量

| 位置 | 上限 |
|---|---|
| 每个运行中 bash 的实时事件 | 每秒最多 4 条 × 8 KiB，即不超过 32 KiB/s |
| 渲染层 | 最多 32 条 × 16 KiB |
| 会话文件 | 0（`tool_execution_update` 从不写入，`agent-loop/index.ts:880-887`） |
| trace | 0（`agent-loop/index.ts:891-905` 只记开始和结束）。另外在结束时补一条摘要 note `tool_output_stream {tool_call_id, updates, bytes}`，用于评估节流效果（工程规范 §2 / §13） |

### 3.2 D4：后台 bash

#### 3.2.1 模型接口（按用户认可的形态，参照 Claude Code 的 BashOutput / KillShell）

| 工具 | 参数 | 返回 | access |
|---|---|---|---|
| `bash`（新增参数） | `run_in_background?: boolean` | 立即返回：`Started background task bg-7f3a2c …`，details 为 `{ background:{ taskId } }` | shell（不变） |
| `bash_output` | `taskId?`、`waitSeconds?`（0–600，默认 0） | 带 id：返回**上次读取之后**新增的输出（每次最多 50 KiB；读落后超过环形缓冲时说明跳过了多少字节）、状态和退出码。不带 id：列出所有任务 | read |
| `bash_stop` | `taskId` | 杀掉整棵进程树，有界等待退出，返回最终状态和未读尾部（最多 8 KiB） | read |

- 参数名保留 `run_in_background`（蛇形），是用户认可的原样。它和 `timeoutSeconds` 的驼峰不一致，这是有意的：模型对这个名字很熟。
- `waitSeconds` 就是用来替代 `sleep` 的：等到任务退出或超时；**插话（`interrupt`）和 Stop（`signal`）都能立刻打断等待**，任务本身继续跑。这和 `TaskWait` 的做法一致（`subagent/index.ts:1650-1658`）。
- bash 的工具描述要补一句话：「超过约 1 分钟、或需要常驻的命令（dev server、watch、`gh run watch`）请用 `run_in_background`；不要用 `sleep` 等待，改用 `bash_output` 的 `waitSeconds`」。这是对这次现场问题最直接的约束（模型可见，需要配评测用例，见 B7）。
- 工具命名跟随本 runtime 的小写方言（`piToolNames.ts:51-66`），不用 Claude 时代的 `BashOutput` / `KillShell`。

#### 3.2.2 权限

- **后台命令走同一道闸，不另开入口**。把 bash 现有的「`checkShellPaths` → `target` → 复查」（`tools/index.ts:466-473`）抽成 `authorizeShell()`，前台和后台共用。授权通过**之后**才把 spawn 交给后台服务。
- `ToolPermissionRequest` 加 `background?: true`。`permissionPrompt.actionOf` 据此发出新动作 `run_background_command`，渲染层文案为「在后台运行命令（本轮结束后仍继续运行）」，这是 T023 的结构化标识。
- 授权记忆：前台授予的 `npm test` 前缀**同样覆盖**后台的 `npm test`（决策 026 的粒度是命令前缀，后台只改变生命周期）；要用测试钉住。
- 计划模式：不做特殊处理，仍然只放行 exploration。
- **子代理**：v1 不允许启动后台命令。`scopeDelegateTools`（`subagent/index.ts:1383-1408`）对 `run_in_background:true` 返回一段可读的拒绝，不执行。`bash_output` / `bash_stop` 不在 `runtimeToolName` 的映射表里（`src/shared/subagentDefinition.ts:148-163`），子代理本来就拿不到。理由：子代理是一次性的，它起的后台进程归属和回收规则需要单独设计。

#### 3.2.3 运行时：新插件 `plugins/background/`

| 模块 | 职责 |
|---|---|
| `index.ts` | `BackgroundShellPlugin`，服务名 `runtimeBackground`，`inject = [EXEC_SERVICE, TOOLS_SERVICE]`。在 ToolsPlugin 之后注册（和 SubagentPlugin 一样往工具表里注册工具）。bash 通过 `ctx.get(BACKGROUND_SERVICE)` 找到它，做法同 `noteInstructionScope` 找 prompt 服务（`tools/index.ts:216-223`）。对外方法：`start()`、`stop(taskId?, cause)`、`list()`、`bindRun()`、`endRun()`、`takeNotices()`、`shutdown(cause)` |
| `registry.ts` | 准入、结算、游标、送达标记、保留，全部是纯状态，脱离进程也能测 |
| `notice.ts` | 生成给模型的完成通知（英文），总长有上限 |

**进程载体**：用 `runtimeExec.spawn()`（`spawnPersistent`），不用 `run()`。它已经具备长寿子进程需要的一切：`onStdout/onStderr`、`kill()`（先 TERM 再 KILL，Windows 下 taskkill /T）、`exited`、shutdown 时统一回收，POSIX 直连 carrier 下还会登记到孤儿回收器（`exec.ts:314-319`）。前台用的 `run()` 没有 reaper。

契约只需要补一个 `RuntimeSpawnRequest.stdin?: 'pipe'|'ignore'`，后台用 `'ignore'`，让读 stdin 的命令直接拿到 EOF，行为和前台一致（`exec.ts:693`）。组长正常退出后再调一次 `child.kill()`（幂等），把残留成员收掉，和 `runPipe` 的 `:829-830` 行为对齐。

**常量**：

| 名称 | 值 | 说明 |
|---|---|---|
| `MAX_BACKGROUND_RUNNING` | 4 / 会话 | 第 5 个用可读的理由拒绝，不排队 |
| `MAX_BACKGROUND_RETAINED` | 16 条已结算 | 已送达的按最早先淘汰；运行中和未送达的永不淘汰（同 `registry.ts:333-341`） |
| `BACKGROUND_RING_BYTES` | 256 KiB / 任务 | worker 内存上限约 5 MiB |
| 后台默认超时 | `MAX_BASH_TIMEOUT_SECONDS`（6h） | 显式的 `timeoutSeconds` 仍然生效；会话关闭时一定会杀 |
| `BACKGROUND_READ_BUDGET_BYTES` | 4 MiB / 会话 | 超过之后每次读取只返回 4 KiB 并说明原因，防止轮询把 32 MiB 的会话文件写满（T024，同 `subagent/index.ts:164` 的做法） |
| taskId | `bg-` + 6 位随机 base36 | 不用递增序号：worker 重启后序号会重来，和转录里的旧 id 撞车 |

**状态机**：`running → exited(exitCode) | stopped(stopCause) | timed_out | spawn_failed`；`lost` 只由 Main 在 worker 崩溃时合成。`stopCause ∈ model | user | session_closed | session_reloaded`。

**给界面的事件**：`background.updated`，payload 为 `{ task: BackgroundTaskSummary, tail?: { text, omittedBytes } }`。生命周期变化时立即发；输出变化时最多 1 Hz，tail 最多 4 KiB；没有新字节就不发。`BackgroundTaskSummary` 只有标识、枚举、时间戳、数字和命令原文（截到 1024 字符）；**没有任何 runtime 自己写的自然语言**，符合 T023 和 noHardcodedChinese（`src/shared/__tests__/noHardcodedChinese.test.ts:56`）。

#### 3.2.4 怎么告诉模型（与回合结束、Stop、插话的关系）

| 场景 | 行为 | 理由 |
|---|---|---|
| 回合结束时后台任务还在跑 | **不等待**。`session.completed` 照常发出，会话进入 idle | 这正是 D4 要解决的问题；和子代理相反（子代理会让运行不结束，`agent-loop/index.ts:1046-1098`） |
| 运行中有任务结算 | 在下一个回合边界（`prepareNextTurnWithContext`，`agent-loop/index.ts:824-825`，和 `flushDiscoveredInstructions` 同一处）用 `agent.steer(markInternalMessage(…,'background-task'))` 投递完成通知 | steer 是唯一会触发 `message_end` 的注入方式，所以会写进会话文件（A1：模型可见 ⟺ 有日志）；内部标记保证不出用户气泡（`projector.ts:505`、`piSessionTimeline.ts:316`），也不会被当成最新的用户任务（`compaction.ts:164`） |
| 空闲时有任务结算 | 只更新任务条；**下一次运行开始时**（`agent-loop/index.ts:1021`）投递，排在用户消息之后 | 默认不自动唤起模型（见拍板点 2） |
| 模型已经用 `bash_output` / `bash_stop` 读到了最终状态 | 标记为已送达，不再发通知 | 同 `deliveredAt`（`registry.ts:83`） |
| 通知的内容 | 列出每个任务的 id、命令、状态、退出码、耗时、最后 2 KiB 输出，并提示可以用 `bash_output` 读更多；整条最多 8 KiB | 参考 Claude Code 在下一次请求里用 system-reminder 提示后台状态；这里直接附上尾部，省一次往返 |
| 用户点 Stop | **只停前台命令，后台任务不停**（待拍板 1）。agent loop 的 `onAbort`（`:911-914`）和 finally 里的 `drain`（`:1196`）都不碰后台服务 | 见拍板点 1 |
| Ctrl+Enter 插话 | 不需要额外处理：后台任务从不阻塞运行；`bash_output` 的等待由 `bindRun({interrupt: interjection.wake.signal})` 打断（位置同 `agent-loop/index.ts:494-502`） | 与决策 041 同向 |
| `endRun()` | 在 finally 里调用（同 `:1198`）；保留会话绑定，让之后的事件仍然带着 sessionId | 同 `SubagentService.endRun` |

#### 3.2.5 清理

| 情形 | 行为 |
|---|---|
| 关闭会话 / 退出应用 | `nativeWorkerRuntime.dispose()` 在退订事件**之前**调用 `handle.background?.shutdown('session_closed')`：杀掉进程并发出最终事件。Main 的退役排空白名单（`WorkerManager.ts:2909-2917`）加上 `background.updated`，让这些最终事件能到达界面。bootstrap 的 dispose 也调一次（幂等），给非 worker 宿主用，然后才是 `runtimeExec.shutdown()`，由它兜底杀剩下的 |
| `reload()`（TUI 交接） | 在 `:703` 退订之前 `shutdown('session_reloaded')`。**后台任务会被杀掉**，这是已知限制，任务条会显示原因 |
| worker 崩溃或被强杀 | runner carrier 在 IPC 断开时自己杀进程组；POSIX 直连靠 reaper（只处理可捕获的信号）。Main 在 `handleLifecycle` 的 crashed 分支里，把缓存中还在运行的任务合成为 `lost` 并派发 |
| Main 回收 | `isSafeToEvict` 增加条件：该会话**没有运行中的后台任务**（根据 Main 缓存的 `background.updated` 判断）。空闲清扫和容量回收都会经过这里 |

### 3.3 T130：被 Stop 的 bash 如实记为「已停止」

1. **runtime**：bash 在 `termination ∈ {aborted, disposed}` 时，在 details 里加 `stopped: true`。文本和状态尾保持原样，模型仍然能看到已经产生的部分输出。
2. **新增 `plugins/tools/outcome.ts`**，提供 `stoppedToolOutcome({result, isError})`：如果 `details.stopped === true` 且当前 `!isError`，就返回 `{ isError: true }`。挂在两处：
   - 主循环 `new Agent({ afterToolCall })`，在 `agent-loop/index.ts:803-813` 的 `beforeToolCall` 旁边。
   - `SubagentPlugin` 创建 `SubagentRun` 时传入 `resolveToolOutcome`（`subagent/index.ts:1289-1332`），让 `run.ts:195` 这个一直没有生产者的钩子第一次有生产者。
   - 不选「直接抛异常」：pi 的 `createErrorToolResult` 会把 details 清空，结构化标记就丢了（N5 的教训是「不要靠文本判断」）。
3. **投影和回放**：
   - `ToolOutcomeDetails` 加 `stopped?: true`（`runtimeEvents.ts:360`）。
   - 投影器的 `toolOutcomeDetails` 复制这个字段（`projector.ts:107-114`）。
   - `HistoryBlock` 加 `stopped`（`sessionHistory.ts` 的 tool_result 分支），`piSessionTimeline.ts:423-438` 复制它，`chatSessions.ts:846-866` 映射它。
4. **渲染**：
   - `ToolRunOutcome` 加 `'stopped'`，文案复用已有的 `Stopped → 已停止`（`src/shared/i18n.ts:2031`）。
   - 动词用 **done 形**（命令确实跑过），不用 refused 形；读作「终端 sleep 30 · 已停止」。
   - 色调是中性，不标红（`failed = … && !outcome`，`toolCard.ts:570`）。
   - 有部分输出时照常显示 body。
   - Run 面板的 failed 计数（`runPanelModel.ts:229`）排除带 outcome 的行，和 refused / notStarted 的处理一致。

---

## 4. 任务拆分

测试标签约定：`[BASH-STOP-n]`、`[EXEC-OUT-n]`、`[LIVE-OUT-n]`、`[BG-n]`、`[BG-UI-n]`。所有涉及进程清理的任务，简报里原样附上工程规范附录 B1：

> production code that calls `process.kill` / `kill(-pgid)` MUST take the signalling function as an injectable dependency … A test that reaches such code with a fabricated pid MUST inject a stub or `vi.spyOn(process, 'kill')` before the first call. pid values 1, 0 and −1 are never valid inputs to a real signal from a test.

### B0 登记（开工前，拍板之后）
- **文件**：`docs/plantree/plans/runtime-hardening/roadmap.md`（批次 N）、`decisions/0xx-background-shell-lifecycle.md`（Stop 不杀后台、空闲不唤起、会话级生命周期、子代理不能用）、`decisions/0xx-live-tool-output-is-memory-only.md`、`进度看板.md`。
- **验收**：每个任务都有 T 编号，每条决策都写清楚它替代或补充了哪条旧决策（041 规则 4 对子代理**不变**）。

### B1 T130 runtime 半边
- **文件**：`src/runtime/plugins/tools/index.ts`（bash 的 details）、新增 `src/runtime/plugins/tools/outcome.ts`、`src/runtime/plugins/agent-loop/index.ts`（`afterToolCall`）、`src/runtime/plugins/subagent/index.ts`（传 `resolveToolOutcome`）。
- **测试**：
  - `src/runtime/__tests__/tools.test.ts`
    - `[BASH-STOP-1]` 运行 `printf a; sleep 5` 时 abort，details 带 `stopped`，文本里有 `a`
    - `[BASH-STOP-2]` 正常退出和超时都**不带** `stopped`
  - `agentLoop.test.ts`
    - `[BASH-STOP-3]` 用 faux provider 在 bash 运行中 Stop，`tool_execution_end.isError === true`，会话文件里 toolResult 的 `isError` 也为 true
  - `subagentHardening.test.ts`
    - `[BASH-STOP-4]` 子代理的 bash 被 TaskStop 之后同样是 `isError`
- **验收**：上面四条通过；反向验证：删掉 `afterToolCall` 后 `[BASH-STOP-3]` 失败。

### B2 T130 投影、回放、渲染半边（依赖 B1 约定的字段名，可以并行开发）
- **文件**：`src/shared/types/runtimeEvents.ts`（`ToolOutcomeDetails.stopped`）、`src/runtime/events/projector.ts`（`toolOutcomeDetails`）、`src/shared/types/sessionHistory.ts`、`src/agent-host/piSessionTimeline.ts`、`src/renderer/stores/chatSessions.ts`（仅历史映射那一处）、`src/renderer/components/chat/toolCard.ts`（outcome、动词形态）、`workspace-shell/surfaces/runPanelModel.ts`。
- **测试**：
  - `runtimeEvents.test.ts` / `eventsPlugin.test.ts`：`[BASH-STOP-5]` 投影出 `ok:false` 加 `details.stopped`
  - `src/agent-host/__tests__/piSessionTimeline.test.ts`：`[BASH-STOP-6]`
  - `src/renderer/stores/__tests__/chatSessionsHistory.test.ts`：`[BASH-STOP-7]`
  - `src/renderer/components/chat/__tests__/toolRowOutcome.test.ts`、`toolCard.test.ts`：`[BASH-STOP-8]` 动词是 done 形、文案「已停止」、不标红、有 body
- **验收**：开发机上执行 `sleep 30`，点 Stop，行显示「终端 sleep 30 · 已停止」；重开会话后显示相同。

### B3 exec 输出回调与 spawn 的 stdin（host，独立泳道）
- **文件**：`src/runtime/contracts.ts`（`onOutput`、`RuntimeSpawnRequest.stdin`）、`src/runtime/host/exec.ts`（`consume`、`spawnPersistent` 的 stdio）。
- **测试**：`src/runtime/__tests__/host.test.ts`
  - 「host exec」组
    - `[EXEC-OUT-1]` chunk 按顺序到达，且超过保留预算后仍然回调
    - `[EXEC-OUT-2]` 回调抛异常不影响结果
    - `[EXEC-OUT-3]` Windows carrier 的注入桩下同样生效
  - 「host exec spawn」组
    - `[EXEC-OUT-4]` `stdin:'ignore'` 时 `cat` 立即退出
  - 一律用真实子进程或注入的 `killGroup`（附录 B1）
- **验收**：原有 host 测试全绿；`grep -rn "process\.kill(" src --include=*.test.ts` 没有新增。

### B4 bash 实时输出（runtime，依赖 B3；和 B1 改同一个函数，排在 B1 之后）
- **文件**：新增 `src/runtime/plugins/tools/liveOutput.ts`、`src/runtime/plugins/tools/index.ts`、`src/runtime/flags.ts`（`AICLIENT_BASH_STREAM`）、`src/runtime/bootstrap.ts`（`ToolsConfig.streamShellOutput`）。
- **测试**：
  - 新增 `src/runtime/__tests__/liveOutput.test.ts`
    - `[LIVE-OUT-1]` 环形缓冲的边界和 `omittedBytes`
    - `[LIVE-OUT-2]` 开头的 UTF-8 续字节被去掉
    - `[LIVE-OUT-3]` 注入时钟后，250 ms 内最多一次，并有尾沿补发
    - `[LIVE-OUT-4]` `stop()` 之后不再发出
  - `tools.test.ts`
    - `[LIVE-OUT-5]` 真实 bash `printf a; sleep 0.4; printf b`，`update` 至少被调 2 次且 tail 在增长
    - `[LIVE-OUT-6]` 开关关闭时 `update` 从未被调用
    - `[LIVE-OUT-7]` 开关开和关两种情况下，最终结果逐字节相同
  - `flags.test.ts`
- **验收**：`tools-03` / `tools-06` 的原有断言不变。

### B5 `tool.output` 事件与 T053 收口（依赖 B4 的 partial 形状，形状已在本文约定，可以并行）
- **文件**：`src/shared/types/runtimeEvents.ts`（类型联合和接口；删掉 `ToolUpdatedEvent.payload.status`）、`src/runtime/events/projector.ts`（update 分支）、`src/renderer/components/chat/assistantProgress.ts`（进度和存活集合）、`src/renderer/components/chat/eventRing.ts`（`HIGH_FREQUENCY_PREFIXES` 加 `tool.output`）、`src/renderer/components/workspace-shell/surfaces/contextSurfaceModel.ts`（`activeToolStatus` 改读 `tool.output`）。
- **测试**：
  - `runtimeEvents.test.ts`：`[LIVE-OUT-8]` 不带 input，tail 原样透传；普通的 `tool_execution_update` 仍走 `tool.updated`
  - `src/runtime/__tests__/guiEventContract.test.ts`
  - `src/renderer/components/chat/__tests__/assistantProgress.test.ts`
  - `eventRing.test.ts`：`[LIVE-OUT-9]` 100 条 `tool.output` 折叠成 1 行
  - `workspace-shell/surfaces/__tests__/contextSurfaceModel.test.ts`：`[LIVE-OUT-10]` 进度行取最后一个非空行
- **验收**：T053 对账要求的「每个字段要么有生产者、要么删除」在 status 字段上成立；golden 录制 `src/shared/__tests__/fixtures/nativeGui*EventStream.json` 不需要重录（主录制里没有 bash）。

### B6 渲染层：运行中行的实时尾部（依赖 B5；和 B2 同样改 `toolCard.ts`，排在 B2 之后）
- **文件**：新增 `src/renderer/components/chat/toolLiveOutputModel.ts`、新增 `src/renderer/stores/toolLiveOutput.ts`、`src/renderer/components/chat/ChatWorkspace.tsx`（`init` effect）、`src/renderer/stores/sessionLifecycle.ts`（修剪）、`src/renderer/components/chat/toolCard.ts`（`ToolRowView.liveOutput`）、`src/renderer/components/chat/ToolRows.tsx`（`LiveToolOutput` 叶子组件、抽出 `useFollowTail`）、`src/shared/i18n.ts`（新增「等待输出…」「已省略前 {{size}} 输出」）。
- **测试**：
  - 新增 `toolLiveOutputModel.test.ts`：`[LIVE-OUT-11]` 条目上限和 tail 上限、`[LIVE-OUT-12]` `tool.completed` 和会话终态时清理、`[LIVE-OUT-13]` ANSI 和 `\r` 规整
  - `toolCard.test.ts`：`[LIVE-OUT-14]` 只有运行中的 bash 行才有 `liveOutput`
  - `timelineToolClock.test.ts`（沿用 ROW-CLOCK 的计数 spy）：`[LIVE-OUT-15]` 一条 `tool.output` 不触发任何 `deriveToolGroupRows`，展开后的行里文字确实在变
  - `messageTimelineWiring.test.ts`
  - `src/renderer/stores/__tests__/storeSelectorStability.test.ts`
  - `src/renderer/stores/__tests__/sessionLifecycle.test.ts`
- **验收**（开发机）：`for i in $(seq 1 30); do echo line $i; sleep 1; done` 展开后逐行出现；`head -c 5000000 /dev/zero | base64` 界面不卡，显示「已省略前 …」；Run 面板显示最后一行。

### B7 后台插件、工具和 bash 参数（依赖 B3；和 B4 改同一个函数，排在 B4 之后）
- **文件**：
  - 新增 `src/runtime/plugins/background/{index,registry,notice}.ts`
  - `src/runtime/plugins/tools/index.ts`（`run_in_background`、`authorizeShell()`、描述文案）
  - `src/runtime/bootstrap.ts`（注册、`required` 列表 `:583-601`、`handle.background`、dispose 步骤）
  - `src/runtime/flags.ts`（`AICLIENT_BASH_BACKGROUND`）
  - `src/shared/types/runtimeEvents.ts`（`background.updated`、`BackgroundTaskSummary`、`PermissionRequestAction` 加 `run_background_command`）
  - `src/runtime/plugins/permissions/index.ts`（请求里的 `background` 字段）
  - `src/runtime/worker/permissionPrompt.ts`（`actionOf`）
  - `src/runtime/plugins/subagent/index.ts`（子代理拒绝）
  - `src/runtime/README.md`（目录表）
- **测试**：
  - 新增 `src/runtime/__tests__/backgroundShell.test.ts`。生命周期用假的 `exec.spawn`，从头到尾不发真实信号：
    - `[BG-1]` 准入，第 5 个被拒绝
    - `[BG-2]` exited / stopped / timed_out / spawn_failed 四种结算
    - `[BG-3]` 游标递增读取和跳过字节数
    - `[BG-4]` 等待被 signal 或 interrupt 打断，任务继续
    - `[BG-5]` 保留上限，未送达的不淘汰
    - `[BG-6]` 读取预算
    - `[BG-7]` 走 ExecPlugin 加真实 `/bin/sh -c 'sleep 5'` 的一次端到端 stop，确认进程树消失
  - `tools.test.ts`：`[BG-8]` 后台和前台走同一道闸（计划模式、拒绝路径、外部目录会问）
  - `permissionGrants.test.ts`：`[BG-9]` 前缀授权覆盖后台
  - `src/runtime/__tests__/subagentToolsPermissions.test.ts`：`[BG-10]` 子代理被拒绝
  - `bootstrap.test.ts` / `pluginGraphIncomplete.test.ts`：`[BG-11]` 服务只在「开关开 + 有 shell」时存在
  - `flags.test.ts`
- **验收**：开关关闭时工具表和 bash 的 schema 与现在逐字节相同。

### B8 agent loop 接线：投递和打断（依赖 B7）
- **文件**：`src/runtime/plugins/agent-loop/index.ts`（`bindRun` / `endRun`、两处 flush、trace note `background_notice_delivered`）、`src/shared/internalMessage.ts`（新 origin `'background-task'`）。
- **测试**：新增 `src/runtime/__tests__/backgroundDelivery.test.ts`（faux provider）
  - `[BG-12]` 运行不等后台任务就结束
  - `[BG-13]` 运行中结算，下一个请求在 tool result 之后带上通知，没有用户气泡，写进了会话
  - `[BG-14]` 空闲时结算，下一次运行的首个请求带上通知
  - `[BG-15]` 已经读过最终输出，就不再发通知
  - `[BG-16]` Stop 之后后台任务仍在运行（钉住拍板点 1）
  - `[BG-17]` **现场事故回归**：`sleep 240; gh run view` 改成后台之后，运行在 1 秒量级内结束
  - `[BG-18]` A1 回放：只用会话文件就能逐字节复原下一次请求
  - 另在 `interject.test.ts` 新增一组：插话打断 `bash_output` 的等待
- **验收**：`turnCeiling.test.ts` 和 `interject.test.ts` 原有用例全绿。

### B9 worker、RPC、Main、IPC（依赖 B7 的类型和服务签名；和 B8 并行）
- **文件**：
  - `src/runtime/worker/nativeWorkerRuntime.ts`：`stopBackgroundTasks`；`dispose` / `reload` 在退订前调 `shutdown`
  - `src/shared/types/workerRpc.ts`：`worker.backgroundTask.stop`，payload 为 `{logicalSessionId, taskId?}`，result 为 `{stopping: string[]}`，加类型守卫
  - `src/agent-host/piWorkerRpcServer.ts`：新 case，**不等待进程退出**，同 `worker.stop` 的理由
  - `src/main/services/agent-host/WorkerManager.ts`：每个 entry 的任务缓存（最多 16 条，含 tail）、`isSafeToEvict` 守卫、`listBackgroundTasks`、`stopBackgroundTask`、排空白名单、crashed 时合成 `lost`
  - `src/shared/types/ipc.ts`：`CHAT_BACKGROUND_TASKS_LIST`、`CHAT_BACKGROUND_TASK_STOP`
  - `src/preload/index.ts`
  - `src/main/ipc/chat.ts`：经过 `claimSessionForSender`
- **测试**：
  - `src/runtime/__tests__/nativeWorkerRuntime.test.ts`：`[BG-19]` reload 和 dispose 先发最终事件再退订
  - `src/agent-host/__tests__/piWorkerRpcServer.test.ts`：`[BG-20]`
  - `src/main/services/agent-host/__tests__/WorkerManager.test.ts`：`[BG-21]` 有运行中任务时空闲清扫和容量回收都跳过、`[BG-22]` 崩溃后合成 lost、`[BG-23]` list 返回缓存、`[BG-24]` 退役窗口里转发 `background.updated`
- **验收**：Main 代码保持英文（Main 不在 noHardcodedChinese 的 ROOTS 里，但仍然遵守）。

### B10 渲染层：后台任务条和工具词表（依赖 B9；和 B6 同样改 `toolCard.ts` / `ChatWorkspace.tsx`，排在 B6 之后）
- **文件**：
  - 新增 `src/renderer/components/chat/backgroundTasksModel.ts`（纯 reducer 和条目视图的派生）
  - 新增 `src/renderer/stores/backgroundTasks.ts`
  - 新增 `src/renderer/components/chat/BackgroundTaskDock.tsx`
  - `ChatWorkspace.tsx`：挂在 `:300` 的 `PendingPermissionDock` 和 `:318` 的输入框之间；`init`；切换会话时调 list 补水
  - `sessionLifecycle.ts`
  - `piToolNames.ts`：`bashOutput`、`bashStop`
  - `toolCard.ts`：`TOOL_VERBS`、`ARG_COVERED_FIELDS`、`run_in_background` 行改用「已在后台启动」动词
  - `questionCardModel.ts`：新动作的文案
  - `src/shared/i18n.ts`：「后台命令」用新 key，**不要复用 `Background → 背景`（i18n.ts:162，那是视觉背景）**
- **视觉**：遵循 `docs/design-system.md`，优先用 @coss/ui。
  - 容器：宽度和输入框对齐，复用 `queueStripWrapperClass()`（`middleColumnLayout.ts:597`）。
  - 头部行：`h-7`（design-system「高度规范」）、`text-meta text-muted-foreground`；有任务在跑时显示 `Spinner`，否则显示 `SquareTerminal`；文案为「后台命令 · N 运行中 · M 已结束」；整行是 `Collapsible` 的触发器。
  - 任务行：
    - 命令：`font-mono text-code truncate`，`title` 显示完整命令
    - 耗时：`tabular-nums`（design-system「数字对齐」）；时钟 1 Hz，**只在任务条内部**并且只在有任务运行时走，不复用时间线的时钟
    - 退出码：`Badge`，非 0 用语义 token，不用原色
    - 停止：`Button` ghost 图标按钮加 `Tooltip`；已结束的任务可以移除
    - 点击任务行展开 `max-h-40` 的 tail `<pre>`
  - 另有一个「全部停止」。
  - 颜色一律用主题 token，不写任何原色值（design-system「硬编码色禁令」）。
- **测试**：
  - 新增 `backgroundTasksModel.test.ts`：`[BG-UI-1]` 按 upsert 做到幂等、`[BG-UI-2]` 补水合并、`[BG-UI-3]` 每个会话的条数上限、`[BG-UI-4]` 背景事件**不**计入回合的进度和存活（`assistantProgress.test.ts`）
  - `runtimeToolVocabulary.test.ts`：新工具的动词、参数、图标
  - `toolCard.test.ts`
  - `sessionLifecycle.test.ts`
  - `noHardcodedChinese.test.ts` 和 i18n 覆盖扫描（自动生效）
- **验收**：见第 7 节的点验清单 D4-1 到 D4-6。

### B11（可选，看拍板点 3）前台超长输出改成「头 + 尾」截断
- **文件**：`src/runtime/plugins/tools/index.ts`、`liveOutput.ts`（结果用的 tail 放大到 32 KiB）、`flags.ts`。
- **做法**：`output.truncated` 为真时，文本改成「头部 ≤ 16 KiB + `[… N bytes omitted …]` + 尾部 ≤ 32 KiB（尾部按到达顺序合并 stdout / stderr）」，状态尾照旧预留。
- **测试**：改写 `tools.test.ts` 里的「keeps the bash exit tail when output fills the budget (tools-03)」，新增 `[LIVE-OUT-16]`（尾部可见、总长 ≤ 50 KiB）。
- **理由**：不做的话，展开的行运行时看到的是结尾，一结算却变成开头；对长时间的构建和测试，模型也看不到结尾处的报错。

### B12 证据与收尾
- **文件**：`docs/plantree/plans/runtime-hardening/evidence/batch-n-bash-2026-09-xx/README.md`（开发机点验、Windows 清单、IPC 事件速率实测）、roadmap 回填、`进度看板.md`。
- **验收**：三套 tsc 通过；定向 Vitest 全绿；CI 为准；Windows 打包实测项已登记。

---

## 5. 执行顺序与可并行性

| 泳道 | 顺序 | 共享文件（必须串行的原因） |
|---|---|---|
| A runtime 工具链 | B1 → B4 → B7 → B8 → (B11) | `tools/index.ts` 的 bash `execute`（B1/B4/B7/B11）；`agent-loop/index.ts`（B1/B8）；`subagent/index.ts`（B1/B7）；`flags.ts`、`bootstrap.ts`（B4/B7） |
| B host | B3（第一天就可以开工） | 只改 `host/exec.ts` 和 `contracts.ts`，与其他任务没有交集；B4 和 B7 合入前它必须先合入 |
| C 投影与渲染 | B2 → B5 → B6 → B10 | `runtimeEvents.ts`（B2/B5/B7 三处改在不同段落，按合入顺序 rebase）；`projector.ts`（B2 改 `toolOutcomeDetails`，B5 改 update 分支，函数不重叠）；`toolCard.ts`（B2/B6/B10）；`ChatWorkspace.tsx`、`sessionLifecycle.ts`、`i18n.ts`（B6/B10） |
| D worker 与 Main | B9（等 B7 的类型和服务签名定稿后，和 B8 并行） | 全部是 worker / RPC / Main / preload 文件，与 A、C 不重叠 |

**建议的合入顺序**：B1、B3 → B2 → B4 → B5 → B6（**检查点 1**：D3 和 T130 完成，做一轮开发机点验）→ B7 → B8 ‖ B9 → B10（**检查点 2**：D4 完成）→ (B11) → B12。

**和 D1（读图与预览崩溃）的边界**：D1 同样会改 `tools/index.ts` 的 read 段、`projector.ts` 的 `output()` 兜底，以及 `ToolRows.tsx` / `toolCard.ts` 的文件链接部分。本计划只动这几个文件里的 bash 段、`ToolRowBody` / 输出段、`deriveToolRowView` 里运行中的字段和 outcome。开工前先 rebase 到 D1 之后，冲突按段落解决。

---

## 6. 风险

1. **非 TTY 下的缓冲**：Python 之类的程序输出到管道时是块缓冲，「实时」会变成按 4 KiB 一块到，或者到退出时才一起到。PTY 不在本计划范围内；交付说明要写明。不默认注入 `PYTHONUNBUFFERED`，因为那会改变命令本身的行为。
2. **IPC 流量**：并行的前台 bash 每条最多 32 KiB/s，后台每个任务最多 4 KiB/s。B12 里实测事件速率；两个开关都能单独关掉。
3. **会话占住 worker**：有后台任务的会话不会被回收，10 个 worker 的池（`WorkerManager.ts:395`）可能被占满，报 `worker_capacity_reached`。缓解：任务条始终可见，并有「全部停止」；这个错误的文案里提示用户停掉后台命令。
4. **轮询把会话文件撑大**：`bash_output` 不在决策 042 的防空转范围内。缓解：增量读取（没有新输出时几乎不占空间）、每会话 4 MiB 的读取预算、描述里引导用 `waitSeconds`。现场如果观察到空转，再评估是否把它纳入 042。
5. **TUI 交接的 reload 会杀后台任务**（§3.2.5）：已知限制，界面会说明原因。
6. **POSIX 直连 carrier 被 SIGKILL**（开发时没有打包 node）：reaper 接不到这个信号，后台进程可能成为孤儿。产品的两种 carrier 都有 runner，不受影响。写进交付说明。
7. **Windows**：taskkill 可能很慢或被安全软件拦截，这时会走 `cleanupError`，任务条对应显示「进程树可能未完全结束」；tail 按 OEM 代码页解码时，开头可能有一个字符乱码（UTF-8 可以精确去掉，OEM 不行）。
8. **T130 改了模型能看到的 `isError`**：被停掉的命令对模型来说变成了失败。下一次运行本来就由用户新发的消息开启，影响很小。
9. **结算后的输出只保留头部**：展开的行在运行时看到的是结尾，结算后变成开头。B11 解决这个问题；如果不做 B11，要写进交付说明。
10. **和 D1 同时改同一批文件**（§5）。
11. **空闲时后台任务结束，模型不知道**：要等用户下一次发送才投递，用户可能以为会自动继续（拍板点 2）。
12. **子代理里的 bash 行看不到实时输出**，子代理也不能用后台命令：v1 的范围如此，写进交付说明。

**本计划不包含**（登记到想法池）：把正在运行的前台命令转到后台（类似 Claude Code 的 Ctrl+B）、侧栏的后台任务徽标、后台命令结束时自动唤起模型、子代理使用后台命令、PTY。

---

## 7. 点验清单（开发机，Windows 另列）

| 编号 | 操作 | 期望 |
|---|---|---|
| D3-1 | 运行每秒打印一行、共 30 秒的命令，展开行 | 每行在 0.5 秒内出现；折叠时不增加任何内容；Run 面板显示最后一行 |
| D3-2 | 一次性输出 5 MB | 界面不卡；显示「已省略前 x MB」；事件不超过每秒 4 条 |
| D3-3 | 在 D3-1 运行中点 Stop | 行显示「终端 … · 已停止」，能看到部分输出，不标红；重开后显示相同（T130） |
| D4-1 | 现场事故复现：「等 4 分钟再看 CI」 | 模型使用 `run_in_background`；回合在 10 秒内结束；任务条上的计时在走；结束后显示退出码；下一条消息里模型直接说出结果 |
| D4-2 | 后台起一个 server，然后点回合 Stop | server 继续运行（拍板点 1）；从任务条停止后，`ps` 或任务管理器里看不到这棵进程树 |
| D4-3 | 关闭会话、退出应用 | 没有残留进程 |
| D4-4 | 渲染层 Ctrl+R 刷新 | 任务条恢复出正在运行的任务 |
| D4-5 | 连续起第 5 个后台命令 | 模型收到可读的拒绝 |
| D4-6 | 在 `bash_output` 等待期间按 Ctrl+Enter | 插话立即送达，任务继续运行 |

---

## 8. 需要用户拍板的点

1. **用户点 Stop 时，后台命令要不要一起停？**
   **建议：不停**，只停当前回合（包括正在跑的前台 bash）。任务条提供逐个停止和「全部停止」。理由：
   - Stop 的含义是「让 Agent 停下」，而后台命令是用户在任务条上看得见、能单独控制的进程；
   - 决策 041 规则 4 让 Stop 杀子代理，是因为子代理会**继续花 token、继续自主行动**，而一条后台命令只是一个已经审批过的进程，不会产生新的动作；
   - 用户经常是想纠正模型，而不是想把 dev server 或长时间构建一起杀掉。
   另一个选项：和子代理保持一致，一起停。改动只是在 `agent-loop/index.ts:911-914` 加一行。
2. **后台命令在空闲时结束，要不要自动唤起模型开一轮？**
   **建议：v1 不自动唤起**。只更新任务条；通知随用户下一次发送投递。理由：无人值守的运行会花 token，可能在用户离开时弹出授权卡，还会和队列释放（`useQueueRelease`）互相干扰。以后可以放在开关后面再加。
3. **是否把 B11（前台超长输出改为「头 + 尾」截断）纳入本分支？**
   这会改变模型看到的内容。**建议纳入**，单独用一个开关、默认开启，否则长时间构建和测试的报错对模型不可见，界面上也会出现「运行时看结尾、结算后看开头」的错位。
