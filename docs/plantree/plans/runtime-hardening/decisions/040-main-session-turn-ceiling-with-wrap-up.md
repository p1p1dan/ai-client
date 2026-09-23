# 决策 040：主会话恢复轮次上限（500 轮），触顶改为「收尾后暂停」

日期：2026-09-23。来源：决策 039 复审后用户拍板「加个上限，但要能安全停止」；旧 64 轮上限的现场问题是触顶时没有有效提示、输出被打断、页面上看不到最终输出。部分替代决策 039。

## 背景

- 决策 039 去掉了 64 轮上限，理由写的是「PI-Desktop 主会话靠 300s 空闲 + 6h 时长看门狗兜底」。复审取证推翻了这一点：那两个看门狗只挂在 PI-Desktop 的**子代理**上，并且已被其 D328 撤除（`packages/agent-runtime/src/subagent.ts` 中 `startWatchdogs()` 为空函数）；PI-Desktop 主会话、pi 本体都没有任何上限。本仓在 039 之后同样没有任何会中止主会话回合的机制——F2 的 Host 看门狗只提示不中止，`WorkerManager` 的空闲回收只收没有活动请求的槽位。无人值守时模型陷入循环，唯一出口是用户手动 Stop。
- 旧 64 轮上限的两个现场问题，根因都在机制本身：
  1. **没有最终输出**：`shouldStopAfterTurn` 在第 64 轮（一个 `toolUse` 轮）工具执行完后直接退出，模型再无机会说话，页面停在一排工具行上。
  2. **提示无效**：触顶走 `session.failed` + `turn_limit`，渲染为红色失败卡片；专用标题直到 2026-09-21（58341983）才加，此前只有「Session failed」加英文原句。即便现在，它也把一次暂停说成了失败。

## 规则

1. **上限**：多轮会话（`singleTurn: false`）每次用户发送最多 500 个 assistant 轮（`DEFAULT_TURN_CEILING`，`AgentLoopConfig.turnCeiling`，唯一出处）。子代理回报触发的续跑计入同一计数。`singleTurn` 探针不变：答完一轮即停。
2. **触顶即停在回合边界**：达到上限的那一轮正常完成（工具已执行、结果已落盘），然后停止向模型发请求。
3. **等待子代理**：触顶时仍在运行的子代理**不停止**，等它们全部回报；这些回报不再各自换取父模型的新一轮，而是暂存。
4. **一轮收尾**：随后发一条带内部标记（`turn-ceiling`，不画用户气泡、不被当作最新用户任务）的消息，前面附上暂存的子代理回报，最后一句是指令：已达上限，不要调用工具，用用户的语言总结已完成、现状、剩余步骤，用户回复「继续」即可接着做。
5. **收尾轮禁用工具但不撤定义**：历史里有 tool_use 块而不声明 tools 的请求在 Anthropic 上是 400，所以工具定义保留，改由 `beforeToolCall` 拦截收尾轮里的任何调用（`block` + `terminate`），不执行、不回模型；收尾轮结束后必停。
6. **结局是完成，不是失败**：run 成功，`RuntimeRunResult.stopCause = 'turn_limit'`，经 projector 以可选字段挂在 `session.completed.payload.stopCause` 上（沿用 `SessionLivenessNote` 的可选字段兼容先例，不新增事件类型）。收尾轮若自身失败或被停止，按那个结局上报，不带 `stopCause`。
7. **渲染**：store 在 session 记录上保存 `stopCause`，下一次运行开始（或失败、停止）即清除；时间线在 idle 时于该回合下方显示中性提示条 `TurnCeilingNotice`（`Alert` default 变体，非红卡），带「继续」按钮。「继续」发送一句 `t('Continue')`（中文界面即「继续」）——**不是**重发原始提示词：重发会让整个任务从头再来。为此 `continueIntent` 扩为 `resend | carry-on` 两种意图。上限数字不写进渲染层文案，只归 runtime 管。
8. **旧卡片保留**：`sessionFailure.ts` 的 `turn_limit` 红卡条目只供旧 64 轮上限时期录下的会话重放。
9. 子代理 `maxTurns` 机制不变（默认 60/50/40/80，上限 80，触顶报 `truncated`），不新增子代理看门狗。

## 替代关系

- 替代决策 039 规则 1（「多轮会话不再设轮次上限」）；039 规则 2–5 不变。
- 039 背景中「PI-Desktop 主会话……靠 300s 空闲 + 6h 时长看门狗兜底」一句不成立，已在 039 中加注更正。

## 实现与验证入口

- `src/runtime/plugins/agent-loop/index.ts`：`turnCeiling`、`shouldStopAfterTurn` 计数、`beforeToolCall` 拦截、回报暂存与收尾轮。
- `src/shared/internalMessage.ts`（`turn-ceiling`）、`src/shared/types/runtimeEvents.ts`（`stopCause`）、`src/runtime/contracts.ts`、`src/runtime/events/projector.ts`。
- `src/renderer/stores/chatSessions.ts`、`src/renderer/stores/continueIntent.ts`、`src/renderer/components/chat/{TurnCeilingNotice,MessageTimeline,ChatComposer}.tsx`、`src/shared/i18n.ts`。
- 测试：`src/runtime/__tests__/turnCeiling.test.ts`（未触顶不变 / 触顶收尾 / 收尾轮拒绝工具 / 等待子代理回报）、`src/renderer/components/chat/__tests__/turnCeilingNotice.test.ts`（store 写入与清除 / 时间线提示条 / carry-on 意图）、`agentLoop.test.ts` 的 singleTurn 用例。关键分支均做过反向变异验证。
