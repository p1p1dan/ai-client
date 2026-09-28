# 决策 031：goal、todo、plan、权限等状态用新事件 `session.projection` 传给渲染层

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-4 方案 §5 D7](../topics/p1-4-bridge-parity.md#5-需要拍板的决策点)。

修订注记（2026-09-28）：转发的 key 由[决策 099](099-p1-4d-scope-dsh-data-only.md) 第 11 条收窄为 `todos`、`goal`、`subagentCatalog`（P1-7b 再加 bridge 合成的 `goalActivation`、`jobs`）；P1-4d2 的实现取舍，包括首次快照为什么推迟到第一个事件之前，见[决策 113](113-p1-4d2-commands-and-projection-choices.md)（待审批）。

## 规则

1. RuntimeEvent 新增 `session.projection {key, view}`，数据来自 DSH 的 `ctx.sessionProjections`：`todos`、`goal`、`plan`、`permissions`、`sandboxMode`、`tokenUsage`、`contextPressure`、`llmRetry` 等。同一个 key 后到的覆盖先到的。
2. 渲染（goal 条、todo 卡等）归 P1-7；P1-4 只负责产出事件。
3. 后台任务和 goal 的通知走 `custom.message`。

## 取舍

- 不选「复用 `custom.entry`」：没有类型，渲染层要自己猜结构。
- 新事件和渲染层在同一个版本发布，没有跨版本兼容问题。
- 代价：事件联合类型多一个成员。
