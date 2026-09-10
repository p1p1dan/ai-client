# Plantree — 规划入口

本 worktree（`feat/runtime-evolution`）只有一个活跃执行计划；GUI 改进已经并入该计划，共享安装包与现场验证。

## 文档职责

- **核心需求与架构**：[Runtime ARD](../plans/2026-09-08-runtime-evolution-ard.md)。维护功能边界、决策、依赖与验收标准；仅需求或决策变化时修改。
- **核心任务树（roadmap）**：[Runtime / GUI 任务树](plans/runtime-evolution/README.md)。维护 P0～P6、GUI 子节点的实现/验证状态与证据，是完成状态的唯一权威。
- **用户进度看板（implementation status）**：[进度看板](进度看板.md)。只维护当前阶段、最多五项活动任务、最近落地、阻塞和最近验证；通过节点 ID 引用核心任务树。
- **功能与验收参考**：各计划的 topics、GUI 功能清单及现场验收步骤；描述“做什么、怎么验”，不复制实时状态。
- **证据与历史**：evidence、history、Windows-P4-6-evidence；记录指定提交/版本的事实，不滚动更新为当前交接。

决策冲突以 ARD 为准；完成情况按核心任务树所引用的实际证据核对。旧 TODO/implementation-status 路径仅作跳转，不再形成第二套进度。

## 活跃计划

| 计划 | 状态 | 当前阶段 | 核心任务树 | 用户看板 |
|---|---|---|---|---|
| Runtime 自主化演进（含 GUI 改进） | In Progress | P4-6 收口 | [P0～P6 / GUI](plans/runtime-evolution/README.md) | [当前进度](进度看板.md) |

GUI 原计划根保留为[功能与验收参考](plans/gui-sdk-experience/README.md)，不再作为独立执行状态源。

## 其他入口

[基线](baseline/README.md) · [想法池](ideas/inbox.md) · [问题与决策索引](plans/runtime-evolution/open-questions.md)

[测试版迁移](../pi-only-migration.md) · [回退说明](../pi-only-rollout-rollback.md) · [候选说明](../release-notes/unreleased.md)。
这些交付说明不代表全部现场验收或公开发布完成。
