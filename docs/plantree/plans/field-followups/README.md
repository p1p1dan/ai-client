# Plan — 现场反馈待办 6–11

> **状态**：In Progress —— 批次一（F07 / F11 / F06）与批次二（F08）已实现，自动化门禁通过；
> GUI 点验与真实 HTTP 请求头未验证。剩 F09 / F10。
> **可见进度**：[TODO.md](./TODO.md)。
>
> **范围**：来自现场反馈的六条待办（原文档编号 6–11），覆盖聊天状态行、模型选择显示、
> `@` 弹层定位、Pi 请求头、启动公告与账户周限额四个互不相干的面。
> 它们同批进来是因为同一轮反馈，不是因为共享实现。
>
> **状态权威**：[roadmap.md](./roadmap.md) · **当前进度与欠项**：[implementation-status.md](./implementation-status.md)。
> **需求原文与产品口径**：[`待办任务执行计划.md`](../../../../待办任务执行计划.md)（仓库根，含四条已确认口径）。

## 与其他计划的边界

- [pix/pi-app UI 对齐](../pix-ui-alignment/README.md) 管新壳长什么样；本计划只修其中被现场点名的四处行为，
  不重排界面。GUI 点验并入该计划的累计点验，不单开轮次。
- [设置清单整理与旧壳删除](../settings-cleanup/README.md) 已删旧壳；本计划的所有改动只落在新壳上，
  不复活任何旧壳入口。F09 隐藏顶部“...”菜单属同一方向（减少失效入口），但它是标题栏而非设置页，
  因此留在本计划。
- 架构边界仍以 Pi-only 的 [D14](../pi-backend-migration/decisions/014-pi-only-product-and-conversation-import.md)
  / [D15](../pi-backend-migration/decisions/015-main-owned-worker-manager.md) 为准；
  F08 只增加 provider header，不改 WorkerManager 的进程模型。
- [模型配置页迁入 onboard](../model-catalog-admin/README.md) 已关闭，但它定义的目录契约是 F07 的前提：
  `AgentModelCatalog.source` 的四种取值就是 F07 用来区分「还没答」「答了没有」「请求失败」的依据。

## 已确认产品口径

四条来自用户，写在需求原文的开头，本计划不再重新讨论：

1. 流式回复的 `↓` 是 assistant 已接收的**字符数**，不是 token，也不是金额。
2. 顶部“...”按钮及其 Reload / Developer Tools / GitHub / Exit **全部隐藏**，不迁移到别处。
3. 公告通知在**每次启动 App 时**自动弹出。
4. 周限额的单位是**金额**。

## 两条待确认的外部依赖

F09（公告）和 F10（周限额）都需要 onboard 侧的接口。按需求原文的收尾段，客户端先按约定的数据契约
实现本地链路，再接真实接口。因此这两项的验收分两段：**契约段**（本仓可自证）与**联调段**（需 onboard 部署）。
把联调段写成已完成，是本计划明确禁止的。

## 文件地图

| 内容 | 位置 |
|---|---|
| 任务 ID / 状态 / 顺序（唯一权威） | [roadmap.md](./roadmap.md) |
| 当前 phase / Next / blocker | [implementation-status.md](./implementation-status.md) |
| 执行清单（勾选视图） | [TODO.md](./TODO.md) |
| 逐任务落地证据 | [evidence/](./evidence/) |
| 需求原文 | [`待办任务执行计划.md`](../../../../待办任务执行计划.md) |
