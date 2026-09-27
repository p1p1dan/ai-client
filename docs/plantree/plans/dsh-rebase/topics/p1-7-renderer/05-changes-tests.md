# P1-7 分片 05 · 改动清单、切分、开工实验与测试

Role: detail shard。上位：[P1-7 方案](../p1-7-renderer.md)。回答调研问题 7、8。规模是粗估，单位为行；文件名是建议名。

## 1 子任务

| 子任务 | 内容 | 产品 / 测试 | 依赖 |
|---|---|---|---|
| **P1-7a 目标、待办、轮次头与通知**（T138、待办 D8 的 todo 部分） | 相邻 store 与纯模型；目标条、待办卡、编辑目标对话框；轮次头与通知轻量行；`worker.command` 与 `worker.panels` 两个 RPC；通知策略表 | 约 1300 / 1000 | P1-4d 的 `session.projection` 与命令执行器；P1-4a 的历史规则；P1-3a 的通道。纯模型与组件可以先按分片 03 §0 的契约写 |
| **P1-7b 后台任务、实时输出、子代理**（待办 D3、D4、D7） | bridge 侧 jobs 与子代理两个模块；后台任务条；运行中命令的实时输出；泳道规则调整；运行面板子代理清单；三个 RPC | 约 2000 / 1400 | P1-4d（`tools/execute` 包装与工具事件）；P1-6b（子代理卡片的 join 键）；P1-3（pong `busy`、`isSafeToEvict`）；U3 拍板 |
| **P1-7c 工具行与 Windows 文案** | DSH 工具全表、pwsh 细则、插件兜底、审批卡与失败卡文案 | 约 600 / 500 | P1-4d 的 `presentation` 字段与 `ABORTED` 映射；P1-6b / P1-6d 的 pwsh 卡片字段；插件与 MCP 行在 P1-10 / P1-16b 之后补测 |
| **P1-7d 收口** | 开工前的原型页（给 U1 / U2 拍板用）；开发机 GUI 点验；Windows 实测；证据；runtime-hardening 的待办 D3 / D4 / D7 / D8 与 T138 回写为「移交完成」 | 脚本约 300 | a～c；推 Windows CI 与出测试版需用户同意 |

- **合计**：产品约 3.9k 行，测试约 2.9k 行，约 4～5 人周（粗估；bridge 侧的两个模块占约三分之一）。
- **顺序**：原型页先行（U1、U2 拍板）→ a 与 c 并行（`toolCard.ts` 只由 c 改；`todo_write` 行的展开体由 c 接入 a 先交付的 `TodoList` 组件）→ b 在 P1-4d、P1-6b 之后（b 与 c 都改 `ToolRows.tsx`，b 排在 c 之后）→ d 收口。跑测试的并行代理不超过 2 个；全量测试只在收口跑一次。

## 2 逐文件改动

**共享类型与纯模块**

| 文件 | 改动 | 约 |
|---|---|---|
| `src/shared/dshPanels.ts`（新） | 渲染层要读的投影视图类型（目标、armed、待办、子代理目录、jobs 摘要），不 import DSH 包；标明哪些 key 是 bridge 合成的 | 120 |
| `src/shared/dshNotices.ts`（新） | 分片 03 §6 的通知与轮次头策略表，bridge 直播与历史投影共用 | 120 |
| `src/shared/types/runtimeEvents.ts` | `message.started` 加可选 `origin`；`tool.output` 事件（沿用 bash 计划书 B5 的形状）；`tool.started/updated` 加可选 `presentation`（与 P1-4d 同批）；`PermissionRequestAction` 的 `escalate_sandbox` 由 P1-6b 加 | 60 |
| `src/shared/types/sessionHistory.ts` | `HistoryMessage` 加可选 `origin` | 10 |
| `src/shared/dshHistory/subagents.ts`（新，挂在 P1-4a 的投影模块上） | 从父会话日志算出 `SubagentHistorySummary`（分片 03 §5.1 的配对规则） | 150 |
| `src/shared/types/workerRpc.ts`、`ipc.ts` | 5 个新 RPC / IPC 通道的类型与守卫 | 80 |

**bridge（`src/dsh-host/bridge/`）**

| 文件 | 改动 | 约 |
|---|---|---|
| `jobs.ts`（新） | 订阅本会话 owner 的 `ctx.jobs.events`；前台命令与调用的对应；`tool.output` 节流（250 ms）；`jobs` 快照（≤ 1 Hz）；`job.kill` / `job.read`；向 `busy` 贡献「有运行中的 job」 | 260 |
| `subagents.ts`（新） | 按 header 的 `parentSession` 登记子会话；配对到父调用；子会话事件 → `subagent.activity`；子会话用量 → `delegated`；`subagent.interrupt`；向 `busy` 贡献「有运行中的子代理」 | 420 |
| `commands.ts`（P1-4d 新建，本任务加带外入口） | `worker.command` 直接执行 DSH 命令，不开回合、不发状态事件 | 50 |
| `projections.ts`（P1-4d 新建） | 加 `goalActivation` 合成与 `worker.panels` 快照 | 60 |

**Main / preload**

| 文件 | 改动 | 约 |
|---|---|---|
| `src/agent-host/piWorkerRpcServer.ts` | 5 个 RPC 的分派 | 60 |
| `src/main/services/agent-host/WorkerManager.ts` | 5 个方法；没有活 slot 时返回空 | 90 |
| `src/main/ipc/chat.ts`、`src/preload/index.ts` | IPC 处理，经 `claimSessionForSender` | 90 |

**渲染层**

| 文件 | 改动 | 约 |
|---|---|---|
| `components/chat/sessionPanelsModel.ts`（新） | 投影按会话、按 key 后到覆盖；目标条状态推导（分片 03 §2 表）；待办视图 | 300 |
| `stores/sessionPanels.ts`（新） | zustand 壳、单监听闩锁、`worker.panels` 补水 | 80 |
| `GoalBar.tsx`、`GoalEditDialog.tsx`、`TodoCard.tsx`、`TodoList.tsx`（新） | 组件，用 @coss/ui 的 `Button`、`Menu`、`Dialog`、`AlertDialog`（清除确认）、`Tooltip`、`Collapsible`、`ScrollArea` | 420 |
| `components/chat/jobsModel.ts`（新）+ `stores/jobs.ts`（新）+ `BackgroundDock.tsx`（新） | 后台任务条（分片 03 §4），用 `Badge`、`Spinner`、`Collapsible`、`Tooltip`、`toast` | 480 |
| `toolLiveOutputModel.ts`（新）+ `stores/toolLiveOutput.ts`（新）+ `ToolRows.tsx` 的 `LiveToolOutput` 叶子与 `useFollowTail` | 实时输出（bash 计划书 B6） | 250 |
| `ChatWorkspace.tsx` | 三条窄条的挂载顺序；三个 store 的 `init()` | 40 |
| `MessageTimeline.tsx` | `AutoTurnHead`、通知轻量行 | 130 |
| `chatSessions.ts` | `message.started` 与历史映射透传 `origin`（可选字段，照 attachments 的先例） | 25 |
| `components/chat/PromptNavRail.tsx`、`messageMetadata.ts`、`turnCopy.ts`，`stores/historyReplayMerge.ts` | 识别 `origin` | 40 |
| `subagentActivityModel.ts` | DSH 会话的收尾规则；续聊分隔行；状态映射 | 80 |
| `workspace-shell/surfaces/runPanelModel.ts`、`RunSurfaceView.tsx`、`contextSurfaceModel.ts` | 子代理清单；「当前工具进度行」改读 `tool.output` | 170 |
| `piToolNames.ts`、`toolCard.ts`、`ToolRows.tsx` 图标表 | 分片 04 全表与 shell 细则 | 390 |
| `questionCardModel.ts`、`sessionFailure.ts` | 分片 04 §6、§7 | 70 |
| `stores/sessionLifecycle.ts` | 新 store 的修剪 | 15 |
| `src/shared/i18n.ts` | 约 150 个新词条（英文键 + 中文） | 150 |

## 3 开工前实验（每个一个脚本；先 `free -m`，一次只起一个宿主）

| 编号 | 问题 | 用在 |
|---|---|---|
| E1 | 前台 bash / pwsh 的 job 是否总在该调用的 `tools/execute` 窗口里 `registered`、label 等于命令原文；转后台后 id 不变 | P1-7b 实时输出 |
| E2 | `subagent/catalog` 是否总落在委派调用的 `tool/call` 与 `tool/result` 之间；两个并行委派描述相同时的顺序；`subagent/start.runId` 与前台结果值能否对账 | P1-7b 配对 |
| E3 | `goal/activation-changed` 在创建、暂停、恢复、宿主恢复、fork、插话取消时的触发顺序；经 bridge 带外执行 `/goal pause` 能否中止正在跑的一轮 | P1-7a 目标条 |
| E4 | 每 10 ms 打一行的命令下，`output` 事件频率、`readAt` 耗时、合并后的 IPC 字节量 | 节流参数 |
| E5 | 用户 Stop（`cancel({kind:'user'})`）是否影响 continuable 子代理、后台 job、一次性后台子代理 | U3 |
| E6 | `maxConsecutiveWakes` 生效；预算用完后 `inbox` 投影能看到待交付的通知 | U3 选 A 时 |

## 4 测试方案

1. **纯单测**（node 环境，根 vitest，不装 DSH 包）
   - `sessionPanelsModel.test.ts`：目标条 7 种状态 × armed × 会话状态；待办的 `null`、多项进行中、全部完成、新一轮清空；按 key 后到覆盖；会话隔离与修剪。
   - `jobsModel.test.ts`：快照合并、已结束只留 8 项、排除挂在前台调用上的 job、并入 continuable 子代理、宿主崩溃后的标记。
   - `toolLiveOutputModel.test.ts`：沿用 bash 计划书 LIVE-OUT-11～13（上限、清理、ANSI 与 `\r` 规整）。
   - `dshNotices.test.ts`：每个 `source.kind` 都有策略；直播与历史同表。
   - `chatTurn.test.ts`：带 `origin` 的消息开新回合；导航条跳过；复制不含。
   - `subagentActivityModel.test.ts`：DSH 会话的 `session.completed` 不再把运行中的泳道扫成已取消；续聊分隔；状态映射；子代理卡片按 `agentIndex` 挂到泳道；父回合结束后到达、不带 requestId 的卡片不把会话标成等待审批。
   - `dshToolVocabulary.test.ts`（新）：固定的 DSH 工具名清单（与 P1-6 的工具分类表对账）逐个有三态动词、中文、图标类别与已覆盖字段；兜底动词不再是 `Ran`。
   - `toolCard.test.ts`、`toolRowArg.test.ts`：`file_path`、pwsh 前缀、退出码小标、`ABORTED` → 已停止、转后台结局、`update_goal` 的动词、`presentation` 兜底。
   - `questionCardModel.test.ts`：PowerShell 标题与高风险、别名说明、`escalate_sandbox` 详情。
2. **挂载测试**（jsdom）：`GoalBar`、`TodoCard`、`BackgroundDock`、`AutoTurnHead`。`window.electronAPI` 的 `env` / `settings` / `app` 最小桩放 `vi.hoisted`，再 `vi.mock('@/utils/logging')`，照 `src/renderer/components/settings/__tests__/networkPanelMount.test.ts` 的写法；`beforeEach` 只用展开语法补字段。原因：zustand persist 在 import 时就 rehydrate 并调 `settings.read()`，桩放 `beforeEach` 会 10 秒挂死且没有报错。跑这类测试一律加 `timeout 90`。
3. **bridge 单测**（假 ctx，`src/dsh-host/bridge/__tests__/`）：jobs 对应与节流（假时钟）；子代理配对，含并行同名描述；通知 → 轮次头；`goalActivation` 合成；`worker.command` 不开回合、不发状态事件。
4. **回放测试**（扩 P1-4e 的 `dshStreamReplay.test.ts`）：GOAL-COMPLETE、GOAL-PAUSE、GOAL-BLOCKED、GOAL-ROUNDLIMIT、TODO、JOBS-BG、JOBS-PROMOTE、SUB-CONT（完成唤醒）、SUB-FORK-BG、NOTICE-INJECT。断言用户最终看到的：回合数、轮次头、面板状态、泳道状态。
5. **录制门禁**（P1-4e 的 `bridge-record.ts --check`）：加上面同一批场景。假网关的 `dsh-p0-2` 计划已有 goal / todo / jobs 场景（`src/dsh-host/tools/fake-gateway.mjs:121-140`），再加子代理与转后台两个标记。金样本只在收口时重录，派工禁止 `git checkout` 金样本。
6. **开发机 GUI 点验**（功能完成后；不与全量测试同时跑）
   - **合成态**：CDP 连开发态应用，从 Vite 直接 import `/stores/sessionPanels.ts` 等模块（不要用 `/@fs/` 路径，会拿到另一份模块实例），把合成的 `session.projection`、`jobs`、`subagent.activity`、带 `origin` 的 `message.started` 经 reducer 灌进界面当前选中的会话，逐一截图：目标条 7 种状态、待办卡折叠与展开、后台任务条（空、运行、结束、展开输出）、三种轮次头、通知行、泳道续聊、运行面板清单，另加一张窄窗口。
   - **真宿主**：临时 HOME 加假网关（P1-1 GUI 点验的配方），`ENTER_MAIN_SURFACE` 进主界面，经输入框发带标记的消息（`P0-GOAL-COMPLETE`、`P0-GOAL-PAUSE`、`P0-JOBS` 等），回合结束按「先等到 busy，再连续三次读到 idle」判定。核对：目标条随轮次推进；点「暂停」中止当前轮；「继续」后续跑；后台任务条出现且能停止；展开运行中的命令有实时输出；Ctrl+R 之后面板补水；杀一次宿主后面板与泳道的收尾。
7. **Windows**：分片 04 §8 的 W1～W12。

## 5 与其他任务的边界

| 任务 | P1-7 要它做的 / 交给它的 |
|---|---|
| P1-3 | 新 RPC 走共享宿主的通道；pong `busy` 的口径（agent 不空闲、有运行中的 job、有运行中的 continuable 子代理、目标 active 且 armed），`isSafeToEvict` 据此不回收；宿主崩溃时发 `session.failed {errorCode: dsh_host_crashed}`，面板据此收尾 |
| P1-4a | 历史投影里，`goal`、`tool-jobs`、`subagent-settled`、`agent-message` 作为回合首条时投成带 `origin` 的轮次头；通知行按 `dshNotices` 表；`subagents` 摘要调用 P1-7b 的纯模块；`readPage` 以后接受子会话 id（可选） |
| P1-4d | 发 `session.projection`（含 `goalActivation`）；命令执行器可被带外调用；`presentation` 字段；bash / pwsh 的 `ABORTED` → `stopped`（它的分片 01 写的 `meta.aborted` 与源码不符）；`execStartedAt` 的 `tools/execute` 包装与 P1-7b 的 job 对应共用一处 |
| P1-5 | `read_image` 需要路由声明图片输入；`LlmFailure.code` 的映射表 |
| P1-6 | 子代理卡片的 `agentId` 取子会话 id；pwsh 发 `kind: 'exec'` 与归一化前缀；可选的 `askReason`；`escalate_sandbox` 由 P1-6b 先加最小文案、P1-7c 精修；决策 049 的 3～4 条用例判 N/A，随 P1-12 删 runtime 一起删除 |
| P1-8 | `turn_limit`、`tool_call_repetition` 复用现有界面；失败卡文案按 DSH 的工具族改一句 |
| P1-9 | `aiclient/pi-subagent` 投成 `SubagentHistorySummary`（P1-9e），迁移来的会话照旧显示委派面板 |
| P1-10 / P1-16 | 插件工具行靠 `presentation` 兜底，白名单插件可补中文词条；决策 062 的工具形态按 U4 定稿、P1-16d 实现；`/skill:` 写法维持；MCP 行沿用现有标签 |
| P1-11 | 删 TUI 时会动 `ChatWorkspace.tsx` 的 TUI 分支，与本任务改同一文件，谁先落地谁先合 |
| P1-12 | `Task*` 与 pi 时代的词条保留（旧会话回放要用）；与 runtime 绑定的渲染层静态测试随之调整 |
| P1-14 | 在 Windows 测试版上跑 W1～W12 |

## 6 退出判据（建议细化）

- 开发机 GUI 点验：合成态整套截图，加真宿主的目标、暂停与继续、后台任务、实时输出、补水、杀宿主六个场景，证据落 `evidence/p1-7-gui-<日期>/`。
- Windows 实测：W1～W12 全过（自动化部分在 Windows CI 两路，界面部分在测试版上人工核对）。
- 回放测试与录制门禁的新增场景全绿；`dshToolVocabulary` 静态守卫全绿；挂载测试不挂死。
