# Topic — 扩展 UI 三级能力分层

## 核心思路

pi-agent 的扩展生态通过 `ExtensionUIContext` 接口暴露 UI 能力。桌面应用不需要完整实现所有 TUI 控件，而是按能力分层处理。

## Portable 原语 GUI 映射

| 原语 | TUI 行为 | GUI 映射 |
|------|----------|----------|
| `select` | 终端列表选择 | Searchable Command Dialog（shadcn CommandDialog） |
| `confirm` | y/n 提示 | ConfirmDialog 组件 |
| `input` / `editor` | 单行/多行终端输入 | 文本输入框 / Monaco 编辑器 |
| `notify` | 终端提示文本 | 标题栏通知 + OS 级通知（warning/error） |
| `setStatus` | 终端状态行 | 标题栏 chip + MCP 服务器 badge |
| `setWidget` | 终端小部件 | Composer 旁卡片（placement: above/below） |
| `setTitle` | 终端标题 | 窗口 / 标签页标题 |
| `setEditorText` | 终端编辑器内容 | Composer 草稿填充 |

## Semantic no-op

- `setWorkingIndicator`：接受但不做视觉处理（桌面端有自己的 loading 指示器）
- `setHiddenThinkingLabel`：产品层控制思考动画，扩展不应覆盖

## TUI-only 降级

- `custom()`：返回 `undefined`，发出 `unsupported: custom` 诊断
- `setWidget(key, Component)`：组件类型不执行，发出 `unsupported: setWidget.component`
- `setFooter` / `setHeader` / `setEditorComponent`：no-op + 诊断
- 自定义 message/entry/tool renderer：不调用，内容走 sanitized Markdown（`MarkdownContent`）

## 实现路径

1. 定义 `ExtensionUiHost` 接口（renderer 侧）
2. 实现 `extension-ui-bridge.ts`（agent-host 侧，pi SDK ExtensionUIContext → contracts 事件）
3. 实现 `generic-renderers.ts`（通用 Markdown 降级渲染）
4. 各 Portable 原语的 React 组件实现
