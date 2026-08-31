# Implementation Status — Pi Backend Migration

**Last Verified**：2026-08-31（Cycle 2）· 主仓与 Agent Host typecheck 均 0；Biome
`src` + `scripts` **1094 文件 · 0 error / 0 warning**；`git diff --check` 通过。Cycle 2
scoped 主批 **16 files / 260 tests** 全绿，追加 store/bus **28 tests** 与最终复跑 **16 tests**
全绿。真机 dev + CDP：`dialogs=0`、内联审批/后台徽标/status/widget/TUI-only 提示均可见；
模型菜单有搜索与“其他模型”子菜单。截图与逐项证据见
[Cycle 2 执行](../../evidence/2026-08-31-cycle2-execution.md)。本批涉及 Agent Host 协议但不改
打包依赖/过滤，故按资源红线不重跑 Agent Host build 或完整 Electron production build。

**上一次完整核对（2026-08-29，T12 后）**：完整 vitest **269 files / 5395 tests** 全绿（T08-c 切片 2 后为 269/5397，净 −2 是 FB3 三例退役换 T12 两例，见 T12 证据档 §3）；typecheck（主仓）全绿；Biome `src` + `scripts` **0 error / 0 warning**；`build:agent-host` 成功（394.3MB）；打包产物权限闸 smoke 通过（`smoke:permission-plugin` → `PERMISSION GATE INTACT`）。完整 Electron build 因当前 VM 仅 3.3 GiB、脚本固定 4 GiB heap 出现内存压力，沿用既有处置不重跑。`pnpm lint`（全仓）另有 1 个**既存**错误，来自未跟踪文件 `docs/plans/2026-08-27-entry-design/logo-concepts-preview.html`，与本仓代码无关。

## Current Phase

**D13 的 Cycle 1 与 Cycle 2 已完成。** Phase 1 Done；**Phase 2 Done**；Phase 3 下一步为
T13 history reader / 真实 resume / session tree / rewind / fork；Phase 4 等 T16～T18；
Phase 5 主链与 T25 均 Done。完整周期见
[topics/completion-cycles.md](topics/completion-cycles.md)。

- **Cycle 2 Done（2026-08-31）**：T08-b 内联审批、T10 能力分层/runtime reset/Main 路由、
  T09 notify/status/widget、T17 第一切片与 T25 标签模型菜单/模型级 effort 全部落地。
  后台审批按 session 隔离并有侧栏徽标；窗口级 Extension UI modal 已清零。证据见
  [Cycle 2 执行](../../evidence/2026-08-31-cycle2-execution.md)。
- **T08-c/Q10 已在 Cycle 1 Done**：固定版本 patch 把 bundled policy 接入真实 ruleset，
  `.pilab` 改 ask、activity surface 订正且产物 smoke 通过。“我的设置未创建”继续是预期空态，
  不自动创建空文件。证据见 [Cycle 1 执行](../../evidence/2026-08-30-cycle1-execution.md)。
- **T12 真实回合验证通过**：用户确认正文顺序、思考时间、流式代码块、底部锚点、悬停条、
  被拒工具与长回合均正常。连续 read 未出现 `Explored 2 files` 仅留低优先级复验，不把
  T12-d 整体降级。
- **近期反馈批已落地**：T12-e′ 无仓库隐藏输入区、T24 pending/权威 echo、T26 主动发送
  滚底、T13 Rename + Archive 确认菜单、T27 仓库移除与迟到事件清理均 Done。提交、复核与
  验证见 [紧急稳定化 M1/M2/M3](../../evidence/2026-08-30-urgent-stabilization-m1-m3.md)。
- **D13 完成全量重排**：T14/T15 代码主体已存在，归 Cycle 1 补验关闭；T08-b、T10→T09→T17
  与 T25 归 Cycle 2；T13 历史/真实 resume/fork/rewind 归 Cycle 3；T16～T18 归 Cycle 4；
  Cycle 5 统一 RC 与上线实测。Q11 已关闭，标签取首标签单归属，effort 复用
  `reasoning` / `thinkingLevelMap`。
- 同日 **T12-a 已 Done，但结论与原计划相反**（[D12](../../decisions/012-timeline-data-model.md)）：
  评估后**不移植** pi-app 的 display-items —— 缺陷不在渲染建模层，在 `piRuntime` 把
  一整轮 pi 运行塞进一条消息一个正文块，导致多步回合里第二段正文被粘在第一段后面、
  且排在它其实晚于的工具行前面。修上游后既有三层模型输出的顺序就是对的。
  证据见 [t12a-message-boundaries.md](../../evidence/t12a-message-boundaries.md)。
- 同日 **T12-b 切片 1 Done，与 T12-a 同族**：pi 的内置工具名是小写的，`toolCard.ts`
  四张表全是 Claude 的大写名，一个都不重合 ⇒ 探针实测七个内置工具**全部**渲染成
  `Ran`、全归 action（**工具聚合在 pi 上从没触发过**）、grep 显示路径而不是 pattern。
  已补 `PI_TOOL_NAMES` 单一来源与四处查表。**同日切片 2 亦已 Done**：`edit`/`write`
  展开后从两坨转义 JSON 换成真 diff（自写 LCS，从**参数**推导所以运行中与被拒的调用
  同样能看），范围按评估从三层改成两层（pi-app 的声明模板层建立在它的
  extension-compat 适配器层上，那是本 plan 的非目标）。真机两图。证据见
  [t12b-pi-tool-vocabulary.md](../../evidence/t12b-pi-tool-vocabulary.md)。
- **T12-c 已 Done（2026-08-30）—— 第三处同族静默失效**：`piRuntime` 里
  `thinking.completed` 出现 **0 次**，而时长是用 `completed − started` 算的 ⇒ pi 上
  每一次思考都渲染成光秃秃的 `Thought`，从没显示过时长。pi 没有「思考结束」事件，
  边界得由 Host 自己定（取「开始作答」与「消息结束」两个，必须幂等否则 7 秒会被报成
  60 秒）。markdown 分段的结论**经用户追问后订正过**，这里记订正后的版本：
  未闭合 fence 不是错误（CommonMark 在文档末尾自动闭合，实测拿到的是一个完整合法、
  高亮正常、只是短一点的代码块），所以真实取舍是「早出但会重排」vs「晚出但稳定」，
  不是对方有缺陷。**同日用户拍板「可以按照 pi-app 的来」，行为已改**：
  `ClosedPrefixSplit` 新增 `openFence`，尾巴里尚未闭合的代码块交给 `<ChatMarkdown>`,
  但没有照抄它的机制（那会撤掉实测过的 39× 优化）。证据见
  [t12c-thinking-and-markdown.md](../../evidence/t12c-thinking-and-markdown.md)。
- **T12-d 已 Done（2026-08-30）—— 原定四件事，核过之后只有两件成立**：
  **展开记忆**（真缺口，而且是 T12-b 制造出来的新可达路径：工具聚合在 pi 上从没触发过，
  修好工具名词汇表之后，「用户打开一行看输出 → agent 再读一个文件 → 两行折成一个收起的
  `Explored 2 files`、正在读的输出从屏幕上消失」这条路才第一次出现）；
  **底部锚点**（真缺口：两个终端早有「滚到底部」圆钮，聊天时间线一颗没有）。
  **跟随滚动不动** —— 我们的 `nextFollowState` 已经在做，且比参照实现多回答了
  「内容缩短、浏览器把 `scrollTop` 夹到底部并抛 `scroll`」那一帧（F10 放大器的一半）。
  **问卷不做** —— pi-app 的问卷挂在它的逐扩展适配器层上（本 plan 非目标第 2 条），
  而 pi 真正的提问通路是 Extension UI，也就是 T08 已完成的四原语；
  `piRuntime.ts` 全文 **0 次**发过 `question` 事件，本仓那套 `QuestionCard` 在 pi 上够不着。
  证据见 [t12d-expand-memory-and-bottom-anchor.md](../../evidence/t12d-expand-memory-and-bottom-anchor.md)。

## Latest Field Test — 2026-08-31

- **Cycle 2 真机 renderer 通过**：审批卡在聊天列内显示、零 modal/focus trap；活动/后台两会话
  各自徽标；status/widget/unsupported 同屏可见；模型 trigger 打开后有搜索与分组子菜单。
- **既有真实工具链证据保持**：read/edit/bash 的 allow/session allow/deny 与 activity 轨迹已在
  2026-08-30 真机通过；本批未改 Host answer 协议，新增形态由 store/bridge 测试与 live renderer
  点验覆盖。
- **截图**：见 [Cycle 2 screenshots](../../evidence/cycle2-screenshots)。
- **仍待环境验收**仅属于 Cycle 1：真账号 queue GUI 复点与高资源主机 packaged preview smoke。

## Last Landed

**2026-08-31 Cycle 2**：T08-b/T09/T10/T17 第一切片/T25 全部落地。窗口级审批 modal
退役为 session-local 内联 dock；新增后台审批徽标；Extension UI 能力表、runtime reset、Main
fire-and-forget 路由修复与 renderer display store；notify/status/widget 限额展示；TUI-only 非阻断
提示；模型 tags/capability 从 models.json 贯穿到 Base UI 分组/搜索菜单，非法 effort 同步降级。
自动门禁与真机 CDP 证据见 [Cycle 2 执行](../../evidence/2026-08-31-cycle2-execution.md)。

**2026-08-30 紧急稳定化 M1/M2/M3**：空仓库/仓库移除闭环、pending 发送反馈与显式滚底、
会话 Rename + Archive 右键菜单全部落地。实现提交为 `8bd7f86b`、`8e93c04b`、
`ace66886`、`73ef8800`、`17623597`、`dcf4b823`、`afc66ae5`；两轮对抗复核发现的跨仓库重绑、迟到
事件复活、echo 一对多、重复 echo 与 queue release 滚动问题均已收口。证据见
[evidence/2026-08-30-urgent-stabilization-m1-m3.md](../../evidence/2026-08-30-urgent-stabilization-m1-m3.md)。

**2026-08-30 悬停操作条改为预留高度 —— T12-b 一条设计决定被用户推翻**（T12-d 之后，同日）。

用户实机反馈：鼠标放到某条回复上、复制按钮出现时，**下面的内容被顶得上下跳**。

这正是 T12-b 明确选过的那一半。当时选 `grid-rows-[0fr] → [1fr]`（pi-app 的
animate-height-to-auto），理由写在注释里：折叠态必须是**真正的零高度**，否则每个回合
底下常驻一条 24px 空白，等于把删掉 meta 行省下的竖向预算又花回去。

那条理由本身没错 —— 它只是替用户权衡了一个用户不接受的代价。用户看到实机之后的判断是：
**在光标下面长出一行、把下面的字整片顶下去，比 24px 的永久空白更难受**。

改法：`turnActionsSlotClass()` 去掉 grid 与高度动画，只留透明度过渡；
`turnActionsInnerClass()` **必须**带确定高度 `h-6`（与复制按钮的 `size-6` 同一档），
并去掉只为 `0fr` 轨道服务的 `min-h-0` / `overflow-hidden`。这把 T12-b「此行不许有任何
高度类」那颗钉子**整条反转** —— 两个版本对各自的机制都成立，所以断言改写的是立论
而不是放宽，旧版为什么会失效仍然留在注释里。

**没有加 `pointer-events-none`**：指针要落到透明条上必须先进入这个回合，而进入回合
正是让它显形的条件，「透明且可点」这个状态到不了，加了是空转。

真机对照：新机制 idle / hover / 离开三次 `turnTops` 读数完全相同、条高恒定 24px；
把旧 grid 装回去做对照，折叠 `[0,0,0,0]`、强制展开 `[24,24,24,24]` ⇒ 每次悬停推低 24px。
变异 5 发全咬红。⚠️ **未改**：键盘 Tab 到复制按钮仍不显形，那是 F-B15 反转留下的既有代价。

**2026-08-30 T12-d —— 展开记忆 + 底部锚点；跟随滚动与问卷经评估未做**。

T12-d 的四件事逐条核过，只有两件成立。

**① 展开记忆。** 工具行的开合原本完全活在 `Collapsible` 实例里，组件一卸载就没了。
扎人的不是「切会话」，是**聚合把这一行吞掉**。探针实测一个回合两次连续 `read`：

```
一次 read 完成    -> [ block-a      "Read a.ts"        ]
两次都完成        -> [ block-a~agg  "Explored 2 files" ]   ← 用户打开的那一行，顶层没了
```

于是「我正在读一个文件的输出，agent 又读了下一个，我在看的东西就消失了」。
**这条路 T12-b 之前不可达**：`classifyTool` 对 pi 的小写工具名全 miss，聚合从没触发过。
修好词汇表，也就把这个形状放了出来。

**只记住那一行不够** —— 它会展开在一个收起的容器里面，照样看不见。所以
`resolveToolRowOpen` 有第二条规则：`detail` 里有被记住展开的孩子，本行也展开；
而行自身的显式选择永远压过它，否则聚合永远关不上。

**取种子、不受控**，这一条是为了不打破 T-34：实时子代理面板的 `defaultOpen: true`
会在通道不再 live 的那一刻消失，一个绑在同一表达式上的受控 `open`
会**在读者读到一半时把面板拍上**。而聚合吞行本来就是一次新挂载，取种子让那个场景
免费成立。`readToolExpandMemory` 是**不订阅**的读：订阅会让每次开合重渲染时间线里
所有工具行，而屏幕上什么都不会因此改变。

**刻意没取** pi-app 的「自动展开运行中回合的最后 N 个工具」——
它会反转 2026-08-25 记在 `ToolRows.tsx` 里的用户决定。

**② 底部锚点。** 两个终端早就各有一颗「滚到底部」的圆钮，聊天时间线一颗都没有。
**两个阈值不是一个**：40px 答「还在跟随吗」（必须紧，否则有意的上滑会被顶回去），
140px 答「下面藏的内容值不值一颗按钮」（用紧的答案会让 41px 的滑动画出一颗按钮）。
中间是一条**真实的死区**，已写成断言，防止后人把两个常量「简化」成一个。
可见性**取几何、不取跟随标志**：`nextFollowState` 会在视口就在底部时报「没在跟随」
（规则 2），绑它就会在用户正看着底部时画出「跳到底部」。位置挂在**滚动容器外面**的
wrapper —— 视口内的 absolute 会随内容滚走，sticky 是 F10 之后明令禁止的形状。
`F-B15` 的悬停反转**不适用**：那条反转的理由是「动作在别处也有」，
而这颗按钮是回到运行中回合的唯一入口。

**③ 跟随滚动不动，④ 问卷不做**，理由见上一节与证据档。

⚠️ **一发变异首轮存活，形状值得记**：`sessionId` 的四跳原本用「文件里至少出现 4 次」
来钉。删掉 `ChatTurn` 那一跳之后**还剩 4 个**（`HistoryErrorNotice` 自己也带一个），
计数照样满足，而链条第一环已经断了。改成**逐跳断言**后四发全红。

真机 CDP 十一图（亮/暗）+ 逐项实测数字见
[t12d-expand-memory-and-bottom-anchor.md](../../evidence/t12d-expand-memory-and-bottom-anchor.md)。
四门：typecheck 0 · biome 1058 文件 0/0 · **vitest 277 文件 5494 例** · 变异 15 发 14 首轮红。

**2026-08-29 T12-b —— meta 行退役，换成悬停操作条**（同日，T12-a 之后）。
用户看图后拍板「跟随 pi-app 删掉 meta」，复制按钮的放置给了三选一，用户选
**「完全照抄 pi-app」**。于是 `Worked for 12s · 2 tools`、模型名、相对时间**全部丢掉**，
复制与 `HH:MM` 进一条**悬停才出现**的操作条。

**先核过 pi-app 到底丢了什么**（逐项读源码，非推测）：复制和时间戳它**留着**，只是挪进
悬停条；思考时长挪到思考块写成 `Thought for Xs`；模型名挪到输入框常驻；**回合总时长和
工具数是真的不显示** —— 实证是它 `timeline-turn-timing.ts` 里算这个数的两个函数还在，
但全仓零调用方，是删 footer 之后留下的死代码。

**`F-B15` 红线经用户知情后明确反转**：原规则是「复制按钮永远不能悬停才出现，因为键盘和
触屏够不到」。代价已如实告知并被接受，所以红线**反转而不是悄悄放宽**，代价写进
`turnActionsSlotClass()` 头注。保留下来的那半条写成断言：**遮蔽只能在容器上，绝不能在
按钮自己身上** —— 按钮若也带 `opacity-0`，就成了「两件事都得同意才点得动」。

**进行中的状态行保留**。它跟 meta 行只是**碰巧共用一个槽**：`Awaiting first token 8s` /
`Stalled` / `Failed` 是唯一说明「还在跑」的东西，F2 的「秒表丢了」缺陷就是这行在还没跑完时
消失。现在跑完什么都不显示，跑的时候照旧。连带退役 `deriveTurnHeadModel` 的四个降级档 ——
它们回答的都是「没量到时长的已完成回合该说点什么」，而现在的答案是「什么都不说」。

⚠️ **GUI 抓到一个断言抓不到的缺陷**：折叠态操作条实测 **28px 而不是 0**，
也就是「收起来了但照样占位置」，正好把删 meta 行省下的竖向预算又花回去。
根因是 `h-7` 从 pi-app 原样抄来，而 grid item 一旦有确定高度就压不扁。
**三个类一个不缺、每条单看都对、断言全绿** —— 失效在类与类的相互作用里。
已修（行高改由 24px 按钮决定）并补了「此行不许有任何高度类」的钉子，把 `h-7` 加回去立刻咬红。

四门：typecheck 0 · biome 1045 文件 0/0 · **vitest 269 文件 5381 例** · 变异 8/8 咬红。
真机 CDP 实测：折叠两条均 `height:0`；真悬停第二个回合后**只有第二条**打开（24px），
证明 `group/turn` 的按回合作用域成立。

**2026-08-29 T12-a —— 时间线外壳与气泡视觉基线**（Phase 3 起手）。
提问气泡取 pi-app 形状（右对齐 · 80% 上限 · 切角从右下换到**右上** ·
`12px 4px 12px 12px` · **不再六行截断**），模型回复**去掉每段一个的边框盒**，
钉住提问的 `sticky` 吸顶条整条退役。

**这三件本来就是一条因果链，只有第一环是当初真想要的**：吸顶条会跟贴底滚动打架
（收起→变矮→`scrollTop` 被夹回→又展开，逐帧震荡），所以 F10 加了无条件截断；
截断藏掉了正文，所以 FB3 加了恒显的 `Show more`。去掉吸顶条，后两件失去存在理由。
反向纪律已写成断言：任何回合级 class 函数长出 `sticky`/`fixed`/`z-*` 即红 ——
单独把吸顶条加回来会原样复现 F10 的震荡。

角色区分改由**不对称**承担：用户侧是个物件（有形状、有面、有切角），模型侧根本不是物件
（占满阅读宽度、无面、无边）。给模型侧「为了一致」加个环，会从另一头到达 D3-b 反对的
「什么都是卡片」。

改动文件：`chatTimelineLayout.ts`（退役两个 class 函数 + 新增两个 + 节奏算术重组）·
`MessageTimeline.tsx`（`UserBubble` 去 state/去按钮/去 title；吸顶条 wrapper 删除；
answer 分支去容器）· 三份测试逐条**改写立论**（不是放宽）。
证据与四张截图见 [t12-timeline-shell-baseline.md](../../evidence/t12-timeline-shell-baseline.md)。

⚠️ 截图里的时间线内容是**注入的合成 transcript**（走真渲染路径，但流式态没被覆盖）。
当时留给用户裁定的「meta 行保留还是删掉」已由同日 T12-b 结案：删掉。

**2026-08-29 T08-c 切片 2 —— 权限策略设置面**（同日，切片 1 之后）。
应用内第一次能读到权限闸的判断依据：按插件语义镜像三层合并（随包默认 < 受管/用户
agentDir < 项目 `.pi/`）并显示每条规则由哪一层决定，**只让受管 agentDir 那一层可编辑**
——本机路线下那一层就是用户自己的 `~/.pi`，写它等于改一个我们不拥有的工具（T08-a 红线），
所以直接抛错拒写而不是静默不做。危险选择（write/edit/bash 兜底/external_directory
兜底/mcp/skill/顶层 `*` 选“直接允许”）走二次确认；`yoloMode` 只显示不提供开关。

同批修掉两个静默缺陷：① **dev 下随包默认策略根本不生效**——插件目录按运行中 Host
入口解析，dev 是 `src/agent-host/`，而构建只写产物；回落到插件裸默认是安全的（什么都问），
所以症状只是弹窗变多，而「`cat .env` 被直接拒」这一半是静默缺失的，会让真机验收
在 dev 上得出错误结论。修法保留原意图（构建仍不碰 checkout），由 `node scripts/dev.js` 自己
显式写入。② 设置分类的联合类型与 localStorage 校验数组是**两份手写清单**，漏改一份
的症状是「新面板能打开、重启后再也打不开」；改为单一来源 + 静态扫描。

新增 `shared/piPermissionPolicy.ts`、`services/piPermissionPolicy/{index,policyStore}.ts`、
`ipc/piPermissions.ts`、`settings/{permissionPolicyView.ts,PermissionPolicySettings.tsx}`；
改动 `shared/types/ipc.ts`、`preload/index.ts`、`ipc/index.ts`、`settings/constants.ts`、
`SettingsContent.tsx`、`App/hooks/useSettingsState.ts`、`agent-host-build-lib.mjs`、
`scripts/dev.js`。证据见
[t08c-permission-settings-panel.md](../../evidence/t08c-permission-settings-panel.md)。

**2026-08-29 T08-c 切片 1 —— 默认权限策略与信任边界**（同日，审计修复批之后）。
Q9 四问拍板收口为 [D11](../../decisions/011-default-permission-policy.md)：务实档基线 ·
path deny 面 · external_directory 一律 ask · 项目配置按凭据模式分叉。策略随包写进
**产物内插件目录的 `config.json`**（插件的最低优先级层，用户配置永远压得过它，
且绝不写用户的 `~/.pi`）。新增 `permissionPolicy.mjs` / `permissionPolicy.d.mts` /
`piHostEnv.test.ts`，改动 `piRuntime.ts`（`projectTrusted()`）、
`shared/piModelConfig.ts`（`PI_PROJECT_TRUST_ENV`）、
`services/piModelConfig/index.ts`、`agent-host-build-lib.mjs`、
`build-agent-host.mjs`、`t08a-permission-plugin-smoke.ts`、
`shared/__tests__/defaultPaths.test.ts`（护栏白名单 + 强制点转移）。

**2026-08-29 Phase 2 审计修复批**（外部审计 13 项，逐条成立、逐条修复）。
最重的四条：权限插件不可用时改为 **fail-closed**（不建 session + `fatal: true`
的 `host.error`）；pi runtime 由**进程级单例改为每 session 一套**
（handle / 订阅 / abort / 投影 / Extension UI bridge）；**Stop 立即排空** pending
弹窗（abort 到不了卡在 `ui.select` 里的扩展）；Runtime Event 改走**强类型
`RuntimeEventDraft`**，`isError`/`errorMessage` 两处漂移修正并当场再抓出一处多余
字段。逐项根因与证据见
[evidence/phase2-audit-fixes.md](../../evidence/phase2-audit-fixes.md)。

新增/改写实现文件：`permissionPlugin.ts`（重写）、`piHostCommands.ts`（新）、
`permissionActivityRow.ts` + `PermissionActivityRows.tsx`（新）、
`extensionUiRouting.ts`（新）、`piRuntime.ts` / `piHost.ts` /
`extensionUiBridge.ts` / `extensionUi.ts` / `ExtensionUiDialog.tsx` /
`chatSessions.ts` / `toolCard.ts` / `MessageTimeline.tsx` /
`agent-host-build-lib.mjs` / `t08a-permission-plugin-smoke.ts` /
`.github/workflows/build.yml`。

**2026-08-28 Phase 2 落地**，五个提交（T07 → T11 → T08 → T08-a → T08-b）；主要实现文件：

- `src/shared/types/runtimeEvents.ts` + `src/shared/types/agentHost.ts`（契约）
- `src/agent-host/extensionUiBridge.ts`（移植自 pix）
- `src/agent-host/permissionPlugin.ts` + `src/agent-host/permissionActivity.ts`
- `src/agent-host/piRuntime.ts` + `src/agent-host/piHost.ts`（绑定与命令分发）
- `src/renderer/components/chat/ExtensionUiDialog.tsx` + `extensionUiModel.ts`
- `src/renderer/stores/extensionUi.ts`
- `scripts/agent-host-build-lib.mjs`（打包过滤特判）

## Active TODO

1. **参考实现回顾闸**：按 [reference-repositories](topics/reference-repositories.md) 对照 pi-app/pix 复审 Cycle 1/2，结论只分“等价 / 本仓更强 / 可简化 / 行为漂移”；仅后两类修复，禁止无收益重写。
2. **Cycle 3（正常 4～5 日）**：移植 pi-app history/incomplete/tree/fork 主体，适配本仓真实 resume → session tree → rewind → fork。
3. **Cycle 4（3～4 日）**：移植/适配 pix Pi TUI PTY、互斥、CLI 提取和打包链 → T17 切换动作 → T18 默认模式。
4. **Cycle 5（2 日）**：完整门禁、Agent Host/权限/打包 smoke、真机矩阵与内部上线实测。
5. **并行环境欠项（Cycle 1）**：真账号 queue GUI 复点 + 高资源主机/CI 的完整 renderer 与 packaged `local-file`/Monaco/PDF smoke；不阻塞参考审计和 Cycle 3。

## Blocked By

- **Cycle 1 仅剩环境验证**：当前主机只有约 3.3 GiB RAM，完整 renderer build 两次中断；按根目录 `AGENTS.md` 资源红线不再硬跑。需 CI/高资源主机执行完整 build/packaged smoke；真账号 queue GUI 复点也需要可交互应用会话。Q10 已关闭，不再阻塞 T08-c。
- **T13 history/resume** 是 Cycle 3 的关键路径；稳定 Pi `entryId` 映射未完成前不得做 rewind/fork UI。
- **T16 打包态 Pi CLI 路径**是 Cycle 4 的关键风险；首版不承诺无损接管 GUI 内存会话。
- Q11 已关闭；其余无外部产品决策阻塞。

## Handoff

- **下一轮入口（强制）**：先读 [参考仓库地图](topics/reference-repositories.md)，并直接打开 `/home/ai/code/pi-app` 与 `/home/ai/code/pix` 对应源码/测试；再读 [Cycle 2 证据](../../evidence/2026-08-31-cycle2-execution.md)、[完整周期](topics/completion-cycles.md) 与 [D13](../../decisions/013-completion-scope-and-product-semantics.md)。先做 Cycle 1/2 对照审计，再以 pi-app history/tree/fork 为主体进入 Cycle 3；不得从零重造。Cycle 1 环境验收继续并行。
- **空仓库闭环已落**：欢迎卡已提升到 `ChatWorkspace`；无 cwd 不挂载 Composer。空 tree
  会清 chatSessions 及相邻 session stores，并以 retirement tombstone 拒绝迟到事件。
- **pending 不是第二份 transcript**：`pendingUserMessages` 只作显示；attempt 与 wire
  user `message.started` 的确切 messageId 按 session FIFO 配对，权威 bucket 落地后删除。
- **滚底只认用户意图**：direct / retry / 明确 enqueue 会 jump；自动 queue release 不 jump。
- **F6 不要修**：“我的设置未创建”是设计空态，随包默认已显示生效；自动创建空文件会
  制造第二份无意义配置。该批真正的问题是 Q10 的 read/`.pilab` 命中偏差。
- **右键管理已落**：Base UI Context Menu 只提供 Rename + Archive；右键本身无副作用，
  Archive 必经确认。永久 Delete / fork / rewind 仍未实现。
- **权限内联卡怎么来的**：pi 扩展调 `ui.select` → `extensionUiBridge` 转成 `extensionUi.request` → Main 只把 blocking dialog 路由到会话 owner → renderer `useExtensionUiStore` → 当前会话 `ExtensionUiInlineDock`。后台会话只显示 SessionRow 徽标，切过去才挂卡；用户选择经 `chat:respondExtensionUi` 原路回去。
- **关掉卡片＝拒绝/无回答**：dismiss 只发 `ok:false` 不带 value，由 Host bridge 补打开请求时记下的 fallback（confirm 是 `false`，其余是 `undefined`）。渲染端从不自己挑这个值。
- **fire-and-forget 不进审批 FIFO**：notify/status/widget/unsupported 走 `useExtensionUiDisplayStore`；状态按 session+runtime 隔离。reload/dispose 的 `extensionUi.reset` 是清旧 runtime 的权威边界，不能退化成等某个 dialog cancellation 顺带清理。
- **权限插件在哪**：`src/agent-host/node_modules/@gotgenes/pi-permission-system`（pin 27.0.1），随 `build:agent-host` 进 `out-agent-host/node_modules/`。用户 `~/.pi/agent/settings.json` 里已自装同名包时不注入。
- **验证产物里的权限闸是否真的能用**：`pnpm smoke:permission-plugin`，期望
  `RESULT: PERMISSION GATE INTACT`。它查三件事：pi 载入扩展、扩展**注册了
  `tool_call` handler**（拦截点本身）、**用产物里的 WASM 真解析一条复合 bash
  命令**并要求两条命令都被枚举。顺带查随包许可证。CI 的 win/linux 两个 job 里
  也各有一步。
- **权限闸不成立时 Host 会拒绝开会话**：`PermissionGateUnavailableError` →
  `host.error{fatal:true}` + `session.failed`，不会「先跑起来再说」。
  想在测试里造这个状态用 `PiAgentRuntimeOptions.decidePermissionGate` 注入。
- **改打包过滤要注意**：walker 会先问包目录本身（`parts.length === 1`），只答文件路径会导致整个包被跳过——本轮 tree-sitter-bash 就这么漏过一次，单元断言全绿、真实构建才暴露。
- **默认权限策略在哪**：`src/agent-host/permissionPolicy.mjs`（单一来源，
  构建期写进 `out-agent-host/node_modules/@gotgenes/pi-permission-system/config.json`）。
  它是插件读的**最低优先级**层——用户自己 agentDir 里的配置整条压过它，我们从不写
  用户的 `~/.pi`。改策略只改这个文件；产物断言与 smoke 会挡住「一词之差变宽松」。
- **想知道现在的权限策略到底是什么**：设置 → 权限（`piPermissions` 分类）。
  它按插件语义合并三层并标出每条规则的来源。**只有受管 agentDir 那一层可写**；
  本机路线整个面板只读，`update`/`reset` 会抛错（写它等于改用户自己的 `pi` CLI）。
- **改这个面板要小心的一条**：合并语义是**镜像**插件的
  （`shared/piPermissionPolicy.ts`），不是调用它——插件的 `.ts` 在 `node_modules` 里，
  Node 拒绝类型剥离。两条必须一起动：最后匹配优先，以及 `{...base,...override}`
  会让**重述的规则保留原位置**。改了镜像而没改断言，面板会开始对「agent 能做什么」
  给出自信但错误的答案。
- **dev 下策略是否生效**：启动日志找 `[dev] permission policy: …`。
  没有这行 = 随包默认没写进 `src/agent-host/node_modules/...`，插件走它自己的裸默认
  （安全但更吵），此时验「`.env` 被直接拒」会得到错误结论。
- **项目级 `.pi/` 配置生不生效**：看 `AICLIENT_PI_TRUST_PROJECT_CONFIG`。
  受管/登录模式发 `'0'`（不生效），本机模式发 `'1'`（生效）。键缺失 = 老 Main 构建，
  按历史姿态 `true`；值不认识 = 落安全侧 `false`。注意这是 pi 自己的
  `projectTrusted`，`'0'` 连带让仓库的 `.pi/settings.json`（packages / 模型）也失效。
- **想用 CDP 给渲染层出图**（T12-d 踩到两个新坑，都不报错）：
  ① 用 `await import('/@fs/<绝对路径>/stores/chatSessions.ts')` 会拿到**另一份模块实例**，
  改它对界面毫无影响、也不抛错 —— 第一轮就是这样白跑的。正确说明符是渲染进程根下的
  `/stores/chatSessions.ts`，而且必须带 `/* @vite-ignore */`，否则 Vite 会静态改写它。
  分辨办法：live 实例的 `sessions.length` 跟侧栏里看到的一致，假实例只有 demo 默认值。
  ② `Runtime.evaluate` + `awaitPromise` 对 `(async () => { … })()` 会报
  `Promise was collected`；改成「发射后不管（`.then()` 里写状态）+ 另一次 evaluate 读结果」就稳。
- **工具行的展开状态在哪**：`stores/toolExpansion.ts`，按会话键、**只在内存里**。
  行的开合是挂载时取种子（`resolveToolRowOpen`）+ 用户 toggle 时写回，**不是受控**。
  改成受控会打破 T-34：子代理面板的 `defaultOpen` 在通道不再 live 时消失，
  受控绑定会当场把面板拍上。
- 本地管理端：`pnpm model-admin`，默认 `127.0.0.1:3210`（Phase 5）。
- 管理模式目录：`~/.pilab/<profile>/pi-agent`；本机模式继续读用户自己的 Pi 目录。
