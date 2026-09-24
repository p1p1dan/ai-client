# 决策 041：插话不等后台子代理，子代理跨运行继续

日期：2026-09-24。来源：`feat/ctrl-enter-interject` 代码审查第 2 条（有后台子代理时插话不生效），用户在「立即交付插话 / 继续等子代理但明确提示」两项中选前者。落地任务 **T118**（`4a964c7d`）。

## 背景

- Ctrl+Enter 插话的原实现（`0a836f27` / `d2938de7`）只在 pi 的 `shouldStopAfterTurn` 里读一次插话标志。当前 prompt 在回合边界停下后，`execute` 仍进入收集后台子代理报告的循环（`collectFinished` 不设期限），等所有子代理跑完再用报告续跑若干轮。
- 结果：父代理派出一个要跑 10 分钟的后台子代理后，用户按 Ctrl+Enter，会话一直是 running，插话排在队首发不出去，而 `interject()` 返回 true，界面也不提示。

## 规则

1. **插话即交付**：插话后本次运行在下一个回合边界结束，不再进入子代理收集循环；如果已经在等，唤醒信号立即打断。会话回到 idle，队列里的插话立即发出。
2. **子代理不被杀**：子代理登记表属于会话而非某次运行。「插话 + 干净结束」时不调用 `drain()`，子代理继续在后台跑（trace 记 `delegates_left_running`）。
3. **报告不丢**：子代理结束后报告留在「未交付」集合，由下一次运行的收集循环或不带 id 的 TaskWait 交给模型（后者见[决策 042](042-delegation-tool-loop-guard.md)）；正在进行的 TaskWait 也会被插话打断并提前返回。
4. **Stop 不变**：用户点 Stop、失败、抛异常、会话关闭时，照旧停掉全部后台子代理。
5. **插话状态在第一个 await 之前建立**：每次运行的插话状态在 `run()` 同步段建立，刚发出就插话不再落空；只清自己那一份的身份语义不变。
6. **两轮之间的界面**：插话结束时不把仍在运行的子代理泳道标成已取消，也不清除子代理挂着的审批卡；空闲期间子代理发来的审批不把会话标成「等待审批」。
7. **结束原因持久化**：插话结束写 `stopCause: 'interjected'`，用户 Stop 写 `user_stop`，都以 pi 原生 `custom` 条目 `aiclient.runStop` 写进会话文件，历史回放折到该运行最后一条 assistant 消息上；该条目不进会话树、不作为系统消息显示。

## 已知限制（接受）

- 插话没有发出去（被用户从队列删掉、发送失败、队列暂停）时，会话显示空闲而子代理仍在跑，报告要等下一次发送才交付。正常情况下空闲只一闪而过。
- 两轮之间发生 Pi TUI 交接触发的 reload、rewind 或改权限时，后台子代理的报告可能丢失或被作废。
- 上一个插话运行留下的子代理，费用算到交付它的那次运行上；会话总费用不变。

## 实现与验证入口

- `src/runtime/plugins/agent-loop/index.ts`（`RunInterjection`、收集循环、finally 清理）、`src/runtime/plugins/subagent/index.ts`（`endRun`、`untakenUsage`、TaskWait 打断）、`src/runtime/bootstrap.ts`（dispose 先 drain）。
- `src/agent-host/piSessionTimeline.ts` / `piSessionTree.ts`、`src/shared/types/sessionHistory.ts`、`src/renderer/stores/chatSessions.ts`、`src/renderer/components/chat/turnEndCause.ts`、`subagentActivityModel.ts`。
- 测试：`src/runtime/__tests__/interject.test.ts`（含「Ctrl+Enter interjection with background delegates」组）、`turnCeiling.test.ts`、`piSessionTree.test.ts`、`piSessionTimeline.test.ts`、`chatSessionsCore.test.ts`、`chatSessionsHistory.test.ts`、`subagentActivityModel.test.ts`、`turnEndCause.test.ts`。
- 证据：[review-and-loop-incident-2026-09-24](../evidence/review-and-loop-incident-2026-09-24.md)。任务状态以 [roadmap](../roadmap.md) 为准。
