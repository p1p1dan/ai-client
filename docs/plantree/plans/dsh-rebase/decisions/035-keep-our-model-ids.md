# 决策 035：界面、会话索引与设置继续存我方的 `provider/modelId`，宿主内按索引翻译

日期：2026-09-26。**状态：自主决定，待用户审批。** 依据：[P1-5 方案 §5 D3](../topics/p1-5-models-and-credentials.md#5-需要拍板的决策点)。

## 规则

1. 菜单、会话索引、设置里存的仍是我方的 `provider/modelId`，由 `resolveRoute(plan, modelId, effort, mode)` 在 bridge 内翻译成 DSH 路由与模型。
2. 路由键就是我方 provider id，不加前缀，与原生 pi-ai 的 `provider` 取值一致。模型声明了不同地址或协议时，拆出 `<id>~2` 等路由。

## 取舍

- P1-9 不用迁移任何模型选择。pi-ai 里按 provider 判断的默认值不变。
- 代价：多维护一张索引表。
