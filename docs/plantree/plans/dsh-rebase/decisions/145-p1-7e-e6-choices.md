# 决策 145：P1-7e 收尾组（e6）的实现取舍：改名框的 Esc、宿主放手后离开「正在活动」、末尾卡片自己进视野、文案与小字、界面原语的中文标签

日期：2026-09-30。**状态：自主决定，待用户审批。**

依据：

- [P1-7e 复点验证据](../evidence/p1-7e-recheck-2026-09-30.md) 的问题 36～43，以及「与前几批相关、未列入五组的」里问题 35 的后半；
- [决策 144](144-p1-7e-e4-choices.md) 做 e4 时顺带发现、没有列进它清单的几类：10 px 中文、按钮被 `lowercase` 压小写、界面原语里的英文、搜索按存的标识符匹配；
- [决策 137](137-user-ruling-sidebar-active-and-folders.md) 第 1 条（被回收 / 宿主重启后离开「正在活动」）与第 4 条（「查看更多（N）」）、[138](138-p1-7e-e1-sidebar-choices.md)（改名持焦）、[139](139-p1-7e-e2a-timeline-sessions-choices.md) 第 14 条（卡片放在时间线末尾）、[140](140-p1-7e-e2b-choices.md) 第 4 条（失败回合没有「完成于」）、[142](142-p1-7e-e3-choices.md) 第 25 条（回收提示按「有没有在跑」措辞）、[131](131-plugin-row-titles-and-fork-title-choices.md) 第 15 条（Main 按当时界面语言写过渡标题）、D12（容量回收说一次）、[090](090-user-rulings-2026-09-28.md)；
- 设计规范 `docs/design-system.md`：「CJK 级联规则」第 3 条（10 px 不承载 CJK）、「按钮文案强制小写」与 `normal-case` 豁免。

改动留在工作区，由编排者复跑后提交。没有起 Electron、没有做 GUI 点验（本机硬规则），界面行为只由挂载测试与源码扫描验证。**第 4、5、9、13、19 条请重点审批。**

## 落地了什么

- Main：`services/agent-host/WorkerManager.ts`（`retireEntry` / `disposeEntries` 可带宣告原因；`invalidateAll` 与空闲回收宣告 `released`；分叉标题按界面语言）。
- 共享：`shared/types/runtimeEvents.ts`（`SessionDisconnectReason` 加 `released`）、`shared/sessionTitles.ts`（新：`NEW_CHAT_TITLE`、`LEGACY_SEED_TITLE` 挪到这里，`FORK_TITLE_KEY`、`forkSessionTitle`）、`shared/i18n.ts`（文末新增一块 8 条中英，删掉 1 条不再使用的旧词条）。
- 渲染层：
  - `workspace-shell/`：`LeftNav.tsx`（改名框、「最近」的查看更多、搜索传 `t`）、`sidebarTree.ts`（搜索按显示标题也匹配）、`useCapacityReclaimNotice.ts`、`SessionBar.tsx`、`SessionReviewPanel.tsx`；
  - `chat/`：`MessageTimeline.tsx`（末尾卡片自己进视野；直播失败回合不写「完成于」）、`messageTimelineScroll.ts`（`shouldRevealEndNotice`）、`middleColumnLayout.ts`（`TURN_RUNNING_PLACEHOLDER`）、`BackgroundJobsWindow.tsx`、`sessionIndex/sessionTitle.ts`（改为从 shared 转出两个常量）；
  - `stores/chatSessions.ts`（`released` 解绑，失败状态保留）；
  - `terminal/`：`ShellTerminal.tsx`（关搜索后焦点回终端）、`TerminalSearchBar.tsx`（文案、标签）；
  - `settings/`：`LegacyAssetNotice.tsx`（初始焦点）、`AppearanceSettings.tsx`；`layout/`：`GitMissingNotice.tsx`、`WindowControls.tsx`；`ui/`：`dialog.tsx`、`sheet.tsx`、`toast.tsx`。
- 没有动 bridge、没有动金样本。

## 规则

### 问题 36：改名框里按 Esc 收起了整个侧栏

1. **根因**：`LeftDock` 在捕获阶段处理 Esc，只放过 `[data-surface-holds-escape]` 子树与打开着的弹层（`shouldCloseOnEscape`）。改名框两者都不是，于是侧栏收起并 `stopPropagation`，改名框自己的 `onKeyDown` 收不到这个键。
2. **改法**：改名编辑态的外层加 `data-surface-holds-escape`（`SURFACE_ESCAPE_HOLD_ATTR`，与终端、编辑器、Git 面板同一约定）。在改名框里按 Esc 只取消改名、侧栏不动；不在改名时，侧栏里按 Esc 照旧收起。`LeftDock` 本身没改。

### 问题 37：宿主放手后，对话仍列在「正在活动」、标「正在后台运行」

3. **根因**：Main 清掉会话条目时，只有正在跑回合的才发 `session.status: disconnected`，而且不带原因；渲染层只在 `capacity_reclaimed` / `engine_restarted` 时把对话从 `hostBoundSessionIds` 里去掉。清掉空闲条目的两条路都不说话：
   - `invalidateAll`：登录、登出、服务或模型计划变化、插件开关都走它，所有会话连同宿主一起关掉，之后**没有东西再把这些会话开回来**；
   - 空闲回收（15 分钟没用）：同样关掉、不再打开。
   复点验里「杀宿主之后也一样」的现象，按代码与集成测试（「SIGKILL 之后所有会话都恢复」）看，宿主崩溃时 Main 会把每个会话重新打开，对话留在「正在活动」是对的；那几行是更早一次插件开关留下的（复点验的证据时间顺序是：杀宿主 → 6 个填充对话 → 插件开关 → 读 `slots`）。
4. **改法：新增断开原因 `released`**（请重点审批）。「Main 自己放开了这个会话的引擎连接，并且不会再打开它」。
   - `invalidateAll` 与空闲回收退役每个条目时都发 `session.status: {status: 'disconnected', disconnectReason: 'released'}`；正在跑回合的，照旧先发 `session.stopped{forced}`，随后的 `disconnected` 带上同一个原因。
   - 其余退役路径不变：容量回收仍是 `capacity_reclaimed`（有 toast）；宿主崩溃、Main 自己重启宿主仍按决策 020、021 由 Main 重新打开；用户「结束对话」由渲染层自己解绑；应用退出不需要。
   - 渲染层收到 `released`：从 `hostBoundSessionIds` 里去掉（离开「正在活动」，下次发送走 resume）；**不弹任何提示**（什么都没丢，跑着的回合已由 forced stop 说过）；透过 `capacity_reclaimed` 的旧分支不变。
   - 空闲回收原来刻意不说话（D12：超时不能说成「容量满了」）。现在它说的是 `released` 而不是 `capacity_reclaimed`，D12 的那一条仍然成立；变的只是渲染层能据此解绑。
5. **失败状态不被放手抹掉**（请重点审批）：`released` 到达时，状态是 `failed` 的对话保留 `failed`（时间线的失败卡与侧栏的「失败」徽标都还在），只解绑；其余对话照容量回收的做法把状态记为 `disconnected`。不这样的话，一次插件开关或登录就会把所有失败对话的卡和徽标一起抹掉。容量回收时徽标消失（问题 44 后半）不在本组，没有改。
6. **事件形状**：只是 `SessionDisconnectReason` 的取值多了一个，仍是 `session.status` 上的可选字段；不认识它的旧消费方照旧只读 `status`。bridge 与金样本不涉及。集成测试的插件开关用例补了一段：开关前留一个空闲会话，开关后它收到且只收到 `status:disconnected/released`，Main 里也没有它了。

### 问题 38：迁移失败卡（文件缺失）少滚 46 px

7. **根因**：没能在代码里钉死。卡片靠通用的「贴底跟随」带进视野（决策 139 第 14 条）；跟随标志在卡片出现前已经不在「跟随」状态、或者这一次的尺寸变化通知没有及时送到，卡片就停在 46 px 之外——恰好落在「跟随阈值 40 px」与「回到底部按钮阈值 140 px」之间的死区，之后再没有东西把它追上。开发机不能跑 GUI，只能从代码与复点验数据推断（迁移中提示在 `source_busy` 时也晚了约 0.4 s 才被跟上）。
8. **改法**：不依赖通用跟随，让「时间线末尾的卡片」（历史读取卡、迁移失败卡、迁移中提示）出现时自己进视野：
   - 条件（`shouldRevealEndNotice`）：出现前读者在跟随，或者离底部不超过 140 px（回到底部按钮出现的位置，即覆盖上面的死区）；读者往上翻得更远就不动他的位置；
   - 在布局之后、绘制之前（`useLayoutEffect`）滚到底并重新挂上跟随，再在下一帧补一次（给晚一帧才定下高度的内容），读者这一帧里主动离开底部就不补；
   - 滚到底后回到底部按钮随之收起（与点按钮的行为一致）。
   **GUI 复核要看**：文件缺失、文件被占用两种失败卡，以及迁移中提示，是否都完整停在输入框上方 8 px。

### 问题 39：宿主崩溃后，回收提示说成「已停止运行」

9. **改法**：回收提示按事件记录的「这个对话有没有东西在跑」，在收到任何 `disconnected`（宿主崩溃、引擎重启、`released`、回收本身）时清零——worker 走了，它手上的回合与后台任务也就没了（任务窗读作「引擎重启，任务已结束」）。回收提示读的是这条事件**之前**的记录，所以回收自己的那条 `disconnected` 仍按回收前在跑什么措辞，决策 142 第 25 条不受影响（请重点审批：之前的规则是「断开本身不改变记录」）。

### 问题 40：文案

10. **改前改后**（「改前」是复点验看到的中文界面；英文界面的变化写在括号里）：

    | 位置 | 改前 | 改后 |
    |---|---|---|
    | 回合运行中的输入框占位 | Agent Host 正在运行 —— Enter 排队，Ctrl+Enter 并入当前回合… | 回合进行中 —— Enter 排队，Ctrl+Enter 并入当前回合…（`Agent Host is running — …` → `Turn in progress — Enter queues, Ctrl+Enter adds to this turn…`） |
    | 新建分叉的标题 | 某标题 (fork) | 某标题（分叉）（英文仍是 `某标题 (fork)`） |
    | 分叉来源是占位标题 / 没有标题 | New chat (fork) / Session (fork) | 新建对话（分叉）（英文 `New chat (fork)`） |
    | 终端搜索框占位 | Search... | 搜索…（`Search…`） |
    | 终端搜索：区分大小写 | Case Sensitive (Aa) | 区分大小写（`Match case`） |
    | 终端搜索：全词 | Whole Word | 全词匹配（`Match whole word`） |
    | 终端搜索：正则 | Regular Expression | 使用正则表达式（`Use regular expression`） |
    | 终端搜索：上一个 | Previous (Shift+Enter) | 上一个匹配（Shift+Enter）（`Previous match (Shift+Enter)`） |
    | 终端搜索：下一个 | Next (Enter) | 下一个匹配（Enter）（`Next match (Enter)`） |
    | 终端搜索：关闭 | Close (Esc) | 关闭搜索（Esc）（`Close search (Esc)`） |
    | 「最近」的展开 | 显示更多 (21) | 查看更多（21）（`Show more (21)` → `View more (21)`） |

11. **分叉标题只管新建时的命名**（请重点审批）：由 Main 在创建分叉时按当时的界面语言写进索引（`forkSessionTitle`，与决策 131 第 15 条的「（1.0.x 分支）」同一做法）。它从此就是这个对话的名字：之后切换语言不改写，**已经存下的「(fork)」标题一个字不动**（不做持久数据迁移，也不在显示层把旧后缀换成中文——显示层映射会牵动搜索、改名初值与后缀识别，收益只是旧的几条标题）。
12. 终端搜索栏的三个开关复用全局搜索已有的词条（「区分大小写」「全词匹配」「使用正则表达式」）；六个按钮都补了 `aria-label`（原来图标按钮只有英文 `title`，读屏读英文），三个开关补了 `aria-pressed`。
13. 「最近」与工作区统一用 `View more ({{count}})`，中文「查看更多（N）」、全角括号，就是决策 137 第 4 条用户确认过的写法（请重点审批：「显示更多」这个词不再出现在侧栏；上下文面板里另有一处同样的「显示更多 (N)」，不在本组，见「发现」）。两处按钮的数字都加 `tabular-nums`。

### 问题 41：终端搜索栏关闭后焦点落到页面

14. 关闭搜索（搜索框里按 Esc，或点 ✕）后把焦点还给终端（`terminal.focus()`），接着打的字直接进 shell。Esc 仍不送到 shell（与决策 142 一致）。

### 问题 42 与 10 px 中文

15. 设计规范不许 CJK 落在 10 px：
    - 审阅面板底部说明、审阅条目展开后的来源说明：`text-2xs` → `text-meta`（14 px）；
    - 会话栏的「临时」标签：`text-2xs` → `text-meta`，与同一行的标题同档；
    - 后台任务窗的「超时转入后台」「退出码 N」徽标：Badge `sm` → `lg`（桌面 14 px），与决策 144 第 2 条侧栏徽标同一做法。代价：徽标高 22 px，放在 24 px 的行里，GUI 复核看是否挤。
    - 审阅条目的 `A` / `M` 标记是拉丁字母，保留 10 px。

### 问题 43：直播里失败的回合仍显示「✻ 完成于」

16. 回合尾行不写「完成于」的条件，除了「以『没有保存回复』的注记结尾」（重开后才有，决策 140 第 4 条），再加上「这一回合拥有当前的会话失败」（`ownsSessionFailure`，即回合头显示「失败」的同一判断）。直播与重开一致；「已工作 N 秒」照旧。
17. **遗留**：直播里接着再发一轮之后，上一轮已不是「拥有失败」的回合，它的尾行会重新显示「完成于」，直到重开（重开时由注记判断）。要彻底一致需要直播也收到失败注记行，超出本组。Stop 停下的回合直播时是否显示「完成于」这次没有核对。

### 问题 35 的后半：旧资产提示打开时滚动区带焦点框

18. 这个提示是自己弹出的，焦点落在哪由我们决定。原来按 Base UI 的默认落到第一个可 Tab 的元素，列表长时就是 `DialogPanel` 的滚动区（`tabIndex=0`），于是带上橙色焦点框。改为 `initialFocus` 指向「知道了」：Enter 直接关掉，Shift+Tab 能回到列表。按钮上是否显示焦点框由浏览器的 `:focus-visible` 判断决定，GUI 复核时看一眼；若嫌按钮上的框也多余，可改为把焦点给对话框本身（`initialFocus` 返回弹层元素）。

### 按钮被 `lowercase` 压小写

19. 同决策 144 第 20 条加 `normal-case`（请重点审批，豁免清单又多三处）：
    - `GitMissingNotice` 的「安装 Git」「去下载 Git」；
    - `AppearanceSettings` 的「URL 模式」，只在 URL 模式下加（同一个按钮在另外两种模式下是「选择文件夹」「选择文件」，英文界面保持原来的小写风格）。
    - 代价同 144 第 20 条：英文界面下这几个按钮不再全小写。设计规范里「现有豁免共 6 处」的清单没有回写。

### 界面原语里的英文

20. 用户看得见、或读屏会读的标签改走词条：
    - 对话框、抽屉右上角的关闭按钮 `Close` → 「关闭」；
    - toast 的关闭按钮 `Close notification` → 「关闭通知」（新词条）；
    - 窗口控制按钮 `Minimize` / `Maximize` / `Restore` / `Close` → 「最小化」「最大化」「还原」「关闭」（已有词条）；「还原」图标上重复的 `aria-label` 删掉，改为 `aria-hidden`（按钮自己已经有名字）。
    - `ui/dialog.tsx`、`ui/sheet.tsx`、`layout/WindowControls.tsx` 因此开始引用 `@/i18n`（`toast.tsx` 原本就引用）。挂载这些组件的测试需要照常给 `electronAPI.settings` 打 hoisted 桩或 mock `@/i18n`；这次跑过的全部渲染层测试没有因此挂起。

### 侧栏搜索

21. 搜索同时匹配存的标题与显示的标题（`displaySessionTitle`）：占位标题存的是 `New chat`、显示「新建对话」，输入「新建」能找到它；输入 `new chat` 照旧也能找到。四处列表（工作区、临时对话、「最近」、「正在活动」）同一个规则；不传界面语言时行为与原来完全一样。

## 发现（本组没有改）

- **同一函数里还有「Agent Host」**：输入框发送中的占位「正在发送到 Agent Host…」「正在与 Agent Host 建立会话（仅首条消息）…」「正在向 Agent Host 发送 N 个附件…」，回合头「正在启动 Agent Host… · N s」，权限档提示「Agent Host 尚未就绪。」。与问题 40 同一类，清单只列了运行中那一条。
- **上下文面板**（`surfaces/ContextSurfaceView.tsx`）仍是「显示更多 (N)」，半角括号。
- **10 px 中文还有**：`surfaces/RunSurfaceView.tsx`（当前工具状态行、会话累计说明）、`surfaces/ContextSurfaceView.tsx`（「字符」「按发送者」、角色图例、底部说明）。
- **读屏仍读英文的原语**：`ui/spinner.tsx` 默认 `aria-label="Loading"`（很多地方没覆盖）、`ui/breadcrumb.tsx` 的 `More`、`ui/pagination.tsx`、`ui/combobox.tsx` 的 `Remove`、`ui/sidebar.tsx` 的 `Toggle Sidebar`（后几个是否可达没核对）。
- **同类的焦点框**：任何内容超出高度的 `DialogPanel`，打开时都可能把焦点给滚动区（Base UI 默认初始焦点 + 滚动区 `tabIndex=0`）。本组只改了旧资产提示；更一般的做法是在 `ui/dialog.tsx` 里统一处理，没做。
- 宿主崩溃后某个会话恢复失败、停在 `error` 时，Main 仍保留它的条目，渲染层也不解绑，它会一直列在「正在活动」。
- 改名框按 Esc 取消后，焦点落到页面，没有回到那一行。

## 测试

- 新增（33 条）：
  - `WorkerManager.test.ts` 2 条（`invalidateAll` 对空闲与跑着的会话都宣告 `released`；结束对话不宣告）；
  - `chatSessionsBatch.test.ts` 2 条（`released` 解绑并保留转录；失败状态保留）；
  - `sidebarActiveAndFolders.test.ts` 3 条（挂载：`released` 后离开「正在活动」；在侧栏捕获规则下 Esc 只取消改名；「最近」读作「View more (N)」）；
  - `sidebarTree.test.ts` 2 条（中文「新建」找到 `New chat`，四处列表都一样；不传语言时不变）；
  - `capacityReclaimNotice.test.ts` 1 条（宿主崩溃后再回收，措辞是「空闲的…」）；
  - `middleColumnLayout.test.ts` 1 条（运行中占位的中文，不含 Agent Host）；
  - `shared/__tests__/sessionTitles.test.ts` 3 条（新文件）；
  - `shellTerminalSearchKey.test.ts` 2 条（Esc 后焦点回终端；六个按钮的标签）；
  - `turnEndReplayMount.test.ts` 1 条（挂载：直播失败回合没有「完成于」，对照组有）；
  - `messageTimelineScroll.test.ts` 3 条（`shouldRevealEndNotice`）；
  - `legacyMigrationTimelineMount.test.ts` 2 条（挂载：差 46 px 时卡片到底；翻远的读者位置不动）；
  - `legacyAssetNoticeMount.test.ts` 1 条（初始焦点在「知道了」）；
  - `workspace-shell/__tests__/e6CopyAndPrimitivesStatic.test.ts` 10 条（新文件：三个文件里没有 10 px 的翻译文字；三个按钮带 `normal-case`；四个原语的标签走词条）。
- 改写（行为变了，断言跟着改，8 条）：`WorkerManager.test.ts` 的三条排空窗口用例（`invalidateAll` 现在先发 `released`）与「空闲回收」用例（现在说 `released`，仍不说 `capacity_reclaimed`）；`middleColumnLayout.test.ts` 两处运行中占位；`capacityReclaimNotice.test.ts` 的 `[E3-11-WORK]`（断开现在清零记录）；集成测试 `[PLG-1, PLG-2]` 补了 `released` 一段。`shellTerminalSearchKey.test.ts` 的 `useXterm` 桩改为给出一个带 `focus` 的终端对象。
- 没有改任何源码扫描类测试（`*Static*` / `*Wiring*`）。`messageTimelineWiring.test.ts` 数 `syncJumpToBottom(viewport)` 恰好两处，末尾卡片进视野时按它的意图不另加一处，改为像「回到底部」按钮那样直接收起按钮。

## 对既有决策的修订注记

- D12：空闲回收不再完全静默，改说 `released`（仍不说 `capacity_reclaimed`，不弹提示）。
- 决策 137 第 1 条：「宿主重启后离开这一节」由本决策第 4 条落地（插件开关、登录登出、服务变化、空闲回收）。
- 决策 139 第 14 条：末尾卡片不再只靠通用跟随进视野（第 8 条）。
- 决策 140 第 4 条：直播也按同一条件不写「完成于」（第 16 条）。
- 决策 142 第 25 条：记录在任何断开时清零（第 9 条）。
- 决策 144 第 8 条：搜索也认显示标题（第 21 条）。

## 用户审批

待审批。
