# D6 — TUI-only 插件通过模式切换使用，后续按需写 GUI 渲染器

**状态**：已拍板（2026-08-28）

## 决策

纯 TUI 插件（如 pi-trellis-kanban）在 GUI 模式下降级并告知用户，用户可切换到 TUI 模式完整使用。后续按需为高价值插件写专属 GUI 渲染器。

## 背景

pi-trellis-kanban 等插件使用 `@earendil-works/pi-tui` 的 Component 接口做自定义渲染（四泳道网格、键盘导航），属于三级能力分层的 TUI-only 级别。

## 用户体验

- **GUI 模式**：发 `unsupported: custom` 诊断，UI 提示"此功能需切到 TUI 模式"
- **TUI 模式**：xterm 直通，插件完整可用
- **一键切换**：Phase 4 实现

## 后续增量

为特定高价值插件（如看板）写专属 GUI 渲染器，将其从 TUI-only 提升为 Portable，是 opt-in 增强而非必须。
