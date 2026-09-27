# P1-7 分片 01 · 渲染层现状：能复用什么、缺什么

Role: detail shard。上位：[P1-7 方案](../p1-7-renderer.md)。回答调研问题 1。行号取 worktree HEAD `beafffb1`；渲染层与 `src/shared/types/runtimeEvents.ts` 在工作区没有未提交改动，与 HEAD 相同。

## 1 中栏布局（会话态，自上而下）

| 位置 | 组件 | 出处 |
|---|---|---|
| 时间线 | `MessageTimeline`：回合 = 一条 user 消息 + 其后全部 assistant / system 消息 | `chat/ChatWorkspace.tsx:283-291`；`chat/chatTurn.ts:85-104` |
| 输入框上方 1 | `PendingQuestionDock`：唯一可答的问答卡 | `ChatWorkspace.tsx:292-295` |
| 输入框上方 2 | `PendingPermissionDock`：唯一可答的审批卡，一次一张（runtime-hardening 决策 022） | `ChatWorkspace.tsx:296-300` |
| 输入框列内 | 模型同步提示 → 发送失败框 → 排队消息条 → 输入框卡片 → 目标栏（仓库 / 分支 / 运行位置） | `chat/ChatComposer.tsx:3834-3889`、`:4098-4104` |
| 左栏 surface | 聊天 / Git / 文件 / 上下文 / 运行；`plan`、`notes` 等只登记未上栏 | `workspace-shell/surfaceRegistry.ts:82-143`、`:180-188` |

排队条的行样式是 `h-7 rounded-sm border bg-muted/50 px-2 text-meta`（`QueuedMessageStrip.tsx:144`），外层宽度与输入框对齐（`middleColumnLayout.ts:597` 的 `queueStripWrapperClass`）。新增的窄条沿用这套样式，视觉上是一套系统。

## 2 可直接复用的部件

| 部件 | 现状 | 对 P1-7 的用处 |
|---|---|---|
| 工具行 | 图标表 `ToolRows.tsx:137-148`；动词表 `toolCard.ts:971-1041`；参数摘要 `:1375-1585`；运行中时钟 `ToolRows.tsx:850`（T146 的 `execStartedAt`）；结局标记 `refused` / `notStarted` / `stopped`（`toolCard.ts:1099-1121`） | DSH 工具只需补表项；新增的 `outcomeUnknown`（P1-4d）同一槽位 |
| 回合工作组与时钟 | 回合的过程项折进「已工作 N 秒」工作组，默认折叠，未应答授权强制展开（`turnProcessFold.ts:140`、`:219`、`:248`）；头上报时长（`MessageTimeline.tsx:1682`），结束后的工作区行（`:1788`）；时钟起点取回合 user 消息的 `message.started`（`:2035-2040`） | 有了轮次头之后，目标轮、唤醒轮各自成回合，工作组与时钟原样适用 |
| 委派行 + 子代理泳道 | 委派行交给 `SubagentActivity` 渲染（`ToolRows.tsx:156-168`、`:366-421`）；泳道按父工具调用 id 平铺，`agentIndex` 把子代理 id 映回泳道，容量 24 条泳道 × 40 行（`subagentActivityModel.ts:33`、`:90`、`:318`） | DSH 的子会话活动投成同一个 `subagent.activity`，泳道原样复用 |
| 泳道历史重建 | `session.history.subagents`（`runtimeEvents.ts:932-940`；`SubagentHistorySummary`，`sessionHistory.ts:93-117`） | DSH 历史投影产出同形状即可，渲染层零改动 |
| 审批卡 | 动作 id → 文案（`questionCardModel.ts:863-868`）；风险分级（`:894-899`）；子代理来源小标；子代理在两轮之间出卡不把会话标成「等待审批」（`chatSessions.ts:1660`，规则见 runtime-hardening 决策 041 第 6 条） | pwsh 与 `escalate_sandbox` 只补表项；后台子代理出卡不带 requestId 的情况已被这条规则覆盖（需补一条测试） |
| 失败卡与收尾 | 按 `errorCode` 查表（`sessionFailure.ts:75-167`）；`turn_limit` 完成注记 `TurnCeilingNotice`（`TurnCeilingNotice.tsx:21-41`）；`stopCause` 读法（`turnEndCause.ts:41-49`） | P1-8 的 `turn_limit` 与 `tool_call_repetition` 直接复用 |
| 相邻 store 模式 | 纯 reducer + zustand 壳 + 单监听闩锁：`sessionRuntimeFacts.ts:39-65`、`subagentActivity.ts:27-50`；在 `ChatWorkspace.tsx:180-209` 初始化，`sessionLifecycle.ts` 负责修剪 | goal / todo / jobs / 实时输出都照这个模式建相邻 store，不碰红线文件 `chatSessions.ts` 的状态结构 |
| 运行面板 | `runPanelModel.ts` + `RunSurfaceView.tsx:116-420`：状态、模型、工具计数、用量、委派占比 | 子代理清单与后台任务的第二入口放这里 |
| 中文动词 | 决策 034 起工具行用「图标 + 两字类型」（`src/shared/i18n.ts:2609-2666`，如 `Ran` → 「终端」、`Read` → 「读取」） | DSH 新工具按同一风格起中文 |

## 3 缺口

| 能力 | 现状 | 证据 |
|---|---|---|
| goal | 完全没有 | 可行性调研 §7.2 |
| todo | 只有 Claude 时代 `TodoWrite` 的一行，参数固定写「next moves」 | `toolCard.ts:1548-1551` |
| 后台任务（待办 D4） | 没有；bash 计划书的后台任务条设计已写好但暂停 | [bash 计划书](../../../../../plans/2026-09-24-bash-streaming-and-background-plan.md) §3.2、B10 |
| 运行中命令的实时输出（待办 D3） | 没有；`tool.updated.status` 定义了但从来没有生产者，运行面板的「当前工具进度行」因此常空 | `runtimeEvents.ts:970-977`；bash 计划书 §2.4 |
| 子代理清单面板（待办 D7） | 只有行内泳道，没有「本会话全部子代理」的视图 | 可行性调研 §8 表「子代理【D7】」 |
| 自主回合的分界 | 没有 user 消息的回合被并进上一回合。HEAD bridge 对 goal 轮、job 通知开的回合只发 `running`，不回显触发它的消息（`dsh-host/bridge/dshSessionRuntime.ts:828-837`、`:839-841`） | `chatTurn.ts:85-104` |
| DSH 通知 | `custom.message` 一律拼成 `${customType}\n${content}` 的系统消息，画成一整张 `Alert` | `chatSessions.ts:1491-1504`；`MessageTimeline.tsx:1357-1404` |
| 子代理泳道收尾 | 任何 `session.completed / failed / stopped`（插话除外）都把仍在跑的泳道扫成「已取消」。1.0.x 父运行要等子代理收齐才结束，所以扫得没错；DSH 的子代理默认后台可续，父回合结束后仍在跑 | `subagentActivityModel.ts:654-681` |
| 面板补水 | 相邻 store 都没有「渲染层刷新或切会话后拉一次快照」的路径，靠事件流重新累积 | `sessionRuntimeFacts.ts`、`subagentActivity.ts` |

## 4 工具行对 DSH 的具体错位（修法见[分片 04](04-tool-rows-windows.md)）

1. 小写 `read` / `edit` / `write` 的参数摘要只读 `path`（`toolCard.ts:1394-1414`），DSH 用 `file_path`。现在靠 HEAD bridge 补一个 `path` 别名（`dshSessionRuntime.ts:350-354`）才显示得出来；但 `ARG_COVERED_FIELDS.read` 只登记了 `path`（`toolCard.ts:729-733`），于是每个读文件行都会多出一段参数 JSON。
2. `pwsh` 不在终端类图标集合、bash 类输出高度集合和超时推断集合里（`toolCard.ts:1205-1212`、`:1649-1655`、`:798`）。Windows 上所有命令行都会落到通用扳手图标和兜底动词。
3. 兜底动词 `UNKNOWN_TOOL_VERB` 是 `Ran`（`toolCard.ts:1043`），中文是「终端」（`i18n.ts:2622`）。插件工具（例如 `word_create`）的行会以「终端」开头，读者会以为它跑了一条命令。
4. `isDelegationTool` 只认 `Task` / `Agent`（`toolCard.ts:1152`）。DSH 的 `subagent`、`subagent_fork` 和决策 062 的委派工具都不会挂出泳道。
5. 审批卡的高风险只认 `bash` / `write` / `edit` 三个名字，或 `kind` 为 exec / file_change（`questionCardModel.ts:894-899`）；`PermissionRequestAction` 没有 `escalate_sandbox`（`runtimeEvents.ts:445`，P1-6b 会先加最小文案）。
6. `bashTimeoutMsFromInput` 读 `timeoutSeconds` / `timeoutMs`，缺省 120 s（`toolCard.ts:807-816`）。DSH 的缺省也是 120 s、上限 600 s（`dsh-bash-local/README.md:45-46`），但到时限是转后台而不是被杀（分片 02 §4）。

## 5 结论

- 能复用的占大头：工具行、泳道、审批卡、失败卡、排队条样式、相邻 store 模式、运行面板。
- 必须新建的：目标条、待办卡、后台任务条、实时输出叶子组件、轮次头、通知的轻量行、子代理清单。
- 必须改的现有逻辑：泳道收尾规则、工具名集合与参数摘要、兜底动词、委派工具集合、审批风险表。这些改动都有现成的静态词表测试兜着（`toolVocabulary` / `piToolVocabulary` / `runtimeToolVocabulary`），新增一份 `dshToolVocabulary` 即可。
