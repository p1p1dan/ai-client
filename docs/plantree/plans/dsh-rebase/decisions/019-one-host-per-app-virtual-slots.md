# 决策 019：每个应用实例一个 DSH 宿主，会话以虚拟 slot 复用一条 IPC

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-3 方案 §4 D1、D2](../topics/p1-3-shared-host.md#4-需要拍板的决策点)、[决策 002](002-defer-encrypted-machine-and-shared-host.md) 第 3 条。

## 规则

1. 每个应用实例一个宿主，也就是每个 profile 的 `DSH_HOME` 一个。单实例锁加上按 profile 分开的 userData，保证不会有第二个实例共用它。不分片，不开第二个宿主。
2. Main 新增 `DshHostSupervisor`，管这一个宿主进程。
   - 每个会话仍是一个 `WorkerSlot`，transport 换成 `DshChannelTransport`：按通道寻址，所有会话复用同一条 Node IPC。
   - 通道 id 由 supervisor 为每个 slot 单独铸造，不复用。只有 `worker.bootstrap` 能建通道。
3. WorkerManager 的会话状态机原样保留：generation、身份提交、T144 语义、排空窗口都不动。改动集中在宿主级策略。
4. 容量：默认 10 个会话，内存 ≤ 4 GiB 的机器 6 个。
5. 宿主侧：P0-6 的 `shared-bridge.js` 转正为唯一的 bridge，测量操作移出产品。另加宿主控制消息：ready 握手、ping / pong、关通道、关停。

## 取舍

- 不选「每个会话一个宿主」：违反决策 002，而且 DSH 不支持多个宿主共用一个 home。
- 不选「WorkerManager 直接管宿主、去掉 WorkerSlot」：约 3600 行的 WorkerManager 测试无法复用。
- 代价：
  - 进程语义变成间接的：旧通道没确认关闭时，只能升级为重启宿主。
  - 一个会话出问题会牵连全部会话，由[决策 020](020-host-fault-handling-and-budgets.md) 兜底。
