# Plan — OpenChamber 气泡对话重构

> 分支 `feat/openchamber-chat-refactor`。2026-07-24 双轨合一后单线推进（原 C-xx 主线 + T-xx 团队轨任务池统一由本计划管理）。

## Scope

旧 AgentPanel 终端式聊天 → 四区 Workspace Shell 气泡对话（仅 Claude 进气泡，其他 Agent 暂留终端模式）。里程碑 M1 打包链 ~ M5 收口，见执行计划。

## 文件地图与阅读路径

| 文件 | 角色 |
|---|---|
| [implementation-status.md](./implementation-status.md) | **先读**：当前阶段 / Active TODO / 阻塞 / 最近落地 |
| [roadmap.md](./roadmap.md) | Done / In Progress / Next / Deferred 全量任务状态 |
| [open-questions.md](./open-questions.md) | 未决问题（多数等用户拍板或现场实证） |

## 权威链（冲突时依此序）

1. [ARD](../../../plans/2026-07-23-openchamber-chat-refactor-ard.md) — 架构权威
2. [执行计划](../../../plans/2026-07-23-openchamber-chat-refactor-execution-plan.md) — 任务定义、验收标准、协议变更纪律、**测试凭证（§4）**
3. [总台账](../../../plans/openchamber-chat-refactor-ledger.md) — 已拍板决策 **D1~D17**、里程碑检查点（CP-x）
4. 过程记录档案：[主线台账](../../../plans/ledger-claude-mainline.md)（C-xx）/ [团队台账](../../../plans/ledger-team-track.md)（T-xx，已移交）
5. 本计划三文件 — 当前活动状态唯一视图

专项文档：[session.history 协议](../../../plans/2026-07-24-c06-session-history-protocol-draft.md)（CP4 定稿=T-03 契约）· [T-10 点验清单](../../../plans/t10-packaged-gui-checklist.md) · [Phase 0 报告](../../../plans/phase0-report.md)

## 维护惯例

任务落地 → 台账档案加行（证据+hash）→ 刷新 implementation-status / roadmap；里程碑与 CP 结果回填总台账检查点表。
