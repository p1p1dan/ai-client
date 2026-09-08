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

**批次 13/14/15 的其余切片**（同为 2026-09-06 落地；逐片叙事已移入
[landed log](./history/2026-09-07-landed-log.md)，下表只作索引）：

| 切片 | 一句话 | 证据 |
|---|---|---|
| U29 | 起始屏底栏不再是空的：控件永不空白，无会话时用全局模板 `chatAgentDefaults` 顶上（抄 pix 的规则、不抄它的单会话结构），占用 chip 刻意不动 | [evidence](./evidence/2026-09-06-u29-start-screen-bar.md) |
| U28 | 起始屏改为「可用的输入框」（[D14](./decisions/014-start-screen-is-a-live-composer.md)）：发送即创建会话，「没有会话」不再判故障；推翻同日 U22 的落地形态 | [evidence](./evidence/2026-09-06-u28-start-screen.md) |
| U25 + U26 + U27 | TUI 下也能看文件（[D13](./decisions/013-editor-stays-available-in-tui.md)，根因是一条过期的决定）；轨道 `h-9` 对齐标题行；窗口最小宽 `SHELL_MIN_WIDTH = 1244` | [evidence](./evidence/2026-09-06-u25-u26-u27-layout-fixes.md) |
| U24 | 中栏回到单会话视图、并发上限 4 → 10（[D12](./decisions/012-single-session-view-and-background-concurrency.md)）；取证结论是后台继续执行本就成立，Tab 从未参与判定 | [evidence](./evidence/2026-09-06-u24-single-session-view.md) |
| U22 + U23 | 免绑定入口（`canSend` 的硬闸下四个出口全关）与插件在 `session.resumed` 下的重订阅 | [evidence](./evidence/2026-09-06-u22-u23-unbound-entry-and-plugin-resume.md) |

**更早的批次（U01–U21，2026-09-03 至 2026-09-05）**：逐批叙事见
[landed log](./history/2026-09-07-landed-log.md)；任务身份与状态以 [roadmap](./roadmap.md) 为准，
逐片证据见 [evidence 目录](./evidence/)。

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
**更早的验证结论**（2026-09-05 批次 9 收尾、U15/U16、U12 rev.2）在被后续批次推翻前继续有效，
原文见 [landed log](./history/2026-09-07-landed-log.md) 第二节。

## Active TODO

> 上限五项（root registry 的维护规则）。六件「待真机验证」合并为一项——它们的性质相同：
> 自动化已绿，缺的是一次真实 pi CLI / 真账号 / 真扩展 / 真慢冷启动的手动跑。

<!-- B 组在本累计 GUI 轮次追加点验，不单开 GUI 轮次。 -->

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

## B 组累计 GUI 追加项（2026-09-08）

与当前累计轮次合并：[资源归位与导入](../resource-home-and-import/implementation-status.md)。
点验资源页「默认」与打开技能目录、随包清单开关保存和重启后的状态、
Claude/Codex 来源区分及选择导入、重复导入结果、点击打开后在 Pi 中继续。
B1 的真实 utilityProcess 与 TUI PTY 自动探针已通过；这里仍需要真实设置页/导入页交互确认。
