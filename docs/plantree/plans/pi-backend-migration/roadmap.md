# Roadmap — Pi Backend Migration

## Phase 1 — 接 SDK + 打包（后端替换）

> 参考：pix `agent-host`（utilityProcess 架构） + pi-app SDK 集成方式
> 进程模型：utilityProcess + MessagePort（D3 rev2）
> 实施顺序：T01 → T02 → T03 → T05 → T00 → T04 → T06

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| T00 | 屏蔽 Claude/Codex 路径（D5） | **Done** | `ACTIVE_BACKEND = 'pi'` 硬编码在 `AgentHostManager.ts`，走 `PiHostProcess`（utilityProcess），Claude/Codex 代码完整保留 |
| T01 | 安装 pi SDK + piRuntime.ts 核心逻辑 | **Done** | SDK 已装、`piRuntime.ts`（事件映射 + session 生命周期）、`agentWire.ts` 已加 `'pi'`、5038 测试全绿 |
| T02 | utilityProcess 入口 + MessagePort IPC 层 | **Done** | `piHost.ts`（utilityProcess 入口，接收 MessagePort 命令，分发到 PiAgentRuntime） |
| T03 | main 进程接入：spawn utilityProcess + 命令路由 | **Done** | `PiHostProcess.ts`（utilityProcess.fork + MessagePort 双向通信，同 AgentHostProcess 事件接口） |
| T04 | pi SDK 打包进安装包（D7） | **Done** | `ESBUILD_EXTERNAL` 加 pi SDK、`piHost.ts` 作为第二入口、agent-host deps 加 pi SDK、构建验证通过（piHost.js 18KB + pi SDK in node_modules） |
| T05 | 权限桥接（permissionBridge）适配 pi SDK 的权限模型 | **Done** | pi SDK 用 `projectTrusted` 信任模型（非 canUseTool 回调），piRuntime.ts 已设 `projectTrusted: true` |
| T06 | 冒烟测试：pi SDK 会话创建 → 发消息 → 收流式回复 → 会话关闭 | **Blocked** | 构建产物 + 类型 + 5038 测试已验证；需真机启动 Electron 做端到端冒烟（utilityProcess + pi SDK 全链路） |

## Phase 2 — 协议层（contracts + UI 原语）

> 参考：pix `packages/contracts` + `EXTENSION_UI.md`

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| T07 | 定义 renderer ↔ agent-host 通信协议（contracts） | Deferred | 参考 pix 的 contracts 包，提取为独立类型定义 |
| T08 | 实现 Portable UI 原语：select / confirm / input | Deferred | ExtensionUIContext → GUI 组件映射 |
| T09 | 实现 Portable UI 原语：notify / setStatus / setWidget | Deferred | 标题栏通知 + 状态芯片 + Composer 卡片 |
| T10 | 三级能力分层框架：Portable / Semantic no-op / TUI-only | Deferred | 降级策略 + `unsupported` 诊断信号 |
| T11 | Extension UI bridge（extension-ui-bridge.ts） | Deferred | 参考 pix 的桥接层实现 |

## Phase 3 — 核心交互

> 参考：pi-app 功能设计

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| T12 | 流式时间线：Markdown / 代码块 / 可折叠工具步骤 | Deferred | 替代 xterm 裸文本输出 |
| T13 | 会话管理：会话列表 / 历史浏览 / 分支回退 | Deferred | 参考 pi-app 会话树 |
| T14 | 消息队列：agent 运行时可继续输入 | Deferred | 消息在当前轮次结束后执行 |
| T15 | 工作区文件预览集成 | Deferred | 多标签浏览、行级源码查看 |

## Phase 4 — 模式切换

> 参考：pix 视图/TUI 切换

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| T16 | GUI 视图模式 ↔ TUI 直通模式切换机制 | Deferred | 一键切换，保留 xterm 作为 TUI 直通 |
| T17 | TUI-only 功能降级 UI 提示 | Deferred | 明确告知用户"此功能在 GUI 模式下不支持" |
| T18 | 模式状态持久化 | Deferred | 用户偏好记住上次模式 |

## Done

- T01 — pi SDK + piRuntime.ts 核心逻辑
- T02 — piHost.ts（utilityProcess 入口）
- T03 — PiHostProcess.ts（main 进程侧）
- T05 — 权限桥接（projectTrusted 信任模型）
- T00 — 屏蔽 Claude/Codex（ACTIVE_BACKEND = 'pi'）
- T04 — 打包（esbuild + node_modules）
