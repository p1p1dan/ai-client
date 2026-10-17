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
| 1 | 为什么少了 11 个工具 | 已裁决（§3 第 1 条） | 待做 |
| 2 | 官方行为与提示词不改，只可在后面追加 | 已裁决（§3 第 7 条） | **已记**（README 裁决 22） |
| 3 | SDK 对话开始后模型菜单只剩同一路由的模型 | 已裁决（§3 第 2 条） | **已做**（单测通过，界面待复核） |
| 4 | 子代理与后台任务只在输出里有，后台任务窗与子代理页都看不到 | 直接修 | 待做 |
| 5 | WebFetch 报"无法验证域名是否安全" | 已裁决（§3 第 6 条） | **已修**（本机探针与单测通过） |
| 6 | 网关 502 `empty_stream`，随后 503"所有供应商暂时不可用" | 要实测（§3 第 9 条） | 待查（最后做，用真实网关前先问） |
| 7 | 左侧工作区标出当前对话记录文件的位置 | 已裁决（§3 第 8 条） | **已做**（单测通过，界面待复核） |
| 8 | 计划审阅卡里放计划的框太小 | 直接修 | **已修**（单测通过，界面待复核） |
| 9 | `loop` 能加载但跑不起来 | 随第 1 条 | 待做 |
| 10 | 加开发人员模式开关，收起不该给用户调的设置 | 已裁决（§3 第 3 条） | **已做**（单测通过，界面待复核） |
| 11a | issue #17：`/compact` 后出现两条「上下文摘要」 | 直接修（DSH） | **已修**（单测通过，界面待复核） |
| 11b | issue #18：新装登录后模型按钮显示「自动」 | 直接修 | **已修**（单测通过，界面待复核） |
| 11c | issue #19：首次发送连接慢；发送前不能完全放行；全自动模式鸡肋 | 已裁决（§3 第 4 条），慢要实测 | 全自动**已做**（单测通过，界面待复核）；首次发送慢仍待实测 |
| 12 | 侧栏「按工作目录」时最新添加的目录排在最下面 | 直接修 | **已修**（单测通过，界面待复核） |
| 13 | Ctrl+Enter 插话卡在「待送达」、撤回显示「无法撤回」，之后的回复错位；另查排队与立刻发送 | 直接修 | **已修**（本机探针与单测通过，待推送后 CI） |

## 2 逐项记录

### 1 少了 11 个工具

- **现象**：PiLab 的 SDK 会话只有 15 个工具：Agent、AskUserQuestion、Bash、Edit、EnterPlanMode、ExitPlanMode、Glob、Grep、NotebookEdit、Read、Skill、TaskStop、WebFetch、WebSearch、Write（从会话记录里的请求核对过，与模型自报一致）。
- **原因**：宿主有意禁掉了 11 个，`src/claude-sdk-host/sdkSessionRuntime.ts` 的 `HOST_ONLY_TOOLS`：CronCreate、CronDelete、CronList、ScheduleWakeup、RemoteTrigger、EnterWorktree、ExitWorktree、ListAgents、SendMessage、ReportFindings、Workflow。当时的理由是它们要靠 PiLab 没有的宿主能力（定时唤醒、跨会话消息、切换 worktree、审阅面板、工作流）。
- **另外**：Monitor、TaskList 等工具不在禁用名单里，但 SDK 的 `claude_code` 预设里也没有，是 CLI 自己在 SDK 模式下没给。要比对同版本 CLI（2.1.300）在命令行里的工具清单才能确定。
- **待裁决**：按裁决 17"都按官方行为来"，是否逐个放开。建议的判断法：放开后 CLI 自己就能完成的（如 EnterWorktree/ExitWorktree）直接放开；要宿主配合才有意义的（定时唤醒要 PiLab 在到点时把会话叫醒，SendMessage/ListAgents 要有别的会话可发）要么做配套，要么继续禁并在界面说明。
- **下一步**：列出 2.1.300 命令行与 SDK 两边的工具差集，每个工具写"放开后会怎样"，交用户逐个定。

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
- **方向**：宿主把 CLI 的 `task_started`、`task_progress`、`task_notification` 与子代理的会话记录映射成 DSH 同形的 jobs 与子代理投影；子代理页能打开子代理的记录（只读）。按官方行为，子代理能否被单独停止看 CLI 是否支持（`TaskStop` 可以停后台任务）。

### 5 WebFetch 报"无法验证域名是否安全"

- **现象**：WebFetch 对 example.com、www.iana.org 都报 `Unable to verify if domain ... is safe to fetch`；WebSearch 正常（经网关）。
- **原因**：CLI 在抓取前先向 `claude.ai/api/web/domain_info` 做域名预检，加密机所在网络到不了 claude.ai。
- **方向**：宿主在传给 CLI 的设置里加 `skipWebFetchPreflight: true`（用户提出的做法，CLI 官方设置项）。注意这会跳过官方的域名安全检查，抓取本身仍是直连外网、不经网关。
- **已修**：`sdkSessionRuntime.ts` 传给 CLI 的设置里加 `skipWebFetchPreflight: true`。实测 2.1.300 的预检连的是 `api.anthropic.com`（报错文字写的是 claude.ai）。
- **验证**：探针新增 `webfetch` 场景，回归套件单独成组（宿主在一个只记录连接目标、全部拒绝的代理后面启动）。修前代理只看到 `api.anthropic.com:443`，工具报"无法验证"；修后只看到 `example.com:443`，不再有预检。单测的启动设置断言同步更新。

### 6 网关 502 `empty_stream` / 503

- **现场**（脱敏）：同一个对话里三处出错，CLI 每次都重试，用户中断后重发即成功：AskUserQuestion 回答之后的那次请求、计划模式里写完计划文件之后的那次请求、用户说"测试 ExitPlanMode"之后的那次请求。CLI 收到的是 503"所有供应商暂时不可用"；网关一侧记的是上游 200 但流里只有 7 帧、1533 字节，在任何正文之前就 `message_stop`，被网关的流内容门禁判为空流（502），再对外报成 503。
- **初步判断**：不是某个请求必然失败：第三处失败的请求和随后成功的请求内容几乎相同。7 帧、约 1.5 KB 正好像"message_start、一个只有签名的 thinking 块、message_delta、message_stop"：模型这次只出了一个摘要式 thinking（请求里 `thinking.display` 是 `summarized`）就结束，网关门禁不把 thinking 当正文。若属实，这是网关门禁对 SDK 请求的误判，不是 PiLab 的问题；但 CLI 会连续重试 10 次，用户只看到卡住。
- **下一步**：用真实网关复现（用户可提供，用前先问）：抓一次失败时上游的原始帧，确认是不是只有 thinking；同一请求在 DSH 上是否也会这样。确认后的处理在网关侧（门禁把 thinking/签名算作有效内容），PiLab 侧最多改善报错文案。

### 7 标出当前对话记录的位置

- **需求**：左侧工作区显示当前对话的记录文件在哪里。
- **现状**：SDK 会话的记录是 CLI 自己写的 `~/.pilab/<配置名>/claude/projects/<目录名>/<会话 id>.jsonl`，子代理在同名目录的 `subagents/` 下；DSH 会话在 `dsh-home` 下。
- **已做**（按裁决放在左侧「上下文」页的「工作区」组）：新加一行「对话记录」，显示记录文件的完整路径，带复制与「在资源管理器中显示」两个按钮。主进程新增 `chat:locateTranscript`（`src/main/services/agent-host/transcriptLocation.ts`）：由对话的标识文件（`runtimeIdentity`）找记录；只接受两个标识目录里的文件，会话 ID 只许安全字符。SDK 对话找 CLI 的 `projects/<目录>/<会话 ID>.jsonl`；DSH 对话按标识文件里的 `dshSessionId` 找 `dsh-home/sessions/<目录>/<ID>/session.v4.jsonl.zstd`（压缩文件；还没写出时显示所在目录）。SDK 对话第一句发出前还没有记录，这一行不显示，回合结束后再查一次。单测：定位 4 条、面板模型 1 条。界面上没有实点，等起开发版时复核。

### 8 计划审阅卡的计划框太小

- **原因**：`src/renderer/components/chat/PlanReviewCard.tsx` 整张卡最高 `40vh`，里面标题、五个"批准，用……继续"、"继续讨论修改"都在同一个高度里，计划正文只剩很小的滚动区。
- **已修**：卡片最高放宽到窗口的 70%；选项区最高 30% 窗口、超出自己滚动；底部按钮固定在最下；计划正文占剩下的全部高度（至少 6 行左右）、单独滚动。原来的"展开/收起"换成"在大窗口中查看完整计划"，用 `@/components/ui/dialog` 打开只读的完整计划。单测按新布局改写。界面上没有实点，等起开发版时复核。

### 9 `loop` 跑不起来

- 与第 1 条同源：`loop` 要靠 ScheduleWakeup、Cron、Monitor、TaskList 来定时与续跑，SDK 会话里没有。随第 1 条一起定：放开并做配套，或者在 SDK 会话里不提供 `loop`。

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
- **首次发送慢**：要实测。记下新对话第一句从点发送到开始出字的时间，分 DSH 与 SDK 两种；SDK 首轮要起 `claude.exe`（约 270 MB），可能比 DSH 慢。测完再看是起进程、建连还是网关排队。
- **全自动模式鸡肋**：要用户裁决：DSH 的全自动模式保留、改进还是去掉。
- **全自动已做**（按裁决 27，分支 `ccv/s6-parallel`，记为 [DSH 决策 191](../../dsh-rebase/decisions/191-dsh-full-auto-asks-less.md)）：`src/shared/permissions/gate.ts` 里全自动档对 shell 命令（bash、pwsh）只在两种情况下问：危险命令（新文件 `dangerousCommands.ts`：递归删除、强推与几种丢弃改动的 git 命令、格式化磁盘），以及命令写明了工作区外的路径（`/dev/null` 这类设备不算）。其余都放行，包括解析不了的参数（变量、`$(…)`、循环、PowerShell 脚本块、`python x.py`）。只经环境变量得到的路径（`$HOME`、`$env:TEMP`）算参数、不算写明，所以 `echo $HOME` 不问；两个分析器为此新增 `parameterPaths`，`checkShellPaths` 与 `authorizeTarget` 一路带到门上。所有 deny、完全放行、「每次询问」与「自动编辑」、文件工具、`run_code` 这类看不进去的工具和 DSH 自己的询问都不变。权限菜单与确认框里「全自动」的说明同步改了。**与说明不一致**：实测改前全自动对能解析的命令连工作区外路径也放行，所以「写明了工作区外路径的命令要问」是新加的，只加在 shell 命令上。
- **验证**：
  - 新增 `src/shared/permissions/__tests__/dangerousCommands.test.ts`（89 条）与 `autoGear.test.ts`（33 条）：全自动下 `echo $HOME`、`npm test $FLAGS` 这类工作区内命令不问；危险命令问；写明工作区外的命令问；deny 仍拒绝；完全放行不变。
  - `src/dsh-host/permissions/__tests__/bashGate.test.ts` 新增 22 条，用真实 bash 语法跑同一组情形。
  - 按旧行为写的 5 条用例改成「全自动不再问，自动编辑仍问」。
  - 根与宿主 tsc 0 错。
  - `src/shared/permissions` 只剩改动前就有的 3 条 `8dot3-*` 失败，`src/dsh-host/permissions` 只剩改动前就有的 2 条。
  - 界面上没有实点，等起开发版时复核。待用户定的 8 件事见决策 191 第 5 节。

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
