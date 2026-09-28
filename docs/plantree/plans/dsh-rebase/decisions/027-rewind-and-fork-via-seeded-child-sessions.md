# 决策 027：回退与 fork 用种子子会话加桩指针切换；fork 子会话的逻辑 id 由 Main 预铸

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-4 方案 §5 D2、D6](../topics/p1-4-bridge-parity.md#5-需要拍板的决策点)、[决策 006](006-session-identity-stub-file.md) 第 2 条（桩是可变指针）。

## 规则

1. **回退**：
   - 从边界 seq 分叉出种子子会话（`buildForkSeed` 加上带 `seed` 的 `agents.create`，id 为 `aiclient-<逻辑 id>.r<n>`），并 flush 落盘；
   - 原子改写桩的 `dshSessionId`，桩升到 v2，追加 lineage；
   - dispose 旧 handle。
   - 索引行、会话键、桩路径都不变。崩溃窗口的结局都是一致的：要么回退没发生、只多一个孤儿会话，要么已经切到新会话。
2. 边界：
   - 回退到用户消息：取上一回合的最后一个事件，这条消息的文本作为 `editorText` 返回；
   - 回退到助手 step：取该 step 的 `step/end`；
   - fork：取目标节点的最后一个事件。
3. 会话有后台任务在跑时拒绝回退，因为 dispose 旧 agent 会结束它名下的后台任务。
4. **fork**：同一套机制，只是写一个新桩。`WorkerForkPayload` 追加可选字段 `targetLogicalSessionId`；Main 把铸 id 挪到 RPC 之前，子会话 id 为 `aiclient-<新逻辑 id>`。沿用 `.staged` 标记和启动清扫；discard 时删桩，日志按[决策 024](024-gc-only-orphan-empty-sessions.md) 处理。
5. 树对话框里「Pi 会话文件不截断」的文案改成与引擎无关的说法，放在 P1-4b 一起改。

## 取舍

- 不选「回退改成新建逻辑会话」：会话键会变，回退就等于 fork，与现有产品语义不同。
- 不选「DSH 会话不支持回退」：会让 v1.0.x 的功能倒退。
- 代价：
  - 会多出退役日志；
  - 日志清理的引用集合要按 lineage 展开；
  - 回退会让进行中的 goal 暂停或失去武装。
- 开工前要先做一个小实验：带 seed 创建、flush、dispose 之后，同一宿主里能否马上 resume。
