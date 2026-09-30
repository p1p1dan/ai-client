# 决策 144：P1-7e 第四组（e4 文案与问答卡）的实现取舍

日期：2026-09-30。**状态：自主决定，待用户审批。**

依据：

- [P1-7e 分组](../topics/p1-7e-pointcheck-fixes.md) 的 e4 行；
- [P1-7d 点验证据](../evidence/p1-7d-gui-2026-09-30.md) 的问题 9（三批各自的「同问题 9」补充）、35、8，以及第 3 批「已知问题的复现情况」里迁移失败卡的 `retry`；
- [决策 138](138-p1-7e-e1-sidebar-choices.md) 第 21 条（开屏演示名 `Live Agent Host` 归 e4）、[决策 140](140-p1-7e-e2b-choices.md) 第 16 条（「Context summary」标题）、[决策 139](139-p1-7e-e2a-timeline-sessions-choices.md) 问题 2（空态英文）、[决策 123](123-p1-9e-migration-renderer-choices.md) 遗留（历史卡片的 `Retry`）；
- [决策 114](114-p1-4d3-ask-user-choices.md) 第 5、6、8 条（多选拆分、跳过、撤卡）、[决策 090](090-user-rulings-2026-09-28.md)（跟随 DSH）、[决策 040](040-default-effort-and-settings-mapping.md) 第 2 条（没选档位时发 medium）；
- 设计规范 `docs/design-system.md`：「按钮文案强制小写」与它的 `normal-case` 豁免、「CJK 级联规则」第 3 条（10px 禁止承载 CJK）。

改动留在工作区，由编排者复跑后提交。**第 2、7、11、20、24 条请重点审批。**

## 落地了什么

- 渲染层文案：`chat/` 的 `ChatComposer.tsx`、`ComposerAttachMenu.tsx`、`ComposerModelTrigger.tsx`、`composerModel.ts`、`efforts.ts`、`MessageTimeline.tsx`、`QuestionCard.tsx`、`SessionTreeDialog.tsx`、`sessionTree.ts`、`slashCommands.ts`、`retryBanner.ts`、`hostStatus.ts`、`middleColumnLayout.ts`、`modelMissingError.ts`、`attachmentLimits.ts`、`dshTimelineRowModel.ts`；`workspace-shell/` 的 `LeftNav.tsx`、`sidebarTree.ts`、`SessionBar.tsx`、`SessionReviewPanel.tsx`、`useCapacityReclaimNotice.ts`；`settings/` 的 `SettingsContent.tsx`、`PiModelManagementSettings.tsx`、`PermissionPolicySettings.tsx`、`LegacyAssetNotice.tsx`、`LegacyAssetsSettings.tsx`；`onboarding/OnboardingView.tsx`。
- 对话标题：`chat/sessionIndex/sessionTitle.ts`（`NEW_CHAT_TITLE`、`LEGACY_SEED_TITLE`、`displaySessionTitle`、`isStartupSeedSession`）、`workspace-shell/useSyncChatWorkspaceTree.ts`、`chat/ChatWorkspace.tsx`、`stores/chatSessions.ts`（DEMO 种子）、`stores/chatSessionActions.ts`（默认标题改用常量）。
- 问答卡：`src/shared/questionAnswer.ts`（新，多选答案的拼接与拆分）、`src/dsh-host/bridge/questions.ts`、`src/shared/types/runtimeEvents.ts`（`question.resolved.stopped`）、`stores/chatSessions.ts`（`questionStopped`）、`chat/questionCardModel.ts`、`chat/QuestionCard.tsx`。
- 摘要标题常量从 `shared/dshHistory/projection.ts` 挪到 `shared/dshHistory/types.ts` 并导出（`CONTEXT_SUMMARY_TITLE`），投影输出不变。
- `src/shared/i18n.ts`：改了 16 条旧词条（删去不再使用的 `Pi`，其余 15 条换英文键或中文），文末新增一块 43 条（中英）。
- 没有动 Main，没有动金样本；`bridge-record --check` 28 个场景无差异。

## 规则

### 问题 9：英文与 pi 残留

标识符（模型 id、工具名、命令名、分支名）保留原文；「Pi」指 1.0.x 引擎的地方改成中性说法或删掉不再成立的句子。下表「改前」是点验看到的中文界面，「改后」是现在的中文；英文界面的变化写在括号里。

1. **侧栏失败徽标**：`failed` → 「失败」（英文 `Failed`）。
2. **侧栏徽标改用大一档**：失败徽标与「类别」徽标（临时、远程）改为 Badge 的 `lg` 档（桌面 14px）。设计规范不许 CJK 落在 10px（原来的 `sm` 档），这两处原来是英文所以没碰到这条。分支 chip 仍是 `sm`（拉丁分支名）。**代价**：这两个徽标比分支 chip 高一点（22px 对 16px，行高 28px 不变），GUI 复核时看是否可接受；嫌重可改成图标加提示。
3. **侧栏类别徽标**：`temporary` / `temp` → 「临时」，`remote` → 「远程」（英文 `Temporary` / `Remote`）。改在显示层（`sidebarRowForDisplay`）：派生出来的行仍带标识符，排序、搜索、`variant` 都读标识符。
4. **模型菜单**：
   - 触发器 `Automatic` → 「自动」；分组标题 `Model` / `Reasoning effort` → 「模型」「推理强度」；
   - 档位 `Default / Off / Minimal / Low / Medium / High / X-High / Max` → 「默认 / 关闭 / 极低 / 低 / 中 / 高 / 极高 / 最高」，触发器后缀同样；
   - 档位提示（悬停）改中文；`Medium` 的提示原文「Moderate reasoning; Pi applies this by default」不再成立的部分改成当前事实：「中等推理；没有选择档位时使用这一档」（英文 `Moderate reasoning; used when no level is chosen`，依据决策 040 第 2 条）；
   - 菜单底部的目录状态行（7 句，如「Waiting for Agent Host to become ready」→「正在等待对话引擎就绪」）与它的 `Retry` → 「重试」。英文键没改。
   - 模型名称本身不翻译。
5. **斜杠菜单来源标签**：`builtin` → 「内置」，`command` → 「命令」，`skill` → 「技能」，1.0.x 的 `prompt` / `extension` → 「提示词模板」「扩展」；认不出的来源原样显示。菜单画的是「显示行」（`slashRowsForDisplay`），执行命令仍按目录里的原始 `source` 判断归属，不受影响。
6. **无障碍标签与提示**：
   - `Copy reply` / `Copied` → 「复制回复」「已复制」；
   - `Attach files`（按钮的 aria-label 与 title，以及菜单项文字）→ 「添加附件」；
   - `Your answer` → 「你的回答」；同一个输入框的占位 `Type your answer…` / `Value is hidden while you type` → 「输入你的回答…」「输入内容不会显示」；
   - `Remove <文件名>` → 「移除 <文件名>」；
   - 同一输入框里的 `Dismiss attachment notice` / `Dismiss queue notice` → 「关闭附件提示」「关闭排队提示」；`@` 弹层底部的 `Navigate / Select / Close` → 「导航 / 选择 / 关闭」（`/` 弹层原本就是中文）。
7. **输入框占位**：「给 Pi 发消息…」→「输入消息…」（英文键 `Message Pi…` → `Send a message…`）。
8. **新对话标题**：存的仍是标识符 `New chat`（不迁移、不改持久数据），显示时换成「新建对话」，与顶部「新建」按钮同一个词条。用到的地方：侧栏行（标题、悬停、改名编辑框初值、归档与结束对话的确认框）、会话栏标题、容量回收的 toast。改名时若用户没改显示的字，照旧算「没改」。
9. **开屏演示名 `Live Agent Host`（决策 138 第 21 条）**：开屏种子、DEMO 种子、重命名 `session-live` 的那一步都改用 `New chat`，显示「新建对话」。
   - 认种子改为按 id 前缀 `session-live`：`useSyncChatWorkspaceTree` 的「已有开屏对话」判断（原来还认标题），`ChatWorkspace` 的兜底选中改用 `isStartupSeedSession`（`session-live*` 且仍是 `New chat`）。不能再按标题认，因为用户点「新建」建的对话也叫 `New chat`。
   - 旧的 `Live Agent Host` 行仍算占位标题（首条消息会给它起名），显示也是「新建对话」，开屏判断仍认它。
10. **重试条末尾**：DSH 的失败类别原样显示（「8s 后重试 · SERVER 500」）。改成：`SERVER` → 「服务端错误」，`TRANSPORT` → 「连接失败」，`TIMEOUT` → 「已超时」，`RATE_LIMIT` → 「请求过于频繁」，`EMPTY_RESPONSE` → 「空回复」，bridge 补的 `unknown` → 「未知错误」（英文 `server error` / `connection error` / `timed out` / `rate limited` / `empty response` / `unknown`）。这五类是 dsh-llm 默认可重试的全部类别；认不出的类别原样显示。上下文面板的诊断行照旧显示原始类别。
11. **审阅面板说明**：「记录当前对话中 Edit 和 Write 的修改；不包含命令行及外部编辑。」→「记录当前对话中文件工具（edit、write）所做的修改；不包含命令行及外部编辑。」DSH 的工具名是小写的 `edit`、`write`，按标识符保留原文并标明是工具；原来的大写是 pi / Claude 的名字（英文同步改为 `Changes made by the file tools (edit, write) in this conversation. Shell commands and external edits are not tracked.`）。
12. **会话分支对话框**：
    - 行尾标签 `user` / `assistant` / `system` → 「用户」「助手」「系统」；
    - 没有预览文字的消息节点（只有工具调用的回复）`assistant message` → 「助手消息」（`user message` / `system message` 同理）；
    - 其他节点类型 `compaction` / `notice` → 「上下文摘要」「通知」；认不出的类型把下划线换成空格原样显示；
    - 摘要节点的预览以英文标题开头，标题换成「上下文摘要」。
13. **设置导航「Pi」→「模型」**：这一页现在放的是 AI 服务、模型管理、提示缓存、模型请求超时，名字按内容取；分类 id `pi` 不变。跟着改的引用：
    - 页内小节「Pi 模型管理」→「模型管理」；
    - 「当前是 “Use my own setup”，Pi 会直接读取你自己的 ~/.pi/agent 配置。」→「当前是「使用本机已有配置」：可用的模型来自上方你自己添加的 AI 服务。」（P1-5 起本机路线不再读 `~/.pi/agent`）；
    - 模型缺失卡「到「设置 · Pi」把 AI 服务迁移或补上，…」→「到「设置 · 数据迁移」把 AI 服务迁移过来，或到「设置 · 模型」补上，…」（迁移早已拆到「数据迁移」页）；按钮「去 Pi 设置补上模型」→「打开模型设置」；
    - 图片输入提示里的「设置 · Pi · AI 服务」→「设置 · 模型 · AI 服务」；
    - 权限策略说明「Pi 后端每次调用工具前都会先过这道闸。…」→「每次调用工具前都会先过这道闸。…」（DSH 的闸门仍读这份策略）。
14. **引擎状态横幅**：「Pi session service 正在启动… / 已停止 / 出错」「点击「重试」初始化（重新初始化）Pi session service」→「对话引擎正在启动… / 已停止 / 出错」「点击「重试」启动（重新启动）对话引擎」。与已有的「对话引擎已重启」「对话引擎意外退出」同一说法。
15. **登录成功页**：「Pi 模型与凭据已在本次会话中生效。」→「模型与凭据已在本次会话中生效。」
16. **摘要行标题（决策 140 第 16 条）**：投影仍写英文 `Context summary`（它是转录数据，金样本不动），渲染时只把开头这一行换成「上下文摘要」，下面的摘要正文原样。压缩成功的 toast「…显示为「Context summary」。」同步为「…显示为「上下文摘要」。」
17. **时间线空态与同处的几句**：「No messages yet. Send a prompt to stream from the Agent Host.」→「还没有消息，发一条消息开始对话。」（英文 `No messages yet. Send a message to start.`）；「Select a session to start chatting.」→「选择一个对话开始。」（英文 `Select a chat to start.`）；`Load earlier messages` → 「加载更早的消息」；失败卡旁的 `Stop` → 「停止」。
18. 同一块代码里顺手发现、但不在点验清单里的英文，只改了与上面同一界面、同一类的（第 6、17 条里列出的几处）。其余见「拿不准、没改的」。

### 问题 35：「打开 agent 目录」的小写

19. **来源**：不是词条，是按钮原语 `ui/button.tsx` 的基类带 `lowercase`（设计规范「按钮文案强制小写」），把「打开 Agent 目录」里的 `Agent` 压成了小写。
20. **改法**：按设计规范给中英混排文案的豁免，两处按钮（旧资产提示弹窗、设置 · 扩展里的旧资产区）加 `normal-case`，显示与词条一致的「打开 Agent 目录」。英文界面下这个按钮因此显示 `Open agent folder`，不再是全小写，与其他英文按钮略有不同，这是豁免本身的代价。

### F3：迁移失败卡的 `retry`

21. 历史卡片（含迁移失败卡）的按钮原来是硬编码英文 `Retry`，再被同一个 `lowercase` 压成 `retry`。改为词条「重试」，与卡上「点「重试」…」的说明一致。

### 问题 8：问答卡

22. **Stop 与 Skip 分开**：bridge 在发起方中止（Stop、回合取消）和会话关闭撤卡时，`question.resolved` 仍是 `outcome: 'cancelled'`，另加 `stopped: true`；用户点 Skip 不带这个字段。渲染层记为 `questionStopped`，冻结卡显示「提问已停止」，每一题下写「已停止」（英文 `Questions stopped` / `Stopped`）；Skip 仍是「已跳过提问 / 已跳过」。「已停止」与 Stop 打断的工具行结尾同一个词条。
    - 字段可选：不带它的发送方（1.0.x 的运行时）照旧显示「已跳过」；`answered` 上即使带了也不理会。
    - 模型收到的内容不变：Stop 时 DSH 仍得到 `ASK_ABORTED`，Skip 时仍是每题 `selected: []`。
23. **多选答案逐行显示**：冻结卡把多选答案拆回所选的每一项，一项一行（项目符号列表），标签里带「, 」也保持完整；「其他」里填的字单独一行，写成「其他：…」。
    - 拆分用的是 bridge 给模型拆 `ask_user_question` 答复时用的同一个函数（新的 `@shared/questionAnswer`，bridge 的 `answerItemFor` 改为调用它，行为不变），所以卡上列出的就是模型收到的 `selected` 与 `custom`。决策 114 第 5 条的边角（「其他」文字以「某个标签, 」开头）在卡上也按同样方式拆，两边不会不一致。
    - 单选、整段自由文字、被遮掩的机密答案仍是一行。
24. **发给模型的格式不改**：模型收到的本来就是结构化的 `{id, selected: [...], custom?}`，没有歧义；有歧义的只是渲染层与 bridge 之间用「, 」拼成一个字符串的 `answers`（1.0.x 协议）。这一层也不改：改它要同时改 1.0.x 协议字段与 bridge 解析，收益只是去掉第 23 条已经在显示上处理掉的问题。
25. **不在本组**：重开会话后问答卡与答案不在时间线上（与决策 113 第 19 条同类），见遗留。

## 拿不准、没改的

- 回退标题 `Session xxxxxx`（点验里的「Session srd2ne」）：英文，由 `fallbackSessionTitle` 生成并参与占位判断，要改成中文需要同 8、9 条一样做显示层映射，清单没列。
- 侧栏行悬停时的归档按钮 `aria-label="Archive session"`、`title="Archive"`：仍是英文。`sessionContextMenuWiring.test.ts` 以这个字面量为锚点，按规则没动测试，也就没改。
- 「数据迁移」页的「把你自己的 Pi 配置搬过来」「你自己的 Pi 目录」、模型缺失卡正文里的「你自己的 Pi 目录」、历史读取错误里的「Pi 会话文件…」「Pi 会话记录…」：说的是 1.0.x 真实存在的 Pi 目录与会话文件，判断为仍然成立，没改。
- 权限策略的「按帐号隔离的 pi 目录」「仓库自带的 .pi 配置」：策略文件确实还在 `.pi/extensions/pi-permission-system/` 下，是目录名，没改。
- `Root.tsx` 的「无法检测 Pi 运行时」「没有找到随包的 Pi worker 运行时。」：不确定 DSH 下这个启动失败页是否还可达，没改。
- 会话管理页「…并在 Pi 中继续」（导入 Claude Code / Codex 历史）：不确定该页在 DSH 下的去留，没改。
- 模型目录状态行的英文键仍含 `Agent Host`、`Automatic will be used`，只补了中文。
- 开发期 DEMO 的 `Welcome` 会话正文仍提到「Live Agent Host」；它在第一次工作区同步时就被丢掉，界面上看不到。
- 「新建对话」同时用作按钮文字与新对话的标题。若希望标题读作「新对话」，需要另起一个词条。

## 测试

- 新增：`chat/__tests__/e4CatalogKeys.test.ts`（15 条：各张表都有中文，显示辅助函数的「标识符进、文字出」与原样透传）；`shared/__tests__/questionAnswer.test.ts`（5 条）。
- 追加：`questionCardModel.test.ts` 6 条（`stopped` 状态、冻结对、多选拆分含带逗号的标签与「其他」、与 `buildRespondPayload` 往返、单选 / 自由文字 / 遮掩不拆、中英文案）；`chineseChatSurface.test.ts` 1 条（挂载：已停止的卡、逐行的多选答案）；`chatSessionsQuestion.test.ts` 2 条（`stopped` 记为 `questionStopped`，`answered` 上忽略）；`treeSyncPatch.test.ts` 1 条（DEMO 种子改名）。
- 改写（行为变了，断言跟着改）：`treeSyncPatch.test.ts`（开屏种子标题）、`middleColumnLayout.test.ts`（占位 3 处）、`chineseChatSurface.test.ts`（模型缺失卡两句）、`attachmentLimits.test.ts`（设置路径）、`permissionPolicyCollapse.test.ts`（策略说明）、`retryBanner.test.ts`（中文里的 `unknown` → 「未知错误」）、`turnEndReplayMount.test.ts`（摘要标题）；bridge 的 `questions.test.ts`、`dshSessionRuntime.test.ts` 把撤卡的断言加严到带 `stopped`。
- 没有改任何源码扫描类测试（`*Static*` / `*Wiring*`）。

## 对既有决策的修订注记

- 决策 114 第 8 条：撤卡的 `question.resolved` 另带 `stopped: true`。
- 决策 138 第 21 条的遗留（演示名）与决策 140 第 16 条（摘要标题）由本决策落地。

## 用户审批

待审批。
