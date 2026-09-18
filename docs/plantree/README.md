# Plantree — 规划入口

本 worktree（`feat/runtime-evolution`）只有一个活跃执行计划：[Runtime 加固与收口](plans/runtime-hardening/README.md)。它承接 2026-09-14 只读审计确认的 185 条缺陷、补审与最后一次现场。此前的 runtime-evolution（P0～P6 + GUI）已执行完并收口为参考与证据基线（[决策 001](plans/runtime-hardening/decisions/001-open-hardening-plan-root.md)）。

## 文档职责

- **核心需求与架构**：[Runtime ARD](../plans/2026-09-08-runtime-evolution-ard.md)。维护功能边界、决策、依赖与验收标准；仅需求或决策变化时修改。
- **活跃 roadmap**：[加固任务树 T001～T055](plans/runtime-hardening/roadmap.md)。任务身份、状态、顺序的唯一权威。
- **历史任务树**：[Runtime / GUI 核心任务树](plans/runtime-evolution/README.md)。P0～P6、GUI 子节点的实现/验证状态与证据，2026-09-14 起为历史；审计对其节点状态的异议见[审计证据](plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md)。
- **用户进度看板（implementation status）**：[进度看板](进度看板.md)。只维护当前阶段、最多五项活动任务、最近落地、阻塞和最近验证；通过任务 ID 引用活跃 roadmap。
- **功能与验收参考**：各计划的 topics、GUI 功能清单及现场验收步骤；描述“做什么、怎么验”，不复制实时状态。
- **证据与历史**：evidence、history、Windows-P4-6-evidence；记录指定提交/版本的事实，不滚动更新为当前交接。

决策冲突以 ARD 为准；完成情况按核心任务树所引用的实际证据核对。旧 TODO/implementation-status 路径仅作跳转，不再形成第二套进度。

## 活跃计划

| 计划 | 状态 | 当前阶段 | 任务树 | 用户看板 |
|---|---|---|---|---|
| Runtime 加固与收口 | In Progress | 批次 D4 与批次 G 均已落地；批次 H（T077～T087 + 提级 T053）十项已提交（13 个本地提交，未推送），本地点验进行中，待 Windows 第二轮验证；T085 未开始（阻塞 Q019）、T087 推迟 | [T001～T087](plans/runtime-hardening/roadmap.md) | [当前进度](进度看板.md) |
| Runtime 自主化演进（含 GUI 改进） | 已收口（参考与证据基线） | 代码侧节点全部执行完；现场与修补移交上一行 | [P0～P6 / GUI](plans/runtime-evolution/README.md) | [收口快照](plans/runtime-evolution/history/2026-09-14-进度看板-收口快照.md) |

GUI 原计划根保留为[功能与验收参考](plans/gui-sdk-experience/README.md)，不再作为独立执行状态源。

## 其他入口

[基线](baseline/README.md) · [想法池](ideas/inbox.md) · [加固计划未决问题](plans/runtime-hardening/open-questions.md) · [旧树未决问题](plans/runtime-evolution/open-questions.md)

[测试版迁移](../pi-only-migration.md) · [回退说明](../pi-only-rollout-rollback.md) · [候选说明](../release-notes/unreleased.md)。
这些交付说明不代表全部现场验收或公开发布完成。
