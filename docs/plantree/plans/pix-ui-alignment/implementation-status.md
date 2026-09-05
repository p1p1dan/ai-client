# Implementation Status — pix/pi-app UI 对齐改造

**Current Phase**：**批次 8（U15 + U16）已落地**，壳层按 [D08](./decisions/008-vscode-dock-shell.md)
重排为 VSCode 式三栏。剩下的仍是一次累计 GUI 点验、外部阻塞的 U06-b（等 Pi 计划 T38）
与用户降优先级的 U10/U11。

**Next Target**：**一次性 CDP GUI 点验**——用户 2026-09-04 明确「最后一起点验」，
所以逐批点验一直后置到现在。批次 8 把点验清单整个换掉了（U14 那五条描述的 chrome 已被 D08 删除），
新看点见 [roadmap U15/U16](./roadmap.md)。

**Last Landed**：2026-09-05 **U15 + U16** VSCode 式壳层重排与上下文页图形化
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

**上一批**：2026-09-04 **U14** 壳层横条重排与双栏收敛（[D07](./decisions/007-two-column-is-two-columns-and-one-bar-per-column.md)）。
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
占用与 usage 一个字段都没建（等 T38），双栏下可见（[D05](./decisions/005-two-column-run-surface.md)，**已被 D07 撤销：双栏现无右列**）。
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

**Last Verified**：2026-09-05（U15/U16 收尾）—— 全仓 **267 files / 4134 tests pass**；
`tsc --noEmit` pass；`biome check src/` 干净；`git diff --check` 干净。
**外加真机 GUI 点验**：U15/U16 的六个看点全部在真实 app 里跑通并留图
（[shots](./evidence/2026-09-05-u15-shots/)）。
（测试总数比 U14 少 24 条：删掉的是两/三栏模式与已删组件的断言，不是覆盖率倒退——
逐条改写理由见 [U15/U16 evidence](./evidence/2026-09-05-u15-u16-vscode-dock-shell.md) 第五节。）
上一批（U12 rev.2）的真回合验证结论仍然有效：
真回合验证（`spikes/u12-tier-turn-probe.ts`，真模型，写工作区外文件）：
`fullopen` 0 次对话框且由 `aiclient-session-tier` 裁决，`handsoff` 仍弹 1 次跨目录确认。

## Active TODO

> 上限五项（root registry 的维护规则）。四件「待真机验证」合并为一项——它们的性质相同：
> 自动化已绿，缺的是一次真实 pi CLI / 真账号 / 真扩展的手动跑。

1. **累计 GUI 点验（当前唯一的主动任务）** — U09 + U12 + U05/U03-b + U08-2 +
   U13 临时分组 + U06-a Run 面板 + U07 对话构成 + U04 插件入口 + **U15 壳层重排 + U16 上下文页**，
   一次 CDP 出图肉眼确认。U14 那五条看点作废（D08 删掉了它们描述的 chrome）。
   **本批次的六个看点**：① 轨道五个图标能切换且选中态可辨；② 面板标题行说明当前区；
   ③ 点左栏会话在中栏新开 Tab、可多开、可关；④ 关 Tab 后会话仍在左栏列表里；
   ⑤ 顶部再无双栏/三栏与「上下文面板」按钮；⑥ 打开文件才出现右栏，展开能盖住中栏。
   **U15/U16 这六条已在真机验证通过**（真实 app + 真实会话数据，
   截图存 [`evidence/2026-09-05-u15-shots/`](./evidence/2026-09-05-u15-shots/)）；
   起不来的那次是本机 `HTTP_PROXY` 导致的挂死，小写 `no_proxy` 一加就好，与本批次改动无关。
   **剩下要点验的是更早批次的项**（U09/U12/U05/U08-2/U13/U06-a/U07/U04）。
2. **待真机验证（四件）** —
   ① **U08-2** `off` 走到真实供应商的实际效果未跑（类型链已逐段核实，不等于每家服务端都认）；
   ② **TUI↔GUI 历史分叉** 已按 pix `leaveTerminalMode()` 修完（`worker.reload` 重载原语 + `chat:reloadSession`，
   离开终端 suspend → 重载 → 揭开；回合进行中拒绝进 TUI），三条变异验证已过，但用户原始复现路径没用真实 pi CLI 跑过
   （老会话不补救，内容在旁支，用会话树自取；见
   [该缺陷记录](./evidence/2026-09-04-host-status-false-stop-and-tui-history-bug.md) 第三、四节）；
   ③ **U13 跨重启** 「聊天 → 退出 → 重开 → 点开」未在真机走过（索引读写、目录认领、resume 参数均有单测）；
   ④ **U04 的 MCP 徽标** 解析逻辑与 pix 同源，但本仓没有可跑通的 MCP 扩展，只有单测覆盖、没有真机样本。
3. **`user_configured` 路线下权限档完全失效** — 用户自己的 `~/.pi` 装了同一个权限插件时，
   我们随包 `config.json` 的 `authorizerChain` 整份不参与，四档一律等同「务实」。红线是不写用户的 `~/.pi`，
   修法未拍板（Host 侧自动应答 / 始终注入随包副本 / 明示降级三选一）。
   详见 [U12 rev.2 evidence](./evidence/2026-09-04-u12-rev2-cross-directory-and-terminal-rail.md) 第五节。
4. **发布前需 `pnpm build:agent-host`** — `out-agent-host/` 里的插件副本与 `config.json` 停留在 09-02，
   连 `authorizerChain` 都没有；dev 不受影响，打包必须重建。
5. **U15 的两处未验证行为** — ① fullscreen diff 藏掉会话 Tab 条是否可接受（备选方案已写在
   evidence 第六节 §2）；② 多会话并发的真机资源表现未测（Tab 只是打开态，
   worker 并发上限仍由 `WorkerManager` 的 bounded pool 决定，本批次没碰）。

## Blocked By

- **U06-b** 等 Pi 计划 [T38-a/b](../pi-backend-migration/roadmap.md) 落地。这是当前唯一的外部阻塞。

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
