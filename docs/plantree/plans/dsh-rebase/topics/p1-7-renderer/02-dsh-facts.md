# P1-7 分片 02 · DSH 源码事实（goal、todo、plan、jobs、子代理、工具呈现）

Role: detail shard。上位：[P1-7 方案](../p1-7-renderer.md)。2026-09-27 只读核对。路径省略前缀 `src/dsh-host/node_modules/@deepseek-ai/`，版本 `0.1.7-rc.2`。只读了代码和 README，没有起宿主；标「推断」的没有运行验证。官方界面包（`client/ui-*`）不在我们的树里，界面层事实只有 README 里提到的部分。

## 1 goal

- **状态**：持久阶段 `active` / `paused` / `blocked` / `complete`，另有只在当前进程有效的 `armed` / `disarmed`（`dsh-goal/lib/types/types.d.ts:38`、`:58`）。`blocked` 带 `{code, message}`，code 如 `model-reported`、`round-limit`（`:40-45`；[P0-2 证据](../../evidence/p0-2-goal-and-plugins-2026-09-25.md)）。
- **投影不含 armed**：`goal` 投影值是 `{goal: GoalSnapshot, roundsStarted, createdAt, updatedAt} | null`，注释明说 activation「deliberately absent」（`types.d.ts:84-99`、`:113-121`）。armed 只能从进程内事件 `goal/activation-changed` 或 `ctx.goals.get(agent).activation` 拿（`:60-72`、`:123-131`；`dsh-goal/lib/types/index.d.ts:67`）。
- **生命周期**（`dsh-goal/README.md:54-72`）：暂停、完成、阻塞、清除都会解除 armed；恢复会话或 fork 之后，active 的目标一律 disarmed，要人明确 resume 才续跑。resume 只在轮次上限还有余量时接受，并清掉阻塞原因。
- **续跑**（`dsh-goal-round-driver/README.md:49-57`）：只在整个 agent 空闲、目标 active 且 armed、轮次有余量时追加一条 `<goal_round>` 消息（`source.kind: goal`）；每一轮在官方 Chat 里有独立的请求头。宿主发起的暂停会中止正在跑的回合；取消不会自动重开，正在进行的目标在下一个空闲点暂停；与目标无关的取消只解除 armed。
- **人用入口** `/goal`（`dsh-command-goal/README.md:34-41`）：`/goal`、`/goal <目标>`、`edit`、`pause`、`resume`、`clear`；命令输出不进模型上下文。README 自己写着「没有持续的状态小部件，裸 `/goal` 是可移植的观察方式」（`:130`）。
- **模型入口**（`dsh-tool-goal/README.md:32-38`、`:55`、`:71`、`:87`）：`get_goal`、`create_goal(objective, max_goal_rounds?)`、`update_goal(goal_id, revision, action, …)`；创建 / 编辑 / 暂停 / 恢复要求本回合有直接的人类消息；已暂停的目标模型不能恢复，要走「Web 控件或 `/goal resume`」；官方界面把三个工具画成通用卡。
- **实测**（P0-2）：宿主执行 `/goal pause` 时，正在跑的 `sleep 8` 被中止，回合以 `aborted {kind:'user'}` 结束，进程树 1 s 内回收；`/goal resume` 之后继续到完成。
- **官方界面**：调研档记载「输入框上方的 goal 条，排在 Todo 之后、队列之前」（[可行性调研 §7.1](../../../../../plans/2026-09-24-dsh-rebase-feasibility-study.md)，出处 `client/ui-goal/README.md:28`，二手，本树无法复核）。

## 2 todo 与 plan

- `todo_write(todos)`：每次整表替换，项为 `{content, status: pending | in_progress | completed}`（`dsh-tool-todo/lib/types/types.d.ts:20-45`）；dsh-base 配置允许多项同时 `in_progress`（`dsh-base/cordis.patch.yml:432`）。
- `todos` 投影：最近一次整表，第一次写之前为 `null`；**下一回合 `turn/start` 时清成 `null`**，回合结束后保留已完成的清单（`dsh-tool-todo/lib/index.js:85-86`；`README.md:94`）。清单只属于写它的那个会话，子代理各有各的（`README.md:56`）。
- plan-mode：`/plan`、`/plan off`、`exit_plan_mode(plan)`；审阅走 `user-questions`，问题带 `detail: <计划 markdown>` 与 `intent: {kind:'plan-review', approve, callId}`，选项 Approve / Keep planning（`dsh-plan-mode/lib/index.js:255-310`）。只有 DSH 的 plan 模式处于激活时 `exit_plan_mode` 才能用（`:257`）。投影 `plan: {active, pending}`（`lib/types/types.d.ts:19-22`）。决策 047 已关掉 DSH 的档位入口并隐藏 `/plan`，所以这条链在我方组合里不会被触发（推断）。

## 3 jobs

- **登记表**（`dsh-jobs/README.md:32-42`、`:55`；`lib/types/view.d.ts:15-94`；`types.d.ts:187-236`）：
  - 每个 job 有 `<kind>-N` id、`label`、`owner`（会话 id）、`status`（running / stopping / completed / killed / failed）、`progress`（活动进度行）、`detail`（结束原因，如 `exit code: 3`）、`startedAt`、`finishedAt`、输出环坐标 `output {total, earliest, spillPaths}`。
  - kind 已有 `bash`、`subagent`（`view.d.ts:26-29`），pwsh 另合并进 `pwsh`（`dsh-tool-pwsh/lib/types/index.d.ts:26`、`lib/index.js:367`，所以 Windows 上是 `pwsh-N`），workflow 与 PTY 也登记成 job（`dsh-tool-workflow/README.md:42`；`dsh-tool-jobs/README.md:12`）。
  - 事件流 `ctx.jobs.events.subscribe({owner} | {owners}, listener)`：`registered` / `progress` / `stopping` / `settled{cause, awaited}` / `removed` 带整份 `JobView`；`output` 只带 `{id, owner, total}`，观察者按自己的游标调 `readAt(id, from)` 取块，不消耗模型的读游标。
  - 只在宿主进程里，宿主退出全部消失；owner 被 dispose 时它的 job 全部取消（`dsh-jobs-local/README.md:56-58`）。
- **配额**（`dsh-jobs-local/README.md:45-50`）：每个 owner 同时最多 10 个 running + stopping；活动环 256 KiB；结束后保留 16 KiB；拉取周期 150 ms。
- **模型工具**（`dsh-tool-jobs/README.md:32-36`）：`job_output(job_id, wait?, timeout_ms?)`、`job_list()`、`job_kill(job_id, reason?)`；官方界面画成通用卡。
- **完成通知**（`dsh-tool-jobs/README.md:40-42`；`lib/index.js:270-285`）：`source.kind: tool-jobs`、`form: notice`；agent 忙时注入下一步，空闲时默认 **followup 开新回合（唤醒）**；`maxConsecutiveWakes` 可给唤醒设上限，默认不限；`completionDelivery: quiet` 则只注入不唤醒。README 承认「通知在等待交付时，客户端没有任何提示」（`:175`）。
- **bash / pwsh 与 jobs**（`dsh-tool-bash/README.md:46-49`、`:60`、`:64`、`:216`；`lib/index.js:391-399`）：
  - `run_in_background: true` 立即返回 job id；
  - **前台命令也在开始时登记成 job**（kind `bash` 或 `pwsh`，label 为命令原文，owner 为调用方会话），调用方等它结束；所以运行中的前台命令输出同样在 job 环里，官方 Web 的任务列表能看到、能停止；
  - 前台命令到时限（缺省 120 s，上限 600 s，`dsh-bash-local/README.md:45-46`）**不杀，转为后台 job**，工具结果写 `[still running after <ms>ms; moved to background job <id>]`（`lib/index.js:182`）；
  - 从外面停掉 job，前台结果写 `[stopped: <reason>]`；
  - bash 与 pwsh 是互斥工具（没有 `isConcurrencySafe`），同一 agent 同一时刻最多一个前台命令。

## 4 子代理

- **我方组合里的工具**（`dsh-base/cordis.patch.yml:348-387`）：`subagent`（spawn，`backgroundMode: continuable`）、`subagent_fork`（fork，one-shot）、`send_message`、`interrupt_agent`、`list_agents`。
- **两种形态**（`dsh-tool-subagent/README.md:57-61`；`lib/index.js:486`、`:519-546`）：
  - continuable：缺省就后台跑，立即返回 `started subagent <childId>`，子代理是持久会话，可以 `send_message` 续聊、`interrupt_agent` 打断当前回合；结束时向父会话发一条 settlement 通知（`kind: subagent-settled`、`form: notice`，`dsh-subagent/lib/index.js:640-652`），父会话空闲时这条通知会开一个新回合（`dsh-subagent/README.md:146-151`）。
  - one-shot：缺省前台等结果；`run_in_background: true` 时登记成 kind 为 `subagent` 的 job。
- **身份与目录**：子会话 header 带 `parentSession`；父会话追加 `subagent/catalog {childId, childCreatedAt, mode, label}`，`label` 就是委派调用的 `description`（`catalog.d.ts:20-38`；`descriptor.d.ts:55-79`）。投影：父会话 `subagentCatalog`（直接子代理列表）；子会话 `subagentTiming {settledMs, active?, lastTurnCompleted?}` 与 `subagent`（身份）（`projection-types.d.ts:8-80`）。
- **生命周期事件** `subagent/start` / `subagent/end`：`{runId, provider, id(子会话), local}`，end 另带 `stopReason`（completed / aborted / error / max-tokens / refusal）与最后一条 assistant 内容（`lifecycle.d.ts:77-81`；`types.d.ts:74-110`、`:239-250`）。**没有父工具调用 id**。
- **能和父调用对上的线索**：执行期结果值 `{kind:'continuable', subagentId}` / `{kind:'background', jobId}` / `{kind:'foreground', runId}`（只在执行期，见 §6）；父会话日志里 `subagent/catalog` 出现在该委派调用的 `tool/call` 与 `tool/result` 之间，label 等于调用参数 `description`（推断，需实测 E2）。
- **人机控制**（`dsh-subagent/lib/types/index.d.ts:186`、`:218`、`:253`；`README.md:61-63`）：`interrupt(childId, authority)` 可由「人类父地址」发起；`prompt(request)` 让人直接给 continuable 子代理发消息，选 Queue 或 Steer；`listChildren` / `listDescendants` 只读目录，不加载子代理。容量：同一棵树最多 8 个活动的 continuable 子代理（`README.md:49-55`）。

## 5 通知类消息（`form: 'notice'`）

| `source.kind` | 何时出现 | 模型看到的 | 出处 |
|---|---|---|---|
| `tool-jobs` | 后台 job 结束 | `background job <id> (<kind>: <label>) finished [status: …]` | `dsh-tool-jobs/lib/index.js:270-282` |
| `subagent-settled` | continuable 子代理一次活动结束 | 结局句 + 子代理的收尾正文 | `dsh-subagent/lib/index.js:640-652` |
| `tool-goal` | 自主轮里 `complete` / `blocked` 成功 | `<goal_complete>` / `<goal_blocked>` 收尾指令 | `dsh-tool-goal/lib/index.js:363-372` |
| `model-selection` | 换了 provider / model | `[model changed: …]` | `dsh-agent/lib/index.js:135-146` |
| `repeat-tool-reminder` | 同一调用连续第 3 / 5 / 8 次 | 提醒文本 | `dsh-repeat-tool-reminder/lib/index.js:1565-1575` |
| `plan-mode` | 切换 plan 模式 | 模式说明 | `dsh-plan-mode/lib/index.js:400-410` |

另有非 notice 的 `goal`（续跑提示）与 `agent-message`（`form: relay`，子代理经 `send_message` 发给父会话）。每一条都带 `summary`（120 字以内）。

## 6 工具呈现与结果

- **呈现意图**：工具可声明纯函数 `presentCall(args)` / `presentResult(args, result)`，返回带 `card` 标签的视图：`generic {title, kind?, rawInput?, content?, locations?}`、`terminal {title, description?, cwd?}`、`diff {title, diffs}`；结果另有 `read` / `search` / `web` 卡（`dsh-tools/lib/types/presentation.d.ts:13`、`:41-110`、`:130`；`lib/types/index.d.ts:174-190`）。`kind` 取值 `read | edit | delete | move | search | execute | fetch | other`，用来选图标。
- **给谁用**：官方 Web 客户端不消费这两个方法，而是在客户端按工具名自行推导；它们是留给「宿主侧消费者」的（`dsh-tools/README.md:91`）。我方 bridge 正是宿主侧消费者，可经 `ctx.tools.get(name, agent)` 取定义（`index.d.ts:683-690`）。
- **执行期值不落盘**：`ToolExecutionSuccess.value` 注明「deliberately omitted from durable events」（`index.d.ts:413-424`）。持久的只有 `tool/result` 的内容、`error {name, code, reason}` 与工具自带的 `meta`。bash / pwsh 没有 `presentationMeta`，所以没有 `meta`；被 Stop 中止的命令是 `error.code: 'ABORTED'`（`dsh-tools/lib/index.js:2528`；`dsh-tool-bash/lib/index.js:325`）。**P1-4 分片 01 写的「bash 的 meta 带 aborted」与源码不符**，历史里的「已停止」要按错误码判。
- **退出码**：DSH 自己的约定是从输出末尾解析 `[exit code: N]` 标记（`dsh-shell/lib/types/render.d.ts:27-39`），回放时同样适用。
- **bash / pwsh 的呈现**：前台为 terminal 卡，标题是命令，`description`（参数说明为「5～10 个词，显示在界面上」）放在卡片上方；后台为 generic 卡（`dsh-tool-bash/lib/index.js:245-285`、`:499`；`dsh-tool-pwsh/lib/index.js:469`、`:659-675`）。

## 7 我方组合里实际可见的工具

- **挂载**：`read`、`read_image`（有附件存储时）、`write`、`edit`、`glob`、`grep`、`bash`（非 Windows）或 `pwsh`（Windows，`dsh-base/cordis.patch.yml:266-272`）、`job_output`、`job_list`、`job_kill`、`skill`、`todo_write`、`get_goal`、`create_goal`、`update_goal`、`exit_plan_mode`、`subagent`、`subagent_fork`、`send_message`、`interrupt_agent`、`list_agents`、`workflow`、`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`。
- **关着或没挂**：`web_search` / `web_fetch`（我方 bundle 关掉，P1-5 可能经网关重开）；`ralph`（dsh-base 关）；`present`（包随 dsh-base 的依赖装进来，`dsh-base/package.json:99`，但 dsh-base 没有任何一行挂它，只有 Web 的代理预设挂）；`list_subagent_models`（只在开启模型选择设置时出现）；`run_code`（只在 PTC 模式）。
- **没有提问工具**：`dsh-tool-ask-user` 不在 dsh-base 的依赖里，也没装。问答卡在我方组合里只剩 plan-mode 一个生产者，1.0.x 的 `ask` 工具没有对应物（交给 P1-4 / P1-10 定去留）。
- **后续加入**：决策 062 的委派工具（P1-16d）、`mcp__*`（P1-16b）、白名单插件工具（P1-10，例如 `word_create`）。

## 8 pwsh（Windows）

- 执行 `pwsh -NoLogo -NoProfile -NonInteractive -Command`，找不到 pwsh 7 时退回 Windows PowerShell 5.1（`dsh-pwsh-local/README.md:32`、`:102`）。
- 每条命令先固定 UTF-8 输出，中文不乱码（`:60`）；5.1 下非 ASCII 的 stdin 可能解错（`:152`）。
- 被强杀在 Windows 上表现为 exit 1、没有信号标记（`dsh-tool-pwsh/README.md:53-55`）。
- 前台命令同样登记成 job、同样超时转后台（`:57-59`）；沙箱打开时的越界升级要求模型用用户当前的语言写 `justification`（`:61-63`）。

## 9 没能确认的

- 官方 Web 界面的实际样子（goal 条、任务列表、子代理浏览器）：`client/ui-*` 包不在树里，只能引用 README 与调研档的二手记录。
- `subagent/catalog` 与委派调用的先后关系、同名 `description` 并行时的配对（E2）；前台 job 与工具调用在 `tools/execute` 窗口内的对应（E1）。
- 用户 Stop（`agent.cancel({kind:'user'})`）会不会连带 continuable 子代理与后台 job（推断不会，E5）。
- `goal/activation-changed` 在 resume、fork、插话取消时的实际触发顺序（E3）。
