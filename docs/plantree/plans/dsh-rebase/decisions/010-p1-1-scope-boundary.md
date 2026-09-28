# 决策 010：P1-1 带上 bridge 最小补丁；fork 暂报不支持；改名留到 P1-12

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-1 方案 §5 D6 与「可自主决定的小项」](../topics/p1-1-engine-cutover.md#5-需要拍板的决策点)、§6 改动边界。

**修订（2026-09-28，P1-4c1）**：第 1 条的重试安全桩已由[决策 095](095-retry-keeps-hidden-continuation.md) 的受理规则取代（[决策 111](111-p1-4c1-turn-semantics-choices.md) 第 9 条）；附件的安全桩仍在，插话带附件也按它拒绝，等 P1-4c2 放开。

**修订（2026-09-28，P1-4c2）**：第 1 条的附件安全桩已由[决策 096](096-images-via-dsh-attachments.md) / [097](097-text-attachments-as-dsh-file-blocks.md) 的入库入口取代：发送与插话的附件都经 DSH 的附件服务入库，被拒时答 `WORKER_ATTACHMENT_REJECTED`（[决策 112](112-p1-4c2-attachment-choices.md) 第 2～5 条）。`WORKER_DSH_UNSUPPORTED` 只剩 compact / reload 与 channelMux 的未桥接操作在用。

## 规则

1. P1-1 带上约 100 行 bridge 补丁，让恢复和崩溃重启在开发机上真正走通，而不只是在单测里成立：
   - 恢复时返回 `initialHistory`：P1-4 之前是合法的空页，渲染层遇到空页会保留运行期消息。
   - 错误映射：会话不存在 → `dsh_session_missing`；被别的进程持锁 → `session_locked`；`forceTakeover` 忽略，因为 DSH 的锁是内核锁，不能强制接管。
   - 安全桩：`mode: 'retry'` 抛 `WORKER_RETRY_UNAVAILABLE`；带附件抛 `WORKER_DSH_UNSUPPORTED`。不再把空文本当新消息发出去，也不再静默丢图。
2. fork：Main 这一侧切到 DSH 并补单测；bridge 的 `worker.fork` 仍返回 `WORKER_DSH_UNSUPPORTED`，要等 P1-4 的历史投影。所以 P1-1 结束时，在界面上点「分叉」会明确报不支持。
3. 这一步不改名。`createPiWorkerSlot`、`PiWorkerRpcServer`、`pi_session_*` 错误码、`AICLIENT_PI_WORKER_*` 都留到 P1-12 统一改，避免和删 runtime 搅在一起、改两遍。
4. 以下不在 P1-1 做：
   - 心跳、按 pid 强杀、宿主级重启预算、Stop 看门狗改造，归 P1-3。
   - 历史 / 树投影，rewind / compact / reload，插话、重试、附件的真实现，归 P1-4。

## 取舍

- 不选「bridge 补丁全部留给 P1-4」：那样开发机上的恢复、重启、Stop 强杀之后，会话都会停在 error。P1-1 的「4 条路径」只能在单测里成立，而且 P1-2 / P1-3 期间没法用真会话自测。
- P1-4 只替换 `history()` / `tree()` 的实现和两个安全桩，不推倒 P1-1 的代码。
- 代价：P1-1 多约 100 行 bridge 代码和对应单测。

## 影响

- P1-1 退出判据补一句：「分叉」明确报不支持；重试和附件明确拒绝。
- P1-1～P1-3 期间一个会话一个宿主，每个约 180 MB。多个宿主共用一个 `DSH_HOME` 不是 DSH 支持的形态，所以只在开发机自测，P1-3 之前不出包。
