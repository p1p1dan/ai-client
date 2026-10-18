# S-6 加密机试用反馈：任务清单（2026-10-17 起）

用户在加密机上覆盖安装了 run 39014148606 的 `windows-installer`（`65fe570d`，1.1.1-test.1），从开始菜单启动，SDK 引擎会话能正常工作（用户口述）。随后用 Anthropic 协议的模型在 PiLab 里逐个试了工具与 skill，带回 12 条反馈。本页是这些反馈的任务清单，**换对话或换模型时从这里接着做**：先看下面的状态表，挑"待做"里排在最前的一项。

- 现场的会话记录在用户本机 `F:\temp\pilabtestback`（含用户名、路径与网关供应商名，**不入库**）；本页只放脱敏结论。
- 编号沿用用户反馈的序号；第 11 条拆成 11a～11c（GitHub issue #17～#19）；第 13 条是之后补报的。
- **在哪做**（用户 2026-10-17 定）：本地分支 `claude/s6-feedback`（工作树 `.claude/worktrees/windows-ci-timeout-handoff-9e97e7`，从路线 B 的 `672cd259` 开出），推送时推到远端的 `claude/claude-sdk-engine-mvp-162021`（`git push origin HEAD:claude/claude-sdk-engine-mvp-162021`，推前先问用户）。路线 B 原工作树 `.claude/worktrees/claude-sdk-engine-mvp-162021` 的本地分支不再在上面提交。若用户要先给 1.1.x 出补丁，#17～#19 与第 12 条改在 main 上做（待用户定，见 §3）。
- 还没推送的：`672cd259`（去掉 CI 的 `PROBE_PS_DIAG`，用户定为 S-6 之后一起推）与本清单之后的提交。
- S-6 本身：安装、开始菜单启动、读写加对话的回合都通过（用户口述）；`claude.exe` 文件头未记录，用户判断"加密了也没事，只要经 node 启动"，#46 待补记文件头后关闭。

## 1 状态表

| # | 反馈 | 类别 | 状态 |
|---|---|---|---|
| 1 | 为什么少了 11 个工具 | 已裁决（§3 第 1 条） | **已做**（探针、单测、开发版界面都过；Monitor/TaskList 是 CLI 非交互模式本来就不提供）；ReportFindings 与审查结果卡**已做**（并行分支 `ccv/s6-findings`，已合入）；卡片留在「最终输出」里不跟着折叠，用户已确认 |
| 2 | 官方行为与提示词不改，只可在后面追加 | 已裁决（§3 第 7 条） | **已记**（README 裁决 22） |
| 3 | SDK 对话开始后模型菜单只剩同一路由的模型 | 已裁决（§3 第 2 条） | **已做**（并行分支 `ccv/s6-parallel`；单测、开发版界面都过） |
| 4 | 子代理与后台任务只在输出里有，后台任务窗与子代理页都看不到 | 直接修 | **已修**（探针、单测、开发版界面都过） |
| 5 | WebFetch 报"无法验证域名是否安全" | 已裁决（§3 第 6 条） | **已修**（本机探针与单测通过） |
| 6 | 网关 502 `empty_stream`，随后 503"所有供应商暂时不可用" | 已实测（真实网关） | **结论：上游网关问题，PiLab 不改**；空流未复现 |
| 7 | 左侧工作区标出当前对话记录文件的位置 | 已裁决（§3 第 8 条） | **已做**（单测、开发版界面都过） |
| 8 | 计划审阅卡里放计划的框太小 | 直接修 | **已修**（单测、开发版界面都过） |
| 9 | `loop` 能加载但跑不起来 | 随第 1 条 | **已做**（ScheduleWakeup 实测可用；`/loop` 本身未单测） |
| 10 | 加开发人员模式开关，收起不该给用户调的设置 | 已裁决（§3 第 3 条） | **已做**（并行分支 `ccv/s6-parallel`；单测、开发版界面都过） |
| 11a | issue #17：`/compact` 后出现两条「上下文摘要」 | 直接修（DSH） | **已修**（单测通过，界面待复核） |
| 11b | issue #18：新装登录后模型按钮显示「自动」 | 直接修 | **已修**（单测、开发版界面都过） |
| 11c | issue #19：首次发送连接慢；发送前不能完全放行；全自动模式鸡肋 | 已裁决（§3 第 4 条） | 全自动**已做**，用户对决策 191 第 5 节的裁决也**已做**（开发版实测）；告诉模型的权限说明**已做**（2026-10-18 在 Linux 开发机上改了那句话并重录 3 个样本，差异只有这一句）；卡片上的原因说明用户定为保留；DSH 宿主随应用启动**已做**（首个新对话 1.94 秒降到 0.81 秒）；连接中改成一行**已做**；回合进行中整行改为动词打头的一行**已做** |
| 12 | 侧栏「按工作目录」时最新添加的目录排在最下面 | 直接修 | **已修**（单测、开发版界面都过） |
| 13 | Ctrl+Enter 插话卡在「待送达」、撤回显示「无法撤回」，之后的回复错位；另查排队与立刻发送 | 直接修 | **已修**（本机探针、单测与 CI 都过） |

## 2 逐项记录

### 1 少了 11 个工具

- **现象**：PiLab 的 SDK 会话只有 15 个工具：Agent、AskUserQuestion、Bash、Edit、EnterPlanMode、ExitPlanMode、Glob、Grep、NotebookEdit、Read、Skill、TaskStop、WebFetch、WebSearch、Write（从会话记录里的请求核对过，与模型自报一致）。
- **原因**：宿主有意禁掉了 11 个，`src/claude-sdk-host/sdkSessionRuntime.ts` 的 `HOST_ONLY_TOOLS`：CronCreate、CronDelete、CronList、ScheduleWakeup、RemoteTrigger、EnterWorktree、ExitWorktree、ListAgents、SendMessage、ReportFindings、Workflow。当时的理由是它们要靠 PiLab 没有的宿主能力（定时唤醒、跨会话消息、切换 worktree、审阅面板、工作流）。
- **另外**：Monitor、TaskList 等工具不在禁用名单里，但 SDK 的 `claude_code` 预设里也没有，是 CLI 自己在 SDK 模式下没给。要比对同版本 CLI（2.1.300）在命令行里的工具清单才能确定。
- **待裁决**：按裁决 17"都按官方行为来"，是否逐个放开。建议的判断法：放开后 CLI 自己就能完成的（如 EnterWorktree/ExitWorktree）直接放开；要宿主配合才有意义的（定时唤醒要 PiLab 在到点时把会话叫醒，SendMessage/ListAgents 要有别的会话可发）要么做配套，要么继续禁并在界面说明。
- **已做**（按 §3 第 1 条）：`HOST_ONLY_TOOLS` 只留 RemoteTrigger、ListAgents、SendMessage、ReportFindings、Workflow；放开 EnterWorktree、ExitWorktree、CronCreate、CronDelete、CronList、ScheduleWakeup。
  - **实测**（假网关）：EnterWorktree 在 git 工作区里建 worktree，随后的命令在里面跑，ExitWorktree 退出并删除；ScheduleWakeup 到点后 CLI 自己发起一轮并正常结束（最短 60 秒）。
  - **配套**：定时到点的回合以前会被当成"后台任务已结束"，现在宿主认出它（没有打开的回合时 CLI 开始执行一条不属于我们的命令），新增来源 `scheduled`，标题"定时任务到点，自动继续"；重新打开对话时按 CLI 记录里的 `turnOrigin: "scheduled"` 同样标出（SDK 自带的读取接口会丢掉这个字段，宿主直接读记录文件）。顺带修了：重新打开对话时后台任务通知（`<task-notification>…`）不再显示成用户消息，而是"后台任务／子代理已结束"的标题。工具行文案：定时类写成"已设定时（对话开着时有效）"，说明对话关掉后定时失效；worktree 两个写成"已进入 worktree / 已退出 worktree"；TaskStop 改称"已停止后台任务"，并按任务 ID 显示任务名。左侧「上下文」的「工作区」组在 SDK 对话进入 worktree 后多一行"当前 worktree"（从最近一次进入或退出的工具结果读出路径）。
  - **验证**：探针新增 `worktree`、`wakeup` 两个场景，回归套件单独成组 `hosttools`（6 条）；单测：工具文案 6 条、worktree 路径推导 1 条、定时来源 2 条、重新打开时的历史投影 1 条、标题文案 1 条。本机全套回归 9 组全过，录制门禁一致。
  - **Monitor、TaskList 查清了**：用随包的同一个 `claude.exe`（2.1.300）在命令行非交互模式（`-p`）下跑，启动时报告的工具清单里也没有 Monitor、TaskList（也没有 TodoWrite）；它们只在终端里交互运行时提供。SDK 会话属于非交互模式，所以不是 PiLab 禁掉的，预设也打不开。用户在命令行里对比看到它们，是交互模式。非交互模式的清单：Bash、CronCreate、CronDelete、CronList、Edit、EnterWorktree、ExitWorktree、Glob、Grep、ListAgents、NotebookEdit、Read、ReportFindings、ScheduleWakeup、SendMessage、Skill、Task、TaskStop、WebFetch、WebSearch、Workflow、Write；SDK 会话另有 AskUserQuestion 与计划模式两个。
  - **未做**：CronCreate 没有单独跑探针（与 ScheduleWakeup 同一条唤醒路径）；ReportFindings 继续禁用待用户确认。
- **ReportFindings 放开并做审查结果卡（用户 2026-10-17："放开并做配套"）**：交给另一个代理做（说明见 [s6-findings-brief.md](s6-findings-brief.md)），分支 `ccv/s6-findings`（b9af3db1、38bf0605，基于 a3bfd537），已合入 `claude/s6-feedback`（合并提交 28741282，无冲突）。
  - 宿主：`HOST_ONLY_TOOLS` 只剩 RemoteTrigger、ListAgents、SendMessage、Workflow。实测五个权限档位都不经过 `canUseTool`、不弹卡（CLI 把它定义成只读、没有自己的权限检查），宿主没加放行代码。
  - 渲染层：新文件 `reviewFindings.ts`（解析输入、短标签、默认展开）；`ToolRows.tsx` 把成功的调用画成卡片，失败或被拒的仍是普通工具行；`toolCard.ts` 补了动词与图标；`chatTurn.ts` 让报告单独成一组、放在「最终输出」里。
  - 对方自己定的：
    - 不超过 3 条全部展开，超过 3 条只展开第 1 条（最严重的），展开状态按会话记住。
    - **卡片不跟着折叠**：回合结束后它留在「最终输出」里，不进「已处理 N 个步骤」。理由是审查技能被要求不在正文里重复问题，折起来用户就看不到结果。说明里没写这条，用户 2026-10-17 确认保留（"审查结果卡留在「最终输出」里，不跟着折叠。"）。
  - 验证（对方）：两套 tsc 0 错；`src/renderer/components/chat` 3483 条、`src/claude-sdk-host` 149 条全过；probe-suite 9 组全过，其中 `hosttools` 新增 `findings` 场景 21 项；开发版看过卡片、点文件跳到行、窄宽两种布局、重新打开后从历史画出。没截到输入还在到达时的占位行（假网关太快），暗色主题与 Linux 没看。
  - 验证（合并后）：三套 tsc 0 错；`src/renderer`、`src/claude-sdk-host`、`src/shared`、`src/main/ipc`、`src/main/services/agent-host`、`src/preload` 的 vitest 只剩改动前就有的本机失败；probe-suite 的 `hosttools`（27 项）与 `flow` 两组通过。

### 2 提示词只追加不插入

- **核对结果**：已满足。宿主用的是官方预设提示词加 `append`（`PILAB_PROMPT_APPEND`，四行：运行在 PiLab 桌面应用里、工具调用显示为行、审批与提问显示为卡片、按用户的语言回复）。会话记录里的请求证实它在系统提示词的**最末尾**，前面官方内容一字未动。
- **仍算"改了官方行为"的地方**（供用户复核是否保留）：禁掉的 11 个工具（第 1 条）；`attribution: false`（提交与 PR 不带署名行）；`claudeMdExcludes`（不读 `~/.claude` 下的 CLAUDE.md，裁决 19）；`strictMcpConfig`（不读项目 `.mcp.json`）；用户级配置目录换到 `~/.pilab/<配置名>/claude`（裁决 19）。
- **已记**：README 裁决 22。

### 3 SDK 对话开始后只显示同一路由的模型

- **原因**：有意的，裁决 10"SDK 会话只在同一路由内换模型"。`src/renderer/components/chat/models.ts` 的 `modelCatalogForEngine` 对 SDK 会话只留同一 `sdkRoute` 的模型。会话已经绑定到 CLI 自己的会话记录，换到别的路由或 DSH 模型要"把前文打包进新对话"（README §8.2 #29），还没做。
- **待裁决**：保持现状但在菜单里加一行说明（"Agent SDK 对话只能换同一服务的模型，换其他模型请新建对话"）；或者把其他模型显示为灰色并带同样的提示；或者现在就做跨引擎换模型。建议先做灰色加提示，跨引擎换模型另排。
- **已做**（按裁决 25，分支 `ccv/s6-parallel`）：`models.ts` 新增 `modelMenuOptionsFor`：菜单按目录原顺序列出全部模型，`modelCatalogForEngine` 排除的（SDK 对话里其他路由与 DSH 的模型）标为 `locked`。`composerModel.ts` 把它们做成 `disabled` 的菜单项并带提示；`ComposerModelTrigger.tsx` 用 base-ui 菜单项自带的 `disabled`（`composerMenuItemClass` 原有的 `data-disabled` 灰显、不接收指针），提示用 `@/components/ui/tooltip`，挂在禁用项外面一层（禁用项不接收指针事件），文案「Agent SDK 对话只能换同一服务的模型，换其他模型请新建对话」走 i18n。点它不改选中值：菜单项禁用，`onClick` 与 `handleSelect` 各拦一道。只是显示变化：选中值、校验（存着的跨路由模型仍显示为「· unverified」的遗留项，且不再重复列出灰色那一行）与发送路径都不变，主进程照旧拒绝 `model_engine_mismatch`。DSH 对话与首页草稿不标灰。代码注释引用 [issue #23](https://github.com/p1p1dan/ai-client/issues/23)，跨引擎换模型做完后去掉锁。
- **验证**：挂载测试 `chat/__tests__/composerModelEngineFilter.test.ts` 改写并补到 8 条：SDK 对话里同路由模型可选、其他路由与 DSH 模型在各自分组里且禁用；悬停禁用项出现提示；点两种禁用项后会话存的模型、默认模板与按钮文字都不变；存着的跨路由模型仍是遗留项；DSH 对话与草稿没有禁用项、能选另一路由的模型。把两道拦截与 `disabled` 临时去掉后其中 5 条失败（已还原）。单测 `models.test.ts` 加 4 条（全量按序、锁的范围、禁用项带提示且不被选中、存着的锁定模型只列一次）。根 `pnpm typecheck` 0 错，`src/renderer/components/chat` 177 个文件 3450 条全过。界面上没有实点，等起开发版时复核；键盘停在禁用项上时看不到提示（提示只认指针悬停），待复核时看是否需要补。

### 4 子代理与后台任务在界面上看不到

- **现象**：Agent 工具起了 5 个后台子代理（CLI 都跑完了，会话目录里有 6 份子代理记录）；后台 `sleep` 也跑了。输出里只有"已委派……后台"，后台任务窗与子代理页都是空的。
- **原因（代码）**：SDK 宿主只把后台任务的**个数**报给界面（`backgroundTasks`），没有报每个任务的条目；子代理列表在每个对话第一回合时主动发了一份**空的**（`subagentCatalog` 投影为 `[]`），之后不再更新。后台任务窗（`BackgroundJobsWindow.tsx`）与子代理页读的是 DSH 那套投影，SDK 引擎没有填。
- **已修**（`src/claude-sdk-host/taskBoard.ts` 新增，`sdkSessionRuntime.ts` 接入）：
  - 宿主把 CLI 的 `task_started`、`task_progress`、`task_notification`、`background_tasks_changed` 折成三样界面已经会画的东西：`jobs` 投影（后台任务窗：后台命令、后台子代理、工作流）、`subagentCatalog` 投影（子代理窗口）、`subagent.activity` 事件（子代理的泳道：开始、进度、结束，以及它自己线程里说的话和调用的工具，工具入参只留名字和路径类字段并截断）。CLI 自己的杂务任务（ambient）不列。前台子代理有泳道和目录项，但不算后台任务。
  - `worker.panels` 答当前的 `jobs` 与 `subagentCatalog`；`worker.job.read` 读后台命令的输出文件（`<临时目录>/claude/<目录>/<会话 ID>/tasks/<任务 ID>.output`，运行中按 ID 找，结束后用通知里给的路径）；子代理任务的输出文件在 Windows 上是空的（实测），改为读它自己的记录 `subagents/agent-<任务 ID>.jsonl` 里说过的话。`worker.job.kill` 走 CLI 的 `stopTask`。
  - **停止后的残留进程**（Windows，与 #52 同类）：CLI 结束任务的 Git Bash 后，它起的 MSYS 进程（如 `sleep`）还活着。宿主在后台命令开始时就记下它那个 bash 的 MSYS 进程组（每条命令会出现两个 bash.exe，只认 Git Bash 进程表里有的那个；查找排队进行，窗口停止前先等查找完成），任务以"已停止"结束时（不论是窗口停止还是模型调 TaskStop）结束该组里剩下的进程。同时跑的另一条后台命令不受影响。
- **验证**：探针新增 `jobs` 场景（加进 `flow` 组）：后台命令进任务窗、结束时带退出码、能读输出、`panels` 一致；窗口停止后进程清零、另一条同时跑的不受影响；模型 TaskStop 后进程清零。`agent` 场景补 4 条：泳道开始与结束、子代理窗口列出、任务窗列为已结束的子代理任务、能读出子代理说的话。单测：`taskBoard.test.ts` 8 条、`sdkSessionRuntime.test.ts` 1 条。本机全套回归 8 组全过（`flow` 由 64 条增到 78 条），录制门禁一致。
- **未覆盖**：子代理泳道里的文字是整条消息，不是逐字流；工作流（Workflow）任务按裁决暂不放开，没测。界面上没有实点，等起开发版时复核。

### 5 WebFetch 报"无法验证域名是否安全"

- **现象**：WebFetch 对 example.com、www.iana.org 都报 `Unable to verify if domain ... is safe to fetch`；WebSearch 正常（经网关）。
- **原因**：CLI 在抓取前先向 `claude.ai/api/web/domain_info` 做域名预检，加密机所在网络到不了 claude.ai。
- **方向**：宿主在传给 CLI 的设置里加 `skipWebFetchPreflight: true`（用户提出的做法，CLI 官方设置项）。注意这会跳过官方的域名安全检查，抓取本身仍是直连外网、不经网关。
- **已修**：`sdkSessionRuntime.ts` 传给 CLI 的设置里加 `skipWebFetchPreflight: true`。实测 2.1.300 的预检连的是 `api.anthropic.com`（报错文字写的是 claude.ai）。
- **验证**：探针新增 `webfetch` 场景，回归套件单独成组（宿主在一个只记录连接目标、全部拒绝的代理后面启动）。修前代理只看到 `api.anthropic.com:443`，工具报"无法验证"；修后只看到 `example.com:443`，不再有预检。单测的启动设置断言同步更新。

### 6 网关 502 `empty_stream` / 503

- **现场**（脱敏）：同一个对话里三处出错，CLI 每次都重试，用户中断后重发即成功：AskUserQuestion 回答之后的那次请求、计划模式里写完计划文件之后的那次请求、用户说"测试 ExitPlanMode"之后的那次请求。CLI 收到的是 503"所有供应商暂时不可用"；网关一侧记的是上游 200 但流里只有 7 帧、1533 字节，在任何正文之前就 `message_stop`，被网关的流内容门禁判为空流（502），再对外报成 503。
- **初步判断**：不是某个请求必然失败：第三处失败的请求和随后成功的请求内容几乎相同。7 帧、约 1.5 KB 正好像"message_start、一个只有签名的 thinking 块、message_delta、message_stop"：模型这次只出了一个摘要式 thinking（请求里 `thinking.display` 是 `summarized`）就结束，网关门禁不把 thinking 当正文。若属实，这是网关门禁对 SDK 请求的误判，不是 PiLab 的问题；但 CLI 会连续重试 10 次，用户只看到卡住。
- **真实网关实测（2026-10-17，用户提供的网关与 key，用完即删，未入库）**：
  - 直接向网关发请求被拒（"this group only allows Claude Code clients"）；没有伪造客户端标识，改用随包官方 CLI 经 Agent SDK 发（与 PiLab 发法一致），中间加一个只在本机运行的记录代理，只记状态码、事件序列、内容块类型与报错，不记请求头和 key。
  - 跑了提问卡 7 轮、计划模式 6 轮（`claude-opus-5-5`，自适应思考、摘要式显示、effort medium）：共 32 个请求，26 个 200、6 个 502。**空流（`empty_stream`）一次也没出现**；200 的回复里没有"只有思考块就结束"的。
  - 6 个 502 都是 Cloudflare 的"源站返回了无效或不完整的响应"，每次挂 78～94 秒才报错，CLI 再等约 1 分钟重试后成功，所以一轮拖到约 3 分钟。期间用户改过一次网关设置，前后表现一样；用户判断是上游网关的问题（"status_code=502, Upstream service temporarily unavailable"）。
- **结论**：两种报错都发生在网关或其上游，不是 PiLab 造成的；PiLab 侧不改。最早那次的 `empty_stream` 是另一套网关的内容门禁，这次没能复现，"门禁把只有思考块的回复判成空流"的推断没有得到证实也没有被否定，需要那套网关的日志才能定。

### 7 标出当前对话记录的位置

- **需求**：左侧工作区显示当前对话的记录文件在哪里。
- **现状**：SDK 会话的记录是 CLI 自己写的 `~/.pilab/<配置名>/claude/projects/<目录名>/<会话 id>.jsonl`，子代理在同名目录的 `subagents/` 下；DSH 会话在 `dsh-home` 下。
- **已做**（按裁决放在左侧「上下文」页的「工作区」组）：新加一行「对话记录」，显示记录文件的完整路径，带复制与「在资源管理器中显示」两个按钮。主进程新增 `chat:locateTranscript`（`src/main/services/agent-host/transcriptLocation.ts`）：由对话的标识文件（`runtimeIdentity`）找记录；只接受两个标识目录里的文件，会话 ID 只许安全字符。SDK 对话找 CLI 的 `projects/<目录>/<会话 ID>.jsonl`；DSH 对话按标识文件里的 `dshSessionId` 找 `dsh-home/sessions/<目录>/<ID>/session.v4.jsonl.zstd`（压缩文件；还没写出时显示所在目录）。SDK 对话第一句发出前还没有记录，这一行不显示，回合结束后再查一次。单测：定位 4 条、面板模型 1 条。界面上没有实点，等起开发版时复核。

### 8 计划审阅卡的计划框太小

- **原因**：`src/renderer/components/chat/PlanReviewCard.tsx` 整张卡最高 `40vh`，里面标题、五个"批准，用……继续"、"继续讨论修改"都在同一个高度里，计划正文只剩很小的滚动区。
- **已修**：卡片最高放宽到窗口的 70%；选项区最高 30% 窗口、超出自己滚动；底部按钮固定在最下；计划正文占剩下的全部高度（至少 6 行左右）、单独滚动。原来的"展开/收起"换成"在大窗口中查看完整计划"，用 `@/components/ui/dialog` 打开只读的完整计划。单测按新布局改写。界面上没有实点，等起开发版时复核。

### 9 `loop` 跑不起来

- 与第 1 条同源：`loop` 要靠 ScheduleWakeup、Cron、Monitor、TaskList 来定时与续跑。
- **已做**：随第 1 条放开了 ScheduleWakeup 与 Cron 三个，`loop` 的自定节奏用的正是 ScheduleWakeup，实测到点能续跑。Monitor、TaskList 仍缺（见第 1 条"未做"），`loop` 里依赖它们的部分可能不全；`/loop` 本身没有跑探针。

### 10 开发人员模式开关

- **需求**：正式版里有些设置不该让用户随意改，应收进"开发人员模式"，默认关、默认值固定。
- **候选**（待用户定）：模型页的「Cache tool definitions」（实验、临时，`ExperimentalCacheControlSection.tsx`）；「Agent SDK engine」开关（`ClaudeSdkEngineSection.tsx`）；「Request identity (User-Agent)」（`RequestUserAgentSection.tsx`）；「Web Inspector」（`WebInspectorSettings.tsx`）。
- **方向**：设置里加开发人员模式开关；关着时这些项不显示，并且一律按默认值生效（不只是隐藏界面，已存的非默认值也不再生效）。打开的方法要不要藏起来（例如连点版本号）由用户定。
- **已做**（按裁决 26，分支 `ccv/s6-parallel`）：「高级」页末尾新增「开发人员模式」一节（`DeveloperModeSection.tsx`），开关明着放，默认关。设置键 `developerModeEnabled`，走现有持久化，`migration.ts` 只认布尔值。「模型」页的「请求标识（User-Agent）」「Agent SDK 引擎」「工具定义缓存断点」三节改由 `DeveloperModelSections`（`PiModelManagementSettings.tsx`）渲染，关着时不渲染。按默认值生效靠一处门控 `src/shared/developerMode.ts` 的 `applyDeveloperModeGate`：关着时这四个键（`experimentalCacheControlOnTools`、`claudeSdkEngineEnabled`、`requestUserAgentMode`、`requestUserAgentCustom`）读作未设置，各读取方落回自己的默认值。经它读取的有主进程的三个读取函数（`claudeSdkEngineSetting.ts`、`cacheControlOnToolsSetting.ts`、`requestUserAgentSetting.ts`；模型计划、新建对话选引擎、模型列表请求的 User-Agent 都经它们），以及渲染端 `ChatComposer` 预测引擎的两处（`stores/settings/developerMode.ts` 的 `effectiveClaudeSdkEngineEnabled`）。存的值不动，打开后恢复；开关一翻，缓存断点与 User-Agent 的监听照常重建模型计划，引擎开关仍只影响之后新建的对话。Web Inspector 不收。
- **验证**：单测 `stores/settings/__tests__/developerMode.test.ts` 6 条（门控只含这四个键、关着时读不到、打开后原样、迁移只认布尔值、持久化且翻开关不改存值）；主进程三个读取函数的测试各加「开发人员模式」一组（关着读到默认值、打开读到存值、开关翻转时重建模型计划），原有用例改为在开发人员模式下存值；挂载测试 `settings/__tests__/developerModeSection.test.ts` 4 条（「高级」页有开关且默认关；关着三节不渲染、打开后渲染并显示存的值、再关又不渲染；三节只在门控里出现；中文文案）。根 `pnpm typecheck` 0 错，`src/renderer/components/settings` 与 `src/renderer/stores/settings` 36 个文件 309 条全过。界面上没有实点，等起开发版时复核。

### 11a issue #17：`/compact` 后两条「上下文摘要」

- DSH 引擎的问题，issue 里已定位：`src/shared/dshHistory/projection.ts` 对每个压缩检查点都加一条摘要行，旧的不会被新的取代。方向按 issue：旧摘要行折叠或标"已被后续压缩取代"。
- **已修**（在界面层做，不动历史投影）：`src/shared/dshHistory/types.ts` 新增 `supersededSummaryIds`，时间线里除最后一条以外的摘要行都算被取代（历史按从新到旧分页加载，最新那条一定已在）。`MessageTimeline.tsx` 在顶层算出这组行、经 context 传给摘要卡，被取代的折叠成一行「上下文摘要 · 已被后续的压缩取代」，点开仍能看原文；最新那条照旧完整显示。挂载测试 2 条（`compactTimelineMount.test.ts` 的 17-TL-1、17-TL-2）。界面上没有实点，等起开发版时复核。推送后关闭 issue #17。

### 11b issue #18：新装登录后显示「自动」

- issue 里已定位：`models.ts` 的 `resolveModelSelection` 没有存过选择时回落到 Automatic，而菜单早已不列 Automatic。方向按 issue 的第一种：用模型计划或宿主给的默认模型作为显示值并写进新会话。
- **另一层原因**：`ComposerModelTrigger` 的 `hostDefaultModel` 在调用处（`ChatComposer.tsx`）从来没传，所以目录一到就只剩 Automatic。
- **已修**：`models.ts` 新增 `seedDefaultModel`：全局默认模板没有模型、目录已权威应答时，取目录第一个模型（与 DSH 模型计划 R9 定的宿主默认模型是同一个）写进默认模板；按钮显示它，发送也带上它，显示与发送一致。会话自己存的选择（包括老会话存的 Automatic）不动。单测：`models.test.ts` 3 条，`composerModelInteraction.test.ts` 原"空默认渲染后默认仍为空"一条按 issue 改成两条（新装草稿显示目录默认、不显示自动；存为自动的老会话保持）。界面上没有实点，等下一个测试包时复核。推送后关闭 issue #18。

### 11c issue #19：首次发送慢、发送前不能完全放行、全自动模式

- **发送前不能完全放行**：路线 B 裁决 16 已做（SDK 的「跳过权限确认」与 DSH 的「完全放行」发送前都能开，见 [开始页的跳过权限确认](bypass-before-first-message.md)），本测试包里已有。用户在加密机上复核即可关这一点。
- **首次发送慢（已实测，2026-10-17，开发版 + 本机假网关，开发机）**：从点发送到请求到达网关的时间（网关日志的到达时间减去点发送的时间）：

  | 情况 | 耗时 |
  |---|---|
  | SDK 新对话第一句（起 CLI） | 约 1.3 秒 |
  | DSH 新对话第一句（打开 DSH 会话） | 约 2.0 秒 |
  | 应用刚启动后的第一句（DSH 宿主在发送时才启动） | 约 2.1 秒 |
  | 任一引擎的后续句子 | 约 0.06 秒 |

  补量（同一次运行里连开两个新对话）把开销拆开了：DSH 宿主冷启动的第一个新对话 1.94 秒、宿主已在跑的第二个 0.31 秒，即启动宿主约 1.6 秒、打开会话约 0.3 秒；SDK 两个新对话 1.25 秒、1.13 秒，每个对话各起一个宿主与 CLI，每次都要付。

  界面 1 秒内就显示"工作中"，不是界面卡住。办公电脑与加密机更慢，再加上真实网关的首字延迟，就是 issue #19 说的"建立很久"。
- **可做的优化**：A. DSH 宿主随应用启动（现在是第一次发送才起）；B. 首页输入框开始打字时先建会话（SDK 会先起 CLI，一个草稿约 250 MB），发送时直接用。都是行为变化，要多占内存。
- **用户裁决（2026-10-17）**："DSH宿主随应用启动，sdk先保持现状"；并要求确认发送后是不是马上显示"工作中"，以及把启动时的两行（「✻ 工作中 2 秒」与「正在连接对话引擎… · 2s」）改成一行。
- **DSH 宿主随应用启动（已做）**：新文件 `src/main/services/agent-host/dshHostPrewarm.ts`。聊天界面挂载时调 `chat:ensureHost`，这里顺带让 DSH 宿主开始启动，不等待、失败只记日志。每次发送也会调 `chat:ensureHost`（SDK 发送也会），所以每次运行只预热一次：之后宿主按决策 025 自己的规则走（10 分钟没有会话就停，下一个 DSH 会话再起），SDK 发送不会把空闲停掉的 DSH 宿主再拉起来。登录前不启动，登录后的下一次调用再试。SDK 引擎不预热。单测 5 条。
  - 实测（开发版 + 本机假网关，同一台开发机）：

    | 情况 | 改前 | 改后 |
    |---|---|---|
    | 应用启动后第一个 DSH 新对话 | 1.94 秒 | 0.81 秒 |
    | 同一次运行里第二个 DSH 新对话 | 0.31 秒 | 0.32 秒 |

    宿主日志确认应用启动时就起了宿主，没有发送。第一个新对话仍比第二个慢约 0.5 秒，是新宿主上第一个会话自己的开销。
  - 已知的限制：没有任何 DSH 会话 10 分钟后宿主照旧会停（决策 025，约 180 MB），之后的第一句又要付约 1.6 秒。
  - **开始打字时再预热一次（用户 2026-10-17："可以改成开始打字时再预热一次"，已做）**：
    - 渲染层新文件 `dshHostWarmup.ts`：DSH 对话的输入框里草稿非空时，经新通道 `chat:warmDshHost` 请主进程启动宿主，每分钟最多一次。SDK 对话不预热。
    - 主进程每次都调 `prewarmDshHost`：宿主在跑就立即返回，登录前不启动，失败只记日志。
    - 单测 3 条，挂载测试 1 条（SDK 对话打字不请求，DSH 对话连续打字只请求一次；去掉接线后失败）。
    - 开发版实测：宿主空闲 10 分钟停掉后，在首页输入框打字（不发送），宿主约 0.1 秒内开始启动；随后发送，从点发送到请求到达网关 0.73 秒（冷启动时约 1.9 秒）。
- **发送后马上显示"工作中"（已确认）**：点发送后约 0.3 秒就出现「✻ 工作中 1 秒」，不用等首字。
- **连接中改成一行（已做）**：连接阶段（handshake）时，计时行带上「正在连接对话引擎…」这一段，下面那行状态不再画，变成一行「✻ 工作中 1 秒 · 正在连接对话引擎…」。`MessageTimeline.tsx` 在时间线根上放一个只给最后一轮的标记，计时行与状态行按同一个条件取舍。挂载测试 `turnHandshakeOneLineMount.test.ts`（2 条，改前第 1 条失败）。截图：[连接中一行](../evidence/s6-head-2026-10-17/connecting-one-line.png)。
  - 连上之后、首字之前（awaiting）仍是两行：「✻ 工作中 1 秒」下面一行「思索中… · ↑ 15 字符 · 0s」，见[截图](../evidence/s6-head-2026-10-17/awaiting-two-lines.png)。这一行按设计数的是当前阶段已沉默几秒（超时提示靠它），还带发出与收到的字数，与上面的总计时不是同一个数，所以没有合并；要不要也并成一行留给用户定。
    - 用户问为什么（2026-10-17），答复要点：第二行是这次发送的传输状态，整个回合都在（`turnStatus.ts`、`attachments.ts` 的 `composerSendingLine`）。首字前写「思索中…」、发出的字数和这一阶段沉默的秒数；有输出后写收到的字数；沉默到 45 秒、180 秒分别换成两档「仍在等待」提示；重试时带次数与倒计时。连接阶段那一行只有秒数，而且和计时行从同一时刻数起，所以并掉不丢信息；其余阶段并掉会丢掉沉默秒数和超时提示。可选做法：平时并成一行（「✻ 工作中 3 秒 · 思索中… · ↑ 15 字符」），只在变慢、卡住或重试时才出第二行。
  - **合成一行、动词打头（用户 2026-10-17："可以，但思考中不就显示思考中就可以了？"，已做）**：
    - 回合进行中只剩一行，动词打头，后面是总计时和字数（新文件 `turnLiveHead.ts`）：
      - 连接中：「✻ 正在连接对话引擎… 1 秒」；
      - 等首字、模型在思考、工具跑完等模型下一步：「✻ 思考中 3 秒 · ↑ 15 字符」（发出的字数只在等首字时有）。按用户的话，统一写「思考中」，不再用轮换的「思索中／酝酿中」；
      - 输出文字：「✻ 回复中 12 秒 · ↓ 1.2k 字符」；
      - 工具在跑：用工具自己的动词，如「✻ 运行中 20 秒」「✻ 编辑中 5 秒」；
      - 说不出在做什么时（比如窗口打开前就在跑的回合）才写「✻ 工作中 N 秒」。
    - 第二行只在一行说不下时出现：沉默 45 秒、180 秒的两档「仍在等待」提示，以及失败。重试的次数与倒计时在上方的重试横幅里，不再重复。
    - 没有回合可挂时的发送头（`PendingTurnHead`）也用同一行的写法。结束后的「已工作 N 秒 · 完成于」不变。
    - 测试：`turnLiveHead.test.ts` 9 条（含中文）；`turnHandshakeOneLineMount.test.ts` 改为 4 条，覆盖连接、等首字、沉默 45 秒仍有第二行、没有回合时的发送头，改前 4 条全失败；`interjectionDeliveryMount.test.ts` 的 3 处「Working」断言改为认「✻ 」开头的进行中行。
    - 开发版实测（DSH 全自动，假网关，一个 6 秒的 `Start-Sleep`）：依次显示「正在连接对话引擎… 1 秒」「思考中 1 秒 · ↑ 112 字符」「运行中 1～5 秒」「思考中 5 秒」「回复中 5 秒 · ↓ 21 字符」，然后结束。截图：[回复中](../evidence/s6-head-2026-10-17/verb-first-replying.png)、[运行中](../evidence/s6-head-2026-10-17/verb-first-tool.png)。
    - 发现的老问题（这次没改）：回合计时比实际少约 1 秒。计时的起点在回声到达后换成用户消息自己的开始时间，这个时间比点发送晚约 1 秒，截图里头部「运行中 1 秒」下面的工具行已经是 2 秒。代码里记为已知残留，要改需要把点发送的时间带到用户消息上。
  - 顺带修了计时一闪：发送后第一秒里计时会从「工作中 1 秒」跳成不带秒数的「工作中」再跳回来。原因是用户消息自己的开始时间比最近一次每秒刷新还晚一点，算出负数就当成"没有计时"。`turnTiming.ts` 的 `deriveTurnElapsedMs` 现在把不到一次刷新间隔（1 秒）的负数当成刚开始；更大的负数仍当成未知。单测 1 条。
- **全自动模式鸡肋**：要用户裁决：DSH 的全自动模式保留、改进还是去掉。
- **全自动已做**（按裁决 27，分支 `ccv/s6-parallel`，记为 [DSH 决策 191](../../dsh-rebase/decisions/191-dsh-full-auto-asks-less.md)）：`src/shared/permissions/gate.ts` 里全自动档对 shell 命令（bash、pwsh）只在两种情况下问：危险命令（新文件 `dangerousCommands.ts`：递归删除、强推与几种丢弃改动的 git 命令、格式化磁盘），以及命令写明了工作区外的路径（`/dev/null` 这类设备不算）。其余都放行，包括解析不了的参数（变量、`$(…)`、循环、PowerShell 脚本块、`python x.py`）。只经环境变量得到的路径（`$HOME`、`$env:TEMP`）算参数、不算写明，所以 `echo $HOME` 不问；两个分析器为此新增 `parameterPaths`，`checkShellPaths` 与 `authorizeTarget` 一路带到门上。所有 deny、完全放行、「每次询问」与「自动编辑」、文件工具、`run_code` 这类看不进去的工具和 DSH 自己的询问都不变。权限菜单与确认框里「全自动」的说明同步改了。**与说明不一致**：实测改前全自动对能解析的命令连工作区外路径也放行，所以「写明了工作区外路径的命令要问」是新加的，只加在 shell 命令上。
- **验证**：
  - 新增 `src/shared/permissions/__tests__/dangerousCommands.test.ts`（89 条）与 `autoGear.test.ts`（33 条）：全自动下 `echo $HOME`、`npm test $FLAGS` 这类工作区内命令不问；危险命令问；写明工作区外的命令问；deny 仍拒绝；完全放行不变。
  - `src/dsh-host/permissions/__tests__/bashGate.test.ts` 新增 22 条，用真实 bash 语法跑同一组情形。
  - 按旧行为写的 5 条用例改成「全自动不再问，自动编辑仍问」。
  - 根与宿主 tsc 0 错。
  - `src/shared/permissions` 只剩改动前就有的 3 条 `8dot3-*` 失败，`src/dsh-host/permissions` 只剩改动前就有的 2 条。
  - 界面上没有实点，等起开发版时复核。待用户定的 8 件事见决策 191 第 5 节。
- **用户对决策 191 第 5 节的裁决（2026-10-17）与落地**：详见[决策 191 第 6 节](../../dsh-rebase/decisions/191-dsh-full-auto-asks-less.md)。
  - 已做：
    - 任何删除都算危险命令；
    - 危险命令在除完全放行外的各档每次都问，不能按本会话允许，自动编辑也问；
    - 全自动下文件工具碰工作区外也问；
    - 卡片上标出原因（删除或丢弃改动、工作区外）。
  - 照旧问：`run_code` 这类看不进去的程序工具。程序在不受限的子进程里跑，可以绕开所有工具直接改文件，静态分析做不到可靠。
  - 留到 Linux 开发机：告诉模型的权限说明。改一句话，并重录 3 个样本（`perm-gear`、`plan-dismiss`、`plan-review`）。
    - **已做（2026-10-18，Linux 开发机，本地分支 `claude/claude-sdk-engine-mvp-162021`，基于远端 `62db8a14`）**：`promptText.ts` 里全自动那句改成"危险命令（任何删除、强推、hard reset 等）和写明了工作区外路径的操作仍然每次询问"。重录的 3 个样本只有这一句话变（`plan-review` 里出现两次）。
    - 全量 `bridge-record.ts --check`：36 个场景一致。Windows 上手改的 `perm-grants` 第三张卡与 Linux 上的录制结果一致，不用重录。
    - 三套 tsc 都是 0 错。`pnpm test` 全量：11934 条通过、65 条跳过、0 条失败。Windows 上因环境失败的几组（建符号链接、`8dot3-*`、`sessionGc`、`shellWorkdir`、`legacyShellAbsence`、`dshHostScopes`）在 Linux 上都通过。`bridge-smoke.ts` 也通过。详见[决策 191 第 6.3、6.4、6.6 节](../../dsh-rebase/decisions/191-dsh-full-auto-asks-less.md)。
  - 后续任务：剩下的询问交给便宜模型审核，配套改登录引导和管理员的模型设置页。
    - 2026-10-18 用户确认范围，方案写成 [DSH 决策 192](../../dsh-rebase/decisions/192-dsh-auto-review-model.md)（只做 DSH；危险命令也交给审核；不放行直接拒绝；没配置审核模型时不审核；登录服务仓库一起改）。用户看过 HTML 预览定了界面，**已做**（两个仓库都只在本地提交），用户在开发版上看过效果；落地与验证见决策 192 第 8 节。
  - 开发版截图两张（删除命令的卡、工作区外的卡），含本机用户目录路径，没有入库，留在开发机工作树的 `bugOutput/s6-cards/`。用户看图后定为保留（2026-10-17："卡片上的原因说明保留。"）。

### 12 侧栏「按工作目录」时最新目录在最下面

- **现象**（用户复核）：从左上角「添加仓库」按钮加的目录，追加在列表最后；期望是新加的排最上面。
- **原因（已定位）**：排序本身按添加时间倒序（issue #15、决策 186，`sidebarTree.ts` 的 `orderFoldersByAddedAt`），但左上角按钮打开的是添加仓库对话框，它走 `src/renderer/App.tsx` 的 `createRepositoryEntry`（本地、克隆、远程三种都经它），这个函数**没写 `addedAt`**。issue #15 的修复只给 `useRepositoryState.ts` 的 `handleAddRepository` 加了 `addedAt`，而对话框不走那条路。侧栏对没有时间的仓库按 0 算（`LeftNav.tsx` 的 `repo.addedAt ?? 0`），比所有老仓库启动时补上的时间都小，所以排在最下。
- **旁证**：重启应用后，启动时的补时间逻辑会按数组位置给它补一个最大的时间，它应该会跳到最上面。可以用这一点复核。
- **同类漏洞**：`useOpenPathListener.ts`（从外部用路径打开目录）新建仓库时也没写 `addedAt`。
- **已修**：`src/renderer/App/storage.ts` 新增 `stampAddedAt`，添加仓库对话框（本地、克隆、远程三种都经 `App.tsx` 的 `createRepositoryEntry`）与外部打开路径（`useOpenPathListener.ts`）都用它写入添加时间；`useRepositoryState.ts` 原本就写。单测 `App/__tests__/repositoryAddedAt.test.ts`：刚加的仓库排在启动时补过时间的老仓库上面。界面上没有实点，等下一个测试包时复核。

### 13 Ctrl+Enter 插话卡住，之后的回复错位

- **现象**（用户另一个对话，SDK 引擎）：Ctrl+Enter 发的"我删了"一直显示「待送达」，点撤回后变成「无法撤回」；前面冒出一个「后台任务已结束，自动继续」的回合，只有「已工作」没有正文；接着正常发送的"我应该运行哪个？"也只有「已工作」。重启应用后时间线恢复正常，两条都有回复。
- **复现**：本机假网关稳定复现。只要插话发在回合的**最后一段回复**里（后面没有工具步骤可以并入），每次都是：插话不回显、回合先结束、CLI 接着处理插话的那一轮被当成后台任务唤醒的回合。
- **原因**：插话进了 CLI 的命令队列，CLI 在本回合结束后单独跑它一轮。宿主原来靠结束消息里的 `queued_turn_count` 判断要不要保持回合，但 2.1.300 对这种插话报 0（实测），宿主就结束了回合并丢掉插话。于是：界面一直「待送达」；撤回时宿主找不到它，界面显示「无法撤回」；CLI 跑插话那一轮时宿主没有对应回合，就按后台任务回合打开（`openEngineTurn`）。界面的排队在第一个结束事件后就把下一条发了出去，CLI 却先跑插话，之后每一轮都错开一位，回复挂到错的回合下。重启后按 CLI 的会话记录重新投影，所以恢复。
- **修法**（`src/claude-sdk-host/sdkSessionRuntime.ts`）：改用 CLI 的 `command_lifecycle` 消息（每条命令 `queued`、`started`、`completed`，或 `cancelled`）。结束消息到达时，本回合还有 CLI 确认排着的插话，就保持回合，等 CLI 跑完它：插话在那一轮回显，回复挂在同一回合下。撤回时 CLI 已经开始跑它的，答「已送达」；撤回成功或 CLI 报 `cancelled`、而回合只在等它时，结束回合。CLI 报 `completed` 而没有哪一轮点名它时，也当作已送达：回显并放行回合，免得回合一直等。没有 lifecycle 消息的旧 CLI 仍按原来的计数判断。
- **排队与立刻发送**：排队是界面在回合结束后再发，立刻发送是先停止再发；两者都依赖宿主每回合只报一次结束。插话修好后不再多出结束事件。新加的 `sendnow` 场景（停止后马上发送）本机通过。
- **验证**：探针新增 `steer-late`（最后一段回复里四种时机插话）、`steer-withdraw`（插话后立刻撤回）、`sendnow`，都加进 `flow` 组；修前 `steer-late` 三种时机都失败，修后全过，原 `steer` 不变。单测加 6 条（`sdkSessionRuntime.test.ts` 的 "Ctrl+Enter after the last step"）。本机全套回归 7 组全过（`flow` 由 35 条增到 64 条），录制门禁一致，根与宿主 tsc 0 错；`src/shared` 的单测有 4 条失败（DSH 权限库的 8.3 短名与符号链接用例，与本改动无关，未在改动前复核）。
- **未覆盖**：撤回与 CLI 收下几乎同时发生时，宿主会先答「已撤回」而 CLI 仍跑了它（原有的已知限制，`withdrawInterjection` 注释里写着）。这个窗口很窄；若发生，界面上的气泡已撤回，CLI 仍会回答它。

### 开发版界面复核（2026-10-17）

用 `src/claude-sdk-host/tools/gui-probe.mjs` 起开发版（隔离的临时 home，只用本机假网关），逐项点过：

- **11b**：加上假服务并刷新后，首页模型按钮显示 `claude-opus-5-5`，不是"自动"。
- **12**：从左上角"添加仓库"依次加 repo-newer、repo-older，侧栏都是新加的排最上（repo-older、repo-newer、workspace）。复核时发现：对话框里输入路径后立即点"添加"会没加上（第一次没生效），等一会儿再点才行，像是路径校验是异步的；这是对话框原有行为，与本次修复无关，未处理。
- **8**：计划模式下 40 行的计划，审阅卡里正文能看到约 9 行，五个选项与按钮完整；"在大窗口中查看完整计划"打开大窗口，计划全文可读。
- **7**：「上下文」页「工作区」组出现"对话记录"一行，路径指向 CLI 的 `projects/<目录>/<会话 ID>.jsonl`，带复制与"在资源管理器中显示"。
- **4**：后台命令进后台任务窗，显示"已完成、退出码 0"，点"输出"能读到命令的输出。
- **1**：在 git 仓库里 EnterWorktree 后，「工作区」组出现"当前 worktree"一行；ScheduleWakeup 60 秒后自动发起的回合标题为"定时任务到点，自动继续"（闹钟图标）。复核时发现：对话开始后才把目录 `git init` 的，EnterWorktree 不会建出 worktree（CLI 在会话开始时就记下了目录是否是 git 仓库），属于 CLI 的行为。
- **未在界面上点**：11a（两条摘要折叠）只有挂载测试；第 5 条（WebFetch）只有探针。
- **合入 `ccv/s6-parallel` 之后**（3、10、11c 三项由另一个代理做，合并提交 `70835e79`）：
  - **10**：「高级」页有"开发人员模式"开关，默认关；关着时「模型」页里没有 User-Agent、Agent SDK 引擎、缓存工具定义三节，打开后三节出现。
  - **3**：SDK 对话的模型菜单里，另一服务（DSH 引擎）的 glm-fake-1 灰显，悬停提示"Agent SDK 对话只能换同一服务的模型，换其他模型请新建对话"，点了不改变选中项；首页草稿不灰显（按设计）。
  - **11c**：DSH 全自动的判断只有单测，假网关驱动不了 DSH 的工具调用，没在界面上点。
  - **复核中发现并修了**（`c07040fd`）：应用重启后重新打开对话，定时唤醒那一轮的标题丢了，两次回复并在一组里。原因是 SDK 读记录时会丢掉那条 `isMeta` 的定时消息；宿主改为从原始记录找出回应它的助手消息，在它前面补上标题，并扫描所有项目目录（进 worktree 后 CLI 会把记录文件挪到 worktree 的目录下）。复核：重开后"定时任务到点，自动继续"恢复；后台任务通知那一轮重开后显示"后台任务已结束，自动继续"，不再露出原始的 `<task-notification>` 文字。

### CI（2026-10-17）

用户同意后推送 `acee9b08` 到 `claude/claude-sdk-engine-mvp-162021`，手动跑一轮 Build（run 39035844957）：gate、app、Linux、Windows 作业全绿（macOS 照旧不看）。Windows 作业的回归套件 9 组全过（flow 78、modes 34、refused 3、errors 33、projcfg 12、scratch 9、home 4、webfetch 4、hosttools 6），录制门禁一致；`windows-installer` 产物已上传（到 2026-10-31），可作为下一个测试包。

## 3 用户裁决（2026-10-17）

1. **禁用的工具（第 1、9 条）**：
   - 直接放开：EnterWorktree、ExitWorktree（界面跟着显示当前所在目录）。
   - 放开并做配套：CronCreate、CronDelete、CronList、ScheduleWakeup（CLI 到点自己发起的回合要能显示，并说明对话关掉后定时失效）；`loop` 随之可用。
   - 继续禁用：RemoteTrigger；ListAgents、SendMessage 作为以后的优化项（[issue #22](https://github.com/p1p1dan/ai-client/issues/22)）。
   - 晚点放开：Workflow，等第 4 条的后台任务界面做好。
   - ReportFindings：用户不清楚用途，已解释（审查技能用它把发现的问题结构化交给宿主画成列表；禁用时改为文字输出）；建议继续禁用，待用户确认。
   - Monitor、TaskList：先用同版本命令行对比，查清 SDK 预设为何没有。
2. **模型菜单（第 3 条）**：选 B，其他模型显示为灰色，悬停提示要新建对话才能换。跨引擎换模型做完后再放开（[issue #23](https://github.com/p1p1dan/ai-client/issues/23)）。
3. **开发人员模式（第 10 条）**：按推荐。收进开发人员模式的是"缓存工具定义"、"Agent SDK 引擎"开关、User-Agent；Web Inspector 留在外面。开关明着放在设置里；关着时这些项隐藏，并且一律按默认值生效。
4. **DSH 全自动（第 11c 条）**：按推荐改进。工作区内解析不了参数的命令也放行，只有删除、强推这类危险命令和明确碰到工作区外的路径才问。
5. **分支**：#17～#19 与第 12 条都在路线 B 分支上改。
6. **WebFetch 预检（第 5 条）**：选 A，一律跳过。
7. **已有的偏离（第 2 条附带）**：不恢复，保持现状（不加署名行、不读 `~/.claude`、不读项目 `.mcp.json`）。"官方提示词不改、只可在末尾追加"记为 README 裁决 22（裁决 21 已被 DSH 权限那条占用）；本页 §3 的其余产品裁决记为 README 裁决 23～27。
8. **对话记录位置（第 7 条）**：显示在左侧「上下文」页面的「工作区」里。
9. **真实网关（第 6 条）**：等 5、8、12、11b 修完再安排；模型用 `claude-opus-5-5` 或 `claude-sonnet-5-5`，effort medium。用之前先问用户要网关。

## 4 建议顺序

先做不需要裁决、改动小的：5 → 8 → 12 → 11b → 2（记裁决）；再做 4（量大）、7、11a；裁决到了再做 1/9、3、10、11c；第 6 条等用户安排真实网关。
