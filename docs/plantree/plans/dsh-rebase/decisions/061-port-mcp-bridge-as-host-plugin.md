# 决策 061：把 1.0.x 的 MCP 桥移植成宿主插件 `aiclient-mcp`（不做就会让 MCP 用户全部倒退，请重点审批）

日期：2026-09-27。**状态：用户 2026-09-28 裁决（见[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-10 / P1-16 方案 §5 D7](../topics/p1-10-p1-16-extensions.md#5-需要拍板的决策点)。

## 规则

1. 钉住的 DSH 树里没有 MCP 客户端：只有 `dsh-mcp-resources` 提供的 3 个读资源工具；官方 `dsh-mcp-client` 不在我们的依赖里。
2. 把 1.0.x 的 MCP 实现移植成宿主插件 `aiclient-mcp`：
   - 纯逻辑（配置解析、客户端）搬进 `src/shared/mcp/`，runtime 改成薄封装；
   - 按会话读三层配置（`<agentDir>/mcp.json` → `.pi/mcp.json` → `.pi/mcp.local.json`），经 `ctx.subprocess` 起 stdio 服务器，cwd 为工作区；
   - 在该会话的 scope 里注册 `mcp__<server>__<tool>`，过闸面 `mcp` 与值 `server:tool` 不变；
   - 再把资源注册给 `ctx.mcpResources`，接上 DSH 的资源工具。
3. 行为差异：服务器的环境继承自宿主，而宿主已按[决策 022](022-host-env-inherits-main.md) 剔除了密钥类变量，所以 MCP 服务器不再能继承 `GITHUB_TOKEN` 这类变量，要写进 `mcp.json` 的 `env`。设置页给出提示。

## 取舍

- 不选「白名单官方 `dsh-mcp-client`」：它的配置格式、工具命名、按会话挂载方式都没核实，而且它自己起进程，绕开了 subprocess 服务，不符合 ARD D11 第 4 条。以后可以再评估，记入想法池。
- 不选「放弃并提示」：1.0.x 的 MCP 用户会全部倒退，违反决策 004 的无痛门槛。
- 代价：约 1.5 人周（搬约 1.1k 行、新写约 500 行），此后自己维护。
- 开工前做实验 E4：插件能否把工具注册在单个会话的 scope 里。
- 实验 E5：`ctx.subprocess` 能否承载 MCP 双向流，宿主被杀后子进程是否回收。
