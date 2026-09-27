Role: detail shard

# P1-10 / P1-16 分片 01 · 1.0.x 用户资产清单

上位：[P1-10 / P1-16 方案](../p1-10-p1-16-extensions.md)。回答调研问题 1：每类资产放在哪、什么格式、谁在什么时候读、界面入口在哪、归属是我方自有还是 pi 生态。

约定：行号取 worktree HEAD `d833115f`（`git show d833115f:<路径>`），路径省略前缀 `src/`。本分片只读代码、测试与文档，没有读开发机上的真实用户目录。

## 1 目录布局与归属

- 应用状态根是 `~/.pilab/<profile>`，`<profile>` 取 userData 的末段（`shared/appStateLayout.ts:94-96`；`main/services/appStatePaths.ts:41-44`）。打包态的 userData 目录名钉为 `PiLabAi`（`shared/appStateLayout.ts:48`）。
- 应用自己的 agent 目录 `<agentDir>` = `<状态根>/pi-agent`（`main/services/piModelConfig/index.ts:44-46`；常量在 `shared/piModelConfig.ts:3`）。H/19 之后，托管与本地两种模式都只跑这一个目录（`piModelConfig/index.ts:37-43`）。
- 用户自己的 pi 目录 `~/.pi/agent`（或 `PI_CODING_AGENT_DIR`）只作为「数据迁移」页的复制来源，不再加载（`piModelConfig/index.ts:52-62`）。
- DSH 的 `DSH_HOME` = `<状态根>/dsh-home`（决策 008；`main/services/agent-host/DshHostProcess.ts:28-29,115-122`）。

`<agentDir>` 里的条目与认领任务：

| 条目 | 内容 | 认领 |
|---|---|---|
| `AGENTS.md` | 托管全局指令 | P1-16 |
| `skills/`、`prompts/`、`subagents/`、`mcp.json` | 用户资产 | P1-16 |
| `settings.json` 的 `packages`、`npm/node_modules/` | pi 扩展 | P1-16（与 P1-10 的插件页一起） |
| `pi-permissions.jsonc`、`extensions/pi-permission-system/config.json` | 权限策略（`runtime/README.md:186-187`） | P1-6（经 `AICLIENT_PERMISSION_AGENT_DIR`） |
| `models.json`、`auth.json`、`managed-models-*.json` | 模型目录与凭据（`shared/piModelConfig.ts:4-15`） | P1-5 |
| `sessions/` | pi 会话 | P1-9 |

项目级资产在用户仓库里：`.pi/skills`、`.pi/prompts`、`.pi/mcp.json`、`.pi/mcp.local.json`、各级 `.agents/skills`，以及各级指令文件。1.0.x 对原生 worker 恒定信任项目（`NATIVE_PROJECT_TRUSTED = true`，`shared/piModelConfig.ts:45-67`），只有 unbound 草稿会话和显式 `settingSources` 会关掉项目层。

## 2 指令文件

- **托管全局文件** `<agentDir>/AGENTS.md`：在 globals 列表里排第一，`scope: 'managed'`，不受 `settingSources` 的 user 开关影响（`runtime/bootstrap.ts:485-499`；`runtime/settingSources.ts:10-17`）。内容由用户自己写，或由「数据迁移」页从 `~/.pi/agent/AGENTS.md` 复制过来（`main/services/agentMigration/AgentDirMigrationService.ts:146-153,319-338`）。
- **用户层**：`~/.pilab/AGENTS.md` → `~/.claude/CLAUDE.md` → `~/.codex/AGENTS.md`，取第一个存在的（`runtime/plugins/prompt/projectInstructions.ts:95-117`）。`~/.pilab/AGENTS.md` 刻意不分 profile（`:108-111`）。A 轮测试有一个临时开关能跳过这一层，默认不跳过（`runtime/flags.ts` 的 `SKIP_USER_INSTRUCTIONS_ENV`）。
- **项目链**：
  - 每级目录在 `AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md`、`.claude/CLAUDE.md` 里取第一个存在的（`projectInstructions.ts:72-83`），再追加 `CLAUDE.local.md`（`:85-93`）；
  - 目录从工作区一直往上，到家目录之下为止，家目录本身和文件系统根都不算（`:126-151`）；
  - 整条链共用 32 KiB 预算（`:153-160`）；
  - 工具读进某个子目录时，把该目录的指令文件作为注入消息补进来，每个文件只补一次（`:28-33`；`runtime/plugins/prompt/instructionTracker.ts`）。
- **读取**：经 HostIo 出口，识别 UTF-16 BOM，解不出的写一条占位说明（`runtime/plugins/prompt/instructionSource.ts:16-49`）。加密机上由随包 node 读，拿到的是明文（ARD D11）。
- **子代理**：委派时带上同一条指令链（`runtime/bootstrap.ts:609-615`）。
- **界面**：没有编辑入口。

## 3 skills

- **根**，后面的覆盖前面的同名技能（`runtime/plugins/skills/index.ts:203-237`）：
  1. `<agentDir>/skills`（user，pi 风格：根下散放的 `.md` 也算技能）；
  2. `~/.agents/skills`（user，根下散放的 `.md` 不算）；
  3. `<cwd>/.pi/skills`（project）；
  4. 从仓库根到 cwd 每一级的 `.agents/skills`（project）。
- **格式**（`runtime/plugins/skills/loader.ts`）：
  - 目录里有 `SKILL.md` 就是一个技能，它的子目录是资源；其他目录最多往下走 4 层；散放的 `.md` 只要带 frontmatter 也算技能（`:322-404`）。
  - frontmatter 只读单行标量：`name`、`description`、`disable-model-invocation`（`:144-184`）。缺 `name` 时用目录名或文件名（`:261`）。名字规则 `[\w.-]{1,64}`（`:212-214`）。
  - 上限 200 个，描述 1 KiB（`:96-101`）。
- **使用**：
  - 系统提示词里列出目录；
  - `skill` 工具按名字读正文，读之前过闸（`skills/index.ts:286-330`）；
  - 用户在行首输入 `/skill:<name> 参数` 时展开（`runtime/plugins/skills/expand.ts:83-88`）。
- **刷新**：建图时拍一次快照。`refresh()` 能力写好了，但没有调用方（`skills/index.ts:83-91`）。
- **界面**：「扩展→资源」列出共享目录 `~/.agents/skills` 与应用目录，可以打开文件夹（`renderer/components/settings/PiResourcesSettings.tsx:97-152`；`main/services/piModelConfig/index.ts:336-354`）；斜杠菜单列出 `skill:<name>`（`runtime/worker/nativeWorkerRuntime.ts:694-718`）；能力弹窗显示数量（`renderer/components/workspace-shell/LeftDock.tsx:522-525`）。
- **归属**：格式属 pi 生态（Agent Skills 标准）；加载器是我方重写的，为了让读取走 D11 出口（`loader.ts:1-26`）。

## 4 prompts（提示词模板）

- **根**：`<agentDir>/prompts`（user）、`<cwd>/.pi/prompts`（project）。目录是平的，不递归（`skills/index.ts:239-248`；`runtime/plugins/skills/templates.ts:74-80`）。上限 200 个，每个 64 KiB（`templates.ts:40-42`）。
- **格式**：文件名即命令名；`description` 可选，缺省取正文第一行的前 60 个字符；另有 `argument-hint`（`templates.ts:1-14,54-67`）。
- **使用**：用户在行首输入 `/name 参数`，发送时整条消息换成模板正文，支持 `$1`、`$@`、`$ARGUMENTS`、`${@:N}`、`${@:N:L}`（`expand.ts:22-65`；`nativeWorkerRuntime.ts:438,528-533`）。模板从不进系统提示词（`templates.ts:10-13`）。
- **界面**：「扩展→资源」可以打开 prompts 文件夹；斜杠菜单列出模板（`nativeWorkerRuntime.ts:694-705`）；渲染层菜单另有 4 个窗口内置命令：new、settings、archive、compact（`renderer/components/chat/slashCommands.ts:47-52`）。
- **归属**：格式属 pi 生态，`substituteArgs` 是从 pi 原样移植的（`expand.ts:12-16`）。

## 5 自定义子代理

- **根**：`<agentDir>/subagents/*.md`，兼容根 `~/.agents/subagents/*.md`，同名时先到先得；不扫项目目录，免得仓库一打开就往用户的目录里加代理（`runtime/plugins/subagent/catalog.ts:1-28,78-89`）。另有 4 个内置：explorer、code-reviewer、test-runner、fixer（`shared/subagentBuiltins.ts:33,59,77,95`）。
- **格式**（`shared/subagentDefinition.ts`）：
  - frontmatter：`name`（小写加短横线，最长 40，`:204`）；`description`（必填）；`tools`（Read / Glob / Grep / BrowserPreview / Bash / Edit / Write，缺省只有前三个只读工具，`:115-138`）；`model`（钉 provider/modelId）；`thinkingLevel`；`permission`（inherit / ask / accept-edits / auto，`:55-76`）；`maxTurns`（上限 80）；`idleTimeout` / `maxDuration`（只解析、不生效，`:31-35`）。
  - 正文就是子代理的系统提示词（`:78-101`）。
  - 同时启用最多 16 个，最多管理 64 个（`:183-192`）。
- **使用**：`Task`、`TaskWait`、`TaskList`、`TaskStop` 四个工具（`runtime/plugins/subagent/index.ts:96-107`）；每次顶层 run 都重读目录（`runtime/bootstrap.ts:599-603`）。
- **开关**：委派总开关与停用名单存在共享设置里，不写进 Markdown（`main/services/agent-host/nativeSubagentSettings.ts:1-60`，名单键在 `:28`）。
- **界面**：「扩展→子代理」是完整的管理页：列表、新建、编辑、改名、删除、开关、导入；编辑内置代理等于写一份同名的用户文件（`main/services/agent-host/subagentCatalog.ts:1-35`；`renderer/components/settings/PiSubagentsSettings.tsx:1-22`）。
- **归属**：我方自有，改编自 PI-Desktop（`subagentDefinition.ts:1-8`）。

## 6 MCP

- **配置文件**，后面的覆盖前面的（`runtime/plugins/mcp/config.ts:139-157`）：`<agentDir>/mcp.json`（user）→ `<cwd>/.pi/mcp.json`（project）→ `<cwd>/.pi/mcp.local.json`（local）。
  - 格式是 Claude Desktop、Cursor 通用的 `{"mcpServers": {"<name>": {"command", "args", "env", "disabled"}}}`（`:1-14`）。
  - `disabled: true` 会删掉前面各层的同名服务器（`:236-243`）。
  - 只支持 stdio，写了 `url` 的报「这个桥只讲 stdio」（`:252-260`）。
- **进程**：
  - 每个会话自己起全部服务器，cwd 是会话工作区（`runtime/plugins/mcp/index.ts:201-214`）；
  - 环境是 worker 的完整环境（也就是 Main 的环境）加上条目里的 `env`（`runtime/host/exec.ts:629-645`；`runtime/host/worker.ts:62-64`）；
  - 每个会话的服务器数按内存分档，4 / 6 / 12 个，最多 16 个（`config.ts:38-93`）；
  - 握手 30 s，全部连接 45 s，每次调用 120 s（`mcp/index.ts:55-69`）。
- **协议**：手写的 stdio JSON-RPC 客户端，只做工具，不做资源、提示词、采样（`runtime/plugins/mcp/client.ts:1-25`）。手写的原因是子进程必须走 exec 出口（ARD D11 第 4 条）。
- **工具与过闸**：
  - 工具名 `mcp__<server>__<tool>`（`mcp/index.ts:139-150`）；
  - 每次调用都过闸：策略面 `mcp`，值 `server:tool`，路径取工作区；默认 ask，只在 auto 档下放行（`:20-28,404-417`）；
  - 默认策略只放行发现类调用（[P1-6 分片 01](../p1-6-permissions/01-current-model.md) 第 50 行）。
- **界面**：
  - 没有编辑页，用户手改文件；
  - 能力弹窗列出每个服务器的工具数与失败原因（`renderer/components/workspace-shell/LeftDock.tsx:491-521`）；
  - 策略页有「MCP tool calls」一面（`renderer/components/settings/permissionPolicyView.ts:190-193`）；
  - 工具行把名字显示成 `server · tool`（`renderer/components/chat/piToolNames.ts:72-127`）。
- **归属**：实现是我方自有的；配置格式是生态里的事实标准（pi 本身没有 MCP，`config.ts:8-10`）。

## 7 pi 插件（pi 扩展）

- **装卸**：设置页把包源交给随包 pi CLI 执行 `pi install` / `pi remove`，装进 `<agentDir>/npm/node_modules/`，并写 `<agentDir>/settings.json` 的 `packages`；开关只改 `autoload:false`（`main/services/piPlugins/PiPluginService.ts:1-29,86-127`；`shared/piPlugins.ts:1-22`）。安装要访问 npm registry，实测约 8 s（`main/services/piPlugins/index.ts:1-8`）。
- **谁加载**：只有内置 pi 终端（真正的 pi CLI）加载。P6-5 之后，聊天一律不加载（`piPlugins/index.ts:111-119`；`renderer/components/settings/PiPluginsSettings.tsx:11-17`；`runtime/worker/nativeWorkerRuntime.ts:680-683`）。装卸之后仍会 `invalidateAll`（`piPlugins/index.ts:120-141`）。
- **界面**：「扩展→插件」有安装框、列表、开关、删除；另外说明内置终端用的是哪套权限扩展（`shared/piPlugins.ts:36-50`）。
- **归属**：pi 生态。

## 8 界面入口汇总

- 设置里的「扩展」页 = 插件 + 资源 + 子代理；「数据迁移」页 = 从 `~/.pi/agent` 复制 + CC / Codex 导入（`renderer/components/settings/SettingsContent.tsx:57-81,134-146`）。
- IPC 通道：`piResources:*`、`piSubagents:*`、`agentMigration:*`、`piPlugins:*`（`shared/types/ipc.ts:258-282`）。
- 聊天侧：斜杠菜单（模板、`skill:` 技能、窗口内置命令）；能力弹窗（MCP 服务器、技能数、模板数、子代理数、pi 扩展说明，`LeftDock.tsx:438-540`）；MCP 工具行与审批卡。

## 9 用户会察觉的行为（回归关注点）

1. 在 `<agentDir>/AGENTS.md` 或 `~/.claude/CLAUDE.md` 里写的规则，每个会话都生效。
2. 工作区外层目录里的 `AGENTS.md` / `CLAUDE.md` 也生效，哪怕在 git 仓库根之上；`AGENTS.override.md`、`.claude/CLAUDE.md` 生效。
3. 技能名可以带大写、下划线、点；frontmatter 不写 `name` 也能用；技能可以按分组目录多层存放；`.pi/skills` 生效。
4. `/skill:<name>` 与 `/<模板名> 参数` 只在行首才触发；模板正文替换整条消息，参数按位置替换。
5. 自定义子代理可以钉模型、限定工具、单独降档或升档、限制轮数。
6. MCP 服务器按会话启动，在工作区目录里运行，能继承 shell 环境里的令牌；可以分 user / project / local 三层覆盖、禁用；工具名与策略规则按 `server:tool` 写。
7. 装过的 pi 扩展在内置 pi 终端里生效。
