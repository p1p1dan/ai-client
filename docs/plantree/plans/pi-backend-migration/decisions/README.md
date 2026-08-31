# Pi-only migration 决策索引

> 本文件是 D1–D15 当前权威状态的唯一索引。原决策保留当时背景与理由；`Superseded` 不代表删除历史，只代表它不能继续驱动新实现。

## Active

| ID | 决策 | 当前适用范围 |
|---|---|---|
| [D2](./002-extension-strategy.md) | Extension strategy | 能力分层与 Extension UI 产品契约；运行 ownership 按 D15 更新到 WorkerSlot |
| [D6](./006-tui-plugins-via-mode-switch.md) | TUI plugins via mode switch | GUI/TUI 展示模式边界；PTY/CLI 实施参考 pix |
| [D8](./008-model-config-strategy.md) | Pi model config | managed models/auth 配置与同步策略 |
| [D9](./009-timeline-reference-piapp.md) | pi-app timeline reference | timeline/history/tree 的功能参考 |
| [D10](./010-tui-managed-pi-config.md) | TUI managed Pi config | 登录模式 TUI 注入 managed agentDir |
| [D11](./011-default-permission-policy.md) | Default permission policy | Pi permission 默认和受管策略 |
| [D12](./012-timeline-data-model.md) | Timeline data model | RuntimeEvent 上游事件边界与 renderer projection |
| [D14](./014-pi-only-product-and-conversation-import.md) | Pi-only 产品与会话导入 | 删除 legacy execution runtime；只读、原子、可去重地导入历史 |
| [D15](./015-main-owned-worker-manager.md) | Main-owned WorkerManager | Main 持有 bounded pool；每 WorkerSlot 一个 utilityProcess/Pi AgentSession |

## Revised / partially active

| ID | 保留结论 | 被修订部分 |
|---|---|---|
| [D3](./003-process-model.md) | utilityProcess、MessagePort、崩溃隔离、不依赖独立 Node/NDJSON | singleton Pi agent-host topology 被 D15 替代 |
| [D4](./004-auth-dual-path.md) | managed/local 两条配置路径 | 存储事实必须以已实现 isolated agentDir/auth/models 为准 |
| [D7](./007-pi-bundling.md) | Pi 由应用随包提供，用户无需单独安装 | SDK/CLI 的 asar 假设由 Worker/Resources 打包取代 |
| [D13](./013-completion-scope-and-product-semantics.md) | Cycle 1/2 已完成产品语义 | 原 Cycle 3–5 顺序和 singleton-host 实施前提由新 roadmap 取代 |

## Superseded

| ID | 原结论 | 替代权威 |
|---|---|---|
| [D1](./001-architecture-route.md) | pix 架构为主且不移植 pi-app WorkerManager | [D15](./015-main-owned-worker-manager.md)：直接采用 pi-app-style WorkerManager/WorkerSlot，pix 聚焦 TUI/PTY/CLI |
| [D5](./005-disable-claude-codex.md) | 屏蔽但保留 Claude/Codex runtime，随时可切回 | [D14](./014-pi-only-product-and-conversation-import.md)：删除执行 runtime，以只读导入保留历史价值 |

## 读取规则

1. 产品范围冲突时，以 D14 为准。
2. 进程、ownership、pool 或 session runtime 冲突时，以 D15 为准。
3. 具体产品行为仍由 D2、D6、D8–D12 与 Cycle 1/2 evidence 约束。
4. Roadmap 任务状态和顺序只由 [`../roadmap.md`](../roadmap.md) 维护；D13 中的旧排期只保留历史意义。
5. 参考仓库使用规则见 [`../topics/reference-repositories.md`](../topics/reference-repositories.md)。
