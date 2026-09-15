# 决策 009：managed 模式下 native runtime 视项目为可信，只有项目 model 相关设置不读

日期：2026-09-15。状态：已采纳（用户拍板，回答 Q009）。

## 背景

`AICLIENT_PI_TRUST_PROJECT_CONFIG` 一个值管了两件事：我方 native runtime 的 `projectTrusted`（门控项目 MCP / skills / 权限策略 / 指令），以及 pi 自己的 `projectTrusted`（TUI 路径，门控项目 `.pi/settings.json` 里的 packages 与 models）。Main 在 managed 模式（公司账号登录、凭据由网关下发）下固定发 `0`，原意是 D-Q9 / D11 决策 4 的「仓库不得放宽权限策略」。T035 按决策 007 / 008 给指令层补上信任门控后，managed 会话不再加载仓库自己的 CLAUDE.md / AGENTS.md。

## 决定

1. managed 模式下 native runtime **视项目为可信**：项目级 MCP（`.pi/mcp.json`、`.pi/mcp.local.json`）、skills、项目权限策略（`.pi/agent/pi-permissions.jsonc` 与 `.local.jsonc`）、项目指令（CLAUDE.md / AGENTS.md / CLAUDE.local.md）都读取。
2. **只有项目里的 model 相关设置不读**。native runtime 本就没有读取项目级 model 设置的路径（目录来自 Main 或 agentDir）；pi 自己的项目 `.pi/settings.json`（packages 与 models）在 TUI 路径继续按 managed 不读。
3. 两个语义拆开：native 的项目来源门控不再从 `AICLIENT_PI_TRUST_PROJECT_CONFIG` 推导；该 env 保留给 pi 自己的语义（TUI）与 PTY 剥凭据。
4. 决策 007「未信任项目不装」与决策 008 第 5 条「未信任项目 project / local 视为关闭」不变；变的是 managed 不再等于未信任。

## 落地时的发现与已知限制（用户知情）

- **`AICLIENT_PI_TRUST_PROJECT_CONFIG` 是我方自起的名字，pi 不读它**（两份 pi 包 grep `AICLIENT` 零命中）。TUI 里的项目信任一直由 pi 自己决定：`--approve` / `--no-approve` → `~/.pi/agent/trust.json` → 全局 `defaultProjectTrust` → 交互弹窗。所以「TUI 在 managed 下不读项目 packages / models」从来没有生效过；本决策的第 2 条对 TUI 只是意图，不是现状。要真正生效只能给 PTY 加 `--no-approve`，代价是 pi 的单一开关会连项目 skills / prompts / extensions / themes / SYSTEM.md 一起挡掉（AGENTS.md / CLAUDE.md 不受 pi 信任门控，照读）。记 Q011（已由 [决策 011](011-managed-tui-company-channel-usable-not-exclusive.md) 结案：不加 `--no-approve`，本决策第 2 条只管 GUI 会话）。
- 该 env 现在唯一起作用的地方是 `PiTuiPty` 用它当「公司账号」标记剥掉继承的网关密钥；保留原样。
- native 侧的实现用常量 `NATIVE_PROJECT_TRUSTED = true`，不新加 env；原「缺失 = 旧 Main 构建」三态约定随之作废（Main 与 worker 在同一发布产物里）。
- 项目可信意味着克隆下来的仓库可以经 `.pi/mcp.json` 起进程、经指令文件影响模型；这与 local 模式既有行为一致，用户接受。

## 影响

- Main 权限策略面板在 managed 路线不再给项目策略打「已忽略」。
- `pi install -l`（项目级包安装）在 managed 下仍不提供，属 pi 项目 packages 语义。
- 落地提交 `HEAD`（见批次 B 落地记录补记）；open-questions 移除 Q009，新增 Q011（后由决策 011 结案）。
