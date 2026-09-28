# 决策 094：Stop 改用 DSH 停止按钮的语义：中止当前回合，保留收件箱

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- [决策 090](090-user-rulings-2026-09-28.md) 总原则；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 4c-2；
- `dsh-agent/README.md:110,178`；`dsh-subagent/lib/index.js:855`；`dsh-goal-round-driver/lib/index.js:234`；`dsh-agent-loop/lib/index.js:188,815-821,854-858,887-899`。

## 规则

1. `worker.stop` 改为 `agent.cancel({kind:'user'}, {keepInbox:true})`。现在是 `cancel({kind:'user'})`（`src/dsh-host/bridge/dshSessionRuntime.ts:823-828`），会清空收件箱。
   - DSH 客户端的停止按钮就是这样调的（`dsh-agent/README.md:110`）；
   - DSH 自己处理「用户打断」时也带 `keepInbox`：打断子代理、从界面暂停目标（`dsh-subagent/lib/index.js:855`；`dsh-goal-round-driver/lib/index.js:234`）。
2. 效果：
   - 本回合照常中止，已流出的正文按 DSH 规则落盘（决策 032 第 3 条）；
   - 收件箱里还没被取走的输入留下来，包括插话（决策 093）和后台任务 inject 进来的完成通知，等下一次唤醒时随新回合一起交给模型；
   - Stop 本身不会再开回合：`wakeRequested` 没有置位（`dsh-agent-loop/lib/index.js:854-858,887-899`）。
3. 不变的：Stop 升级阶梯（决策 021）、Main 的 Stop 看门狗，以及会话关闭时收卡（决策 088 第 6 条）。

## 取舍

- **维持现状（清空收件箱）**：
  - 用户补的插话会被悄悄丢掉，DSH 只在日志里记一条取消的 inbox splice；
  - 后台任务的完成通知也会丢，模型不知道任务已经结束。
  - 1.0.x 没有收件箱，插话留在渲染层队列里，Stop 后不会丢。保留收件箱至少不丢消息，比清空更接近用户在 1.0.3 里的体验。
- **代价**：Stop 后，之前补的那句话仍会在下一次发送时送给模型。渲染层要把这类消息标成「待送达」，不能当成已丢弃。
- **与 1.0.3 的差别**：
  - 1.0.3 里 Stop 不冻结渲染层队列，队首的插话在会话空闲后会自动发出，开一个新回合（`src/renderer/components/chat/messageQueue.ts:136-143`）；
  - 按本决策，已经送进引擎、还没被取走的插话不会自动开新回合，要等下一次发送（或用 Enter 排队的消息在 Stop 后自动发出）时一起交给模型；
  - 这是 DSH 停止按钮的原样语义。
- **备选**：Stop 时由 bridge 把收件箱里没取走的插话摘出来（`inbox.remove`），交回渲染层队列，照 1.0.3 在空闲后自动发出。这是为与 1.0.3 一致的自研，没有采用。
- 如果以后要一个「Stop 并作废全部待处理输入」的动作，可以在 Stop 之外另加，不改这个缺省。

## 影响

- **测试**：`src/dsh-host/bridge/__tests__/dshSessionRuntime.test.ts` 里 stop 的 cancel 参数断言。
- **金样本**：`stop-stream`、`stop-tool` 两个场景的收件箱为空，清空时本来就不落事件（`dsh-agent-loop/lib/index.js:188`），预计不变，收口时用 `bridge-record.ts --check` 确认。
- **P1-3**：Stop 看门狗的测试（`dshChannelStopWatchdog.test.ts`）不受影响。
