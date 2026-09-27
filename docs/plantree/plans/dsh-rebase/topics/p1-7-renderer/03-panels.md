# P1-7 分片 03 · 面板方案与线框

Role: detail shard。上位：[P1-7 方案](../p1-7-renderer.md)。回答调研问题 2。事实出处见[分片 01](01-current-state.md)、[分片 02](02-dsh-facts.md)。线框只示意结构与文案，尺寸、颜色一律按 `docs/design-system.md` 的 token（行高 `h-7`、小按钮 `h-6`、字号 `text-meta`、截断 `min-w-0 flex-1 truncate`）。中文字符在等宽字体里占两格，框线只画左边。线框里的符号是 Lucide 图标的占位：◎ Target、‖ Pause、! TriangleAlert、✓ CircleCheck、▤ ListChecks、▣ SquareTerminal、◇ Users、(i) Info、⟳ Spinner、✗ CircleX、◉ / ○ CircleDot / Circle。

## 0 数据流与线协议

**原则**：P1-4 产出事件，P1-7 只渲染；少数只服务界面的 bridge 逻辑（子代理活动、jobs 快照、实时输出）归 P1-7b，写在 `src/dsh-host/bridge/` 下的独立模块里。渲染层一律用相邻 store（纯 reducer + zustand 壳），不改 `chatSessions.ts` 的状态结构，只允许加可选字段。

| 通道 | 形状 | 生产 | 消费 |
|---|---|---|---|
| `session.projection` · `goal` | DSH `GoalProjection \| null` | P1-4d（决策 031） | 目标条 |
| `session.projection` · `goalActivation` | `{goalId, revision, activation} \| null`，bridge 从 `goal/activation-changed` 与 bootstrap 时的 `ctx.goals.get()` 合成 | P1-4d（本方案提需求） | 目标条 |
| `session.projection` · `todos` | `TodoItem[] \| null` | P1-4d | 待办卡 |
| `session.projection` · `subagentCatalog` | 直接子代理列表 | P1-4d | 子代理清单 |
| `session.projection` · `jobs` | `JobSummary[]`，bridge 合成，≤ 1 Hz 合并；不含正挂在运行中前台调用上的 job | P1-7b | 后台任务条 |
| `session.projection` · `inbox`（可选） | 待交付输入的条数 | P1-4d | 后台任务条的「有 N 条通知待交付」 |
| `tool.output` | `{messageId, toolCallId, tail, omittedBytes, totalBytes}`，整段替换，≤ 4 Hz，只在内存 | P1-7b（从 job 环 `readAt` 取） | 运行中的命令行 |
| `message.started` · `role:'user'` + `origin` | 自主回合的轮次头（§6.1） | P1-4d 直播、P1-4a 历史，规则由 P1-7a 定 | 时间线 |
| `custom.message` · `dsh:<kind>` | 回合中途的通知（§6.2 表） | P1-4d | 时间线轻量行 |
| `subagent.activity` | 现有类型 | P1-7b（子会话事件投影） | 泳道、清单 |
| `tool.started/updated.presentation` | `{card, title, kind?, description?}`，取自 `ctx.tools.get(name, agent).presentCall(args)` | P1-4d（可选字段） | 插件 / 未知工具行 |

新增 RPC（渲染层 → Main → worker，Main / preload / IPC 归 P1-7）：`worker.command {line}` → `{ok, output?, error?}`；`worker.job.kill {jobId}`；`worker.job.read {jobId, from}` → `{chunks, next, lossy}`；`worker.subagent.interrupt {childId}`；`worker.panels` → `{projections, jobs}`。都经 `claimSessionForSender`，与现有聊天 IPC 同一套会话归属检查。

**补水**：渲染层刷新、切会话、会话被恢复时调一次 `worker.panels`；会话没有活的 worker（只读预览）时返回空，面板不显示。以后可让 P1-4a 的只读回放顺带返回投影值，给预览也画出只读目标条（可选）。

**jobs 为什么走 `session.projection`**：它是「每个 key 后到的覆盖先到的」快照，正好是 jobs 列表要的语义；再开一种事件类型，渲染层要多一套订阅和补水。代价是决策 031 的 key 不再全部来自 DSH 投影，要在类型里注明哪些是 bridge 合成的（`goalActivation`、`jobs`）。

## 1 输入框上方的布局（U1）

```text
│ …时间线（最后一个回合）…
│ ── ◎ 目标 · 第 4/256 轮 ─────────────── 12:05      ← 轮次头（§6.1），不是气泡
│ 已工作 1 分 12 秒 ⌄
│ 本轮回复正文……
│
│ ▤ 待办 3/7 · 正在：补目标条单测                        ⌃   ← 待办卡（折叠，h-7）
│ ◎ 目标 · 第 4/256 轮 · 进行中 · 让 CI 全绿      [暂停] ⋯   ← 目标条（h-7）
│ ▸ 后台 · 2 运行中 · 1 已结束                   [全部停止]  ← 后台任务条头（h-7）
│ ┌ 问答卡 / 审批卡浮层（现有，未变）
│ ┌ 排队消息条（现有，未变）
│ ┌ 输入框 ……                                   [模型][发送]
│ └ 仓库 / 分支 / 运行位置（现有目标栏）
```

- 顺序照 DSH 的「Todo → goal → 队列」（分片 02 §1），后台任务条接在目标条后面；可答的问答 / 审批卡维持离输入框最近。
- 三条都默认折叠成一行；没有内容就不渲染；全部出现时共占约 84 px。
- 宽度、圆角、底色与排队条同一套（`queueStripWrapperClass`、`rounded-sm border bg-muted/50 text-meta`）。窄窗口下按钮只剩图标，文字进 `Tooltip`。
- 备选 B：只放一行「会话状态」小标（目标 / 待办 / 后台），点开浮层。更省高度，但目标状态与后台任务要多点一次才看得见。备选 C：全放左栏「运行」面板，聊天区不占位，但运行面板默认是收起的。

## 2 目标条

**数据**：`goal` 投影 + `goalActivation` + 会话运行状态。

| 状态 | 左侧文案（中文） | 右侧 |
|---|---|---|
| active · armed · 回合进行中 | ◎ 目标 · 第 3/256 轮 · 进行中 · 〈目标〉 | 暂停 ⋯ |
| active · armed · 空闲 | ◎ 目标 · 第 3/256 轮 · 等待下一轮 · 〈目标〉 | 暂停 ⋯ |
| active · disarmed | ◎ 目标已挂起 · 重开会话、回退或打断后需要手动继续 | 继续 ⋯ |
| paused | ‖ 目标已暂停 · 第 3/256 轮 · 〈目标〉 | 继续 ⋯ |
| blocked · `model-reported` | ! 目标受阻 · 〈阻塞说明〉 | 继续 ⋯ |
| blocked · `round-limit` | ! 目标已用完 256 轮 | ⋯（继续置灰，提示「让助手调高轮数上限，或清除」） |
| complete | ✓ 目标已完成 · 共 5 轮 · 〈目标〉 | 收起 ⋯ |

- `⋯` 菜单：编辑目标、清除目标（二次确认）、复制目标文本。
- 按钮全部走 `worker.command`：暂停 `/goal pause`、继续 `/goal resume`、清除 `/goal clear`、编辑 `/goal edit <文本>`（对话框里编辑）。不进消息队列，不开模型回合；宿主执行暂停时会中止正在跑的一轮（P0-2 实测）。命令出错时弹 toast，写出 DSH 返回的原因。
- 请求进行中按钮禁用；没有活的 worker（只读预览）时隐藏按钮。
- 目标文本单行截断，完整内容进 `Tooltip`；展开条目（点左侧）显示全文、创建时间、最后更新时间。
- 「收起」只在本机隐藏已完成的目标，下一次目标变化时重新出现。
- 与其他操作的关系：
  - Stop：本轮中止，DSH 在下一个空闲点把目标置为 paused，条上随之显示「继续」；
  - Ctrl+Enter：见 U5；
  - 回退、fork、宿主重启：目标变为 disarmed（P1-4 §8），显示「已挂起」；
  - 创建目标：只有 `/goal <目标>` 与模型的 `create_goal`，输入框不加「目标模式」开关（与 Claude Code、Codex、DSH 一致）。

```text
│ ◎ 目标 · 第 3/256 轮 · 进行中 · 让 CI 全绿并提交修复          [暂停] ⋯
│ ‖ 目标已暂停 · 第 3/256 轮 · 让 CI 全绿并提交修复             [继续] ⋯
│ ! 目标受阻 · 配置文件 /etc/app.json 连续 3 轮都不存在          [继续] ⋯
│ ✓ 目标已完成 · 共 5 轮 · 让 CI 全绿并提交修复                 [收起] ⋯
```

## 3 待办卡

- **数据**：`todos` 投影。`null` 不渲染；新一轮开始时 DSH 把它清空，回合结束后保留完成的清单直到下一轮开始（分片 02 §2）。
- **折叠态**：`▤ 待办 3/7 · 正在：<第一项 in_progress>`；有多项进行中时写「正在：A 等 2 项」；全部完成写「待办 7/7 已完成」。
- **展开态**：逐项一行，图标 `Circle`（待做）、`CircleDot`（进行中，`text-foreground`）、`CircleCheck`（完成，`text-muted-foreground` 加删除线）；超过 8 项时限高滚动。展开状态按会话记住。
- **时间线里的 `todo_write` 行**：动词「规划」，参数「3/7 已完成」；展开体用同一个清单组件画出这次写入的清单，不再显示参数 JSON。
- 子代理各有自己的清单，不进这张卡；可以在泳道里显示（P1-7b 可选项）。

```text
│ ▤ 待办 3/7 · 正在：补目标条单测                                  ⌄
│   ✓ 读 DSH goal 投影
│   ✓ 设计目标条的七种状态
│   ◉ 补目标条单测
│   ○ 开发机 GUI 点验
```

## 4 后台任务条（待办 D4）

- **数据**：`jobs` 快照。每项 `{id, kind, label, status, progress?, detail?, startedAt, finishedAt?, outputTotal}`；外加正在跑的 continuable 子代理（来自子代理清单），这样「回合结束后还在跑的东西」都在一处，与 DSH 的会话活动口径一致（job 与 subagent 两族）。
- **列出哪些**：`run_in_background` 的命令、超时转后台的前台命令、一次性后台子代理、后台 workflow、运行中的 continuable 子代理。**不列**正挂在运行中前台调用上的 job，它们的输出走 §4.1 的实时输出。已结束的只留最近 8 项。
- **头**：`▸ 后台 · 2 运行中 · 1 已结束`，有运行项时带 `Spinner`；右侧「全部停止」（多于 1 项时二次确认）。没有任何项时整条不渲染。
- **行**：图标（命令 `SquareTerminal`、子代理 `Users`、workflow `Workflow`）→ 标签（命令用等宽截断，描述用比例字）→ 状态词 → 进度行（workflow 的阶段）→ 用时（`tabular-nums`，只在条内每秒走，不复用时间线的时钟）→ 结果（`退出码 1` 用 `Badge`，非 0 不标红）→ 操作：查看输出、停止（运行中）、移除（已结束，只在本机隐藏）。
- **查看输出**：展开 `max-h-40` 的等宽尾部，经 `worker.job.read` 每秒拉一次新块，只在展开时拉；环里被挤掉的部分显示「已省略前 x KB」，有溢出文件时给路径。
- **停止**：命令与一次性子代理走 `worker.job.kill`；continuable 子代理走 `worker.subagent.interrupt`（只打断当前回合，子代理还能续聊）。
- **通知待交付**：`inbox` 投影里有 job 通知而 agent 空闲、唤醒预算又用完时（见 U3），头上加一句「1 条完成通知待下次发送时交付」。DSH README 承认官方界面没有这个提示。
- **宿主回收**：有运行中的 job 或子代理时，bridge 在 pong 里报 `busy`，Main 的 `isSafeToEvict` 不回收（P1-3 §7 已登记，这里给出 busy 的口径：agent 不空闲、或有运行中的 job、或有运行中的 continuable 子代理、或目标 active 且 armed）。宿主崩溃时 job 全部消失，条上把运行项标成「引擎重启，任务已结束」。

```text
│ ▾ 后台 · 2 运行中 · 1 已结束                              [全部停止]
│   ▣ bash-3   npm run dev                运行中   12:04   [输出][停止]
│   ◇ 子代理  调研 goal 投影（explore）    运行中    3:10         [打断]
│   ▣ bash-2   npm test                   已完成 · 退出码 0 · 1:02  [移除]
│   ┌ bash-3 输出（最近 16 KB）
│   │ VITE ready in 812 ms
│   │ ➜ Local: http://localhost:5173/
```

### 4.1 运行中命令的实时输出（待办 D3）

- 前台 bash / pwsh 在开始时就登记成 job（分片 02 §3）。bridge 在 agent 级 `tools/execute` 包装里记下「这个 agent 当前正在执行的命令调用」，之后 `registered` 的同 owner、kind 为 `bash`（Windows 上为 `pwsh`）、label 等于命令原文的 job 就是它（bash / pwsh 互斥，同一时刻只有一个；需实测 E1）。
- 这个 job 的 `output` 事件按 250 ms 合并，`readAt` 取尾部，发 `tool.output`。形状、上限、「只在内存、不进会话文件和 chatSessions」都沿用 [bash 计划书](../../../../../plans/2026-09-24-bash-streaming-and-background-plan.md) §3.1.2～§3.1.4 的设计。
- 渲染层照 bash 计划书 B6：相邻 store `toolLiveOutput` + 叶子组件 `LiveToolOutput`，只在行展开时挂载；折叠时零成本；展开后局部跟随到底。
- 命令超时转后台时：行以结局「已转后台 · bash-3」收尾，后台任务条出现这一项。
- 运行面板的「当前工具进度行」改读 `tool.output` 最后一个非空行（bash 计划书 B5，T053 收口）。

## 5 子代理（待办 D7）

### 5.1 行内泳道（沿用 1.0.x 形制）

- `isDelegationTool` 加上 `subagent`、`subagent_fork`、决策 062 的委派工具；`workflow` 也挂泳道，但一行 workflow 下面可能有多个成员子代理，首版只显示成员数与阶段（可选项）。
- 行文案：`已委派 <代理名> · <description>`。代理名：062 工具取 `agent` 参数；`subagent_fork` 写「分叉」；通用 `subagent` 没有名字，只显示描述。
- **配对**（子会话 → 父调用，决定 `parentToolCallId`）：
  1. 直播：执行期结果值 `{kind:'continuable', subagentId}` 是确证（分片 02 §4）；在它之前，父会话日志里落在该调用 `tool/call` 与 `tool/result` 之间、`label` 等于调用 `description` 的 `subagent/catalog` 先配上，子会话在配上之前的活动先缓存；
  2. 前台 one-shot：`subagent/start` 的 `runId` 与结果值 `{kind:'foreground', runId}` 对账；
  3. 后台 one-shot：结果值 `{jobId}` 对上 job，job 的子会话靠 catalog 配；
  4. 历史：执行期值不落盘，只用第 1 条里的日志位置规则。同一回合里描述完全相同的并行委派按出现顺序配，属已知的小概率误配（需实测 E2）。
- **子会话事件 → `subagent.activity`**：
  - `subagent/start` → `started {agentId: 子会话 id, agentType, description}`；
  - 子会话 `assistant/message` 的文本、思考 → `text` / `thinking`；
  - 子会话 `tool/call` / `tool/result` → `tool.started` / `tool.completed`（输入按白名单裁剪，与 1.0.x 一致）；
  - `subagent/end` → `status` + `report`：completed → completed；aborted → stopped；error → failed；max-tokens → truncated；refusal → failed，报告写「子代理拒绝了任务」；
  - 子会话用量 → 泳道 `usage`，并汇入父会话 `usage.updated.delegated`（P1-4 分片 04 §4 把 `delegated` 交给 P1-7）。
- **续聊**：`send_message` 让已有子代理再跑一段时，活动落回原泳道（按 `agentIndex`），泳道中插一行「续聊 · 12:31」，状态回到运行中。
- **收尾规则要改**：泳道不再在任何 `session.completed` 时被扫成「已取消」（分片 01 §3）。DSH 会话只在引擎失联（宿主崩溃、`disconnected`）时扫；Stop 时是否连带见 U3；其余靠子代理自己的 `subagent/end`。
- **审批卡的来源小标**：子代理的审批卡 `agentId` 取子会话 id（[P1-6 分片 03 §4](../p1-6-permissions/03-design.md)），与泳道的 `agentIndex` 同一个 join 键。后台子代理在父回合结束后出卡、不带 requestId：现有「两轮之间不标等待审批」的规则已覆盖（分片 01 §2），补一条测试。
- **历史重建**：DSH 历史投影输出 `session.history.subagents`，形状同 `SubagentHistorySummary`；P1-9 迁移来的 `aiclient/pi-subagent` 记录由 P1-9e 投成同一形状，渲染层不用改。

### 5.2 运行面板里的子代理清单

```text
 子代理（3）
  ⟳ explore · 调研 goal 投影              2:31   45k tokens   [打断] [定位]
  ✓ 分叉 · 复核方案                        0:48   12k tokens          [定位]
  ✗ review · 检查审批文案                  1:02   拒绝了任务          [定位]
```

- 数据：父会话 `subagentCatalog` + 泳道状态 + 子会话 `subagentTiming`（用时）。
- 操作：打断（运行中的 continuable）；定位（时间线滚到对应委派行并展开）；查看记录（可选，P1-7b 之后：用只读回放读子会话，画在对话框里，需要 P1-4a 的 `readPage` 接受子会话 id）。
- 不做：人直接给子代理发消息（DSH 的 `prompt`，Queue / Steer）。这是新的产品能力，放进想法池。

### 5.3 行内泳道线框

```text
 ◇ 已委派 explore · 调研 goal 投影                          2:31  ⟳
    读取 goal/types.d.ts
    搜索 activation（src）
    回复 目标投影不带 armed 状态……
    状态 运行中 · 12 次调用 · 45k tokens
```

## 6 自主回合与通知

### 6.1 轮次头（决策点 D3）

- 一个回合的第一条输入如果不是人发的，bridge 回显一条 `message.started {role:'user', origin}`，正文取 `source.summary`：

| 触发来源 | `origin` | 轮次头文案 |
|---|---|---|
| `goal` | `{kind:'goal', round, maxRounds}` | ◎ 目标 · 第 4/256 轮 |
| `tool-jobs` | `{kind:'job', jobId, label}` | ▣ 后台任务 bash-3 已结束，自动继续 |
| `subagent-settled` | `{kind:'subagent', childId, label}` | ◇ 子代理 explore 已完成，自动继续 |
| `agent-message` | `{kind:'agent-message', childId}` | ◇ 子代理 explore 发来消息（可展开看全文） |
| `aiclient-retry`、`aiclient-loop-guard` 等内部来源 | 不回显 | —（重试没有回显，T135） |

- 渲染层遇到带 `origin` 的 user 消息画成一行 `AutoTurnHead`（`text-meta text-muted-foreground`，图标 + 文案 + 时间），不画气泡；`groupMessagesIntoTurns` 照常据此开新回合，于是回合时钟、工作组折叠都按「一轮」计。
- 要跟着改的读者：`PromptNavRail` 跳过它；待确认用户消息的逻辑不认它（没有 `attemptId`）；复制回合正文不含它；`historyReplayMerge` 按 `origin.kind` 加 id 合并；用量小标照常把它当回合起点。
- 历史里按同一规则投影（P1-4a 在其分片 03 §1 的表里把 `goal`、`subagent-settled` 列为隐藏，需改为「回合首条时投成轮次头」）。

### 6.2 回合中途的通知

| 来源 | 直播与历史 | 显示 |
|---|---|---|
| `tool-jobs`（注入进正在跑的一步） | 显示 | (i) 后台任务 bash-2（npm test）已结束 · 退出码 0 |
| `subagent-settled`（注入） | 显示 | (i) 子代理 explore 已完成 |
| `agent-message` | 显示，可展开 | (i) 子代理 explore 发来消息 |
| `tool-goal`（收尾指令） | 隐藏 | 目标条已经说明完成或受阻 |
| `model-selection`（`[model changed]`） | 隐藏 | 每条回复的元数据行已写模型名 |
| `repeat-tool-reminder`、`plan-mode` | 隐藏 | 给模型看的提示 |

- 显示的通知画成一行轻量注记（图标 + 一句话，`text-meta text-muted-foreground`），不再用整张 `Alert`（那是错误和导入横幅的形制）。
- 规则表写成共享纯模块 `src/shared/dshNotices.ts`，bridge 直播和历史投影共用，保证两边口径一致。

## 7 其余边界项

- **斜杠菜单**：`/goal`、`/compact` 给中文说明；`/feedback` 隐藏（只在会话日志里记反馈，我方没有反馈通道）；`/plan`、`/permission` 由 P1-6 隐藏；`/skill:<name>` 写法维持（P1-10 分片 03 §2.2），不改成 DSH 的 `/<name>`。
- **`present`**：dsh-base 不挂，P1 不做交付卡；P1-10 试点办公插件时再议。
- **计划审阅**：DSH 的审阅依附它自己的 plan 模式，而决策 047 让我方 plan 模式在 pre-execute 里实现、不接 DSH 的 plan 服务。P1 不做；如果 P1-6 以后改为驱动 `ctx.planMode`，问答卡补渲染 `detail`（markdown 计划）即可。
- **`max-tokens` 截断**：回合以 `max-tokens` 结束时，最后一条回复末尾加一句「回复达到输出上限被截断」（可选，小）。
