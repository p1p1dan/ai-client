Role: topic

# P1-10 插件白名单与预装 + P1-16 pi-agent 用户资产接管：方案与就绪检查

上位：[roadmap P1-10、P1-16](../roadmap.md)。两项都关系到 DSH 下的扩展与用户自定义，合并出方案。

依据：
- 决策：[001](../decisions/001-route-b-and-scope.md) 第 2 条（内部白名单加官方包，不开放社区自由安装）；[003](../decisions/003-p0-closeout-enter-p1.md) 第 2 条；[004](../decisions/004-branch-isolated-dsh-only.md) 第 3、6 条；[008](../decisions/008-private-dsh-home.md)；[014](../decisions/014-host-size-budget.md)；[015](../decisions/015-probe-plugin-out-of-product.md)；[016](../decisions/016-pnpm-ships-for-now.md)；[019](../decisions/019-one-host-per-app-virtual-slots.md)；[022](../decisions/022-host-env-inherits-main.md)；[023](../decisions/023-no-dotenv-private-cwd-home-patch-overlay.md)；[025](../decisions/025-host-lifecycle.md) 第 5 条；[033](../decisions/033-model-plan-via-configure-overlay.md)；[034](../decisions/034-per-request-credential-pull.md)；[042](../decisions/042-approval-in-pre-execute-plugin.md)；[047](../decisions/047-tool-classification-and-plan-mode.md)；[049](../decisions/049-delegate-declared-tier-inherits.md)。
- 证据与方案：[P0-2](../evidence/p0-2-goal-and-plugins-2026-09-25.md)（plugin-manager 经 pnpm 装插件、写用户目录、访问网络）；[P1-2](p1-2-host-packaging.md)；[P1-3](p1-3-shared-host.md)；[P1-5](p1-5-models-and-credentials.md)；[P1-6](p1-6-permissions.md)；[P1-9](p1-9-migration.md) §8。

明细分片：[01 1.0.x 用户资产清单](p1-10-p1-16-extensions/01-assets.md) · [02 DSH 侧事实](p1-10-p1-16-extensions/02-dsh-facts.md) · [03 设计明细](p1-10-p1-16-extensions/03-design.md) · [04 改动、实验与测试](p1-10-p1-16-extensions/04-changes-and-tests.md)。

状态：
- 只读调研，基线 worktree HEAD `d833115f`。同一 worktree 里 P1-2 与 P1-3b 正在施工，本文不引用它们未提交的改动。
- 没有改代码，没有起宿主或 Electron，没有联网，没有调用模型，没有读开发机上任何真实用户目录（`~/.pilab/*/pi-agent/` 等）。
- **方案待拍板**（§5）。

约定：DSH 路径省略前缀 `src/dsh-host/node_modules/@deepseek-ai/`，版本 `0.1.7-rc.2`；`host.ts` 指 `src/dsh-host/host.ts`；1.0.x 路径省略前缀 `src/`，只写文件名的以分片 01 的全路径为准，行号取 `git show d833115f:<路径>`；`<agentDir>` 指 `~/.pilab/<profile>/pi-agent`。标「推断」「需实测」的没有运行验证。

## 1 结论先行

1. **插件预装进安装包的「安装范围」，用户机上不跑包管理器。**
   - 白名单插件写成宿主子包的精确版本依赖，构建期 `npm ci` 按锁文件的 `integrity` 装进 `resources/dsh-host/node_modules/`。我方 `@aiclient/dsh-app` 本来就这样进包（`src/dsh-host/package.json:12`）。DSH 解析 bundle 时先找安装锚点、再找 profile（`dsh-app-boot/lib/index.js:900-906`）；plugin-manager 把宿主依赖列为「不可删除」（`dsh-plugin-manager/lib/index.js:1456-1471`）；DSH 官方随安装包分发的可选 bundle 走的也是这条路（`dsh-app-boot/lib/index.js:544-556`）。
   - `DSH_HOME` 里只记「启用了哪几个」：宿主每次启动按「产品 bundle +（已启用 ∩ 白名单）」重写 profile 清单，是对 P1-3a bundles 重申（决策 025 第 5 条）的扩展。
   - 于是 pnpm 不再随包（决策 016 收口：约 −16 MiB，Q007 少一项），`plugin-manager`、`tool-plugin-manager` 两行关掉。插件跟应用版本一起升级，peer 兼容在构建期对钉住的 DSH 核一次。
2. **白名单 = 仓库清单 + 锁文件双键 + 构建期审计 + 启动期组合审计 + 人工审查记录**。由工程维护、经 PR 合入，用户不能自行安装（决策 001 第 2 条）。插件与宿主同进程（决策 019），能直接用 `ctx.fs`、子进程、网络、IPC，也能调 `ctx.credentials`；工具闸门只拦经注册表的调用。**审查是唯一的硬防线**，审查单见 §4.5。
3. **用户资产原地对接，不搬家。** pi-agent 目录里的东西留在原处，由 DSH 构建按原路径读；不复制、不改写，回装 1.0.x 看到的还是同一份（与 P1-6 读策略文件的做法、决策 004 的回装口径一致）。逐类结论：
   - 全局 `AGENTS.md`：**对接**。DSH `agent-instructions` 行的 `dshHome` 指向 `<agentDir>`；用户层（`~/.pilab/AGENTS.md` 等三选一）用一个小插件补上。
   - skills：**对接**。`skill-filesystem` 行加上 `<agentDir>/skills`；DSH 要求 frontmatter 带 kebab-case 的 `name`、只认一层目录，不合规的出兼容报告提示。
   - prompts：**自持**。DSH 没有提示词模板，展开逻辑搬进 shared，由 bridge 执行。
   - 自定义子代理：**对接**。新宿主插件把定义翻成 DSH spawn 的 `persona` / `toolFilter` / `agentOptions`（`dsh-subagent/lib/types/types.d.ts:136-192`）；工具形态与 P1-7 一起拍板。
   - `mcp.json`：**自持**。把 1.0.x 的 MCP 桥移植成宿主插件：按会话起服务器，工具名与策略面不变，经 `ctx.subprocess` 起进程；再接上 DSH 的资源工具。
   - pi 插件：**放弃并提示**。1.0.x 里聊天本来就不加载它们，只有内置 pi 终端加载（`main/services/piPlugins/index.ts:111-119`）；P1-11 / P1-12 之后没有载体。
4. **MCP 是最大的倒退风险。** 钉住的 DSH 树里只有 `dsh-mcp-resources`（3 个读资源的工具），没有 MCP 客户端：官方客户端要另配（`dsh-base/README.md:62`），而 `dsh-mcp-client` 只以 devDependency 出现（`dsh-spill-policy/package.json:64`），没有装在我们的树里。什么都不做，1.0.x 的 MCP 用户切过去就全部失效。推荐移植（D7 A），约 1.5 人周。
5. **规模**：P1-10 约 1.5～2 人周，P1-16 约 3～4 人周（粗估），切成 P1-10a～d、P1-16a～d（§6）。硬依赖 P1-2（构建脚本）、P1-3a（宿主启动与 bundles 重申）、P1-4d（`commands` / `capabilities`）、P1-6b（过闸）。
6. **要用户拍板的**：D5 首批白名单（要不要随包分发社区插件）、D7 MCP 路线、D11 子代理工具形态（与 P1-7 一起）、D12 放弃 pi 扩展。其余按工作方式自主决定，每条单独写决策、标待审批。

## 2 现状：1.0.x 的用户资产（明细见[分片 01](p1-10-p1-16-extensions/01-assets.md)）

| 资产 | 位置与格式 | 谁读、何时 | 界面入口 | 归属 |
|---|---|---|---|---|
| 托管全局指令 | `<agentDir>/AGENTS.md`（`main/services/piModelConfig/index.ts:44-46`） | worker 建图时作为 managed 全局文件进系统提示词，不可关（`runtime/bootstrap.ts:485-499`） | 无编辑器；「数据迁移」页从 `~/.pi/agent` 复制（`AgentDirMigrationService.ts:146-153,319-338`） | 自有 |
| 用户层指令 | `~/.pilab/AGENTS.md` → `~/.claude/CLAUDE.md` → `~/.codex/AGENTS.md`，取第一个（`projectInstructions.ts:95-117`） | 同上，user 层 | 无 | 跨工具生态文件 |
| 项目指令链 | 每级取 `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` / `.claude/CLAUDE.md` 中第一个，加 `CLAUDE.local.md`；从工作区到家目录之下；共 32 KiB（`projectInstructions.ts:72-93,126-160`） | 同上；工具读到子目录时补注入 | 无 | 事实标准，在用户仓库里 |
| skills | `<agentDir>/skills`、`~/.agents/skills`、`<cwd>/.pi/skills`、仓库根到 cwd 各级 `.agents/skills`（`skills/index.ts:203-237`）；`SKILL.md`，名字 `[\w.-]{1,64}`，缺 `name` 用目录名，最深 4 层（`loader.ts:212-214,261,322-404`） | 建图时进系统提示词；`skill` 工具读正文；行首 `/skill:<name>`（`expand.ts:83-88`） | 「扩展→资源」打开目录（`PiResourcesSettings.tsx:97-152`）；斜杠菜单 | pi 生态（Agent Skills 标准） |
| prompts | `<agentDir>/prompts/*.md`、`<cwd>/.pi/prompts/*.md`，平铺（`skills/index.ts:239-248`） | 发送时行首 `/name 参数` 换成正文，支持 `$1` / `$@` / `$ARGUMENTS`（`expand.ts:22-65`；`nativeWorkerRuntime.ts:438,528-533`） | 同上；斜杠菜单（`nativeWorkerRuntime.ts:694-718`） | pi 生态 |
| 自定义子代理 | `<agentDir>/subagents/*.md`、`~/.agents/subagents/*.md`，加 4 个内置（`catalog.ts:78-89`）；字段见 `subagentDefinition.ts:78-101` | 建图时读，每个顶层 run 重读；`Task*` 工具 | 「扩展→子代理」完整管理页（`subagentCatalog.ts:1-35`） | 自有（改编自 PI-Desktop） |
| MCP | `<agentDir>/mcp.json` → `.pi/mcp.json` → `.pi/mcp.local.json`，`{"mcpServers":{…}}`，只支持 stdio（`mcp/config.ts:139-157,236-260`） | 每个会话自己起服务器，cwd 为工作区，环境为 Main 全部环境加 `env`（`mcp/index.ts:201-214`；`host/exec.ts:629-645`）；工具 `mcp__<server>__<tool>`，过闸面 `mcp`、值 `server:tool`（`mcp/index.ts:139-150,404-417`） | 无编辑页；能力弹窗列服务器（`LeftDock.tsx:491-521`）；策略页的 MCP 面 | 自有实现 + 事实标准格式 |
| pi 插件 | `<agentDir>/npm/node_modules/*` 加 `settings.json` 的 `packages`，经随包 pi CLI 装卸（`PiPluginService.ts:1-29,86-127`） | 只有内置 pi 终端加载，聊天不加载（`piPlugins/index.ts:111-119`；`nativeWorkerRuntime.ts:680-683`） | 「扩展→插件」（`PiPluginsSettings.tsx:1-17`） | pi 生态 |

不在本题：`models.json` / `auth.json`（P1-5）；权限策略文件（P1-6）；`sessions/`（P1-9）。

## 3 DSH 侧事实（明细见[分片 02](p1-10-p1-16-extensions/02-dsh-facts.md)）

- **plugin-manager**：每次安装都跑 `pnpm add <spec> --registry=…`，装进 `$DSH_HOME/profiles/<profile>`，默认还会回落到 npmmirror，没有离线参数（`dsh-plugin-manager/lib/index.js:1750-1753`；`README.md:79`）。支持绝对路径与 tarball 规格（`lib/types/install-spec.js:57-85`）。装进来的代码在进程内运行，不在工作区沙箱里（`README.md:31`）。dsh-base 里只要有 `profileContext` 这一行就启用，给模型用的 `tool-plugin-manager` 关着（`dsh-base/cordis.patch.yml:16-22`）。
- **解析与组合**：安装锚点优先于 profile（`dsh-app-boot/lib/index.js:900-906`）；profile 清单只在首次写入（`:575-591`）；peer 只查 `@deepseek-ai/dsh*`，按含预发布的规则匹配（`:286-318`）；组合顺序是 bundles → profile 用户层（可用 `userLayer: false` 跳过）→ home 层 → overlays（`:946,1022-1033`）。
- **指令**：`agent-instructions` 只认一个用户全局文件 `<dshHome>/AGENTS.md`（`dshHome` 可配）；项目链从 `.git` 根到 cwd，`AGENTS.md`、`CLAUDE.md` 都读，内容相同才去重，另加 `*.local.md`；候选名不许带路径分隔符；64 KiB；以 durable user 消息注入（`dsh-agent-instructions/lib/index.js:16-18,75-77,141,480-488`；`README.md:32,59-66`）。
- **技能**：根按 rank 先到先得：项目根 `.dsh/skills`、`.agents/skills` → `customSkillDirs` → `$DSH_HOME/skills` → `~/.agents/skills`；只认 `<name>/SKILL.md` 与平放的 `<name>.md`；`name`、`description` 必填，名字必须 kebab-case；有热更新（`dsh-skill-filesystem/README.md:36,44-56`；`lib/index.js:664-700`；`dsh-skill/lib/index.js:17`）。用户消息任何位置的 `/name` 都会注入技能（`dsh-tool-skill/README.md:54,88`）。
- **命令与模板**：`ctx.commands` 是插件注册的动作，不产生模型消息（`dsh-commands/README.md:32,50`）；DSH 没有提示词模板。
- **子代理**：`ctx.subagents.start(name, request)` 的请求能带 `persona`、`toolFilter`、`agentOptions`、`maxDepth`（`dsh-subagent/lib/types/types.d.ts:136-192`）；没有 Markdown 代理定义。
- **MCP**：只挂了 `mcp-resources`（`dsh-base/cordis.patch.yml:491-492`）；任何插件都能经 `ctx.mcpResources.register` 注册资源提供者（`dsh-mcp-resources/lib/index.js:109-176`）；按 DSH 自己的说明，MCP 传输自己起进程、绕开 subprocess 服务（`dsh-subprocess/README.md:84,150`），而 `ctx.subprocess` 的 `pipe` 模式可以承载 JSON-RPC 之类的流（`:57`）。
- **同进程暴露面**：凭据、`fs`、子进程、网络、IPC、钩子、`config-editor` 写 profile 补丁，对插件都是开放的（分片 02 §9）。

## 4 方案（明细见[分片 03](p1-10-p1-16-extensions/03-design.md)）

### 4.1 逐类资产结论

| 资产 | 结论 | 做法 | 残留差异与提示 |
|---|---|---|---|
| 托管全局指令 | 对接 | overlay 给 `agent-instructions` 配 `dshHome = <agentDir>`，`maxBytes` 一并写上 | 以 user 消息注入，不再进系统提示词；预算 64 KiB |
| 用户层指令 | 对接（小插件） | `aiclient-instructions` 读家目录三选一 | — |
| 项目指令链 | 对接，接受差异 | 用 DSH 原生 | 以 `.git` 为根；不认 `AGENTS.override.md`、`.claude/CLAUDE.md`；`AGENTS.md` 与 `CLAUDE.md` 都读；写进设置页说明 |
| skills | 对接 + 兼容报告 | `customSkillDirs = [<agentDir>/skills]`；bridge 把行首 `/skill:<name>` 改写成 DSH 的 `/<name>` | 缺 `name`、名字不合规、多层目录、放在 `.pi/skills` 或中间目录 `.agents/skills` 里的不加载，列进报告（D9） |
| prompts | 自持 | 模板加载与展开搬进 `src/shared`，bridge 在 `startSend` 展开、在 `commands()` 列出 | 与 DSH 命令同名的模板被遮蔽，列进报告 |
| 自定义子代理 | 对接（宿主插件） | `aiclient-delegates` 读同一批定义，调 `ctx.subagents.start('spawn', {persona, toolFilter, agentOptions})` | `permission` 按 inherit（决策 049）；`maxTurns` 可选补；正文里的 `{{…}}` 要转义 |
| `mcp.json` | 自持（移植） | `aiclient-mcp`：按会话读三层配置，经 `ctx.subprocess` 起 stdio 服务器，在该会话 scope 里注册 `mcp__<server>__<tool>`，再注册资源提供者 | 服务器不再继承 Main 环境里像密钥的变量（决策 022），要写进 `mcp.json` 的 `env`，设置页提示 |
| pi 插件 | 放弃并提示 | 插件页改为 DSH 白名单插件；旧 pi 扩展只读列出，注明新版不加载 | 文件不动，回装 1.0.x 照常可用 |

路径下发：`<agentDir>` 随 P1-5 的 `configure` 控制消息进宿主，由 `host.ts` 生成 overlay；P1-6 的 `AICLIENT_PERMISSION_AGENT_DIR` 建议并到同一处。所有读取都在宿主（随包 node）里做（ARD D11）。

### 4.2 插件白名单

- **载体**：`src/dsh-host/plugins/allowlist.json`。字段：名字、精确版本、与锁文件相同的 `integrity`、`kind`（`official` 为与钉住 DSH 同版的 `@deepseek-ai/*`；`internal` 为审过的社区包或我方包）、`defaultEnabled`、允许插入的 `rows`、各工具的过闸分类 `tools`、审查记录、可选的 `replaces`（分片 03 §3.1）。
- **维护**：工程经 PR 修改，清单与锁文件必须同时改，静态测试核对。每次插件升版、DSH 升版都重审（决策 003 第 2 条已含「复核白名单插件的 peer」）。
- **构建期审计**：integrity 一致；对钉住的 DSH 兼容，不许豁免；bundle 补丁只能 `insert` 自己声明的行，不许改已有 id；不带 `dsh.client`，不跑安装脚本；依赖闭包全部在册；体积、许可；敏感 API 扫描报告。结果写进 `dsh-host-manifest.json` 的 `plugins` 段。
- **启动期审计**（扩展 `host.ts:130-149`）：bundles 只能是产品 bundle 加已启用的白名单项；`REQUIRED_DISABLED` 加两行插件管理，由决策 023 的 overlay 重申；`aiclient-bridge`、`aiclient-permissions`、`aiclient-credentials` 必须启用；home 层补丁插入未声明的行时，产品态拒绝启动。
- **准入**：提名 → 初筛（纯宿主、是 bundle、peer 兼容、许可）→ 按审查单审查 → 定过闸分类（默认 `'*': 'ask'`，决策 047；只能按读写细分，不能归入「内部工具直接放行」）→ 真宿主冒烟 → 合入并写发版说明。下架即从清单删除，新版自动停用并提示。

### 4.3 预装与离线

- **放哪**：安装包里的 `resources/dsh-host/node_modules/<插件>`，不在首次启动时装。`DSH_HOME` 里只有 profile 清单记录启用项。
- **不联网**：用户机上没有 pnpm，也没有任何安装入口。网络只在 CI 构建期用一次，由锁文件 integrity 校验。打包冒烟带一个已启用插件，断言零非回环连接、零 DNS、没有 pnpm 进程。
- **体积**（决策 014）：插件与宿主同一套 B 档裁剪，同样计入 128 MiB 硬上限；去掉 pnpm 约 −16 MiB；建议单插件默认上限 5 MiB / 500 个文件，超出单独批准；总上限在 P1-10a 按实测重定。
- **启用**：宿主级，Main 设置里存启用集合；切换走 `invalidateAll`（决策 025），有在飞回合就等空闲再重启宿主。
- **升级与回装**：插件随应用版本整体替换，不需要迁移；`replaces` 处理改名；回装 1.0.x 不受影响。

### 4.4 界面（与 P1-7 的边界）

- 「扩展→插件」改成白名单插件列表：名称、版本、说明、来源、能力标签、审查日期，只有启用开关；没有安装框，没有删除按钮；下方只读列出 1.0.x 装过的 pi 扩展。
- 「扩展→资源」保留目录入口，加兼容报告与项目指令链的差异说明；「扩展→子代理」保留，注明 `permission` 按继承处理；MCP 加一句 `env` 说明；能力弹窗去掉 pi 扩展那句（`LeftDock.tsx:536-540`）。
- 边界：设置页、IPC、插件工具的过闸分类归本任务；聊天区的插件工具行文案、子代理面板归 P1-7。

### 4.5 安全

- **威胁面**：`ctx.credentials.resolve` 能拿到网关 key（P1-5 风险项）；`ctx.fs`、`node:fs`、子进程、`fetch` 都不经工具注册表（P1-6 绕过面）；`process.on('message')` 能看到宿主 IPC 上的全部消息，包括决策 034 的凭据应答（推断，Node 语义）；能注册更靠前的 `tools/pre-execute`、`approval/request` 监听者；bundle 补丁能改写任何行。
- **运行期兜底只有四样**：没有安装器（D3）；bundles 与行按白名单重申和审计；隐私行由 overlay 重申（决策 023）；闸门的同步 guard（决策 042 第 3 条）。它们挡得住「配置被篡改」，挡不住「白名单里的代码作恶」。
- **审查单**（全文见分片 03 §6.2）：身份与许可；安装脚本与原生件；依赖闭包；bundle 补丁；敏感 API（凭据、`process.env`、IPC、子进程、网络、越界写、`eval` 与动态 import、`vm` / `worker_threads`、猴子补丁、上报）；钩子（自动应答审批就是 `aiclient-probe` 那一类问题，决策 015）；工具与过闸分类，目录标注的能力要独立核实（`dsh-office-tools` 标的是只读，实际会写文件）；数据去向；平台与加密机。
- **插件自己的凭据**：P1 不提供；凭据提供者能否按调用方限制，留给实验 E8。

## 5 需要拍板的决策点

| # | 决策 | 选项 | 推荐 | 理由 | 代价 |
|---|---|---|---|---|---|
| D1 | 用户资产放哪 | A 原地对接，DSH 按原路径读；B 首启一次性复制进 `DSH_HOME` 的原生位置；C 两边同步 | A | 回装 1.0.x 零影响；没有会漂移的副本；P1-6 已这样读策略文件 | DSH 原生位置空着；要把 `<agentDir>` 下发给宿主 |
| D2 | 预装形态 | A 安装范围，构建期装；B 随包 tarball，首启用 pnpm 离线装进 profile；C 运行期从内部源装 | A | 与 `@aiclient/dsh-app` 同路；锁文件 integrity 天然校验；没有首启失败面；与 DSH 同版升级 | 上新插件要发版；插件字节全算进安装包 |
| D3 | pnpm 与 plugin-manager（收口决策 016） | A 去掉 pnpm，关掉两行插件管理，profile 用户层不参与组合；B 保留备用 | A | 去掉用户机上唯一会联网、写用户目录的路径（P0-2）；插件拿不到安装器；约 −16 MiB；Q007 少一项 | 以后要运行期安装得另立决策；启用选择由我方写 profile 清单（约 50 行） |
| D4 | 白名单校验 | A 仓库清单 + 锁文件双键 + 构建期与启动期审计；B 另加签名清单，运行期验签 | A | 安装目录与 `app.asar` 同一信任级别，运行期验签没有实质增益 | 审计规则随 DSH 升级维护；home 层新增行的处理细化了决策 023 |
| **D5** | **首批白名单（需用户拍板）** | A 试点 `dsh-office-tools@1.0.4`（P0-2 跑通，零运行期依赖），默认关；B P1 不带第三方插件，只用测试夹具验证机制；C 再加官方包（清单要联网盘点） | A | 走通真实插件的整条链；办公文档贴近用户场景 | 要完成一次社区包审查；随包分发第三方代码 |
| D6 | 启用粒度 | A 宿主级，切换即重启宿主；B 按会话 | A | DSH 的组合是宿主级的（决策 019） | 切换会中断在飞回合，所以等空闲再重启 |
| **D7** | **MCP（需用户拍板，涉及倒退）** | A 移植 1.0.x 的桥为宿主插件；B 白名单官方 `dsh-mcp-client`，把 `mcp.json` 转成行；C 放弃并提示 | A | 配置格式、按会话语义、cwd、工具名、策略规则都不变；经 `ctx.subprocess` 起进程，符合 ARD D11 第 4 条；还能接上资源工具 | 约 1.5 人周：搬约 1.1k 行、新写约 500 行，此后自己维护。B 的格式、命名、按会话挂载都没核实，官方客户端自己起进程；C 让 MCP 用户全部倒退 |
| D8 | 指令文件 | A DSH 原生，`dshHome` 指向 `<agentDir>`，外加用户层小插件；B 整链移植我方实现，关掉 DSH 行；C 只用 DSH 原生，首启复制一次 | A | 用上 DSH 的按需发现、去重、热更新；1.0.x 两类全局文件都保住 | 项目链的差异（§4.1）要写进说明 |
| D9 | skills | A DSH 原生 + 自定义目录 + 兼容报告；B 再加兼容提供者，读 `.pi/skills` 与多层目录；C 复制并改写 frontmatter | A，B 看报告里的数量再定 | DSH 注册表直接拒绝不合规的名字，B 也救不回这一类；改写用户文件风险大 | 不合规的技能要用户自己改 |
| D10 | prompts | A bridge 自持展开；B 转成 DSH 的用户可调技能；C 放弃 | A | 保住位置参数替换与「整条消息替换」的语义；代码现成 | 自维护约 300 行 |
| **D11** | **子代理定义（需与 P1-7 一起拍板）** | A 宿主插件注册一个带「代理名」枚举的委派工具，按定义调 `ctx.subagents.start`；B 每个启用的定义生成一行 `dsh-tool-subagent`；C 放弃，只留 DSH 通用 `subagent` | A | 与 1.0.x 的 `Task(subagent_type)` 体验一致；工具数不随定义增多；改定义不用重启宿主 | 约 1 人周；与 DSH 通用 `subagent` 并存，要写清分工。B 每个定义占一个工具 schema；C 让自定义代理全部失效 |
| **D12** | **pi 扩展（需用户拍板）** | A 放弃并提示；B 保留 pi TUI，继续加载（取决于 P1-11） | A | 1.0.x 起聊天就不加载它们；P1-12 删掉 `resources/agent-host` 后没有 pi CLI | 在内置终端里用 pi 扩展的用户会失去它们 |

## 6 改动清单与切分（逐文件见[分片 04](p1-10-p1-16-extensions/04-changes-and-tests.md)）

| 子任务 | 内容 | 主要文件 | 产品 / 测试（行，粗估） | 依赖 |
|---|---|---|---|---|
| P1-10a 白名单与构建期审计 | 清单与校验库；构建脚本的插件步骤；去掉 pnpm；体积上限 | `src/dsh-host/plugins/allowlist.json`、`src/shared/dshPluginAllowlist.ts`、`scripts/dsh-host-build-lib.mjs`、`src/dsh-host/package.json` 与锁文件、`scripts/packaging-budget.mjs` | 300 / 400 | P1-2 落地；E2 |
| P1-10b 宿主装载与审计 | bundles 按清单与启用集合重申；关两行；组合审计；`ready` 回报插件状态 | `host.ts`、`bundle/cordis.patch.yml`、Main 下发启用集合 | 200 / 300 | P1-3a；E1、E3 |
| P1-10c 设置页与 IPC | 插件服务、IPC、插件页、旧 pi 扩展说明、能力弹窗文案 | `src/main/services/dshPlugins/*`、`src/main/ipc/dshPlugins.ts`、`DshPluginsSettings.tsx`、`SettingsContent.tsx` | 350 / 400 | b |
| P1-10d 试点插件 | 审查记录；工具过闸分类；真宿主与 Windows CI 冒烟 | `src/dsh-host/plugins/reviews/*`、P1-6 分类表、bridge-smoke 场景 | 100 / 300 | a、b、P1-6b；D5 |
| P1-16a 指令与技能 | 两行 overlay；`aiclient-instructions`；技能兼容报告；`/skill:` 改写 | `host.ts`、`src/dsh-host/extensions/instructions.ts`、`src/shared/skills/*`、bridge | 400 / 600 | P1-3a、P1-4d；E6 |
| P1-16b MCP | 纯逻辑搬进 shared，runtime 改薄封装；`aiclient-mcp`；`mcp__*` 过闸分类 | `src/shared/mcp/*`、`src/dsh-host/extensions/mcp.ts` | 搬 1.1k + 新 500 / 900 | P1-3a、P1-6b；E4、E5 |
| P1-16c 模板与斜杠命令 | 模板与展开搬进 shared；bridge 合并命令并按顺序展开 | `src/shared/skills/{templates,expand}.ts`、bridge | 搬 350 + 新 150 / 350 | P1-4d |
| P1-16d 子代理定义 | `aiclient-delegates`；委派总开关映射到行；设置页说明 | `src/dsh-host/extensions/delegates.ts`、`src/shared/subagentCatalogRoots.ts` | 500 / 500 | P1-4、P1-5a、P1-6b、P1-7；D11；E7 |

- **顺序**：10a（P1-2 之后）→ 10b（P1-3a 之后）→ 10c、10d；16c、16a 在 P1-4d 之后；16b 在 P1-3a、P1-6b 之后；16d 等 D11 与 P1-7。跑测试的并行代理不超过 2 个。
- **边界**（全表见分片 04 §2）：P1-2 构建脚本与预算；P1-3a bundles 重申与 overlay；P1-4d `commands` / `capabilities`；P1-5 `configure` 与凭据提供者；P1-6 分类表与 `<agentDir>` 下发；P1-7 子代理面板与工具行文案；P1-9 不迁资产；P1-11 决定 pi TUI；P1-12 删 runtime 前先完成各项搬迁；P1-13 检查单补两项。

## 7 测试方案（明细见分片 04 §4）

- **单测（根 vitest，不装 DSH）**：清单模式与双键核对；补丁审计的好样本与坏样本；bundles 重申（全新、保留、剔除、下架、改名、幂等）；启动期组合审计；技能兼容报告表；模板展开沿用 `skills.test.ts` 的用例；MCP 沿用 `mcp.test.ts` 的用例；子代理映射（工具补集、档位、`{{` 转义）；设置页与服务。
- **真宿主（bridge-smoke 风格，假网关，进 Linux CI）**：PLG-1 试点插件从安装范围加载，`word_create` 出审批卡，允许后写入，全程零外连、没有 pnpm；PLG-2 关闭与 peer 不兼容；PLG-3 篡改 profile 清单与 home 层补丁；INS-1 三类指令进首个请求；SKL-1 两个技能根与 `/skill:x`；TPL-1 模板展开与遮蔽；MCP-1 用 `mcp-echo-server.mjs` 验证会话隔离、过闸、资源工具、进程回收；SUB-1 自定义代理的 persona 与工具限制。
- **CI 与打包**：Windows 两路跑 PLG-1、MCP-1（推送前确认）；P1-2 的 L1 打包冒烟带一个已启用插件，加断网断言。
- **退出判据**：P1-10「白名单插件离线可装可用」= PLG-1 在 Linux CI、Windows 两路、打包冒烟里全过，PLG-2、PLG-3 全过。P1-16「每类资产有结论并落地，自定义项可用或有明确提示」= INS-1、SKL-1、TPL-1、MCP-1、SUB-1 全过，加上兼容报告、pi 扩展说明、MCP `env` 说明的 GUI 点验。

## 8 风险与未覆盖

- **开工前要做的实验**（分片 04 §3，每个一个脚本，先 `free -m`）：E1 关掉插件管理两行、profile 用户层不参与组合后宿主照常启动；E2 插件作为宿主依赖时 npm 的 peer 解析（npm 匹配预发布比 DSH 严，可能 `ERESOLVE`，要联网，在 CI 或经授权做）；E3 从只读安装目录加载插件 bundle；E4 插件能否把工具注册在某个会话的 scope 里；E5 `ctx.subprocess` 能否承载 MCP 双向流、宿主被杀后子进程是否回收；E6 `dshHome` 与 `customSkillDirs` 生效；E7 插件调 `ctx.subagents.start` 带 persona 与 toolFilter；E8 凭据提供者能否认出调用方，插件能否读到 IPC 上的凭据应答。
- **没能确认的事实**：`dsh-mcp-client` 的配置格式、工具命名、stdio 与 cwd 支持、起进程方式（包不在钉住的树里，核实要联网 `npm pack`，需授权）；`dsh-office-tools` 的体积、文件数和实际调用的 API（审查时看）；官方包里还有哪些值得进白名单（npm 上 `@deepseek-ai/*` 有 300 多个，需联网盘点）；1.0.x 用户手里不合规的技能、MCP 配置、pi 扩展的实际分布（没有读真实用户目录，只能靠应用内报告计数，或经授权用离线工具统计）。
- **同进程信任**：白名单插件的代码与宿主同权，审查漏一项就是全权限漏洞；进程外隔离不在 DSH 的模型里。
- **DSH 升级**：插件 peer 可能失效，启动时只告警、跳过，但用户会失去功能。升级流程要带上白名单复审与 PLG 场景。
- **加密机（P1-13）**：MCP 服务器和插件起的子进程由加密驱动按进程放行，经 `ctx.subprocess` 走随包 node 的 runner 是否够用，要上机确认。
- **行为差异**（写进发版说明）：项目指令链规则；技能的命名与目录层级；`/name` 在消息中间也会触发技能；模板被 DSH 命令遮蔽；MCP 服务器不再继承密钥类环境变量；子代理的 `permission` / `maxTurns` 不生效；pi 扩展不再加载。
- **roadmap 补登建议**（本文不改 roadmap）：① P1-12 删 runtime 前，先把 skills 的解析与模板、MCP 的配置与客户端、子代理目录规则搬进 `src/shared`；② P1-13 检查单补「MCP 服务器与插件子进程读写明文」；③ 决策 016 由 D3 收口；④ P1-5 评估同进程插件读到 IPC 凭据应答的风险；⑤ 决策 023 一并审批 home 层新增行的处理。
