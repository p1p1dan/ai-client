# 决策 029：DSH 下插话保持 v1.0.3 语义：在步边界收尾，不用 DSH 的 `steer`

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-4 方案 §5 D4](../topics/p1-4-bridge-parity.md#5-需要拍板的决策点)、runtime-hardening 决策 046（`turnActive`）。

## 规则

1. Ctrl+Enter 插话：在当前 step 的 `step/end` 上同步调用 `cancel({kind:'hook', reason:'aiclient-interject'}, {keepInbox:true})`。
   - 回合在步边界收尾，插入的消息留在收件箱里，作为下一回合的输入；
   - 映射为 `session.completed {stopCause:'interjected'}`；
   - 落盘的原因能和普通 Stop 区分开。
2. `turnActive` 按 bridge 当前是否持有回合回报。

## 取舍

- 不选 DSH 的 `steer`（消息直接进当前回合的下一步）：语义与 v1.0.3 不同，要改协议和渲染层，属于产品变更。
- 不选「`pre-step` reject → `blocked`」：落盘记录有歧义，还会吞掉已取出的输入。
- 代价：插话会让进行中的 goal 暂停。
- 开工前要先做一个小实验：在 `session/event` 监听里同步 `cancel`，能否赶在下一步取输入之前生效。
