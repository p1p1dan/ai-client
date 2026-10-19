# 决策 203：停止只停主对话、运行中回车改插话、转到后台、子代理子对话页

日期：2026-10-19（北京时间）。**状态：前四项方向由用户 2026-10-19 选定（第 1 节）；标「自主」的是实现时的自主决定，待用户审批（第 7 节汇总）。** 分支 `claude/sub-agent-delegation-blocking-3a8feb`，接在[决策 201](201-send-now-keeps-subagents.md) 之后，本地提交，未推送。修订[决策 069](069-stop-and-background-lifecycle.md) 第 1 条。编号已登记在会话组共享笔记的 `decision-number-claims.md`（202 已被另一个会话占用）。

## 1 起因与用户选择

决策 201 修完「立即发送」之后，用户又提了四点，并逐项选定方向：

| 问题 | 用户选择 |
|---|---|
| 停止按钮与 Esc | 默认只停主对话，子代理窗口里加「全部停止」 |
| 运行中按回车 | 改成插话（下一步送达），排到回合结束后降为次要选项 |
| 可以后台运行的任务 | 加按钮，点了直接转入后台 |
| 子代理的展示 | 像 Claude 桌面版那样，能以子对话的形式查看 |

另外截图里，被停掉的子代理名下还挂着一行「运行中」的工具，一并修。

## 2 停止只停主对话

- **所有停止都只停主回合**：停止按钮、Esc、失败卡片上的「停止」、重试横幅的「现在放弃」、「立即发送」。`stopChatSession` 的默认范围改为 `turn`，Main 和 DSH 宿主沿用决策 201 加的 `scope`。
- **DSH**：只取消父回合；后台子代理继续运行，跑完照常把结果交回主对话。
- **Claude 引擎（SDK）**：做不到。CLI 2.1.300 对 SDK 客户端的 interrupt 一定会清掉后台子代理（它把这类结束记为 `killed.system`，说明原文是「the sweep of background subagents when an SDK or IDE client interrupts」）。所以停止按钮在这个引擎上仍是全停，提示文字写明这一点：
  - DSH：「停止当前回合 — 后台子代理继续运行」
  - Claude 引擎：「停止当前回合 — Claude 引擎会同时结束后台子代理」
- **子代理窗口加「全部停止」**：先确认，再逐个停止所有运行中的子代理。可续聊的打断（之后还能续聊），其余的结束对应的后台任务。做法和后台任务窗的「全部停止」一样，只是范围限于子代理。

## 3 运行中回车改为插话

| 操作 | 改前 | 改后 |
|---|---|---|
| 运行中回车 | 排队，回合结束后发出 | **插话**，下一步送达 |
| 运行中 Ctrl+Enter | 插话 | **排队**，回合结束后发出 |
| 运行中的主按钮 | 「加入队列」 | 「发送到当前回合（下一步送达）」，提示里说明 Ctrl+Enter 排队 |
| 停止进行中 | 排队 | 仍排队（正在停的回合不再接收消息） |

输入框的占位提示改为「回合进行中 —— Enter 并入当前回合，Ctrl+Enter 排到回合结束后…」。

## 4 已停止子代理的工具行收尾

子代理的泳道进入结束状态时（停止、失败、完成，或者引擎断开），它名下还处于「运行中」的工具行一律收尾为「已停止」，和主时间线上被停掉的工具行一样显示。

## 5 转到后台

- **Claude 引擎**：Bash、PowerShell、Agent 正在前台运行时，行的右侧出现「转到后台」。点击后宿主发 CLI 的 `background_tasks` 控制请求，带上这一项的 `tool_use_id`，相当于 Claude Code 对这一项按 Ctrl+B：调用立即返回，主回合继续往下走，被转走的工作作为后台任务继续运行。
- **CLI 的回答**：回应里的 `backgrounded` 表示是否真的转走了。命令刚开始的一瞬间 CLI 还没把它登记成任务，这时转不走，界面提示「这一项没能转到后台」，稍后再点即可。
- **任务窗**：前台子代理转到后台后，CLI 会通过 `task_updated`（`patch.is_backgrounded`）或后台任务集合告知，任务板随之把它列为后台任务。之前任务板不列前台子代理，转走之后任务窗里也看不到它。
- **DSH**：没有对外的转后台接口，前台命令只在超时后才会转后台（`promoteOnTimeout`），前台子代理则从不转。所以宿主回答 `backgrounded: false`，界面也不显示这个按钮。按决策 090 不改 DSH，要做得等上游提供接口。

## 6 子代理子对话页

- **入口**：子代理窗口每一行有「查看对话」，打开一个只读弹窗，显示这个子代理的完整过程：给它的提示、它的思考与回复、每次工具调用及结果。子代理还在运行时，每 3 秒重新读一次。
- **数据**：新增 RPC `worker.subagent.history`，读子代理自己的完整记录，不读委派行下面的泳道（泳道是截断过的：每段文字最多 4,000 字，行数有上限）。
  - DSH：读子会话日志（`sessionQuery.observeSession`），用 `projectDshHistory` 投影，与历史加载走同一套。只允许读本会话的直接子代理：本会话日志的目录里记有它，或者本次运行里见过它。否则返回 `WORKER_SUBAGENT_UNAUTHORIZED`。
  - Claude 引擎：读 CLI 的 `subagents/agent-<任务 id>.jsonl`，只在本会话的目录下找。用新写的 `projectSubagentTranscript` 投影：同一个 API 消息拆成的多行合并，工具结果并到对应的工具调用下面。
  - 最多返回最新的 500 条消息，更早的标明未显示。
- **渲染**：复用时间线的部件，正文用 `TurnTextItem`，工具与思考用 `ToolGroup`。不挂会话，所以没有展开记忆，也没有任何行内操作。

## 7 自主决定（待审批）

1. **Claude 引擎的停止仍然全停**，只在提示里说明。CLI 没有"只停主回合"的 interrupt；`send_now` 不结束后台任务，但它必须带一条消息，不能当停止用。
2. **失败卡片和重试横幅上的「停止」也只停主回合**，与停止按钮保持一致。
3. **停止进行中按回车仍排队，不插话。**
4. **「转到后台」只放在 Bash、PowerShell、Agent 三种工具上**（CLI 把这三种登记为任务）。转不走时只提示，不自动重试。
5. **子对话页只读，不支持在里面继续给子代理发消息。** DSH 有 `send_message`；CLI 的 `SendMessage` 目前在 `HOST_ONLY_TOOLS` 里被禁用，要放开得另行决定。
6. **子对话页最多显示最新 500 条消息。**

## 8 验证

- 两套 tsc（`pnpm typecheck`、`pnpm typecheck:dsh-host`）通过；biome 通过。
- 单测：
  - 渲染端：`composerStopStatic`（停止范围、运行中回车、停止按钮提示）、`queueRelease`（运行中按钮改为插话）、`chatSessionActions`、`middleColumnLayout`（占位提示）、`subagentActivityModel`（泳道结束时工具行收尾 2 条）、`toolBackground`（哪些行显示「转到后台」）。
  - DSH 宿主：`[SUB-HISTORY]` 授权与读取，`[BG-TOOL]` DSH 回答 false。
  - SDK 宿主：`backgroundTool` 2 条，`taskBoard` 转后台后列为任务，`subagentTranscript` 投影 2 条，send_now 的能力判断移到消息排队时。
  - Main：`chatPiWorkerRouting` 的停止范围。
- 路线 B 探针 `agentstop` 组（本机 Windows，假网关）：`agent-sendnow`、`agent-stop-all`、`tool-background-bash`、`tool-background-agent`，全部通过。
- **没有验证**：
  - DSH 真宿主上"停止后子代理继续运行"（录制门禁与 bridge 冒烟要在 Linux 上跑）；
  - 开发版界面上的实际操作（按钮位置、弹窗）。
- **2026-10-19 Linux 补验**（合入 201～205 后的分支）：
  - 自动检查：三套 tsc、vitest（`src/renderer src/shared src/dsh-host src/claude-sdk-host src/main`，700 个文件）、录制门禁 37 个场景、bridge 冒烟、5 个真宿主集成测试、路线 B 探针 `flow`（82 项）与 `agentstop`（25 项，Linux 上「父命令在立即发送后结束」是硬检查）全部通过。
  - 新增真宿主集成测试 `src/dsh-host/__tests__/stopScope.integration.test.ts`（假网关脚本 `P1-SUBSTOP`）：`scope: 'turn'` 时后台子代理不被打断、跑完、结算通知唤醒父会话；不带 scope 时子代理被打断。去掉 `scope` 判断后第一条失败。
  - 开发版界面（两个本地假网关）：DSH 的「立即发送」、停止按钮、Esc 只停主回合，子代理跑完交回结果；子代理窗口「全部停止」先确认再打断；「查看对话」能看到提示、工具与回复，运行中自动刷新；委派行在主回合结束后显示「后台运行中」；Claude 引擎的「立即发送」不中止子代理，停止按钮提示写明会结束后台子代理；运行中回车插话、Ctrl+Enter 排队；Bash 与前台子代理「转到后台」后回合继续，任务窗里能看到；决策 204、205 的场景也走通。
  - 补验中发现并修复：运行中回车把引擎命令（DSH `/goal`、技能等）当文字插进回合，命令不执行；改为照旧排队（`enterInterjectSlashMount.test.ts`）。Claude 引擎队列条的「立即发送」没送出去时，放回队首改用 `restoreHead`，不再因队列上限丢消息。
  - 界面上没测到：停止进行中按回车排队（Claude 引擎的停止在几十毫秒内完成，没有可操作的窗口；源码测试覆盖）；子对话页里的思考块（假网关的子代理脚本不产出思考）。
  - 观察：「转到后台」在命令开始约 3 秒时点，CLI 回答转不走，十几秒后再点成功；不带 `run_in_background` 的 Agent 调用，CLI 2.1.300 直接放到后台，这时没有「转到后台」按钮。
- **补验后的审查收尾**（同日）：
  - 别的对话的停止还没落定时，本对话运行中回车照样插话，与主按钮一致（只看本对话的停止状态）。
  - 子代理窗口「全部停止」里，结束一次性子代理失败时提示「子代理没有停下」，不再一律写「没有被打断」。
  - 删去 `chatSessions` 里已无调用方、仍是全停的 `stopActiveSession`。
  - Claude 引擎：插话之后、CLI 回报排队之前按了停止，不再补发 `send_now`（`sdkSessionRuntime.test.ts`）。
  - 核实后不改：Claude 引擎的 `/compact` 不是回合，期间对话不是运行中，「立即发送」只会排队、不会退回全停；子对话投影里「工具结果与文字同在一行」在 CLI 2.1.300 的记录里没有出现（插话单独成行）。
