# Plan — Pi Backend Migration

> 分支 `feat/pi-primary-backend`。将桌面应用后端从 Codex（Claude Code CLI app-server）全面切换到 pi-agent 生态（`@earendil-works/pi-coding-agent` SDK）。

## Scope

把 `src/agent-host/` 的后端从 Claude Code Agent SDK 替换为 pi-agent SDK，保留 GUI 外皮，实现结构化对话交互 + 视图/TUI 模式自由切换。

**动机**：pi-agent 适配多模型供应商（不限于 Claude/Codex），用户设备可直接使用，提供开箱即用体验。

**非目标**：
- 不改 Electron 主进程架构（保留 main → preload → renderer 三层）
- 不重写 GUI 组件库（复用现有 React + shadcn 组件）
- 不做 pi-app 的 34 个逐扩展适配器（采用三级能力分层代替）

## 参考项目

| 项目 | 用途 | 核心借鉴 |
|------|------|----------|
| [pix](https://github.com/num-scope/pix)（架构参考） | 四层隔离 + contracts 包 + 三级能力分层 + utilityProcess 崩溃隔离 | agent-host 进程模型、Extension UI bridge、Portable/Semantic no-op/TUI-only 分层 |
| [pi-app](https://github.com/justhil/pi-app)（功能参考） | 流式时间线 + 会话树 + 消息队列 + 扩展兼容层 | 产品功能设计、用户交互模式、`~/.pi/agent` 共享配置 |

## 受影响模块

| 模块 | 影响 |
|------|------|
| `src/agent-host/` | **重写**：claudeRuntime → piRuntime，eventNormalizer 适配 pi SDK 事件 |
| `src/shared/types/` | **扩展**：新增 pi 协议类型，保留 runtimeEvents 作为内部统一事件层 |
| `src/main/services/agent-host/` | **改造**：AgentHostManager 切换到 utilityProcess 模式 |
| `src/renderer/` | **增量**：新增结构化消息渲染 + 模式切换 UI |
| `src/preload/` | **适配**：IPC 桥接更新 |

## 文件地图与阅读路径

| 文件 | 角色 |
|------|------|
| [roadmap.md](./roadmap.md) | 四阶段任务全量状态 |
| [open-questions.md](./open-questions.md) | 未决问题 |
| [topics/architecture.md](./topics/architecture.md) | 架构方案：四层隔离 + 进程模型 |
| [topics/extension-ui.md](./topics/extension-ui.md) | 扩展 UI 三级能力分层方案 |
| [decisions/](./decisions/) | 已拍板决策 |
