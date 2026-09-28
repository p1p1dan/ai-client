# 决策 030：DSH 会话的只读回放交给宿主读，Main 不自己解 DSH 日志

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-4 方案 §5 D5](../topics/p1-4-bridge-parity.md#5-需要拍板的决策点)、runtime-hardening 决策 030（主进程只读回放）。

## 规则

1. P1-3 的宿主控制消息增加只读操作 `{host:'readPage', id, stubFile, offset, limit}`。
2. 宿主侧依次：读桩 → 校验逻辑 id → `ctx.sessionQuery.observeSession`（不取锁、不写盘，冷读时在内存里补上中断收尾）→ 用[决策 026](026-history-per-message-tree-across-lineage.md) 的共享投影分页 → 返回 `SessionHistoryPage`。
3. Main 的 `CHAT_READ_SESSION_PAGE` 遇到 DSH 行时改走这个操作，照旧广播 `session.history`。宿主不在或读取失败，报 `session_replay_unavailable`，渲染层退回到恢复。
4. 旧 pi 会话照旧走 `SessionReplayReader`。P1-12 删 runtime 时，要把 pi 解码链（`runtime/plugins/session/codec.ts`、`legacy.ts`、`agent-host/piSessionTimeline.ts`）搬到 shared，不能删，因为 P1-9 的转换器也要用它。

## 取舍

- 不选「Main 自己解 zstd 帧」或「Main 引用 DSH 的持久化库」：DSH 还是 developer preview，这两条路都要跟着它的格式漂移；在加密机上，Electron 进程也不在白名单里，读到的会是密文。交给宿主读，格式由 DSH 自己负责，读盘也在白名单载体上。
- 顺带解决一个问题：今天「看一眼」DSH 会话走的是恢复，恢复会取写锁，还会往日志追加 `session/end-seed`，看一眼就改了日志。
- 代价：预览要依赖宿主在线，冷启动约 0.8 s。
- 开工前要实测：`observeSession` 读 2000 条消息的会话，耗时和内存各是多少。
