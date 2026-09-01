# D17 — Worker pool identity、capacity 与 crash policy

**状态**：已拍板并落地（2026-08-31）  
**实现证据**：[T30 WorkerManager](../evidence/2026-08-31-t30-worker-manager.md)

## 决策

### Identity

- temporary create authority 使用 normalized workspace + logical session ID + opaque UUID token。
- durable authority 使用 normalized Pi `sessionFile`；workspace/cwd 不代替 session identity。
- POSIX identity 保留大小写；Windows drive/UNC 采用 win32 normalization 与 case-insensitive comparison。
- remap 必须在一个 Main lifecycle critical section 中完成：validate collision → one map swap → awaited SessionIndex atomic flush → publish success。
- collision、index failure 或 stale create 不偷取现有 authority；remove + dispose partial slot。

### Capacity

- capacity 是 Main startup product policy，不进入 Worker RPC protocol。
- resource-aware default：≤4 GiB 为 2，≤8 GiB 为 3，其余为 4。
- `AICLIENT_PI_WORKER_CAPACITY=1..8` 可作启动时部署/开发覆盖；非法值 fail fast。
- idle TTL 默认 15 分钟。
- foreground、active turn、pending blocking Extension UI、creating/restarting/disposing slot 不可淘汰。
- 达容量且无安全 victim 时返回 retryable、可解释的 `worker_capacity_reached`，不 overcommit。

### Crash / restart

- crash 只清当前 slot 的 active turn、blocking/display UI 与 owner-scoped request；不终止其他 slot。
- active turn 不自动重放，只合成一次 disconnected + failed。
- replacement generation 必须 `SessionManager.open(sessionFile)` 重开同一 durable identity；identity mismatch fail closed。
- 60 秒内最多 2 次 restart；耗尽后保留 recoverable error authority，不无限拉起。
- app close 并行 dispose 全 pool；bootstrap await 前即把进程 ownership 交给 Manager；deadline/signal 可同步 force kill。

## Q12/Q13 处理

本决策关闭原 Q12/Q13。当前不提供运行时热改 capacity，也不引入 WSL stdio transport。若未来要增加 settings UI、runtime resize 或 WSL transport，必须另立任务并保持本决策的 protected-slot、single-authority 与 fail-closed 不变量。

## Reference disposition

- pi-app：采用 pool/remap/isolation 算法与 test scenarios；适配本仓 typed generation、owner、blocking UI、SessionIndex transaction 和 confirmed disposal。
- pix：只采用 serialized lifecycle、single-writer 与 stale-output lessons。
- 不采用 fixed sleeps、global foreground/mainWindow、第二 supervisor、over-cap busy policy 或 GUI/TUI 双写。
