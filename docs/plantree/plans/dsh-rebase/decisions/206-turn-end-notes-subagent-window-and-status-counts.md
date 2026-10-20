# 决策 206：停止或失败的回合保持展开并写明原因；子代理不再重复显示；去掉状态行的 ↑/↓ 计数

日期：2026-10-19（北京时间）。**状态：用户提出的改动，已实现，用户在 dev 应用里验收中。** 分支 `claude/claude-mode-issues-f4bc49`（基于 1.1.1-test.3 的 `claude/sub-agent-delegation-blocking-3a8feb`），本地提交，未推送。

## 1 用户的要求（2026-10-19，Windows，1.1.1-test.3）

1. Claude 模式下，上下文页的 Host stderr 一个会话里刷出几十条一样的 `[claude-sdk-host] start pid=… settingSources=…`，看不出有什么用。
2. 主动停止、意外停止、重试失败放弃之后，页面要停在原来的输出状态，并用气泡写明错误原因和内容，不要默认折叠。
3. 后台任务里已完成的项只能一项项移除。
4. 运行中的状态行 `Thinking 1s · ↑ 158.2k tokens · ↓ 712 tokens` 与 Claude 官方的不一致，也不会跟着变，只留「思考中 N 秒」。慢等待那一行的「↑ N 字符」也去掉。
5. 子代理窗口只显示正在运行的子代理，已完成、失败、被终止的要从列表里清掉。
6. 后台运行的子代理同时出现在后台任务和子代理两个窗口里，是重复的。

## 2 改法

### 2.1 Host stderr（第 1 项）

- 原因：每个 Claude 会话有自己的宿主进程，每起一次打一行启动行。闲置回收、重开、网关变化、崩溃重启都会重起进程；上下文页的 stderr 列表在整个应用运行期间既不清空也不去重。
- Main 侧新增 `isRoutineHostLine`（`hostStderr.ts`），匹配宿主的例行诊断行：启动行、正常退出、send now / withdraw 回执、Git Bash 查找。`WorkerManager.absorbStderr` 照常把这些行写日志、放进崩溃回放缓冲，只是不再转发成 `session.stderr`。警告、失败和 CLI 自己的 `[cli]` 行不受影响。
- 渲染侧 `foldStderrLine`：连续相同的行合并成一行，在**上下文页**显示为 `… (×N)`。日志里仍然每行都记。

### 2.2 停止或失败的回合（第 2 项）

- 原规则（2026-09-24 用户裁决）：结束的回合默认折叠，只有用户主动结束的（Stop、Ctrl+Enter）保持展开。现在扩大到所有**没有正常完成**的回合：主动停止、失败（包括重试放弃）、引擎中断。依然只是默认值，用户点一下照样能折起来（`turnWorkGroupOpen` 的规则不变，传入的是 `endedAbnormally`）。
- `session.failed` 给失败请求打 `stopReason: 'error'` 时，把错误码和原文一起记在消息的新字段 `ChatMessage.failure` 上（只在实时会话里有）。
- 新纯函数 `liveTurnEnd`（`turnEndNoticeModel.ts`）：回合末尾没有历史回放生成的结束说明时，从最后一条助手消息推出「已停止」或「失败 + 原因」。时间线在回合末尾用 `TurnEndNotice` 画成一个气泡；失败的气泡用 `error` 底色。
- 会话失败卡片还在时（最后一个回合、会话状态是 `failed`），同一条失败只由卡片说，不重复画气泡。等下次发送、卡片消失后，气泡留在那个回合上作为记录。

### 2.3 后台任务（第 3 项）

- 后台任务窗口标题栏新增「清除已结束」按钮（`hideJobs`），一次收起所有可移除的行；和逐行「移除」一样，只影响这个窗口。

### 2.4 状态行计数（第 4 项）

- 运行中的那一行（`formatTurnLiveLine`）只显示动词和时间：「✻ 思考中 3 秒」「✻ 回复中 12 秒」。
- 等待行（`composerSendingLine`）和流式回合头（`deriveTurnStatus` 的 `streaming`）也不再带 ↑/↓ 字符数。`promptChars` / `replyChars` 两个参数保留在签名上，但不再使用。
- 用户看到的「tokens」字样，在 test.2 / test.3 的代码里找不到出处（当时的单位已经是「字符」）。这次把所有 ↑/↓ 计数都去掉，问题一并消失。

### 2.5 子代理窗口与后台任务的分工（第 5、6 项，推翻决策 109 第 3 条）

- 决策 109 第 3 条（2026-09-28）：同一个可续跑的子代理同时出现在后台任务窗、子代理窗和时间线泳道三处，「不算重复，三处都保留」。用户这次改为不重复。
- **后台任务窗**只列命令和工作流，不再列子代理（`deriveJobsWindowView` 过滤掉 `kind === 'subagent'` 的行，包括一次性后台子代理的作业和正在运行的可续跑子代理）。
- **子代理窗**只列正在运行的子代理；完成、失败、被打断的离开列表，记录仍保留在时间线和泳道里。标题计数改为「N 运行中」，空状态改为「当前没有运行中的子代理」。没在本窗口见过运行的旧子代理（只在目录里）不再列出。
- 停止能力搬到子代理窗：可续跑的照旧是「打断」；一次性后台子代理新增逐行「停止」，通过它的作业停掉（`deriveStoppableSubagentRows` + `stoppableRowFor`；SDK 引擎里泳道的 `agentId` 就是作业 id）。「全部停止」不变。
- 时间线泳道不受影响。

## 3 验证

- 根 `pnpm typecheck` 通过。
- 更新了按旧行为写的断言：`turnLiveHead`、`turnHandshakeOneLineMount`、`attachments`、`turnStatus`、`messageTimelinePendingStatic`、`turnEndOpenInteraction`（END-OPEN-3：失败的回合现在展开，点一下能折起）、`messageTimelineWiring`、`subwindowsModel`、`sessionSubwindowsMount`。
- 新增：`liveTurnEnd`（turnEndNotice.test.ts）、`isRoutineHostLine`（hostStderr.test.ts）、stderr 连续行合并（contextSurfaceModel.test.ts）、「清除已结束」挂载测试（P7B-MOUNT-CLEAR）。
- `src/renderer` 全部 390 个测试文件里只有 `legacyShellAbsence` 一项失败，它扫描的是这次没改的 `stores/settings/migration.ts`，与本次改动无关。WorkerManager / WorkerManagerClaudeSdk 测试通过。
- 还没在打包应用或加密机上验证。
