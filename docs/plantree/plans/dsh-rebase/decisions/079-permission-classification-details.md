# 决策 079：权限归类表的几处细节；看不透的执行与未知工具选「本会话允许」时，放行整个工具（请审）

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：P1-6b 实现、[决策 047](047-tool-classification-and-plan-mode.md)。

## 规则

1. 归类：
   - `plugin_manager` 归为「看不透的执行」，auto 档下也问；
   - `ralph`、`structured_output`、`list_subagent_models` 归为内部工具，直接放行；
   - MCP resources 与 web 工具走策略 `'*': 'ask'`。
2. 看不透的执行（`workflow`、`run_code` 等 PTC 程序体、`plugin_manager`）和未知工具：用户选「本会话允许」时，记的是这个工具在本会话内整体放行。它们没有可以按目录或命令前缀收窄的参数，没法像 bash 那样细分。
3. 决策 044 的两个字面值（`sandbox-policy: danger-full-access`、`approval: ask`）在 P1-6 第二部分由我方闸门出卡时一起改。现在就改的话，bridge-smoke 与打包冒烟里靠「沙箱拒绝后越界升级」出卡的审批判定会失败。

## 取舍

- 第 2 条的范围比 bash 的授权宽：用户对一个 `run_code` 选了「本会话允许」，之后本会话里的所有程序体都直接执行。备选是这类工具不提供「本会话允许」，每次都问，更安全但更打扰。**请用户选择。**
