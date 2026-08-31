# Completed Plan — Unified Credentials and App State

> **状态**：Completed foundation（2026-08-28）
>
> 本计划不再提供活动 handoff。Pi-only 后续权威见 [Pi migration](../pi-backend-migration/README.md)、[D4](../pi-backend-migration/decisions/004-auth-dual-path.md) 与 [model config](../pi-backend-migration/topics/model-config.md)。

## 已完成且继续有效

- app state 统一到 `~/.pilab/<profile>/`；旧 `.aiclient` copy migration 和 profile isolation；
- credential vault + safeStorage envelope；可选 `pi` arm，旧文档可兼容读取；
- credential mode 成为 Main-owned runtime setting，不由不可达 env flag 决定产品行为；
- managed Claude/Codex home 整体重定向被取消，凭据与用户配置树解耦；
- Main-owned settings key 防 renderer 整份写回覆盖；
- managed/local 两条入口和登录/adoption 的历史实现证据。

Pi-only 不再需要 Claude/Codex execution injection，但这些 app-state、vault、mode、ownership 和迁移原则仍是 Pi managed/local config 的基础。

## 当前边界

- Pi managed agentDir、`models.json`/`auth.json`、model sync 与 TUI env 由 Pi plan 维护。
- Claude/Codex legacy credential parsing 只在 T34 import/adoption 真有需要时保留；不得因此保留 execution runtime。
- 品牌/appId/profile rename 是独立迁移，不从本 completed plan 继续扩张。

## 文件

| 文件 | 当前角色 |
|---|---|
| [roadmap.md](./roadmap.md) | 完成摘要与 Pi-only 影响 |
| [implementation-status.md](./implementation-status.md) | completed snapshot，不含活动 TODO |
| [open-questions.md](./open-questions.md) | 无 plan-local 活动问题 |
| [topics/discarded-approaches.md](./topics/discarded-approaches.md) | 废案与取证 |
| [重排前快照](./history/2026-08-31-pre-pi-only-realignment/) | 原详细 handoff/roadmap/questions |
