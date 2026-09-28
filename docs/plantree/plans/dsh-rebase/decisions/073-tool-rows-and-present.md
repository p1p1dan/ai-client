# 决策 073：工具行：插件行优先用 `presentCall` 的标题与类别，shell 行显示命令摘要；`present` 与计划审阅 P1 不做

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-7 方案 §5 D8～D10](../topics/p1-7-renderer.md#5-需要拍板的决策点)、[分片 04](../topics/p1-7-renderer/04-tool-rows-windows.md)。

## 规则

1. 插件工具与未知工具的行：优先用 `presentCall` 给出的标题与类别；兜底动词从「终端」改成「工具」。标题是插件自己的英文，不翻译。
2. shell 行（bash、pwsh）显示命令摘要，延续 09-22 的用户裁定；模型写的 `description` 放在展开体里。
3. 修掉三处错位：
   - 小写的 `read` / `edit` / `write` 摘要要读 `file_path`；
   - `pwsh` 加进终端类集合；
   - 插件工具行不再以「终端」开头。
4. `present` 交付卡与 DSH plan 模式的计划审阅，P1 都不做：dsh-base 不挂 `present`，决策 047 也不接 DSH plan 模式。办公插件试点时再议。

## 取舍

- 代价：行上看不到模型的意图说明；待办 D8 只落地一半。
