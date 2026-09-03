# Evidence — Q04 Run 面板字段可用性取证

> 2026-09-03，[D02](../decisions/002-layout-cwd-and-evidence-scope.md) 决定三派 `maxapi/grok-4.6` 子代理取证。
> 读取对象：AiClient `feat/pi-primary-backend` 当前代码。
> 结论已关闭 Q04：**U06 不能纯靠渲染层**，上下文占用/usage 字段需 Pi runtime 补（归 Pi 计划）。

## 权威 schema 与链路

- **Schema**：`src/shared/types/runtimeEvents.ts`（联合类型，~1127 行）
- **Producer**：`src/agent-host/piWorkerSession.ts`
- **IPC**：`chat:runtimeEvent`（`src/shared/types/ipc.ts:316`）
- Worker 在 `WorkerManager.dispatch`（`src/main/services/agent-host/WorkerManager.ts:2245`）打 `seq`/`timestamp`

## 字段矩阵

| 字段 | 判定 | 证据 |
|---|---|---|
| **状态机** | ✅ 有（比 pi-app 更丰富） | `SessionRuntimeStatus` idle/starting/running/waiting_permission/waiting_question/stopping/completed/failed/disconnected（`runtimeEvents.ts:42-51`）。Worker 发 `session.status` running/stopping/idle（`piWorkerSession.ts:576,589,1042`）+ `session.failed`（`:1027`）。Renderer 存于 `chatSessions.ts:679`。视觉上 `tool`/`thinking` 是渲染层叠加，同 pi-app（`run-panel.tsx:39-49`）。 |
| **模型** | ✅ 有 | Assistant `message.started.payload.model`（`runtimeEvents.ts:220`；发 `piWorkerSession.ts:935`）。配置的模型是 renderer-local（`useSessionModel.ts:14`）。目录：`chat:listPiModels`（`ipc.ts:315`）。 |
| **思考档 / effort** | ⚠️ 可推导 | 选中的 effort 是 renderer-local（`useSessionEffort.ts:18`；wire `SessionEffortLevel` `agentHost.ts:7`）。Worker 应用它（`piWorkerSession.ts:1080`）但**不在事件里回显** thinkingLevel。live「thinking」可从 `thinking.started/delta`（`piWorkerSession.ts:1003`）推导。 |
| **回合耗时** | ⚠️ 可推导 | 每个事件都带 `timestamp`（`runtimeEvents.ts:64`）。Renderer 已 tick 发送耗时（`turnSendStatus.ts:53`；`ChatComposer.tsx:1219`）。完成延迟：`messageMetadata.ts:16-19`。无需专门 duration 字段。 |
| **上下文占用** | ❌ 缺失（部分在 Main 侧） | `usage.updated` 在 schema 里（`runtimeEvents.ts:34,613`）**但 Pi worker 从不发**（`piWorkerSession.ts` 无匹配；`agent_end` 在 `:672` 忽略 `message.usage`）。目录丢弃 `contextWindow`（`piModelConfig.ts:109` vs 定义 `:48`）。无 `context.preview` / `roleBreakdown` IPC。时间线文本可伪造 donut，但不是真正的占用 %。 |
| **活动工具** | 名称 ✅ / 状态行 ❌ | `tool.started.payload.name`（`runtimeEvents.ts:249`；发 `:854`）。`tool.updated` 只转发 `input`（`:864`），不是 pi-app 的 `partialResult` 状态行（`pi-app/.../worker-session-events.ts:283`）。 |

pi-app 的 Run 面板还从 `turn_end` 要 `usage.{input,output,cacheRead,cacheWrite,cost}`（`pi-app/.../worker-session-events.ts:160-164` + `worker-message.ts:84`）。我们**有事件类型，没有 producer**。

## 判定（U06 的边界）

**否——如果面板对齐 pi-app（usage 行 + 占用 donut），不能纯靠渲染层。**

可用现有 `RuntimeEvent` + renderer store 拼出：状态 / 模型 / 选中 effort / 耗时 / 工具**名称**。

**必须由 Pi runtime 补（归 Pi-only 计划，不在 UI 计划改）**：
1. **发出 `usage.updated`**：从 Pi `turn_end`/`agent_end` 的 `message.usage` 取值（schema 已是 `Record<string, unknown>` 在 `runtimeEvents.ts:613-616`；worker switch 无 `turn_end` 且在 `piWorkerSession.ts:672` 丢弃 usage）。
2. **可选**：`tool.updated` 的 output/partialResult（用于 `activeToolStatus`）。

**不是 worker RuntimeEvent、但仍非 renderer-only**：在 `AgentModelOption` 上暴露 `contextWindow`（Main 已持有；`piModelOption` 把它剥离）。角色图例字符可从 `chatSessions` 消息近似；真正的 session-file 预览要新增 Main/worker IPC（`context.preview` 对应物），也非 UI-only。
