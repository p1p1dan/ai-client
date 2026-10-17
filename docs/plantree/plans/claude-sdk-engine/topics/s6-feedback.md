# S-6 加密机试用反馈：任务清单（2026-10-17 起）

用户在加密机上覆盖安装了 run 39014148606 的 `windows-installer`（`65fe570d`，1.1.1-test.1），从开始菜单启动，SDK 引擎会话能正常工作（用户口述）。随后用 Anthropic 协议的模型在 PiLab 里逐个试了工具与 skill，带回 12 条反馈。本页是这些反馈的任务清单，**换对话或换模型时从这里接着做**：先看下面的状态表，挑"待做"里排在最前的一项。

- 现场的会话记录在用户本机 `F:\temp\pilabtestback`（含用户名、路径与网关供应商名，**不入库**）；本页只放脱敏结论。
- 编号沿用用户反馈的序号；第 11 条拆成 11a～11c（GitHub issue #17～#19）。
- **在哪做**（用户 2026-10-17 定）：本地分支 `claude/s6-feedback`（工作树 `.claude/worktrees/windows-ci-timeout-handoff-9e97e7`，从路线 B 的 `672cd259` 开出），推送时推到远端的 `claude/claude-sdk-engine-mvp-162021`（`git push origin HEAD:claude/claude-sdk-engine-mvp-162021`，推前先问用户）。路线 B 原工作树 `.claude/worktrees/claude-sdk-engine-mvp-162021` 的本地分支不再在上面提交。若用户要先给 1.1.x 出补丁，#17～#19 与第 12 条改在 main 上做（待用户定，见 §3）。
- 还没推送的：`672cd259`（去掉 CI 的 `PROBE_PS_DIAG`，用户定为 S-6 之后一起推）与本清单之后的提交。
- S-6 本身：安装、开始菜单启动、读写加对话的回合都通过（用户口述）；`claude.exe` 文件头未记录，用户判断"加密了也没事，只要经 node 启动"，#46 待补记文件头后关闭。

## 1 状态表

| # | 反馈 | 类别 | 状态 |
|---|---|---|---|
| 1 | 为什么少了 11 个工具 | 要用户裁决 | 待裁决 |
| 2 | 官方行为与提示词不改，只可在后面追加 | 已满足，记为裁决 | 已核对 |
| 3 | SDK 对话开始后模型菜单只剩同一路由的模型 | 要用户裁决 | 待裁决 |
| 4 | 子代理与后台任务只在输出里有，后台任务窗与子代理页都看不到 | 直接修 | 待做 |
| 5 | WebFetch 报"无法验证域名是否安全" | 直接修 | 待做 |
| 6 | 网关 502 `empty_stream`，随后 503"所有供应商暂时不可用" | 要实测 | 待查（需真实网关，用户可提供） |
| 7 | 左侧工作区标出当前对话记录文件的位置 | 直接做 | 待做 |
| 8 | 计划审阅卡里放计划的框太小 | 直接修 | 待做 |
| 9 | `loop` 能加载但跑不起来 | 随第 1 条 | 待裁决 |
| 10 | 加开发人员模式开关，收起不该给用户调的设置 | 要用户定清单 | 待裁决 |
| 11a | issue #17：`/compact` 后出现两条「上下文摘要」 | 直接修（DSH） | 待做 |
| 11b | issue #18：新装登录后模型按钮显示「自动」 | 直接修 | 待做 |
| 11c | issue #19：首次发送连接慢；发送前不能完全放行；全自动模式鸡肋 | 要实测 + 裁决 | 待查 |
| 12 | 侧栏「按工作目录」时最新添加的目录排在最下面 | 直接修 | 原因已定位，待修 |

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
- **下一步**：把"官方提示词不改、只可在末尾追加"记为裁决 21，写进 README §3。

### 3 SDK 对话开始后只显示同一路由的模型

- **原因**：有意的，裁决 10"SDK 会话只在同一路由内换模型"。`src/renderer/components/chat/models.ts` 的 `modelCatalogForEngine` 对 SDK 会话只留同一 `sdkRoute` 的模型。会话已经绑定到 CLI 自己的会话记录，换到别的路由或 DSH 模型要"把前文打包进新对话"（README §8.2 #29），还没做。
- **待裁决**：保持现状但在菜单里加一行说明（"Agent SDK 对话只能换同一服务的模型，换其他模型请新建对话"）；或者把其他模型显示为灰色并带同样的提示；或者现在就做跨引擎换模型。建议先做灰色加提示，跨引擎换模型另排。

### 4 子代理与后台任务在界面上看不到

- **现象**：Agent 工具起了 5 个后台子代理（CLI 都跑完了，会话目录里有 6 份子代理记录）；后台 `sleep` 也跑了。输出里只有"已委派……后台"，后台任务窗与子代理页都是空的。
- **原因（代码）**：SDK 宿主只把后台任务的**个数**报给界面（`backgroundTasks`），没有报每个任务的条目；子代理列表在每个对话第一回合时主动发了一份**空的**（`subagentCatalog` 投影为 `[]`），之后不再更新。后台任务窗（`BackgroundJobsWindow.tsx`）与子代理页读的是 DSH 那套投影，SDK 引擎没有填。
- **方向**：宿主把 CLI 的 `task_started`、`task_progress`、`task_notification` 与子代理的会话记录映射成 DSH 同形的 jobs 与子代理投影；子代理页能打开子代理的记录（只读）。按官方行为，子代理能否被单独停止看 CLI 是否支持（`TaskStop` 可以停后台任务）。

### 5 WebFetch 报"无法验证域名是否安全"

- **现象**：WebFetch 对 example.com、www.iana.org 都报 `Unable to verify if domain ... is safe to fetch`；WebSearch 正常（经网关）。
- **原因**：CLI 在抓取前先向 `claude.ai/api/web/domain_info` 做域名预检，加密机所在网络到不了 claude.ai。
- **方向**：宿主在传给 CLI 的设置里加 `skipWebFetchPreflight: true`（用户提出的做法，CLI 官方设置项）。注意这会跳过官方的域名安全检查，抓取本身仍是直连外网、不经网关。
- **验收**：本机挡住到 claude.ai 的访问后 WebFetch 能抓到页面；探针加一条。

### 6 网关 502 `empty_stream` / 503

- **现场**（脱敏）：同一个对话里三处出错，CLI 每次都重试，用户中断后重发即成功：AskUserQuestion 回答之后的那次请求、计划模式里写完计划文件之后的那次请求、用户说"测试 ExitPlanMode"之后的那次请求。CLI 收到的是 503"所有供应商暂时不可用"；网关一侧记的是上游 200 但流里只有 7 帧、1533 字节，在任何正文之前就 `message_stop`，被网关的流内容门禁判为空流（502），再对外报成 503。
- **初步判断**：不是某个请求必然失败：第三处失败的请求和随后成功的请求内容几乎相同。7 帧、约 1.5 KB 正好像"message_start、一个只有签名的 thinking 块、message_delta、message_stop"：模型这次只出了一个摘要式 thinking（请求里 `thinking.display` 是 `summarized`）就结束，网关门禁不把 thinking 当正文。若属实，这是网关门禁对 SDK 请求的误判，不是 PiLab 的问题；但 CLI 会连续重试 10 次，用户只看到卡住。
- **下一步**：用真实网关复现（用户可提供，用前先问）：抓一次失败时上游的原始帧，确认是不是只有 thinking；同一请求在 DSH 上是否也会这样。确认后的处理在网关侧（门禁把 thinking/签名算作有效内容），PiLab 侧最多改善报错文案。

### 7 标出当前对话记录的位置

- **需求**：左侧工作区显示当前对话的记录文件在哪里。
- **现状**：SDK 会话的记录是 CLI 自己写的 `~/.pilab/<配置名>/claude/projects/<目录名>/<会话 id>.jsonl`，子代理在同名目录的 `subagents/` 下；DSH 会话在 `dsh-home` 下。
- **方向**：在对话的右键菜单或对话信息里加"在资源管理器中显示记录文件"，必要时在左侧对话行的悬停信息里显示路径。具体放在哪里先给用户看两种位置再定。

### 8 计划审阅卡的计划框太小

- **原因**：`src/renderer/components/chat/PlanReviewCard.tsx` 整张卡最高 `40vh`，里面标题、五个"批准，用……继续"、"继续讨论修改"都在同一个高度里，计划正文只剩很小的滚动区。
- **方向**：计划正文给足空间（卡片高度放宽，按钮区固定在底部、正文区独占剩余高度），再加"展开查看完整计划"打开一个大的只读窗口（用 @coss/ui 的 Dialog）。

### 9 `loop` 跑不起来

- 与第 1 条同源：`loop` 要靠 ScheduleWakeup、Cron、Monitor、TaskList 来定时与续跑，SDK 会话里没有。随第 1 条一起定：放开并做配套，或者在 SDK 会话里不提供 `loop`。

### 10 开发人员模式开关

- **需求**：正式版里有些设置不该让用户随意改，应收进"开发人员模式"，默认关、默认值固定。
- **候选**（待用户定）：模型页的「Cache tool definitions」（实验、临时，`ExperimentalCacheControlSection.tsx`）；「Agent SDK engine」开关（`ClaudeSdkEngineSection.tsx`）；「Request identity (User-Agent)」（`RequestUserAgentSection.tsx`）；「Web Inspector」（`WebInspectorSettings.tsx`）。
- **方向**：设置里加开发人员模式开关；关着时这些项不显示，并且一律按默认值生效（不只是隐藏界面，已存的非默认值也不再生效）。打开的方法要不要藏起来（例如连点版本号）由用户定。

### 11a issue #17：`/compact` 后两条「上下文摘要」

- DSH 引擎的问题，issue 里已定位：`src/shared/dshHistory/projection.ts` 对每个压缩检查点都加一条摘要行，旧的不会被新的取代。方向按 issue：旧摘要行折叠或标"已被后续压缩取代"。

### 11b issue #18：新装登录后显示「自动」

- issue 里已定位：`models.ts` 的 `resolveModelSelection` 没有存过选择时回落到 Automatic，而菜单早已不列 Automatic。方向按 issue 的第一种：用模型计划或宿主给的默认模型作为显示值并写进新会话。

### 11c issue #19：首次发送慢、发送前不能完全放行、全自动模式

- **发送前不能完全放行**：路线 B 裁决 16 已做（SDK 的「跳过权限确认」与 DSH 的「完全放行」发送前都能开，见 [开始页的跳过权限确认](bypass-before-first-message.md)），本测试包里已有。用户在加密机上复核即可关这一点。
- **首次发送慢**：要实测。记下新对话第一句从点发送到开始出字的时间，分 DSH 与 SDK 两种；SDK 首轮要起 `claude.exe`（约 270 MB），可能比 DSH 慢。测完再看是起进程、建连还是网关排队。
- **全自动模式鸡肋**：要用户裁决：DSH 的全自动模式保留、改进还是去掉。

### 12 侧栏「按工作目录」时最新目录在最下面

- **现象**（用户复核）：从左上角「添加仓库」按钮加的目录，追加在列表最后；期望是新加的排最上面。
- **原因（已定位）**：排序本身按添加时间倒序（issue #15、决策 186，`sidebarTree.ts` 的 `orderFoldersByAddedAt`），但左上角按钮打开的是添加仓库对话框，它走 `src/renderer/App.tsx` 的 `createRepositoryEntry`（本地、克隆、远程三种都经它），这个函数**没写 `addedAt`**。issue #15 的修复只给 `useRepositoryState.ts` 的 `handleAddRepository` 加了 `addedAt`，而对话框不走那条路。侧栏对没有时间的仓库按 0 算（`LeftNav.tsx` 的 `repo.addedAt ?? 0`），比所有老仓库启动时补上的时间都小，所以排在最下。
- **旁证**：重启应用后，启动时的补时间逻辑会按数组位置给它补一个最大的时间，它应该会跳到最上面。可以用这一点复核。
- **同类漏洞**：`useOpenPathListener.ts`（从外部用路径打开目录）新建仓库时也没写 `addedAt`。
- **修法**：三处都写 `addedAt: Date.now()`，最好让所有新建仓库都经同一个构造函数；补单测：从对话框、克隆、远程、外部打开四个入口新加的仓库都排在最上。

## 3 要用户定的事

1. 第 1、9 条：11 个禁用工具与 `loop` 逐个怎么处理（先等工具差集清单）。
2. 第 3 条：模型菜单用哪种做法。
3. 第 10 条：哪些设置收进开发人员模式，开发人员模式怎么打开。
4. 第 11c 条：DSH 全自动模式的去留。
5. #17～#19 与第 12 条在路线 B 分支上做，还是先在 main 上出 1.1.x 补丁。
6. 第 6 条：何时用真实网关复现。

## 4 建议顺序

先做不需要裁决、改动小的：5 → 8 → 12 → 11b → 2（记裁决）；再做 4（量大）、7、11a；裁决到了再做 1/9、3、10、11c；第 6 条等用户安排真实网关。
