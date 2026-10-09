Role: topic

# P1-7 渲染层：方案与就绪检查

上位：[roadmap P1-7](../roadmap.md)。建立：2026-09-27。roadmap 原文：「渲染层：goal 条、todo 卡、jobs 面板、子代理面板；Windows 上 `pwsh` 工具行与审批文案（吸收 runtime-hardening 的 D3 / D4 / D7 / D8 / T138）」，退出判据「开发机 GUI 点验；Windows 实测」。

依据：
- 决策：[001](../decisions/001-route-b-and-scope.md) 第 3 条（外壳与渲染层保留）；[029](../decisions/029-interject-keeps-v103-semantics.md)（插话）；[031](../decisions/031-session-projection-event.md)（`session.projection`）；[044](../decisions/044-dsh-sandbox-off-by-default-in-p1.md)～[047](../decisions/047-tool-classification-and-plan-mode.md)（沙箱、pwsh、plan 模式）；[049](../decisions/049-delegate-declared-tier-inherits.md)；[062](../decisions/062-custom-subagents-delegate-tool.md)（自定义子代理工具，在本任务定稿）；runtime-hardening 的时间线规则（[决策 031](../../runtime-hardening/decisions/031-tool-calls-aggregate-and-work-group-always-folded.md)、[034](../../runtime-hardening/decisions/034-zcode-aligned-process-rows.md)、[038](../../runtime-hardening/decisions/038-delegation-thinking-preview-and-completion-fold.md)、[041](../../runtime-hardening/decisions/041-interject-does-not-wait-for-background-delegates.md)、[043](../../runtime-hardening/decisions/043-thought-folded-and-interrupted-turns-open.md)）。
- 方案：[P1-3](p1-3-shared-host.md) §7；[P1-4](p1-4-bridge-parity.md) §4.4～4.7、§6；[P1-6](p1-6-permissions.md) §4.7；[P1-8](p1-8-p1-11-guards-and-terminal.md) §3.3；[P1-9](p1-9-migration.md)；[P1-10 / P1-16](p1-10-p1-16-extensions.md) §4.4。
- 被吸收的 runtime-hardening 项：待办 D3 / D4 见 [bash 计划书](../../../../plans/2026-09-24-bash-streaming-and-background-plan.md)（「计划定稿，实施暂停」）；待办 D7 / D8 与 T138 见[可行性调研](../../../../plans/2026-09-24-dsh-rebase-feasibility-study.md) §6～§8 与 [runtime-hardening roadmap](../../runtime-hardening/roadmap.md) T138。
- 证据：[P0-2](../evidence/p0-2-goal-and-plugins-2026-09-25.md)（goal、todo、jobs 的真实事件）；[P0-4](../evidence/p0-4-windows-ci-2026-09-26.md)（Windows 上只有 `pwsh`）。

明细分片：[01 渲染层现状](p1-7-renderer/01-current-state.md) · [02 DSH 源码事实](p1-7-renderer/02-dsh-facts.md) · [03 面板方案与线框](p1-7-renderer/03-panels.md) · [04 工具行映射与 Windows 文案](p1-7-renderer/04-tool-rows-windows.md) · [05 改动、切分、实验与测试](p1-7-renderer/05-changes-tests.md)。

状态：
- 只读调研，基线 worktree HEAD `beafffb1`。同一 worktree 里 P1-3a、P1-9a 在施工，本文不引用它们未提交的改动；渲染层文件在工作区没有改动。
- 没有改代码，没有起宿主或 Electron，没有联网，没有调用模型。
- **方案待拍板**（§5）：U1～U5 建议用户拍板，D1～D10 按工作方式自主决定、各写一份决策（编号由编排器接续 067 分配）。

约定：DSH 路径省略前缀 `src/dsh-host/node_modules/@deepseek-ai/`，版本 `0.1.7-rc.2`；我方路径行号取 `git show beafffb1:<路径>`。标「推断」「需实测」的没有运行验证。runtime-hardening 的用户待办写作「待办 D3」「待办 D4」等，以免与本文的决策点 D1～D10 混淆。

## 1 结论先行

1. **能做，主体是「接新数据源 + 少量新组件」。** 时间线、工具行、子代理泳道、审批卡、失败卡、排队条样式、相邻 store 模式都能复用（分片 01）。粗估产品代码约 3.9k 行、测试约 2.9k 行，约 4～5 人周，切成 P1-7a～d（§6）。
2. **数据源**：goal、todo、子代理目录来自 `session.projection`（决策 031）。另要两个 bridge 合成的 key：`goalActivation`（DSH 的 goal 投影故意不带 armed 状态）与 `jobs`。运行中命令的实时输出走 `tool.output`（沿用 bash 计划书的形状）。子代理活动沿用 `subagent.activity`，由 P1-7 在 bridge 侧从子会话事件投出来。
3. **布局（U1）**：输入框上方按 DSH 的顺序叠三条可折叠窄条：待办 → 目标 → 后台；默认各折叠成一行 `h-7`，没有内容就不出现；问答 / 审批浮层与排队条不动。
4. **目标条**：显示目标、阶段、轮次（如 3/256）、是否已挂起；暂停 / 继续 / 编辑 / 清除经新 RPC `worker.command` 带外执行 `/goal …`，不进消息队列、不开模型回合（D2）。恢复会话、回退、fork、Stop、插话之后，DSH 会让目标挂起或暂停，条上要说清楚并给「继续」。
5. **自主回合要有边界。** 目标轮、后台任务完成唤醒、子代理完成唤醒今天都会被并进上一回合：回合按 user 消息切分（`chatTurn.ts:85-104`），HEAD bridge 对这类回合只发 `running`、不回显触发消息（`dshSessionRuntime.ts:828-841`）。推荐 bridge 回显带 `origin` 的轮次头，渲染层画成一行轻量头（D3）。
6. **待办卡**：`todos` 投影在新一轮开始时清空、回合结束后保留（`dsh-tool-todo/lib/index.js:85-86`）；折叠为「待办 3/7 · 正在：…」，展开为清单；时间线里的 `todo_write` 行展开也画清单。待办 D8 的「计划审阅」依附 DSH 自己的 plan 模式，决策 047 没有接它，P1 不做。
7. **后台任务条（待办 D4）**：列出后台命令、超时转后台的命令、一次性后台子代理、后台 workflow 与运行中的可续子代理，能停止、能展开看尾部。DSH 的前台命令本来就登记成 job（`dsh-tool-bash/README.md:64`），所以待办 D3「运行中命令的实时输出」直接从 job 输出环取，不再改 runtime。
8. **子代理（待办 D7，U2）**：保留 1.0.x 的行内泳道，扩到 `subagent`、`subagent_fork` 与决策 062 的工具；运行面板加子代理清单（状态、用时、打断、定位）。**必须改一处**：泳道今天在任何 `session.completed` 时被扫成「已取消」（`subagentActivityModel.ts:654-681`），而 DSH 的 `subagent` 缺省后台可续跑，父回合结束后还在跑。
9. **工具行（分片 04）**：给 DSH 全部工具补动词、图标、参数摘要。三处已知错位：小写 `read` / `edit` / `write` 只读 `path` 不读 `file_path`；`pwsh` 不在终端类集合；兜底动词 `Ran` 译成「终端」，插件工具（例如 `word_create`）的行会以「终端」开头。插件与未知工具优先用 DSH 的 `presentCall` 标题与类别（D8）。
10. **Windows**：pwsh 行与 bash 同形，摘要额外去掉 `Set-Location …;` 等前缀；命令到时限是**转后台**而不是被杀，行尾改写；Stop 在 Windows 上表现为 exit 1，按 `ABORTED` 错误码显示「已停止」。审批卡标题写 PowerShell、按高风险、授权前缀附别名说明；`escalate_sandbox` 只在沙箱开关打开后出现。
11. **runtime-hardening 遗留**：待办 D3、D4 的 runtime 与 Main 半边作废，渲染层半边（bash 计划书 B5、B6、B10）换成 DSH 数据源复用；bash 计划书两个没拍的点并入 U3；待办 D7、D8 与 T138 由本方案落地（§4.6）。
12. **要交给其他任务的发现**：P1-4 分片 01 说「bash 的 meta 带 aborted」，源码里 bash 没有 `presentationMeta`，执行期结果值也不落盘（`dsh-tools/lib/types/index.d.ts:413-424`），历史里只能按 `error.code: 'ABORTED'` 判；DSH 组合里没有提问工具（`dsh-tool-ask-user` 不在 dsh-base 依赖中），1.0.x 的 `ask` 没有对应物；`present` 随包但 dsh-base 不挂。

## 2 现状（明细见分片 01）

- **中栏布局**：时间线 → 问答浮层 → 审批浮层 → 输入框列（模型同步提示、发送失败框、排队条、输入框、目标栏）（`ChatWorkspace.tsx:283-324`；`ChatComposer.tsx:3834-3889`）。左栏有「运行」面板（`surfaceRegistry.ts:130-143`）。
- **已有而能复用的**：工具行三件套（动词表、图标表、参数摘要）；委派行与子代理泳道（按父工具调用 id，`agentIndex` 做 join，历史经 `session.history.subagents` 重建）；审批卡（动作 id、风险、子代理来源小标、两轮之间不标等待审批）；失败卡与 `TurnCeilingNotice`；相邻 store 的写法（纯 reducer + zustand 壳，不碰红线文件 `chatSessions.ts` 的状态结构）。
- **缺的**：goal、todo 的任何界面；后台任务；运行中命令的实时输出（`tool.updated.status` 从来没有生产者）；子代理清单；自主回合的分界；DSH 通知的样式（今天会画成 `dsh:tool-jobs\n…` 的整张 Alert，`chatSessions.ts:1491-1504`）；面板补水。

## 3 DSH 侧事实（明细见分片 02）

- **goal**：阶段 active / paused / blocked / complete，另有进程内的 armed / disarmed；投影 `goal` 不含 armed，要听 `goal/activation-changed`（`dsh-goal/lib/types/types.d.ts:60-131`）。续跑只在整个 agent 空闲、目标 active 且 armed 时进行；宿主发起的暂停会中止正在跑的一轮（P0-2 实测）；恢复会话或 fork 之后目标 disarmed，要人明确 resume。已暂停的目标模型不能恢复，要走 `/goal resume` 或界面控件。
- **todo**：整表替换，三态；投影在 `turn/start` 清空。
- **jobs**：`ctx.jobs` 登记表，`<kind>-N` id、owner、状态、进度行、结束原因、输出环；事件 `registered / progress / stopping / settled / removed / output`，观察者用 `readAt` 非消费地读；每个 owner 最多 10 个；随宿主进程消失。完成通知默认**唤醒空闲的 agent 开新回合**，`maxConsecutiveWakes` 可设上限。
- **子代理**：`subagent`（continuable，缺省后台，`send_message` 续聊、`interrupt_agent` 打断）、`subagent_fork`（one-shot）；子会话 header 带 `parentSession`；父会话有 `subagent/catalog` 与 `subagentCatalog` 投影；生命周期事件不带父工具调用 id，要靠结果值与日志位置配对。
- **工具呈现**：工具可声明纯函数 `presentCall` / `presentResult`（card、title、kind），DSH 明说是给宿主侧消费者用的，官方 Web 客户端并不读它（`dsh-tools/README.md:91`）。
- **Windows**：只有 `pwsh`；UTF-8 输出已固定；缺 pwsh 7 时退回 5.1；强杀是 exit 1。
- **官方界面**：界面包不在我们的树里；README 与调研档里能确认的只有：goal 条在输入框上方、排在 Todo 之后（二手）；Web 任务列表可停止前台命令；子代理浏览器可让人给子代理发消息。

## 4 方案（明细见分片 03、04）

### 4.1 线协议与存储（分片 03 §0）

- P1-4 产出事件，P1-7 只渲染。只服务界面的 bridge 逻辑（jobs 快照、实时输出、子代理活动）归 P1-7b，写成 `src/dsh-host/bridge/` 下的独立模块。
- 渲染层新增三个相邻 store：`sessionPanels`（goal、armed、todos、子代理目录）、`jobs`、`toolLiveOutput`；`chatSessions.ts` 只加一个可选字段 `origin`。
- 新 RPC：`worker.command`、`worker.panels`（补水）、`worker.job.kill`、`worker.job.read`、`worker.subagent.interrupt`，Main、preload、IPC 由本任务加。

### 4.2 目标条（T138）

七种状态、按钮与线框见分片 03 §2。要点：暂停会中止当前轮；Stop 之后 DSH 在下一个空闲点把目标置为暂停；回退、fork、宿主重启后目标挂起；round-limit 阻塞时「继续」置灰并提示让助手调高上限。创建目标只靠 `/goal <目标>` 与模型的 `create_goal`，输入框不加开关（与 Claude Code、Codex、DSH 一致）。

修订（2026-10-09，[决策 166](../decisions/166-permission-menu-single-column-and-goal-entry.md)，GitHub issue #5 用户裁决）：权限菜单末尾加「设定目标…」，只往输入框预填 `/goal `，仍不是开关；创建目标的 `/goal` 发出前会把会话切到执行模式、至少「全自动」。

### 4.3 待办卡（待办 D8）

分片 03 §3。清单只属于根会话；子代理的清单首版不显示。

### 4.4 后台任务条与实时输出（待办 D3、D4）

分片 03 §4。前台命令的 job 在 `tools/execute` 窗口里与调用对应（bash / pwsh 互斥，E1 核实），输出按 250 ms 合并成 `tool.output`；后台项进后台任务条，展开时每秒 `readAt` 一次。有运行中的 job、子代理或 armed 的目标时，bridge 在 pong 里报 `busy`，Main 不回收会话（交给 P1-3）。

### 4.5 子代理（待办 D7）

分片 03 §5。配对：直播以执行期结果值为准，历史用「`subagent/catalog` 落在该调用的 `tool/call` 与 `tool/result` 之间、label 等于 `description`」（E2 核实）。状态：completed / aborted / error / max-tokens / refusal 分别映射为已完成 / 已停止 / 失败 / 截断 / 失败（拒绝）。续聊落回原泳道。审批卡的 join 键是子会话 id（与 P1-6 一致）。

### 4.6 runtime-hardening 遗留项的落地

| 项 | 原本是什么 | 为什么暂停 | DSH 下怎么落地 |
|---|---|---|---|
| 待办 D3 | 运行中的 bash 行实时显示输出（bash 计划书 §3.1） | 09-24 等 DSH 调研结论，自研一套切换后作废 | 前台命令本来就是 job，bridge 从输出环取尾部发 `tool.output`；渲染层照 B5、B6 做 |
| 待办 D4 | 后台命令：`run_in_background`、读输出、停止、后台任务条（用户 09-24 认可这个形态） | 同上；DSH 的 jobs 语义完整 | 直接用 DSH 的 `run_in_background`、超时转后台、`job_*` 与完成通知；B10 的任务条换数据源；两个待拍板点并入 U3 |
| 待办 D7 | 子代理面板与可续跑（调研档 §8） | 并入 P1 | DSH 子会话 + 行内泳道 + 运行面板清单；续聊与打断用 DSH 原生工具；形态见 U2、U4 |
| 待办 D8 | 计划与 todo：todo 卡与计划审阅 | 并入 P1 | todo 卡照 §4.3；计划审阅依附 DSH plan 模式，P1 不做 |
| T138 | goal 模式，向 Claude / Codex / DSH 看齐 | 09-25 移交 DSH P0-2 / P1 | DSH goal 四件套原样用；目标条、轮次头、`/goal` 与带外控制归本任务 |

落地后由编排器在 runtime-hardening roadmap 把这五项标为「由 DSH P1-7 吸收并落地」。

### 4.7 工具行与 Windows 文案（D8、D9，分片 04）

全表见分片 04 §2、§3；shell 细则 §4；插件兜底 §5；审批卡 §6；失败卡 §7；Windows 实测清单 W1～W12 在 §8。

## 5 需要拍板的决策点

**建议用户拍板**

| # | 问题 | 选项 | 推荐 | 理由 | 代价 |
|---|---|---|---|---|---|
| **U1** | 输入框上方怎么放 | A 三条可折叠窄条（待办 → 目标 → 后台）；B 一行状态小标，点开浮层；C 只放左栏「运行」面板 | A | 与 DSH 的顺序一致；和 09-24 认可的后台任务条同形；目标状态一眼可见 | 全部出现时多占约 84 px；开工前做一张原型页给用户确认 |
| **U2** | 子代理面板的形态 | A 行内泳道 + 运行面板清单；B 另开左栏 surface「子代理」；C 只有行内泳道 | A | 沿用 runtime-hardening 决策 038 的委派两层；清单补上「本会话全部子代理」 | 运行面板收起时看不到清单 |
| **U3** | 后台活动的生命周期 | A Stop 连带停子代理（打断可续子代理的当前回合、停掉一次性后台子代理），不停后台命令；完成唤醒保留，设 `maxConsecutiveWakes: 3`；B 都不停，唤醒不设上限（DSH 原生）；C 都停；完成后不唤醒，等下次发送再交付（`completionDelivery: quiet`，即 bash 计划书拍板点 2 的建议） | A | 保住用户拍板过的决策 041 第 4 条；后台命令用户看得见、能单独停；目标与子代理本来靠唤醒续跑，上限防自激链 | 离开时仍可能自动续跑、弹审批卡；上限 3 没有实测依据（E6 后再定） |
| **U4** | 自定义子代理工具（决策 062 定稿） | A 单个 `delegate {agent, description, prompt, run_in_background?}`，缺省后台可续；B 沿用 1.0.x 的 `Task {agent, task, …}`；C 每个定义一个工具 | A | 参数与 DSH `subagent` 一致，`send_message` / `interrupt_agent` 通用，泳道统一；不与旧会话的 `Task` 撞名 | 模型要认一个新名字；旧会话的 `Task` 词条要留着 |
| **U5** | 目标运行中按 Ctrl+Enter | A 与普通回合一致：本轮在步边界结束，目标因取消而暂停，条上给「继续」；B 目标轮里改用 DSH 的 steer，消息并入当前轮、目标不停 | A | 与决策 029 一致，改动小 | 想「边跑边补一句」时目标会停，要多点一次继续；B 可作后续增强 |

**自主决定（待审批）**

| # | 决策 | 选项 | 推荐 | 理由 | 代价 |
|---|---|---|---|---|---|
| D1 | jobs 与 armed 怎么上线 | A `session.projection` 加 bridge 合成 key（`goalActivation`、`jobs`）；B 各开一种新事件 | A | 都是「后到覆盖」的快照；少一套订阅与补水 | 决策 031 的 key 不再全来自 DSH 投影，类型里注明 |
| D2 | 目标控制通道 | A 新 RPC `worker.command` 带外执行 `/goal …`；B 走普通发送；C 专用 goal RPC 直调 `ctx.goals` | A | 普通发送在回合进行中会被排队；A 还能给别的命令复用，且保留 DSH 的暂停语义 | 多一个 RPC |
| D3 | 自主回合的表示 | A 回显带 `origin` 的轮次头；B 并入上一回合（现状）；C 在上一回合末尾插系统注记 | A | 回合时钟、工作组折叠都按「一轮」计；与 DSH 每轮一个请求头一致 | `chatSessions.ts` 加一个可选字段；5 处读 user 消息的地方要认 `origin` |
| D4 | 通知怎么显示 | A 按来源定表（分片 03 §6.2），直播与历史共用；B 全显示；C 全隐藏 | A | `[model changed]`、提醒类只给模型看；任务与子代理完成对用户有用 | 表要随 DSH 新来源维护 |
| D5 | 运行中命令的实时输出 | A job 环 + `tool.output`；B 只显示时钟（现状） | A | 待办 D3 的原始诉求；不改 runtime | bridge 多一个节流模块 |
| D6 | 子代理配对 | A 结果值确证 + 日志位置规则；B 在 `tools/execute` 里用 AsyncLocalStorage 追踪；C 只按描述文字 | A | 直播与历史同一套规则，历史不依赖执行期状态 | 同一回合里描述完全相同的并行委派可能配错（E2） |
| D7 | 泳道的收尾 | A DSH 会话只在引擎失联时扫，其余靠子代理自己的结束事件；B 维持现状 | A | 现状会把后台可续的子代理误标为已取消 | 要补一组测试 |
| D8 | 插件与未知工具行 | A 优先用 `presentCall` 的标题与类别，兜底动词改成「工具」；B 只按名字兜底 | A | 插件自带描述；DSH 为宿主侧消费者设计了这个接口 | 标题是插件自己的英文，不翻译 |
| D9 | shell 行摘要 | A 命令摘要（延续 09-22 的用户裁定），`description` 放展开体；B 显示 `description` | A | 与 1.0.x 一致；模型常用英文写说明 | 行上看不到模型的意图说明 |
| D10 | `present` 与计划审阅 | A P1 都不做；B 挂 `present` 做交付卡、接 DSH plan 模式 | A | dsh-base 不挂 `present`；决策 047 不接 DSH plan 模式 | 待办 D8 只落地一半；办公插件试点时再议 |

## 6 改动清单与切分（明细见分片 05）

| 子任务 | 内容 | 产品 / 测试 | 依赖 |
|---|---|---|---|
| P1-7a 目标、待办、轮次头与通知 | 相邻 store 与纯模型；目标条、待办卡；轮次头与通知行；`worker.command`、`worker.panels` | 约 1300 / 1000 | P1-4d、P1-4a、P1-3a；纯模型可先写 |
| P1-7b 后台任务、实时输出、子代理 | bridge 的 jobs 与子代理模块；后台任务条；实时输出；泳道规则；运行面板清单；3 个 RPC | 约 2000 / 1400 | P1-4d、P1-6b、P1-3；U3 |
| P1-7c 工具行与 Windows 文案 | 分片 04 全表、pwsh 细则、插件兜底、审批与失败卡文案 | 约 600 / 500 | P1-4d 的 `presentation` 与 `ABORTED` 映射；P1-6b / 6d |
| P1-7d 收口 | 原型页（U1、U2）；GUI 点验；Windows 实测；证据；runtime-hardening 回写 | 脚本约 300 | a～c；推送与测试版需用户同意 |

顺序：原型页先行 → a 与 c 并行 → b 在 P1-4d、P1-6b 之后 → d。跑测试的并行代理不超过 2 个；全量测试只在收口跑一次。开工前实验 E1～E6 见分片 05 §3。

## 7 测试方案（明细见分片 05 §4）

- **纯单测**（根 vitest，不装 DSH）：面板模型、jobs 模型、实时输出模型、通知策略、回合分组、泳道规则、`dshToolVocabulary` 静态守卫、工具行与审批卡文案。
- **挂载测试**：`window.electronAPI` 的 `env` / `settings` / `app` 桩放 `vi.hoisted`，并 `vi.mock('@/utils/logging')`；zustand persist 在 import 时就 rehydrate，桩放 `beforeEach` 会 10 秒挂死。加 `timeout 90`。
- **bridge 单测**（假 ctx）：jobs 对应与节流、子代理配对、轮次头、`goalActivation`、带外命令不开回合。
- **回放与录制门禁**：在 P1-4e 的回放测试与 `bridge-record.ts --check` 里加 goal、todo、后台、转后台、子代理、通知共 10 个场景；假网关 `dsh-p0-2` 计划已覆盖 goal / todo / jobs。
- **GUI 点验**：合成态（经 Vite import store，把合成事件灌进当前会话，逐态截图）+ 真宿主（临时 HOME、假网关、带标记的消息、「先 busy 再三次 idle」判结束）。
- **Windows**：分片 04 §8 的 W1～W12，自动化部分进 Windows CI 两路，界面部分在测试版上人工核对。

## 8 风险与未覆盖

- **需实测**：E1 前台 job 与调用的对应；E2 子代理配对；E3 armed 事件的触发与带外暂停；E4 输出事件量；E5 Stop 对后台活动的影响；E6 唤醒上限。
- **视觉噪音**：用户对「一团乱麻」敏感（runtime-hardening 决策 034），三条窄条加轮次头会让聊天区更满。缓解：默认折叠、没内容不出现、开工前原型页确认。
- **事件量**：实时输出与 jobs 快照走共享宿主的 IPC 通道，靠节流（250 ms / 1 s）与只在展开时拉尾部控制；E4 给出实测数。
- **Main 不知道自主回合**：目标轮、唤醒轮期间 Main 的忙碌锁与 Stop 看门狗只能部分覆盖（P1-3、P1-4 已登记）；用户在目标轮期间发的消息会排到本轮之后（DSH 让位规则）。
- **补水依赖活的 worker**：只读预览里看不到目标状态；可让只读回放顺带返回投影值（可选）。
- **DSH 升级漂移**：goal 投影有 `stateVersion`，jobs 事件、呈现意图都可能改；靠钉版本、录制门禁与词表静态守卫兜住。
- **没能确认**：官方 Web 界面的实际样子（界面包不在树里）；Stop 对后台活动的实际影响；并行同名委派的配对。
- **未覆盖**（进想法池）：人直接给子代理发消息（DSH 的 `prompt`）；计划审阅；交付卡（`present`）；子代理自己的待办与后台任务；workflow 成员逐个泳道；用 `contextBreakdown` 投影细分上下文占用。
- **行为差异**（写进发版说明）：子代理缺省后台可续跑，父回合结束后仍在跑；超时的命令转后台而不是被杀；目标轮是独立回合；若 U3 选 A，Stop 不停后台命令。
- **本文没有改** roadmap、看板、决策与 README 的文件地图；需要编排器登记本方案、按 §5 写决策，并在 P1-4 的范围里补登 `goalActivation`、`presentation` 字段与 `ABORTED` → 已停止的映射。
