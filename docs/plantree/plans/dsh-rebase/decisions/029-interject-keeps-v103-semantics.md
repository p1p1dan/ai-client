# 决策 029：DSH 下插话保持 v1.0.3 语义：在步边界收尾，不用 DSH 的 `steer`

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-4 方案 §5 D4](../topics/p1-4-bridge-parity.md#5-需要拍板的决策点)、runtime-hardening 决策 046（`turnActive`）。

**修订（2026-09-28，P1-4c1）**：第 1 条被[决策 093](093-interject-via-dsh-steer.md)（用户已批准）取代。Ctrl+Enter 改为 `agent.steer`：bridge 不在 `step/end` 上 cancel，新回合不再产生 `stopCause:'interjected'`；第 2 条的 `turnActive` 口径保留，细化见[决策 111](111-p1-4c1-turn-semantics-choices.md) 第 5 条。开工前的「同步 cancel」实验不再需要，改做了 steer 实验（`evidence/p1-4c1-steer-experiment-2026-09-28.md`）。迁移会话的 `aborted{hook:'aiclient-interject'}` 投影规则保留。

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
