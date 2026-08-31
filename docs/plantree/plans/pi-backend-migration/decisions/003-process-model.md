# D3 — 进程模型：直接走 utilityProcess + MessagePort

> **状态：Revised / partially active（2026-08-31）**
>
> utilityProcess、MessagePort、崩溃隔离与“不建设一次性 NDJSON bridge”继续有效；单个全局 pi agent-host 的拓扑与回退假设由 [D15 — Electron Main 持有 bounded WorkerManager](./015-main-owned-worker-manager.md) 修订为 Main-owned pool + one utilityProcess per WorkerSlot。

**原状态**：已拍板（2026-08-28，rev2）

## 决策

Phase 1 直接采用 Electron utilityProcess + MessagePort 作为 pi agent-host 的进程模型，不经过独立 Node 进程 + NDJSON 的中间态。

## 理由（rev2 更新）

原方案（A）选"先保持独立进程"的理由是"每步只改一个变量"降低风险。但：

1. **pix 已验证** — pix 项目（`apps/desktop/src/agent-host/`）已跑通 utilityProcess + pi SDK 这条路，风险已被证伪
2. **A 路线会产生一次性代码** — 给 pi 写 NDJSON 接线，切 B 时全部扔掉，等于白做
3. **piRuntime.ts 的核心逻辑不浪费** — `projectEvent()` 事件映射与传输管道无关，MessagePort / NDJSON 都复用同一份
4. **白名单环境更友好** — utilityProcess 用 Electron 内嵌 Node，不需要额外的 `node.exe` 白名单条目
5. **安装包更小** — 省掉独立捆绑的 Node 二进制（~90MB）

## 回退路径

如果用户环境无法使用 utilityProcess，可回退到独立 Node 进程：
- 改动范围：仅通信适配层（~50-80 行），`utilityProcess.fork()` → `child_process.spawn()` + NDJSON readline
- piRuntime.ts 的 SDK 初始化、事件映射、session 生命周期管理完全不动

## 参考

- pix: `apps/desktop/src/agent-host/` — utilityProcess 入口 + MessagePort IPC
- pix: `packages/contracts/` — 协议类型定义
