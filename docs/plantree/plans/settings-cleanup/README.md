# Plan — 设置清单整理与旧壳删除

> **状态**：In Progress —— 2026-09-07 立项，取证与拍板已完成，尚无任务落地。
>
> **范围**：设置页的**失效项清理**与**分类重排**，以及为此必须先做的**旧壳删除**。
> 与 [pix/pi-app UI 对齐计划](../pix-ui-alignment/README.md) 是两回事：那个管新壳长什么样，
> 这个管「旧壳与它带来的一堆死开关什么时候消失」。
>
> **状态权威**：[roadmap.md](./roadmap.md) · **当前进度与欠项**：[implementation-status.md](./implementation-status.md)。
> **完整取证**：[设置清单审计](../../../plans/2026-09-07-settings-inventory-audit.md)（三轮取证 + 逐项证据行）。
>
> **参考实现**：`~/code/pix` 的 `apps/desktop/src/renderer/components/settings/`。

## 开工时的问题

用户原话：「当前软件的设置页面中有相当多历史残留功能，但实际已经失效」。

取证证实了这个判断，并且找到了**失效的根因不在设置页自己**：

`useOpenChamberShell` 默认为 `true`（`stores/settings/index.ts:202`），
`App.tsx:1434` 按它二选一渲染新壳（`WorkspaceShell`）或旧标签页壳（`MainContent` + 两个侧栏）。
旧壳自 openchamber-chat-refactor T-16 起就是「**回退不是产品**」，
但**为旧壳服务的 13 组设置仍然摆在设置页上**，用户改了什么也不会发生。

另有 5 项是真正的死代码：Agent 通知三项全仓零消费方，`fileTreeAutoReveal` 与增强输入两键
既没有 UI 入口、消费方又只在旧壳。

## 目标

1. 删掉旧壳，让「设置项 = 会生效的东西」重新成立
2. 删掉与旧壳无关的 5 项纯死设置
3. 把删剩下的设置按领域重排成 9 类，不再有 13 段的 General 抽屉
4. **删之前先补齐**旧壳独有的硬能力，中间态不丢功能

## 已拍板边界

来自用户 2026-09-07 三轮问答，完整选项与理由见[审计文档](../../../plans/2026-09-07-settings-inventory-audit.md) §10 / §15 / §18：

1. **连旧壳一起删**，不是「保留旧壳但把设置移走」，也不是「只加标注」。
2. **Agent 通知先删**；按 pix 重做一个真能用的通知设置**另立任务**。
3. **弃掉仓库分组**（`group/` 五个组件 + `hideGroups`），承认新壳的扁平仓库树是最终形态。
4. **G5–G9 全弃**：跨仓运行中项目弹层、在外部应用中打开菜单、快速终端浮窗、
   临时会话右键菜单、设置浮窗切换，连同各自的设置项。
5. **必须补齐**：全局搜索（新壳无入口）、仓库设置入口（否则初始化脚本「照跑但改不了」）、
   分支切换（纯移植，成本低）。
6. **git stash 另立任务**：后端 stash 只服务 merge 内部流程、`preload` 零暴露、
   前端无可复用 UI——是新建链路而非移植。
7. **不引入 pix 的 usage / archived 两段**（我们已在别处展示，设置页再开一段是权威分裂）；
   `behavior` / `environment` 记入 [ideas inbox](../../ideas/inbox.md)。

## 顺序纪律

**补齐线必须先于删除线合入。** 三条补齐（S01/S02/S03）任何一条没落地就删旧壳，
中间态会真丢能力——全局搜索没有替代入口，初始化脚本会变成不可配置。
唯一例外是 S04（删纯死设置），它与旧壳无关，可以随时先走。

## 文件地图

| 内容 | 位置 |
|---|---|
| 任务 ID / 状态 / 顺序（唯一权威） | [roadmap.md](./roadmap.md) |
| 当前 phase / Next / blocker | [implementation-status.md](./implementation-status.md) |
| 三轮取证全文（逐项证据行、闭包对比、pix 对照） | [审计文档](../../../plans/2026-09-07-settings-inventory-audit.md) |
| 逐任务落地证据 | [evidence/](./evidence/) |
