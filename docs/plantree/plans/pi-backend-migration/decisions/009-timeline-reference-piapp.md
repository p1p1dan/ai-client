# D9 — 时间线交互参照 pi-app：皮肤风格保留，实现大胆取用（rev.2）

> rev.1（2026-08-28 上午）原拍板「参照机制不抄代码」。**同日 rev.2 由用户当场修正两条**（原话大意：「我没说不抄代码，能直接抄来用当然就抄来用，省时间省 token」「布局什么的也可以适当调整，不能说参考没有的按钮功能我们有，就非得再单独实现，那些可以丢后面去。保证前端设计风格就行。但气泡输出展示他们的效果也可以学习参考，我感觉我们的气泡现在有点丑」）。
> rev.2 新增第三条：**权限审批要加上**（用户：「权限审批是肯定要加上的，我记得有对应的高分插件」——已核实为 `@gotgenes/pi-permission-system`，见 §三）。
> 调查与映射表见 [topics/timeline-reference.md](../topics/timeline-reference.md)。

## 拍板内容（rev.2，三加一改）

**1.（保留 rev.1）皮肤风格保留**：设计令牌、@coss/ui 组件体系、design-system.md 的视觉语言保留——「保证我们的前端设计风格就行」。但**布局可适当调整**：凡 pi-app 没有而我们有的按钮/功能，不必急着单独实现，**可以丢到后面**（降优先级），不必为对齐旧布局束缚新实现。

**2.（修正 rev.1 的「不抄代码」）能直接抄就抄**：pi-app 是 **MIT License**（已核实 `LICENSE` 文件，Copyright 2026 justhil）——法律上允许直接复用代码。默认策略改为**直接取用/改写 pi-app 的实现**，省时间省 token；需要脱离其原始形态重写的情形（如深度耦合其 extension-compat 层或 ui-store 的部分）才走重写。**气泡观感也在学习之列**——用户自评我们的气泡「有点丑」，pi-app 的输入输出气泡效果作为对标。

**3.（新增）权限审批必须加上**：pi 轴不是「无权限审批」（rev.1 的推断错了），而是**审批由扩展承载**。采用 `@gotgenes/pi-permission-system`（MIT，本机 `~/.pi/agent/` 已装 v27.0.1，用户 settings.json 已启用）。要点：

- allow/ask/deny 三态 + bash 通配模式 + 路径横切门（`path` 规则跨所有工具与 bash，含 symlink 规避防护）+ fail-closed；
- **非 TUI 模式（我们的 utilityProcess 正是）走 `ui.select()`/`ui.input()` fallback**——即 pi SDK 扩展 UI 的 select 原语，正好落在我们 Phase 2 T08 的 Portable UI 原语上：**权限审批成为 T08 的第一个、也是最高优先级的消费者**；
- 事件面：`permissions:ui_prompt` 广播 + `permissions:decision` 应答（事件总线通道已核实 `permission-events.ts`）；
- **不复用 Claude 的 FB7 permission join，但必须实现 pi 独立审批 UI**：pi-permission-system 是四选一决策（Yes / Yes for session / No / No with reason），不是 Claude 的 Allow/Deny 卡；「旧卡不迁移」绝不等于「不做权限」。

**4.（连带）参照仓库直接取用**：将 pi-app（及 pix）纳入本地参照清单，施工切片直接开文件对照移植，而非仅读结构；substantial 复制保留 MIT copyright/license notice。

## 排序影响

- **T08（Portable UI 原语：select/confirm/input）从 Phase 2 提前**——它是权限审批的依赖，而权限审批是用户点名的功能。T12 系列之前先把 select/confirm/input 三原语 + pi-permission-system 的接入打通。
- 我们已有但 pi-app 没有的功能（按钮/交互面）降优先级排队，不阻塞主线。

## 范围声明

只定方向与授权级别，不授权立即开工。切片施工时按本仓惯例验证（typecheck/biome/vitest + 变异）；直接取用的代码须过 biome 规则（`as any` 禁用等）与 @coss/ui 边界，冲突处以本仓规则为准。
