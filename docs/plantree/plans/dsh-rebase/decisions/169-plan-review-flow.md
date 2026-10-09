# 决策 169：计划模式的收尾——DSH 原生计划模式 + 我方「计划审阅卡」

日期：2026-10-09。**状态：第 1 节为用户裁决（2026-10-09）；第 2 节起的具体做法为自主决定，待用户审批。**

来源：用户 2026-10-09 原话：

> 「模型在计划模式下不能自行建目标，这个我认为不合理。应该是使用计划模式时，不进行修改，只进行规划分析等。在计划规划完全结束后，已经形成了计划和目标，这时可以询问用户是否按照上述计划设定目标并切换到完全模式进行执行，亦或是对当前计划结果进行讨论修改」

调研与对抗复核见编排者的 `planreview.json`（不入库）；复核意见与调研冲突的地方以复核为准。代码提交：待编排者提交。

修订关系：

- [决策 047](047-tool-classification-and-plan-mode.md) 第 3 条（已批准）：计划模式仍由我方闸门在调用时拒绝写类工具，工具目录不变，`/plan`、`/permission` 仍隐藏；**新增**：我方计划档位同时驱动 DSH 的 plan mode（`dsh-plan-mode`），启用它的 `plan:policy` 提示段与 `exit_plan_mode` 审阅。
- [决策 114](114-p1-4d3-ask-user-choices.md) 第 3、5、6 条（待审批）：`intent.kind === 'plan-review'` 的提问不再丢弃 intent、不再把 `detail` 拼进问题正文，改出专用的审阅卡；审阅卡的跳过 / 关闭改为 DSH 的 `ASK_CANCELLED`，不再回答 `selected: []`。普通 `ask_user_question` 卡不变。
- [决策 092](092-p1-6c-grants-and-setters-choices.md)（已批准）：「回合中改 mode 报忙」加一个**窄例外**——只有 bridge 内部的批准路径（`approvePlan`）可以在回合中把 plan 改成 agent；对外的 `worker.setPermissions` 回合中改 mode 仍报 `WORKER_SESSION_BUSY`，Main 的 `setPermissions` 仍报 `session_busy`（单测与 PLN-1 钉住）。批准时用 `configure`，照常清空本会话授权。
- [决策 098](098-ask-user-via-official-tool.md)：它「取舍」里说应答方的 plan-review 路径是死代码，现在有了用处；只有根会话能提问的规则不变。
- [决策 118](118-p1-7a-goal-todo-round-choices.md)：一致——建目标是人发起的带外操作；这里由 bridge 直接调 `ctx.goals.create`，不经 `worker.command` 发 `/goal`（同步、与改档位在同一个同步块里）。
- [决策 166](166-permission-menu-single-column-and-goal-entry.md)：**关闭第 13 条**（见第 2.8 节）；第 10 条计划模式的菜单说明改为提到审阅（见第 2.10 节）。「设定目标…」保留，作为模型不调 `exit_plan_mode`、只把计划写成普通回复时的退路。
- runtime-hardening 决策 023：卡上的「完全放行」在卡内二次确认；切换后的持续可见交给芯片的警示色。

## 1 用户裁决（2026-10-09）

1. **方案 A**：DSH 原生计划模式（跟随我方闸门）+ 我方审阅卡接住 `exit_plan_mode`。
2. **卡上的选项**：「设为目标，全自动执行」（默认）／「设为目标，完全放行执行」（卡内二次确认，决策 023）／「只执行这一次，不设目标」（次要选项，档位为全自动）／「继续讨论修改」+ 修改意见／「关闭审阅」。
3. **计划模式下模型直接调 `create_goal` 不拒绝**：打开同一张审阅卡（它的 objective + 本会话最近一份计划，如有）。批准 → bridge 切换档位并建目标，原调用要结算成不会再建第二个目标的结果；继续讨论 → 带着意见拒绝。`update_goal resume` 在计划模式下怎么处理，自行决定并记录（见第 2.5 节）。
4. **审阅卡挂着时用户发消息** → 先自动关闭审阅（`ASK_CANCELLED`：模型停下等待），再把消息作为下一回合发出，仍在计划模式。Ctrl+Enter 插话同样处理。

## 2 决定（自主，待审批）

### 2.1 闸门是唯一真源，DSH plan mode 跟随

- `syncPlanMode()`：`ctx.planMode.set(agent, gate.mode === 'plan')`，在三处调用：bootstrap、`setPermissions`（含 `setPermissionTier`）、回退切到子会话之后。分叉的子会话由新开的 slot bootstrap 时对齐。
  - 空闲时 DSH 立即写 `plan/mode`，必要时注入一句「用户切换了模式」旁白（时间线本来就隐藏 `plan-mode` 来源）；与当前状态相同时是 no-op，所以**非计划会话的日志一个字节都不变**。
  - 回合中 mode 改不了，跟随也就无事可做；批准后 DSH 的退出是进程内 pending，宿主在下一步之前崩溃时，下次 bootstrap 按闸门纠正。
  - 宿主没有 `planMode` 服务时只记一次日志，退回到原来的计划模式（只有闸门，没有审阅卡）。没有把 `plan-mode` 行加进 `REQUIRED_ENABLED`。
- `/plan`、`/permission` 仍隐藏；计划模式的唯一入口仍是档位芯片（047、113 不变）。

### 2.2 审阅卡的协议

- bridge 识别 DSH 的审阅题（恰好一题、`intent.kind === 'plan-review'`、有 `detail`），`question.requested` 带 `review: PlanReviewCard`（`kind`、`source: 'exit_plan_mode' | 'create_goal'`、`title`、`plan`、`objective`、`callId`、`goalObjective`），`questions` 里只保留一题（键 `plan-review`），不再拼接计划正文。
- 卡的答复：`answers: {'plan-review': 'goal:auto' | 'goal:bypass' | 'run:auto' | 'keep-planning'}`，继续讨论时意见放 `response`（`@shared/planReview` 的 `planReviewResponse`）。`cancel` = 关闭审阅。
- 解码一律失败关闭（`decodePlanReviewResponse`）：未知选项、多余的键、空意见的「继续讨论」都当作**关闭审阅**（`ASK_CANCELLED`），绝不当作「继续规划」——那会让 DSH 立刻原样重交、卡片反复弹出。只有自由文本时当作带意见的继续讨论。
- 回给 DSH 的答复：批准 = `{selected: ['Approve']}`、不带 custom（DSH 只认这个）；继续讨论 = `{selected: ['Keep planning'], custom: 意见}`；关闭 = 鸭子类型的 `UserQuestionError` `ASK_CANCELLED`（DSH 会还原成自己的错误，告诉模型「停在计划模式，等用户发话」）。
- `question.resolved` 增加 `review: {choice, goal?}`，冻结卡据此显示。

### 2.3 批准：一个同步块，回合中切换档位

`approvePlan` 在审阅所在的回合仍然打开时，按顺序同步执行（中间没有 await，插不进任何 step）：

1. `gate.configure({mode: 'agent', gear})`：`goal:bypass` → 完全放行，其余 → 全自动；照常清空授权（092）。
2. `syncSandboxMode()`；`planMode.set(agent, false)`（回合中只排队；`exit_plan_mode` 自己也会排同样的退出，这一条兜底 `create_goal` 路径和 plan-mode 服务被重载的情况）。
3. 打开「本步保持」（第 2.6 节）。
4. 选了设目标时 `ctx.goals.create(agent, {objective, maxGoalRounds?})`；已有未完成目标等原因建不成时，**照常批准**，原因带回。
5. 记下给模型和时间线的审批记录（第 2.7 节）。
6. 发 `session.permissions {permissions, cause: 'plan-approved', questionId, goal?}`，然后才结算卡片（`question.resolved`）。

目标原文：`exit_plan_mode` 批准时 = 计划标题 + 计划里「目标 / 成功标准 / 验收」各节（`planGoalObjective`，中英文标题都认，跳过「非目标」和代码块里的标题），超过 4000 字符或没有这类小节时改为指引式：`Carry out the approved plan "<标题>" (presented for review in this session) until its success criteria are met.`（模型看的文字用英文）。`create_goal` 路径用模型自己的 objective 和 `max_goal_rounds`。

### 2.4 计划模式下的 `create_goal`：在 `tools/execute` 里审阅

- DSH 的 `tools/pre-execute` 只能答 allow / deny / cancel / ask，给不出「成功、已建目标」这样的结果；`tools/execute`（调度环绕）可以不调 `next()` 直接返回结果，DSH 会按工具自己的输出 schema 和渲染器规范化。所以审阅放在 bridge 已有的 `tools/execute` 环绕里，权限行不拦 `create_goal`。
- 批准且设目标：bridge 用 `goals.create` 建目标，调用以 `create_goal` 自己的返回值结构结算（`{goal: {...}, activation: 'armed'}`）——历史里就是一次成功的建目标，`goal/change create` 是审计记录，真实可信；工具本体不再运行，不会建第二个目标，也不受 `requireDirectHuman` 限制（卡上的点击就是人的授权）。
- 批准但「只执行这一次」：错误结果，说明「用户批准了计划但不设目标，不要建目标」；建不成目标：错误结果并带原因；继续讨论 / 关闭：与 DSH 的 `exit_plan_mode` 同样措辞的错误结果；审阅中 Stop：`ABORTED` 结果。

### 2.5 计划模式下的 `update_goal resume`：引导式拒绝

权限行在 pre-execute 拒绝它，理由告诉模型：计划模式下恢复的目标轮什么也改不了，先用 `exit_plan_mode` 提交计划，用户批准后会离开计划模式，届时再恢复目标。`edit`、`pause`、`complete`、`blocked` 不拦。不复用审阅卡：恢复已有目标没有「设为目标 / 只执行一次」之分，同一张卡会变成另一种语义；而且已有未完成目标时，卡上的「只执行这一次」本来就是离开计划模式的路径。

### 2.6 批准后同一步内的「保持」

`exit_plan_mode` 没有声明并发安全，同一条回复里排在它后面的调用是在批准**之后**才做 pre-execute 的（调研原先说「已按 plan 判过」不成立）。所以批准时 bridge 打开一个保持，直到本会话根 agent 的下一个 step（下一条 `assistant/message`）或回合结束：

- 权限行对本会话根 agent 自己的所有调用（包括 internal 工具，例如同一回复里的 `create_goal`——用户可能选了不设目标）一律拒绝，理由是「计划已在本步批准，从下一步开始执行；这次调用没有执行，需要的话下一步再发」，与 `plan:policy` 的说法一致。子代理的调用不拦。
- 这期间再来的审阅请求（同一回复里的第二个 `exit_plan_mode`）不出卡，直接拒绝。

### 2.7 审批记录：工具结果附带的一条 notice，而不是 `aiclient/plan-review` 事件

复核建议 bridge 追加一条 `aiclient/plan-review` 日志事件。实测 DSH 的 `session.append` 不能给事件打 `ignorable` 标记，而持久化层冷读时会拒绝「不认识、又没标 ignorable」的事件类型，整份会话都打不开（`dsh-session-persistence` 的读取校验）。所以改为：批准时给那次调用的结果附一条 `additionalContexts` 的 `user/message`，来源 `{kind: 'aiclient-plan-review', form: 'notice', summary, choice, goal?}`：

- 模型在下一步读到正文（英文，说明已批准、是否设了目标、现在的档位）；
- 时间线按 notice 显示 `summary`：直播是 `custom.message`（`dsh:aiclient-plan-review`），回放是 `dsh-notice-<seq>` 行；`summary` 是五句固定英文之一（`PLAN_REVIEW_NOTICE_SUMMARIES`），渲染层当词典键翻译。
- 回合在下一步之前被 Stop 时，这条记录可能随待处理上下文一起丢掉；卡片的选择仍在 `exit_plan_mode` 的结果里（已批准），只是少了具体选了哪一项。

### 2.8 历史回放与 166 §13 的收口

- `exit_plan_mode` 和审阅过的 `create_goal` 的工具行按结果文字识别结局（`planReviewRowOutcome`）：已批准 / 继续修改：<意见> / 已关闭审阅 / 已批准未设目标 / 已批准未能设定目标。这些行**不显示为失败**，行尾是本地化的一个词，不再显示 DSH 的英文原句；计划正文仍是可展开的输入。直播与回放一致。
- 冻结卡（「计划审阅 · 已批准：设为目标，全自动执行」等）与普通提问卡一样只在直播里有；回放以工具行和审批 notice 为准。`dshStreamReplay` 的 `REOPEN_DIFFERS` 记下原因，`dshHistoryGolden` 有对应断言。
- **166 §13 第一项**（计划模式下拒绝 `create_goal` / `update_goal resume`）：按用户裁决，`create_goal` 改为审阅入口（2.4），`resume` 引导式拒绝（2.5）。
- **166 §13 第二项**（改写提示词）：`promptText.ts` **两句都不改**。plan 句「Inspect and produce an implementation plan for user approval」与 DSH 的 `plan:policy` 一致，`planMode` 服务缺失时也仍然准确；agent 句改动要重录全部 30 个金样本。批准后 `aiclient:permission` 自动变成「Mode: agent. Execute the approved work …」，正好对得上。

### 2.9 档位同步：可补齐，Main 只认自己转发过的批准

- 新运行时事件 `session.permissions`。Main 收到 worker 的 `plan-approved` 时，**只接受**它刚转发过的那张审阅卡的批准答复，档位由 Main 从那条答复推出（`decodePlanReviewResponse`），与 payload 不符、没有对应答复、或答复不是批准的一律丢弃并 warn。接受后更新 `entry.permissions`（崩溃重启用新档位；回合中芯片只改档位也能被接受）再转发。
- 可补齐：Main 给这个 entry 记一个「档位来自审阅批准」的标记；渲染层错过事件（审阅时恰好重载窗口）后再打开这个会话，带着旧的 plan 档位来 warm create / resume 时，Main 不再把旧档位推回 worker，而是发 `session.permissions {cause: 'sync'}` 把自己的档位交还；渲染层下一次自己改档位时标记清除。没有用 `session.projection` 的新键：那会进每个会话的 bootstrap 基线和 `worker.panels` 的答复，改动全部金样本。
- 渲染层在 `App` 里全局订阅（`planApprovalPosture.ts`）：写入该会话的档位存储 → `notePostureSynced` 让芯片重读 → `plan-approved` 时 toast「计划已批准，已切换到「全自动」」，没建成目标时用 warning 并写原因。

### 2.10 渲染层

- 审阅卡在停靠位（`PendingQuestionDock` 见到 `block.planReview` 就画 `PlanReviewCard`）：计划正文预览 `max-h-48`，可展开到 `max-h-96`，适配约 800px 高的窗口；**按原文显示**（`whitespace-pre-wrap`），不做 Markdown 渲染——T-29 的全仓守卫要求助手文字只在 `MessageTimeline` 一处走 Markdown，这里与提问卡、`exit_plan_mode` 行展示计划的方式一致。用户若要渲染后的计划，需要另行放开 T-29。
- 组件用 @coss/ui 的 RadioGroup / Radio、Textarea、Button。「将设定的目标」两行截断预览。已有未完成目标时，两条「设为目标」置灰并说明原因，默认改选「只执行这一次」——可用性由渲染层按目标条视图实时计算，不在出卡时算定（目标条中途 `/goal clear` 后会恢复）。
- 「完全放行」按「确定」后原地换成确认条（返回 / 确认以完全放行执行）。「继续讨论修改」必须填写意见，空时「确定」置灰。「关闭审阅，改为输入消息」= `cancel`，随后焦点交给输入框（`composerFocus.ts` 的窗口事件）。
- 发消息 / Ctrl+Enter 时（`ChatComposer.handleSend` 的入队与插话路径），本会话挂着审阅卡就先发 `cancel` 关闭它；**只针对审阅卡**，普通 `ask_user_question` 卡维持 114 第 6 条。
- 冻结态一行：已批准（三种）/ 继续讨论修改：<意见> / 已关闭审阅 / 已停止；没建成目标时第二行写原因。
- GoalBar：折叠行显示目标第一行并去掉开头的 `#` 标记；展开区目标正文 `max-h-48` 滚动。
- 菜单里计划模式的说明改为「只读：勘察时不再询问，完成后把计划交给你审阅。改文件、其他命令和联网工具都会被拒绝。」，删掉 166 §10 的旧词条。
- 文案集中在 `i18n.ts` 的 `// Plan review (decision 169)` 一块。`shared/planReview.ts` 里用来识别中文「目标 / 成功标准」小节标题的正则含中文，加进 `noHardcodedChinese` 的白名单并写明理由（读模型写的标题，不是界面文案）。

### 2.11 金样本与测试工具

- 假网关新增 `P1-PLAN-REVIEW`（读 → 提交计划 → 按意见重交 → 批准后写文件 → 目标轮完成）、`P1-PLAN-DISMISS`、`P1-PLAN-SIBLING`（同一回复里 `exit_plan_mode` + `write`）、`P1-PLAN-GOAL`（计划模式下 `create_goal`）。
- 录制器新增场景 `plan-review`、`plan-dismiss`（排在 `question` 之后，共享宿主）；`SHOWN_SOURCES` 加 `aiclient-plan-review`（我方文字、不含日期）。重录 `perm-plan`：日志开头多一条 `plan/mode {active: true}`，其后序号整体后移一位，系统提示仍是占位符。
- `bridge-smoke` 新增三条判定：审阅卡与回合中切换档位、同一步的兄弟调用被保持到下一步、计划模式下 `create_goal` 走审阅并由目标轮完成。
- 真宿主集成测试 PLN-1～3（`dshSharedHost.integration.test.ts` 的「a plan review supervisor」）。

## 3 风险

1. **修订已批准的 047 第 3 条、给 092 开例外**，需要用户审批。例外只在 `approvePlan` 里生效，对外 RPC 仍报忙，有单测钉住。
2. **KV 缓存**：进入或退出计划模式会改系统提示中 `plan:policy`（顺序 500）之后的部分，缓存从那里失效；工具目录不变。
3. **弱模型不守规矩**：把计划写成普通回复而不调 `exit_plan_mode`，就不会出审阅卡；退路是 166 的「设定目标…」。同一回复里的兄弟调用会被「保持」拒绝一次，模型需要下一步重发。
4. **档位丢失的剩余窗口**：渲染层错过事件且 Main 的 entry 已被回收（空闲回收、应用重启）时，再打开会话以渲染层存储为准，回到计划模式。方向是安全的（只读），芯片如实显示。
5. **批准与 Stop 竞争**：先到者生效。批准先到时档位已切、目标已建，随后的 Stop 让目标进入「已挂起」，可在目标条「继续」；DSH 待提交的退出在下一回合第一步写入。
6. **授权被清空**：每次批准都走 `configure`，清掉「本会话内允许」记下的授权（与任何改档一致）。
7. **合成的 `create_goal` 结果依赖 DSH 的输出 schema**（`goalValue` 结构）；DSH 升级若改了这个结构，`bridge-smoke` 的 `planModeGoalIsReviewed` 和 PLN 测试会先失败。
8. **目标原文的 token 成本**：每个目标轮都会重述目标；限制在 4000 字符以内，超过时用指引式。

## 4 验证（2026-10-09，开发机逐条跑，一次一个）

- 宿主单测：`pnpm exec vitest run src/dsh-host` → 43 个文件通过、2 个跳过；829 项通过、11 项跳过。其中新增 / 改动：`bridge/__tests__/planReview.test.ts` 23 项、`questions.test.ts` 22 项、`rewindFork.test.ts` 24 项、`permissions/__tests__/permissionHost.test.ts` 57 项（1 项跳过）。
- `pnpm exec vitest run scripts`：228 项。
- Main：`WorkerManager.test.ts` 183 项（新增「plan review posture (decision 169)」4 项）。
- 真宿主：`AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run src/main/services/agent-host/__tests__/dshSharedHost.integration.test.ts -t "decision 169"` → PLN-1～3 共 3 项通过。
- `bridge-smoke`：69 条判定全真（新增 3 条）。
- `bridge-record --update --only perm-plan,plan-review,plan-dismiss`，随后全量 `--check`：30 个场景 0 差异。
- 共享：`src/shared/__tests__/planReview.test.ts` 9 项；`pnpm vitest run src/shared/__tests__` 521 项；`dshHistoryGolden` 103 项。
- 渲染层：`planReviewModel.test.ts` 12 项、`planReviewCard.test.ts` 7 项、`planReviewWiringStatic.test.ts` 5 项、`planApprovalPosture.test.ts` 4 项、`dshStreamReplay.test.ts` 240 项、`dshTimelineRowModel` + `sessionPanelsModel` 31 项、`pendingQuestionDock` / `toolCard` / `toolRowOutcome` / `sessionPanelStripsMount` / `dshTimelineRowsMount` / `chatSessionsQuestion` 157 项；决策 166 的 `composerPermissions` / `composerGoalEntry` / `goalStart` / `goalStartWiringStatic` 48 项。
- `pnpm vitest run Static Scan Wiring`：78 个文件、797 项。
- `pnpm typecheck`、`pnpm typecheck:dsh-host` 通过；改动文件 `biome check` 无问题。
- 未做：GUI 点验（Electron）与整包构建（开发机不跑）。
