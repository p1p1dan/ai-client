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
| [Runtime 自主化演进](plans/runtime-evolution/README.md) | In Progress | P1 审查补修、P2-1/P2-2 接线及本机验证完成；P1 现场与 P2 后续门禁仍待验收 | `2ae6f209` 压缩配对已提交；本次提交的补修与 P2 接线见 [P2 证据](plans/runtime-evolution/evidence/p2/README.md) | P3-1 存储契约/实现，然后接 P2-4；[当前 TODO](plans/runtime-evolution/TODO.md) |

## 基线

[`baseline/README.md`](baseline/README.md) — 指向本仓库既有的架构与术语文档，不复制内容。

## 想法池

[`ideas/inbox.md`](ideas/inbox.md) — 未承诺的想法，提升为任务前不进看板。
