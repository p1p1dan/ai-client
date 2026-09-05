# Implementation Status — pix/pi-app UI 对齐改造

**Current Phase**：**U06-b / U21 已落地，外部阻塞清零**。壳层仍按
[D08](./decisions/008-vscode-dock-shell.md) 的 VSCode 式三栏。
剩下的只有一次累计 GUI 点验与用户降优先级的 U10/U11。

**Next Target**：**一次性 CDP GUI 点验**——用户 2026-09-04 明确「最后一起点验」，
所以逐批点验一直后置到现在。批次 8 把点验清单整个换掉了（U14 那五条描述的 chrome 已被 D08 删除），
新看点见 [roadmap U15/U16](./roadmap.md)。

**Last Landed**：2026-09-05 **U21** 下线实时 `↓` 输出 token 计数器
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

**Last Verified**：2026-09-05（批次 9 收尾，含 U20）—— 全仓 **271 files / 4162 tests pass**；
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

1. **累计 GUI 点验（当前唯一的主动任务）** — U09 + U12 + U05/U03-b + U08-2 +
   U13 临时分组 + U06-a Run 面板 + U07 对话构成 + U04 插件入口 + **U15 壳层重排 + U16 上下文页**，
   一次 CDP 出图肉眼确认。U14 那五条看点作废（D08 删掉了它们描述的 chrome）。
   **U15/U16 的六个看点**：① 轨道五个图标能切换且选中态可辨；② 面板标题行说明当前区；
   ③ 点左栏会话在中栏新开 Tab、可多开、可关；④ 关 Tab 后会话仍在左栏列表里
   （[D09](./decisions/009-tab-close-ends-conversation.md) 后仍成立：变的是它在后台还活不活）；
   ⑤ 顶部再无双栏/三栏与「上下文面板」按钮；⑥ 打开文件才出现右栏，展开能盖住中栏。
   **U15/U16 这六条已在真机验证通过**（真实 app + 真实会话数据，
   截图存 [`evidence/2026-09-05-u15-shots/`](./evidence/2026-09-05-u15-shots/)）；
   起不来的那次是本机 `HTTP_PROXY` 导致的挂死，小写 `no_proxy` 一加就好，与本批次改动无关。
   **剩下要点验的是更早批次的项**（U09/U12/U05/U08-2/U13/U06-a/U07/U04），
   外加 **U06-b 的三个新看点**：① 一回合结束后 Run 面板出现占用环且中心百分比与图例三行自洽；
   ② Composer 底栏出现 `NN%` chip、hover 给绝对值；③ 跑一个有进度输出的工具时工具名下方出现状态行。
   再加 **U21 的一条反向看点**：跑一个长回合，状态行只有 `✽` 加计时，**没有第二个数字**
   （[D11](./decisions/011-retire-the-live-output-token-counter.md)）。
2. **待真机验证（六件）** —
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
3. ~~**`user_configured` 路线下权限档恢复功能**~~ — **已决定不做**（用户 2026-09-05 拍板，
   [D10 决定三](./decisions/010-user-configured-gate-explicit-degradation.md)）。
   用户自己装了权限插件，就让他自己去 pi TUI 设置里改自己的策略。
   「始终注入随包副本」与作为其前置的双插件加载语义探针**一并取消**，不再是欠项。
   已落地的明示降级（[U20](./evidence/2026-09-05-user-configured-gate-degradation.md)）保留。
4. **发布前需 `pnpm build:agent-host`** — `out-agent-host/` 里的插件副本与 `config.json` 停留在 09-02，
   连 `authorizerChain` 都没有；dev 不受影响，打包必须重建。
5. **U15 的两处未验证行为** — ① fullscreen diff 藏掉会话 Tab 条是否可接受（备选方案已写在
   evidence 第六节 §2）；② 多会话并发的真机资源表现未测（Tab 只是打开态，
   worker 并发上限仍由 `WorkerManager` 的 bounded pool 决定，本批次没碰）。

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
