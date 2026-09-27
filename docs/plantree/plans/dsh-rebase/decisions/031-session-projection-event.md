# 决策 031：goal、todo、plan、权限等状态用新事件 `session.projection` 传给渲染层

日期：2026-09-26。**状态：自主决定，待用户审批。** 依据：[P1-4 方案 §5 D7](../topics/p1-4-bridge-parity.md#5-需要拍板的决策点)。

## 规则

1. RuntimeEvent 新增 `session.projection {key, view}`，数据来自 DSH 的 `ctx.sessionProjections`：`todos`、`goal`、`plan`、`permissions`、`sandboxMode`、`tokenUsage`、`contextPressure`、`llmRetry` 等。同一个 key 后到的覆盖先到的。
2. 渲染（goal 条、todo 卡等）归 P1-7；P1-4 只负责产出事件。
3. 后台任务和 goal 的通知走 `custom.message`。

## 取舍

- 不选「复用 `custom.entry`」：没有类型，渲染层要自己猜结构。
- 新事件和渲染层在同一个版本发布，没有跨版本兼容问题。
- 代价：事件联合类型多一个成员。
