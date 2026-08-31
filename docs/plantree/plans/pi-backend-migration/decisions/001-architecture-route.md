# D1 — 架构路线：pix 架构 + pi-app 功能

> **状态：Superseded（2026-08-31）**
>
> “不移植 pi-app WorkerManager”的拓扑结论已由 [D15 — Electron Main 持有 bounded WorkerManager](./015-main-owned-worker-manager.md) 替代。本文保留 2026-08-28 的原始背景；pix 的能力分层参考仍有效，后续主要用于 Pi TUI/PTY/CLI packaging。

**原状态**：已拍板（2026-08-28）

## 决策

采用 pix 的架构路线（四层隔离 + contracts 包 + 三级能力分层），同时从 pi-app 借鉴功能设计（会话树 + 消息队列 + 流式时间线）。

## 背景

两个参考项目各有优势：
- **pix**：架构干净（monorepo + utilityProcess 隔离 + contracts 协议定义），与我们现有 agent-host 分层同构
- **pi-app**：功能成熟（34 个扩展适配器 + 会话树 + 消息队列 + 语音输入 + 双语 UI）

## 理由

1. 我们已有 renderer → preload → main → agent-host 四层架构，与 pix 同构，改动最小
2. pi-app 的逐扩展 JSON 适配器方式需要维护 45 个适配器文件，长期成本过高
3. pix 的三级能力分层是通用框架，新扩展自动归类，维护成本低
4. pi-app 的功能设计（会话树、消息队列）是成熟的产品答案，可直接借鉴而不需要照搬其架构

## 影响

- Phase 1-2 以 pix 为参考实现后端替换和协议层
- Phase 3-4 以 pi-app 为参考实现功能和交互
