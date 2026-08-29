# Roadmap — Pi Backend Migration

## Phase 1 — 接 SDK + 打包（后端替换）

> 参考：pix `agent-host`（utilityProcess 架构） + pi-app SDK 集成方式
> 进程模型：utilityProcess + MessagePort（D3 rev2）
> Phase 1 实施顺序：T01 → T02 → T03 → T05 → T00 → T04 → T06（已完成）
>
> **2026-08-28 重新规划后的近期主线（仅规划，未授权施工）**：
> 1. **模型闭环**：T19 本地模型目录 → T20 选中模型真实生效；
> 2. **权限闭环**：T07 contracts → T11 bridge → T08 UI 原语 → T08-a 插件随包 → T08-b 审批闭环（T08-c 默认策略等 Q9）；
> 3. **GUI 体验重构**：T12 气泡/时间线外壳 → T12-a~d 工具、思考、流式与交互（直接取用 pi-app MIT 实现）；
> 4. **受管模式**：T21 隔离 agentDir + key 注入；T22 等公司管理页；T23 随 T16。
>
> 排序原则：先补「选了不能生效/无审批」等功能缺口，再做气泡与工具显示；本仓独有但参照项目没有的按钮/附加功能后置。

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| T00 | 屏蔽 Claude/Codex 路径（D5） | **Done** | `ACTIVE_BACKEND = 'pi'` 硬编码在 `AgentHostManager.ts`，走 `PiHostProcess`（utilityProcess），Claude/Codex 代码完整保留 |
| T01 | 安装 pi SDK + piRuntime.ts 核心逻辑 | **Done** | SDK 已装、`piRuntime.ts`（事件映射 + session 生命周期）、`agentWire.ts` 已加 `'pi'`、5038 测试全绿 |
| T02 | utilityProcess 入口 + MessagePort IPC 层 | **Done** | `piHost.ts`（utilityProcess 入口，接收 MessagePort 命令，分发到 PiAgentRuntime） |
| T03 | main 进程接入：spawn utilityProcess + 命令路由 | **Done** | `PiHostProcess.ts`（utilityProcess.fork + MessagePort 双向通信，同 AgentHostProcess 事件接口） |
| T04 | pi SDK 打包进安装包（D7） | **Done** | `ESBUILD_EXTERNAL` 加 pi SDK、`piHost.ts` 作为第二入口、agent-host deps 加 pi SDK、构建验证通过（piHost.js 18KB + pi SDK in node_modules） |
| T05 | 工作区信任适配（原名「权限桥接」） | **Done** | `projectTrusted: true` 只解决工作区是否可信，**不等于用户权限审批已完成**；工具审批另由 T08 系列接 `pi-permission-system`（D9 rev.2） |
| T06 | 冒烟测试：pi SDK 会话创建 → 发消息 → 收流式回复 → 会话关闭 | **Done (2026-08-28)** | 真机实测：发 `hi` 流式回复正常，Q6 事件映射验证通过；模型菜单错位另立 D8/T19 |
| T06-a | 事件映射修复：piRuntime.ts `projectEvent` 重写对齐 EventNormalizer 输出格式 | **Done** | 修复三类缺陷：① 缺 messageId/blockId（渲染器靠它们定位消息块）；② message_update 只看 assistantMessageEvent.delta，忽略 event.message.content 快照（pi SDK 主要用快照发文本）；③ 缺 thinking.started/thinking.delta 事件。2026-08-28 真机验证通过 |
| T06-b | 启动阻塞修复 | **Done** | ① `CREDENTIAL_MODE_SETTING_KEY` 循环块：vite 自动拆块 `shell→settings→shell`，pi SDK 依赖树变化触发，内联常量断开循环；② `utilityProcess.fork()` env 不接受 undefined 值：改为显式过滤 `ELECTRON_RUN_AS_NODE` |

## Phase 2 — Extension UI + 权限审批（D9 rev.2，提前到时间线重造之前）

> 参考：pi-app `features/extension-ui/` + worker RPC、pix `packages/contracts` / `EXTENSION_UI.md`、`@gotgenes/pi-permission-system`。**默认能直接取用 MIT 代码就取用**，不为维持旧布局重复实现。执行依赖：T07 → T11 → T08 → T08-a/b/c；完成后才进入 T12。

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| T07 | 定义 renderer ↔ agent-host 的 Extension UI contracts | Planned | 优先直接移植 pi-app 的 worker-frame / IPC contract 形状；覆盖 request id、挂起/取消、select/input/confirm 响应 |
| T11 | Extension UI bridge：utilityProcess ↔ Main ↔ preload ↔ renderer | Planned | 参照 pi-app bridge/worker RPC 直接取用；必须处理迟到响应、会话切换、host 崩溃、重复应答 |
| T08 | Portable UI 原语：select / confirm / input | Planned | 直接取用 pi-app `ExtensionDialogShell`/`questionnaire-dialog`/confirm 结构，套本仓主题；布局可调整，不受旧气泡内表单约束 |
| T08-a | 随包并固定 `@gotgenes/pi-permission-system` | Planned | MIT；不能依赖用户全局已装。确定 pin、随包/受管 agentDir 加载方式、License notice；本地模式与登录隔离模式均须可用 |
| T08-b | 权限审批闭环：插件 ask → GUI → decision | Planned | 非 TUI 走 `ui.select/input`：Yes / Yes for session / No / No with reason；覆盖 `permissions:ui_prompt` / `permissions:decision`、子代理转发、挂起与取消 |
| T08-c | 默认权限策略与设置面 | Blocked | open-q Q9 待用户拍板默认 policy；至少覆盖工具/bash/path/external_directory，必须 fail-closed |
| T09 | Portable UI 原语：notify / setStatus / setWidget | Deferred | 标题栏通知 + 状态芯片 + Composer 卡片；非权限主线，可后置 |
| T10 | 三级能力分层框架：Portable / Semantic no-op / TUI-only | Deferred | 降级策略 + `unsupported` 诊断信号；不阻塞首版权限审批 |

## Phase 3 — GUI 时间线与气泡重构（D9 rev.2：直接取用 pi-app，保持本仓风格）

> 皮肤风格与主题令牌保留，但**布局、气泡形态、按钮位置均可调整**；用户明确认为当前气泡偏丑。pi-app 为 MIT，默认直接取用/改写其实现。我们独有而参照项目没有的按钮/功能降优先级，不阻塞核心体验。前置：T08 权限审批链完成。

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| T12 | 时间线外壳 + 输入/输出气泡视觉基线 | Deferred | 直接取用 pi-app timeline/turn chrome 的结构与交互，套本仓颜色、字体、圆角与 @coss/ui；先出亮暗双主题 GUI 图供用户验收，不要求保持现有气泡布局 |
| T12-a | display-items / turn-groups 数据建模 | Deferred | 优先直接移植 `timeline-display-items`/`timeline-turn-groups`；若现有 `chatTurn.ts` 能低成本承载则复用，否则替换，不为保留旧代码增加适配层 |
| T12-b | 工具行人话摘要、diff 徽记、原生预览 | Deferred | 直接移植 `tool-call-row`、`buildToolSummary`、`tool-previews`：Edit/Write diff、Read、Grep/Find、Bash、Ls；声明模板→原生预览→通用 default 三层 fallback |
| T12-c | 思考链、流式文本与 Markdown | Deferred | 直接取用 `thinking-chain-block`、`stream-text-reveal`；pi-app 与本仓 FB1-b markdown 分段实测对比后择优，不预设保留旧实现 |
| T12-d | 展开记忆、跟随滚动、底部锚点、问卷 | Deferred | 直接取用 `toolExpandBySession`、follow-scroll/bottom-anchor、questionnaire-dialog；问卷共用已完成的 T08 原语 |
| T13 | 会话管理：历史浏览 / 分支回退 | Deferred | 参考 pi-app 会话树；现有 sessionIndex 仅在低成本时复用，独有按钮后置 |
| T14 | 消息队列：agent 运行时可继续输入 | Deferred | 直接取用 `composer-pending-queue` 及相关状态模型 |
| T15 | 工作区文件预览集成 | Deferred | 多标签浏览、行级源码查看；非首轮气泡/工具体验阻塞项 |

## Phase 4 — 模式切换

> 参考：pix 视图/TUI 切换

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| T16 | GUI 视图模式 ↔ TUI 直通模式切换机制 | Deferred | 一键切换，保留 xterm 作为 TUI 直通 |
| T17 | TUI-only 功能降级 UI 提示 | Deferred | 明确告知用户"此功能在 GUI 模式下不支持" |
| T18 | 模式状态持久化 | Deferred | 用户偏好记住上次模式 |

## Phase 5 — 模型配置链路（D8）

> 2026-08-28 立项。背景、pi-app 参考架构与目标架构见 [topics/model-config.md](./topics/model-config.md)；拍板见 [decisions/008](./decisions/008-model-config-strategy.md)。核心：**先读本地，管理页就绪后切换（D8-d）；key 永不进 models.json（D8-c）；隔离 agentDir（D8-a）**。

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| T19 | GUI 模型菜单对 pi 改读本地 pi 配置 | **Done (2026-08-28)** | Pi 独立目录分支读取本地/受管 `models.json` → `provider/model`；不读 Claude/Codex vault、不发网关请求、不经家族白名单 |
| T20 | 模型选择闭环：`session.create`/`send` 的 model 参数接通 pi SDK `getModel(provider, id)` | **Done (2026-08-28)** | `applySelectedModel()` 在 prompt 前调用 `getModel()` + `session.setModel()`；create 默认、send override、非法/不存在模型均有测试 |
| T21 | 隔离 agentDir（方案 B）：`PI_CODING_AGENT_DIR` 指向 `~/.pilab` 下受管目录 + 登录模式 key 注入 | **Done (2026-08-28)** | `~/.pilab/<profile>/pi-agent`；models/auth 分离，vault 新增可选 pi arm；utilityProcess 只在登录模式注入目录，本机模式零注入 |
| T22 | 管理页同步：登录模式启动拉取 → 校验 → 写隔离目录 | **Done (2026-08-28)** | `pnpm model-admin` 本地端口管理页 + GET/PUT API；启动/登录/手动同步；远端失败 → stale cache → 默认配置；设置页可改部署 URL |
| T23 | TUI 直通模式的模型配置策略 | **Done (2026-08-28, D10)** | 用户拍板 Q8：登录模式 agent PTY 注入 `PI_CODING_AGENT_DIR`，TUI 与 GUI 共用公司模型；普通 terminal/local/remote 不注入 |

## Done

- T01 — pi SDK + piRuntime.ts 核心逻辑
- T02 — piHost.ts（utilityProcess 入口）
- T03 — PiHostProcess.ts（main 进程侧）
- T05 — 工作区信任适配（projectTrusted；用户权限审批另见 T08 系列）
- T00 — 屏蔽 Claude/Codex（ACTIVE_BACKEND = 'pi'）
- T04 — 打包（esbuild + node_modules）
- T06-b — 启动阻塞修复（循环块 + env undefined）
- T06/T06-a — 冒烟通过（2026-08-28 真机：流式回复正常显示）
- T19~T23 — Phase 5 模型配置链路全落（本地/受管目录、模型选择、管理端同步、TUI 注入）；证据见 [evidence/phase5-model-config.md](./evidence/phase5-model-config.md)

## 2026-08-28 本会话关键修改文件

| 文件 | 变化 |
|------|------|
| `src/agent-host/piRuntime.ts` | **重写 `projectEvent()`**：新增 `TurnState` 状态追踪（messageId/blockId/textSnapshot/thinkingSnapshot），快照→增量转换，对齐 EventNormalizer 输出格式（`message.started` 带 messageId、`message.delta` 带 blockId/text、`thinking.started`/`thinking.delta` 独立事件、`tool.started` 带 messageId/name/input）。新增 `ensureAssistant()`/`emitTextDelta()`/`emitThinkingDelta()` 三个辅助方法 |
| `src/main/ipc/settings.ts` | `CREDENTIAL_MODE_SETTING_KEY` 从 `@shared/credentialMode` 导入改为本地内联常量，断开 vite 循环块 `shell→settings→shell` |
| `src/main/services/agent-host/PiHostProcess.ts` | `utilityProcess.fork()` 的 env 参数：从 `{...process.env, ELECTRON_RUN_AS_NODE: undefined}` 改为显式过滤（遍历 process.env 跳过该键） |
