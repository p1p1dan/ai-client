# 决策 070：自定义子代理工具定稿为单个 `delegate {agent, description, prompt, run_in_background?}`（定稿决策 062）

日期：2026-09-27。**状态：待用户确认（用户 2026-09-28 提问，建议改为只用 DSH 自带子代理，见[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-7 方案 §5 U4](../topics/p1-7-renderer.md#5-需要拍板的决策点)、[决策 062](062-custom-subagents-delegate-tool.md)。

## 规则

1. 宿主插件 `aiclient-delegates` 注册一个工具 `delegate`，参数为 `{agent, description, prompt, run_in_background?}`，缺省按后台可续跑处理。
2. 参数与 DSH 的 `subagent` 一致，`send_message` / `interrupt_agent` 通用，泳道统一。
3. 不叫 `Task`，免得与旧会话里的 `Task` 撞名；旧会话里 `Task` 的词条与显示保留。

## 取舍

- 不选「沿用 1.0.x 的 `Task`」：与旧会话撞名，参数形状也不同。
- 不选「每个定义一个工具」：工具 schema 随定义数量膨胀。
- 代价：模型要认一个新名字。
