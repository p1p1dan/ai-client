# 决策 062：自定义子代理暂定用一个带「代理名」枚举的委派工具承载，在 P1-7 定稿

日期：2026-09-27。**状态：用户 2026-09-28 裁决：不做，只用 DSH 自带的子代理（见[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-10 / P1-16 方案 §5 D11](../topics/p1-10-p1-16-extensions.md#5-需要拍板的决策点)。

## 规则

1. 新宿主插件 `aiclient-delegates` 读取与 1.0.x 相同的定义（`<agentDir>/subagents/*.md`、`~/.agents/subagents/*.md`，加内置 4 个），注册一个委派工具，参数里带「代理名」枚举；调用时按定义执行 `ctx.subagents.start('spawn', {persona, toolFilter, agentOptions})`。
2. 定义里的 `permission` 按 inherit 处理（[决策 049](049-delegate-declared-tier-inherits.md)）；`maxTurns` 可以选择补上；正文里的 `{{…}}` 要转义。
3. 与 DSH 通用的 `subagent` 工具并存，要写清分工。**P1-7 设计子代理面板时复核工具形态并定稿**，届时本决策可能修订。

## 取舍

- 这与 1.0.x 的 `Task(subagent_type)` 体验一致；工具数量不随定义增多；改定义不用重启宿主。
- 不选「每个定义生成一行 `dsh-tool-subagent`」：每个定义都要占一个工具 schema。
- 不选「放弃，只留 DSH 通用 `subagent`」：自定义代理会全部失效。
- 代价：约 1 人周。
- 开工前做实验 E7：插件调 `ctx.subagents.start` 时，`persona` 与 `toolFilter` 能否生效。

## 补记（2026-09-27）

工具形态由[决策 070](070-delegate-tool-finalized.md)（待审批）定稿为单个 `delegate {agent, description, prompt, run_in_background?}`。
