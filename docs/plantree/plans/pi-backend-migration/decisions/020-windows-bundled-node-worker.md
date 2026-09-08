# D20 — Windows 安装版 GUI worker 使用随包 Node

日期：2026-09-08。状态：用户已接受，GUI 读取已获现场确认；其他工具与退出清理待验收。

## 背景

同一 Windows 安装包在加密机上 GUI Read 返回异常内容、bash 输出句柄报错，而 TUI/编辑器正常。
三者执行路径的对照及不确定性见[问题分析报告](../../../../../Windows加密环境GUI异常分析.md)。

## 决策

- 修订 D15 中“所有平台每槽固定 utilityProcess”的约束：Windows 安装版改用 `resources/node-runtime/node.exe` 启动同一 worker；其余平台与开发模式维持 utilityProcess。
- 保留 D15 的 Main-owned bounded WorkerManager、WorkerSlot、generation、崩溃隔离、每槽一个 Pi AgentSession。
- Windows 通信使用 Node 原生 IPC，由 WorkerTransport 适配原协议；不引入 singleton supervisor、NDJSON bridge，不将 Pi SDK 移入 Main。
- 不存在随包 Node 时明确失败，不回落到 Electron 或 PATH 中不确定的 Node。
- 进程断开、工具终止及打包验证跟随实际后端；验证须包含 Read/bash，最终仍需加密机验收。

## 参考取舍

已阅读 pix `apps/desktop/src/main/host-spawn.ts`、`host-spawn.test.ts`、主进程 spawn 与 agent-host 入口。
**适配保留**其隔离、环境清理和事件路由；**不采用**其所有 Windows 场景固定 utilityProcess 的执行身份。
采用本仓已在现场正常的 TUI 随包 Node 路径。无大段复制上游代码。

## 影响

T39 记录修复及验收；旧 T28–T38 的历史完成事实保留。
runtime 自主化 ARD 的 D4/Node 环境结论按本决策修订。
