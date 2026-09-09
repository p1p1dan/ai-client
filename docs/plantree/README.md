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
| [Runtime 自主化演进](plans/runtime-evolution/README.md) | In Progress | P3/P2-4 实现与本机验证完成，准备 P4 集成 | `fb7cb10b` 补修/P2 接线；P3 代码与证据随本次提交归档，见 [242+34 项及往返证据](plans/runtime-evolution/evidence/p3/completion/README.md)；并行载体/D13 状态保留 | P4-1 bootstrap → P4-2 后端开关 → P4-3 RPC 接线；[TODO](plans/runtime-evolution/TODO.md) |

## 当前并行规划

P4 集成由 Claude 实施；P5-2 已按用户要求改为**完整复刻 PI-Desktop subagent 子系统，再在整体基础上优化**。
规划入口：[源码调研](plans/runtime-evolution/topics/p5-2-subagent-research.md) → [D10/D17 契约](plans/runtime-evolution/topics/p5-2-subagent-contracts.md) → [任务/验收](plans/runtime-evolution/topics/p5-2-subagent-tasks.md)。
研究和文档完成不等于 P5 实现完成，现有 P4 状态以看板为准。

## 基线

[`baseline/README.md`](baseline/README.md) — 指向本仓库既有的架构与术语文档，不复制内容。

## 想法池

[`ideas/inbox.md`](ideas/inbox.md) — 未承诺的想法，提升为任务前不进看板。
