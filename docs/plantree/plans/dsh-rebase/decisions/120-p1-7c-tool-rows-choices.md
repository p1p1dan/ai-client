# 决策 120：P1-7c 工具行与 Windows 文案的实现取舍：原型比对结论；DSH 全部工具的动词、图标、参数；「后台 / 已转后台 · bash-N」；pwsh 细则；审批卡与失败卡文案；`presentCall` 暂不接

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- 用户裁决：[决策 090](090-user-rulings-2026-09-28.md)（默认跟随 DSH；只做 Linux 与 Windows；062 / 070 自定义子代理不做；061 MCP 移植不做）、[109](109-user-rulings-p1-7-prototype-2026-09-28.md)、[110](110-user-rulings-2026-09-28-batch2.md)；
- 已批准的决策：[073](073-tool-rows-and-present.md)（工具行三条规则）、[096](096-images-via-dsh-attachments.md) 第 5 条（`read_image` 行文案归 P1-7c）、[098](098-ask-user-via-official-tool.md)「影响」（`ask_user_question` 词条）、[106](106-p1-4d1-live-mapping-choices.md) 第 14、16、42 条（`ABORTED` → 已停止、被拒中性色、四个失败码的文案）、[044](044-dsh-sandbox-off-by-default-in-p1.md)～[046](046-pwsh-conservative-lexical-analysis.md)；
- 待审批的前序决策：[114](114-p1-4d3-ask-user-choices.md)（提问工具已挂载）、[115](115-p1-10d-pilot-plugin-choices.md)（`dsh-office-tools` 3 读 5 写，行文案归 P1-7c）、[118](118-p1-7a-goal-todo-round-choices.md)「影响与遗留」（`todo_write` 展开体接 `TodoList`；目标三个工具的动词与图标）、[119](119-p1-7b-jobs-subagents-choices.md)「影响与遗留」（转后台结局、分叉措辞、`job_*` / `send_message` / `interrupt_agent` 的动词与参数、pwsh 进终端类集合、「到时转后台」）；
- 方案：[P1-7 方案](../topics/p1-7-renderer.md) §4.7、§6 的 P1-7c 行、§7；[分片 04](../topics/p1-7-renderer/04-tool-rows-windows.md) 全表；[分片 02](../topics/p1-7-renderer/02-dsh-facts.md) §4、§6～§8；
- 原型（验收基准）：[p1-7-prototype-2026-09-28](../evidence/p1-7-prototype-2026-09-28/)（`prototype.html` 的 `TIMELINES`：「规划 3/5 已完成」「终端 npm run dev · 后台 · bash-2」「读取 parseConfig.ts src/config/」「已委派 分叉 · 复核方案」）；
- DSH 源码（钉版本 0.1.7-rc.2，路径省略 `src/dsh-host/node_modules/@deepseek-ai/`）：各工具定义的 `name:` 与参数名（`dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-tool-bash`、`dsh-tool-pwsh`、`dsh-tool-jobs`、`dsh-tool-subagent`、`dsh-tool-subagent-control`、`dsh-tool-goal`、`dsh-tool-todo`、`dsh-plan-mode`、`dsh-tool-workflow`、`dsh-mcp-resources`、`dsh-tool-web`、`dsh-tool-present`、`dsh-tools` 的 `run_code`、`dsh-tool-ask-user`）；`dsh-tool-bash/lib/index.js` 的执行期值 `{kind: 'background' | 'promoted', jobId}` 与 `render`；`dsh-shell` 的 `parseExitStatus`；`dsh-bash-local/README.md`、`dsh-pwsh-local/README.md` 的 `timeoutMs` 120 000 / `maxTimeoutMs` 600 000；`dsh-sandbox` 的 `approveEscalation`（`displayReason`）；`dsh-office-tools/lib/index.js` 的参数与 `presentCall`。

改动留在工作区，由编排者复跑后提交。**第 1、3、27、28 条请重点审批。**

## 规则

### 一、开工前的比对

1. **与用户裁决（090、109、110）没有冲突，照原型施工。** 比对的结论：

   | # | 比对项 | 原型 / 分片 04 | 决策 / 事实 | 结论 |
   |---|---|---|---|---|
   | a | `todo_write` 的动词 | 分片「Planned → 已规划」；原型「规划 3/5 已完成」 | 原型是验收基准；决策 034 的「图标 + 两字类型」 | **按原型**：`Planned` 的中文由「已规划」改为「规划」（第 28 条） |
   | b | `run_in_background` 的结局 | 分片「已在后台启动 · bash-5」；原型「后台 · bash-2」 | 同上 | **按原型**：「后台 · bash-2」 |
   | c | 委派行的名字 | 原型 `explore · 调研 goal 投影` | 090：DSH 的子代理没有名字；119 第 1 条 f、第 25 条 | 按 090：`subagent` 行显示描述，`subagent_fork` 行「分叉 · 描述」（分片与原型的「分叉 · 复核方案」一致） |
   | d | 插件与未知工具优先用 `presentCall` 的标题与类别 | 分片 §5 第 1 条；073 第 1 条 | 依赖 P1-4d 的 `presentation` 字段；P1-4d 按 099 重划后没有这一项（[重划表](../topics/p1-4-p1-16-rescope.md) 4d-1～4d-18 都没有），bridge 至今不产出 | **缺口**：本任务不接，见第 27 条（请审批） |
   | e | 决策 062 的委派工具、`mcp__*` 工具行 | 分片 §3 | 090 取消 P1-16d、P1-16b | 委派工具这一行不做；`mcp__*` 维持「调用 server · tool」，只把图标换成 Plug |
   | f | 审批卡「本会话允许」的别名说明、「为什么要问」 | 分片 §6 | 依赖 P1-6d 的 pwsh 前缀归一化与 P1-6b 的 `askReason`；两者都没有落地（pwsh 现在按整条命令看不透，`opaqueShellAnalysis`） | **缺口**：不加，见第 24 条 |
   | g | `escalate_sandbox` 的「当前 → 申请」模式行 | 分片 §6 | 卡片只拿到 DSH 的英文 `displayReason`，没有结构化的当前 / 申请模式；沙箱默认关（044、045），这张卡现在不会出现 | **缺口**：只加「只对这一次调用有效」，模式行不做（第 23 条） |
   | h | `update_goal` 的 edit | 分片「修改目标」 | P1-7a 目标条菜单已是「编辑目标」（`Edit goal`） | 与目标条一致：「编辑目标」 |
   | i | 运行中行尾 | 分片「12s · 2 分钟后转后台」 | 行上的时长格式一向是 `2m`（`formatWorkedForDuration`） | 「12s · 2m 后转后台」 |
   | j | 审批卡工具名 | 分片「`toolDisplayName` 加一张显示名表」 | `toolDisplayName` 还供运行面板、泳道头、授权活动行用，改它会牵动这三处 | 只在审批卡上换名（第 21 条） |
   | k | `ask_user_question` | 分片 §3「包不在树里」 | 已过期：114 已随宿主装好并挂载 | 按已挂载的工具处理，复用 `ask` 的词条 |
   | l | 被拒的调用、`ABORTED` → 已停止 | 106 第 14、16 条交接 | P1-4d1 已落地（`dshToolOutcomeFlags`、`ToolRows.tsx` 不画重复的「已拒绝」、行不标红） | 不改代码，词表测试补例核对 |
   | m | office 插件的行 | 分片 §5「例如 `word_create` → 写文档」 | 115：审查按实测分为 3 读 5 写 | 读 →「读取」、写 →「编辑」（第 10 条） |

2. 原型没有画的：转后台的行、审批卡、失败卡、退出码。按分片 04 做，写法见下。

### 二、「后台 · bash-2」「已转后台 · bash-3」（bridge，119 的交接）

3. **bridge 在转后台的同一挂点加一个字段**：`tools/execute` 的包装出口（`dshSessionRuntime.aroundExecute`，`jobs.endCall` 同一处）把 DSH 的执行期值交给 `DshLiveEvents.onExecEnded`：值是 `{kind: 'background', jobId}` 或 `{kind: 'promoted', jobId}` 时记下；这次调用随后的 `tool/result` 在 `tool.completed.output.details` 里带 `backgroundJob: {id, promoted?}`。
   - 类型在 `ToolOutcomeDetails.backgroundJob`（`src/shared/types/runtimeEvents.ts`），与已有的 `stopped`、`notStarted` 同一个结构化通道，渲染层 store 原样保存，不碰 `chatSessions.ts`；
   - 只认本会话自己 agent 的调用（与 `execStartedAt` 同一个过滤）；失败的结果不带；
   - 顺序：包装的 `finally` 在 DSH 写 `tool/result` 之前执行（值先交回给调用方，DSH 才落盘）。
   - **扩到 `run_in_background`**：原型要「后台 · bash-2」，id 同样只在执行期值里；同一形状也覆盖后台 `workflow` 与后台 `subagent_fork`。
4. **历史**：执行期值不落盘。重开会话后，`run_in_background` 的行从输入认出「后台」但不带 id；转后台的行就是普通的已完成行，展开能看到 DSH 的原文 `[still running after …; moved to background job bash-3]`，不做文字匹配（分片 §4）。DSH 的 job id 是宿主进程级计数，宿主重启后 id 从头数，只在直播显示反而不会误导。

### 三、工具行（`toolCard.ts`、`ToolRows.tsx`、`piToolNames.ts`）

5. **全表**（英文键 → 中文；图标；参数摘要）。未列出的沿用现状。

   | 工具 | 动词 | 图标 | 参数 |
   |---|---|---|---|
   | `read` | 读取 | FileText | `file_path`（缺时 `path`）的短路径，带 `offset` / `limit` 时 `L10-60` |
   | `read_image` | Viewed image → 看图 | Image | 短路径；可点开（编辑器能预览图片） |
   | `write` / `edit` | 编辑 | PencilLine | `file_path` 的短路径（流式时「已收到 N 行」） |
   | `glob` / `grep` | 搜索 | Search | `pattern（仓库名）` |
   | `bash` / `pwsh` | 终端 | SquareTerminal | 命令摘要（第 16、17 条） |
   | `run_code` | Ran code → 代码 | SquareTerminal | `description`，没有时代码第一行 |
   | `workflow` | Ran workflow → 工作流 | Workflow | `meta.name` |
   | `job_output` | Read job output → 后台输出；`wait: true` 运行中 Waiting for job → 等待中 | Layers | `bash-3 · npm test`（第 8 条） |
   | `job_list` | Listed jobs → 后台列表 | Layers | 「全部后台任务」 |
   | `job_kill` | Stopped job → 停止后台 | Layers | `bash-3 · npm test` |
   | `subagent` | 已委派 | Users | `description` |
   | `subagent_fork` | 已委派 | Users | 「分叉 · 」+ `description` |
   | `send_message` | Messaged subagent → 发消息 | Users | `→ 子代理标签`，查不到时是消息正文 |
   | `interrupt_agent` | Interrupted subagent → 打断 | Users | 子代理标签，查不到时是 `agent_id` |
   | `list_agents` | 已列出子 Agent（复用） | Users | 「直接子代理」/「全部后代」（按 `scope`） |
   | `list_subagent_models` | Listed models → 列模型 | Users | 无 |
   | `todo_write` | 规划 | ListChecks | 「3/7 已完成」 |
   | `get_goal` | Checked goal → 查看目标 | Target | 结果里的目标原文；没有目标时「没有目标」 |
   | `create_goal` | Set goal → 设定目标 | Target | `objective` |
   | `update_goal` | 按 `action`（第 6 条） | Target | 受阻原因 / 新目标，其余取结果里的目标 |
   | `exit_plan_mode` | 规划 | ListTree | 计划的第一个标题，没有时第一行 |
   | `skill` | 已加载技能（复用） | Wrench | 技能名 |
   | `ask_user_question` | 询问（复用 `ask`） | Wrench | 第一个问题 |
   | `list_mcp_resources` / `list_mcp_resource_templates` | Listed resources → 列资源 | Plug | `server` |
   | `read_mcp_resource` | 读取 | Plug | `server · uri` |
   | `web_search` / `web_fetch`（我方组合关着） | 搜索 / 获取 | Globe | `queries` 用「 · 」连起来 / `url` |
   | `present`（dsh-base 不挂） | Presented → 交付 | FileOutput | 文件名列表 |
   | office 读：`word_read`、`excel_read`、`ppt_read` | 读取 | FileText | `path` 的短路径 |
   | office 写：`word_create`、`word_update`、`excel_create`、`excel_update`、`ppt_create` | 编辑 | PencilLine | `path` 的短路径；要写的内容在展开体 |
   | `ralph`、`structured_output`、`plugin_manager` | 兜底「工具」（第 11 条） | Wrench | 工具名 |
   | 其余未登记的工具 | Used tool → 工具 | Wrench | 工具名，有可探测字段时「工具名 · 字段」 |

6. **`update_goal` 的动词按调用的 `action` 选**（`toolVerb` 新增可选的 `input` 参数）：complete → 完成目标，blocked → 目标受阻，pause → 暂停目标，resume → 继续目标，edit → 编辑目标；DSH 以后新增、本版本不认识的 action 退回「更新目标」。三态各有英文键（`UPDATE_GOAL_VERBS`）。
7. **`job_output` 带 `wait: true` 运行时读作「等待中」**：它可能等上几分钟，那段时间不是在「读」。
8. **标签在绘制时查**：行模型仍是纯函数，只在 `ToolRowView.argRef` 里带出句柄（`{kind: 'job' | 'subagent', id, format}`）和兜底文字；绘制参数的叶子组件 `RefToolRowArg` 从 `sessionPanels` 的 `jobs`、`subagentCatalog` 查标签，子代理再退到泳道的 `description`（`agentIndex`）。选择器只返回字符串，job 进度行变了不会让行重画；`composeRefArg` 决定措辞，单测覆盖。
   - `jobs` 投影只留最新 8 个已结束的，前台命令正常结束后 DSH 自己移除，所以旧行常常查不到标签，这时只显示 id（分片「查不到只显示 id」）。
9. **兜底（073 第 1 条后半）**：动词从 `Ran`（「终端」）改为 `Used tool`（「工具」），图标是通用扳手；参数以工具名开头（动词已经说不出是哪个工具）。`mcp__*` 仍是「调用 server · tool」，图标改 Plug（分片 §3）。
10. **office 插件（115）**：读与写沿用 `read` / `write` 的词（读取 / 编辑）与图标，与闸门的分类一致，文件名的扩展名说明了格式；读行不给文件链接（编辑器打不开 docx / xlsx / pptx），计入读取类。
11. **故意走兜底的三个 DSH 工具**：`ralph`（dsh-base 关）、`structured_output`（子代理自己的返回通道）、`plugin_manager`（运行期不装插件，P1-10）。词表测试列出这三个，DSH 以后新增的工具没有词条就会让测试失败。
12. **新增 7 类图标**（分片 §1）：`image` Image、`todo` ListChecks、`goal` Target、`job` Layers、`workflow` Workflow、`mcp` Plug、`deliver` FileOutput。`todo`、`goal`、`job` 与待办卡、目标条、后台任务按钮用的是同一个图标。
13. **文件行读 `file_path`（073 第 3 条）**：`read` / `write` / `edit` 先读 `file_path`，缺时读 `path`（bridge 的别名与旧会话）。覆盖字段加上 `file_path`：以前只登记 `path`，DSH 的每个读文件行都多出一段参数 JSON。
14. **`todo_write` 的展开体是清单**（118 的交接）：新的 `todos` 展开类型，画待办卡导出的 `TodoList`；不再显示参数 JSON，也不显示 DSH 一句话的确认；写入失败时仍显示错误。状态不认识的项按「待做」，空内容的项丢掉。
15. **`exit_plan_mode` 的展开体是计划原文**（Markdown 文本），不是转义过的 JSON 字符串；参数取第一个标题，与 dsh-plan-mode 自己的卡片标题一致（没有标题时取第一行，不用 DSH 的英文 `Plan`）。
16. **shell 行的展开体（073 第 2 条、分片 §4）**：第一行 `# <description>`，然后是命令原文，再往下是其余参数（`# workdir: …`、`# timeoutMs: …`）。
    - `#` 在 bash 与 PowerShell 里都是注释，整段复制执行仍然成立（决策 033 D6 建这个展开体就是为了复制重跑）；
    - 以前是 JSON，多行命令会变成 `\n` 转义；
    - 行上仍是命令摘要（09-22 用户裁定），不显示 `description`。
17. **pwsh 摘要去掉的前缀**（分片 §4）：`cd <路径>`、`Set-Location [-Path|-LiteralPath] <路径>`、`Push-Location <路径>`、`pushd <路径>`，以 `;` 或 pwsh 7 的 `&&` 结尾，不区分大小写，可连续多个；路径可带引号或是裸的 Windows 路径。只剩目录切换本身时不剥（那次调用确实只切了目录）。bash 的规则不变（只剥 `cd … &&`）。只影响行上的显示。
18. **退出码**：只认 DSH 自己的末行标记 `\n[exit code: N]`（与 `dsh-shell` 的 `parseExitStatus` 同一条规则，标记必须在换行之后、在文末），非 0 时行尾写「退出码 N」。
    - 中性色、纯文字，与「已停止」同一个位置和样式；不用 `Badge`：工具行一向不加底色和边框（`toolRowPermissionClass` 的约定）。后台任务窗里的「退出码 N」仍是 outline Badge；
    - 有结局词（已停止、未执行……）、留了后台任务、或调用失败时不显示；被信号杀掉（`[killed by signal: X]`）不显示；
    - Windows 上 Stop 的强杀是 exit 1，但那条结果是 `ABORTED` → 「已停止」，不会读成「退出码 1」。
19. **运行中行尾**：「12s · 2m 后转后台」替换「12s / 2m」（DSH 到时限转后台，不杀）。时限的读法：`timeoutMs`（沿用旧的 `timeoutSeconds` 兼容），缺省 120 s，**上限 600 s**（DSH 的 `maxTimeoutMs`）；`run_in_background` 没有时限；`pwsh` 加入。时限仍要等 `execStartedAt` 到了才显示（T146）。
20. **输出窗口高度**：`pwsh` 与 `job_output` 用 shell 那一档（46vh）。

### 四、审批卡（`questionCardModel.ts`，分片 §6）

21. **卡片标题里的工具名**：`bash` → Bash，`pwsh` → PowerShell（新函数 `permissionToolLabel`，只用于审批卡与它折叠后的那一行）。Windows 的卡读作「PowerShell — 在工作区运行命令」。`toolDisplayName` 不动（运行面板、泳道头、授权活动行仍用原名）。
22. **风险**：`pwsh` 按名字与 `bash` 同为高风险（P1-6 发的 `kind: 'exec'` 本来也会判高，这里补上按名字的那一半）。
23. **`escalate_sandbox`**：动作文案沿用 P1-6b 的「以更宽的沙箱权限运行一次」（分片写「以更宽的沙箱权限执行」，现文已说清「一次」，不改键）；卡上加一行「只对这一次调用有效」，放在「本会话允许」说明的位置（这张卡只有允许 / 拒绝）。「当前 → 申请」的模式行不做：卡片没有结构化的模式字段，只有 DSH 的英文原句；沙箱默认关，这张卡目前不会出现。
24. **不做**：「PowerShell 别名按同一条命令记忆」的说明（P1-6d 的别名归一化没有落地，现在写这句是假话）；「为什么要问」的原因句（P1-6b 没有 `askReason`）。两者由 P1-6d 落地时一并加。

### 五、失败卡（`sessionFailure.ts`，分片 §7、106 第 42 条）

25. **`tool_call_repetition`**：「同一个子 Agent 工具调用」改为「同一个子代理或后台任务工具调用」。DSH 的防空转工具族包括 `job_*`、`send_message`、`interrupt_agent`、`list_agents`（`loopGuard/constants.ts`）。loop guard 自己写给详情的英文原句不改。
26. **四个 provider 失败码有了自己的卡**（DSH 的原句仍在下面作详情）：
    - `PROVIDER_UNAUTHORIZED`「模型服务不接受密钥」，动作 configure（重发一样会失败）；
    - `PROVIDER_RATE_LIMITED`「模型服务在限流」，continue；
    - `NETWORK_ERROR`「连不上模型服务」，continue；
    - `PROVIDER_ERROR`「模型服务返回了错误」，continue。

### 六、暂不做与偏离（请审批）

27. **073 第 1 条的前半「优先用 `presentCall` 的标题与类别」本任务不接**，只做后半（兜底改「工具」+ 工具名）。
    - **事实**：P1-7c 依赖的 `presentation` 字段（分片 05 §2 的「P1-4d 的 `presentation`」）没有生产者：P1-4d 按 099 重划时这一项漏掉了，bridge 与历史投影都不产出。
    - **不接的理由**：
      - 现在没有「未登记的插件工具」：白名单插件的工具由测试钉在 `PLUGIN_TOOL_CLASSES` 里（不在表里的插件工具过不了闸），新的词表测试又要求表里每个工具都有词条；DSH 自带工具只剩第 11 条的三个走兜底；
      - `presentCall` 是纯函数，结果不落盘。只在直播带上它，重开会话后的行会与直播不一样（违背 106 第 2 条「直播与历史共用」）；要一致，历史投影也得在 bridge 里调它；
      - 插件的标题是英文（`Create report.docx`），与「图标 + 两字中文类型」的行混排。
    - **代价**：以后白名单加入新插件，要同时在词表里补词条（词表测试会逼着补），否则那几行只显示「工具 + 工具名 · 路径」。
    - **要做的话**：bridge 在 `tool.started` / `tool.updated`（参数齐了时）对不在 DSH 分类表里的工具调 `ctx.tools.get(name, agent).presentCall(args)`，历史投影同样补上，渲染层在无词条时用它；约 0.5～1 人日，既有录制场景没有插件工具，金样本不变。
28. **`Planned` 的中文改为「规划」**（第 1 条 a）：Claude 时代的 `TodoWrite`、`ExitPlanMode` 行与 DSH 的 `todo_write`、`exit_plan_mode` 同改。与决策 034 把「已编辑 / 已运行」改为「编辑 / 终端」同一个方向。

### 七、测试与录制

29. **测试**：
    - 新增 `dshToolVocabulary.test.ts`：以闸门的两张分类表为清单，逐个工具表驱动（每个工具至少一例：动词、中文、图标、参数），覆盖字段、兜底的三个工具、按 action 的目标动词、`job_output` 的等待、`file_path`、Windows 路径、pwsh 前缀（8 例）、shell 展开体、转后台时限与上限、退出码、「后台 / 已转后台」、`todo_write` 展开体、标签查找的措辞、`exit_plan_mode` 展开体；并读 `ToolRows.tsx` 核对每个图标类别都有 Lucide 元素、新尾巴都经过 `t()`；
    - 改：`toolCard.test.ts`（兜底动词、时限上限、「Read / Set」两种形态同形的例外）、`questionCardModel.test.ts`（Bash / PowerShell 标题，新增 PowerShell 卡一组）、`sessionFailure.test.ts`（四张新卡与重复调用的文案）、`timelineToolClock.test.ts`（挂载测试：行尾改为「to background at 5m」）；
    - bridge：`runtimeJobs.test.ts` 加 `[P7C-JOB]`（转后台、后台、普通前台、子代理的调用、失败结果五种）。
30. **录制 `--check`**：28 个场景只有 2 处差异，都是本条的新字段：
    - `stream.job-notice.json`、`stream.jobs-kill.json` 的 `$[14].payload.output` 由字符串 `"started background job bash-N"` 变为 `{content: [{type: 'text', text: 同一句}], details: {backgroundJob: {id: 'bash-N'}}}`；
    - `log.*`、`rpc.*` 与其余 26 个场景的 `stream.*` 一个字节不变。
    - **重录方法**（编排者收口时）：`jobs-kill` 用自己的宿主，`--update --only jobs-kill` 即可（试录到 `/tmp/p1-7c-rec`，除这个字段外与金样本逐字相同）；**`job-notice` 要整套跑**（不带 `--only`）：它和前面的场景共用一个宿主，DSH 的 job id 是宿主进程级计数，单独录时是 `bash-1`，整套录时是 `bash-2`，单独录会把 `log`、`rpc` 也改成 `bash-1`，之后整套 `--check` 又会对不上。
31. **静态扫描的坑**：`fontDomainScan` 按整个文件配对引号字符。pwsh 前缀的正则里若直接写 `'` 与 `"`，引号个数变奇数，扫描会在之后的每个反斜杠上指数回溯（单个用例跑到 93 秒超时）。正则里的引号写成 `\x27`、`\x22`，已在代码注释里说明。

## 取舍

- 标签在绘制时查而不是在推导时查：推导在 `useMemo` 里按工作组缓存，接上 store 会让 jobs 投影的每次变化重推所有工作组；叶子组件只重画自己那一小段。
- 退出码不标红、不加徽标：与 DSH、1.0.x「非零退出码由模型判断」一致；工具行的尾巴都是纯文字。
- 兜底带工具名：动词「工具」不再说是哪个工具，名字只能放在参数里。
- `backgroundJob` 放进结果的 `details` 而不是新事件：与 `stopped` 等结局标志同一个通道，store 零改动。

## 待用户拍板

- **第 27 条**：`presentCall` 暂不接（073 第 1 条前半推迟）。
- **第 28 条**：「规划」替换「已规划」，旧会话里的 `TodoWrite` 行也跟着变。
- **第 3 条**：「后台 · bash-N」「已转后台 · bash-N」只在直播里带 id，重开会话后前者只剩「后台」，后者是普通行。
- 第 18 条退出码用纯文字尾巴而不是徽标；第 23、24 条审批卡的三处缺口留给 P1-6d。

## 影响与遗留

- **金样本**：见第 30 条，编排者收口时重录 2 份 `stream`。
- **P1-7d 点验要看的**：
  - 合成态：DSH 各工具行（尤其新图标、「后台 · bash-2」「已转后台 · bash-3」「退出码 3」「12s · 2m 后转后台」、`todo_write` 展开的清单、`job_output` 带标签「bash-3 · npm test」、`send_message`「→ 标签」）、兜底行「工具 acme_widget · …」、PowerShell 审批卡、四张新失败卡；
  - 深浅两套主题下 Plug、Layers、Target 等新图标与行的对比度；
  - Windows 实测清单 W1～W12（分片 04 §8）中的界面部分，尤其 W1（pwsh 摘要）、W3（行尾转后台提示）、W4（Stop 读「已停止」不读「退出码 1」）、W5（「已转后台 · pwsh-N」）、W8（标题 PowerShell）、W10（中文与长路径的短路径）。
- **P1-6d**：pwsh 前缀归一化落地时，一并加审批卡的别名说明与原因句（第 24 条）。
- **Windows 上的授权活动行**：`pwsh` 的请求以 `policySurface: 'bash'` 过闸，授权活动行因此写「已允许 bash」。不在本任务范围，记给 P1-6d / P1-7d 核对。
- **已知限制**：转后台之后，`jobs` 投影只留最新 8 个已结束的任务，前台命令正常结束后 DSH 会移除它，所以较早的 `job_output` / `job_kill` 行多半只显示 id。
- 相关决策加了修订注记：073、096、098、106、115、118、119。

## 修订注记

- 2026-09-29（P1-6d，[决策 129](129-p1-6d-pwsh-analysis-choices.md)）：第 24 条的两句已补上（129 第 14、15 条：pwsh 的 cmdlet 授权加「PowerShell 别名（如 ls、dir、gci）按同一条命令记忆」；闸门给出 `askReason` 时加原因句）。上面「Windows 上的授权活动行」一条不准确：活动行用的是 `request.tool`，写的是「已允许 pwsh」而不是「已允许 bash」；现改为「已允许 PowerShell」，bash 仍写 `bash`（129 第 16 条）。
