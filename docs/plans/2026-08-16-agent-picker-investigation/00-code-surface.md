# D48 调查 00 — 代码面摸底（agent 选择相关接线面）

> 2026-08-16，阶段 3（D48）调查轮第 0 篇。只读摸底，全部 file:line 已由调查员核实。
> 立项拍板见[总台账 D48](../openchamber-chat-refactor-ledger.md)。

## 1. `capabilities.agents`：定义与消费点

**定义（类型）**

- `src/shared/types/runtimeEvents.ts:93-108` — `HostReadyEvent['payload'].capabilities`，其中 `agents?: AgentWireName[]`（:108），注释："absent = old Host, only Claude Code"。
- `src/main/services/agent-host/AgentHostManager.ts:65` — `AgentHostCapabilitiesInfo = NonNullable<HostReadyEvent['payload']['capabilities']>`；:98 私有缓存；:113/:121 `getStatus()` 透出给 IPC。
- `src/renderer/components/chat/hostStatus.ts:38` — `HostStatus.capabilities?: { thinking?: boolean; agents?: AgentWireName[] }`；`filterAgentWireNames`（:49-52）过滤未知 slug。

**产生处（Host 侧写入）**

- `src/agent-host/agentSupport.ts:164-189` — `buildHostAgentRegistry()`：flag × credentialMode × probeEntry × prepareHome 四道闸门。
- `src/agent-host/index.ts:363-373` — `host.ready` 里 `capabilities.agents: [...outcome.registry.agents]`。

**读取链路**

- Main：`AgentHostManager.ts:394-397`（`host.ready` → `this.capabilities`）。
- Renderer 双通道：`hostStatus.ts` `reduceHostStatus`（:73-113，事件流）+ `primeHostStatus`（:163-189，挂载快照）；由 `useHostStatus.ts:37-48` 驱动。

**当前 UI 消费：无。** 唯一生产读点 `ChatWorkspace.tsx:49` 只读 `.thinking`。`hostStatus.ts:35-36` 注释自述："Today's only consumer is test assertions; a stage-3 agent picker is the eventual UI reader."

## 2. 聊天会话与 agent 的绑定现状

- `AgentWireName`：`src/shared/types/agentWire.ts:43-45` — 闭合两元 `['claude-code','codex']`；`LEGACY_AGENT = 'claude-code'`（:59，全仓唯一硬编码点）；`resolveAgentWireName()`（:101-106，空值→LEGACY，未知→null）；`sessionAgent()`（:118-120，`session.agent ?? LEGACY_AGENT`）。
- 创建链：`chatSessionActions.ts:20-60` `createChatSessionOnWorkspace()` **不写 `agent` 字段**（:31-38 对象字面量无 agent）。
- 物化点：`chatSessions.ts:1030-1037` `sendMessage()` → `createSession({..., agent: sessionAgent(session)})` — **agent 在首条消息发出时物化**。
- Host 回填：`chatSessions.ts:486-502`（`session.created`/`session.resumed` 的 `event.payload?.agent`）。
- 侧栏 chip：`sidebarTree.ts:99-107` `agentChipForSession()` + `AGENT_DISPLAY_NAMES`（`agentWire.ts:48-51`：'Claude Code'/'Codex'）；渲染 `LeftNav.tsx:787-794`（Badge，约 63px predicate budget，恒显示）。

## 3. 旧终端轴 picker（三轴隔离，不碰）

- `AgentPickerMenu.tsx`（被 `AgentSessionTabs.tsx:6,155`、`AgentPanel.tsx:28,116` 引用）；`SessionBar.tsx:446`（内含重复 inline 菜单 :923-960）。
- `BuiltinAgentId`：`src/shared/types/cli.ts:1-8` 七元联合，但消费点实际是松散 `string`（承载 `-hapi`/`-happy` 后缀 + 自定义 id：`AgentPickerMenu.tsx:30-32`、`SessionBar.tsx:786-789`、`agentSession.ts:26-28`）。
- 与聊天轴差异：`agentWire.ts:1-34` 文件头三轴分工表；数值故意不对齐（`'claude-code'` vs `'claude'`），`agentWireStatic.test.ts` 静态断言禁互转。

## 4. Composer 现有结构（新入口的自然落点）

文件：`src/renderer/components/chat/ChatComposer.tsx`（2493 行）。

- session 模式底栏：:2455-2461 `[attachButton, textareaEl, statusLine, modelEffortControls, actionButtons]`。
- empty 模式底栏：:2474-2479 `[attachButton, modelEffortControls, statusLine, actionButtons]`（:2470-2472 注释 "⊕ → model → status → actions"）。
- `modelEffortControls`（:2224-2231）→ `ComposerModelTrigger.tsx`（T-30b2 合并的单 Menu 双 RadioGroup）。
- `ComposerTargetBar.tsx`（:2344,2484 使用）管 folder/branch/runLocation，不是模型/agent 控件。
- **没有 permission mode 写入控件**：permissionMode 只出现在只读展示（`sessionRuntimeFacts.ts` / `contextSurfaceModel.ts`）。
- 发送路径已读 `sessionAgent(preSession ?? {})`（:879），仅内部逻辑非 UI。
- 新 agent 入口自然落点 = `modelEffortControls` 同级，同款闸门 `disabled={disabled || busy || sending}`（参照 :2224-2231）。

## 5. flag `AICLIENT_AGENT_CODEX` 控制面

- 定义/读取：`agentSupport.ts:25`（`CODEX_FLAG_ENV`）、:42-44（严格 `=== '1'`）、:167（registry 第一道闸门，off 时 `reason: 'flag_off'` 且不碰 fs）、:230（错误文案）。
- Main **故意不注入**该 key（`hostEnv.ts:24-27` 注释；`buildAgentHostEnv` :62-73 无此 key）；靠 `AgentHostProcess.ts:49-52` `...process.env` 透传用户 shell 值。
- `scripts/dev.js` / `dev.env*` / `.env.local.example` 均不设置（默认 off）。
- **off**：registry 第一道闸即标不可用，`capabilities.agents = ['claude-code']`，create/resume codex 被拒。
- **on**：过三道后续闸后 `capabilities.agents = ['claude-code','codex']`；但渲染端无任何 UI 消费 → 用户仍无入口（阶段 3 补的就是这块）。
