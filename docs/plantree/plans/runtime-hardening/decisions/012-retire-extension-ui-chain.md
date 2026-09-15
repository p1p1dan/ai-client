# 决策 012：extensionUi 整链退役；免代码插件扩展推后；Q012 结案

日期：2026-09-15。状态：已采纳（用户拍板，回答 Q012）。

## 背景

extensionUi 是旧引擎时代让 pi 插件在 GUI 里弹窗、挂状态行、发通知的管道：worker 侧 `extensionUiBridge` → RPC 事件 `extensionUi.request/cancelled/reset` → Main `WorkerManager` → IPC → 渲染层两个 store 与 `ExtensionUiDialog` / `ExtensionUiSurfaces` → 用户回答经 `chat:respondExtensionUi` 回 worker。P6-5 之后 GUI 会话跑自有 runtime、不加载任何 pi 扩展；T025 核实 `uiContext` 全仓唯一调用点被 `bootstrap.ts` 的 `?? approval?.approve` 永久遮蔽；T026 之后侧栏能力面板与 MCP 徽标也不再读它。约 3700 行渲染层专属代码 + Main / preload / IPC / shared 约 150 处触点，无任何可到达的生产者（审计 cutover-06）。

## 用户要求（原话要点）

- 「extensionUi 确实可以删除了。」
- 「免代码的插件扩展后续再考虑吧，现在优先做好现在的版本发布。」
- 选 Cordis 的初衷是后续能用 DSH 生态里现成的插件——编排者已指出：同内核不等于插件可直接用，DSH 插件写的是 DSH 自己的服务接缝（`ctx.llm` / `ctx.agentLoop` / Typert / `dsh.client`），要用需先对齐接缝或写适配层。记入想法池，不在本阶段规划。

## 决定

1. extensionUi 整链删除：专属文件全删，混合文件里的触点全部摘除；`createRuntimeApprovalBridge` 与 `ExtensionUiRequest` 类型一并删除，`bootstrap` 的 `permissions.approve` 改为必填（nativeWorkerRuntime 本来恒传）。
2. 旧会话文件里若残留 `extensionUi.*` 事件，回放时静默忽略，不报错、不渲染。
3. 内嵌 Pi 终端不受影响（它有自己的 TUI，不经这条链）。
4. 免代码插件扩展（自有插件目录加载 / pi 插件兼容层 / DSH 接缝对齐）推后，本阶段优先版本发布。

## 影响

- 新开 T036（批次 C 追加）执行删除；验收：三套 tsc、相关用例、批次收口全量一次。
- 审计 cutover-06 由「改注释」升为「已删（T036）」。
- 想法池新增一条：DSH 生态插件复用需要接缝对齐。
