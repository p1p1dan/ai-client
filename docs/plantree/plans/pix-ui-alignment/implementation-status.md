# Implementation Status — pix/pi-app UI 对齐改造

**Current Phase**：**批次 13/14/15 全部落地（U22–U31）**。累计 GUI 点验已于 2026-09-06
由用户在真实窗口跑完，产出的五条反馈加一条追加诉求都已收口。
壳层仍按 [D08](./decisions/008-vscode-dock-shell.md)，但它的两条已被本批推翻：
中栏 Tab（[D12](./decisions/012-single-session-view-and-background-concurrency.md) 决定一）
与 TUI 独占（[D13](./decisions/013-editor-stays-available-in-tui.md)，实际推翻的是 D02）。

**Next Target**：**批次 13/14 的累计 GUI 点验**——七片全部只差真窗口确认，
其中 U28 有一条是崩溃复现（原「直接开聊」按钮的路径）。看点见下方 Active TODO 第 1 项。

**Last Landed**：2026-09-06 **U30 + U31**（用户第二轮点验的产出）。
**U30-a** 权限菜单选完不关——`MenuPrimitive.RadioItem` 按设计不关闭（radio 语义是反复切），
`<Menu>` 改受控且**只在 `applyTier` 里关**（放 `handleSelect` 会让危险档的确认框来不及出现）。
**U30-b** 底栏抖动——模型触发器右边缘被 `ms-auto` 钉住、左边缘随标签浮动，
菜单原本锚在会动的那条边上；改 `align="end"` + `max-w-56` + 名称 `truncate`。
**U30-c** 权限卡「重叠」不是错位，是 `Button` 焦点光环（盒外 3px、不占布局）
伸进了 `gap-1` 的 4px 缝，而第一项 `autoFocus` 所以每次必现；改 `gap-2`。
**U31** 左栏批量归档：`archiveMany` **只 refetch 一次**（循环调 `archive` 会整份重取 N 遍，
而这功能存在的场景正是「会话太多」）；选择态是**一个可空 Set**；
同一行横条服务两种模式；复选框占运行点那个槽，行高不变。
**顺带修好** `'Archive'` 从来没有中文条目这个既有缺陷。
**280 files / 4246 tests 全绿**。真机验证：顶栏变「已选 N 项 ⧉ 归档 取消」、行首复选框勾上。
证据见 [U30/U31 evidence](./evidence/2026-09-06-u30-u31-chrome-and-bulk-archive.md)。
**第四条反馈（问答卡）不是缺陷**，取证结论见 [Q14](./open-questions.md)。

**同一天稍早**：2026-09-06 **U29** 起始屏底栏不再是空的
（关闭 [D14](./decisions/014-start-screen-is-a-live-composer.md) 的「已知未对齐处」，
用户拍板「那就全局默认吧」）。
**先查了 pix**：它的 `Composer` 根本不接收 sessionId——模型/思考档写给 **host 进程**、
权限档是**全局偏好**、占用是只读快照字段。pix 是单 host 单会话，
**「没有会话」这个状态在它那里不存在**；它防空白的手法是
`snapshot?.model ?? lastComposerChromeRef.current.model`，
注释写着「survives snapshot gaps so composer never flashes 未选择模型」。
**抄规则不抄结构**：我们多会话并发，模型/思考档必须留在会话上，
采纳的是「控件永不空白，无会话时用全局模板顶上」。
模型/思考档的全局位 `chatAgentDefaults` 早就存在且该组件本来就在写它，
所以只是把 per-session 读写在无会话时跳过；权限档新增独立 key
（不在 per-session 映射里占保留 id——那张表会被清扫）；
spawn 档位变两级、会话自己的仍优先。**占用 chip 刻意不动**（实测量，pix 同）。
**278 files / 4230 tests 全绿**，变异验证两条判红。
**真机前后对照**：干净 profile 下 `activeSessionId: null`，底栏按钮由
`[Attach files, 发送]` 变为 `[Attach files, Pragmatic, Automatic, 发送]`。
证据见 [U29 evidence](./evidence/2026-09-06-u29-start-screen-bar.md)。

**同一天稍早**：2026-09-06 **U28** 起始屏改为「可用的输入框」
（[D14](./decisions/014-start-screen-is-a-live-composer.md)，基准是用户给的 pix 截图）。
**推翻 U22 的落地形态**：U22 的取证对（`canSend` 要求会话、四个入口全死），
但它加按钮去**补入口**而没拆闸——那个按钮把 React 事件对象当成会话标题传下去，
用户点第一下就抛 `Objects are not valid as a React child`。
崩溃是表面，加按钮本身就说明闸没拆干净。
现在 `runSend` 用 `activeSessionId ?? createUnboundChatSession()`，发送即创建会话；
「没有会话」不再判 `error-notice`、占位符不再说「先去左栏选一个会话」
（那两处在前提消失后成了**应用把自己的起始状态标成红色故障**）；
起始屏收敛为标记 + 「开始对话」+ 一句副文案，**没有任何控件**，
并按用户追加要求扩大到**每一次对话开始**（有目录时点名目录）。
**第二轮（同日）**：用户回报「聊天还是假的」——发送闸拆了但 **textarea 自己**
还锁着（`disabled={disabled || !activeSessionId}`），附件按钮同病；
`runSend` 新建的会话 `handleSend` 闭包读不到，会话标题会永远停在「New chat」。
同批把 empty 模式布局改成 composer 钉底 + 起始屏在上方剩余空间居中
（原来是 composer 在起始屏剩下的空间里居中，两者挤在上半屏）。
**278 files / 4228 tests 全绿**，两轮变异验证各四条判红。
**这次自己起 app 验了**：干净 profile 下 `activeSessionId: null` / `workspaces: 0` /
`textarea.disabled: false` / 无红框，键盘输入实际落进了输入框。
证据见 [U28 evidence](./evidence/2026-09-06-u28-start-screen.md)。

**同一天稍早**：2026-09-06 **U25 + U26 + U27**（批次 13 收尾）。
U26（[D13](./decisions/013-editor-stays-available-in-tui.md)）——TUI 下也能看文件。
根因不是缺陷代码，是**一条过期的决定**：U03-a 写 `!isTui && editorOpen` 时「收右栏」
的意思是把宽度让给终端，D08 把编辑器搬进右栏后同一行变成了「终端开着就不能看文件」。
`editorOpen` 派生自 `tabs.length`，所以没开文件时 TUI 仍是「dock + 一整条终端」，
D02 想要的形态没丢，只是不再被强制。
U27——轨道第一个子元素改为 `h-9` 占位并去掉 `pt-1`，与面板标题行下方内容齐平。
U25——**方向由用户改定**：不做复现与压缩，改为限制窗口最小尺寸。
新增 `shared/shellMinimums.ts`，`SHELL_MIN_WIDTH = 324 + 400 + 520 = 1244`，
取左栏**展开态**最小宽（按收起态的 44px 轨道算是 964，但用户一打开面板溢出就回来）。
**278 files / 4227 tests 全绿**，变异验证 U26/U27 各自判红。
证据见 [U25/U26/U27 evidence](./evidence/2026-09-06-u25-u26-u27-layout-fixes.md)。

**同一天稍早**：2026-09-06 **U24** 中栏回到单会话视图 + 后台并发
（[D12](./decisions/012-single-session-view-and-background-concurrency.md)）。
开工取证先回答了用户的疑问：`isSafeToEvict` 的四条里第三条就是「没有正在执行的回合」，
`claimEntry` 让「切走」只等于「不再是前台」——**后台继续执行一直成立，Tab 从未参与判定**。
删 Tab 条与两个镜像 effect，新增 `SessionBar`；左栏启动态标记改读 `hostBoundSessionIds`
（有没有活 worker）而非「有没有 Tab」；U19 的确认框挂到左栏右键菜单，`closeSessionTab.ts`
随之改名 `endSessionRuntime.ts`。并发默认 2/3/4 → **3/6/10**，env 上限 8 → 10。
容量回收现在发 `disconnectReason: 'capacity_reclaimed'`，渲染层据此清掉过期 host 绑定
**但保留消息**，并弹一条 toast；**空闲扫描刻意不发**（另一条线，有反向断言）。
**276 files / 4219 tests 全绿**，改写六个既有测试文件（逐条理由见 evidence 第六节），
变异验证两条核心改动各自判红。
证据见 [U24 evidence](./evidence/2026-09-06-u24-single-session-view.md)。

**同一天稍早**：2026-09-06 **U22 + U23**（批次 13 第一片）。
U22——`canSend` 的最后一道硬闸是 `activeSessionId`，而全新状态下四个出口全部关闭
（`createChatSessionOnWorkspace` 返回 null、`handleNewSession` 空转、`+ New` 带 `disabled`、
欢迎卡只给「选目录」），所以卡上那句「不选也能直接聊」在这个状态下没有任何路径。
新增 `createUnboundChatSession()`（形状照抄 U13 的免绑定会话，**不预写**
`unbound.workspacePath`——目录要到首次发送才分配）。
U23——`useSessionExtensions` 只订 `session.created`，而点开已有会话发的是 `session.resumed`；
挂载时那次查询早于 worker 建好，返回 null 后再无第二次机会。
**275 files / 4210 tests 全绿**（新增 8 条），变异验证两条各自判红。
证据见 [U22/U23 evidence](./evidence/2026-09-06-u22-u23-unbound-entry-and-plugin-resume.md)。

**上一批**：2026-09-05 **U21** 下线实时 `↓` 输出 token 计数器
（[D11](./decisions/011-retire-the-live-output-token-counter.md)）——用户在 U06-b 落地后点名处置
T38 evidence 里那条欠项。取证给出的答案是**这不是「生产者还没接」**：pi 的 11 种事件里只有
`turn_end` / `agent_end` 带 usage，流式的 `message_update` 没有 token 字段，
所以「实时输出 token」在 pi 后端下没有数据源，凑出来只能字符除以 4——正是 U06 一路守的红线。
整条删除（字段 / 两个 reducer / 选择器 / 两处 `↓` 渲染 / `formatTokenCount` / 20 条断言），
保留 `readPiUsagePayload` 与 `messageMetadata` 的「估算不得记为账单」守卫，
并加一条**反向守卫**防止有人把计数器接回来。274 files / **4194** tests 全绿。
证据见 [D11 evidence](./evidence/2026-09-05-retire-live-token-counter.md)。

**同一天稍早**：2026-09-05 **U06-b** 上下文占用与 usage——随 Pi 计划
[T38](../pi-backend-migration/roadmap.md) 同批落地，因为 T38 的每个生产者都只有一个消费者，
分两次落会留下「有字段没人读」的中间态。Run 面板得到占用环 + used/free/window 图例 + usage 行
（全部标「上一回合」：pi 的 usage 是单回合的账，求和会打印出没人收过的费），
U09-2 预留的底栏 `usage` 槽由 `ComposerUsageChip` 填上（只显 `68%`，tooltip 给绝对值），
工具名下方接上 T38-c 的实时状态行。
**开工取证改了做法**：pi SDK 的 `AgentSession.getContextUsage()` 直接返回
`{ tokens, contextWindow, percent }`，占用由 worker 报，不是渲染层拿 token 除以目录窗口算——
后者会把「配置的模型」的窗口套到「实际回答的模型」的 token 上。
**环形图只有 used/free 两段、不按角色分色**（pi-app 有）：pi-app 的角色份额是字符除以 4 估的，
照抄会把实测总量与估算切分放进同一个环。全仓 274 files / 4210 tests 全绿。
证据见 [T38/U06-b evidence](../pi-backend-migration/evidence/2026-09-05-t38-runtime-usage-fields.md)。

**再早一些**：2026-09-05 **U20** `user_configured` 权限档明示降级
（[D10](./decisions/010-user-configured-gate-explicit-degradation.md)）——原 Active TODO 第 3 项已关闭。
用户自己的 agentDir 声明了同一个权限插件时我们不注入随包副本（红线），
`authorizerChain` 因此缺席、档位环永不被咨询，**而界面照常显示四档**。
把 `permissionGate` 从 bootstrap 应答经 `session.created` / `session.resumed` 送到渲染层，
降级态下标签改「你自己的策略」、菜单换成两行说明。
**用户拍板只说降级、不教修法**，补救办法只留在 D10。
**更正旧记录**：不是「四档等同务实」，是等同用户自己的策略——本机那份 `yoloMode: true`，
比任何一档都宽。证据见 [U20 evidence](./evidence/2026-09-05-user-configured-gate-degradation.md)。

**同一批**：2026-09-05 **U17 + U18 + U19**（三件用户报障）：
① `chat:resumeSession` 的 `worker.bootstrap timed out after 10000ms`——bootstrap 套用了
给暖 RPC 的 10s 预算，冷启动的全部一次性成本都在里面，改为单开 60s；
**这条按代码路径判定，原始现场未复现**。
② 思考强度选 Minimal 打回 `502 ... level "minimal" not supported`——本仓对无
`thinkingLevelMap` 的模型把七档全给，比 pi 自己的规则还松；用户拍板改为
「没声明就只给 low/medium/high」，四个极端档必须点名。
③ 关中栏 Tab 改为**结束对话**（[D09](./decisions/009-tab-close-ends-conversation.md)）：
确认框 + 断开运行时 + 复位渲染层四处会话状态，左栏那一行保留。
证据见 [批次 9 evidence](./evidence/2026-09-05-startup-timeout-thinking-levels-tab-close.md)。

**上一批**：2026-09-05 **U15 + U16** VSCode 式壳层重排与上下文页图形化
（[D08](./decisions/008-vscode-dock-shell.md)，基准 `docs/design/a11-vscode-shell-prototype.html`）。
左栏成为 `44px 图标轨道 + 面板` 的导航容器（聊天 / Git / 文件 / 上下文 / 运行），
右栏只剩文件与编辑器（展开覆盖跟着文件走），中栏一个已启动会话一个横向 Tab，
`shellColumnMode` 与「上下文面板」开关整组删除，store v2 → v3。
上下文页加环形 + 堆叠条构成图，「对话构成」默认折叠且展开后限 20 条。
**原型迭代了三轮，前两轮被用户推翻**（顶部标签放不下 5 个中文 Tab；带文字的轨道「不行好丑」），
最终形态是原版 VSCode 纯图标轨道 + 面板标题行。
**明示代价**：fullscreen diff 会一并藏掉会话 Tab 条与 GUI/TUI 开关（可恢复，非死路）；
上下文环形图画的是**角色构成**不是「窗口占用率」——真实 token 占用仍等 T38。
证据见 [U15/U16 evidence](./evidence/2026-09-05-u15-u16-vscode-dock-shell.md)。

**再上一批**：2026-09-04 **U14** 壳层横条重排与双栏收敛（[D07](./decisions/007-two-column-is-two-columns-and-one-bar-per-column.md)）。
用户看到实际界面后指出三处 chrome「臃肿不协调」，并以原型
`docs/design/a10-pix-ui-alignment-prototype.html` 为准。取证给出的答案分三层：
原型在本计划里的登记身份就是「非施工依据」；壳层结构不在 D01 的样式授权也不在 Q11 的尺寸里，无人认领；
**而原型 CSS 写的是双栏隐藏右栏，D02 决定一写的是双栏仍留 context 右栏，代码跟了 D02**——
这就是「双栏渲染出三列」的成因。D07 以原型为准推翻 D02 决定一与 D05。
落地后：中栏横条 3 层 104px → 2 层 68px，`MainHeader` 按钮 7 → 3，顶栏 5 件 → 3 件，
双栏真的只有两列，surface 切换器从顶栏的四个无标签图标改回右栏自己的文字 tab 条。
**明示代价**：U06-a / U07 在双栏下不可达，`Ctrl/Cmd+1..4` 与 `Ctrl/Cmd+J` 在双栏下失效。
证据见 [U14 evidence](./evidence/2026-09-04-u14-shell-chrome-realignment.md)。

**上一批**：2026-09-04 批次 7 —— **U04** 左栏插件入口。
开工前取证推翻了这一片的形状：「MCP 就绪数」在 pix 里不是 MCP API，而是扫描扩展自己用
`ui.setStatus` 发布的状态文本抠 `N/M`（本仓 T09 已经在存这份 statuses，纯渲染层）；
而「已装插件」本仓**没有数据源**。用户拍板走 [D06](./decisions/006-plugin-inventory-source.md)：
worker 上报「这个会话实际加载了什么」（它为校验权限插件本来就调用了 `getExtensions()`），
不在 Main 重实现 pi 的解析。入口是底栏 Settings 旁的 chrome 按钮 + 对话框，不是 pix 的一级导航；
`null`（没人报告过）与 `[]`（报告了、一个都没加载）在 UI 上是两句不同的话。
插件**只可见、不可管**。证据见 [U04 evidence](./evidence/2026-09-04-u04-plugin-entry.md)。

**再上一批**：2026-09-04 批次 5.5 + 批次 6 ——
**U13**：免绑定会话重启后不再从侧栏消失（索引行加可选 `unbound` 标记，侧栏合成「临时对话」分组）。
比 [D04](./decisions/004-unbound-session-index-visibility.md) 多两处落点，都在「看得见」与「打得开」之间：
重启后必须认领索引里记着的 scratch 目录（否则 resume 撞 workspace 不匹配），
以及把该路径带在 `ChatSession.unbound` 上供 resume 使用。
**U06-a**：新 `run` 面板（状态/模型/思考档/耗时/工具），状态映射是全映射 `Record`，
占用与 usage 一个字段都没建（等 T38；已于 2026-09-05 由 U06-b 补齐），双栏下可见（[D05](./decisions/005-two-column-run-surface.md)，**已被 D07 撤销：双栏现无右列**）。
**U07**：Context 面板加「对话构成（已加载）」——分角色字符占比 + 逐段展开；
token 估算与手动刷新刻意不做，理由在 evidence 里。
证据见 [U13 evidence](./evidence/2026-09-04-u13-unbound-session-visibility.md) 与
[批次 6 evidence](./evidence/2026-09-04-u06a-u07-run-and-context-panels.md)。

**更早**：2026-09-04 U12 rev.2 —— 用户报「hands-off / full access 都还在弹权限」，
裁决日志证明档位本身没坏：撞的是 `external_directory`（工作区外写入）这道门，
而上游 envelope 把我们链在该面上的 `allow` 一律降级为 `defer`，连 full access 也免不掉。
按拍板**只为 full access** 解除该降级（分发者补丁只豁免 `aiclient-session-tier` 一个名字，deny 规则不受影响），
并把 hands-off / full access 的档位文案改成点明工作区边界。同批下线顶栏终端按钮与 ``Ctrl/Cmd+` ``。
证据见 [U12 rev.2 evidence](./evidence/2026-09-04-u12-rev2-cross-directory-and-terminal-rail.md)。

**Last Verified**：2026-09-06（U30 + U31）—— 全仓 **280 files / 4246 tests pass**；
`tsc --noEmit` pass；`biome check src/` 干净；`git diff --check` 干净。
真机：进选择模式 → 顶栏「已选 0 项」→ 点一行 → 「已选 1 项」+ 复选框勾上，无渲染层异常。
同日稍早（U29）—— 全仓 **278 files / 4230 tests pass**；
`tsc --noEmit` pass；`biome check src/` 干净；`git diff --check` 干净。
变异验证：把两个槽位改回 `activeSessionId ? … : null` 并撤掉 spawn 的默认档回退后两条判红，
恢复后 11 条全绿。真机前后对照见 U29 evidence 第八节。
同日稍早（U28）—— 全仓 **278 files / 4228 tests pass**；
`tsc --noEmit` pass；`biome check src/` 干净；`git diff --check` 干净。
变异验证：回退「发送时建会话」「`hasSendTarget` 放宽」「空态不再判故障」三处后四条断言判红，
恢复后 34 条全绿。
同日稍早（U25 + U26 + U27）—— 全仓 **278 files / 4227 tests pass**；
`tsc --noEmit` pass；`biome check src/` 干净；`git diff --check` 干净。
变异验证：回退 U26 的两处与 U27 的占位后两条断言各自判红，恢复后 5 条全绿；
U25 的漂移守卫按构造即是变异验证（直接比对 Main 与渲染层两侧数值）。
同日稍早：U24 276 files / 4219 tests；U22+U23 275 files / 4210 tests，变异验证均判红后恢复。
**下方是上一次验证（2026-09-05 批次 9 收尾，含 U20），结论仍然有效** —— 全仓 **271 files / 4162 tests pass**；
`tsc --noEmit` pass；`biome check src/` 干净；`git diff --check` 干净。
批次 9 的真机验证：思考强度下拉只剩 `Default / Low / Medium / High`（持久化的 `Minimal`
被 reconcile 成 Default）；关 Tab 弹确认框，确认后 Tab 消失、左栏 78 行不变、
store 里该会话 `status: disconnected` / `hostBound: false` / `messages: 0`、
打开时新起的两个 worker 进程在 8s 内消失。
U20 用 `AICLIENT_DEV_ENV_FILE` 指向用户自己的 agentDir 真复现了 `user_configured`：
store 记 `user_configured`、标签「你自己的策略」、菜单只剩两行说明；
对照组指向干净目录时报 `bundled`、四档照常。
**上一批 U15/U16 的六个看点也仍然有效**，全部在真实 app 里跑通并留图
（[shots](./evidence/2026-09-05-u15-shots/)）。
（U15/U16 那次测试总数比 U14 少 24 条：删掉的是两/三栏模式与已删组件的断言，不是覆盖率倒退——
逐条改写理由见 [U15/U16 evidence](./evidence/2026-09-05-u15-u16-vscode-dock-shell.md) 第五节。）
上一批（U12 rev.2）的真回合验证结论仍然有效：
真回合验证（`spikes/u12-tier-turn-probe.ts`，真模型，写工作区外文件）：
`fullopen` 0 次对话框且由 `aiclient-session-tier` 裁决，`handsoff` 仍弹 1 次跨目录确认。

## Active TODO

> 上限五项（root registry 的维护规则）。六件「待真机验证」合并为一项——它们的性质相同：
> 自动化已绿，缺的是一次真实 pi CLI / 真账号 / 真扩展 / 真慢冷启动的手动跑。

1. **批次 13/14 累计 GUI 点验（当前唯一的主动任务）** — 七片自动化全绿，缺一次真窗口确认：
   ⓪ **U28 剩下的那半**：起始屏形态、能打字、两种副文案都已由 CDP 探针实测
   （见 evidence 第七节，截图在 `2026-09-06-u28-shots/`）；**没验的是真的发出去一回合**
   ——按下发送后会话被创建、消息到达 runtime，需要真账号真模型；
   ① U22 全新状态下点 `+ New` 或「直接开聊」后输入框可用、发得出去；
   ② U23 点开已有会话后插件对话框列出实际加载的插件，不再是「发送一条消息…」；
   ③ U24 中栏无 Tab 条、点左栏直接切换、空心环出现在已启动但非前台的会话上、
   右键有「结束对话」、开满 10 个后第 11 个弹出后台提示；
   ④ U26 TUI 下点文件编辑器与终端并排，关掉最后一个标签终端收回整行；
   ⑤ U27 左栏第一个图标与面板标题行下方内容齐平；
   ⑥ U25 窗口拖到最窄时编辑器工具条右端按钮仍完整可见可点。
2. **批次 13/14 的五笔欠账**（性质各异，合并计一项以守住五项上限）——
   **U30/U31**：三条 chrome 改动只有静态断言，抖动是否「看着还动」要肉眼；
   批量归档没点确认（那会真改本机索引）；选择模式没有「全选」。
   **U29**：没验「改完默认再发送，新会话真的用了它」——自动化锁住了 spawn 读取的那条串，
   真机只验到控件可见可点；另外模型菜单的 scope 文案仍是给有会话的场景写的
   （权限档那个 tooltip 已说明「作用于新建的对话」）。
   **U24**：① 10 个 worker 同时在跑时的真机内存占用未实测；
   ② 空闲超时（15 分钟）仍不提示，D12 明确不动它，留作 open question。
   **U25**：③ 原始现场从未复现，1244px 只有算术保证；
   ④ `minWidth` 变大对 1280×800 一类小屏的代价未评估，退路是让左栏先被压缩、
   再把地板降到收起态的 964px。
3. **待真机验证（六件）** —
   ⓪ **U17 的 bootstrap 超时** 原始现场（`worker.bootstrap timed out after 10000ms`）本轮未复现，
   修改按代码路径判定、由单测锁住 60s 预算；下次真遇到冷启动慢时确认它不再中断 resume；
   ⓪′ **U18 的极端档** 反过来的一半没测：真给某模型声明 `thinkingLevelMap: { minimal: 'minimal' }`
   之后下拉是否真的多出 Minimal 且能打通——目前只有单测；
   ① **U08-2** `off` 走到真实供应商的实际效果未跑（类型链已逐段核实，不等于每家服务端都认）；
   ② **TUI↔GUI 历史分叉** 已按 pix `leaveTerminalMode()` 修完（`worker.reload` 重载原语 + `chat:reloadSession`，
   离开终端 suspend → 重载 → 揭开；回合进行中拒绝进 TUI），三条变异验证已过，但用户原始复现路径没用真实 pi CLI 跑过
   （老会话不补救，内容在旁支，用会话树自取；见
   [该缺陷记录](./evidence/2026-09-04-host-status-false-stop-and-tui-history-bug.md) 第三、四节）；
   ③ **U13 跨重启** 「聊天 → 退出 → 重开 → 点开」未在真机走过（索引读写、目录认领、resume 参数均有单测）；
   ④ **U04 的 MCP 徽标** 解析逻辑与 pix 同源，但本仓没有可跑通的 MCP 扩展，只有单测覆盖、没有真机样本。
4. **发布前需 `pnpm build:agent-host`** — `out-agent-host/` 里的插件副本与 `config.json` 停留在 09-02，
   连 `authorizerChain` 都没有；dev 不受影响，打包必须重建。


> 两项已出列：`user_configured` 权限档恢复功能于 2026-09-05 拍板不做
> （[D10 决定三](./decisions/010-user-configured-gate-explicit-degradation.md)）；
> U15 遗留的「fullscreen diff 藏掉 Tab 条」随 [D12](./decisions/012-single-session-view-and-background-concurrency.md)
> 删掉 Tab 条一并消失，同条的「多会话并发资源表现」并入 U24。

## Blocked By

无。~~U06-b 等 Pi 计划 T38-a/b~~ — T38 已于 2026-09-05 关闭，U06-b 同批落地。

## Handoff

1. 动手前读 [execution-plan](./topics/execution-plan.md)，它有批次顺序、逐片验收和门禁。
2. 每片按 [baseline gates](../../baseline/test-and-release-gates.md) 串行验证：相关 Vitest（`--maxWorkers=1
   --no-file-parallelism`）→ typecheck → biome → `git diff --check`。不并行、不整套跑。
3. **U01 已确立的两条边界**，后续切片不要推翻：
   - 颜色只能改 OKLCH 的 L 分量，色相与彩度不动（改动前后的对比度必须实测，不能推断）。
   - evidence-u01（数值档）与 evidence-u09（组件形态）冲突时**以 U09 为准**，这是
     [D03](./decisions/003-sidebar-density-and-runtime-field-ownership.md) 决定一确立的先例，
     已在侧栏行高与 Composer 内距上各用过一次。
4. 布局尺寸（栏宽类）不在 D01 授权范围内，动之前先过 Q11。
