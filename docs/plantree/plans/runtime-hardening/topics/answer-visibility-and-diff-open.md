# 正文全露 · 工具行去后缀 · 审阅打开 diff —— 任务执行清单

Role: topic capsule。建立：2026-09-21。来源是用户当日直接提出的界面诉求，**不走审计 / 点验通道**。
任务身份的**权威仍是** [roadmap](../roadmap.md)：本文件不登记状态，只排顺序、定改动点、列测试影响面。两者冲突时以 roadmap 为准。

**本文件是移交施工用的清单。** 建立时尚未实施；当前进度见 roadmap 与 [执行记录](../evidence/batch-k-answer-visibility-2026-09-21/README.md)。任务号登记为 **T107～T110**（[roadmap](../roadmap.md) 批次 K）。
文中所有行号对应建立日当天的 `398a0f4c`，施工前请重新定位。

> 交付物：给施工方直接照做的清单。已含用户拍板结论、既有红线、逐文件改动点、测试影响面。

## Context（为什么做）

用户 2026-09-21 提出三条界面诉求（第 4 条为已登记、暂缓的缺陷）：

1. **模型正文被折进工作组。** 用户的期望是：工作组折叠只隐藏**思考与工具调用**，**agent 输出的正文必须始终可见**。
2. **工具行尾部那一串太长。** 原话：「工具调用，我感觉不需要后缀显示（有的内容太长了影响观感，看的密密麻麻乱得不行），就显示 已思考、x次工具调用，不用显示什么最后运行 xxxxx 的一长串内容」。用户举的实例是 `3 次工具调用 · 最后运行 cd "/e/Projects/chipTestMachine/DIEAlgorithm/.worktrees/bmo-m1" && "c:/program Files/…"`。
3. **审阅条目要点开就看到 diff，并能跳到文件。** 原话：「点击哪个文件，就在审阅面板中展开对应的 diff」。

**一处必须先对齐的事实**：诉求 2 **不是**推翻[决策 031](../decisions/031-tool-calls-aggregate-and-work-group-always-folded.md) 的「头部必须显示当前在做什么」。用户在看到第一版分析把它写成「推翻」后**当场更正**：「不是推翻，是现在显示的内容太长了」。所以本次改动是**对显示内容的收窄**（保留状态词与计数、去掉参数与命令行），决策 031 关于「头部是唯一进度证据、间隙不可为 null」的全部结论继续成立。

**一条与用户描述不符、需要施工方知道的事实**：诉求 2 里说的「3 次工具调用 · 最后运行 …」有两个不同来源，改法不同 —— 聚合行的尾部（`aggregateActionText`）与工作头的当前动作 clause（`deriveTurnCurrentAction` + `formatToolArg`）。两处都要改，见任务 2。

---

## 用户已拍板的结论（不要重新讨论）

2026-09-21 施工前追加确认：当前 `ef26ca5f` 的默认展开是旧分组下的临时处理；T107 正文移出后，过程组默认折叠，保留手动展开与待应答授权强制展开。

| # | 结论 |
|---|---|
| K1 | **所有 `answer` 段一律留在折叠区外**，按发生顺序渲染；折叠区**只收 `process` 段**（工具 / 思考 / 授权卡） |
| K2 | 工具段按现有规则（连续调用聚合成一条，思考与带授权的 run 作分隔符）折叠成一行计数，**沿用决策 031 的聚合口径**，不新造一套 |
| K3 | 过程行只留状态词与计数（`3 次工具调用` / `已思考`）；**末尾的命令行与参数不显示**。思考行的显示**不动** |
| K4 | 审阅打开 diff 采用 **A0 + A1 组合**：A0 = 点条目在面板内就地展开；A1 = 条目上的「打开文件」按钮走现有 `git-diff://` 页签。**A2（按 patch 渲染的单次改动视图）不做** |
| K5 | 「中断后内容消失」**本轮不做**，登记为 T111 待取证（见文末） |

**K4 的一处口径澄清（施工方必读）**：用户原话是「点击哪个文件，就在审阅面板中展开对应的 diff」，同时又选了 A1。这两句话落在**同一次点击**上是矛盾的 —— A0 和 A1 是两种不同的落点。按用户「都展示给我看看」之后的选型，拆成**两个手势**：

- **点条目头（文件名那一行）** → A0：在面板内就地展开该条 diff
- **点条目右侧的「打开文件」图标按钮** → A1：中列开 `git-diff://` 页签

两个手势互不冲突，因为回答的是不同问题（「这一次改了什么」 vs 「这个文件现在相对 git 变了什么」）。**A1 会占用中列、聊天区让位**（`centerLayoutModel.ts` 的 `diffTabActive` 现有行为），施工前要让用户知道这一点。

**一处必须同时修掉的现行行为**：`SessionReviewPanel.tsx` 的 `defaultOpen={index === entries.length - 1}` 会让**最后一条自动展开**。用户报的就是「打开审阅后眼花缭乱」。K4 落地后改为**一律默认折叠，只认用户的点击**；不保留自动展开的例外（理由：条目是会话级累加的，任何自动展开在长会话里都会退化成同一种噪声）。

---

## 施工前必读的红线（违反其一就会翻车）

### R1 · 折叠头保持英文（决策 031 D7）

`messageTimelineWiring.test.ts` 与 `turnProgress.test.ts` 的两条 `HEAD-EN` 守卫钉着「工作头渲染英文」。K3 只改**内容**（去掉参数），**不改语言**。组内工具行、思考行仍是中文。

### R2 · 未应答授权强制展开是红线

`turnWorkGroupAwaitsUser` **一个字不改**。工作组永远折叠之后它是唯一还能自动展开的规则。

### R3 · 纯派生、零 `useEffect`

`turnProcessFold.ts` 的开合判定是入参的纯函数。K1 会**改变该模块的返回形状**（见任务 1），但「不改成一个 effect」这条不动 —— 理由见决策 021：`useEffect` + ref 在 StrictMode 下触发两次，且可能把读者刚展开的组关掉。

### R4 · 正文绝不可因折叠而消失

这是 FB4 的既有裁定（`chatTurn.ts:42`、`turnProcessFold.ts:64` 两处注释都写着）。K1 正是把这条从「最后一个 answer 段」推广到「所有 answer 段」。**任何实现方式如果让某一段正文看不见，就是没做完。**

### R5 · 字号只能用 token

新增或改动的字号必须走 `--text-chat-body` / `--text-chat-process` / `--text-meta` / `--text-code` 等既有 token，`fontDomainScan.test.ts` 在 `chat/` 与 `workspace-shell/` 下禁用任意值。

### R6 · i18n 词条必须是字面量

新词条必须以单引号字面量出现在 `t()` 的调用点上，否则 `i18nCoverage.test.ts` 扫不到（该扫描只认字面量与注释，穿透不了变量）。聚合行现在用 `verbText` 绕开这条，K3 落地后**应回到字面量路径**（见任务 2）。

---

## 任务 1（T107）· 正文全露：折叠区只收 process 段

**改动点**

| 文件 | 改什么 |
|---|---|
| `src/renderer/components/chat/turnProcessFold.ts` | `splitTurnWorkGroup` 的判据由「最后一个 answer 段」改为「**answer 段一律在外，process 段进组**」。返回形状从 `{ leading, grouped, finalAnswer, trailing }` 改为**有序的分段列表**（建议 `TurnWorkSection[]`：`{ kind: 'answer', segment }` 与 `{ kind: 'processGroup', segments }` 交替），因为一个回合现在可能有**多个**折叠组 |
| `src/renderer/components/chat/MessageTimeline.tsx` | `renderSegment` 的调用点从「一个 `TurnProgressHead` 包住全部 group」改为「按分段列表顺序渲染：answer 直接渲染、processGroup 各包一个 `TurnProgressHead`」。`groupedProcessItems` / `groupForcedOpen` 改为按组计算 |
| `src/renderer/components/chat/__tests__/turnProcessFold.test.ts` | 该文件的断言围绕旧形状，需重写为「三个 answer 段 + 两段工具的回合 → 5 个分段、正文段数 = 3」这类判据 |

**必须保留的既有行为**

- 无 answer 的回合（只跑工具、或 error 收尾）：process 段进组，**notice 段留在组外** —— 否则整个回合塌成一行、把唯一的错误信息藏起来。
- 「没有 process 就没有组头」：一段单独的正文不该长出空壳折叠头。
- `turnWorkGroupAwaitsUser` 的强制展开（R2）。
- 已知顺序偏差（notice 夹在两次工具之间时渲染到组后）**本轮不动**，但要在新形状下重新确认它还成立。

**已知代价（必须在验收时看）**：正文与计数行会交替出现（正文 → 计数行 → 正文 → 计数行 → 正文）。2026-09-18 曾因「各种调用、授权穿插在 agent 的输出中，严重影响我的观感」把过程收成一组；K1 是同一个用户在看过三栏对比页后选择的相反形态。**验收判据**：拿一次真实的、工具调用 ≥ 20 次的长回合跑一遍，确认屏幕上过程行数 ≈ 正文段数（而不是 ≈ 工具调用次数）。这一条**不能只靠静态页判断**。

---

## 任务 2（T108）· 工具行去后缀

**两处来源，都要改**

| 位置 | 现在 | 改成 |
|---|---|---|
| `toolCard.ts` `aggregateActionText` + `deriveAggregateRow` | `3 次工具调用 · 最后编辑 App.tsx`（`verbText` = 计数 + `·` + 动作） | 只留 `3 次工具调用`；`verbText` 不再需要，聚合行走 `verb` 的字面量路径（R6 的债一并还掉） |
| `MessageTimeline.tsx` `TurnProgressHead` 的 `actionClause` | `Working 12s · Reading App.tsx`（`deriveTurnCurrentAction` 的 run 经 `formatToolArg` 补参数） | 只留状态词（`Working 12s · Reading` / `已思考` 一类），**参数与命令行不渲染**。`deriveTurnCurrentAction` 保留（决策 031 的「间隙不可为 null」仍是活的），只是不再取参数 |

**连带清理（只清本次改动产生的孤儿）**

- `ToolRowView.verbText` 如果不再有生产者，**删掉该字段**与该字段的注释，而不是留着不用 —— 同决策 031 §5 的判据（该文件自己的戒律禁止保留无人消费的导出规则）。
- `aggregateActionText` 若整体不再被调用，删掉；`toolActionNoun()` 的调用点随之消失则一并核。
- 单条（未聚合）工具行的 `arg`（路径、命令）**保持现状不动**：K3 说的是「后缀」，单条行的主参数不是后缀。这一条已于 2026-09-21 在施工前确认：保留单条工具行主参数。

**验收判据**：一个含长命令行（≥ 100 字符）的真实回合里，**工作头与聚合行都不出现命令行文本**；组内的单条工具行是否仍显示参数按上条确认结果定。

---

## 任务 3（T109）· 审阅条目：面板内就地展开（A0）

**改动点**：`src/renderer/components/workspace-shell/SessionReviewPanel.tsx`

- `defaultOpen` 一律 `false`（去掉 `index === entries.length - 1`）。
- 条目展开时渲染 diff 的**行号栏**：行号取自 patch 的 hunk 头（`@@ -a,b +c,d @@`），新增行用右列行号、删除行用左列行号；**取不到时留空而不是编造**。
- 「打开文件」图标按钮移到条目头右侧，与展开手势分开（见 K4 的口径澄清）。
- 条目头补 hover 态与键盘可达（现在只有 `CollapsibleTrigger`）。

**现状可复用**：`entry.patch` 已经是完整 unified patch，`lines` 的分行与 `+/-/@@` 着色已在实现里，本任务只加行号与手势拆分。

---

## 任务 4（T110）· 审阅条目 → 中列 diff 页（A1）

**改动点**

- `SessionReviewPanel.tsx` 的「打开文件」按钮改为调 `useEditorStore.getState().openDiffTab({ kind: 'workdir', path: entry.path, status: entry.status })`（`stores/diffTabTarget.ts` 的现成形状），**不再**调 `onShowFiles`。
- `WorkspaceShell.tsx` 传给审阅面板的 `onShowFiles` 若失去最后一个消费者，删掉该 prop 的传递链（含 `filesOpen`）。

**必须写进交付说明的一句**：A1 打开的是**中列的 `git-diff://` 页签**，`diffTabActive` 会让中列独占（聊天区让位）。这是 `centerLayoutModel.ts` 的既有行为，不是本任务的引入，但用户会第一次在审阅场景里碰到它。

**不做**：A2（按 unified patch 渲染的独立视图）。仓库目前没有任何这类组件，成本最高、收益最小；A0 展开的 diff 已经能回答「那一次改了什么」。

---

## 测试影响面

| 文件 | 影响 |
|---|---|
| `chat/__tests__/turnProcessFold.test.ts` | **重写**（返回形状变了） |
| `chat/__tests__/messageTimelineWiring.test.ts` | `HEAD-EN-1` 守卫不动；若头部合成参数的调用点变了需同步 |
| `chat/__tests__/turnProgress.test.ts` | 同上（`HEAD-EN` 两条） |
| `chat/__tests__/toolVocabulary.test.ts` | 若删 `toolActionNoun` 的调用点需同步 |
| `chat/__tests__/fontDomainScan.test.ts` | 只在新写任意字号时命中（R5） |
| `shared/i18n` 覆盖测试 | 新词条必须字面量（R6）；`Last {{action}}` 若失去消费者应从目录删除 |
| `workspace-shell/__tests__/sessionReviewInteraction.test.ts` | 默认折叠改为一律折叠会打掉现有断言 |
| `workspace-shell/__tests__/sessionReview.test.ts` | 派生层不变，预计无影响 |
| `workspace-shell/surfaces/__tests__/diffCenterTabsStatic.test.ts` | A1 复用既有链路，预计无影响（可作为回归证据） |

**验证方式**：逐任务跑对应单文件测试 + 三套 `tsc --noEmit`；本机资源受限（见 CLAUDE.md），**不装依赖、不跑全量**，全量门禁以 CI 为准并在交付说明里写明。任务 1 与任务 2 必须串行（同时改 `MessageTimeline.tsx` / `i18n.ts`，是该仓库 2026-09-19 已记录过的踩踏模式）；任务 3 与任务 4 同文件，也应串行。

---

## 演示页（已出，用户已看过并拍板）

| 文件 | 内容 | 用户结论 |
|---|---|---|
| `/tmp/aiclient-preview-answer-fold-and-diff-open.html` | 正文折叠规则 × 工具行后缀两个开关 + A0/A1/A2 三方案 | 选 A0 + A1 |
| `/tmp/aiclient-preview-answer-visible-3ways.html` | 同一回合三栏对比：A 现状 / B 正文全露 + 工具折叠 / C 正文全露 + 取消折叠 | **选 B** |

两页都放在 `/tmp`（当时工作区有其它会话在改）。若需要长期留存，收口时移入本计划的 `evidence/`。

---

## 登记在案、本轮不做（T111）

**中断 / 报错后，该回合先前的流式正文消失**（用户 2026-09-21 报告，当日决定「先放一放」）。

已排除的路径（2026-09-21 只读分析）：`session.failed` / `session.stopped` 两个 reducer 只改 status，流式 append 路径（`message.delta` / `appendTextBlock`）不清理任何 blocks。

未排除的两条嫌疑，待取证：

1. **历史重读合并**（首要）：`historyReplayMerge.ts` 的折叠身份是「同 role + 文本相同」，中断回合被截断的文本与 JSONL 行匹配失败时的行为；以及 `chatSessions.ts:707` 在 `historyMessage.incomplete && blocks.length === 0` 时插入占位行的分支。
2. **折叠规则**：任务 1（T107）落地后此条很可能自然消失或变形，**因此 T111 应排在 T107 之后取证**，否则可能修一个已经不存在的现象。

**取证方式（最小代价，符合本机资源约束）**：起一次 dev、复现一次中断，dump 那条消息的 blocks（类型 + 长度 + 首 40 字符）与是否走了 history 合并。不装依赖、不跑全量。
