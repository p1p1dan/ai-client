# Roadmap — pix/pi-app UI 对齐改造

> 本文件是本计划任务 ID、状态与顺序的唯一权威。
> [D01](./decisions/001-style-depth-and-sequencing.md) 决定二的排期闸门**已解除**：Pi-only 计划 T37 于 2026-09-03 收口
> （manual CI run `33714362901` 全绿），本计划可以开工。
> 切片划分、批次顺序、逐片验收标准与门禁见 [execution-plan](./topics/execution-plan.md)；本文件只维护任务身份与状态。

## 状态摘要

| 分组 | 数量 | 说明 |
|---|---|---|
| Done | 22 | U00：实况核查；**U01：样式地基**（[evidence](./evidence/2026-09-03-u01-style-baseline.md)）；**U09：Composer 形态**（[evidence](./evidence/2026-09-03-u09-composer-form.md)）；**U12：会话权限档**（2026-09-03）；**U02：双栏/三栏布局模式**、**U03-a：TUI 收右栏**（[evidence](./evidence/2026-09-03-u02-u03a-column-mode.md)）；**U05：免绑定开聊**、**U03-b：TUI 解绑**（[evidence](./evidence/2026-09-03-u05-u03b-unbound-chat.md)）；**U08-2：思考档七档**（[evidence](./evidence/2026-09-03-u08-2-thinking-levels.md)）；**U13：免绑定会话跨重启可见性**、**U06-a：Run 面板**、**U07：Context 内容增强**（2026-09-04，[U13 evidence](./evidence/2026-09-04-u13-unbound-session-visibility.md) / [批次 6 evidence](./evidence/2026-09-04-u06a-u07-run-and-context-panels.md)）；**U04：左栏插件入口**（2026-09-04，[U04 evidence](./evidence/2026-09-04-u04-plugin-entry.md)）；**U14：壳层横条重排与双栏收敛**（2026-09-04，[U14 evidence](./evidence/2026-09-04-u14-shell-chrome-realignment.md)）；**U15：VSCode 式壳层重排**、**U16：上下文页图形化与折叠**（2026-09-05，[U15/U16 evidence](./evidence/2026-09-05-u15-u16-vscode-dock-shell.md)）；**U17：bootstrap 冷启动超时**、**U18：思考强度极端档需声明**、**U19：关 Tab 即结束对话**（2026-09-05，[批次 9 evidence](./evidence/2026-09-05-startup-timeout-thinking-levels-tab-close.md)）；**U06-b：上下文占用 donut + usage 行 + 底栏占用 chip**（2026-09-05，随 Pi 计划 T38 同批，[T38/U06-b evidence](../pi-backend-migration/evidence/2026-09-05-t38-runtime-usage-fields.md)）；**U21：下线实时 ↓ 输出 token 计数器**（2026-09-05，[D11](./decisions/011-retire-the-live-output-token-counter.md) / [evidence](./evidence/2026-09-05-retire-live-token-counter.md)） |
| In Progress | 0 | — |
| Moved out | 0 | ~~U06-b → Pi 计划 T38~~ — T38 已关闭，U06-b 同批落地，回到 Done |
| Dropped | 1 | U08-3 请求优先级（[Q12](./open-questions.md) 拍板不做） |
| Superseded | 1 | U02 双栏/三栏开关 → 被 [D08](./decisions/008-vscode-dock-shell.md) 决定四整片作废 |
| Deferred | 2 | U10–U11 |

**执行顺序**（批次，详见 execution-plan）：
`U01 ✅ → U09 ✅ → U12 ✅ → U02+U03-a ✅ → U05+U03-b ✅ → U08-2 ✅ → U13 ✅ → U06-a+U07 ✅ → U04 ✅ → U14 ✅
→ 批次 8：U15-a ✅ → U15-b ✅ → U15-c ✅ → U15-d ✅ → U16 ✅ → 批次 10：U17–U19 ✅ → 批次 11：U06-b ✅
→ 批次 12：U21 ✅`。
**全部切片已落地**；批次 8 由 [D08](./decisions/008-vscode-dock-shell.md) 开立，
按 [`docs/design/a11-vscode-shell-prototype.html`](../../../design/a11-vscode-shell-prototype.html) 施工。
**外部阻塞已清零**——U06-b 随 Pi 计划 T38 于 2026-09-05 同批落地。Deferred 仍是 U10/U11。
U12 紧跟 U09：底栏顺序对齐要给权限 chip 留出左侧位置，先排位再插控件，同一块 JSX 只改一次。

**新增决策**：
- ~~[D05](./decisions/005-two-column-run-surface.md)——双栏 rail 由「只有 Context」扩到「Context + Run」~~
  **Superseded by [D07](./decisions/007-two-column-is-two-columns-and-one-bar-per-column.md)**：
  双栏已无第三列可挂，Context 与 Run 一并退出双栏。
- [D06](./decisions/006-plugin-inventory-source.md)——插件清单由 worker 上报「实际加载了什么」，
  不在 Main 重实现 pi 的解析（后者是第二份手抄，表现为「界面说 3 个、agent 实际加载 1 个」）。
- [D10](./decisions/010-user-configured-gate-explicit-degradation.md)——**`user_configured` 明示降级**：
  档位在这条路径上从来没生效过而界面看不出来，改为把 `permissionGate` 送到渲染层并在控件上说明。
  只说降级、不教修法（用户拍板）。**决定三（2026-09-05 追加）：不恢复功能，到此为止**——
  用户自己装了权限插件就由他自己去 pi TUI 设置里改；「始终注入随包副本」与双插件语义探针一并取消。
- [D09](./decisions/009-tab-close-ends-conversation.md)——**关 Tab 就是结束对话**：确认后断开该会话的
  运行时，但左栏那一行留着（仓库里三个「关闭」中最轻的那个；另两个是左栏 Close 与 Archive）。
  修正 D08 决定三留下的「关 Tab 只是收起 Tab」。
- [D08](./decisions/008-vscode-dock-shell.md)——**VSCode 式壳层**：左栏是图标轨道 + 面板的导航容器
  （聊天 / Git / 文件 / 上下文 / 运行），右栏只做文件与编辑器，中栏一个已启动会话一个 Tab，
  **删掉双栏/三栏与上下文面板开关**。推翻 D07 决定一与决定三（决定二「每栏一条横条」继续有效），
  并使 U02 整片作废。基准是 `docs/design/a11-vscode-shell-prototype.html`。
- ~~[D07](./decisions/007-two-column-is-two-columns-and-one-bar-per-column.md)——**双栏就是两栏**~~
  **决定一/三 Superseded by D08**（决定二仍有效）：
  （推翻 D02 决定一与 D05）；**每栏只留一条横条**，三列齐平；GUI/TUI 与列数是两个独立控件，
  不做成三选一。起因是用户看到实际界面后指出「臃肿不协调」，取证发现原型与 D02 在双栏语义上
  互相矛盾、而代码跟的是 D02。

**无未决问题**：Q01–Q13 全部关闭（Q08/Q10 见 [D03](./decisions/003-sidebar-density-and-runtime-field-ownership.md)；
Q09 由取证关闭；Q11 布局尺寸维持现值；Q12 请求优先级不做；
Q13 免绑定会话跨重启可见性由 [D04](./decisions/004-unbound-session-index-visibility.md) 拍板走索引标记，落为 U13）。

## Done — 批次 12（最新）

### U21 — 下线实时 `↓` 输出 token 计数器 — **Done**（2026-09-05）

按 [D11](./decisions/011-retire-the-live-output-token-counter.md)，关闭 T38 evidence §七的欠项 ②。

D33（Claude 时代，计划已归档）定的状态行 `✽ 19m 55s · ↓ 38.5k` 里的 `↓`，
数据来自 Claude host 的中途估算通道；T35 删 legacy host 时生产者一并消失，消费链留了下来。

**取证结论：这不是「还没接」，是没有数据源。**pi 的 `AgentEvent` 共 11 种，
带 usage 的只有 `turn_end` / `agent_end`（都在回合结束后），流式的 `message_update`
没有任何 token 字段。要凑出「实时」只剩字符除以 4，与 U06 一路守的红线冲突。

整条删除：字段、两个 reducer、zustand 选择器、两处 `↓` 渲染（回合状态行 + composer 等待行）、
`formatTokenCount`，以及 20 条相关断言。**保留**「估算不得记为账单」的两处守卫
（`readPiUsagePayload` / `messageMetadata`）与 `↑ NNN chars`（那是精确值，不是估算）。
加了一条反向守卫，防止有人拿估算把计数器接回来。

**证据**：[D11 evidence](./evidence/2026-09-05-retire-live-token-counter.md)。
**欠项**：GUI 点验并入累计那一次，看点是**不该出现的东西**（状态行只有 `✽` 加计时）。

## Done — 批次 9

三件用户报障，一次做完。证据合并在
[批次 9 evidence](./evidence/2026-09-05-startup-timeout-thinking-levels-tab-close.md)。

### U17 — 启动 resume 的 bootstrap 超时 — **Done**（2026-09-05）

`chat:resumeSession` 报 `worker.bootstrap timed out after 10000ms`：
`createPiWorkerSlot` 没给 bootstrap 传超时，于是套用了 `WorkerSlot` 给**暖 RPC** 用的 10s 默认值，
而 bootstrap 是冷启动本身（fork 进程 + dev 下逐模块剥类型加载 agent-host + 解析会话文件 +
加载 pi 扩展并绑审批 UI）。改为单开 `BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000`。
**按代码路径判定，未复现原始现场**——证据是那条单测，不是一次成功启动。

### U18 — 思考强度不再给未声明的极端档 — **Done**（2026-09-05）

Minimal + GPT-5.6 Terra 打回 `502 host_call_failed: level "minimal" not supported,
valid levels: low, medium, high, xhigh, max`，且被 pi 当网络抖动重试了 3 次。
根因是三层叠加：models.json 只有 `reasoning: true` 没有 `thinkingLevelMap`；
pi 假定 `off`/`minimal` 处处可用所以 clamp 不拦；本仓 `effortsForModel` 比 pi 还松，
无 map 就把七档全给（连 pi 要求声明的 `xhigh`/`max` 也给，而那两档会被 pi 静默降级成 `high`）。
**用户拍板**：没声明就只给 `low/medium/high`，四个极端档必须在 `thinkingLevelMap` 里点名。
配套让 `reconcileEffortForModel` 在模型未知（目录未加载完）时保留已存档位，
否则它会把用户合法的 `xhigh` 抹掉——它的返回值是要写回存储的。

### U20 — `user_configured` 权限档明示降级 — **Done**（2026-09-05）

按 [D10](./decisions/010-user-configured-gate-explicit-degradation.md)，关闭 U12 rev.2 的头号欠项。
用户自己的 agentDir 声明了同一个权限插件时，我们不注入随包副本（红线），
于是 `authorizerChain` 缺席、档位环永不被咨询——**界面却照常显示四档**。
现在把 `permissionGate` 从 bootstrap 应答送到渲染层，降级态下标签改「你自己的策略」、
菜单换成两行说明。**用户拍板只说降级、不教修法**，补救办法只留在 D10 里。
顺带更正旧记录：不是「等同务实」，是等同用户自己的策略——本机那份 `yoloMode: true`，
比任何一档都宽。证据见 [U20 evidence](./evidence/2026-09-05-user-configured-gate-degradation.md)。

### U19 — 关闭中栏 Tab = 结束对话 — **Done**（2026-09-05）

按 [D09](./decisions/009-tab-close-ends-conversation.md)：X 先弹确认框，确认后调
`chat.closeSession` 断开运行时并复位渲染层的四处会话状态，**左栏那一行保留**。
修正了 U15-c「关 Tab ≠ 关闭会话」的定义；U15-c 验收看点 ④ 继续成立
（变的是它在后台还活不活，不是它在列表里还在不在）。

## Done — 批次 8

### U15 — VSCode 式壳层重排 — **Done**（2026-09-05）

按 [D08](./decisions/008-vscode-dock-shell.md) 与
[`a11 原型`](../../../design/a11-vscode-shell-prototype.html) 施工，四片有先后依赖：

- **U15-a 左栏导航容器**：`44px` 纯图标轨道 + 面板（顶部 h-9 标题行）+ 页脚账号胶囊。
  五个入口 `chat · git · editor(文件) · context · run`，轨道底部 `插件 · 设置`。
  `chat` 复用既有注册表 id，语义改为「会话列表」；原 `LeftNav` 主体降为该 surface 的视图。
  `sidebarCollapsed` 语义改为「收起面板、轨道常驻」。
- **U15-b 右栏收敛**：`ContextPanel` 退役，右栏只剩文件与编辑器 + 展开覆盖；
  无打开文件时不渲染（不是 0 宽）。
- **U15-c 中栏会话 Tab**：新增打开态（有序 `openSessionIds`）+ 会话 Tab 条 + `+` 新建，
  GUI/TUI 移到该条右端。`activeSessionId → 保证在 Tab 列表里` 是单向的，
  既有 `selectSession` 调用点不改。关 Tab ≠ 归档/关闭会话。
  左栏列表标出打开态（实心=运行中 / 空心=已启动 / 无=未启动）。
- **U15-d 删列数开关**：`shellColumnMode` 及其模型、按钮、快捷键分支整体删除；
  store 版本 v2 → v3（丢弃老 `railOrder` 与 `shellColumnMode`）。

**验收看点**（进累计 GUI 点验）：① 轨道五个图标能切换且选中态可辨；② 面板标题行说明当前区；
③ 点左栏会话在中栏新开 Tab、可多开、可关；④ 关 Tab 后会话仍在左栏列表里；
⑤ 顶部再无双栏/三栏与「上下文面板」按钮；⑥ 打开文件才出现右栏，展开能盖住中栏。

### U16 — 上下文页图形化与折叠 — **Done**（2026-09-05）

按 [D08](./decisions/008-vscode-dock-shell.md) 决定五：环形（总占比）+ 堆叠条（分项构成）；
「对话构成」默认折叠 + 展开后限制条数（前 N 条 + 显示更多）。

**边界不变**：数据源仍是本窗口已加载的消息（U07 确立），措辞继续点明；
真实 token 占用已由 U06-b（2026-09-05）落在 **Run 面板**，两张图刻意不合并：单位不同（字符 vs token），
混在一个环里读者无从分辨哪半是实测。本图仍不把字符数印成 token 数。
**落地形态**：环形图画的是**角色构成**（`pathLength=100`，弧长即图例百分比），不是窗口占用率；
折叠与限条数**两条都做**——只折叠挡的是第一眼，300 轮会话展开一次照样渲染 300 行。

**证据**：[U15/U16 evidence](./evidence/2026-09-05-u15-u16-vscode-dock-shell.md)。
**欠项**：GUI 点验（本批次尝试过，真实窗口起不来，详见 evidence 第六节）；
fullscreen diff 会一并藏掉会话 Tab 条（可恢复，备选方案已记录）；多会话并发未在真机验证。

## Done — 批次 1–7

### U00 — 开工前实况核查 — **Done**

盘清「已有 vs 真缺口」，避免重做已存在的能力。结论见 [current-state-audit](./topics/current-state-audit.md)。

**关键结论**：复制按钮、模型二级菜单、Context 面板、思考强度控件**都已存在**；真缺口是 Run 面板、请求优先级、思考强度词汇对不上 Pi、必须绑定目录才能开聊、TUI 不收右栏、左栏无插件/资源入口、无双栏/三栏模式开关。

### U01 — 样式层密度与字体对齐 — **Done**（2026-09-03）

- **U01-a Done**：`--text-markdown` 15→14、`--text-code` 13→12、radius sm/md/lg 8/12/16→6/10/12、
  `body` 补 14px/1.45。`--text-meta`、`--radius-xs`、`html` 的 16px rem 基准与 markdown 的
  `leading-relaxed` 均刻意不动。
- **U01-b Done**：亮暗两套 surface 只改 OKLCH 的 L 分量，色相彩度不动。暗色 canvas→panel 从 0.0216 L
  拉到 0.0639 L（1.05:1 → 1.18:1），panel→hover 取 pix 自己的 0.043 L。秩序不变，对比度实测留档。
- **U01-c 三项全部未改（已收尾）**：Composer 内距按 D03 先例保持 8px；侧栏宽 / 右面板宽 / 阅读栏宽
  属布局尺寸、不在 D01 授权内，[Q11](./open-questions.md) 已由用户拍板**维持现值**。
- **U01-d Done**：`docs/design-system.md` 的圆角表、字号表、阅读栏推导三处同步。

**证据**：[U01 style baseline](./evidence/2026-09-03-u01-style-baseline.md)（含对比度实测数字、门禁结果与 GUI 点验）。
**GUI 点验 Pass**：用户在真实窗口肉眼确认，事先标注的 hover 可分辨度代价未构成问题。**本任务无欠项。**

### U09 — Composer 形态 — **Done**（2026-09-03）

- **U09-1 Done**：空会话摘列改为与输入卡接合的顶盖（`mx-3` 内缩、`rounded-t-md`、`bg-muted`、
  `h-7` 容器），卡片有顶盖时顶角降到 `rounded-t-xs`。无 targetable workspace 时卡片类串**逐字节不变**。
- **U09-2 Done**：底栏顺序落成导出数据（`COMPOSER_BAR_LEADING` / `COMPOSER_BAR_TRAILING`），
  两个分支 map 渲染。`modelEffort` 与发送键移入尾部锚定组。
  `permission` / `usage` 两槽留空且渲染 `null`，分别归 U12 与 T38。
- **组件形态对照表**（原 U09 主体）已于 2026-09-03 产出并逐条拍板，见
  [evidence-u09](./topics/evidence-u09-component-forms.md)：6 件里 5 件判定「不搬」。

**证据**：[U09 Composer 形态](./evidence/2026-09-03-u09-composer-form.md)（含门禁数字与一次变异验证）。
**欠项**：GUI 点验未做，建议与 U12 合并做一次（非取证型验收，不阻塞）。

> 用户诉求原话（本计划的根本判据，不随 U09 收尾而失效）：整体布局、内容展示、
> 聊天输入框及小控件、输出内容展示形式，总体感受是「**功能齐全，同时保证利落简约**」。

### U12 — 会话级权限档 chip — **Done**（2026-09-03）

Composer 底栏左侧的权限控件，四档（只读/务实/放手/完全放开）、作用于**当前对话**。

- 共享类型 `SessionPermissionTier`（4 档 + 守卫函数）
- 内联扩展 `sessionTierAuthorizer`：纯判定函数 `verdictForTier` + `permissions:ready` 注册
- `authorizerChain` 配置加入 `aiclient-session-tier` 链环
- IPC 转发 `chat:setPermissionTier` → Worker RPC `worker.setPermissionTier`
- 渲染器 `ComposerPermissionTrigger`：鬼影芯片 + 四选 RadioItem + 危险档确认对话框
- 测试：verdict 判定覆盖 4×7（含 release-blocker `path`/`external_directory`）、RPC 正反例、bar slot 静态扫描

**两条硬边界实测通过**：① delegation envelope 将 `path`/`external_directory` 上的 `allow` 降级为 `defer`；
② "完全放开"文案明确声明保留密钥防线与跨目录确认。commit `c17c2e9f`。

**2026-09-03 缺陷修复**（[evidence](./evidence/2026-09-03-u12-tier-spawn-drift-fix.md)）：档位原本只在用户点击那一刻推送一次，
从未在 worker 建好后重放，导致两处「芯片显示 ≠ 运行时实际」且方向都是**实际更宽松**——
① 首次发送前设的档位被静默丢弃（那时还没有 worker 可推）；② 崩溃重启后 authorizer 重建，回落默认档。
修法是把档位并入 spawn（与 U05 的 `unbound` 同路），`ManagedSlot.tier` 让它活过重启；
fork **不**继承档位（与 `unbound` 相反，理由见 evidence §三）。

**欠项**：GUI 点验未做，建议与 U09 合并做一次（非取证型验收，不阻塞）。

### U02 — 双栏 / 三栏布局模式开关 — ~~Done~~ **Superseded by [D08](./decisions/008-vscode-dock-shell.md)**（2026-09-05）

> 整片作废并从代码中删除：surface 迁入左栏容器后，「要不要第三列」这个问题没有第二个答案了。
> 这是本计划第一次删掉一片已验收的功能，原因是上层布局形态被推翻，不是它做错了。
> 下方保留原始理由与落地记录。

`PersistedShellLayout` 新增 `shellColumnMode`（默认 `three-column`）。双栏 = 只承担 AI 对话与 AI 开发，
rail 收敛到 `context` 一件（[D02](./decisions/002-layout-cwd-and-evidence-scope.md) 决定一，解 [Q05](./open-questions.md)）。
收敛判定 `isSurfaceAvailableInColumnMode` 下沉 `surfaceRegistry`，一处过滤贯穿 rail 显示 + 快捷键 + reducer guard；
`reduceColumnModeChange` 切模式时把非 context 活动面换成 context 且不碰 `railOrder`（往返无损）。`MainHeader` 加切换按钮。

- **字段命名偏差**：execution-plan 原文 `layoutMode` → 实际 `shellColumnMode`，避开 settings 既有 `LayoutMode`（`columns`/`tree`）。见 [evidence §二](./evidence/2026-09-03-u02-u03a-column-mode.md)。

**证据**：[U02+U03-a evidence](./evidence/2026-09-03-u02-u03a-column-mode.md)。**欠项**：GUI 点验（合并做）。

### U05 — 免绑定工作目录直接开聊 — **Done**（2026-09-03）

新增 `ScratchWorkspaceService`（Main）：逐会话隔离临时目录，首次发送/首次开 TUI 时惰性创建，
归档即删、退出清空、启动再清一次（覆盖崩溃）。基路径复用「临时会话路径」设置，Main 独占决定，渲染器无从指定。

- **U05-a Done**：`<临时会话基路径>/unbound-sessions/<uuid>`，`mode 0700`；`adopt()` 让跨运行恢复拿到存在的空目录，
  并拒绝任何越界路径。
- **U05-b Done**：`deriveChatEmptySurface` 新增 `unbound` 分支（跳过「没目录」但继续下落到会话检查）；
  `canSend`/`runSend` 的 `!cwd` 硬闸拆除，隔离目录在握手 try 内分配；欢迎卡由「替换输入框」改为「在输入框上方」；
  头部 `Temporary` 徽标 + 侧栏 `temporary` chip 两处标识。
- **U05-c Done**：档位默认务实（每次弹窗），项目信任强制关闭（持久授权无处可写）。
  `unbound` 由 Main 从 `isScratchPath` 推出、**只能减不能加**，且随 `ManagedSlot` 走过崩溃重启、恢复与 fork。
- **U05-d Done**：全仓 260 files / 4031 tests 全绿。

**证据**：[U05+U03-b evidence](./evidence/2026-09-03-u05-u03b-unbound-chat.md)（含变异验证与两处计划偏差说明）。
**两处偏差**：① 隔离目录落在用户主目录下的临时基路径（用户 2026-09-03 拍板，覆盖 execution-plan 验收①的字面要求）；
② 退出会删掉 agent 写在临时目录里的文件（对话历史不受影响）。
**欠项**：GUI 点验（合并做）；跨重启可见性由 [D04](./decisions/004-unbound-session-index-visibility.md) 拍板后转 **U13** 单独落地。

### U03-b — TUI 解除目录强绑定 — **Done**（2026-09-03）

`presentationMode === 'tui' && activeWorkspacePath` 换成 `&& effectiveCwd`，`AgentTerminal` 的 `cwd` 同步；
`openTui` 先确保隔离目录再切模式，失败弹 toast 而不是开一个没有目录的终端。头部工具条显示条件同步放宽，
否则免绑定会话看不到 GUI/TUI 开关。

**证据**：同上 evidence。**欠项**：GUI 点验（合并做）。

### U08-2 — 思考档扩到 Pi 七档 — **Done**（2026-09-03）

思考档词汇从 Claude 的 `EffortLevel`（五档）补齐为 Pi 的 `ThinkingLevel`（七档，加 `off` / `minimal`）。

- `SESSION_EFFORT_LEVELS` 与 `CHAT_EFFORTS` 补两档；后者改为由前者 `map` 派生，成员与顺序不再是第二份手抄。
- **比计划多改五处**：五词清单在边界校验处还有三份独立拷贝。其中
  `workerRpc.ts` 的 `isWorkerEffort` 是**发布级**——它返回 false 会让整条 bootstrap 载荷判非法，
  带 `off` 的会话根本起不来，不是「档位不生效」。另有 `piUtilityRunner` 静默丢档、
  `PiThinkingLevel` 缺 `off`、`git.ts` 三处未校验强转。三份拷贝现已统一走 `isSessionEffortLevel`。
- **`off` 在两条路径上不对称**（取证发现）：Pi 依赖树里有两个同名 `ThinkingLevel`——
  `pi-agent-core` 七档（聊天路径，含 `off`），`pi-ai` 六档（AI 功能的一次性补全，无 `off`）。
  后者遇 `off` 省略字段而非替换成 `minimal`。
- **迁移是超集不是迁移**：旧五档是新七档真子集，已存偏好逐字不变，无需翻译、不回写。
- `off`（发 `effort:'off'`）与 `default`（不发字段，Pi 用 `medium`）语义相反，各有断言守住。

**证据**：[U08-2 evidence](./evidence/2026-09-03-u08-2-thinking-levels.md)（含变异验证、七档门禁数字与三项欠项）。
**欠项**：GUI 点验（合并做）；真账号回合未验；AI 功能路径的 `off` 需走 Pi 模型配置层才能真正关推理。

### U03-a — TUI 收起右侧栏 — **Done**（2026-09-03）

`WorkspaceShell` 在 `presentationMode==='tui'` 时收起右栏与 editor 列，终端独占 center。未动 `ChatWorkspace`
的 `openTui`/`openGui`/`piTui.dispose` 交接，D19 单写者不变；退出 TUI 后持久 surface/columnMode 未被改写、自动恢复。
**U03-b（解除目录强绑定）仍属批次 4**，依赖 U05 的隔离 cwd。

**证据**：同上 evidence。**欠项**：GUI 点验（合并做）。

### U14 — 壳层横条重排与双栏收敛 — **Done**（2026-09-04）

用户看到实际界面后提出：顶栏、中右侧横栏、右侧图标栏「十分的不协调，显得软件很臃肿」，
并以 `docs/design/a10-pix-ui-alignment-prototype.html` 的形态为准。按
[D07](./decisions/007-two-column-is-two-columns-and-one-bar-per-column.md) 落地。

- **中栏 3 层横条 / 104px → 2 层 / 68px**：`ChatWorkspace` 的 h-9 头整条删除，
  内容上交 `MainHeader`；`MainHeader` 不再贯通中右，移入中栏。
- **`MainHeader` 按钮 7 → 3**：surface 切换的四个无标签图标搬进右栏自己的**文字 tab 条**；
  宽阅读栏进设置；剩「收/开面板 · 双栏⇄三栏 · GUI｜TUI」。
- **双栏真的只有两列**（推翻 D02 决定一 + D05）：`columnModeHasPanel` 为假时不渲染
  `ContextPanel`——`visible={false}` 的 0 宽盒子仍会画出 1px 的 `border-l`。
  **代价**：U06-a / U07 在双栏下不可达，`Ctrl/Cmd+1..4`、`Ctrl/Cmd+J` 在双栏下失效。
- **顶栏 5 件 → 3 件**：设置与用户胶囊下沉左栏底部（顺带修好 macOS 上胶囊完全不可达的平台缺口）。
- **GUI/TUI 不与列数合并**：两个 store、两条持久化，合成三选一需要藏一个「上一个非 TUI 档」。

**证据**：[U14 evidence](./evidence/2026-09-04-u14-shell-chrome-realignment.md)（含四条变异验证、
9 个测试文件 24 条断言的改写理由，以及第一版做法被依赖方向守卫判红的记录）。
**欠项**：GUI 点验（合并做）。

### U13 — 免绑定会话跨重启可见性 — **Done**（2026-09-04）

免绑定会话重启后在侧栏消失（索引行还在，`mergeSessionIndex` 判为 orphan 丢弃）。既有缺口，被 U05 从罕见放大为常见。
按 [D04](./decisions/004-unbound-session-index-visibility.md) 走索引标记：`SessionIndexEntry` 加可选 `unbound?: boolean`，
Main 按 `isScratchPath` 写入，`mergeSessionIndex` 在 orphan 分支之前拦下并合成「临时对话」分组。

- **比 D04 多两处落点**，都是「可见」与「能打开」之间的缺口：
  ① `chat:ensureScratchWorkspace` 重启后必须**认领**索引里记着的目录——否则新分配的 uuid 目录会让
  resume 撞上 `pi_session_workspace_mismatch`，会话看得见却打不开；
  ② `ChatSession` 加 `unbound?: { workspacePath }`，因为 resume 需要一个精确路径，而 scratch 目录**按设计**不是 workspace。
- **写入规则**：两个 IPC 入口都从自己即将写入的那个路径推出布尔值，显式 `false` 清除标记、`undefined` 才保留旧值——
  只有 `?? existing?.unbound` 会让改绑真实目录的会话永远粘着标记。
- **老行不回填**（D04 明确），批次 4 之前的免绑定会话仍不可见，属已知残留。

**证据**：[U13 evidence](./evidence/2026-09-04-u13-unbound-session-visibility.md)（含四条变异验证与五条验收对照）。
**欠项**：GUI 点验（合并做）；真机「聊天→退出→重开→点开」未跑。

## 已完成切片的范围与拍板出处

下方保留任务身份、范围边界与拍板出处；验收标准与改动落点在
[execution-plan](./topics/execution-plan.md) 与各自的 evidence 里，**不要**在本文件复制。
本节的条目全部已落地（含 U06-b，2026-09-05 随 Pi 计划 T38 同批）。

### U02 — 双栏 / 三栏布局模式开关 — **已完成**（见上方 Done · U02）

### U03 — TUI 模式收起右侧栏 — **已完成**（U03-a / U03-b 均见上方 Done）

### U04 — 左栏插件入口 — **Done**（2026-09-04）

对照 pix 的 `nav-packages`（带 MCP 就绪数徽标）与 `nav-resources`（带计数徽标）。

**拍板**（用户 2026-09-03）：pix 的「插件」是包管理（本地已装插件，可禁用/更新/移除），「资源」是文件清单（index.js / extension.js / agent.md）——**不是重叠，是两个视角**，但资源页目前没用。本轮左栏只加「插件」入口（含 MCP 就绪徽标），**资源入口不做**。证据见 [evidence §Q03](./topics/evidence-q02-q03.md)。

**落地形态**（[U04 evidence](./evidence/2026-09-04-u04-plugin-entry.md)）：入口是底栏 Settings 旁的一枚 chrome 按钮 + 对话框，
不是 pix 那种一级导航。清单来自 worker 上报的「这个会话实际加载了什么」（[D06](./decisions/006-plugin-inventory-source.md)）；
MCP 就绪数按 pix 同一套办法，从扩展自己发布的状态行解析（那不是 MCP API）。
`null`（没人报告过）与 `[]`（报告了、一个都没加载）在 UI 上是两句不同的话；没数据时不渲染徽标。
**只可见、不可管**：启用/禁用/更新/移除要走 pi 的 `PackageManager`，不在本片范围。

### U05 — 免绑定工作目录直接开聊 — **已完成**（见上方 Done · U05）

### U06 — Run 面板 — U06-a **Done**（2026-09-04）/ U06-b **Done**（2026-09-05）

新增 `run` surface，参照 pi-app 的 `features/run/run-panel.tsx` + `context-donut.tsx`：运行态状态机、模型、思考档、回合耗时、上下文占用环形图。

**边界已取证**（[evidence-q04](./topics/evidence-q04-runtime-fields.md)）：状态机/模型/选中 effort/耗时/工具**名称**渲染层可拼（现有 `RuntimeEvent` + store）；**占用 % + usage 行**需 Pi runtime 补 `usage.updated`（schema 已有、worker 不发）且目录剥离 `contextWindow`——**归 Pi-only 计划**。因此 U06 分两半：先做渲染层能拼的，占用 donut/usage 行留待 Pi runtime 补字段后做（或作为 Pi 计划 task）。

**U06-b 落地形态**（2026-09-05，与 [T38](../pi-backend-migration/roadmap.md) 同批，
[evidence](../pi-backend-migration/evidence/2026-09-05-t38-runtime-usage-fields.md)）：
占用环 + used/free/window 图例 + usage 行（全部标「上一回合」，因为 pi 的 usage 是单回合的账，
求和会打印出没人收过的费）；U09-2 预留的底栏 `usage` 槽由 `ComposerUsageChip` 填上（只显 `68%`，
tooltip 给绝对值）；T38-c 的工具状态行接到工具名下方。

**环形图只有 used/free 两段，不按角色分色**（pi-app 有）——pi-app 的角色份额是字符数除以 4 估的，
照抄会把实测总量与估算切分放进同一个环。按角色的视图留在 Context 页构成图，那张图单位是**字符**。
同理 Context 页构成图**没有**改成 token 分母，原处「T38 落地后本图获得真实分母」的注释已改成这条决定。

**U06-a 已落地**（见 [批次 6 evidence](./evidence/2026-09-04-u06a-u07-run-and-context-panels.md)）：
新 `run` surface，状态映射是一张全映射 `Record`（加第十个运行时状态会编译失败，不会被默认分支吞掉），
`running` 之上再叠 tool / thinking 一层。跨会话串数据的防线放在纯函数里（单槽 `turnSendStatus` 按 `sessionId` 比对后丢弃）。
**没有**占用/usage 的任何字段或空壳，等 T38。双栏下可见，见 [D05](./decisions/005-two-column-run-surface.md)。

### U07 — Context 面板内容增强 — **Done**（2026-09-04，范围本次定死）

`context` surface 已存在，本项是对照 pi-app 的 `features/context/context-panel.tsx` 做内容层增强。
**本次交付**：分角色构成（各角色字符数与占比，时间线看不到的信息）+ 逐段展开（一条消息一行，点开看正文，2000 字符封顶）。
数据源是**本窗口已加载的消息**，措辞处处点明这一点——pi-app 读的是会话文件的 context 条目，那要新增 `context.preview` 对应 IPC，超出本计划边界。

**刻意未做**：① token 估算——execution-plan 已写明随 U06-b 解锁，`字符/4` 印成 `~1.2k tok` 会像运行时报的数；
② 手动刷新按钮——本仓这份数据是实时 store，不是一次性快照，放按钮是装饰。
两条理由见 [批次 6 evidence](./evidence/2026-09-04-u06a-u07-run-and-context-panels.md) §二。

### U08 — 模型选择器对齐 — U08-1（无需改动）/ U08-2（**Done**）/ U08-3（Dropped，见 [Q12](./open-questions.md)）

三件事，宜拆成独立切片：

1. 确认二级菜单的分组键（现按 `tags[0]`）。**拍板为保留现状**（用户 2026-09-03：保留使用管理站主页分组标签）——`tags[0]` 本就是管理站主分组标签，不改分组键。
2. ~~思考强度词汇改为 Pi 的 `ThinkingLevel`~~ — **Done**（见上方 Done · U08-2）。
   开工前判定的「真缺口只有两个常量」在**显示层**成立，但边界校验处另有三份五词拷贝，
   其中一份是发布级；落地记录见 [evidence](./evidence/2026-09-03-u08-2-thinking-levels.md)。
3. ~~新增请求优先级（`flex` / `default` / `priority`）~~ — **Dropped**（[Q12](./open-questions.md) 用户拍板不做）。
   取证（[evidence-q09](./topics/evidence-q09-service-tier.md)）证实透传通道存在但挂在「模型静态默认值」层
   而非「每次请求」层；补那一层的代价、以及该参数只对 OpenAI 系生效的适用面，都撑不起这个次要控件。
   重开时优先走路径 A。

## Deferred

### U10 — 消息「回退」操作

pi-app 有。用户明确列为非最高优先级（D01 决定三）。注意本仓已有会话树 rewind 能力（Pi 计划 T33），本项是消息级操作入口，不是重建能力。

### U11 — 消息「在新会话中继续」

pix 有。同上，非最高优先级。本仓已有 fork 能力（Pi 计划 T33-c），本项同样是操作入口问题。

## 依赖

```text
Pi 计划 T37 收口 ✅ 2026-09-03
  → U01 样式地基 ✅ 2026-09-03（U01-a/b/d 落地；U01-c 三项转 Q11）
      ├→ U09-1 空态摘列 ✅ → U09-2 底栏顺序 ✅ → U12 权限档 chip ✅（占底栏左侧位）
      └→ U02-a 模式字段 ✅ → U02-b 双栏收敛 ✅ → U03-a TUI 收右栏 ✅
                                              → U05-a/b/c/d 免绑定开聊 ✅ → U03-b TUI 解绑 ✅
                                              → U13 免绑定会话跨重启可见性 ✅ 2026-09-04（承 U05 的 unbound 语义）
  → U08-2 思考档七档 ✅ 2026-09-03（无前置）
  → U06-a Run 面板渲染层 ✅ 2026-09-04（挂载位由 U02 的模式语义决定，D05）→ U07 Context 增强 ✅ 2026-09-04
  → U04 左栏插件入口 ✅ 2026-09-04（无前置，可交错；清单来源见 D06）

跨计划：
  U06-b 占用 donut/usage 行 ← Pi 计划 T38-a/b（D03 决定二已移交）

已放弃：
  U08-3 请求优先级          ← Q12 拍板不做
```
