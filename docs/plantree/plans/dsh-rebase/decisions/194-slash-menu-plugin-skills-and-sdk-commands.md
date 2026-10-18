# 决策 194：斜杠菜单——首页列出插件的 skill（DSH 宿主新接口）；SDK 引擎的命令与 skill 能列、能看、能执行

日期：2026-10-18（北京时间）。**状态：第 1 节为用户裁决（决策 193 第 29 条）；第 2 节是盘点；第 4 节两点用户已定（2026-10-18，经上游会话转达）；第 3 节与第 4 节的落实方式为自主决定，待用户审批。**

分支：`feat/slash-skills-193-29`，从 `claude/s6-feedback`（`89d82245`）开出。

修订关系：

- [决策 175](175-slash-commands-before-session-start.md) §5 已知出入 2、3 与看板「没做：让宿主无会话时按任意目录列 skills」：本决策做掉——宿主加 `slashCommands` 接口，答复里有插件提供的 skill，也有 DSH 命令（`/goal`）。175 的读盘（`dshSkillCatalog.ts`）降为宿主答不了时的退路。
- 决策 175 §3.2 第 2 条（`none` 时借任意一个就绪 worker 的命令行）：撤销。池里现在有两种引擎的 worker，`ready[0]` 可能是 SDK 会话，首页或 DSH 对话会拿到 Claude CLI 的命令；DSH 的命令改由宿主答。
- 路线 B S-2 A-8（「SDK 引擎没有目标，`/goal` 不切姿态」）：不变。CLI 2.1.300 自己有 `/goal`，作为 CLI 的命令照官方行为发出。
- 路线 B 裁决 17（SDK 引擎照官方行为）、22（官方提示词只可在末尾追加）、19（用户层是 `~/.pilab/<配置名>/claude`）：遵守；偏离只在第 4 节用户定下的那几个命令（`/clear`、`/model`、`/effort` 由 PiLab 执行，`/config`、`/autocompact` 不发出）。
- [决策 174](174-home-page-and-composer-draft-target.md)（每个「新建」都回首页、预选这个对话的仓库）：`/new` 与 `/clear` 从对话里手打时，另外把这个对话的模型与思考强度带到首页（第 4 节 Q2）。

## 1 用户裁决（2026-10-18，决策 193 第 29 条）

1. 首页（还没开对话时）的斜杠菜单列出插件提供的 skill（需要宿主加接口）。
2. 用户追加：SDK 引擎（Claude Agent SDK）的斜杠命令、skill 等也要支持并在界面上显示。动工前先盘点 SDK 引擎现在能列出、能执行哪些，再定显示与执行方式。

## 2 盘点（`89d82245` 上逐条核实）

### 2.1 DSH 对话

| 场景 | 菜单的清单从哪里来 | 缺什么 |
|---|---|---|
| 已启动的会话 | `worker.commands`：`ctx.commands.list(agent)`（去掉 `plan`、`permission`、`feedback`，`compact` 归窗口）+ `ctx.skills.list({cwd, scope: agent})` 里 `user-invocable` 的（`bridge/commands.ts` `slashCommandRows`）。`ctx.skills` 汇总所有 provider，插件用 `registerProvider` 提供的也在内 | 不缺 |
| 同一工作区有别的就绪会话 | 借它的 `worker.commands`（`origin: workspace`） | 不缺 |
| 首页、没启动的对话 | Main 照 DSH 规则读盘列 skills（`dshSkillCatalog.ts`），命令行借池里**任意一个**就绪 worker（`origin: none`） | ① 插件提供的 skill 没有（读盘只认文件系统的五个根）；② 池里没有 worker 时没有 DSH 命令（`/goal`）；③ **新发现**：池里的 `ready[0]` 可能是 SDK 会话（`WorkerManager.getSlashCommands` 不看引擎），这时首页菜单出现 CLI 的命令 |
| 执行 | 选中只填 `/名字 `；发送时窗口自己的四个（new、settings、archive、compact）就地执行，其余原文发出：DSH 命令经 `ctx.commands.execute`，skill 由 `dsh-tool-skill` 在消息里认出注入 | 不缺 |

宿主侧（子代理调查，`file:line` 见交接）：Main 与宿主之间已有不经会话的「宿主控制」消息（`readPage`、`seedSession`、`complete` 等），新加一种照抄即可；`ctx` 是整个宿主共用的，`ctx.skills.list({cwd})` 不带 scope 读全局层（宿主行与插件都注册在这一层），`ctx.commands.list(undefined)` 是 DSH 的全局视图；宿主控制消息不带协议版本（一方不认识的种类丢弃并记日志），不用升版本，不用重录。白名单里目前只有 `dsh-office-tools`（默认关，不提供 skill），所以**眼下插件 skill 实际为零**，接口做好后插件一提供就能看到。

### 2.2 SDK 对话（CLI 2.1.300，SDK 0.3.300）

证据：新工具 `src/claude-sdk-host/tools/slash-inventory.ts`，按宿主的启动方式（流式输入、`settingSources` user + project + local、信任项目、独立 `CLAUDE_CONFIG_DIR`）对假网关跑。临时目录里放：用户层（配置目录）的 `commands/`、`skills/`，项目的 `.claude/commands`、`.claude/skills`（含一个 `user-invocable: false` 的）、一个会写标记文件的 SessionStart hook、一个本地目录插件市场（插件带一条命令、一个 skill）。2026-10-18 本机跑两遍，结果一致。

**SDK 能怎么列**（`sdk.d.ts`）：

- `query.initializationResult().commands` / `query.supportedCommands()`：`{name, description, argumentHint, aliases?, builtin?}`，CLI 起来、还没发消息就能拿到（实测 0.6～3.8 秒）。`builtin: true` 是 CLI 自带的（内置命令与随 CLI 的 skill），不带的是用户、项目、插件的。
- 第一条消息后的 `system/init`：`slash_commands`（只有名字）、`terminal_slash_commands`（只适合终端的：doctor、color、focus、reload-plugins）、`skills`、`plugins`。
- 会话中途变化推 `system/commands_changed`（整份替换）。
- `reloadSkills()` 也答一份 skill 清单，但与 `system/init.skills` 不一致（含自定义命令与 `user-invocable: false` 的，不含部分随 CLI 的），不拿来分类。

**列出了什么**（50 条）：

- 用户层与项目的 skill、自定义命令都在；`user-invocable: false` 的不在；**插件的命令与 skill 第二次启动起才在**（第一次启动时 CLI 才去装插件，与 README §5 记的一致），名字带插件前缀（`inv-plugin:inv-plugin-skill`，另有别名 `inv-plugin-skill`）。
- 随 CLI 的 skill（`builtin`）：deep-research、dataviz、update-config、verify、debug、code-review（别名 review）、simplify、batch、fewer-permission-prompts、doctor、loop、claude-api、workflow-authoring、run、run-skill-generator、plugin-authoring。
- 内置命令（`builtin`）：agents、auto-mode-setup、autocompact、clear（别名 reset、new）、color、compact、config（别名 settings）、output-style、context、effort、fast、focus、heapdump、init、mcp、model、`__remote-workflow`、workflow-launch-exec、reload-plugins、reload-skills、rename、security-review、usage（别名 cost、stats）、insights、recap、goal、list-agents、team-onboarding。
- **只为列清单起一个 CLI 也会跑仓库的 SessionStart hook**（标记文件出现）；在 flag 层加 `disableAllHooks: true` 后不跑，清单不变（50 条）。

**每条作为第一条消息发出时**（各起一个新会话）：

| 类别 | 命令 | 结果 |
|---|---|---|
| skill、自定义命令（用户、项目、插件） | 5 种都试了 | 发一次模型请求，正文进了请求（CANARY 词都回来了），参数接在后面 |
| 发模型请求的内置项 | deep-research、dataviz、update-config、verify、debug、simplify、batch、fewer-permission-prompts、doctor、loop、claude-api、workflow-authoring、run、run-skill-generator、plugin-authoring、init、insights、team-onboarding | 正常一轮 |
| 本地命令（不请求模型） | context、usage、model、effort、config、output-style、mcp、autocompact、rename、recap、goal、list-agents、color、reload-plugins、reload-skills、agents、auto-mode-setup、fast、focus、heapdump、`__remote-workflow`、workflow-launch-exec | 输出作为一条 `assistant` 消息到达（`model: "<synthetic>"`，没有流式帧），`result.result` 同文。`fast`：「Agent SDK 里不可用」；`focus`：「这里还不能用」；`agents`：「已移除」；`heapdump` 往桌面写堆快照；`__remote-workflow`、workflow-launch-exec 只在远程会话有用 |
| 后台任务类 | code-review、security-review | 起任务（`task_started` / `task_notification`）；security-review 的内嵌 shell（`git diff origin/HEAD...`）在没有远端的仓库里报错，属官方行为 |
| 改会话本身 | clear | 发 `conversation_reset`，CLI 换一个新会话 |
| 压缩 | compact | 「Not enough messages to compact.」（空会话） |

**PiLab 现在怎么做**（SDK 宿主 `sdkSessionRuntime.ts`）：

| 环节 | 现状 | 问题 |
|---|---|---|
| 菜单（会话里） | `commands()` 答 `system/init.slash_commands`，只有名字，一律 `source: command` | 第一条消息之前是空的；没有说明；skill 与命令不分；`terminal_slash_commands` 与在 SDK 里用不了的也在；`commands_changed` 不处理 |
| `/compact` | CLI 的 `compact` 行（`source: command`）在渲染层把窗口的同名内置项顶掉 | 手打 `/compact` 不走窗口的压缩流程（`worker.compact`），直接发给 CLI |
| 菜单（首页、没启动的 SDK 对话） | 走 DSH 的路：借 DSH worker 的命令、按 DSH 规则读盘（`.dsh/skills`、`.agents/skills`…） | 列出的全是 DSH 的东西，CLI 认不得；CLI 的 `.claude/skills`、`.claude/commands`、插件一个都不在 |
| 执行 | 原文作为用户消息发给 CLI（官方行为） | skill 与发模型请求的命令能用；**本地命令的输出看不到**：`ingestAssistant` 只在有流式步骤时处理，`<synthetic>` 消息被丢掉，用户只看到自己那条消息，回合静悄悄结束 |
| 重开后的历史 | `getSessionMessages` 投影；`CLI_MARKER_TEXT` 丢掉以 `<command-name>`、`<local-command-stdout>` 开头的用户行 | 本地命令：用户打的 `/context` 与输出都不见了（输出在 `system/local_command` 行，默认不读）；skill 与自定义命令：用户行是 `<command-message>…<command-name>/x</command-name><command-args>…`，**原样显示成一串标签** |
| 首页手打 | `homeSlashRefusal` 按 DSH 的规则拦 `/archive`、`/compact`、不带目标的 `/goal` | `/goal` 的说法是 DSH 的；SDK 下 CLI 的 `/goal` 自有用法 |

用户层：SDK 会话的 `CLAUDE_CONFIG_DIR` 是 `~/.pilab/<配置名>/claude`（裁决 19），用户的 skill 与命令放在它的 `skills/`、`commands/`，与 `~/.claude` 无关；DSH 的用户层仍是 `<agentDir>/skills` 等（决策 101、175），两个引擎各读各的。

## 3 方案（自主决定，待审批）

### 3.1 菜单按引擎区分（渲染层 + Main）

1. 渲染层的菜单请求多带一个 `engine`：已绑定的对话用 Main 报的引擎，没启动的对话与首页用 `chatEngineForDisplay` / `predictNewChatEngine` 的预测（与权限菜单同一个判断）；引擎变了（首页换模型）就重新请求。
2. `WorkerManager.getSlashCommands({sessionId?, workspacePath?, engine})`：点名会话在池里时以它的引擎为准；替身只找**同引擎**、同工作区的就绪 worker；`none` 时不再借任何 worker 的命令行（撤销 175 §3.2 第 2 条）。SDK 引擎不找替身（见 3.3 第 3 条）。

### 3.2 DSH：首页与没启动的对话问宿主（落实第 1 节第 1 条）

1. 新宿主控制 `{host:'slashCommands', id, cwd}` → `{host:'slash-commands', id, ok, result | error, ms}`（`dshHostProtocol.ts`、`channelMux.ts`）。宿主用 `commands.list(undefined)` 与 `skills.list({cwd})` 按 `slashCommandRows` 的规则出行（`bridge/commands.ts` `globalSlashCommandRows`），与会话里的菜单同一套规则：插件提供的 skill、DSH 命令（`/goal`）都在。
2. Main：`DshHostSupervisor.listSlashCommands(cwd)`。**不为菜单启动宿主**（宿主随应用启动，打字时也会预热，S-6 11c）；正在启动的等它，连同答复最多 5 秒；没有就绪的宿主、超时或失败时退回 175 的读盘（只有文件系统的 skills，没有命令）。
3. 不改 `worker.commands`、不改协议版本、不重录。

### 3.3 SDK：列清单

1. **会话里**（`sdkSessionRuntime.commands()`）：CLI 起来后取 `initializationResult().commands`，之后以 `commands_changed` 整份替换；不再用 `system/init.slash_commands`。CLI 还没起来（重开的对话，下一次发送才起）时，菜单打开就把这个会话的 CLI 起起来再答（等于把冷启动提前，发送时不用再等；SessionStart hook 随之提前到这一刻，与发送时起 CLI 跑的是同一次）。
2. 行的映射：`builtin` → `source: command`（CLI 自带，含随 CLI 的 skill）；其余 → `source: skill`（用户、项目、插件的 skill 与自定义命令；CLI 现在把自定义命令也当 skill）；名字带 `插件:` 前缀的 `scope: plugin`；`description`、`argumentHint` 照 CLI；别名不单列。
3. **没启动时**（首页预测是 SDK、没启动的 SDK 对话）：Main 起一个只列清单的宿主进程问 CLI（第 4 节 Q1，用户选 A）。替身不用：别的 SDK 对话的 CLI 不一定起着，借它就要替它起 CLI。
4. **菜单里不列**的（宿主侧过滤，渲染层不再判断）：
   - CLI 标为只适合终端的（`terminal_slash_commands`，2.1.300 是 doctor、color、focus、reload-plugins），以及 CLI 在 SDK 里明说用不了的 fast（「Agent SDK 里不可用」）；
   - 只对远程会话或调试有用的：`__remote-workflow`、workflow-launch-exec、heapdump；已移除的 agents；ListAgents 已禁（issue #22）对应的 list-agents；
   - 说明与用途都是 CLI 产品自身用量的：insights（「分析你的 Claude Code 会话」）、team-onboarding（「帮队友上手 Claude Code」）。产品界面不叫 Claude Code（路线 B §2 第 4 条）；手打照样发出；
   - `compact`：归窗口（与 DSH 相同），窗口的 `/compact` 走 `worker.compact`，SDK 宿主的 `compact()` 再发给 CLI；
   - 与 PiLab 自己的入口冲突的：见第 4 节 Q2。
   - 其余照官方全列（context、usage、init、rename、recap、goal、mcp、output-style、reload-skills、security-review、auto-mode-setup，以及所有 skill）。
5. **说明里出现产品名的**：update-config 的说明（「配置 Claude Code harness…」）换成宿主自己的一句（「配置 settings.json：自动化行为的 hooks、权限与环境变量」）；其他 CLI 行的说明若含「Claude Code」，这一行不带说明。

### 3.4 SDK：执行与显示

1. **发出**：照旧，原文作为用户消息发给 CLI（官方行为）；窗口自己的四个仍在窗口执行。
2. **本地命令的输出**：`<synthetic>` 的 assistant 消息在没有流式步骤时，宿主按一条完整的回复发出（开始、正文、结束），时间线上就是一条普通回复；`result.result` 不再另外显示。
3. **重开后的历史**：`<command-name>` / `<command-message>` 行还原成用户当时打的 `/名字 参数`；本地命令的输出在 `system/local_command` 行（父行是命令那一行），`<local-command-stdout>` / `<local-command-stderr>` 去掉标签作为紧跟其后的一条回复；`isMeta` 的 skill 正文行不显示（SDK 的读取器本来就不给，与直播一致）。实测 `getSessionMessages` 即使带 `includeSystemMessages` 也不给 `local_command` 行，所以与 S-6 的定时唤醒行一样，直接读会话文件（`transcriptExtras`）。窗口的 `/compact` 那一行与输出不显示（压缩有自己的摘要行，与直播一致）。
4. **首页手打**：`/archive`、`/compact` 两个引擎都拦（照 175）；`/goal` 的拦截只对 DSH（SDK 下是 CLI 的命令，原文发出，CLI 自己答用法）。
5. **说明的语言**：CLI 内置命令的说明是英文；照 DSH 命令的做法查词典，词典里加了会显示的 11 条内置命令、6 条较短的随 CLI skill 与 update-config 替换说明的中文（dataviz、claude-api、code-review 等长段说明不译，保持原文）；用户、项目、插件的 skill 保持作者原文。CLI 升级改了说法时，查不到就显示英文原文。
6. **按发送按钮后菜单不再残留**（点验时发现，两个引擎都有）：输入 `/context` 后用鼠标点发送，输入框清空了，菜单还按上一句的前缀开着，再按 Enter 会把那一行填回去。改为输入框不以 `/` 开头时菜单不显示。

### 3.5 界面

两个引擎同一个菜单、同一套来源标签：「内置」（窗口的四个）、「命令」（DSH 命令；SDK 的 CLI 自带项）、「技能」（DSH 的 skill；SDK 的用户、项目、插件 skill 与自定义命令）。插件的行名字里就带插件名。不另加「Claude」之类的引擎标注：一个对话只会显示它那个引擎的清单（3.1）。

## 4 用户定的两点（2026-10-18）与落实

下面先照录当时给的选项，再记用户的答复（经上游会话原话转达）与落实方式（落实方式为自主决定，待审批）。

**Q1：SDK 对话启动之前（首页模型是 Anthropic 协议的、没启动的 SDK 对话），菜单的清单怎么来？**

- **A（推荐）**：Main 临时起一个只列清单的 SDK 宿主进程，问 CLI 要清单后退出。清单与对话里完全一致（含插件、说明、随 CLI 的 skill）。代价：第一次打开约 1～4 秒才出全（窗口的内置项立刻有），期间多占约 250 MB；同一目录的结果缓存，下次打开先显示上次的、后台再刷新。列清单时 flag 层加 `disableAllHooks`，不跑仓库的 hook（实测）；受信任项目的插件市场照官方行为可能被拉取（与开一个对话相同）。
- B：Main 照 CLI 的规则读盘（`.claude/skills`、`.claude/commands`、用户层同名目录）加一份随 CLI 版本固定的内置清单（测试钉住）。快、不起进程；但插件的只能另读 CLI 的安装记录，规则要跟 CLI 升级，等于复刻 CLI（与 175 读盘的问题相同，而 DSH 这边本决策正是用宿主的答复取代读盘）。
- C：启动之前只显示窗口的内置项，发出第一条消息后才有完整菜单。

**用户：A。** 用户追问「现在不是本来在启动时就会拉起后端？还是仅仅 dsh 会拉起，claude 不会？」，上游答复：应用启动时只预热 DSH 共享宿主（打字时再预热）；SDK 引擎是每个对话一个宿主加 CLI，只在新建或重开对话时起，没有启动时预热。上游提议：列清单的 CLI 若能留给随后同目录、同模型新建的 SDK 对话用，就顺带省掉那次冷启动，做不到不强求，写进决策。

落实：

1. SDK 宿主新增**列清单模式**（`src/claude-sdk-host/catalog.ts`；`host.ts` 读 `AICLIENT_CLAUDE_SDK_CATALOG_CWD`）：起 CLI（流式输入、不发消息），读 `initializationResult().commands`，按 §3.3 的规则出行，回报 Main 后退出。flag 层 `disableAllHooks`（实测不跑仓库的 SessionStart hook，清单不变）。没有网关、没有 key：CLI 的网关地址指向宿主在本机开的一个立即答 503 的桩，没有请求到达它（实测）。不用桩时，Windows 上 CLI 连一个没人监听的端口要等约 19 秒；用桩后约 0.6 秒。给了文件夹就按受信任的项目读它的项目层（与打开的项目一致），主目录本身不当项目（同 S-3 P-11）；没有文件夹（首页「不选仓库」）只读用户层。
2. Main：`claudeSdkCatalog.ts` 起这个宿主，与对话的宿主同一种起法（随包 node、同一组启动变量，`claudeSdkHostLaunch` 由两者共用），25 秒没有答复就结束它。**按文件夹缓存**：菜单先显示上次的清单，超过 30 秒的在后台重列，下次打开就是新的；同一文件夹同时只列一次。只在 spawn gate 放行（登录或用户自己配了服务）后才起进程。
3. **没做：把列清单的 CLI 留给随后的新对话。** 两者的启动条件不同：列清单关了 hook、不带模型、不经宿主的鉴权代理；对话要开 hook、带选中的模型、经代理连网关，而 CLI 起来后不能再打开 hook 或换网关。SDK 的 `prewarm()`（alpha）能先起一个空进程、之后再绑目录与模型，但项目层的 skill 要绑定后才读，列不出首页要的清单。以后若要省掉新对话的冷启动，可以另做「首页选了 SDK 模型就 prewarm 一个」，与列清单分开。

**Q2：与 PiLab 自己的入口冲突的 CLI 命令怎么处理？**（`/clear`、`/model`、`/effort`、`/config`、`/autocompact`）

`/clear` 让 CLI 换一个新会话，PiLab 的记录仍指向旧会话（重开后回到 `/clear` 之前，直播的历史也对不上）；`/model`、`/effort` 绕过模型与思考档位选择（界面上的模型名与实际不符，S-6 第 3 条的同路由限制也被绕过）；`/config`、`/autocompact` 改 CLI 自己的设置（可能与宿主钉住的上下文窗口等冲突）。

- **A（推荐）**：菜单不列；手打时就地提示（例如「在 PiLab 里用 /new 开新对话」「请用输入框下方的模型菜单」），不发给 CLI，文字留在输入框。这是对裁决 17「照官方行为」的偏离，只限这五个。
- B：菜单不列，手打照官方发给 CLI（后果自负，界面可能与实际不符）。
- C：照官方全列、全发。

**用户**：「这个地方我建议同步一下，例如 /new 和 /clear 可以给并和 pilab 同步，/model 这种指令就屏蔽不给」；随后补充：「/model、/effort 就调用 pilab 的接口，而不是内部的。/config、/autocompact 可以先屏蔽。」

落实：

1. **`/clear`**（及 CLI 的别名 `/reset`）成为窗口自己的命令，与 `/new` 相同：回首页，预选这个对话的仓库（决策 174），并把这个对话的模型与思考强度写进新对话的默认（首页发送用的就是它，与在这个对话的模型菜单里点选一次相同）。原对话留在侧栏，历史不动；发出第一句话就是新对话。`/clear` 不发给 CLI，所以不会出现 CLI 换了会话、PiLab 记录对不上。`/new` 从对话里手打时同样带上模型与思考强度。首页菜单不列 `/clear`（没有可清的），手打等于 `/new`。
2. **`/model`、`/effort`** 成为窗口自己的命令，经输入框下方的模型菜单执行（`ComposerModelTrigger` 收到请求后照点选一行的规则处理：SDK 对话只能换同一服务的模型、思考强度只能选模型有的档位、同时更新新对话的默认）：
   - 不带参数：打开模型菜单（两项在同一个菜单里）。
   - `/model <名字>`：先按 id、显示名、去掉服务前缀的 id 完整匹配，再按唯一的部分匹配。唯一命中就切换并提示「模型：…」；命中的是这个 SDK 对话不能换的模型，提示「只能换同一服务的模型」，不切；没有或不唯一，打开菜单、把名字填进搜索框并提示。不能用名字选「自动」。
   - `/effort <档位>`：按 id、英文名、界面语言的名字匹配（`x-high` 与 `xhigh` 都算），`auto`、`default` 是「默认」；这个模型没有的档位，打开菜单并提示。
   - 两个引擎都这样（DSH 没有同名命令；skill 或插件命令占了这个名字时照旧它优先）。
3. **`/config`、`/autocompact`**（只在 SDK 对话里）：菜单不列，手打不发出，提示「PiLab 不发送 /config」并说去哪里改（设置在「设置」里；自动压缩按模型的上下文窗口，在「设置」里该模型所属的服务中改），字留在输入框。DSH 对话里照旧作为正文发出（DSH 没有这两个命令）。

## 5 验证计划

- 单测：`dshHostProtocol` 新消息的守卫；`channelMux` 的 `slashCommands`（有/没有实现、失败）；`globalSlashCommandRows`；`DshHostSupervisor.listSlashCommands`（就绪、启动中、超时、宿主退出）；`composerSlashCommands` 按引擎与来源；`WorkerManager.getSlashCommands` 不跨引擎；SDK 宿主行映射与过滤、`<synthetic>` 回复、历史投影；渲染层请求带引擎、首页 `/goal` 只拦 DSH、手打冲突命令的提示（Q2 选 A 时）。
- `probe-suite.ts` 新增 `slash` 组：会话里菜单（发消息前就有、有说明、过滤生效、`compact` 不在）、`/context` 直播出回复、skill 正文进请求、重开后历史里 `/context` 与 skill 那一行显示正确；Q1 选 A 时加清单进程（不跑 hook、插件第二次起出现）。
- `bridge-smoke.ts` 加宿主 `slashCommands` 一项。
- 两套 tsc（`pnpm typecheck`、`pnpm typecheck:dsh-host`）与 `typecheck:claude-sdk-host`；相关 vitest。
- 开发版、假网关（`claude-sdk` 与 `dsh-p0-2`）：首页（DSH 模型、SDK 模型各一次）、DSH 对话、SDK 对话各打开一次斜杠菜单，SDK 对话里发 `/context` 与一个 skill。

## 6 风险

1. CLI 的清单随版本变：过滤表按名字写，CLI 改名或加命令时新命令照官方显示，旧名字的过滤失效（只多显示，不会少）；`probe-suite` 的 `slash` 组钉住 2.1.300 的过滤结果，升级 CLI 时会报。
2. 只列清单的进程（Q1-A）在加密机上：与会话的宿主同一种起法（随包 node 起宿主、宿主经 SDK 起 `claude.exe`），放行规则相同；未上机验证。
3. 重开的 SDK 对话一打开菜单就起 CLI（3.3 第 1 条）：多占内存直到闲置回收，与发一条消息后相同。
4. DSH 宿主没起来时首页菜单没有插件 skill 与 DSH 命令（退回读盘）。宿主闲置 10 分钟会停（决策 025）；首页输入 `/` 这一下会触发打字预热（S-6 11c），菜单请求等启动中的宿主（最多 5 秒），开发版点验里首页菜单拿到了宿主的答复（有 `/goal`）。
5. `/usage` 显示 CLI 按官方价目算的费用，可能与网关实际计费不一致（官方行为，照列；决策 193 第 10 条的「费用不显示」说的是 Run 面板）。

## 7 实现与验证（2026-10-18，Windows 开发机）

提交：`02d8fa54`（本决策与 `tools/slash-inventory.ts`）、`6ad3ccb3`（§3.1、§3.2）、`ca4d7e9d`（§3.3、§3.4）、`742fd2e1`（§3.4 第 6 条）、`7de6e1ca`（Q2）、`975a4954`（Q1）。

第一轮（Q1、Q2 定下之前）：

- 两套 tsc 与 `typecheck:claude-sdk-host`：0 错。
- vitest：
  - `src/claude-sdk-host`：12 个文件 167 项过（新 `slashCommands.test.ts` 9 项，`sdkSessionRuntime` 新增 5 项）。
  - `src/dsh-host/bridge`、`src/shared/types`、`src/shared/__tests__`、`src/main/services/agent-host`、`src/main/ipc`：143 个文件，2476 项过、12 项失败。12 项都在本次没碰的测试里，是本机环境问题：Linux 专用（`dshHostScopes`）、Windows 下的符号链接与路径（`sessionGc`、`tempWorkspaceRecovery`、`ScratchWorkspaceService`、`settingsTemporaryPath`、`dshSkillCatalog` 的根目录表那一项用 POSIX 路径写的期望）。
  - `src/renderer/components/chat` 与 Static / Scan / Wiring：240 个文件，4083 项过、2 项失败（Windows 符号链接 EPERM、shiki 负载下 5 秒超时，与本次无关）。
- `bridge-smoke.ts` 加了宿主 `slashCommands` 一项（`hostMenuMatchesSessionMenu`），但它读 `/proc`，只能在 Linux 上跑，本机未跑。
- 开发版（`gui-probe.mjs`，隔离 HOME，假网关 `claude-sdk` 计划；DSH 模型走同一网关的 OpenAI 接口）：
  - 首页选 DSH 模型输入 `/`：`/goal`（只有宿主答得出）、项目与用户的 DSH skill、`/new`、`/settings`；没有 `/archive`、`/compact`，没有 SDK 的 skill。
  - DSH 对话：DSH 命令与 skill 加窗口的内置项。
  - SDK 对话：CLI 的命令与 skill（带中文说明），项目 skill 标「技能」；没有 clear、model、compact 的 CLI 行。
  - SDK 对话里 `/context`（表格）、`/usage`、`/reload-skills` 的输出都显示为回复；重启应用后重开这个对话，这几行按用户打的显示，输出跟在后面。
  - 用户层 skill 放进 `~/.pilab/<配置名>/claude/skills` 后，`/reload-skills` 说「1 added」，再发一条消息后菜单里才出现（CLI 下一条消息才推 `commands_changed`，官方行为）。
  - 另见（与本次无关）：重开 SDK 对话时，Main 先试 DSH 宿主的预览读取（`chat:readSessionPage`），报 `session_invalid` 后才走恢复，控制台留两条错误。

第二轮（按 Q1、Q2 的答复做完后）：

- 三套 tsc：0 错。
- vitest：`src/claude-sdk-host` 与 Main 的 agent-host、ipc 相关 45 个文件 784 项过、2 项失败（同上的环境问题）；渲染层 chat、stores、Static / Scan / Wiring 与 `src/shared/__tests__` 327 个文件 5651 项过、2 项失败（符号链接 EPERM；一项静态扫描负载下 39 秒超时，单独重跑通过）。新增：`slashModelCommand.test.ts` 10 项、`composerModelInteraction` 3 项、`homeSlashMount` 5 项、`claudeSdkCatalog.test.ts` 5 项、`catalog.test.ts` 2 项。
- `probe-suite.ts` 全部 10 组过（215 项），`slash` 组 15 项：列清单宿主答复、列出 CLI 命令与项目、用户层的 skill、不列 `compact` 与 `clear`；对话自己的 CLI 跑了项目的 SessionStart hook，列清单的那次没跑。
- 开发版：
  - 首页选 SDK 模型输入 `/`：列清单宿主给出 CLI 的命令与 skill（含项目与用户层的），加窗口的 `/new`、`/model`、`/effort`、`/settings`。
  - 首页 `/model claude-sonnet-5-5`：模型切过去；`/effort high`（这个假模型没有档位）：打开菜单并提示「这个模型没有「high」这一档推理强度」；`/model gpt-9`：打开菜单。
  - SDK 对话里 `/config theme=dark`：提示「PiLab 不发送 /config」，字留在输入框；`/model glm-fake-1`（另一个服务）：提示只能换同一服务的模型，模型不变。
  - SDK 对话里 `/clear`：回首页，仓库预选这个对话的，模型是这个对话的 claude-opus-5-5（首页之前是 claude-sonnet-5-5），原对话留在侧栏。

## 8 用户审批

- [x] 第 1 节（决策 193 第 29 条）
- [x] Q1 = A（2026-10-18）
- [x] Q2：`/new`、`/clear` 与 PiLab 同步，`/model`、`/effort` 走 PiLab 的入口，`/config`、`/autocompact` 先屏蔽（2026-10-18）
- [ ] 第 4 节两点的落实方式
- [ ] 第 3 节其余自主决定
