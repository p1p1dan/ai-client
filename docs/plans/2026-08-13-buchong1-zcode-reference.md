# 2026-08-13 buchong1 参考批分析 — ZCode 聊天细节九图对照

> **来源**：用户 2026-08-13 补充的 ZCode（竞品）细节截图，原件 `D:\Dan\vmshare\buchong1\`，已入库
> [`docs/design/refs/zcode-20260813-buchong1/`](../design/refs/zcode-20260813-buchong1/)（9 张语义重命名）。
> **性质**：参考调研档（非规格、非承诺）。逐项「参照细节 ↔ 仓内现状」对照；仓内证据由 4 路并行 survey
> （sonnet×4，2026-08-13，基于 `feat/openchamber-chat-refactor` 工作树）取得，file:line 为 survey 实读非推测。
> **【拍板注记 2026-08-13 当日 = D31】**四路全部立项；冲突项裁定：气泡**改回右对齐**（推翻 D26④）/
> 工具行**维持 D24** / 模型-effort **拆回双下拉**（推翻 T-30b2①）/ 侧栏**双区 + Recent 封顶折叠**。
> §4「待拍板」与 §5「默认不采纳」的表述以本注记与总台账 D31 行为准。
> **采纳范围原挂**：open-q **#32**（已裁定关闭）。与既有拍板冲突项单列 §5（默认不采纳）；不冲突项按量级分档 §4。
> **用户原话强信号**：右侧 Progress 面板「这个我很喜欢」（图⑨）；右键菜单「不一定全都有用」（图⑥，取子集即可）。

## §1 九图清单（对应用户八点）

| 图 | 文件 | 内容 | 用户点位 |
|---|---|---|---|
| ① | `01-权限模式下拉-输入框内.png` | Composer 内权限模式下拉：Ask before changes / Edit automatically / Plan mode / Full access，每项图标+一行副标题；当前模式为 composer 底行 chip（Full access 橙色） | 1 |
| ② | `02-授权卡-三选项带快捷键.png` | Permission required 卡：Awaiting approval 状态行 + 文件 chip + 路径 + `+10` 绿色 diff stat；编号选项 1.Allow(仅本次)/2.Always allow in this project/3.Deny；底部「Tab/方向键选择 Enter 确认」提示 + Confirm 钮 | 2 |
| ③ | `03-等待态-Working计时+Thinking.png` | 等待态：用户气泡右对齐；`Working for 13s` 实时计时分隔头；`Thinking...` 行 + 独立 spinner | 3 |
| ④ | `04-问答卡-思考展开+选项+自由输入.png` | `Thought for 17 seconds ˅` 暗淡内滚动预览；问答卡：tag chip（「卡片样式」）+ 编号选项（**粗标签**+常规描述双层）+ `1/1` 分页 + 末行常驻自由输入 + Dismiss/Submit | 2、4 |
| ⑤ | `05-回复完成态-Worked折叠+Asked摘要+正文.png` | `Worked for 45s ˅` 回合折叠；`Asked 1 questions ˅` 答后摘要行（引用问题 + No answer provided）；正文列表排版 | 3、4 |
| ⑥ | `06-侧栏右键菜单-会话条目.png` | 会话条目右键菜单 12 项：Pin/Rename/Archive/Mark as unread/Open in split view/Open in File Manager/Copy path/Copy task path/Copy log path/Copy session ID/Go to config/View model trajectory/Report issue；侧栏顶部 New task(Ctrl+N)/Search(Ctrl+K)/Automations/Skills | 5 |
| ⑦ | `07-正文bash代码卡-标题+复制钮.png` | Markdown 正文（Step 标题+散文）+ bash 代码卡：头部行=语言标签+图标（左）/ wrap 切换+复制钮（右），语法高亮，横向滚动 | 4、6 |
| ⑧ | `08-侧栏Group视图-相对时间.png` | `# Group / 🗀 Project` 互斥切换 chips；Group=扁平最近列表+相对时间徽章（1m/4m/24m）+运行中 spinner 徽章 | 7 |
| ⑨ | `09-全窗-右侧Progress面板+Terminals.png` | 右侧 **Progress 6/7** 区：完成项绿勾+删除线（折叠为「4 completed」）、当前项箭头标记；下方 `Terminals 1m 43s · 1 background` 摘要行；回合顶部 `2 files changed +407 -0 · Undo` 汇总条 | 8 |

## §2 逐项对照总表

状态：✅ 有 ｜ 🟡 半有 ｜ ❌ 无 ｜ ⚖️ 与既有拍板冲突（详 §5）

### Composer（图①）

| 参照细节 | 状态 | 仓内证据（survey 实读） |
|---|---|---|
| per-session 权限模式下拉 | ❌ | Composer 底行无任何权限元素（`ChatComposer.tsx:2437-2461`）；Host 两侧硬编码——`claudeRuntime.ts:182-193` `CHAT_PERMISSION_MODE='default'` 常量、`codexRuntime.ts:103-113` `CODEX_PERMISSION_DEFAULT`；IPC `createSession` payload 无 permissionMode 字段（`preload/index.ts:1366-1375`）；唯一消费点=Context 面板只读一行（`contextSurfaceModel.ts:165-177`）。**但协议类型已定义全套模式**：`runtimeEvents.ts:496-546` `SessionPermissionMode`（default/acceptEdits/dontAsk/bypassPermissions/plan）——SDK 支持，纯接线缺口 |
| 底行：⊕ 附件 / 模型下拉 / 思考等级 / 圆形发送钮 | 🟡⚖️ | 四类俱备（`ChatComposer.tsx:2437-2443`）；但模型+effort 是**一个合并控件**（`ComposerModelTrigger.tsx`，T-30b2 拍板①），非参照的两个并列下拉；`Max` 档已有（`efforts.ts:24-29`）；圆钮四态已有（send/stop/retry/enqueue） |
| 空态 placeholder 提示命令/能力 | ❌ | 固定 `'Message Claude via Agent Host…'`（`middleColumnLayout.ts:798`）；无斜杠命令菜单（ideas inbox 已有 slash-command 想法条，用户曾明示优先级不高） |

### 授权卡 / 问答卡（图②④⑤）

| 参照细节 | 状态 | 仓内证据 |
|---|---|---|
| 「Permission required」标题 + 常驻 Awaiting approval 状态行 | 🟡 | 标题为 `'Permission'`（`questionCardModel.ts:302`）；`'Waiting'` 仅排队卡显示，可答卡无状态行（`QuestionCard.tsx:531-539`） |
| 文件 chip + 路径 + diff stat 绿色 | 🟡 | 三件俱备且逐 hunk 计数（`QuestionCard.tsx:459-477`、`questionCardModel.ts:479-500`）；但 stat 单一 muted 色，无 +绿/−红 分色 |
| 编号选项 Allow/Always allow in project/Deny | 🟡 | 现有 Allow / Allow for session / Deny / Deny and stop（`questionCardModel.ts:302-341`），字母 A/B/C 非数字编号；语义近似但作用域是 **runtime session** 非 project |
| 「Always allow in this project」项目级持久化 | ❌ | 全仓无落盘的 per-project 允许策略；最近似 `allow_session` 随会话蒸发（S3 切片4 方言表 `2026-08-10-s3-slice4-permission-projection-spec.md:67`） |
| 键盘导航（Tab/方向键+Enter 确认两步制）+ footer 提示 + Confirm 钮 | ❌ | PermissionQaCard 无 onKeyDown、`selected={false}` 硬编码（`QuestionCard.tsx:541-573`）；点击即发一步制；全仓无「Use Tab / arrow keys」类提示文案 |
| 问答卡 tag chip | ❌🎁 | **协议已带**：`runtimeEvents.ts:403-407` `QuestionItem.header?`（SDK 合同 ~12 字符 chip），渲染端零消费 |
| 选项=粗标签+描述双层 | 🟡🎁 | **协议已带**：`QuestionOption.description?/preview?`（`runtimeEvents.ts:388-393`），`buildOptionRows()` 只取 label 丢弃其余（`questionCardModel.ts:129-137`），单行等权重渲染 |
| 多问题分页 ‹ 1/1 › | ✅ | `derivePager()`（`questionCardModel.ts:220-232`）+ QaHead 箭头（`QuestionCard.tsx:113-135`），文案 `X of Y` |
| 末行常驻自由输入 | 🟡 | 藏在 `Other…` 选项行内、选中才展开（`QuestionCard.tsx:231-244`），非常驻末行 |
| footer 键盘提示 + Dismiss/Submit | 🟡 | Skip/Continue（⏎ 内嵌）已有（`QuestionCard.tsx:413-431`）；无提示句、无 roving focus |
| 答后折叠「Asked N questions ˅」+ No answer provided | ❌ | FrozenQaCard 恒全展开无折叠钮（`QuestionCard.tsx:269-280`）；文案体系为 Answers/Skipped。权限卡侧反而已收敛为单行 ToolRow（d759023，`QuestionCard.tsx:525-529`），但为静态行不可展开回看原文 |

### 回复解剖（图③⑤⑦⑨）

| 参照细节 | 状态 | 仓内证据 |
|---|---|---|
| 用户气泡右对齐 | ⚖️ | D26④ 已拍板满宽（`MessageTimeline.tsx:671-680`），对齐参照=推翻既有裁定 |
| Working for Ns 实时计时头 | 🟡 | `Generating · Ns` 六态 + 1s tick 已有（`turnStatus.ts:82-107`、`MessageTimeline.tsx:126`）；形态为 meta 文本行非分隔线；Thinking 行无独立 spinner（spinner 挂回合头，`MessageTimeline.tsx:1265-1275`） |
| Thought for Ns 折叠 + 暗淡内滚动预览 | 🟡 | 折叠+时长+暗淡色俱备（`toolCard.ts:503-524`、`turnTiming.ts:110-130`、`--tool-arg` 低对比）；**唯独 thinking body 不挂 `outputMaxHeightClass` 内滚动**（`ToolRows.tsx:301-307`，对比 output 分支 :283-291），长思考会无限撑高 |
| 工具行 图标+`·`分隔+Completed 后缀 | ⚖️ | 现行「动词时态区分完成态、无图标」系 D24 明文拍板（reply-anatomy §10-E）；聚合行 `Explored · N files` 能力已有（`toolCard.ts:346-410`，逗号分隔） |
| Worked for Ns ˅ 回合折叠 | ✅ | T-31 已落地：`turnTiming.ts:132-172` + 回合级 Collapsible（`MessageTimeline.tsx:1085-1121`），答案段恒可见 |
| 正文 Markdown 全解析 | ✅ | T-29 `d320206` 已落地 react-markdown+gfm 全套（`ChatMarkdown.tsx`）。**ideas inbox 2026-07-30「无 md 解析」条目已过期，本批已勘误** |
| 代码卡头部行（语言标签+wrap 开关+复制钮） | ❌ | `ChatCodeBlock.tsx:32-77` 为裸 `<pre><code>`+shiki 高亮+横滚+圆角卡，**无任何 header 容器**——无语言标签、无复制钮、无 wrap 切换 |
| 回合级 `N files changed +X -Y · Undo` 汇总条 | ❌ | 全仓无此组件与 Undo 通道；相邻基建：单文件 `countDiffStat`（权限卡内）、会话级累计行数（`StatusLine.tsx:224-237`）——均未在回合顶聚合 |

### 侧栏 / 右栏（图⑥⑧⑨）

| 参照细节 | 状态 | 仓内证据 |
|---|---|---|
| New task Ctrl+N / Search Ctrl+K / Automations / Skills | 🟡 | New 钮无快捷键；Search 为就地过滤框非命令面板（`LeftNav.tsx:320-357`）；shellShortcuts 无 KeyN/KeyK（`shellShortcuts.ts:88-109`）；Automations/Skills 概念全仓不存在 |
| Group/Project 互斥切换 chips | 🟡 | 两种形态**并存**非切换：Recent 扁平区（`LeftNav.tsx:390-446`）+ Repositories 树区（:448-616）；相对时间格式恰好一致（`relativeTime.ts:34-51` → `1m/4m`）；忙碌=圆点非 spinner（:771-773） |
| 会话右键菜单 12 项 | ❌⚠️ | **现状右键=立即归档**，无菜单无确认（`LeftNav.tsx:756-760` `onContextMenu→onArchive()`）——与 open-q #6（归档不可逆、无 un-archive）叠加成误触风险面。等价能力仅 Rename（双击 :748-755）与 Archive（hover 钮 :838-864）两项；真右键菜单先例=仓库级 `repositoryContextMenuModel.ts`（5 项，可复用模式）；split view 已登记后置（`surfaceRegistry.ts:112-120` 多标签 pendingTask） |
| 右栏 Progress 区（进度计数/绿勾删除线/当前项箭头） | ❌⭐ | `'plan'` surface 系 registry 占位 `registeredOnly`（`surfaceRegistry.ts:139-147`）；T12-15 规格明文「不做 Plans（**无数据源**，做即假状态）」（§4，D27 复核维持）；A08 原基线其实画过 notes/todo/plans（`a08-final-context-panel-baseline.html:985`）后被裁掉。**关键：「无数据源」前提对 Claude 侧已过期，见 §3.1** |
| Terminals 摘要行（elapsed + N background） | ❌ | 现状为独立全功能 Terminal surface（`TerminalSurfaceView.tsx`），无摘要行形态 |

## §3 三个关键发现

### 3.1 Progress 面板：「无数据源」前提已过期（Claude 侧）⭐

- T12-15 裁定「不做 Plans」的理由是**无数据源**。survey 实证：Claude 侧 **TodoWrite 的结构化
  `todos: [{content,status,activeForm}]` 数组今天就随 `tool_use.input` 原样进入 renderer store**
  （`toolCard.ts:27-39` `ToolRun.input: unknown` 透传；`ARG_COVERED_FIELDS` 无 TodoWrite 条目
  → 整份 JSON 塞进折叠 input body；:704-707 工具行仅渲染固定摘要 `'next moves'`）。
  即：**数据在、没接线**，不是「做即假状态」。
- Codex 侧：`codexItemMapper.ts` 无 plan/update_plan 分支；spike 里的 `plan` 全部指 turn 级
  collaborationMode 开关，非逐步骤清单——若立项，Codex 侧需显式降级（可仿 S3 切片5 档 A
  `history_unsupported` 思路）。
- 主进程另有一套 `ClaudeHookManager`/`ClaudeIdeBridge`（旧壳 worktree 指示灯用），不进
  agent-host stream 管线，与本数据源无关，勿混。
- ⚠️ **实现方否决权**：本结论基于 renderer 侧类型与 toolCard 处理链推断「input 未被裁剪」；
  施工前须以真实会话实测一发 TodoWrite，确认 Host 序列化后 todos 字段完整到达（若被
  Host/协议层裁剪则结论不成立，改走协议加法）。

### 3.2 两个零协议改动的白捡项 🎁

协议早已承载、渲染端弃用：① `QuestionItem.header` tag chip（图④「卡片样式」位）；
② `QuestionOption.description`（粗标签+描述双层排版）。两处均纯渲染端改动即可点亮。

### 3.3 右键即归档：现状是误触面 ⚠️

`LeftNav.tsx:756-760` 右键会话条目=立即归档（无菜单、无确认），叠加 open-q #6（归档后彻底不可见、
无恢复入口）= 一次误右键即「丢失」会话。参照图的右键菜单（图⑥）正是该问题的顺路解法：
右键改弹菜单后，Archive 退居菜单项（可加确认），误触面自然消失。

## §4 候选采纳清单（不冲突既有拍板，按量级分档）

**S 档（各 ≤0.5d，纯渲染端，可合为一个小施工批）**

1. 代码卡头部行：语言标签 + 复制钮（+可选 wrap 开关）——`ChatCodeBlock.tsx` 现为裸 pre
2. 问答卡 header tag chip（协议已带，§3.2①）
3. 选项 label+description 双层排版（协议已带，§3.2②）
4. thinking 展开体补 `outputMaxHeightClass` 内滚动（唯一不挂内滚的 body 分支）
5. 权限卡 diff stat `+` 绿色分色（`text-status-*` token 体系已有）
6. 侧栏忙碌徽章 圆点→spinner（纯观感，可并可弃）

**M 档（各 1~2d，渲染端为主）**

7. 权限卡/问答卡全键盘导航：方向键/Tab roving + footer 提示行 +（权限卡）选中-确认两步制
8. 问答卡答后折叠摘要行（`Asked N questions ˅` 形态；FrozenQaCard 现恒展开）
9. **会话右键菜单**（连带收口 #6 误触面，§3.3）：复用 `repositoryContextMenuModel` 模式；
   首批建议子集（用户明示不必全要）：Rename / Archive（带确认）/ Copy session ID /
   Open in File Manager / Un-archive 入口顺路解 #6
10. Ctrl+N 新建 / Ctrl+K 聚焦搜索（shellShortcuts 加两键）

**L 档（跨 Host+IPC+渲染，各自独立立项）**

11. **per-session 权限模式选择器**（图①）：协议类型全套已定义（`SessionPermissionMode`）、
    SDK 支持，缺口纯接线：IPC `createSession` 加字段 + 两侧 runtime 解硬编码 + composer 下拉
    + Context 面板行变可写。无协议发明，但触 Host 红线需按工程规范 flag+Happy Path
12. **Progress 面板**（图⑨⭐用户明示喜欢）：数据源见 §3.1；**采纳即推翻 T12-15「不做 Plans」
    裁定（D27 复核维持过），须用户明示** → open-q #32 主拍板项
13. 回合级 `N files changed · Undo` 汇总条：统计侧可聚合权限卡 diff 数据，**Undo 通道全仓无
    先例**（快照/反向 patch 均属新机制）——本批最重，建议仅立想法不排期
14. 「Always allow in this project」项目级持久化：涉落盘策略层+安全面（与 FILE_COPY 加固同类），
    需单独安全设计，不宜随 UI 批顺手

## §5 与既有拍板冲突项（默认不采纳，除非用户明示推翻）

| 参照点 | 冲突对象 | 说明 |
|---|---|---|
| 用户气泡右对齐 | **D26④**（满宽拍板，2026-07-30） | 推翻属纯观感回摆，无功能理由 |
| 工具行图标 / `·` 分隔 / Completed 后缀 | **D24**（图标/圆点/边框整块作废） | 现行动词时态法系有意设计 |
| 模型与思考等级两个独立下拉 | **T-30b2 拍板①**（合并控件） | 合并系用户自己裁的 |
| Group/Project 互斥切换 chips | 现状 Recent+Repositories 双区并存（非拍板但既定形态） | 改互斥属信息架构变更，收益存疑：双区并存已同时提供两种视图 |

## §6 过期记录勘误（本批已顺手落）

- ideas inbox「assistant 正文 Markdown 解析」（2026-07-30）：已被 T-29 `d320206`（2026-08-04）
  落地超越，条目已标过期；残余缺口收窄为「代码卡头部行」= 本档 §4-1。

## §7 Survey 元信息

- 4 路并行（composer / cards / reply / shell），sonnet，共 412k tokens / 175 tool calls；
  结构化输出（have/partial/missing + file:line evidence + gap + planRefs）。
- 侧栏对照以**新壳** `workspace-shell/LeftNav.tsx` 为准（旧壳 RepositorySidebar 系回退非产品）。
- survey 亦确认：本批 8 点此前**均无**专项规格/想法记录（Progress 面板、右键菜单、权限模式
  选择器、Group/Project chips 全为首次系统对照）。
