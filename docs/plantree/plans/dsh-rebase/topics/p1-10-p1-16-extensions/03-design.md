Role: detail shard

# P1-10 / P1-16 分片 03 · 设计明细

上位：[P1-10 / P1-16 方案](../p1-10-p1-16-extensions.md)。回答调研问题 2（逐类结论）、3（白名单）、4（预装与离线）、5（界面）、6（安全）。事实依据见[分片 01](01-assets.md)、[分片 02](02-dsh-facts.md)。本分片是设计，没有运行验证；标「推断」「需实测」的留给实现前的实验（[分片 04 §3](04-changes-and-tests.md)）。

## 1 总原则与路径下发

- **原地对接（D1）**：资产留在 `<agentDir>` 与用户仓库里，DSH 构建按原路径读。产品不复制、不改写这些文件；只有用户在设置页里主动编辑时才写，例如子代理管理，这与 1.0.x 相同。
  - 好处：回装 1.0.x 看到同一份文件；没有副本漂移；没有迁移步骤，也就没有迁移失败面；P1-9 不用管这些资产。
  - 代价：DSH 的原生位置（`$DSH_HOME/AGENTS.md`、`$DSH_HOME/skills`）空着。有人照 DSH 文档往那里放东西，也照样生效，因为这些默认根没关。
- **路径下发**：Main 知道 `<agentDir>`（`getAppPiAgentDir()`）。推荐随 P1-5 的 `configure` 控制消息一起下发（决策 033 的 overlay 通道），由 `host.ts` 生成 overlay：`agent-instructions` 的 `dshHome` 与 `maxBytes`、`skill-filesystem` 的 `customSkillDirs`，以及我方几个插件行的 `agentDir`。P1-6 的 `AICLIENT_PERMISSION_AGENT_DIR` 建议并到同一处，一份路径、一个来源。`configure` 落地之前可以先用环境变量，路径不是密钥，进了工具环境也无害。
- **加密机**：所有读取都在宿主里做，宿主跑在随包 node 上（ARD D11）。Main 不替宿主读这些文件，因为 Main 读到的可能是密文（ARD D13）。

## 2 逐类资产

### 2.1 指令文件（D8 A）

- 配置（overlay，整行 `config` 会被替换，所以 `maxBytes` 要一起写）：

  ```yaml
  - id: agent-instructions
    config:
      maxBytes: 65536
      dshHome: <agentDir>   # filled in by host.ts from the configure message
  ```

- 新行 `aiclient-instructions`（我方 bundle，约 120 行）：会话首次请求前读家目录下的三个候选 `~/.pilab/AGENTS.md` → `~/.claude/CLAUDE.md` → `~/.codex/AGENTS.md`，取第一个存在的；用和 DSH 一样的 `<system-reminder>` 包装，并转义 `</system-reminder>`；作为 durable 的 user 消息注入，缓存友好、能回放；预算单独 32 KiB。用 `agent/pre-step` 还是 `systemPrompt.section`，实现时照 DSH `agent-instructions` 的做法定。
- 交给 DSH 原生、接受下来的差异（写进设置页「资源」段和发版说明）：
  - 项目链以 `.git` 为根，仓库根以上、家目录以下的父目录不再读；
  - 不认 `AGENTS.override.md` 和 `.claude/CLAUDE.md`。前者可以加进候选，但语义会变成「都读」而不是「覆盖」，所以不加；
  - `AGENTS.md` 与 `CLAUDE.md` 同时存在时都读，内容相同才去重，1.0.x 只读第一个；另外多认 `AGENTS.local.md`；
  - 预算 64 KiB，超了先丢较宽的文件；1.0.x 是整链共用 32 KiB；
  - 以 user 消息进入上下文，不是系统提示词；
  - 按需发现只跟 `read` / `write` / `edit`，不跟 shell。
- 否决的选项：
  - B 整链移植我方实现：要搬 `projectInstructions.ts` 与 `instructionTracker.ts`，还要关掉 DSH 行，失去 DSH 的去重、按需更新、预算提示，换来的只是几条边角规则；
  - C 只用 `$DSH_HOME/AGENTS.md`，首启复制一次：副本会与原文件漂移，用户层也丢了。

### 2.2 skills（D9 A）

- 配置：overlay 给 `skill-filesystem` 行加 `customSkillDirs: [<agentDir>/skills]`，rank 300，排在项目根之后、`~/.agents/skills` 之前；其余默认根不动。
- 调用：bridge 在 `startSend` 里把行首的 `/skill:<name>` 改写成 `/<name>`，只在 `<name>` 是用户可调技能时改写，DSH 的 `tool-skill` 随后注入技能内容。`commands()` 继续给出 `skill:<name>` 行，渲染层不用改；以后要不要换成 DSH 的写法，交给 P1-7。
- 兼容报告：纯函数 `src/shared/skills/compat.ts`。输入是按 1.0.x 规则扫出来的技能（复用搬进 shared 的解析逻辑），逐条按 DSH 规则判定：
  - 缺 `name`：DSH 整条丢弃；
  - 名字不是小写短横线；
  - 目录层级超过一层，例如放在分组目录里的技能；
  - 所在的根 DSH 不扫：`.pi/skills`，以及仓库根与 cwd 之间各级的 `.agents/skills`；
  - 与更高优先级的同名技能冲突：DSH 先到先得，1.0.x 是后到覆盖；
  - YAML 写法：1.0.x 只认单行标量，DSH 用真正的 YAML，一般只会更宽松，只列提示。

  扫描在宿主里执行（加密机上只有宿主读得到明文），结果经 bridge 的 `capabilities.skillIssues` 和设置页的「检查兼容性」回报。只列名字与原因，不改用户文件。
- 否决与后备：
  - B 兼容提供者，经 `ctx.skills.registerProvider` 读 `.pi/skills` 与多层目录：能救回「位置不对」的一类，救不回「名字不合规」的一类，因为注册表直接拒绝（`dsh-skill/README.md:66`）。先看报告里的数量，再决定要不要做；
  - C 把技能复制到 `$DSH_HOME/skills` 并改写 frontmatter：动用户数据，副本还会漂移，否决。
- DSH 带来的变化：技能热更新；`/name` 出现在消息任何位置都会触发，不限行首；可以用 `user-invocable`、`whenToUse` 等新字段。

### 2.3 prompts 与斜杠命令（D10 A）

- 把 `runtime/plugins/skills/templates.ts` 与 `expand.ts` 的纯逻辑搬进 `src/shared/skills/`，runtime 里改为 re-export，旧用例原样跑。宿主侧的加载器读 `<agentDir>/prompts` 与 `<cwd>/.pi/prompts`，规则与上限同 1.0.x。
- `startSend` 处理一条以 `/` 开头的消息，依次：
  1. 窗口内置命令（new / settings / archive / compact）由渲染层处理，到不了宿主，照旧；
  2. DSH 命令：`ctx.commands` 能找到就执行，不开模型回合（P1-4d 已规划）；
  3. 模板：`/name 参数` 展开成正文，替换整条消息；
  4. `/skill:<name>` 改写（§2.2）；
  5. 其余原样作为提示词发出。
- `commands()` 合并三类：DSH 命令（source `dsh-command`）、模板（`prompt`）、用户可调技能（`skill`，名字仍写 `skill:<name>`）。模板与 DSH 命令同名时模板被遮蔽，写进兼容报告。
- 否决的选项：B 把模板转成 `disable-model-invocation` 的技能，会丢掉「整条消息替换」和位置参数，语义不同；C 是纯倒退。

### 2.4 自定义子代理（D11 A，与 P1-7 一起拍板）

- 新行 `aiclient-delegates`（我方 bundle）：
  - 定义来源不变：`<agentDir>/subagents`、`~/.agents/subagents`、4 个内置。解析复用 `shared/subagentDefinition.ts`，目录与合并规则从 `runtime/plugins/subagent/catalog.ts` 搬进 shared；委派总开关与停用名单随 `configure` 下发；
  - 注册一个委派工具（名字待定），参数 `{agent: 定义名枚举, task, run_in_background?}`，描述里列出启用的定义名与描述，最多 16 个；
  - 执行：`ctx.subagents.start('spawn', {prompt, parent: exec.agent, signal: exec.signal, persona, toolFilter, agentOptions})`（`dsh-subagent/lib/types/types.d.ts:136-192`）。
- 字段映射：
  - 正文 → `persona`，`{{`、`}}` 要转义，因为 persona 按 `{{…}}` 严格插值；
  - `tools` → `toolFilter`，取「全局工具减去允许集」的补集。1.0.x 的 Read / Glob / Grep / Edit / Write / Bash 对应 DSH 的 read / glob / grep / edit / write / bash（Windows 上是 pwsh）；BrowserPreview 没有对应；委派类工具一律排除，防止嵌套，与 1.0.x 一致；
  - `model` → `agentOptions` 的 provider / model，经 P1-5 的计划索引翻成路由（决策 035）；`thinkingLevel` → 档位（决策 040）；
  - `permission` → 按 inherit（决策 049）；
  - `maxTurns` → 可选：插件数子会话的步数，超了就中断；`idleTimeout` / `maxDuration` 在 1.0.x 本来就不生效。
- 与 DSH 通用 `subagent`、`subagent_fork` 并存：通用工具负责临时委派，我方工具只承载「有名字的代理」，两边的工具描述要写清分工。两类都是 DSH 子会话，子代理面板与活动流由 P1-7 统一处理。
- 委派总开关关掉时，overlay 关掉 `tool-subagent*` 各行与 `aiclient-delegates` 行；这是宿主级的，重启后生效。
- 否决的选项：
  - B 每个启用的定义生成一行 `dsh-tool-subagent`（`toolName` 取定义名）：不用写代码，但每个定义占一个工具 schema，改定义要重启宿主；
  - C 只留通用 `subagent`：用户的自定义代理全部失效。

### 2.5 MCP（D7 A）

- 搬：`runtime/plugins/mcp/config.ts`（三层合并、`disabled`、预算）、`client.ts`（stdio JSON-RPC，改为使用 `ctx.subprocess` 交出的双工流）、命名与结果折叠，都搬进 `src/shared/mcp/`。runtime 版改为薄封装，`mcp.test.ts` 的用例原样跑（同 P1-6a 的做法）。
- 新行 `aiclient-mcp`（我方 bundle）：
  - slot bootstrap 时按会话 cwd 与信任状态读三层配置，并行连接，预算与超时同 1.0.x；
  - 进程经 `ctx.subprocess.spawn`（`stdio: 'pipe'`）起，cwd 为会话工作区，环境为宿主环境加上条目里的 `env`；Windows 上走 runner 与 Job，符合 ARD D11 第 4 条；
  - 工具注册在该会话 agent 的 scope 里（实验 E4），名字 `mcp__<server>__<tool>`，参数 schema 原样转发；
  - 资源：给每个连接实现 `resources/list`、`resources/templates/list`、`resources/read`，经 `ctx.mcpResources.register` 注册，DSH 的三个资源工具随之出现。1.0.x 没有资源，这是净增；
  - stderr 写宿主日志；slot 关闭时 `terminate()`，并等进程退出；
  - bridge 的 `capabilities.mcpServers` 形状与 1.0.x 相同（`runtime/worker/nativeWorkerRuntime.ts:372-391`）。
- 过闸（与 P1-6 的分类表一起定）：`mcp__*` 构造 `ToolPermissionRequest{policySurface: 'mcp', policyValue: 'server:tool', path: cwd}`，与 1.0.x 的策略规则和授权记忆一致。插件内部保留「工具名 → server:tool」的映射，不从清洗过的名字反推。两个 list 类资源工具按发现类放行；`read_mcp_resource` 走 `mcp` 面，值为 `server:resources/read`。
- 与 1.0.x 的差异：服务器拿不到 Main 环境里名字像密钥的变量（决策 022；DSH 自己也会清洗，`dsh-subprocess/README.md:84`）。依赖 `GITHUB_TOKEN` 这类继承变量的服务器，要把变量写进 `mcp.json` 的 `env`。设置页和发版说明里要提示。
- 否决的选项：
  - B 白名单官方 `dsh-mcp-client`，由 Main 或宿主把 `mcp.json` 翻成行：配置格式、工具命名、能不能按会话挂载、cwd 怎么给都没核实；官方客户端自己起进程、绕开 subprocess 服务（`dsh-subprocess/README.md:84,150`），在加密机和 Windows Job 回收上都是新变量；宿主级挂载时一个服务器被所有会话共享，cwd 只有一个。官方包核实之后可以作为后续选项再评估；
  - C 放弃：1.0.x 的 MCP 用户全部倒退。

### 2.6 pi 插件（D12 A）

- 不加载、不迁移、不删除。插件页下方只读列出 `<agentDir>/settings.json` 的 `packages`（复用 `PiPluginService` 的解析，不调用 pi CLI），注明「新版不再加载；回装 1.0.x 仍可用」。能力弹窗里那句 pi 扩展说明同步改掉（`LeftDock.tsx:536-540`）。
- 如果 P1-11 决定保留 pi TUI（B），插件页的 pi 部分原样保留，只补一句「只对内置终端生效」。本方案不预设 P1-11 的结论。

## 3 白名单

### 3.1 清单 `src/dsh-host/plugins/allowlist.json`

| 字段 | 含义 |
|---|---|
| `name`、`version` | 包名与精确版本 |
| `integrity` | 与锁文件相同的 sha512；本仓库里的包（如 `@aiclient/*`）改记构建产物的目录哈希 |
| `kind` | `official`：`@deepseek-ai/*`，版本与钉住的 DSH 相同；`internal`：审过的社区包或我方的包 |
| `defaultEnabled` | 新用户是否默认开启，默认 false |
| `rows` | 该包的 bundle 补丁允许插入的行 id |
| `tools` | 每个工具的过闸分类（读 / 写 / 执行 / ask），以及写类取哪个参数作路径，供 P1-6 |
| `review` | 审查记录的路径、日期、审查人、结论 |
| `replaces` | 可选；改名时继承旧包的启用状态 |

### 3.2 构建期审计（P1-2 的构建脚本里加一步）

1. 清单与宿主的 `package.json`、锁文件双键一致：名字、版本、integrity 逐项相等。静态测试再核对一遍。
2. 对钉住的 DSH 跑 `evaluatePluginCompatibility`，只许通过，不许豁免。
3. bundle 补丁只能 `insert` 清单 `rows` 里的行，行的模块名必须属于本包；不许改已有的任何 id，例如打开 `session-log-deepseek`、关掉 `aiclient-permissions`。
4. 不带 `dsh.client`；没有 `bin`；安装脚本不执行（`--ignore-scripts`），并且冒烟要证明不跑脚本也能用。
5. 运行期依赖闭包里的每个包，要么在清单里，要么是钉住的 DSH 自带的。
6. 单插件体积与文件数不超上限（§4.5）；许可在允许的名单里，与 P1-2 的许可流程同一套。
7. 静态扫描敏感 API，生成报告给审查人对照（§6.2 第 5 项）。报告只作参考，不作放行依据。§6.2 第 5 项的**三条必拒项**不在此列：它们另有静态守卫，命中即测试失败（见 §6.2，[决策 153](../../decisions/153-e8-a-plugin-review-guard-choices.md)）。
8. 结果写进 `dsh-host-manifest.json` 的 `plugins` 段：名字、版本、说明、显示元数据、`rows`、`tools`、审查日期、体积。

### 3.3 启动期（扩展 `host.ts` 现有的组合审计，`host.ts:130-149`）

- bundles 只能是产品 bundle 加上「已启用 ∩ 清单」（§4.2）。
- `REQUIRED_DISABLED` 加上 `plugin-manager`、`tool-plugin-manager`，由决策 023 的 overlay 重申。
- `aiclient-bridge`、`aiclient-permissions`、`aiclient-credentials` 必须处于启用状态，否则拒绝启动。
- 组合里只许出现 bundle 层（产品与已启用插件）声明过的行。home 层补丁新插入的行：产品态拒绝启动并指明文件，开发态告警。这一条细化了决策 023（那里只要求「文件存在即告警」），需要一并审批。

### 3.4 维护、范围与准入

- **维护**：工程经 PR 修改，审查记录与清单放在同一个 PR。每次插件升版、每次 DSH 升版都重审（决策 003 第 2 条的升级流程里已有「复核白名单插件的 peer」）。
- **范围**：
  - 官方包：钉住版本的 `@deepseek-ai/*` 里 dsh-base 以外的包（npm 上共 300 多个，需联网盘点）。审查可以轻一些，因为与核心是同一发布者，但补丁审计和工具分类照做；
  - dsh-base 里默认关着的行（例如 `tool-ralph`、`skill-badge`）要打开，也按同一流程登记；
  - 内部白名单：审过的社区包，以及我方自己的插件包。
- **社区插件准入**：
  1. 提名：写明用途、替代方案、受众；
  2. 初筛：纯宿主（没有 `dsh.client`）、是 bundle、peer 兼容钉住的 DSH、许可可接受。P0-2 的筛法可以复用，下载量前 150 个里只有 14 个过这一关；
  3. 审查：按 §6.2 逐项查，写审查记录；
  4. 过闸分类：插件工具默认走 `'*': 'ask'`（决策 047）。审查可以给工具补分类（读类在 auto 档放行；写类指明路径参数，accept-edits 才能判断），但不能归入「内部工具直接放行」；
  5. 集成：真宿主加假网关冒烟，断网断言，Windows CI；
  6. 合入清单与锁文件，写发版说明；
  7. 下架：从清单删除，新版启动时 reconcile 自动停用，并在界面提示。

## 4 预装、离线与升级

### 4.1 构建（接在 P1-2 方案 §3.2 的流水线上）

- 白名单插件写进 `src/dsh-host/package.json` 的 `dependencies`（精确版本），锁文件里带 `integrity`。`npm ci --ignore-scripts` 往暂存区装时，npm 会按 integrity 校验。
- 之后照 P1-2 的步骤物化、B 档裁剪、校验、生成许可清单，再跑 §3.2 的插件审计。
- 预期问题（实验 E2，推断）：npm 7 以后会自动装 peer，而且 npm 匹配预发布版本比 DSH 严（不带 `includePrerelease`）。像 `^0.1.0-rc.6` 这样的 peer 范围可能被判为不满足，导致 `ERESOLVE`。候选解法是 `overrides`，或者由构建脚本单独解包插件。要在 CI 上或经授权联网验证。

### 4.2 宿主启动时重申 bundles（扩展 P1-3a 的 `reconcileProductBundles`）

1. 从 `configure` 或环境变量取得启用集合。
2. 目标列表 = 产品 bundle（顺序固定）+（启用集合 ∩ 清单，按清单顺序）；`replaces` 里的旧名换成新名。
3. 目标与 profile 清单不同才写回（`writeProfileBundles`，`dsh-app-boot/lib/index.js:1084-1097`）。
4. `loadProfileDirectory(..., {userLayer: false})`：profile 用户层补丁不参与组合，文件非空就告警（`dsh-app-boot/lib/index.js:946,1026`）。
5. 插件 bundle 被跳过（peer 不兼容、读不到）只告警，`ready` 里带 `plugins: {enabled, skipped: [{name, reason}]}`；产品 bundle 被跳过仍然明确报错（决策 025 第 5 条）。

### 4.3 Main：启用集合与重启

- 启用集合存在 Main 的共享设置里（新键，例如 `dshPlugins.enabled`）；首次运行取清单的 `defaultEnabled`。
- 切换时走 `invalidateAll`（决策 025 第 2 条）。有在飞回合就排队，等空闲再重启宿主（仿决策 033 第 4 条）；界面提示「插件变更会重启 AI 引擎」。
- 列表数据来自构建产物清单，Main 不必问宿主。

### 4.4 pnpm 与 plugin-manager（D3，收口决策 016）

- 做法：从 `src/dsh-host/package.json` 删掉 `pnpm`；`host.ts` 删掉 `packageManager` 相关代码；bundle 补丁删掉 `plugin-manager` 的 registry 配置，改为 `disabled: true`；`tool-plugin-manager` 保持关闭，并加进 `REQUIRED_DISABLED`。
- 收益：用户机上唯一会联网、会写用户目录（`%LOCALAPPDATA%\pnpm`）的路径没了；进程内的插件也拿不到安装器；安装包少约 16 MiB；Q007 里「pnpm 打包代码的许可」这一项随之消失。
- 代价：DSH 的 `listBundles` / `setBundleEnabled` 用不上了，启用选择由我方写 profile 清单，约 50 行。以后要在运行期安装，另立决策。
- 前提：实验 E1 证明关掉这两行后宿主照常启动。

### 4.5 体积（决策 014）

- 插件与宿主同一套 B 档裁剪，同样计入每平台 128 MiB / 1.2 万个文件的硬上限。
- 去掉 pnpm，约 −16 MiB。
- 每个插件单独记体积与文件数。建议单插件默认上限 5 MiB / 500 个文件，超出要在审查记录里单独批准。
- 总上限在 P1-10a 落地时按实测重定（决策 014 已预告）。

### 4.6 升级、下架、回装

- 插件随应用版本整体替换，与钉住的 DSH 一起在构建期核过兼容，不需要迁移步骤。
- 启用集合在 Main 设置里，跨版本保留；`replaces` 处理改名；清单删掉的插件在新版被 reconcile 剔除，并在插件页提示「已下架」。
- 回装 1.0.x：它不读 `DSH_HOME`，也不认这些插件，没有影响。

### 4.7 否决的做法

- B 随包带 tarball，首次启动用 pnpm 离线装进 profile：pnpm 还得随包，还会写 pnpm store 与用户目录；首启多一个失败面；profile 里的副本不会随应用升级更换，DSH 一升级 peer 就可能失效（[P1-3 分片 02](../p1-3-shared-host/02-design.md) 第 174 行）；加密机上多一条「谁写的文件」链路（P0-2 证据第 289～291 行）。
- C 运行期从内部源装：需要内网 registry、签名与撤销机制，超出 P1。

## 5 界面

- 「扩展→插件」：
  - DSH 白名单插件列表：名称、版本、说明、来源（官方 / 内部审查）、能力标签、审查日期，只有启用开关；
  - 没有安装框，也没有删除按钮；
  - 切换时提示需要重启 AI 引擎；插件被跳过（例如 peer 不兼容）时显示原因。
- 同一页下方：1.0.x 装过的 pi 扩展的只读列表与说明（§2.6）。
- 「扩展→资源」：保留 skills / prompts 目录入口；补上 `~/.agents/skills`、项目 `.dsh/skills` 与 `.agents/skills` 的说明；显示兼容报告（不会加载的技能、被遮蔽的模板）；把项目指令链的差异写成说明文字。
- 「扩展→子代理」：保留；`permission` 字段标「新版按继承处理」；`maxTurns` 按 D11 的实现情况标注。
- MCP：仍然没有编辑页；设置页加一句「需要令牌的服务器，请把变量写进 `mcp.json` 的 `env`」。
- 能力弹窗：去掉 pi 扩展那句，改成已启用的 DSH 插件数；MCP 与技能照旧由 bridge 的 `capabilities` 提供。
- 与 P1-7 的边界：设置页、IPC、插件工具的过闸分类归本任务；聊天区里插件工具行的文案与图标、子代理面板归 P1-7。

## 6 安全

### 6.1 威胁面与运行期兜底

| 面 | 插件能做什么 | 运行期兜底 | 其余靠 |
|---|---|---|---|
| 凭据 | 调 `ctx.credentials.resolve` 拿网关 key；监听 IPC 读凭据应答；伪造凭据请求（实验 E8 实测） | 提供者只回答计划里的引用名（决策 034）。调用方可辨，但限制可绕过；应答在 `process` 级 IPC 上对同进程插件可见（[决策 150](../../decisions/150-e8-plugin-credential-isolation.md)） | 审查（§6.2 第 5 项的必拒三条） |
| 文件 | `ctx.fs`、`node:fs` 任意读写，不过闸 | 无 | 审查 |
| 子进程、网络 | `child_process`、`ctx.subprocess`、`fetch`，不过闸 | 无（代理只管路由，不管放行） | 审查 |
| 工具 | 注册的工具经 `tools/pre-execute` 过闸 | 决策 042 的闸门与同步 guard；插件工具默认 ask（决策 047） | — |
| 钩子 | 注册更靠前的 pre-execute、`approval/request`、`agent/request`、`llm/*` 监听者 | guard 兜住「闸门没被调到」 | 审查 |
| 组合 | bundle 补丁改写任意行 | 构建期补丁审计；启动期组合审计；隐私行 overlay | — |
| 持久化 | 经 `config-editor` 写 profile 补丁；调插件管理器装包 | profile 用户层不参与组合；plugin-manager 关闭、没有 pnpm | — |

结论：运行期兜底挡得住「配置被篡改」，挡不住「白名单里的代码作恶」。白名单插件与宿主同权，审查是唯一的硬防线。把插件隔离到进程外不在 DSH 的模型里，也不在 P1 范围。

### 6.2 审查单（每个包的每个版本一份记录）

1. **身份**：包名、精确版本、registry 的 integrity、发布者与维护者、源码仓库与 tag、许可（与 P1-2 的许可规则一致，禁 GPL / AGPL 一类）。
2. **安装期**：没有安装脚本，或者证明不跑也能用；原生二进制逐个列出并确认来源；没有 `bin`。
3. **依赖**：运行期依赖闭包逐个过；peer 只能是 `@deepseek-ai/*`，而且与钉住的 DSH 兼容。
4. **组合**：bundle 补丁只插自己的行；没有 `dsh.client`；补丁里的 `!!js` 表达式逐个看。
5. **敏感 API**（读源码，静态扫描辅助）：`ctx.credentials`、`process.env`、`process.send` / `process.on('message')`、`child_process` / `ctx.subprocess` / `spawnTerminal`、`fetch` / `http` / `https` / `net` / `dns` / `ws`、工作区外的 `fs` 写入、`eval` / `new Function` / 计算出来的动态 `import()`、`vm`、`worker_threads`、对 `Module` 或全局对象的猴子补丁、遥测或上报。
   - 上面这些由审查人读源码判断，构建期的扫描报告只作参考（§3.2 第 7 项）。
   - **必拒三条**（[决策 149](../../decisions/149-user-rulings-2026-10-07.md) 第 4 条裁决，判据出自[决策 150](../../decisions/150-e8-plugin-credential-isolation.md) §3）：包内（含它带进来的依赖闭包）出现任一条即**拒绝**。不做豁免，也不靠审查人解释放行。
     1. **凭据**：出现 `ctx.credentials` 或 `ctx.get('credentials')`（含 `inject` 里声明 `credentials`）。插件确有自己的凭据需求时单独走审批，P1 不提供。
     2. **宿主 IPC**：出现 `process.on('message')`、`process.prependListener`、`process.send`、`process.removeAllListeners('message')`。宿主的 IPC 通道是 Main 与 bridge 的私有通道，插件没有正当理由碰它。
     3. **逃出 Cordis 代理与猴子补丁**：出现 `Symbol.for('cordis.original')`；或者对 `ctx.get(...)` 返回的对象、`Module`、全局对象、`process` 做属性赋值。
   - **静态守卫**：`scripts/__tests__/dsh-plugin-review-guard.test.mjs` 逐文件扫描白名单插件，以及产品 bundle 挂载的非我方包（目前是 `dsh-office-tools` 与 `@deepseek-ai/dsh-tool-ask-user`）。命中任一条测试即失败，失败信息给出包名、文件、行、命中的判据。CI 的 `build.yml` gate 用 `pnpm test` 跑它。
   - 守卫只是静态近似，近似边界与盲区见[决策 153](../../decisions/153-e8-a-plugin-review-guard-choices.md)：动态拼出来的名字、经函数参数传递的别名、混淆代码，它都看不见。逐行读源码仍是主防线；守卫通过不等于审查通过。
6. **钩子**：有没有注册 `tools/pre-execute`、`approval/request`（自动应答就是 `aiclient-probe` 那一类问题，决策 015）、`agent/request`、`llm/*`、`system-prompt/assemble` 监听者，各自做什么。
7. **工具**：列出全部工具，给出过闸分类与路径参数；核对目录里标的能力是否属实（`dsh-office-tools` 标的是只读，实际会写文件）。
8. **数据**：会不会往外发数据；会在 `DSH_HOME` 或工作区之外写什么；需不需要自己的凭据（P1 不提供）。
9. **平台**：Windows 路径、原生件、会不会起外部可执行文件（关系到 P1-13 加密机按进程放行）。
10. **结论**：通过、带条件通过（例如默认关闭）或拒绝；写明复审触发条件：插件升版、DSH 升版。
