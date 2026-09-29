# 决策 119：P1-7b 后台任务、实时输出、子代理的实现取舍：原型比对结论；`jobs` 投影与节流；前台命令与 job 的对应；`execStartedAt` 覆盖全部工具；子代理配对与泳道收尾；Stop 的连带与唤醒上限；三个 RPC；两个浮动子窗口

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- 用户裁决：[决策 109](109-user-rulings-p1-7-prototype-2026-09-28.md)（浮动子窗口，会话栏按钮开关；不做停靠与底部嵌入；同一个可续跑子代理三处出现不算重复；原型 README 第 5～7、9、10 题未定的按原型做法）、[110](110-user-rulings-2026-09-28-batch2.md)、[090](090-user-rulings-2026-09-28.md)（默认跟随 DSH；自定义子代理不加载，062 / 070 不做）、[069](069-stop-and-background-lifecycle.md)（U3：Stop 连带停子代理、不停后台命令；唤醒保留，上限 3）；
- 已批准的决策：[068](068-renderer-layout-bars-and-subagent-list.md)（经 090、109 修订）、[072](072-renderer-data-channels.md) 第 1、5～7 条、[099](099-p1-4d-scope-dsh-data-only.md) 第 15 条（`execStartedAt` 与前台 job 同一挂点）、[106](106-p1-4d1-live-mapping-choices.md) 第 21、41 条；
- 待审批的前序决策：[118](118-p1-7a-goal-todo-round-choices.md)（`BRIDGE_PROJECTION_KEYS` 加 `jobs`、`worker.panels` 顺带返回、`live` 标志与补水计数规则复用、三个 RPC 照 `chat:runSessionCommand` 的写法）；
- 方案：[P1-7 方案](../topics/p1-7-renderer.md) §1 第 7、8 条、§4.4、§4.5、§6 的 P1-7b 行、§7；[分片 02](../topics/p1-7-renderer/02-dsh-facts.md) §3、§4；[分片 03](../topics/p1-7-renderer/03-panels.md) §0、§4、§5；[分片 05](../topics/p1-7-renderer/05-changes-tests.md)；
- 原型（验收基准）：[p1-7-prototype-2026-09-28](../evidence/p1-7-prototype-2026-09-28/)（README、`prototype.html` 的 `jobsWindow` / `agentsWindow` / `layoutOverlayWindows`、`shots/C-*`、`D-*`、`E-both-floating-*`）；
- DSH 源码：`dsh-jobs/lib/types/types.d.ts`（`JobEvent`、`readAt`、`kill`）、`dsh-tool-bash/lib/index.js`（前台命令即 job、`promoted`、前台收回后 `remove`）、`dsh-tool-subagent/lib/index.js`（`label` 即 `description`；三种结果值）、`dsh-subagent/lib/index.js`（`interrupt` 的人类父授权、结算通知 `notifySettlement`）、`dsh-tool-jobs/lib/index.js`（`maxConsecutiveWakes`）、`dsh-tools/lib/types/index.d.ts`（`tools/execute` 在审批之后）。

改动留在工作区，由编排者复跑后提交。**第 1、10、15～17、25 条请重点审批。**

## 规则

### 一、开工前的原型比对

1. **与用户裁决（109、110、069）没有冲突，照原型施工。** 逐条比对的结论：

   | # | 比对项 | 原型 | 决策 / 方案 | 结论 |
   |---|---|---|---|---|
   | a | 子窗口形态 | 场景 C、D、E 的浮动 | 109 第 1 条：浮动；停靠、底部嵌入不做 | 一致，只做浮动 |
   | b | 入口 | 会话栏「后台任务 N」「子代理 N」，在终端按钮旁 | 090、109：会话栏按钮开关，放在终端按钮旁边 | 一致。终端按钮是 P1-11 的，现在那里还是 GUI / TUI 开关组，两个按钮另起一组紧挨着它 |
   | c | 同一个可续跑子代理 | 后台任务窗、子代理窗、泳道三处都有 | 109 第 3 条：不算重复 | 一致，三处都显示 |
   | d | 后台任务窗的行 | 两行：图标、id、命令 / 描述、用时；状态、「超时转入」、退出码、输出 / 活动 / 阶段、停止 / 打断 / 移除 | 分片 03 §4 | 一致 |
   | e | 子代理清单的位置 | 子代理浮动窗（场景 D） | 068 第 2 条原为「运行面板加清单」，109 改为浮动子窗口 | 按 109：清单只在子代理窗，运行面板不加 |
   | f | 子代理的名字 | `explore`、`review`、「分叉」 | 090：不加载自定义子代理，DSH 的 `subagent` 没有名字 | **原型与用户裁决不一致，按 090**：显示「子代理 · 描述」或「分叉 · 描述」；1.0.x 旧会话的泳道带代理名的照显。这是原型画了 1.0.x 的自定义代理名，不是两条裁决互相冲突 |
   | g | 停止的动词 | 可续子代理「打断」，命令 / 一次性子代理 / workflow「停止」 | 069 | 一致 |
   | h | 「全部停止」 | 纯图标 + 提示，运行项多于 1 个才出现 | 分片 03 §4：多于 1 项时二次确认；原型 README「没有画二次确认弹窗」 | 按原型出现，确认用 `AlertDialog`（方案有、原型只是没画） |
   | i | 位置记忆（README 第 6 题） | 只在当前场景内存活 | 109：未定的按原型 | 只存内存，本次运行有效 |
   | j | 徽标颜色（第 7 题） | `--primary` 实心 | 同上 | 按原型 |
   | k | 子代理 / workflow 的「展开」（第 9 题） | 有：「活动」「阶段」 | 同上 | 按原型：子代理展开泳道最近 6 行，workflow 展开 job 输出（阶段日志） |
   | l | 两窗同开 | 右上角纵向堆叠，各占可用高度一半，底边不越过输入框 | 109 已定 README 第 3 题 | 按原型；底边不越过输入框做成结构性的（第 22 条） |
   | m | 浮动遮挡时间线（第 4 题） | 会遮挡 | 109：接受 | 按原型 |
   | n | 窄窗 | 1280、1024 档只剩图标 | — | 窗口宽度小于 1280 px 时隐藏按钮文字（`max-xl:hidden`）；原型的 1280 档已是紧凑，差在断点的这 1 px |
   | o | 输入框上方第三条「后台窄条」 | 没有 | 方案 §1、§4.4、068 第 1 条 | 以 109 为准，不做窄条，改浮动子窗口 |
   | p | 「引擎重启，任务已结束」 | 没画 | 分片 03 §4 | 按方案做（第 24 条） |
   | q | 「N 条通知待交付」 | 没画 | 分片 03 §4，依赖 `inbox` 投影，P1-4d 没做 | 不做，进遗留 |

### 二、线协议（`src/shared/types/`）

2. **`jobs` 是 bridge 合成的投影 key**（072 第 1 条、118 第 3 条）：`BRIDGE_PROJECTION_KEYS = ['goalActivation', 'jobs']`。值是 `DshJobSummary[]`：`{id, kind, label, status, progress?, detail?, startedAt, finishedAt?, promoted?}`。**不带输出环的偏移**：它随每个字节变，放进去投影就会随输出狂发；窗口要看输出时经 `worker.job.read` 取。
3. **快照时机**：bootstrap 的快照只在会话有 job 时带 `jobs`（与 118 第 9 条同理：既有录制场景的快照一个字节都不变）；`worker.panels` 总带（空列表也带）；回退总带，让被回退会话的列表不会留在窗口里。
4. **变化**：只有生命周期事件（登记、进度行、停止中、结束、移除）会触发；前沿立即发，之后 1 秒一个窗口合并成一次，发的是窗口结束时的当前值，值没变不发。**结束的只留最新 8 个**（按结束时间），与分片 03 §4 一致。
5. **`tool.output`**：`{messageId, toolCallId, jobId, tail, omittedBytes, totalBytes}`，`tail` 最多 16 KiB，整段替换上一条；250 ms 一个窗口，前沿立即。只在内存：不进会话文件、不进 `chatSessions`，行结束后由 `tool.completed` 的输出接替。
6. **三个 RPC**：
   - `worker.job.kill {jobId}` → `{outcome: 'requested' | 'already-finished'}`，就是 DSH 的 `ctx.jobs.kill`，以本会话为调用者（DSH 自己按属主拦别人的 job），结束原因写「stopped by the user from the app」；
   - `worker.job.read {jobId, from?, maxBytes?}` → `{text, from, next, omittedBytes, lossy, spillPaths?}`：用 `readAt`，不动模型的游标；不给 `from` 就是最新 `maxBytes`（缺省 16 KiB，上限 64 KiB）；
   - `worker.subagent.interrupt {childId}` → `{interrupted}`：DSH 的 `ctx.subagents.interrupt(childId, {kind: 'user', parentSessionId})`，只打断当前一轮，子代理还能续聊。
   - 新错误码：`WORKER_JOB_UNKNOWN`（本会话没有这个 job）、`WORKER_JOBS_UNAVAILABLE`（宿主没有 job 登记表或子代理服务）、`WORKER_SUBAGENT_UNAUTHORIZED`（不是本会话的子代理）。
   - Main：停止与打断是改动，要求会话就绪并按发送者认领（同 `chat:runSessionCommand`），不做空闲检查（后台 job 本来就与回合并行）；读取不认领，没有就绪 slot 的会话答 `null`（它的 job 随宿主没了）。
7. `subagent.activity` 加一种 `kind: 'resumed'`（可续子代理结束后又跑一轮）；`SubagentReport` 加可选 `stopReason`（DSH 原样的结束原因，区分「拒绝」与「出错」）；`started.taskType` 填委派工具名（`subagent` / `subagent_fork`）。都是可选字段或新值，旧渲染层忽略。

### 三、bridge（`src/dsh-host/bridge/jobs.ts`、`subagents.ts`）

8. **两个独立模块**，经 host 接口由 `dshSessionRuntime.ts` 驱动。**`tools/execute` 包装是同一个挂点**（099 第 15 条）：只处理本会话自己 agent 的调用（`exec.agent.id` 是本会话、没有 `parent`，即不是子代理的调用、也不是程序的子派发），进入时盖 `execStartedAt`、登记 shell 调用与委派调用，离开时读 DSH 的执行期结果值（不落盘）。包装里的任何失败都只记日志，不影响调用。
9. **前台命令与 job 的对应**（实验 E1，按构造成立）：调用在 `tools/execute` 里时，登记的 job 若 kind 与工具同名（`bash` / `pwsh`）、label 等于命令原文，就是这个调用的——DSH 在调用里同步登记，bash 与 pwsh 互斥，一个 agent 同时只有一个。带 `run_in_background` 的调用不算（它的 job 一开始就是后台的）。这个 job 不进 `jobs` 投影，输出走行上的 `tool.output`；调用拿到 `promoted` 结果（超时转后台）时，job 进投影并标 `promoted`；正常结束时 DSH 自己把 job 移除，投影不出现。
10. **`execStartedAt` 覆盖全部工具**，不只 bash（1.0.x 的 T146 只给 bash）：DSH 的审批在 `tools/pre-execute`，进 `tools/execute` 就过了审批，所以每个工具的行时钟都不再含等审批的时间；超时尾巴（「12s / 2m」）仍只给 bash 类，那是渲染层的现状（`bashTimeoutMsFromInput`），P1-7c 再按「到时转后台」改文案。代价：每个派发的调用多一条 `tool.updated`，录制里每个有工具调用的场景都多这一条（第 31 条）。
11. **子代理配对**（072 第 6 条，实验 E2）：
    - 委派调用在 `tools/execute` 里时，父会话日志出现的 `subagent/catalog`，label 等于调用的 `description`、且在等待中的第一个调用拿走它；
    - 结果值确证或纠正：`{kind: 'continuable', subagentId}` 直接点名子代理，`{kind: 'foreground', runId}` 对上 `subagent/start` 报的 run；
    - 一次性后台子代理（`{kind: 'background', jobId}`）在调用返回之后才建立，它的调用留着等下一条同名的 catalog；
    - 配对前的活动先存着（每个子代理最多 200 条），配上再发；纠正时在正确的泳道重新发 `started`；
    - 已知小概率误配：同一回合里描述完全相同的并行委派，在结果值纠正之前发出的活动会落在对方泳道。
12. **子会话事件到泳道**：
    - 子会话 `assistant/message` 的文本、思考 → `text` / `thinking`（每条最多 4000 字）；每步用量累加，发 `progress`（tokens、调用数）；
    - `tool/call` → `tool.started`，输入按 DSH 的参数名白名单裁剪、每项最多 240 字（`file_path` 同时给 `path`，渲染层的行读 `path`）；`tool/result` → `tool.completed`，失败只带原因（最多 400 字），不带输出正文；
    - `subagent/start` → `status: running`，同一个子代理已结束过就发 `resumed`；`subagent/end` → `status` + `report`：completed → 已完成，aborted → 已停止，error → 失败，max-tokens → 截断，refusal → 失败（`report.stopReason: 'refusal'`，窗口写「拒绝了任务」）；
    - 只发时刻（`endedAt`、`at`），不发时长：时刻在录制里归一成 `<ms>`，时长每次不同。
13. 这次**不做**：子代理用量汇入父会话 `usage.updated.delegated`、子代理的重试横幅（106 第 21、41 条留给 P1-7b 的另两项）。见遗留。
14. **`busy`** 加一条：本会话有子代理正在跑（可续子代理在父回合结束后还在跑，回收 slot 会结束它）。
15. **Stop 的连带**（069 第 1 条）：有回合时，先打断每个正在跑的可续子代理的当前一轮（人类父身份）、停掉本会话正在跑的一次性后台子代理（kind 为 `subagent` 的 job），**不停后台命令**，再照 094 取消父回合（`keepInbox`）。先打断子代理的理由：子代理的结算通知若在父回合结束之前到达，会进收件箱留给下一回合，不会在 Stop 之后把会话唤醒。没有回合时 Stop 照旧什么也不做（不发 `stopped: true`，免得 Main 的 Stop 看门狗等一个不会来的结束事件）；那时子代理从窗口里单独打断。
16. **唤醒上限**（069 第 2 条）：包 overlay 给 `tool-jobs` 行写 `maxConsecutiveWakes: 3`（dsh-base 这一行没有 config，id 补丁不会覆盖别的配置）。它管后台命令、一次性后台子代理、workflow 的完成通知。**可续子代理的结算通知是 dsh-subagent 发的，DSH 没有这个开关**，按 090 跟随 DSH，不自己拦截。
17. **已知行为（请审批）**：Stop 打断的可续子代理仍会发一条「was stopped before it finished」的结算通知；它若在父回合结束之后才到，父会话会被唤醒一轮（DSH 原生行为，第 16 条的上限管不到）。第 15 条的先后次序把大多数情况挡在收件箱里；是否还需要更强的处理，等 P1-7d 做实验 E5 之后再定。
18. **回退**：子代理的追踪清空（被回退的 agent 连同它的可续子代理一起释放），job 订阅换到新会话。

### 四、渲染层

19. **`jobs` 并进 `sessionPanels`**，不另建 jobs store：与目标、待办同一个 `live` 标志、同一套补水先后规则（118 第 13～15 条）。
20. **实时输出** `toolLiveOutput`（相邻 store + 纯模型）：按调用存最新尾部；去掉 ANSI 转义，`\r` 按终端的方式改写本行，`\r\n` 当换行；最多 16 个调用、每个 32k 字符；调用结束、回合结束、引擎失联即清。
21. **`LiveToolOutput`** 是行展开体里的叶子，只在调用运行中挂载，跟随到底、向上滚就停跟。转后台的结局文案（「已转后台 · bash-3」）归 P1-7c：bridge 已在同一挂点拿到 `promoted`，届时加一个字段即可。
22. **浮动层**：盖在时间线（空会话是起始屏）所在的那块区域上，**结构上**不会越过待办条、目标条与输入框（原型 `overlapsDock` 检查变成布局保证）；右上角纵向堆叠，距上 8 px、距右 12 px；两窗同开平分可用高度，每窗 88～420 px（原型 `layoutOverlayWindows`）；宽 340 px，窄时随区域收窄；拖第一行移动、夹在层内、双击回原位；位置只存内存。
23. **窗口外观**：`bg-popover`、`border`、`rounded-lg`、`shadow-lg`（设计规范浮层档）；标题固定两行（标题与关闭一行，计数与操作一行，只截文字不截按钮）；正文用普通滚动容器（与待办卡一致）——卡片只有最大高度，`ScrollArea` 的百分比视口在这里撑不出高度。
24. **后台任务行**：命令的 id 与命令原文用 `Ident`（等宽）；状态词；「超时转入」与「退出码 N」用 outline `Badge`，不标红；展开「输出 / 活动 / 阶段」；运行中给「停止」（可续子代理给「打断」），已结束给「移除」（只在本窗口隐藏）；「全部停止」确认后逐项停止或打断。输出面板在展开且运行时每秒调一次 `worker.job.read`，先取最新 16 KB，之后接着读，面板最多留 64k 字符，写「已省略前 x KB」，有溢出文件时给路径。会话没有活 worker 时，运行中的项写「引擎重启，任务已结束」、不给停止。
25. **子代理行**：状态图标（运行转圈 `status-running`、完成 `success`、失败 `destructive`、停止 / 截断灰色）；**名字按 090：「子代理」或「分叉」加描述**，旧会话泳道有代理名时显示代理名；用时（运行中每秒走）；「45k tokens · 12 次调用」；拒绝写「拒绝了任务」；「打断」只给运行中的可续子代理（一次性子代理在 DSH 里打断是空操作）；「定位」展开所在的工作组、把委派行滚到中间并短暂标成 `bg-selection`；只在目录里、本窗口没见过运行的子代理写「此前运行」，不能定位。
26. **会话栏按钮**：计数是正在运行的项数，用品牌色 `Badge`（原型第 7 题），为 0 时不显示；按下态 `bg-selection`；窗口宽度小于 1280 px 时只留图标。
27. **泳道**：`DELEGATION_TOOL_NAMES` 加 `subagent`、`subagent_fork`（动词沿用「已委派」，参数摘要读 `description`；分叉的措辞归 P1-7c）。**收尾规则改掉**（072 第 7 条）：泳道只在引擎失联（`session.status: disconnected`）时被扫成已取消；任何回合结束都不再扫，DSH 的子代理缺省后台可续，父回合结束不等于子代理结束，每条泳道由子代理自己的结束事件收尾。续聊在泳道里插一行「续聊 · 时间」，状态回到运行中，计数重新开始；泳道记 `startedAt`、`endedAt`、`taskType`。

### 五、测试、录制与冒烟

28. **录制**：`tool.output` 在归一化时丢掉（条数取决于 job 输出何时被抽取，同 P1-4d1 丢参数流式更新的理由）。新场景两个，各用一个独立宿主（DSH 的 job id 是宿主进程级计数 `bash-N`，放在共享宿主上会随前面跑过的场景变）：
    - `jobs-kill`：后台 ticker，窗口读两次输出、停止，停止的完成通知唤醒一轮；`rpc.jobs` 只记读取结果的形状（从头开始、接着读）、停止结果、停止后 `worker.panels` 的列表；
    - `sub-cont`：可续子代理在后台，结算唤醒一轮，那一轮 `send_message` 再给它一条，第二轮跑完再唤醒一轮；子代理与父会话并行，事件先后取决于时钟，所以 `stream` 只记父会话三轮（去掉泳道事件），泳道事件按自己的顺序记在 `rpc.lane`。
    - 两个场景各试录两次，结果逐字节相同；排在别的场景之后再录一次，也相同。
29. `dshHistoryGolden.test.ts` 的清单加上 `jobs-kill`、`sub-cont`（由编排者收口时录）。另加一处比较规则：bridge 先把树节点预览截断到 64 字，录制器再把其中的 UUID 换成更短的 `id-N`，于是一个带 UUID 的截断预览（子代理结算的轮次头点名了子代理）在金样本里比按归一化日志投影出来的短；这种预览按前缀比较，其余字段与其余预览照旧逐字相等。
30. `bridge-smoke` 宿主 H 加三项判定：`liveOutputReachesTheRow`（前台命令的实时尾部与 `execStartedAt`）、`backgroundJobListedReadAndStopped`（后台 job 进投影、从头读到、从外面停止、停止通知唤醒一轮、之后列表里是 killed）、`subagentInterruptReachesDsh`（经真宿主的 bridge 行拿到 DSH 的子代理服务，打断一个不存在的子代理是 DSH 的空操作）；`panelsAnswerCurrentValues` 改为五个 key（多 `jobs: []`）。
31. **`--check` 的差异全部可解释**：既有 26 个场景的 `log.*`、`rpc.*` 一个字节不变；16 个场景的 `stream.*` 只有三类差异，按类去掉后与金样本逐字相同：
    - 每个派发的调用多一条 `tool.updated {execStartedAt}`（tool、stop-tool、compact、crash-resume、usage、job-notice、perm-card、perm-plan、perm-gear、perm-subagent、file-attach 各 1 条；steer、perm-grants、perm-search、question 各 2 条；perm-restart 4 条）；被闸门拒在派发之前的调用没有（perm-deny 不变）；
    - job-notice 在第一轮里还多一条 `session.projection {jobs}`（后台 sleep 登记时）；
    - perm-subagent 还多 9 条 `subagent.activity`（started、status×2、progress×2、tool.started、tool.completed、text、report），子代理的审批卡 `agentId` 与泳道的 `agentId` 是同一个子会话 id。

## 取舍

- **窗口数据走 `session.projection` 而不是新事件**：沿用 072 第 1 条、118；少一套订阅与补水。代价：快照不带输出偏移，读输出要多一次 RPC。
- **`execStartedAt` 给全部工具**：用户要的是「工具计时不含审批等待」（099 第 15 条），写文件、编辑同样会等审批；只给 bash 是 1.0.x 的实现限制。代价是录制每个工具调用多一条事件。
- **Stop 先打断子代理再取消父回合**：能把多数结算通知留在收件箱；不能保证全部（第 17 条）。更强的做法（Stop 后一段时间内把结算通知降为注入）要自己改写 DSH 的投递，违背 090 的「跟随 DSH」。
- **名字按 090 偏离原型**：原型画的是 1.0.x 的自定义代理名，DSH 版没有；编一个名字不如直说「子代理 / 分叉」。
- **浮动层只盖时间线区域**：比原型的「算出输入框上边界再减 8 px」更稳，窗口结构上碰不到输入框与两条窄条；代价是层的高度随时间线区域变，窗口的最大高度要量一次。

## 待用户拍板

- **第 10 条**：`execStartedAt` 覆盖全部工具，所有工具的行时钟都不含等审批的时间。
- **第 15～17 条**：Stop 的连带次序；可续子代理的结算唤醒没有上限（DSH 无开关）；Stop 之后仍可能被结算通知唤醒一轮。
- **第 25 条**：子代理按「子代理 / 分叉 + 描述」命名，与原型的代理名不同。
- 第 24 条「全部停止」的二次确认、第 22 条的窗口尺寸与拖动、双击回原位，属原型没写死的细节。

## 影响与遗留

- **金样本（编排者收口时重录）**：16 个既有场景的 `stream.*`（第 31 条）；新场景 `jobs-kill`、`sub-cont` 各三份首次录制（`--update --only jobs-kill`、`--update --only sub-cont`，各自独立宿主，单独录与整套录结果相同）。录好之前 `dshHistoryGolden.test.ts` 的清单用例会因两个新场景的文件不存在而失败。
- **P1-7c**：转后台的结局文案（bridge 已拿到 `promoted`）；分叉的措辞；`job_output` / `job_kill` / `send_message` / `interrupt_agent` 的动词与参数摘要（标签可从 `jobs` 投影查）；pwsh 进终端类集合；行尾「到时转后台」。
- **P1-7d**：
  - 合成态点验：经 Vite import `/stores/sessionPanels.ts`、`/stores/subagentActivity.ts`、`/stores/toolLiveOutput.ts`、`/stores/sessionSubwindows.ts` 灌合成数据，截图场景 C、D、E（含 1280×720、1024×640）、空窗文案、「全部停止」确认、输出展开、拖动与双击回位、定位高亮、窄窗只剩图标；
  - 真宿主：`P1-JOBKILL`、`P1-SUBCONT`、`P0-SLEEPTOOL` 标记，核对实时尾部、停止、打断、Stop 连带（实验 E5：Stop 之后有没有被结算通知唤醒）、`maxConsecutiveWakes` 生效（实验 E6）、杀宿主后运行项显示「引擎重启，任务已结束」、泳道扫成已取消；
  - 实验 E1、E2 已按源码与录制覆盖（第 9、11 条），E4（高频输出的事件量）没有测。
- **没做的**：
  - 历史里重建子代理泳道（`session.history.subagents`，方案分片 05 的 `shared/dshHistory/subagents.ts`）：重开会话后泳道只剩委派行本身，子代理窗按目录列出，写「此前运行」；
  - 子代理用量汇入父会话（`usage.updated.delegated`）、子代理的重试横幅；
  - 「N 条通知待交付」（需要 `inbox` 投影）；
  - 子代理自己的待办与后台任务（进想法池）。
- 相关决策加了修订注记：068、069、099、106、118。
