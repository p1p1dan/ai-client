# 决策 205：另一对话在上游重试时不再占住发送位

日期：2026-10-19（北京时间）。**状态：实现完成，自主决定，待用户审批。** 分支 `claude/youthful-colden-64e5e9`，本地提交，未推送。编号已登记在会话组共享笔记的 `decision-number-claims.md`。

## 1 现象

用户 2026-10-19 报告（Windows，1.1.1-test.1）：

- 对话 A（claude-opus-5-5）的回合正在上游重试，时间线显示「N 秒后重试」倒计时。
- 这时在另一个仓库新建对话 B，模型切到 GLM 5.3（DSH），发「你好」。
- B 的时间线一直是空的，输入框上方出现排队条「1 你好」，占位符是「已排队 1 条 —— 可以接着输入…」，消息一直没发出去。

## 2 原因（已复现）

- 输入框对所有对话只有**一个发送位**（`ChatComposer` 的 `sendingSessionId` / `inFlightRef`，T091 注释里叫 GLOBAL latch）。
  - `decideSendAction` 看到发送位被占，就把新消息放进队列（「另一个对话的发送占着发送位」）。
  - `decideQueueRelease` 也要等发送位空出来才放行，排队条上的「立刻发送」此时同样被 `other-send` 挡住。
- A 的 `runSend` 一直占着发送位，要等到 A 的第一个助手块、权限/提问、失败或结束才放手。
- 上游重试时，每一帧 `session.status(running, retry)` 都算活性（F2 的 `classifyTurnLiveness`），会把 300 秒的静默预算重新计时。所以 A 的等待最长能撑到 `SEND_WAIT_LOOP_BOUND_MS`（30 分钟）。这段时间里 B 的消息只能排队，排队也放不出去。
- 跟 Main 侧无关：`WorkerManager` 根本没收到 B 的发送。也跟引擎切换（SDK → DSH）无关：两个对话同一引擎也能复现（下面的挂载测试就是这样）。B 是新对话这一点也不影响：发送位一空，B 的状态是 `idle`，队列照常放行。

证据：新挂载测试 `otherChatRetrySendSlotMount.test.ts`，在真的 `ChatComposer` 里依次走：A 发送 → A 的用户回显 → A 的重试帧 → 切到 B → B 回车。去掉修复后，断言失败为 `expected [ '你好' ] to deeply equal []`，B 的消息留在队列里，与用户看到的一致。

## 3 改法

- 新纯函数 `shouldHandOffRetryingTurn`（`queueRelease.ts`）：引擎**已接下**这一回合（看到用户回显；Continue 时以 `running` 为准，即 `acceptRetry`），并且报了上游重试，就不再等了。
- `sendAndWait` 的等待条件最后加这一条，前面的真结论（进展、失败、权限/提问、新助手消息）优先。命中时返回新的 `WaitResult` 成员 `'retrying'`。
  - 之后按「我们不再等、宿主也没说话」处理：进 `'ceiling'` 分支。有回显，所以走 `'pending'`，交给待回复看守（`armPendingReply`）。轮次头和停止按钮都保留；回合后来失败时，D1 照常把输入还回去。
  - 不写 `lastError`、不解绑、不挂重试按钮，这些仍由 F2 的 `[S-1]`～`[S-7]` 守着。
- 没有回显的重试帧不放手：宿主还可能拒收这一回合，那时输入或排队项要还给用户。
- 顺带：`runSend` 开头清 `pendingReplyRef` 时只清本对话的。以前会把别的对话的看守载荷也清掉，那个对话之后再失败，就还不回输入了。store 的槽位本来就是按对话清的。

## 4 不做的

- 「已接下但上游迟迟不出首字、也没重试」的回合仍按 F2 等满 300 秒静默。要不要「一接下就放开发送位」是另一个更大的取舍（F2 的等待还承担了首字前失败的归类），留作后续。
- 不把发送位拆成每个对话一个。`runSend` 的取消、所有权、看守都是组件级的单槽，拆开动得太大。

## 5 验证

- 根 `pnpm typecheck` 通过。
- `vitest run src/renderer/components/chat src/renderer/stores`：237 个文件、4490 个测试全过，其中包括 `composerStopStatic.test.ts` 对等待条件与 `'ceiling'` 分支的源码守卫。
- 新增：`queueRelease.test.ts` 里 `shouldHandOffRetryingTurn` 的真值表；挂载测试两条（已接下的重试回合放开发送位，B 直接发出、A 的看守还在；没有回显的重试帧照旧占位，B 进队列）。
- 未在开发版或打包版上机复现，只在挂载测试里复现。

## 6 后续：每个对话一份看守（2026-10-19，用户选定）

- 问题：等待回复的看守（`pendingReply`）原来全应用只有一份。A 交出发送位后，B 在同一次故障里也被交出，就把 A 的看守盖掉：A 的「工作中」计时行连同停止按钮消失，A 最后失败时原文也不回输入框。
- 改法：store 的 `pendingReply` 改为按对话的 `pendingReplies`（`selectPendingReply` 取单个），输入框的 `pendingReplyRef` 改为按对话的 Map；结束事件按事件自己的对话找看守。
- 测试：`otherChatRetrySendSlotMount.test.ts` 新增一条（A、B 先后交出，两份看守都在；A 失败只清 A 的，切回 A 时原文回到输入框）；`turnSendStatus.test.ts` 的 `[PR-1]`～`[PR-5]` 改按对话断言。

