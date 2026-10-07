# 决策 156：合入 main 前的界面小修（决策 145 的「发现」、决策 146 第 13、22 条、决策 149 第 10～12 条）的实现取舍

日期：2026-10-07。**状态：自主决定，待用户审批。**

依据：

- [决策 149](149-user-rulings-2026-10-07.md) 第 3 条（界面小修合入前一批修完）、第 10 条（问题 44 后半：容量回收时失败对话只解绑）、第 11 条（`Session xxxxxx` 显示层改中文）、第 12 条（侧栏 `Archive` 走词条）；
- [决策 145](145-p1-7e-e6-choices.md)「发现（本组没有改）」七条，以及第 5 条（失败只解绑）、第 17 条（遗留：再发一轮后失败回合重新显示「完成于」）、第 18 条（旧资产提示的初始焦点）、第 20 条（原语标签走词条）；
- [决策 144](144-p1-7e-e4-choices.md) 第 8、9 条（占位标题的显示层映射）与「拿不准、没改的」里的 `Session xxxxxx`、`Archive`；
- [决策 146](146-real-gateway-followups.md) 第 13 条（评审标题显示原始模型 id）、第 22 条（失败回合直播空消息与回放注记并存；请求未发出就被停的回合）；
- [P1-7e 复点验证据](../evidence/p1-7e-recheck-2026-09-30.md) 问题 40、42、44；
- 设计规范 `docs/design-system.md`：Typography 表「2xs 10px 禁止承载 CJK」、CJK 级联规则第 3 条。

代码提交 `5d495e01`（文案与原语，第 1～4、9、10 项）、`c568b989`（焦点，第 5、7 项）、`e81ea90c`（会话状态，第 6、8 项）、`d01e8db4`（时间线与标题，第 11～13 项）。没有起 Electron、没有做 GUI 点验（本机硬规则），界面行为只由挂载测试与源码扫描验证。没有动 bridge、没有动历史投影（`shared/dshHistory/projection.ts`）、没有动金样本。**第 5、6、12、15、17 条请重点审批。**

## 落地了什么

- Main：`services/agent-host/WorkerManager.ts`（停在 `error` 的会话宣告 `released`；容量回收不再对已宣告的 `error` 条目再说 `capacity_reclaimed`）。
- 共享：`shared/i18n.ts`（改 6 条旧词条、删 1 条不再使用的「显示更多」，文末新增一块 3 条中英）。
- 渲染层：
  - `chat/`：`middleColumnLayout.ts`、`attachments.ts`、`piModelCatalog.ts`、`ChatComposer.tsx`（文案）；`sessionIndex/sessionTitle.ts`（回退标题显示层）；`turnEndNoticeModel.ts`、`MessageTimeline.tsx`（失败请求不写「完成于」）；
  - `stores/chatSessions.ts`（容量回收保留失败；失败请求打标；回放时给失败注记补上直播 id）；
  - `workspace-shell/`：`LeftNav.tsx`（改名 Esc 后焦点回行；归档按钮走词条）、`surfaces/ContextSurfaceView.tsx`、`surfaces/RunSurfaceView.tsx`（「查看更多（N）」、10 px 中文）；
  - `source-control/CodeReviewModal.tsx`（评审标题用模型显示名）；
  - `ui/`：`dialog.tsx`（默认初始焦点）、`spinner.tsx`、`breadcrumb.tsx`（读屏标签走词条）。

## 规则

### 1. 残留的「Agent Host」文案（决策 145 发现第 1 条）

1. `rg -a "Agent Host" src/` 穷举后，用户看得见的出现全部改掉，中文用界面上已有的「对话引擎」，英文用 `chat engine`，与「对话引擎正在启动…」「对话引擎已重启」等同一说法：

   | 位置 | 改前（中文 / 英文） | 改后（中文 / 英文） |
   |---|---|---|
   | 发送中的输入框占位 | 正在发送到 Agent Host… / `Sending to Agent Host…` | 正在发送… / `Sending…`（复用已有词条） |
   | 首条消息建会话时的占位 | 正在与 Agent Host 建立会话（仅首条消息）… | 正在建立对话（仅首条消息）… / `Setting up the chat (first message only)…` |
   | 带附件发送时的占位 | 正在向 Agent Host 发送 N 个附件… | 正在发送 N 个附件… / `Sending N attachment(s)…` |
   | 回合头（握手阶段） | 正在启动 Agent Host… · N s | 正在连接对话引擎… · N s / `Connecting to the chat engine… · Ns` |
   | 模型菜单底部的目录状态（英文界面） | `Waiting for Agent Host to become ready` | `Waiting for the chat engine to become ready`（中文本来就是「正在等待对话引擎就绪」） |
   | 输入框状态行的两个兜底分支（原为硬编码英文，不走词条） | `Starting Agent Host / sending…`、`Agent Host running — use Stop to abort` | `t('Sending…')`、`t(TURN_RUNNING_PLACEHOLDER)`（即问题 40 已改的「回合进行中 —— …」） |
   | 词条 `The Agent Host is not ready.` | Agent Host 尚未就绪。 | 对话引擎尚未就绪。 / `The chat engine is not ready.` |

2. 握手阶段（`ensureHost → close → createSession → 等 session.created`）在共享宿主下多数时候并不「启动」任何东西，所以说「连接」不说「启动」。
3. 「权限档提示『Agent Host 尚未就绪。』」核对后**没有调用方**：它所在的「权限芯片」一组词条（`This chat has nowhere to run right now.` 等）在本分支已无任何 `t('…')` 引用。仍按清单改了措辞，没有借机清理整组孤儿词条。
4. 剩下两处不改：`LEGACY_SEED_TITLE = 'Live Agent Host'` 是存储标识符（显示为「新建对话」，决策 144 第 9 条）；开发期 DEMO 的 `Welcome` 会话正文在第一次工作区同步时就被丢掉，界面上看不到（决策 144 已记）。
5. 守卫：`middleColumnLayout.test.ts` 新增一组，断言发送中的三种占位中英文都不含 `Agent Host`，且整张中文词表的键与值都不含 `Agent Host`。

### 2. 上下文面板「显示更多 (N)」

6. 改为侧栏同一写法 `t('View more ({{count}})')`：中文「查看更多（N）」，全角括号；按钮加 `tabular-nums`（决策 145 第 13 条）。「显示更多」词条已无调用方，删除。

### 3. 10 px 中文

7. 同决策 145 第 15 条的做法，`text-2xs` → `text-meta`（14 px）：
   - `ContextSurfaceView.tsx`：环中的「字符」、「按发送者」、角色图例、底部说明。环是 80 px，内圈约 51 px，「字符」两个字 28 px，放得下。
   - `RunSurfaceView.tsx`：当前工具状态行（内容是工具自己发布的状态，可能是中文）、会话累计说明。
   - 保留 10 px 的只有 Run 面板环下的 token 总数（`12.3k` 这类拉丁数字）。运行时长徽标（`12s`）本来就是拉丁，没动。
8. 守卫：`e6CopyAndPrimitivesStatic.test.ts` 的「没有 10 px 翻译文字」扩到这两个文件；另加一条更严的：上下文面板不再有 `text-2xs`，Run 面板唯一的 `text-2xs` 是环下的 `formatTokenTotal(...)`。原因是角色图例（先有色块）和工具状态（不是 `{t(`）两处，原来的形状扫描看不见。

### 4. 读屏念英文的原语

9. 先核对可达性（按 `import` 扫全部 `src/renderer`）：

   | 原语 | 英文 | 产品里可达？ | 处理 |
   |---|---|---|---|
   | `ui/spinner.tsx` | 默认 `aria-label="Loading"` | 可达：输入框读附件、时间线加载更早消息、登录按钮、工作组头等 9 处；只有侧栏行传了自己的标签 | 改走词条「加载中」（`Loading`），调用方传的标签仍优先 |
   | `ui/breadcrumb.tsx` | `<nav aria-label="breadcrumb">` | 可达：编辑器顶部路径栏（清单没列，同类） | 改走词条「路径导航」（`Breadcrumb`） |
   | `ui/breadcrumb.tsx` | `BreadcrumbEllipsis` 的 `More` | 不可达：编辑器只用 `Breadcrumb / List / Item / Separator` | 不改 |
   | `ui/pagination.tsx` | `pagination`、`Go to previous/next page`、`More pages` | 不可达：没有任何引用 | 不改 |
   | `ui/combobox.tsx` | `ComboboxChipRemove` 的 `Remove` | 不可达：三处 Combobox 用的都是单选输入，没有用 `ComboboxChip(s)` | 不改 |
   | `ui/sidebar.tsx` | `Toggle Sidebar` | 不可达：没有任何引用 | 不改 |

10. `spinner.tsx`、`breadcrumb.tsx` 因此开始引用 `@/i18n`（同决策 145 第 20 条的代价）。两处的上层组件本来就在用 `useI18n`，全量渲染层测试没有因此挂起。守卫：`e6CopyAndPrimitivesStatic.test.ts` 的原语一组加上这两个文件。
11. 顺带看到、没改：`AddRepositoryDialog` 里 Autocomplete 的清除按钮（`showClear`）没有任何可读名称，读屏只念「按钮」。不是英文问题，不在本组。

### 5. 对话框打开时滚动区带焦点框（请重点审批）

12. **根因**（比决策 145 第 18 条写的更宽）：Base UI 默认把初始焦点给弹层里第一个可 Tab 的元素。`DialogPanel` 包着 `ScrollArea`，它的视口带 `tabIndex=0`（让键盘能滚动）；而且溢出是挂载后下一个微任务才量出来的，量之前默认按「有溢出」处理，所以**内容不超高时视口在选初始焦点那一刻也是可 Tab 的**。于是凡是 `DialogPanel` 排在最前面的对话框，打开时焦点都落在滚动区上。挂载测试 `[DLG-FOCUS-0]` 用 Base UI 自己的默认值复现了这一点。
13. **改法**：`ui/dialog.tsx` 的 `DialogPopup` 在调用方没有传 `initialFocus` 时，用 `dialogInitialFocus`：
    - 弹层里第一个可 Tab 的元素**不是**滚动区：交回 Base UI 的默认（`true`），行为不变；
    - 第一个是滚动区：改给第一个不是滚动区的可 Tab 元素（面板里的输入框、页脚按钮、右上角关闭按钮，按文档顺序）；一个都没有时给弹层本身；
    - 触摸打开：照 Base UI 的默认给弹层本身（避免弹出软键盘）。
    - 调用方自己传的 `initialFocus` 照旧优先（旧资产提示仍指向「知道了」）。
14. **键盘可达性不变**：滚动区仍是 `tabIndex=0`，Tab / Shift+Tab 照样能到，只是不再是打开时的落点。
15. **可见的变化**（请重点审批）：表单类对话框打开时焦点落在第一个字段上。例如「添加 AI 服务」打开后焦点在「服务」下拉框（原来在滚动区上）。键盘打开时下拉框按浏览器 `:focus-visible` 规则显示焦点框，鼠标打开一般不显示；下拉框不会因此展开。若某个对话框的第一个可聚焦元素在长内容的下方，打开时滚动区会滚到它那里——目前没有找到这样的对话框，GUI 复核时留意。
16. 测试：新增 `ui/__tests__/dialogInitialFocus.test.ts`（挂载 6 条：对照组、页脚按钮、面板里的输入框、只能给弹层、非滚动区在前时保持默认、调用方优先；纯函数 3 条）。`userProvidersSettings.test.ts` 的取选项辅助函数改为只读「本次展开的那个下拉框」的列表：Base UI 的下拉框在触发器获得焦点时就预先挂载（隐藏的）选项，焦点改落到「服务」下拉框后，全文档查询会把它的 15 个选项一起数进来。断言本身没改。

### 6. 恢复失败停在 `error` 的会话一直留在「正在活动」（决策 145 发现第 6 条）（请重点审批）

17. **改法**：Main 自己放弃重开某个会话时（`parkInError` 的五个调用点：宿主崩溃后恢复批次里的「连续两次在场」与「宿主起不来」、自身重启预算用完、通道两次关不掉、宿主已失败；以及「没有持久身份不能安全重启」那一处），发一次 `session.status: {status: 'disconnected', disconnectReason: 'released'}`。
    - 语义与决策 145 第 4 条的 `released` 一致：「Main 放开了这个会话，并且不会再自己打开它」。渲染层照现有规则处理：从 `hostBoundSessionIds` 去掉（离开「正在活动」，下次发送走 resume）；状态是 `failed` 的保留 `failed`（失败卡与「失败」徽标都在），其余记为 `disconnected`；不弹提示。
    - **Main 仍保留这个 `error` 条目**（设计如此：用户的下一次打开会退役它并走冷路径；管理器状态仍是 `degraded`，诊断仍看得见）。
    - 连带：容量回收挑中的若是这种 `error` 条目，**不再**宣告 `capacity_reclaimed`（它已经宣告过 `released`，引擎上也没有东西被回收；D12 说一次）。否则用户会在它已离开「正在活动」之后，又收到一条「已转入后台」的提示。空闲回收与 `invalidateAll` 对它再说一次 `released` 无害（渲染层幂等），没改。
18. 测试：`WorkerManager.test.ts` 新增 `[E156-6]`（停在 error 后恰好一次 `released`、管理器仍 `degraded`；随后被容量回收时不再多说）；`[WMH-02]`（宿主预算用尽，两个会话各一次 `released`）与 `[WMH-03]`（只有停在 error 的那个 `released`，恢复了的那个没有）补了断言。

### 7. 改名框按 Esc 取消后焦点回到那一行（决策 145 发现第 7 条）

19. 取消改名时记一个标志，编辑框卸下、行重新渲染后把焦点给这一行（`role="button"`、`tabIndex=0` 的那个触发器）。只管 Esc：按 Enter 提交后焦点同样落到页面上，清单没有列，没改（见「疑点」）。
20. 测试：`sidebarActiveAndFolders.test.ts` 新增 `E156-7`（Esc 后 `document.activeElement` 是那一行）；去掉这一行代码时该用例失败（已核对）。

### 8. 问题 44 后半：容量回收时失败对话保留失败徽标与失败卡（决策 149 第 10 条）

21. 渲染层收到 `capacity_reclaimed` 时，与 `released` 同一条规则：状态是 `failed` 的只解绑、保留 `failed`；其余照旧记为 `disconnected`。回收提示（toast）照旧按事件说一次。
22. 测试：`chatSessionsBatch.test.ts` 新增 `E156-44`。

### 9. 回退标题 `Session xxxxxx` 显示层改中文（决策 149 第 11 条）

23. `displaySessionTitle` 认出回退标题的形状（与 `isPlaceholderTitle` 同一个正则 `^Session \S{1,6}$`），显示为 `t('Session {{id}}')`：中文「会话 srd2ne」，英文仍是 `Session srd2ne`。存储值、`fallbackSessionTitle` 的产出、`isPlaceholderTitle` 的判断都不变（判断读存储值）。
24. 用到 `displaySessionTitle` 的地方随之生效：侧栏行（标题、悬停、改名框初值、归档 / 结束对话确认框）、会话栏标题、容量回收提示、侧栏搜索（输入「会话」能找到）。
25. 已知边界：用户自己起的、恰好形如 `Session` 加 1～6 个非空白字符的标题（如 `Session A`）本来就被 `isPlaceholderTitle` 当成占位，现在中文界面也会显示成「会话 A」。这是沿用既有识别规则的结果，没有另做区分。
26. 测试：`e4CatalogKeys.test.ts` 新增 `E156-9`。`sidebarContextMenuInteraction.test.ts` 的 `t` 桩改为按参数插值（它的测试数据标题正是 `Session A`，原桩不插值，会显示成 `Session {{id}}`）。

### 10. 侧栏归档按钮 `Archive`（决策 149 第 12 条）

27. `aria-label={t('Archive session')}`（「归档会话」）、`title={t('Archive')}`（「归档」），两个词条原本就有（确认框标题与右键菜单在用）。
28. `sessionContextMenuWiring.test.ts` 的锚点从 `aria-label="Archive session"` 改为 `aria-label={t('Archive session')}`，原断言（悬停按钮只打开确认框、不直接归档）不变，另加三条：按钮带 `title={t('Archive')}`、源码里不再有两个英文字面量。
29. `scripts/run-f2b-probe.mjs`（手工 CDP 探针，不是测试）仍按 `aria-label === 'Archive session'` 找按钮；它同时按早已不存在的 `Close session` 找行，本来就过期了，没改。

### 11. 评审标题显示原始模型 id（决策 146 第 13 条）

30. 指定模型时，括号里改为模型的显示名：从模型目录取（`usePiModelCatalog` 的 `catalog.models[].label`，与输入框模型菜单、设置 · AI 的模型下拉同一来源），目录里没有这个 id 时退回 id。自动模式「代码审查(自动)」不变。
31. 读目录的部分放在只在标题里渲染的小组件 `ReviewModelName` 里：`CodeReviewModal` 跟着 Git 改动列表一直挂着，若在外层调用目录钩子，Git 面板一挂上就会去向 Main 要目录。传给钩子的宿主状态与设置 · AI 一样写 `'ready'`。
32. 测试：`codeReviewModalTitle.test.ts` 新增 `E156-11`（显示名）与 `E156-11-AUTO`（自动模式不读目录），原 `GW6-CHOSEN` 改名为「目录里没有时显示 id」，断言不变。

### 12. 失败回合直播空消息与回放失败注记并存（决策 146 第 22 条第 2 点）（请重点审批）

33. **为什么不照决策 146 对 Stop 的做法改投影**：让投影给失败占位行也带上 `liveMessageId`，最省事，但会改动金样本 `rpc.fail.json`（它的 `worker.history` 里就是这一行），按规则不能重录，所以改在渲染层。
34. **以回放 / 注记为准，直播外观不变**：
    - 直播：收到 `session.failed` 时，若这一回合**最新的** assistant 消息是空的（请求发出、一个字也没回），只给它打上 `stopReason: 'error'`（历史里对这种请求的叫法）。它在屏幕上本来就什么都不画，打标不改变任何显示；失败卡照旧说明失败。只看最新一条且必须是空的，是为了不误伤：请求未发出就失败（例如模型缺失，没有回显、没有消息）时，往回找会找到上一回合的回复，那条不是空的，不会被打标。
    - 回放：在合并之前，渲染层替历史里的失败占位行补上直播 id：占位行的 id 是「回合首行 id + `:end`」，找到回合首行，取这一回合里最后一条带直播 id 的用户消息（Ctrl+Enter 插入的消息也算这一回合），在当前时间线里从它的直播回显往后找到被打标的空消息，把它的 id 记到占位行上。之后由现有的「按直播 id 精确合并」把空消息换成注记行，与决策 146 对 Stop 的处理同一条路。
    - 只认被打标的空消息：没有亲眼看到失败的窗口、或者回复已经流出一部分再失败的，合并行为与原来完全一样。
35. 测试：`chatSessionsHistory.test.ts` 新增五条 `E156-12-*`（直播只打标不改显示、回放后只剩一条注记、Ctrl+Enter 插入后仍能对上、失败没有自己的消息时不碰上一回合、回复流出一部分后不打标）；去掉回放补 id 这一步时，两条回放用例失败（已核对）。渲染层回放金样本 `dshStreamReplay.test.ts`（224 条，含 `fail`、`fail-retry`）全部通过，没有差异。
36. **第 1 点（请求还没发出就被停的回合，直播只显示「已工作 N 秒」）记为遗留**：这种回合直播没有任何 assistant 消息，要显示注记得在直播里新插一行；而历史里对应的占位行没有直播 id（没有 `assistant/attempt`），回放时要靠「回合首行 → 用户回显」去配对。配对本身能复用第 34 条，但 Stop 落在 Ctrl+Enter 插入的消息之后时，历史不写占位行（这一回合前面已经存过步骤），直播却会插注记，两边说法不一；要处理干净需要更多规则，不算顺手。

### 13. 决策 145 第 17 条遗留：再发一轮后，上一轮失败回合的尾行重新显示「完成于」

37. **修了（小改动）**：回合尾行判断「没有完成」的条件，在「以注记结尾」「拥有当前会话失败」之外，再加「这一回合最新的 assistant 消息是被打标的空失败请求」（第 34 条的标记）。于是上一轮失败回合在下一轮开始、失败卡让位之后，仍不写「完成于」，与重开后一致；「已工作 N 秒」照旧。
38. 覆盖范围：请求一个字也没回就失败的回合（含前面已经存过步骤、最后一次请求失败的）。**没覆盖**：回复已经流出一部分再失败的回合，下一轮之后仍会显示「完成于」——直播里那条消息不是空的，没有打标（打标会让回放把流出的文字也一起换掉）。重开之后由历史注记判断，没有这个问题。失败重试（「继续」）成功的回合，最新的 assistant 消息是重试的回答，照常显示「完成于」。
39. 「下一轮之后在直播里也画出失败注记」没有做：要在时间线里为非注记行渲染失败说明，超出「改动小」。
40. 测试：`turnEndReplayMount.test.ts` 新增 `E156-13-MOUNT`（挂载：对照组不打标时显示「完成于」，打标后不显示，下一轮照常显示）；`turnEndNotice.test.ts` 新增 `turnEndsOnFailedRequest` 的纯函数用例。

## 测试

- 新增 29 条：`dialogInitialFocus.test.ts` 9（新文件）、`middleColumnLayout.test.ts` 2、`WorkerManager.test.ts` 1（另给 `[WMH-02]`、`[WMH-03]` 补断言）、`chatSessionsBatch.test.ts` 1、`sidebarActiveAndFolders.test.ts` 1、`e4CatalogKeys.test.ts` 1、`codeReviewModalTitle.test.ts` 2、`chatSessionsHistory.test.ts` 5、`turnEndReplayMount.test.ts` 1、`turnEndNotice.test.ts` 1、`e6CopyAndPrimitivesStatic.test.ts` 5（两个文件进 10 px 扫描、一条更严的 10 px 断言、两个原语）。
- 改写（文案或锚点变了，断言意图不变）：`attachments.test.ts` 4 处、`middleColumnLayout.test.ts` 7 处（发送中的占位）、`composerStopStatic.test.ts`（只改注释里的旧字面量）、`sessionContextMenuWiring.test.ts`（锚点）、`codeReviewModalTitle.test.ts`（加目录钩子的桩）、`userProvidersSettings.test.ts`（取选项的范围）、`sidebarContextMenuInteraction.test.ts`（`t` 桩插值）。
- `rg -a` 复扫旧字面量：`Agent Host`（只剩存储标识符与看不到的 DEMO 正文）、`Show more` / 「显示更多」（只剩注释与两条 `not.toContain`）、`Archive session` 字面量（只剩上面第 29 条的手工探针）。

## 对既有决策的修订注记

- 决策 145 第 5 条：失败只解绑的规则扩到 `capacity_reclaimed`（第 21 条）与 Main 放弃重开时的 `released`（第 17 条）。
- 决策 145 第 17 条：遗留由第 37 条部分落地（未覆盖的见第 38 条）。
- 决策 145 第 18 条：初始焦点的处理从旧资产提示推广到所有对话框（第 13 条）。
- 决策 146 第 13 条遗留（指定模型时显示原始 id）由第 30 条落地；第 22 条第 2 点由第 34 条落地，第 1 点仍是遗留（第 36 条）。
- D12：容量回收挑中已宣告 `released` 的 `error` 条目时不再说（第 17 条）。

## 疑点（没改，供判断）

- 宿主崩溃（不带原因的 `disconnected`）与 `engine_restarted` 仍会把 `failed` 改写成 `disconnected`，失败卡与徽标随之消失；与决策 149 第 10 条同一原则，但不在清单内，改了会牵动崩溃恢复路径，没动。
- 改名按 Enter 提交后焦点也落到页面上（第 19 条）。
- `AddRepositoryDialog` 的清除按钮没有可读名称（第 11 条）。

## 建议在 P1-14 复点验的项目

1. 中文界面首条消息、带附件发送、普通发送时输入框的占位，以及握手阶段的回合头「正在连接对话引擎… · N s」。
2. 上下文面板的「查看更多（N）」、「字符」「按发送者」、角色图例与底部说明的 14 px；Run 面板工具状态行与会话累计说明的 14 px（看是否挤）。
3. 读屏（或无障碍树）：转圈图标读「加载中」，编辑器路径栏读「路径导航」。
4. 对话框焦点：旧资产提示、添加 AI 服务、会话分支、创建 worktree 等带 `DialogPanel` 的对话框，键盘与鼠标打开时焦点落点与焦点框；Tab 能进滚动区。
5. 宿主崩溃后恢复失败（或宿主预算用尽）的会话离开「正在活动」，失败的保留失败卡与徽标；之后被容量回收时不再弹提示。
6. 侧栏改名按 Esc 后，方向键 / Enter 直接作用在这一行。
7. 失败对话被容量回收后「失败」徽标与失败卡仍在。
8. 回退标题显示为「会话 xxxxxx」；英文界面仍是 `Session xxxxxx`。
9. 侧栏悬停归档按钮的提示「归档」。
10. 代码审查标题显示模型显示名。
11. 失败回合（请求一个字未回）：直播只有失败卡；再发一轮后上一轮不写「完成于」；被回收后重开（resume 回放）只有一条失败注记。

## 用户审批

待审批。
