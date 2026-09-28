# 决策 093：Ctrl+Enter 插话改用 DSH 的 `steer`：消息在下一个步边界并入当前回合，回合不结束，目标不暂停（需用户拍板）

日期：2026-09-28。**状态：自主决定，待用户审批（需用户拍板）。** 依据：
- [决策 090](090-user-rulings-2026-09-28.md) 总原则；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 4c-1、§5；
- `dsh-agent/README.md:47,178`；`dsh-agent-loop/lib/index.js:800-814,983-990,1020`；`dsh-subagent/lib/index.js:1264`；`dsh-tool-goal/README.md:57,71-72`；`dsh-goal-round-driver/README.md:53,72`；`dsh-plan-mode/README.md:89`。

修订：取代[决策 029](029-interject-keeps-v103-semantics.md) 第 1 条、[决策 071](071-interject-pauses-goal.md)；P1-7 方案 U5 的 B 成为默认。

## 规则

1. **回合进行中按 Ctrl+Enter**：渲染层不再把消息放进队首、等回合结束再发，而是立即交给 worker。
   - bridge 调 `agent.steer(message)`，来源为 `user`；消息进 DSH 收件箱的 next-step。
   - DSH 在下一个步边界把它并入**当前**回合：步结束时 next-step 不空，回合就继续开下一步；回合正好在收尾，也会接着开下一回合（`dsh-agent-loop/lib/index.js:983-990,1020`），所以消息不会丢。
2. **协议**：
   - `worker.interject` 的载荷加上 `text`、可选的 `attachments`、`attemptId`，IPC `chat:interject` 同步扩展；
   - 带附件的，与普通发送共用 P1-4c2 的入库入口（决策 096、097）。
3. **没有回合时**：bridge 没有持有回合，就回 `{interjected:false, turnActive:false}`，渲染层按普通发送处理。沿用 runtime-hardening 决策 046：worker 是「有没有回合」的权威。
   - 回合由 bridge 以外的来源开出（目标轮、后台任务唤醒）时也算有回合，照样 steer。
4. **回显**：DSH 取走这条消息时会追加 `user/message`，bridge 以它回显 `message.started`（user，带 `attemptId` 与附件元数据）。取走之前，渲染层把气泡标为「待送达」，具体样式随 P1-7 原型定。
5. **结束原因**：新回合不再产生 `stopCause:'interjected'`。
   - 迁移来的 1.0.x 会话，转换器仍写 `aborted{hook:'aiclient-interject'}`（`legacyPiSession/convert/seed.ts:296-300`）；
   - 所以投影规则与 `AICLIENT_INTERJECT_REASON` 保留，旧会话照旧显示「已插话」。
6. **目标**：插话不再暂停目标。DSH 把人的 steer 当作与目标轮并行的输入（`dsh-tool-goal/README.md:57`），自动续跑在人的输入之后让位（`dsh-goal-round-driver/README.md:72`）。
7. **Stop 与待送达的插话**：Stop 时还没被取走的插话，按[决策 094](094-stop-keeps-inbox.md) 留在收件箱里，随下一回合一起送出。
8. **普通发送不变**：回合进行中按 Enter，照旧进渲染层的队列，等回合结束再发。

## 取舍

- **保留决策 029**（在 `step/end` 上同步 `cancel({kind:'hook', reason:'aiclient-interject'}, {keepInbox:true})`）：
  - bridge 约 100 行，渲染层不动，约 1.5 人日，还要先做「同步 cancel 能否赶在下一步取输入之前」的实验。
  - 但这是为对齐 1.0.3 而自研的组合用法：DSH 没有「停在下一个边界」的原语，`cancel` 没有「只停这一步、回合继续」的形式（`dsh-agent/README.md:178`）。
  - 而且 cancel 会让目标停下：取消的是目标轮，目标暂停；取消的回合与目标无关，也会解除续跑（`dsh-goal-round-driver/README.md:53`）。
- **steer 是 DSH 给忙碌 agent 送消息的做法**：子代理完成通知是「空闲 queue、忙碌 steer」（`dsh-subagent/lib/index.js:1264`），`/plan <消息>` 也走 steer。
  - 代价约 3.5 人日：bridge 约 120 行，Main 与协议约 40 行，渲染层 composer 与队列约 200 行，测试约 400 行。
  - 渲染层的改动与 P1-7 碰同一批文件，要排在 P1-7a 开工之前，或者约定文件范围。
- runtime-hardening 决策 041 的「插话即交付、不停后台子代理」在 steer 下自然成立：steer 不取消任何东西。

**用户看得见的不同**：
- 按下后，消息不再排在队列条里等这一回合结束，而是直接成为对话里的一条用户消息，模型从下一步起一边继续一边照顾它；
- 模型原来的计划不会被「掐断」，它可能先把手上这一步做完再回应；时间线里同一回合会出现「助手 → 我的插话 → 助手」；
- 跑目标时补一句，目标照常续跑，不必再点「继续」。

**如果用户不同意**：退回决策 029 / 071，P1-4c1 按原方案做，约 3 人日。

## 影响

- **测试**：
  - bridge：`src/dsh-host/bridge/__tests__/dshSessionRuntime.test.ts` 新增 steer、无回合、合成回合的用例；
  - `src/shared/types/__tests__/workerRpc.test.ts` 的载荷校验；
  - `src/main/services/agent-host/__tests__/WorkerManager.test.ts` 的 interject 路径；
  - 渲染层 `messageQueue.test.ts`、`queueRelease.test.ts`、`composerStopStatic.test.ts`；
  - `turnEndCause.test.ts`、`chatSessionsHistory.test.ts` 里关于 `interjected` 的用例保留，迁移历史仍会出现。
- **金样本**：新增 `steer` 场景（两个工具步，第一个工具执行时插话；空闲时插话回 `turnActive:false`）；已有 9 个场景不变。
- **开工前实验**：
  - 在工具等审批时、在最后一步刚结束时、在 `agent/turn-stopping` 的 await 期间各 steer 一次，确认都在下一个步边界被取走；
  - Stop（决策 094）之后再发送，确认待送达的插话随新回合一起被取走。
- **P1-7**：目标条不再需要「因插话暂停」这个状态；排队条里「插话」类条目的语义随之改变。
