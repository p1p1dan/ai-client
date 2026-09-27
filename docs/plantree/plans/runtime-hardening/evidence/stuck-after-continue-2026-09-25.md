# 「继续」之后停不下来：根因排查（2026-09-25）

Role: evidence。来源：用户 2026-09-25 在 Windows `1.0.3-test.2` 现场反馈；只读排查（代码 + /tmp 探针测试，未改产品代码）。落地任务：T144～T146、T135，规则见[决策 046](../decisions/046-stop-always-settles.md)。

## 现场现象

1. 上一轮中断出现失败卡，点「继续」后会话一直显示运行中；Stop、Esc、Ctrl+Enter 立即插入都停不下来。
2. 左侧「结束对话」后，在右侧发新消息却进了队列；点队列行的「立即发送」，消息回到输入框；再点发送正常。
3. 工具行显示 `运行中：<bash 命令>  已允许  3m55s/2m`。

## 结论

| 编号 | 结论 | 把握 |
|---|---|---|
| H1 | 停止链没有对账：worker 没有活动回合时 `stop` / `interject` 只回 `false`、不发事件（`nativeWorkerRuntime.ts:473-503`）；Main 丢掉 `stopped`（`WorkerManager.ts:1975-1992`），entry 非 ready 时静默返回；`closeSession` → `retireEntry` 只清 `activeRequestId`、不派发终态（`:2214-2222`、`:2790-2808`）；渲染层 `stopChatSession` 只清 `lastError`。渲染层一旦认为「在跑」而 worker 没有可 abort 的回合，Stop 永远解不开 | 探针证实 |
| H2 | 结束对话后队列死锁：`endSessionRuntime` 只置 `disconnected`，不清输入框闩锁、不处理队列（`endSessionRuntime.ts:63-82`）；放行只认 `idle` / `completed`（`queueRelease.ts:141`）；「立即发送」按钮禁用时 `disabled:pointer-events-none`（`ui/button.tsx:21`）让点击穿透到行的 `onEdit`（`QueuedMessageStrip.tsx:113,148`），消息被「取回编辑」回到输入框。禁用按钮由 `0f153694` 引入；`stopping` 状态同样死锁 | 探针证实（CSS 穿透为代码推定） |
| H3a | 重发的 run 卡在不响应 abort 的 await 上：`startRun` 先发 `running`（`agent-loop/index.ts:457`），abort 监听到 `:950` 才注册，中间有 `await subagents.refresh()`（`:516`）；此时 Stop 只得到永久 `stopping`，而 `isRunningStatus` 不含 `stopping`（`queueRelease.ts:647-654`），Stop 按钮消失、Esc 失效、Ctrl+Enter 退化为普通入队 | 代码强支持 |
| H3b | `runSend` 卡在不可取消的 IPC await 上（`resumeSession` / `send` / `createSession`，generation 只在等待谓词里检查，`ChatComposer.tsx:2112`）；worker 重启期间 Stop 可见但无效 | 代码支持，有上界（bootstrap 最长 60s） |
| H3c | Main 与 worker 闩锁不一致：`startSend` 在 run 真正接纳前就回 `accepted:true` 并吞掉前置拒绝（`nativeWorkerRuntime.ts:436-446`），Main 的 `activeRequestId` 永久钉住，此后每次 send 都是 `session_busy`；已存在 entry 的 `createSession` 按钉住的闩锁重新广播 `running`（`WorkerManager.ts:906-911`） | 探针证实可达，本路径上较弱 |
| E | bash 超时 / abort 挂死：**证伪**。`runPipe` 在超时、abort、exit 后最多 `cleanupTimeoutMs`（2s）必定结束，不等管道 `close`（`exec.ts:720-783`）；Windows 只 `taskkill /T /F` 一次，孤儿孙进程会泄漏但调用会结束 | 探针证实 |

H3 三条具体走的是哪条，需现场日志与会话文件区分；但 H1 / H2 是结构性缺陷，无论哪条都要修。

## 显示问题（3m55s/2m）

工具行时钟起点是 `tool.started`，T101 起在参数流式阶段就发出（`projector.ts:385-405`），包含参数流式、审批等待与路径检查；「2m」超时从 exec 开始算（`exec.ts:720`）。起点不同，所以会出现「已用超过上限」的假象。能看到时钟在走，说明当时状态仍是 running 类或有在飞的 send（`processSettled` 为真时不显示时钟，`MessageTimeline.tsx:2217,2239`）。

## 旧修复为何没覆盖

- `e5226881`：只在 `session.stopped` 到达时清 `pendingReply` 计时，依赖终态事件必到。
- `0f153694`：放行仍以 idle / completed 为前提，并引入了会被点击穿透的禁用 Send-now。
- `0a836f27` / `d2938de7` / `4a964c7d`：插话要等下一个回合边界；没有 run 或 run 卡在边界前时永远不生效。

## 探针

`/tmp/stuckprobe/`（重启即丢）：`rendererQueue.test.ts`（5）、`runtimeStop.test.ts`（3）、`workerManagerEnd.test.ts`（1）、`execSettle.test.ts`（3），全部通过。修复时收成正式用例。

## 待现场补的证据

当天 `aiclient-YYYY-MM-DD.log`（日志开关关闭时文件仍记 info 及以上）：`turn failed`、`provider retry`、`crashed`、`restart budget exhausted`、`chat:stop` / `chat:send` / `chat:resumeSession` / `chat:closeSession` 的 handler 错误、`worker.stop timed out`、`worker.dispose timed out`、`session_busy`。该会话 `.jsonl` 末尾约 80 行：有无第二条相同 user 消息、bash 的 toolResult 与 `termination` / `stopped`。界面：点 Stop 后 Stop 按钮是否消失；Ctrl+Enter 是否提示「当前没有正在运行的回合」。
