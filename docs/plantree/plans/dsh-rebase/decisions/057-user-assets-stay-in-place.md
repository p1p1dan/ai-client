# 决策 057：pi-agent 目录里的用户资产原地对接，DSH 构建按原路径读，不搬家

日期：2026-09-27。**状态：自主决定，待用户审批。** 依据：[P1-10 / P1-16 方案 §5 D1、D8、D9、D10](../topics/p1-10-p1-16-extensions.md#5-需要拍板的决策点)、[分片 03](../topics/p1-10-p1-16-extensions/03-design.md)。

## 规则

1. 用户资产留在 `<agentDir>`（`~/.pilab/<profile>/pi-agent`）等原位置。DSH 构建按原路径读，不复制，也不改写。回装 1.0.x 后看到的还是同一份。
2. 所有读取都在宿主（随包 node）里做（ARD D11）。`<agentDir>` 随 P1-5 的 `configure` 控制消息下发，P1-6 的 `AICLIENT_PERMISSION_AGENT_DIR` 并到同一处。
3. 逐类做法：
   - **托管全局指令** `<agentDir>/AGENTS.md`：用 overlay 把 DSH `agent-instructions` 行的 `dshHome` 指向 `<agentDir>`。
   - **用户层指令**（`~/.pilab/AGENTS.md` → `~/.claude/CLAUDE.md` → `~/.codex/AGENTS.md` 取第一个）：新增小插件 `aiclient-instructions`。
   - **项目指令链**：用 DSH 原生实现，接受差异（见[决策 064](064-accepted-behavior-differences-extensions.md)）。
   - **skills**：`customSkillDirs` 加上 `<agentDir>/skills`；bridge 把行首的 `/skill:<name>` 改写成 DSH 的 `/<name>`；不合规的技能列进兼容报告提示用户。兼容提供者（读 `.pi/skills` 和多层目录）看报告里的数量再定。
   - **prompts**：模板的加载与展开搬进 `src/shared`，由 bridge 在发送时展开，并在 `commands()` 里列出。
   - **MCP**：见[决策 061](061-port-mcp-bridge-as-host-plugin.md)。
   - **自定义子代理**：见[决策 062](062-custom-subagents-delegate-tool.md)。
   - **pi 扩展**：见[决策 063](063-drop-pi-extensions-with-notice.md)。

## 取舍

- 不选「首启一次性复制进 `DSH_HOME` 的原生位置」：会产生会漂移的副本，回装后两边不一致。
- 不选「两边同步」：复杂，而且没有必要。
- 代价：DSH 的原生位置空着；要把 `<agentDir>` 下发给宿主。
