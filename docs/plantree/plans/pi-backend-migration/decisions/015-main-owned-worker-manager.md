# D15 — Electron Main 持有 bounded WorkerManager

**状态**：已拍板（2026-08-31）

**替代**：[D1](./001-architecture-route.md) 的“只借鉴 pi-app 功能、不移植 WorkerManager”与 [D3](./003-process-model.md) 的 singleton host topology。

**保留**：D3 的 utilityProcess、MessagePort、崩溃隔离和不建设一次性 NDJSON bridge。

## 决策

目标拓扑为：

```text
Renderer
  → Preload
    → Electron Main
      → WorkerManager
        → bounded WorkerSlot pool
          → one utilityProcess per slot
            → one Pi AgentSession per slot
```

Electron Main 持有 WorkerManager 和 pool policy；Pi SDK 不直接运行在 Main。每个 WorkerSlot 拥有独立 utilityProcess、transport、pending requests、runtime/session identity 和生命周期状态。不再保留一个额外的 singleton PiHost supervisor。

## Ownership

### Electron Main / WorkerManager

负责：

- 按 workspace/session file 查找、创建和 remap slot；
- bounded capacity、foreground authority、idle eviction 和 park/reopen；
- window/session owner routing；
- worker crash、restart budget 和 atomic disposal；
- 将 Renderer IPC 转成 slot RPC，将 worker RuntimeEvent 定向回 owner；
- 阻止 stale worker、旧 generation 或已退休 session 的事件泄漏。

### WorkerSlot

至少持有：

- pool key、cwd、runtime identity、logical session ID；
- normalized Pi session file（创建完成后）；
- utilityProcess/MessagePort transport；
- pending RPC、初始化、active turn、stopping/restarting 状态；
- foreground/last-used/idle timestamps；
- Extension UI blocking request ownership。

### utilityProcess / Pi AgentSession

负责：

- Pi SDK、SessionManager 与 extension runtime；
- create/open/send/stop/fork/rewind；
- RuntimeEvent projection；
- Extension UI bridge；
- managed agentDir/auth/models 和 project trust 的进程内应用。

Renderer 不依赖 worker PID 或物理进程路径，只消费稳定 IPC/RuntimeEvent/session identity。

## Slot identity 与 remap

- 新会话可先使用 normalized workspace temporary key。
- Pi 创建原生 session file 后，WorkerManager 原子地将 slot remap 到 normalized session-file key。
- 恢复会话优先以 session file 为 durable identity；cwd 是约束和诊断信息，不代替 session identity。
- 任何 remap 失败都必须回滚或 dispose slot，不能留下两个 key 指向不同 authority。

## Pool policy

默认策略是产品配置而非协议常量：

- 普通机器目标容量约 3–4；
- 低资源开发环境可降至 1–2；
- foreground、active turn 或有 pending blocking request 的 slot 不可淘汰；
- recent background session 可驻留或 park；
- 无活跃 turn/request 的 idle slot 可在约 10–15 分钟后回收；
- 达容量时只淘汰安全的 non-foreground idle slot；无安全候选时返回可解释的 capacity error。

具体默认容量可在实现前由 roadmap open question 收口，不阻塞单 slot 纵切。

## 崩溃与清理

- 一个 worker 崩溃不得终止其他 slot。
- 每个 worker/slot 使用 generation 防止重启前的迟到事件污染新 runtime。
- crash/dispose 必须清理 pending RPC、Extension UI request/display state、active turn 和 owner routing。
- restart 有界；反复失败后进入可恢复错误态，不无限拉起。
- 应用关闭必须等待或强制终止所有 utilityProcess，验证无 orphan。

## 参考与复用

### pi-app

允许直接移植或近直接移植 WorkerManager、WorkerSlot、worker transport、pool/remap/eviction 和相关测试场景。若 substantial copying，必须保留 pi-app MIT copyright/license notice。

必须适配 ai-client 的：

- RuntimeEvent contract；
- SessionIndexService/runtimeIdentity；
- queue/pending/attachments；
- Extension UI、permissions、model catalog；
- renderer stores 和 window ownership。

### pix

继续作为 Pi TUI/PTY、session-identified terminal contract、stale output filtering、CLI extraction 和 packaged resources 的参考。不得引入与 WorkerManager 重叠的第二套 supervisor，也不复制 GUI/TUI 同写同一 JSONL 的 takeover 语义。

## 不采用

- Pi SDK 直接运行在 Electron Main；
- 一个全局 PiHost utilityProcess 承载所有会话；
- singleton supervisor 再管理一层 worker pool；
- standalone Node + NDJSON 作为正式中间层；
- 每个 renderer window 自己启动 worker；
- 无界 worker 数量；
- GUI/TUI 同时写同一 Pi session file。

## 影响

- 现有 singleton `PiHostProcess`/`AgentHostManager` 只作为替换来源，不是最终边界。
- Cycle 1/2 的产品行为继续有效，但 transport、routing、reset 和 ownership 必须重新挂到 WorkerSlot。
- History/resume/tree/rewind/fork 在 WorkerSlot 内通过 Pi SessionManager 实现。
- 新 roadmap 必须先完成单 slot 纵切和 bounded pool，再进行 history、legacy deletion、migration 与 TUI release。
