# Open Questions — Pi Backend Migration

## 已解决

### ~~Q1 — pi SDK 的进程模型选择~~ → D3 (rev2)

直接走 utilityProcess + MessagePort，不经过独立 Node 进程中间态。pix 已验证此路径可行。

### ~~Q2 — pi SDK 认证流程~~ → D4

双路径：企业自动注入 + 本地 GUI 配置窗口。与 unified-credentials S4 对接。

### ~~Q3 — 现有 Claude/Codex 功能的保留策略~~ → D5

先屏蔽（代码不删，配置项控制），后续可切回。

### ~~Q4 — 扩展兼容范围~~ → D6

TUI-only 插件通过模式切换使用。Phase 2 前做一次主流扩展 UI 原语调研仍有价值，但不阻塞。

## 已解决（续）

### ~~Q5 — pi SDK 打包进安装包~~ → D7

pi SDK 是纯 JS 包（21.4MB），无平台二进制。作为 npm 依赖安装，esbuild external + node_modules 子树随 Electron 打包。体积 ~40-60MB，远小于 Codex 的 ~300MB。

## 未解决

（暂无阻塞性未决问题。Phase 2 前需做一次主流扩展 UI 原语调研，但不阻塞 Phase 1。）
