# Roadmap — Unified Credentials and App State

> **状态：Done**。详细 as-built 记录见 [重排前快照](./history/2026-08-31-pre-pi-only-realignment/roadmap.md)。

## Completed

| Slice | 结果 | Pi-only relevance |
|---|---|---|
| S0′ | 取消整体 Claude/Codex home 重定向，凭据与用户 config tree 解耦 | 原则继续有效：Pi managed config 必须显式隔离，不劫持 local setup |
| S1 | `.aiclient` 字面量收敛 | 支撑统一 app-state layout |
| S2 | 迁移到 `~/.pilab/<profile>/`，vault 并入 app state | 继续作为 product state root |
| S3 | credential mode 改为 Main-owned runtime setting | Pi managed/local 入口继续使用 |
| S4 | vault 增加可选 Pi arm、旧 vault compatibility | Pi login/config 基础 |
| Settings ownership fix | renderer 不覆盖 Main-owned credential/onboarding keys | 全局不变量 |

## Superseded legacy parts

- Claude/Codex execution env/provider injection 会随 Pi roadmap T35 删除。
- “pi 是未来第三 Agent”的表述已被 D14 替代；Pi 是唯一 conversation runtime。
- 旧 next-work 指向 entry-and-environment/multi-agent 已结束，不再作为本计划活动任务。

## Remaining work location

- Pi models/auth/agentDir：Pi T19–T25 与 T31。
- legacy conversation import：T34。
- legacy credential/runtime cleanup：T35。
- branding/appId/profile migration：如仍需要，另立独立 plan。
