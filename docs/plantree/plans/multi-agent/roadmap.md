# Historical Roadmap — Claude + Codex Multi-Agent

> **状态**：Superseded。完整施工叙事与数字见 [2026-08-31 快照](./history/2026-08-31-pre-pi-only-realignment/roadmap.md)；当前活动任务只看 [Pi-only roadmap T28–T37](../pi-backend-migration/roadmap.md)。

## 已完成历史里程碑

| 里程碑 | 历史结果 | Pi-only 处理 |
|---|---|---|
| ACP feasibility | 选择 direct Codex app-server，不接 ACP | Historical evidence；不再扩多 Agent |
| Codex runtime/protocol | question、permission、turn normalization、resume、idle sweep | execution path 归 T35 删除；fixtures 可供 T34 import |
| Agent binding/picker | Claude/Codex session binding、model/effort/permission UI | 产品语义归 T35 删除；model UI 由 Pi T25 取代 |
| Login/credentials | D47 managed credentials 与 isolated paths 演进 | durable credential facts 由 unified-credentials/Pi config 保留 |
| Codex packaging | pinned CLI、resources、CI budgets/verification | legacy execution payload 归 T35；packaging lessons 可供 T36/T37 |
| Pi third-backend candidate | 原本仅候选第三 backend | 已被 D14 改判为唯一 conversation runtime |

## 不再活动的事项

- 新增第三个 legacy Agent 或多 Agent 协同；
- 继续升级/扩展 Claude/Codex conversation runtime；
- agent picker/binding 的产品迭代；
- 以 ACP 统一 legacy execution；
- 让 Pi 作为 Claude/Codex 旁边的第三 backend。

## 重新归口

| 历史遗留 | 当前归口 |
|---|---|
| legacy runtime/dependency/UI 删除 | Pi roadmap T28/T35 |
| Claude/Codex history value | T34 read-only import |
| Codex source fixtures/readers | T34 migration-only assets |
| Codex ASR/非对话功能 | T28-c 独立分类 |
| multi-session isolation/crash/idle lessons | T29/T30 WorkerManager tests |
| packaging/resource lessons | T36/T37 |

本文件不再追加实施进度。
