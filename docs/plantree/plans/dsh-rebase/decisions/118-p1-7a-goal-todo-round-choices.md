# 决策 118：P1-7a 目标条、待办卡、轮次头与通知行的实现取舍：原型比对结论；`goalActivation` 提前到 P1-7a；`worker.command` 带外执行 `/goal …`；`worker.panels` 补水；「待送达」气泡的正式样式

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- 用户裁决：[决策 109](109-user-rulings-p1-7-prototype-2026-09-28.md)（浮动子窗口；三处显示不算重复；不做停靠；原型 README 第 5～7、9、10 题未定的按原型做法）、[110](110-user-rulings-2026-09-28-batch2.md)、[090](090-user-rulings-2026-09-28.md)（默认跟随 DSH；修订 068）；
- 已批准的决策：[068](068-renderer-layout-bars-and-subagent-list.md)（经 090、109 修订：待办、目标两条留在输入框上方）、[072](072-renderer-data-channels.md)、[093](093-interject-via-dsh-steer.md)、[099](099-p1-4d-scope-dsh-data-only.md)、[106](106-p1-4d1-live-mapping-choices.md)（第 36 条：目标轮在 P1-7a 之前显示为空气泡）；
- 待审批的前序决策：[111](111-p1-4c1-turn-semantics-choices.md)（插话不再暂停目标；「待送达」气泡的最终样式归 P1-7）、[113](113-p1-4d2-commands-and-projection-choices.md)（`session.projection` 首次快照推迟到第一个事件；补水归 P1-7 的 `worker.panels`；第 19 条「命令不进历史」待拍板，本任务不做命令投影）；
- 方案：[P1-7 方案](../topics/p1-7-renderer.md) §4.1～4.3、§6 的 P1-7a 行、§7；[分片 03](../topics/p1-7-renderer/03-panels.md) §0～§3、§6；[分片 05](../topics/p1-7-renderer/05-changes-tests.md)；
- 原型（验收基准）：[p1-7-prototype-2026-09-28](../evidence/p1-7-prototype-2026-09-28/)（README、`prototype.html`、`shots/B-*`）；
- DSH 源码：`dsh-command-goal/lib/index.js`（`/goal` 语法与文案）、`dsh-commands/lib/index.js`（`execute` 同步写 `command/run`）、`dsh-goal/lib/types/types.d.ts`（`GoalActivation`、`goal/activation-changed`）、`dsh-goal/lib/index.js`（`setActivation` 只在变化时发事件，初值 `disarmed`）。

改动留在工作区，由编排者复跑后提交。**第 1、9、13、24、26 条请重点审批。**

## 规则

### 一、开工前的原型比对

1. **与用户裁决（109、110）没有冲突，照原型施工。** 逐条比对的结论：

   | # | 比对项 | 原型 | 决策 / 方案 | 结论 |
   |---|---|---|---|---|
   | a | 输入框上方放几条 | 待办、目标两条（场景 B） | 109、090 修订 068：保留两条，后台与子代理改浮动子窗口 | 一致；后台、子代理归 P1-7b |
   | b | 109 未定的第 5～7、9、10 题 | 图标、位置记忆、徽标色、子代理窗「展开」、未绑定目录的终端 | 按原型做法 | 都不落在两条窄条上；P1-7a 只用到原型的图标（`list-checks`、`target`、`pause`、`triangle-alert`） |
   | c | 条数与顺序 | 待办在上、目标在下，各 28 px，间隔 4 px，下方 8 px | 方案 §1 原为三条 | 按原型：两条，共多占 68 px（原型实测值） |
   | d | 目标条状态 | 画了 4 种：进行中、已暂停、已挂起、轮次上限 | 分片 03 §2 列了 7 种 | 7 种都做，沿用原型的写法（见第 14 条）；README 自己写着「目标的其余状态」没画 |
   | e | 「因插话暂停」 | 没有 | 111、093：插话并入当前回合，目标不暂停 | 一致，不做这一态 |
   | f | 挂起态文案「重开会话、回退或打断后需要手动继续」 | 有 | 分片 03 §2 同句 | 照用；这里的「打断」指 Stop（非目标轮里的 Stop 只解除 armed），与插话无关 |
   | g | 输入框占位「Ctrl+Enter 在下一轮后插话」 | 原型照抄了代码里的旧文案 | 093 改为 steer，下一步并入 | 原型与决策不一致但不是裁决冲突：旧文案本身过期。改为「Ctrl+Enter 并入当前回合」（第 26 条） |
   | h | 两条相对问答 / 审批浮层与排队条的位置 | 原型没有画这两样（README「原型里没有画的」） | 方案 §1：问答 / 审批卡离输入框最近，排队条在输入框列内 | 按方案：待办 → 目标 → 问答卡 → 审批卡 → 输入框列（排队条在列内） |
   | i | 「待送达」气泡 | 没有 | 111 第 12 条：最终样式归 P1-7 | 按设计规范做最小可辨认样式（第 24 条） |
   | j | 通知行 | 测量脚本认 `.notice`，但页面上没有画 | 分片 03 §6.2：图标加一句，`text-meta` 灰字 | 按方案（第 21 条） |
   | k | 轮次头 | 目标轮：图标 + 「目标 · 第 2/256 轮」+ 细线 + 时间 | 分片 03 §6.1 同形 | 照做；后台 / 子代理唤醒的轮次头原型没画，同形换图标（第 19 条） |
   | l | 挂起态需要 armed 信息 | 有挂起态 | 099 第 11 条、106 第 41 条把 `goalActivation` 划给 P1-7b | 验收基准要挂起态，所以提前到 P1-7a（第 9 条）；只是任务切分提前，行为与 072 第 1 条一致 |
   | m | 068 正文「三条约占 84 / 100 px」 | 两条 68 px | 068 已被 090、109 修订 | 在 068 加修订注记 |

2. 原型 README 的「原型自己定的细节」第 1 条（轮次上限、挂起态文案后面接目标原文）照做，并推到没画的几态：受阻态、已完成态同样接目标原文。

### 二、线协议（`src/shared/types/`）

3. **`goalActivation` 是 bridge 合成的投影 key**（072 第 1 条）：`BRIDGE_PROJECTION_KEYS = ['goalActivation']`，与 DSH 自己的 `SESSION_PROJECTION_KEYS` 分开列；值是 `{goalId, revision, activation: 'armed'|'disarmed'} | null`。渲染层只拿它对照同一个 `goalId` 的 `goal`，因为目标被编辑时 revision 会变而 activation 不变、没有新事件。P1-7b 往同一个数组加 `jobs`。
4. **`worker.command {logicalSessionId, line}`** → `{ok: true, output?} | {ok: false, error}`：
   - `line` 以 `/` 开头、不超过 16 KiB（目标原文可能很长，允许换行）；
   - DSH 回答的错误（例如目标状态不对）是 `ok: false`，不是请求失败；请求失败只有两种新码：`WORKER_COMMAND_UNKNOWN`（不是本会话可带外执行的命令）、`WORKER_COMMAND_TIMEOUT`（超过 8 秒预算被取消，可重试，预算在 Main 的 10 秒热请求超时之内）。
5. **`worker.panels {logicalSessionId}`** → `{projections}`：与 `session.projection` 同一套 key 与值。Main 侧用 `sanitizeWorkerPanels` 只放行已知 key；新增 key 时类型会逼着改这张表。

### 三、bridge（`src/dsh-host/bridge/panels.ts`、`dshSessionRuntime.ts`）

6. **带外命令**：只执行按 DSH 语法解析出、本会话 agent 已知、且不在隐藏集合（`/plan`、`/permission`、`/feedback`）与窗口自有集合（`/compact`，它有自己的 RPC 与 45 秒预算）里的命令；不带附件。
   - **不开回合、不发任何事件**：DSH 照常写 `command/run`、`command/done`，但直播翻译只给「发送带来的命令」回显（113 第 6 条），带外命令在界面上什么也不出现，结果只经 RPC 答复回到按钮。
   - **回合进行中不拒绝**：目标条的「暂停」本来就是冲着正在跑的那一轮去的，DSH 自己的 pause 会中止它（P0-2 实测）。
   - RPC 在 worker 里本来就串行，所以不会与 rewind、fork 交错。
7. **`worker.panels`**：没 bootstrap 或已 dispose 答空；不会为了读而 bootstrap；不发事件。
8. **`goalActivation` 的来源**：`ctx.goals.get(agent).activation`（bootstrap、回退、`worker.panels` 时读）与 `goal/activation-changed`（只收本会话的 `sessionId`）。没有 `ctx.goals` 服务或读失败，就不报这个 key（等同「未知」），会话照常。
9. **bootstrap 快照只在有当前目标时带 `goalActivation`**；`worker.panels` 则总带（没有目标时为 `null`）。理由：
   - 没有目标时 activation 没有意义，渲染层也不读；
   - 这样 26 个录制场景（都没有目标）的 `stream` 一个字节都不变，不必重录；
   - DSH 的 `setActivation` 只在值变化时发事件、初值是 `disarmed`，所以没有目标的会话也不会冒出 activation 事件（按源码核对，录制 `--check` 复核）。
   - 代价：渲染层在「目标被清除」之后可能还留着一份旧的 activation；它按 `goalId` 对照，读不到就不用。

### 四、Main 与 preload

10. **`chat:runSessionCommand`**：会话必须有就绪的 slot，并按发送者认领（与 `/compact` 相同）；**不做空闲检查**（理由同第 6 条）。worker 的答复原样返回，格式不对就抛 `worker_command_failed`。
11. **`chat:getSessionPanels`**：是读，不认领、不要求会话在运行；没有就绪 slot 的会话答空列表而不是报错（渲染层对每个显示的会话都会问，多数会话没在跑）。与命令菜单 `chat:getSlashCommands` 同一个口径。
12. 旧引擎 `NativeWorkerRuntime` 补了两个空实现（命令答 `WORKER_COMMAND_UNKNOWN`、面板答空），保持 T025「所有方法必需」的契约；随 P1-12 一起删。

### 五、渲染层：相邻 store 与补水（`sessionPanelsModel.ts`、`stores/sessionPanels.ts`）

13. **补水的时机**（113 第 12 条的遗留）：
    - 收到某会话的 `session.resumed`（冷 / 暖 resume、宿主重启后的 refresh）就问一次；
    - 显示一个本窗口还一无所知的会话（刷新之后、切过去）时问一次；
    - 回退不问：bridge 在回退时立刻发出子会话的整份快照。
    - 同一会话同时只有一个请求在路上。
14. **补水与直播的先后**：`worker.panels` 的答复走 invoke 回复，事件走事件通道，两者没有先后保证。每个 key 记收到过几次直播事件，发请求时记下这份计数；答复回来时，只填计数没变的 key。已经到了的新事件永远不会被一份更早读出的答复盖掉。
15. **「有活的 worker」（`live`）**：收到任一 `session.projection`，或补水答复非空，就算有；收到 `disconnected`（slot 被回收、引擎重启）就算没有；一份空答复只有在发请求之后没有新事件时才把它清掉。按钮只在有活 worker 时出现；**没有活 worker 的进行中目标一律显示「已挂起」且不带按钮**——没有进程会去续跑它。
16. 条的展开状态、已完成目标的「收起」、命令在途标志都只存在内存里，按会话记，随会话修剪（`pruneSessionScopedRendererState`）。刷新窗口后展开状态回到折叠。

### 六、目标条（`GoalBar.tsx`、`GoalEditDialog.tsx`）

17. **七种状态**（左侧文案，接着是目标原文；右侧一个按钮 + ⋯ 菜单 + 展开箭头）：

    | 状态 | 判据 | 左侧 | 按钮 |
    |---|---|---|---|
    | 进行中 | active、armed、会话有回合在跑 | ◎（运行色）目标 · 第 3/256 轮 · 进行中 · 〈目标〉 | 暂停 |
    | 等待下一轮 | active、armed、会话空闲 | ◎（运行色）目标 · 第 3/256 轮 · 等待下一轮 · 〈目标〉 | 暂停 |
    | 已挂起 | active、disarmed，或没有活 worker | ◎ 目标已挂起 · 重开会话、回退或打断后需要手动继续 · 〈目标〉 | 继续（没有活 worker 时无按钮） |
    | 已暂停 | paused | ‖ 目标已暂停 · 第 3/256 轮 · 〈目标〉 | 继续 |
    | 受阻 | blocked，原因不是 `round-limit` | ! 目标受阻 · 〈DSH 的原因〉 · 〈目标〉 | 继续 |
    | 轮次上限 | blocked、`round-limit` | ! 目标已用完 256 轮 · 〈目标〉 | 继续（轮数用完时置灰，悬停提示「让助手调高轮数上限，或清除目标后重新开始」） |
    | 已完成 | complete | ✓ 目标已完成 · 共 5 轮 · 〈目标〉 | 收起 |

    - 「继续」是否置灰按 DSH 自己的规则算：`roundsStarted >= maxGoalRounds` 时 DSH 拒绝 resume，这时才置灰；上限被调高后即使原因还写着 `round-limit` 也能点。
    - 活 worker 上 activation 未知（只可能是一瞬间）按 armed 算。
18. **按钮与菜单全部走 `worker.command`**：暂停 `/goal pause`、继续 `/goal resume`、编辑 `/goal edit <文本>`（对话框，保存后等 DSH 接受才关）、清除 `/goal clear`（AlertDialog 二次确认）、复制目标文本（剪贴板）。菜单顺序照原型：编辑、复制、清除。DSH 拒绝（`ok: false`）或请求失败时弹错误 toast，写出 DSH 的原句；命令在途时按钮置灰。「收起」只在本窗口隐藏这一个已完成的目标，按 id + revision 记，目标一变就重新出现。展开后显示目标全文、受阻原因、「创建于 / 最后更新 / 已用轮数」。

### 七、待办卡（`TodoCard.tsx`）

19. **折叠一行**：「待办 3/5 · 正在：…」；多项进行中写「正在：A 等 N 项」（N 是进行中的项数，原型写法）；全部完成写「待办 5/5 已完成」；**没有进行中、又没做完时写「待办 2/5 · 下一项：…」**（原型与方案都没写这一格，自定）。`null`（新一轮开始时 DSH 清空）或空清单不显示。
20. **展开**：逐项一行 24 px；待做 `Circle`、进行中 `CircleDot`、完成 `CircleCheck` 灰字加删除线；超过 8 项限高滚动（`max-h-48`）。清单组件 `TodoList` 单独导出，给 P1-7c 的 `todo_write` 工具行展开体复用。

### 八、轮次头与通知行（`DshTimelineRows.tsx`、`dshTimelineRowModel.ts`）

21. **轮次头**（替换 106 第 36 条的空气泡）：带 `origin` 的 user 消息画成原型的 `.autohead`：图标 + 文案 + 细线 + 时间（`text-meta` 灰字）。
    - 目标轮：◎「目标 · 第 3/256 轮」（没有上限时「目标 · 第 3 轮」）；
    - 后台任务唤醒：`Layers`「后台任务已结束，自动继续 · 〈DSH 的一句话摘要〉」；
    - 子代理完成唤醒：`Users`「子代理已完成，自动继续 · 〈摘要〉」；
    - 子代理来信：`Users`「子代理发来消息 · 〈正文〉」，长的可点开看全文。
    - 图标沿用原型会话栏上后台任务、子代理两个按钮的图标。106 第 29 条已说明 DSH 的来源里没有 jobId、label，所以用 DSH 自己的摘要，不编造。
    - 时间取该消息的 `message.started` 时间（直播），回放取历史时间戳。
    - 它照常开一个新回合（回合时钟、工作组都按一轮算）；左侧提示词导航条不列它（没有可跳回的输入）。复制回合、待确认用户消息、历史合并本来就不认它，不用改。
22. **通知行**：DSH 通知画成一行：`Info` 图标 + DSH 的一句话，`text-meta` 灰字，截断，悬停看全文；超过 160 字或有换行的可点开。
    - 直播：`custom.message` 的 customType 是 `dsh:<来源>` 时，`chatSessions.ts` 只存正文，并在新可选字段 `ChatMessage.noticeKind` 记下来源（这是继 `origin` 之后的第二个可选字段；不改状态结构）；
    - 回放：历史行按 `liveMessageId` 以 `dsh-notice-` 开头认出（投影与金样本都不改）；
    - 其他 custom message 仍是原来的 Alert。
23. **命令的回答**（`dsh:command` / `dsh:command-error`，113 第 6 条的发送命令）画成同一种轻量行，但**整段显示**（用户自己要看的）：`SquareSlash` 图标；出错的用 `CircleX`（`text-destructive`）。命令进不进历史仍按 113 第 19 条待拍板，本任务不做投影。

### 九、「待送达」气泡与输入框提示

24. **「待送达」气泡的正式样式**（原型没有，按设计规范做最小可辨认样式）：同一个气泡外形与尺寸，边框改成虚线、不画底色（`border-dashed bg-transparent`），底部「待送达」前用 `Clock3` 图标代替转圈（它在等回合的下一步，不是在发送），悬停提示「会在当前回合的下一步并入」。取走后由带同一 `attemptId` 的回显换成正式气泡，行为不变（111 第 12 条）。
25. 待送达气泡的 class 走 `chatTimelineLayout.userBubbleAwaitingClass()`，`messageTimelineWiring.test.ts` 的 `[D3-1]` 随之更新期望（仍要求挂布局函数而不是字面量）。
26. **输入框运行中的占位文案**改为「Agent Host 正在运行 —— Enter 排队，Ctrl+Enter 并入当前回合…」（原为「在下一轮后插话」，093 之后已不准确；原型照抄了旧句）。

### 十、样式细节

27. 两条的外观与排队条一行同一套：`rounded-sm border bg-muted/50 text-meta`；头 26 px（`h-6.5`）加边框正好 28 px；图标按钮 24 px（设计规范的图标按钮，悬停与键盘焦点同一层底色）；文字按钮用 `Button size="xs" variant="ghost"`，强制 `text-meta`（CJK 不低于 14 px）。截断文字用 `title` 悬停看全文（与排队条同一做法），没有另套 Tooltip。宽度走 `ReadingColumn`，与输入框对齐。
28. 方案分片 05 建议的 `src/shared/dshPanels.ts` 没有建：视图类型 P1-4d2 已经放在 `runtimeEvents.ts`（`DshTodoItem`、`DshGoalProjection` 等），再建一份是重复。

### 十一、测试与录制

29. 新增与扩展的测试：bridge `commandsAndState.test.ts`（带外命令、拒绝、超时、回合中不拒、`worker.panels`、activation 基线与边沿，8 例）；`piWorkerRpcServer.test.ts`（两个 RPC 的分派与载荷，3 例）；`workerRpc.test.ts`（守卫，3 例）；`WorkerManager.test.ts`（3 例）；渲染层纯模型 `sessionPanelsModel.test.ts`（16 例）、`dshTimelineRowModel.test.ts`（6 例）、store `sessionPanels.test.ts`（5 例）；挂载 `sessionPanelStripsMount.test.ts`（5 例）、`dshTimelineRowsMount.test.ts`（3 例，挂真 `MessageTimeline`）；`dialogPopupPaddingStatic.test.ts` 登记 `GoalEditDialog`。挂载测试的 `electronAPI` 桩都在 `vi.hoisted`。
30. `bridge-smoke` 的宿主 H 加两项判定：`worker.panels` 答出四个 key（`goalActivation` 为 `null`）；`worker.command` 带外执行 `/goal`（DSH 的用法说明）、`/goal pause`（没有目标，DSH 拒绝为 `ok: false`）、拒绝 `/plan`，三者都不在通道上发事件。
31. 录制：本任务不改 26 个场景的任何输出（第 9 条），`--check` 预期无差异；没有新增录制场景（带目标的真宿主场景留给 P1-7d，见遗留）。

## 取舍

- **`goalActivation` 提前**：不提前，目标条在重开会话后会停在「等待下一轮」却永远不动，用户没有「继续」可点；原型的挂起态也做不出来。代价是 P1-7a 碰了 bridge（约 60 行）。
- **带外命令不限于 `/goal`**：072 第 2 条说「还能给别的命令复用」。只排除隐藏的与窗口自有的；目前产品里只有目标条在用。
- **快照只在有目标时带 activation**：换来录制零差异；代价见第 9 条。
- **没有活 worker 时显示「已挂起」**：比显示「进行中」诚实；代价是一个被回收的会话在重新打开前，条上说「已挂起」而按钮不在。
- **通知行不按来源分图标**：方案 §6.2 三类都是 (i)；历史行本来也不带来源（不改投影与金样本）。

## 待用户拍板

- **第 9 条**：`goalActivation` 从 P1-7b 提前到 P1-7a，且 bootstrap 快照只在有目标时带它。
- **第 13 条**：补水只在 `session.resumed` 与「首次显示无数据的会话」时问，回退不问。
- **第 24 条**：「待送达」气泡用虚线、无底色、时钟图标。
- **第 26 条**：输入框运行中的占位文案改为「Ctrl+Enter 并入当前回合」。
- 第 19 条「下一项：…」、第 17 条已完成态的「收起」按钮，属原型没画、方案写得很粗的细节。

## 影响与遗留

- **P1-7b**：在 `BRIDGE_PROJECTION_KEYS` 加 `jobs`，`worker.panels` 顺带返回；`live` 标志与补水顺序规则可直接复用；后台任务、子代理两个浮动子窗口与 `worker.job.kill` / `worker.job.read` / `worker.subagent.interrupt` 三个 RPC 照同一套 IPC 写法。
  - 修订注记（2026-09-28）：已照此落地，`worker.panels` 总带 `jobs`（空列表也带），bootstrap 快照只在有 job 时带；见[决策 119](119-p1-7b-jobs-subagents-choices.md)（待审批）。
- **P1-7c**：`todo_write` 行展开体接 `TodoList`；`get_goal` / `create_goal` / `update_goal` 的动词与图标。
  - 修订注记（2026-09-28）：已照此落地，`update_goal` 按 `action` 选词，edit 与目标条菜单同为「编辑目标」，三个工具都用 Target 图标；见[决策 120](120-p1-7c-tool-rows-choices.md) 第 5、6、14 条（待审批）。
- **P1-7d**：
  - 合成态点验：经 Vite import `/stores/sessionPanels.ts`，把合成的 `session.projection` 灌进当前会话，逐态截图（7 种目标状态、待办折叠 / 展开、三种轮次头、通知行、待送达气泡）；
  - 真宿主：`P0-GOAL-PAUSE` 等标记，核对暂停中止当前轮、继续续跑、Ctrl+R 后补水、杀宿主后变「已挂起」；
  - 实验 E3（`goal/activation-changed` 在创建、暂停、恢复、宿主恢复、fork 时的顺序）本任务没有跑，只按源码读法与单测；
  - 真宿主上「有目标时 activation 快照与边沿」没有自动化覆盖（冒烟只覆盖无目标的路径）。
- **仍然开着的**：
  - 113 第 19 条（命令进不进历史）待拍板；
  - 111「遗留」的第一条（引擎重启后收件箱里的插话回显不带 `attemptId`，待送达气泡收不掉）没有动；
  - 只读预览没有面板（`worker.panels` 需要活的 slot），方案里「让只读回放顺带返回投影值」仍是可选项。
- 相关决策加了修订注记：068、099、106、111、113。
