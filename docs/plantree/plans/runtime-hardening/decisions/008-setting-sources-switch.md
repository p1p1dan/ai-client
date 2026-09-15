# 决策 008：引入 `settingSources` 三值开关，管全部分层来源，并定义 local 层

日期：2026-09-14。状态：已采纳（用户拍板，修订决策 007 的「不做 settingSources」）。

## 决定

1. 运行时接受 `settingSources?: ('user' | 'project' | 'local')[]`；省略即三者全开，与 Claude Code CLI / Agent SDK 一致。
2. 开关管**全部分层来源**，不只指令文件：
   - `user`：`~/.claude/CLAUDE.md`（经 `prompt.globals`）、全局权限策略、用户 `mcp.json`、用户 skills / prompts。
   - `project`：项目 CLAUDE.md / AGENTS.md（根、父目录、子目录按需）、项目权限策略、项目 `mcp.json`、项目 skills / prompts。
   - `local`：新定义的本地不入库变体：权限 `.pi/agent/pi-permissions.local.jsonc`、MCP `.pi/mcp.local.json`、指令 `CLAUDE.local.md`（cwd 与每个父目录）。
3. 随包 fail-closed 权限策略无论开关如何始终加载。~~优先级最高~~（决策 010 收窄：仍是最底层默认，不压顶。）
4. 合并优先级从高到低：~~托管（随包）>~~ 编程选项（run / bootstrap 请求里显式给的）> local > project > user > 随包默认（决策 010）。
5. 未信任项目：`project` 与 `local` 视为关闭。managed 模式不等于未信任（决策 009）。

## 理由

- 用户要求与官方 `settingSources` 语义对齐，而不是只做指令文件；runtime 已有 user / project 两层，缺的是总开关与 local 层。
- local 层现在就定义，避免「合法取值但不对应任何文件」的半成品。

## 影响

- 决策 007 第 3 条「暂不做 settingSources、CLAUDE.local.md」作废；rules 目录仍不做。
- T035 范围扩大为「指令分级加载 + settingSources 开关 + local 层」，见 roadmap。
- 现有 `mergePermissionScopes`、MCP 项目覆盖用户同名（T018）、skills 近者优先（决策 004）的合并规则需与第 4 条对齐并补用例。
