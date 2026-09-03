# Roadmap — pix/pi-app UI 对齐改造

> 本文件是本计划任务 ID、状态与顺序的唯一权威。
> 全部任务按 [D01](./decisions/001-style-depth-and-sequencing.md) 排在 Pi-only 计划的 T37 收口之后；
> 目前**没有任何任务在执行**，所有条目都是待细化的想法登记。

## 状态摘要

| 分组 | 数量 | 说明 |
|---|---|---|
| Done | 1 | U00：实况核查 |
| In Progress | 0 | — |
| Next（待 T37 收口后细化开工） | 9 | U01–U09 |
| Deferred | 2 | U10–U11 |

## Done

### U00 — 开工前实况核查 — **Done**

盘清「已有 vs 真缺口」，避免重做已存在的能力。结论见 [current-state-audit](./topics/current-state-audit.md)。

**关键结论**：复制按钮、模型二级菜单、Context 面板、思考强度控件**都已存在**；真缺口是 Run 面板、请求优先级、思考强度词汇对不上 Pi、必须绑定目录才能开聊、TUI 不收右栏、左栏无插件/资源入口、无双栏/三栏模式开关。

## Next

所有条目**尚未细化到可执行**，需在后续会话里逐条确定范围与验收标准。顺序是建议值，不是承诺。

### U01 — 样式层密度与字体对齐

把字号档、行高、间距档、圆角档向 pix 靠拢；**不动语义 token 名与主题机制**（D01 决定一）。落地后同步更新 `docs/design-system.md` 的 Token 分档。

**取证已回**（[evidence-u01](./topics/evidence-u01-numeric-scale.md)）：
- **可搬（不含色彩）**：markdown 15→14、code 13→12、body 行高 1.45；radius sm 8→6 / md 12→10 / lg 16→12；间距/行高 sidebar row 28→32、composer pad 12/14/4。
- **⚠️ 灰阶不可照搬**：pix 灰阶是**无彩度 hex**，AiClient Flexoki 是**暖色 OKLCH**。照搬会抹平色相。只做 **L 阶关系重映射**（canvas < sidebar < panel < hover），**不换 hex**。原 roadmap「中性灰阶向 pix 靠拢」措辞**修正**为此。

### U02 — 双栏 / 三栏布局模式开关

现状只有「关闭右面板」，没有布局模式概念（[audit §2.7](./topics/current-state-audit.md)）。需要新增持久化的模式字段（`PersistedShellLayout` + 其清洗函数同步）。

**双栏语义已拍板**（[D02](./decisions/002-layout-cwd-and-evidence-scope.md) 决定一）：双栏 = 只承担 AI 对话与 AI 开发，Files / Git / Terminal 等**刻意不提供**，需用时切回三栏。因此双栏下**不**为这些 surface 另设承载方案（解决 [Q05](./open-questions.md)）。右栏仍承载 `context`。

### U03 — TUI 模式收起右侧栏

目标形态：左栏 + 右侧整块 TUI，无第三栏。现状只换中栏（`ChatWorkspace.tsx:266`）。

**双栏语义已拍板**（[D02](./decisions/002-layout-cwd-and-evidence-scope.md) 决定一）：TUI 属双栏的专用子模式，右侧不再有其他 surface。与 U02 的模式状态机耦合，宜合并设计。

### U04 — 左栏插件 / 资源入口 — **已拍板：只保留插件，资源不要**

对照 pix 的 `nav-packages`（带 MCP 就绪数徽标）与 `nav-resources`（带计数徽标）。

**拍板**（用户 2026-09-03）：pix 的「插件」是包管理（本地已装插件，可禁用/更新/移除），「资源」是文件清单（index.js / extension.js / agent.md）——**不是重叠，是两个视角**，但资源页目前没用。本轮左栏只加「插件」入口（含 MCP 就绪徽标），**资源入口不做**。证据见 [evidence §Q03](./topics/evidence-q02-q03.md)。

### U05 — 免绑定工作目录直接开聊

新增不绑定项目即可发送的路径，并保留引导提示：开发场景仍优先绑定工作目录。

**cwd 与信任态已拍板**（[D02](./decisions/002-layout-cwd-and-evidence-scope.md) 决定二）：cwd 落隔离临时目录，默认**不信任**、逐次授权、写路径默认拒绝；UI 上需区别于工作态会话（解决 [Q01](./open-questions.md)）。

### U06 — Run 面板

新增 `run` surface，参照 pi-app 的 `features/run/run-panel.tsx` + `context-donut.tsx`：运行态状态机、模型、思考档、回合耗时、上下文占用环形图。

**边界已取证**（[evidence-q04](./topics/evidence-q04-runtime-fields.md)）：状态机/模型/选中 effort/耗时/工具**名称**渲染层可拼（现有 `RuntimeEvent` + store）；**占用 % + usage 行**需 Pi runtime 补 `usage.updated`（schema 已有、worker 不发）且目录剥离 `contextWindow`——**归 Pi-only 计划**。因此 U06 分两半：先做渲染层能拼的，占用 donut/usage 行留待 Pi runtime 补字段后做（或作为 Pi 计划 task）。

### U07 — Context 面板内容增强

`context` surface 已存在，本项是对照 pi-app 的 `features/context/context-panel.tsx` 做内容层增强（分角色分段、token 估算、逐段展开、手动刷新）。范围待定：不是重建面板。

### U08 — 模型选择器对齐

三件事，宜拆成独立切片：

1. 确认二级菜单的分组键（现按 `tags[0]`）。**拍板为保留现状**（用户 2026-09-03：保留使用管理站主页分组标签）——`tags[0]` 本就是管理站主分组标签，不改分组键。
2. 思考强度词汇改为 Pi 的 `ThinkingLevel`（补 `off` / `minimal`），并按当前模型过滤可用档位。**迁移规则已取证**（[evidence-q06](./topics/evidence-q06-migration.md)）：复制 pix 的「纯 mapper + read 时映射」模式；`EffortLevel` 与 `ThinkingLevel` 重叠值（low/medium/high/xhigh/max）保留原样，只教 store 认识 `off`/`minimal`；未知/垃圾值 → `default` 哨兵（不是 `off`）；**不静默重写**已存偏好。
3. 新增请求优先级（`flex` / `default` / `priority`），只对支持的模型暴露，与思考强度作为两根正交轴呈现。

### U09 — 组件形态对照表

对 Composer 输入框、其上的小控件、以及输出内容的渲染形式，逐件与 pix 做形态对照，产出「搬 / 不搬 / 改造后搬」的清单。**先出对照表，再逐条拍板**——D01 只授权了样式 token 层，没有授权组件形态照搬。

**对照表已产出**（[evidence-u09](./topics/evidence-u09-component-forms.md)）：6 件组件逐项判定。**核心结论：大部分不搬**——我们已有的 Codex 简约形态大多正确。其余（助手输出、用户气泡、右栏、侧栏）均为「不搬」——跳过 pix 的卡 chrome 图标、KaTeX、常显页脚、32px 侧栏行等。

**Composer 已拍板**（用户 2026-09-03，在对照表基础上加一条）：
1. 空会话顶部接合摘列（project/branch 作为卡片顶盖）——改造后搬。
2. **底部工具条布局对齐 pix**（`Composer.tsx:1618-1770` 顺序已核）：左侧「＋附件 · 权限管理」，右侧「上下文占用 · 模型 · 思考 · 发送」。控件仍用我们的 24px ghost chip 与 token，只对齐**位置与顺序**。信任态从底部摘列移入权限 chip；上下文占用 chip 依赖 Q04 的 `usage.updated`，在 runtime 补字段前先隐藏或占位；请求优先级（U08-3）不占底栏，放进模型菜单二级。可视化见 `docs/design/a10-pix-ui-alignment-prototype.html`。

用户诉求原话：整体布局、内容展示、聊天输入框及小控件、输出内容展示形式，总体感受是「功能齐全，同时保证利落简约」。

## Deferred

### U10 — 消息「回退」操作

pi-app 有。用户明确列为非最高优先级（D01 决定三）。注意本仓已有会话树 rewind 能力（Pi 计划 T33），本项是消息级操作入口，不是重建能力。

### U11 — 消息「在新会话中继续」

pix 有。同上，非最高优先级。本仓已有 fork 能力（Pi 计划 T33-c），本项同样是操作入口问题。

## 依赖

```text
Pi 计划 T37 收口
  → U01 样式层
  → U02 布局模式 ─┬→ U03 TUI 收右栏
                  └→ U04 左栏入口
  → U05 免绑定开聊（cwd/信任态已拍 [D02]，切片时细化实现）
  → U06 Run 面板（需 Q04 取证）
  → U07 Context 增强
  → U08 模型选择器（三个子切片可独立；U08-1/Q02、U08-2/Q06 取正中）
  → U09 组件形态对照（产出对照表后再派生任务）
```
