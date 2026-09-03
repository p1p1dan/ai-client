# Roadmap — pix/pi-app UI 对齐改造

> 本文件是本计划任务 ID、状态与顺序的唯一权威。
> [D01](./decisions/001-style-depth-and-sequencing.md) 决定二的排期闸门**已解除**：Pi-only 计划 T37 于 2026-09-03 收口
> （manual CI run `33714362901` 全绿），本计划可以开工。
> 切片划分、批次顺序、逐片验收标准与门禁见 [execution-plan](./topics/execution-plan.md)；本文件只维护任务身份与状态。

## 状态摘要

| 分组 | 数量 | 说明 |
|---|---|---|
| Done | 6 | U00：实况核查；**U01：样式地基**（[evidence](./evidence/2026-09-03-u01-style-baseline.md)）；**U09：Composer 形态**（[evidence](./evidence/2026-09-03-u09-composer-form.md)）；**U12：会话权限档**（2026-09-03）；**U02：双栏/三栏布局模式**、**U03-a：TUI 收右栏**（[evidence](./evidence/2026-09-03-u02-u03a-column-mode.md)） |
| In Progress | 0 | — |
| Ready（已切片，可开工） | 3 | U03-b（依赖 U05）、U04、U05 |
| Ready（部分） | 2 | U06-a、U08-2 可开工 |
| Scope 待细化 | 1 | U07（建议在 U06-a 后定范围） |
| Moved out | 1 | U06-b → Pi 计划 T38（[D03](./decisions/003-sidebar-density-and-runtime-field-ownership.md) 决定二） |
| Dropped | 1 | U08-3 请求优先级（[Q12](./open-questions.md) 拍板不做） |
| Deferred | 2 | U10–U11 |

**执行顺序**（批次，详见 execution-plan）：
`U01 ✅ → U09 ✅ → U12 ✅ → U02+U03-a ✅ → U05+U03-b → U08-2 → U06-a+U07 → U04`。批次 5、7 可与 3/4 交错，但都不得与 U01 并行。
U12 紧跟 U09：底栏顺序对齐要给权限 chip 留出左侧位置，先排位再插控件，同一块 JSX 只改一次。

**未决：无。** Q01–Q12 全部关闭（Q08/Q10 见 [D03](./decisions/003-sidebar-density-and-runtime-field-ownership.md)；
Q09 由取证关闭；Q11 布局尺寸维持现值；Q12 请求优先级不做）。

## Done

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

**欠项**：GUI 点验未做，建议与 U09 合并做一次（非取证型验收，不阻塞）。

### U02 — 双栏 / 三栏布局模式开关 — **Done**（2026-09-03）

`PersistedShellLayout` 新增 `shellColumnMode`（默认 `three-column`）。双栏 = 只承担 AI 对话与 AI 开发，
rail 收敛到 `context` 一件（[D02](./decisions/002-layout-cwd-and-evidence-scope.md) 决定一，解 [Q05](./open-questions.md)）。
收敛判定 `isSurfaceAvailableInColumnMode` 下沉 `surfaceRegistry`，一处过滤贯穿 rail 显示 + 快捷键 + reducer guard；
`reduceColumnModeChange` 切模式时把非 context 活动面换成 context 且不碰 `railOrder`（往返无损）。`MainHeader` 加切换按钮。

- **字段命名偏差**：execution-plan 原文 `layoutMode` → 实际 `shellColumnMode`，避开 settings 既有 `LayoutMode`（`columns`/`tree`）。见 [evidence §二](./evidence/2026-09-03-u02-u03a-column-mode.md)。

**证据**：[U02+U03-a evidence](./evidence/2026-09-03-u02-u03a-column-mode.md)。**欠项**：GUI 点验（合并做）。

### U03-a — TUI 收起右侧栏 — **Done**（2026-09-03）

`WorkspaceShell` 在 `presentationMode==='tui'` 时收起右栏与 editor 列，终端独占 center。未动 `ChatWorkspace`
的 `openTui`/`openGui`/`piTui.dispose` 交接，D19 单写者不变；退出 TUI 后持久 surface/columnMode 未被改写、自动恢复。
**U03-b（解除目录强绑定）仍属批次 4**，依赖 U05 的隔离 cwd。

**证据**：同上 evidence。**欠项**：GUI 点验（合并做）。

## Ready

条目已在 [execution-plan](./topics/execution-plan.md) 里切成可执行片并配了验收标准。下方只保留任务身份、范围边界与拍板出处；
**不要**在本文件复制验收标准或改动落点。

### U02 — 双栏 / 三栏布局模式开关 — **已完成**（见上方 Done · U02）

### U03 — TUI 模式收起右侧栏 — U03-a **已完成**（见上方 Done · U03-a）/ U03-b（依赖 U05，属批次 4）

U03-b 目标：把 `ChatWorkspace.tsx` 的 `presentationMode === 'tui' && activeWorkspacePath` 后半条件换成「已有可用 cwd」，
让免绑定会话（U05-a 的隔离 cwd）也能进 TUI，且 TUI 的 cwd 就是该会话的隔离目录。与 U05 合并在批次 4 做。

### U04 — 左栏插件 / 资源入口 — 单切片 — **已拍板：只保留插件，资源不要**

对照 pix 的 `nav-packages`（带 MCP 就绪数徽标）与 `nav-resources`（带计数徽标）。

**拍板**（用户 2026-09-03）：pix 的「插件」是包管理（本地已装插件，可禁用/更新/移除），「资源」是文件清单（index.js / extension.js / agent.md）——**不是重叠，是两个视角**，但资源页目前没用。本轮左栏只加「插件」入口（含 MCP 就绪徽标），**资源入口不做**。证据见 [evidence §Q03](./topics/evidence-q02-q03.md)。

### U05 — 免绑定工作目录直接开聊 — 切片 U05-a/b/c/d

新增不绑定项目即可发送的路径，并保留引导提示：开发场景仍优先绑定工作目录。

**cwd 与信任态已拍板**（[D02](./decisions/002-layout-cwd-and-evidence-scope.md) 决定二）：cwd 落隔离临时目录，默认**不信任**、逐次授权、写路径默认拒绝；UI 上需区别于工作态会话（解决 [Q01](./open-questions.md)）。

### U06 — Run 面板 — 切片 U06-a（Ready）/ U06-b（已移交 Pi 计划 T38）

新增 `run` surface，参照 pi-app 的 `features/run/run-panel.tsx` + `context-donut.tsx`：运行态状态机、模型、思考档、回合耗时、上下文占用环形图。

**边界已取证**（[evidence-q04](./topics/evidence-q04-runtime-fields.md)）：状态机/模型/选中 effort/耗时/工具**名称**渲染层可拼（现有 `RuntimeEvent` + store）；**占用 % + usage 行**需 Pi runtime 补 `usage.updated`（schema 已有、worker 不发）且目录剥离 `contextWindow`——**归 Pi-only 计划**。因此 U06 分两半：先做渲染层能拼的，占用 donut/usage 行留待 Pi runtime 补字段后做（或作为 Pi 计划 task）。

### U07 — Context 面板内容增强 — Scope 待细化（建议在 U06-a 后定）

`context` surface 已存在，本项是对照 pi-app 的 `features/context/context-panel.tsx` 做内容层增强（分角色分段、token 估算、逐段展开、手动刷新）。范围待定：不是重建面板。

### U08 — 模型选择器对齐 — U08-1（无需改动）/ U08-2（Ready）/ U08-3（Blocked，见 [Q09](./open-questions.md)）

三件事，宜拆成独立切片：

1. 确认二级菜单的分组键（现按 `tags[0]`）。**拍板为保留现状**（用户 2026-09-03：保留使用管理站主页分组标签）——`tags[0]` 本就是管理站主分组标签，不改分组键。
2. 思考强度词汇改为 Pi 的 `ThinkingLevel`（补 `off` / `minimal`），并按当前模型过滤可用档位。**范围已收窄**（2026-09-03 复核，见 [execution-plan §一](./topics/execution-plan.md)）：按模型过滤与 config 层七档**已经存在**，真缺口只有 `SESSION_EFFORT_LEVELS` 与 `CHAT_EFFORTS` 两个五档常量。**迁移规则已取证**（[evidence-q06](./topics/evidence-q06-migration.md)）：复制 pix 的「纯 mapper + read 时映射」模式；`EffortLevel` 与 `ThinkingLevel` 重叠值（low/medium/high/xhigh/max）保留原样，只教 store 认识 `off`/`minimal`；未知/垃圾值 → `default` 哨兵（不是 `off`）；**不静默重写**已存偏好。
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
                                              → U05-a/b/c/d 免绑定开聊 → U03-b TUI 解绑
  → U08-2 思考档七档（无前置，可交错）
  → U06-a Run 面板渲染层（需 U02 的模式语义确定挂载位）→ U07 Context 增强
  → U04 左栏插件入口（无前置，可交错）

跨计划：
  U06-b 占用 donut/usage 行 ← Pi 计划 T38-a/b（D03 决定二已移交）

已放弃：
  U08-3 请求优先级          ← Q12 拍板不做
```
