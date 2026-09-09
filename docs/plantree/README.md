# Plantree — 规划入口

本 worktree（`feat/runtime-evolution`）的唯一规划入口。

## 权威顺序

1. **ARD**（架构与决策的最终口径）：[`docs/plans/2026-09-08-runtime-evolution-ard.md`](../plans/2026-09-08-runtime-evolution-ard.md)
2. **任务看板**（执行顺序与进度）：[`plans/runtime-evolution/README.md`](plans/runtime-evolution/README.md)
3. **未决问题**：[`plans/runtime-evolution/open-questions.md`](plans/runtime-evolution/open-questions.md)

ARD 与看板冲突时以 ARD 为准；看板只记录「做到哪了」，不重复决策论证。

## 活跃计划

| 计划 | 状态 | 当前阶段 | 最近落地 | 下一目标 |
|---|---|---|---|---|
| [Runtime 自主化演进](plans/runtime-evolution/README.md) | In Progress | P4-6 出包中；Linux CI 通过，Windows 退出修复与主线 GUI 合并待新 CI | `76424efa` native 打包补修及 `d7def5c3`～`80294b63` 主线 GUI；[P4-6 交接与 CI 结果](plans/runtime-evolution/evidence/p4-6/README.md) | 手动 CI 出 1.0.0-test.11 → Windows/加密机累计签收；[TODO](plans/runtime-evolution/TODO.md) |
| [Pi SDK GUI 问题与体验](plans/gui-sdk-experience/README.md) | In Progress | A～E 修复已引入；现场验收归 P4-6 同一测试包 | A～E 来源提交见 [状态](plans/gui-sdk-experience/implementation-status.md) | [TODO](plans/gui-sdk-experience/TODO.md) |

## 当前并行规划

P4-5 由 Claude 完成，2026-09-09 已交接 Codex 跟进 P4-6；P5-2 已按用户要求改为**完整复刻 PI-Desktop subagent 子系统，再在整体基础上优化**。
规划入口：[源码调研](plans/runtime-evolution/topics/p5-2-subagent-research.md) → [D10/D17 契约](plans/runtime-evolution/topics/p5-2-subagent-contracts.md) → [任务/验收](plans/runtime-evolution/topics/p5-2-subagent-tasks.md)。
研究和文档完成不等于 P5 实现完成，现有 P4 状态以看板为准。

## 基线

[`baseline/README.md`](baseline/README.md) — 指向本仓库既有的架构与术语文档，不复制内容。

构建必需交付文档：[测试版迁移](../pi-only-migration.md) · [回退说明](../pi-only-rollout-rollback.md) · [候选说明](../release-notes/unreleased.md)。这些文档不代表现场验收或公开发布完成。

## 想法池

[`ideas/inbox.md`](ideas/inbox.md) — 未承诺的想法，提升为任务前不进看板。
