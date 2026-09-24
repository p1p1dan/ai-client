# 决策 043：思考块默认折叠；只有被插话或停止打断的回合默认展开

日期：2026-09-24。来源：`feat/ctrl-enter-interject` 代码审查第 3 条（过程区强制展开收不起来）与第 4 条（点开思考被滚走）；用户拍板「思考块默认折叠」「仅插话 / 停止的回合展开，且可收起」。落地任务 **T120**（`20f172da` + `6e85aff2`）。部分替代[决策 038](038-delegation-thinking-preview-and-completion-fold.md)。

## 背景

- `20f172da` 已把思考块从 038 的「200 字预览 + 行内展开」改成与工具行一致的默认折叠；审查时这与主线的 038 冲突，需要拍板。
- `0a836f27` 为「被中断且无最终回答的回合」加了强制展开，但判据 `processSettled && 没有 finalAnswer 段` 对所有以工具收尾、失败、历史里的回合都成立，并进了 `groupForcedOpen`，而 `turnWorkGroupOpen` 在强制展开时忽略用户点击——过程区收不起来。
- 思考行改用带 150ms 高度动画的面板后，滚动跟随器把动画中间的高度当成新内容，停在底部时点开思考会被滚走。

## 规则

1. **思考块默认折叠**：与工具行一致，点击展开全部内容；不再有 200 字预览与行内按钮。替代 038 规则 2。
2. **默认展开 ≠ 强制展开**：只有被 Ctrl+Enter 插话或用户 Stop 结束的回合（`turnEndedByUser`，读回合最后一条 assistant 的 `stopCause`；旧历史 `stopReason: 'aborted'` 视为 `user_stop`），过程区**默认**展开，用户点击后以用户选择为准。其他已结束回合按 038 规则 3 默认收起。
3. **强制展开只剩一个来源**：有未应答授权（`turnWorkGroupAwaitsUser`）的回合仍强制展开、不可收起，保证授权卡可达。
4. **行面板去掉高度动画**：思考行与工具行瞬间展开 / 收起，展开时通知滚动跟随器，不再被当成新内容。
5. **运行中工具行计时**：运行中的工具行可展开，行尾显示「已耗时 / 超时上限」，每秒刷新只落在运行中那一行。

## 替代关系

- 替代决策 038 规则 2（思考 200 字预览、尾部展开 / 收起按钮）。038 的其余规则（委派两层、外层过程组运行中展开 / 完成后收起、单项完成可折叠、终稿提取）不变。
- 撤回 `0a836f27` 的 `interruptedWithoutAnswer` 强制展开。

## 实现与验证入口

- `src/renderer/components/chat/MessageTimeline.tsx`、`turnProcessFold.ts`、`ToolRows.tsx`（`TOOL_ROW_PANEL_CLASS`、`ToolRowClockContext`）、`toolCard.ts`（`deriveToolGroupRows` 传递计时）、`turnTiming.ts` / `useTurnTiming.ts`、`turnEndCause.ts`（只读使用）。
- 测试：`turnEndOpenInteraction.test.ts`（END-OPEN-1～4）、`timelineToolClock.test.ts`（ROW-CLOCK-1～3，含「已结束回合不重算」计数）、`turnProcessFold.test.ts`（WG-OPEN-5）、`thinkingStreamRender.test.ts`、`toolCard.test.ts`、`messageTimelineWiring.test.ts`。
- 证据：[review-and-loop-incident-2026-09-24](../evidence/review-and-loop-incident-2026-09-24.md)。任务状态以 [roadmap](../roadmap.md) 为准。
