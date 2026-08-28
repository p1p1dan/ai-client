# D2 — 插件策略：三级能力分层

**状态**：已拍板（2026-08-28）

## 决策

扩展 UI 兼容采用三级能力分层（Portable / Semantic no-op / TUI-only），而非逐个扩展写适配器。

## 三级定义

| 级别 | 行为 | 示例 |
|------|------|------|
| **Portable** | 桌面/TUI 均有完整实现 | select, confirm, input/editor, notify, setStatus, setWidget, setTitle |
| **Semantic no-op** | 接受调用但无视觉效果，不报错 | setWorkingIndicator, setHiddenThinkingLabel |
| **TUI-only** | 不执行，发出 `unsupported` 诊断，明确告知用户 | custom(), setFooter/setHeader, setEditorComponent |

## 理由

1. 新扩展自动可用，不需要逐个写适配器
2. 降级行为透明——TUI-only 功能明确告知用户不支持，不静默伪装
3. 如果后续有特定扩展需要富 UI（如看板），可按需写专属渲染器（opt-in），不影响整体框架
4. 维护成本远低于 pi-app 的 45 个适配器

## 影响

- Phase 2 需要实现 Portable 原语的 GUI 版本
- Phase 2 需要实现降级诊断机制
- 后续按需为高价值扩展添加专属渲染器
