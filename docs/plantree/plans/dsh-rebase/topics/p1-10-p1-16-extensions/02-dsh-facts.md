Role: detail shard

# P1-10 / P1-16 分片 02 · DSH 侧事实

上位：[P1-10 / P1-16 方案](../p1-10-p1-16-extensions.md)。回答调研问题 2 的事实部分，以及插件安装、离线、预装相关的源码事实。

约定：`<包>/…` 指 `src/dsh-host/node_modules/@deepseek-ai/<包>/…`，版本 `0.1.7-rc.2`，以已装源码为准。`host.ts` 行号取 HEAD `d833115f`。标「推断」的没有运行验证。

## 1 plugin-manager：安装、启用、卸载与落点

- **服务**：`ctx.pluginManager`，依赖 `loader` 与 `profileContext`（`dsh-plugin-manager/lib/index.js:1352,1380`）。dsh-base 里这一行只要有 `profileContext` 就启用；给模型用的 `tool-plugin-manager` 行字面关闭（`dsh-base/cordis.patch.yml:16-22`）。我方宿主提供了 `profileContext`（`host.ts:106-127,210`），所以服务是活的。
- **远程方法**：`listPlugins`、`listBundles`、`registries`、`inspect`、`setPluginEnabled`、`setBundleEnabled`、`installBundle`、`waitForInstall`、`cancelInstall`、`removeBundle`、版本豁免两个（`lib/index.js:1186-1212`）。
- **安装**：
  - 每次都跑 `pnpm add <spec> --registry=<url>`，在 profile 目录里执行，按 registry 计划逐个重试，默认回落到 npmmirror（`lib/index.js:1750-1753`；`README.md:50,79`）。没有 `--offline` 之类的离线参数。
  - 规格支持 registry 名、绝对路径、本地或远程 tarball、git 地址（`dsh-plugin-manager/lib/types/install-spec.js:57-85`）。路径规格在装之前读它自己的 `package.json` 做兼容检查（`lib/index.js:306-330`；`README.md:46,63`）。
  - 装完校验是 bundle，再把包名加进 profile 清单的 `dsh.profile.bundles`（`lib/index.js:1778-1800`）。
  - 失败或取消时恢复 `package.json` 与 `pnpm-lock.yaml`，但下载的文件可能留在 `node_modules` 或 pnpm store（`README.md:133`）。
  - pnpm 11 拦下依赖的构建脚本时，可以按包名在 profile 里批准，批准一直有效（`README.md:58`）。
- **落点**（P0-2 实测）：包装进 `$DSH_HOME/profiles/aiclient/node_modules`；日志在 `.plugin-manager/logs/`；pnpm 会写 `~/.cache/pnpm`、`~/.local/share/pnpm/store`（Windows 为 `%LOCALAPPDATA%\pnpm`），访问 registry，还会自己检查 pnpm 新版本；因为我们关了 hmr，装完要重启宿主才生效（[P0-2 证据](../../evidence/p0-2-goal-and-plugins-2026-09-25.md)第 178～186、264 行）。
- **pnpm 从哪来**：launcher 提供的 `packageManager` 优先，否则用配置 `pnpmCommand`，默认是 PATH 上的 `pnpm`（`README.md:10,75`；`lib/index.js:1354,1530`）。`host.ts` 只在设了 `AICLIENT_DSH_PNPM_CLI` 时才指向随包的那份（`host.ts:116-126`）。
- **启用与停用**：
  - `setBundleEnabled` 只改 profile 清单的 bundles 列表，追加在末尾（`README.md:40`；`lib/index.js:1979-2005`）；
  - `setPluginEnabled` 在 profile 的 `cordis.patch.yml` 里改或追加一条 `disabled` 覆盖（`README.md:40`）；
  - 管理自身相关的模块受保护，不能被关掉（`lib/index.js:1077-1094`）。
- **安装范围的 bundle**：`listBundles` 把宿主 `package.json` 的依赖也列出来，并且不可删除（`lib/index.js:1456-1471`）。DSH 官方随安装包分发、默认关着的可选 bundle 走的就是这条路（`OPTIONAL_BUNDLES`，`dsh-app-boot/lib/index.js:544-556`）。

## 2 profile、bundle 与解析锚点（`dsh-app-boot/lib/index.js`）

- profile 目录是 `$DSH_HOME/profiles/<name>`，用户补丁文件是其中的 `cordis.patch.yml`（`:485-487,524-528`）。
- `initProfile` 只在文件不存在时写清单、空补丁，以及 `pnpm-workspace.yaml`（`nodeLinker: hoisted`、`autoInstallPeers: false`）（`:562-591`）。此后 bundles 以清单为准，`host.ts` 里的 `BUNDLES` 只起播种作用（`host.ts:34-35,92-94`）。
- **解析 bundle 先找安装锚点，再找 profile**（`:881-906`）。所以同名包以安装目录里的为准，profile 里的副本顶替不了。
- **安装范围的包**从宿主 `package.json` 的依赖闭包收集（`:680-728`）；profile 范围另算（`:815-825`）。我方 `@aiclient/dsh-app` 就是以 `file:` 依赖进安装范围的（`src/dsh-host/package.json:12`）。
- `loadProfileDirectory` 逐个解析清单里的 bundle，读不到或 peer 不兼容就放进 `skippedBundles`，不改清单（`:919-944`）。HEAD 的 `host.ts:95-98` 一旦有跳过就拒绝启动；P1-3a 计划改成产品 bundle 跳过才报错、插件 bundle 跳过只告警（决策 025 第 5 条）。
- **组合层次**，后面的覆盖前面的（`:1022-1033`）：
  1. 各 bundle 的补丁；
  2. profile 用户层 `profiles/<name>/cordis.patch.yml`，传 `userLayer: false` 就不读（`:946,1026`）；
  3. home 层 `$DSH_HOME/cordis.patch.yml`；
  4. launcher 的 overlays；
  5. 遥测补丁。
- 补丁对同一 id 整体替换 `config`，不做深合并（`dsh-base/cordis.patch.yml:6-10`）。

## 3 兼容规则

- 只检查名字是 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的 peer，用 `includePrerelease` 匹配运行时版本（`dsh-app-boot/lib/index.js:286-318`）。不兼容时可以在 profile 的 `compatibility.json` 里按「包名@版本 × DSH 版本」精确豁免（`dsh-plugin-manager/README.md:65`）。
- 插件自带的 `dsh.compatibility.dshReleases` 不参与判断（P0-2 证据第 108 行）。
- P0-2 的筛选：下载量前 150 的社区插件里，121 个带界面，12 个不是 bundle，9 个被 peer 规则拒绝，纯宿主、是 bundle 且兼容的只有 14 个；目录里的能力标签不可全信，例如 `dsh-office-tools` 标的是 `fs-read`，实际会写文件（P0-2 证据第 80～102 行；数据见同名 `.data.json` 的 `communityPluginSelection`）。

## 4 指令文件：`agent-instructions`

- dsh-base 挂载时只配了 `maxBytes: 65536`（`dsh-base/cordis.patch.yml:288-291`）。
- **用户全局**：只有一个文件 `$DSH_HOME/AGENTS.md`，目录可以用 `dshHome` 配置，文件名固定为 `AGENTS.md`（`dsh-agent-instructions/lib/index.js:141,552-575`；`README.md:59-66`）。
- **项目链**：
  - 从最近的 `.git` 祖先到 cwd，从宽到窄；找不到 `.git` 就只看 cwd（`lib/index.js:480-488,576-578`）；
  - 每级把 `AGENTS.md`、`CLAUDE.md` 都读进来，内容去掉首尾空白后相同的才只算一份，再加上 `AGENTS.local.md`、`CLAUDE.local.md`（`lib/index.js:16-18`；`README.md:36,217`）；
  - 候选名不许带路径分隔符，所以 `.claude/CLAUDE.md` 配不进去（`lib/index.js:75-77`）；
  - 不认 `.claude/rules/` 与 `@path` 导入（`README.md:216`）。
- **注入方式**：首个请求前插一条 durable 的 user 消息作为基线；之后 `read` / `write` / `edit` 碰到更深的目录时追加；超预算时先丢较宽的文件（`README.md:12,32,72`）。
- 符号链接会被跟随，仓库可以借此把仓库外的内容作为低权威指引带进来（`README.md:218`）。

## 5 技能：`skill` / `skill-filesystem` / `tool-skill`

- dsh-base 挂了 `skill`、`skill-filesystem`、`tool-skill`，`skill-badge` 关着（`dsh-base/cordis.patch.yml:293-304`）。
- **根与优先级**（`dsh-skill-filesystem/README.md:44-56`；`lib/index.js:150-189`）：rank 越小越优先，先到先得（`dsh-skill/README.md:84,141`）。
  - 100：`<projectRoot>/.dsh/skills`；
  - 200：`<projectRoot>/.agents/skills`，只在项目根这一级；
  - 300：`customSkillDirs`，绝对路径，宿主级配置（`lib/index.js:79`）；
  - 400：`$DSH_HOME/skills`；
  - 500：`~/.agents/skills`（或 `$DSH_AGENTS_HOME`）；
  - 600：可选的随包目录。
- **格式**：
  - 只认 `<name>/SKILL.md` 或根下平放的 `<name>.md`，不找更深的 `SKILL.md`（`README.md:36`）；
  - frontmatter 用真正的 YAML 解析，`name`、`description` 必填，缺了整条丢弃（`lib/index.js:664-700`）；
  - 名字必须是小写短横线 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（`dsh-skill/lib/index.js:17`），注册表对不合规的名字直接报错（`dsh-skill/README.md:66`）；
  - 另支持 `user-invocable`、`whenToUse`、`metadata`。
- **热更新**：用文件监视器，新增、改名、删除技能不用重启（`dsh-skill-filesystem/README.md:79-81`）。
- **调用**：模型经 `skill` 工具读正文；用户消息里任何位置出现以空白分隔的 `/name`，只要它是用户可调的技能，就注入技能内容（`dsh-tool-skill/README.md:12,54,88`）。

## 6 命令与提示词模板

- `ctx.commands` 的命令由插件注册，名字小写；执行时不产生模型消息，只写 `command/run` / `command/done`（`dsh-commands/README.md:32,46,89`）。命令行必须以 `/` 开头；在交互式适配器里，未知命令会被拒绝，不会变成提示词（`README.md:50`）。P1-4 计划让未知的 `/xxx` 照常作为提示词发出（[P1-4 分片 04](../p1-4-bridge-parity/04-turn-semantics.md) 第 117 行）。
- dsh-base 里的命令：`/compact`、`/goal`、`/plan` 等（`dsh-base/cordis.patch.yml:306-346`）。决策 047 要把 `/plan`、`/permission` 从列表里藏起来。
- **DSH 没有「提示词模板」**这种东西：已装的包里没有哪个把 `/name` 展开成用户消息。

## 7 子代理

- dsh-base 挂了 `subagent`、spawn 与 fork 两个进程内后端、`subagent`（continuable）与 `subagent_fork` 两个工具、控制工具与 `list_agents`（`dsh-base/cordis.patch.yml:348-387`）。
- `dsh-tool-subagent` 每行一个工具，可以配 `persona`、`toolFilter`、`agentOptions`（provider / model / 档位 / maxTokens）、`maxDepth`（`dsh-tool-subagent/README.md:28,43-53`）。
- `ctx.subagents.start(name, request)` 的请求本身就能带 `agentOptions`、`maxDepth`、`toolFilter`、`persona`；persona 按 `{{…}}` 严格插值（`dsh-subagent/lib/types/types.d.ts:136-192`；`index.d.ts:300`）。fresh 子代理看不到父会话内容，只继承 cwd、谱系与模型（`dsh-subagent-spawn-in-process/README.md:109`）。
- **没有 Markdown 代理定义**：dsh-base 不带代理预设，钉住的树里也没有 `agent-preset` 类的包；委派定义的 `permission` 字段在 DSH 下按 inherit 处理（决策 049）。

## 8 MCP

- dsh-base 只挂了 `mcp-resources`（`dsh-base/cordis.patch.yml:491-492`），它提供三个共享工具 `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`，必须有某个 MCP 连接插件注册了服务器才会出现（`dsh-mcp-resources/README.md:28-35`）。
- 连接插件要另配（「Configure only MCP client entries」，`dsh-base/README.md:62`）。官方客户端 `@deepseek-ai/dsh-mcp-client@0.1.7-rc.2` 只以 devDependency 出现（`dsh-spill-policy/package.json:64`），**不在钉住的树里**。它的配置格式、工具命名、是否按会话挂载、stdio 与 cwd 怎么处理，本地都查不到。
- 资源提供者是一个很小的接口：任何插件都能 `ctx.mcpResources.register(server, provider)`，按调用方 agent 的 scope 可见（`dsh-mcp-resources/lib/index.js:109-176`）。
- MCP 服务器的工具按服务器给的 schema 注册进工具注册表（`dsh-tools/README.md:138`），所以同样经过 `tools/pre-execute`。
- 起进程：按 `dsh-subprocess` 的说明，MCP 传输自己起进程，绕开 subprocess 服务，只借用它的环境清洗函数（`dsh-subprocess/README.md:84,150`）。HTTP 类 MCP 走全局 `fetch` 代理（`dsh-http-proxy/README.md:12,32`）。
- `ctx.subprocess.spawn` 的 `stdio: 'pipe'` 会交出原始流，供调用方自己分帧，例如 LSP 的 JSON-RPC、ACP 的 ndjson（`dsh-subprocess/README.md:57`）。Windows 上 subprocess-local 的 runner 就是随包 node 加 `runner.js`，并把目标进程挂进 Job（P0-2 证据第 239～241 行）。

## 9 同进程暴露面

- plugin-manager 自己的说明写得很直白：装进来的宿主代码在进程内运行，不在工作区沙箱里（`dsh-plugin-manager/README.md:31`）。
- **凭据**：`llm-pi-ai` 每次请求都调 `ctx.credentials.resolve`（[P1-5 分片 02](../p1-5-models-and-credentials/02-dsh-facts.md) 第 29 行）。P1-5 已把「同进程插件也能调它」列为风险（[P1-5 方案](../p1-5-models-and-credentials.md)第 211 行；[分片 03](../p1-5-models-and-credentials/03-design.md) 第 131 行）。
- **IPC**：决策 034 的凭据应答走宿主与 Main 之间的 Node IPC。进程内任何代码都能 `process.on('message')` 看到这些消息（推断，Node 语义），也能 `process.send`。
- **文件、子进程、网络**：`ctx.fs`、`ctx.subprocess`、`node:fs`、`child_process`、`fetch` 都不经工具注册表，完全不过闸（[P1-6 方案](../p1-6-permissions.md)第 212 行）。
- **钩子**：插件能注册更靠前的 `tools/pre-execute`、`approval/request`、`agent/request`、`llm/*` 监听者；决策 042 的同步 guard 兜住「闸门没被调到」这一种。
- **配置写入**：`config-editor` 行把表单改动写进 profile 补丁（`dsh-base/cordis.patch.yml:94-103`）；进程内代码也能调它。
- **补丁**：bundle 补丁可以改写组合里的任何一行（`dsh-app-boot/lib/index.js:61-110` 的语义）。

## 10 钉住的树里没有的东西

- `dsh-mcp-client`（MCP 客户端）、`agent-preset` 类的包、`ui-plugin-manager` 等界面插件、`dsh-host-plugin-inventory` 的挂载行（包装了，dsh-base 没挂）。
- 核实这些要联网 `npm pack`，本次按约束没有做。
