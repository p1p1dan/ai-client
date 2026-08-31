# Topic — Pi-only WorkerManager 架构

> 架构决策权威是 [D15](../decisions/015-main-owned-worker-manager.md)；本文件只提供实现阅读 capsule。重排前 singleton-host 方案见 [history snapshot](../history/2026-08-31-pre-pi-only-realignment/topics/architecture.md)。

## 目标拓扑

```text
Renderer
  → Preload/contextBridge
    → Electron Main
      → WorkerManager
        → bounded WorkerSlot pool
          → utilityProcess
            → Pi AgentSession / SessionManager / extensions
```

## 责任边界

| 层 | 负责 | 不负责 |
|---|---|---|
| Renderer | session UI、timeline、queue/pending 展示、Extension UI surfaces | worker PID、Pi SDK、pool policy |
| Preload | 最小受控 IPC bridge | runtime ownership、业务状态 |
| Main/WorkerManager | slot lookup/create/remap、capacity、foreground、owner routing、crash/reclaim | 直接运行 Pi SDK |
| WorkerSlot | transport、generation、pending RPC、runtime/session identity、active/stopping state | 跨 slot 产品状态 |
| utility worker | Pi SDK、AgentSession、SessionManager、extensions、RuntimeEvent projection | window/navigation 和全局 pool |

## Durable 与 transient identity

- durable identity：normalized Pi session file；由 session index 提供产品导航。
- create 前 temporary identity：workspace + unique creation token。
- runtime identity：应用/worker generation 可解析但不替代 session file。
- remap 必须原子；旧 generation 的事件必须被丢弃。

## 保留的协议层

- `RuntimeEvent` 继续隔离 renderer 与 Pi SDK 类型。
- Extension UI blocking 和 fire-and-forget 仍分开。
- session-local queue/pending、permission、model 和 timeline behavior 继续有效。
- `extensionUi.reset`、session retirement 和 repository tombstone 是清理边界，但触发源改到 WorkerSlot lifecycle。

## 替换的边界

- singleton `PiHostProcess`；
- 一个 host 内的全局会话 router；
- `ACTIVE_BACKEND` 和 Claude/Codex multi-runtime dispatch；
- singleton host/asar-only packaging 假设。

## 关键不变量

1. 一个 durable GUI session 同一时刻只有一个 active WorkerSlot authority。
2. foreground/active turn/pending blocking request 的 slot 不可被淘汰。
3. 单 worker crash 不污染或终止其他 session。
4. stop/dispose/crash 清理 pending RPC、Extension UI、display state 和 owner routing。
5. GUI/TUI 不同时写同一 session file。
6. legacy import parser 不进入活动 runtime，也不修改 source。

## 参考

- WorkerManager/WorkerSlot/history/tree：pi-app。
- TUI/PTY/CLI/resources：pix。
- 复用分类和禁用模式见 [reference repositories](./reference-repositories.md)。
