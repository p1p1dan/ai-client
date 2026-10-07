# 决策 155：阶梯 B 重启宿主前，先并发关闭其他在忙的会话

日期：2026-10-07。**状态：按用户裁决（[决策 149](149-user-rulings-2026-10-07.md) 第 6 条）实现，实现取舍待审批。**

依据：

- [决策 149](149-user-rulings-2026-10-07.md) 第 6 条：用户裁决按「甲」修。Main 在阶梯 B 杀宿主之前，先对其他在飞的通道并发发 `worker.dispose`，每个最多等 3 s；不改 DSH。
- [决策 151](151-p1-3e-stuck-switch-choices.md) 第 5 节第 2 条：缺陷本身。卡点在 DSH 内部时，宿主的优雅关停也在等卡住的会话，3.5 s 收不了尾，宿主被 SIGKILL，其他会话已流出的正文全部丢失。
- [决策 021](021-stop-escalation-ladder.md) 第 3 条、[分片 02](../topics/p1-3-shared-host/02-design.md) §4：优雅关停时，其他会话在飞的正文落盘为 interrupted。
- [P1-3 汇总证据](../evidence/p1-3-shared-host-2026-10-07.md) §3、§4.1：改前的 S5 时间线。

代码提交 `4ebcfe5a`。**第 2、3、5 条请重点审批。**

## 规则

### 1. 做法

- **位置**：`WorkerManager.restartHost` 里，调 `supervisor.restart` 之前，新增一步 `closeBusyChannelsBeforeRestart`。
  - 按第 2 条选出要关的会话。
  - 对每个会话的 slot 并发发 `worker.dispose`，`reason` 为 `slot-replace`，单个请求超时 3 s。
  - 总等待上限 3 s（`HOST_RESTART_DRAIN_MS`）：一个总截止计时器与 `Promise.allSettled` 赛跑。并发，不是每个串行 3 s。
  - 任何一个超时、被拒或一直不应答，都只记一行告警，不阻止重启。
  - 结束时打一行 `[worker-manager] closed N of M busy session(s) in X ms before restarting the DSH host`。
- **不改 DSH，也不改 bridge**。bridge 收到 `worker.dispose` 后的顺序是：
  1. `runtime.dispose()`，内部就是 DSH 的 agent dispose：`cancel({kind:'disposed'})` → `whenIdle()`；
  2. 已流出的正文以 `assistant/message {interrupted: true}` 落盘，回合以 `turn/end {kind:'aborted', reason:{kind:'disposed'}}` 关闭；
  3. 关句柄、释放会话锁；
  4. 回 ACK，再发 `{host:'closed', ch}`。
- **只发 RPC，不走 `WorkerSlot.dispose()`**：
  - slot 自己的 dispose 是「等 ACK 3 s，再等 `closed` 3 s」，最坏 6 s；
  - 它还会把 slot 置为 `disposed`，让这个会话离开宿主崩溃的恢复路径，还得另写一套通知和恢复。
  - 只发 RPC 时，通道关闭后 slot 走现成的崩溃路径（`crashed` 生命周期事件 → `handleLifecycle`），与其他会话进同一个恢复批次。
- **提前关闭的通道怎么记账**：`hostFaultOf` 新增一条判据。
  - 本次重启前被 Main 主动关闭的 slot 记在 `drainedSlots`（WeakSet）里。它们的 `channel-closed` 退出算 `restarted`，即 Main 计划内的重启，不算这个会话自己的崩溃。
  - 所以：不扣会话预算，不计 `hostFaultStreak`，不单独重开，而是进宿主恢复批次。在飞的那些照旧排在前面（`activeAtHostExit`）。
  - 没被 Main 关过的通道自己关了，仍是这个会话自己的崩溃（[WMH-12] 不变）。

### 2. 关哪些会话（请重点审批）

- **关**：除卡死会话之外，状态为 `ready`、slot 为 `running`，并且满足下面任一条：
  - Main 发出的回合在飞（`activeRequestId`）；
  - 正在 Stop（看门狗已布防）；
  - 引擎自己起的回合，例如 goal 续跑、job 唤醒（`workerTurn`）；
  - 上次 pong 报告该通道 busy，例如后台 job、子代理还在跑。
- 卡死会话是显式排除的。它此时本来也不会被选中：状态是 `restarting`，slot 是 `dispose-failed`。
- **不关**：
  - **空闲会话**。它们没有在飞的正文，照现有语义随宿主重启：收到 `disconnected/engine_restarted`，再批量恢复。理由：裁决说的是「在飞的通道」；空闲会话提前关，保不住任何东西，只多一次往返。
  - **正在 rewind / fork 的会话**（`mutationInFlight`）。bridge 的请求链是串行的，dispose 会排在这次变更后面；Main 侧的变更流程也没设计成中途被关通道。它们没有流式正文要保，随宿主重启，与改前相同。
  - `creating` / `restarting` / `crashed` / `error` 的会话：没有可用的通道。
- **正在 compact 的会话**：有在飞回合时会被选中，但 dispose 排在 compact 后面，多半等满 3 s 后随宿主重启，结局与改前相同。

### 3. 覆盖范围：Main 发起的所有宿主重启，不只 Stop 看门狗这一条（请重点审批）

这一步放在 `restartHost` 里，三处调用都会走：

1. **阶梯 B**（`escalateStuckChannel`，Stop 看门狗之后）。本次的缺陷就在这里。
2. **关闭或回收会话时通道关不上**（`releaseStuckChannels`，同属阶梯 B）。这里重启的前提就是别的会话都不在忙，所以通常一个都不关，也不等待。
3. **`session_locked` 卡片的「重启引擎」**（`forceTakeover`，原因 `user`）。锁的持有者就是宿主里一个卡住、放不掉锁的 agent，优雅关停同样会被它卡住；被 SIGKILL 时，其他会话的正文同样会丢。

第 3 处超出了裁决的字面（裁决只说阶梯 B）。理由：同一个函数，同一个缺陷，那里的注释原本也写着「其他会话被优雅中断」。不同意的话，把调用从 `restartHost` 挪回 `escalateStuckChannel` 即可，单测 [WMH-lock-02] 随之删除。

### 4. 时序：卡死会话照旧

- 卡死会话的时序不变：
  - t0 Stop；
  - 10 s 界面收尾（`stopped(forced)` 加 `idle`），T144 不受影响；
  - 阶梯 A：dispose ACK 等 3 s，`closed` 再等 3 s；
  - 然后阶梯 B。
- 新增的一步在阶梯 B 开头，最多 3 s。S5 实测 9 ms：只有 b2 要关，它立即应答。
- 最坏情况：只有某个在忙的会话 3 s 内答不上 dispose 时，阶梯 B 才多出 3 s，总时长从分片 02 §4 估的约 23 s 变为约 26 s。

### 5. 被提前关闭的会话：通知与恢复（请重点审批）

- **通知照旧，只是提前**：
  - 在飞的会话收到 `disconnected/engine_restarted` 和 `failed(dsh_engine_restarted)`，时间提前到它的通道关闭时。S5 里比旧宿主退出早约 3.5 s。
  - 只有后台 job 的会话只收到 `disconnected/engine_restarted`。
  - 「引擎已重启」的 toast 照旧，5 s 内只提示一次。
- **不换成别的提示**，理由：
  - **准确**：这个回合确实是因为「为恢复另一个对话而重启引擎」被打断的。失败卡原文是「The engine was restarted to recover another chat, so this reply was interrupted. … Continue to carry on from here.」，正文保住之后反而更贴切。
  - **渲染层依赖这个码**：`isEngineTurnFailure` 对 `dsh_engine_restarted` 返回 false，渲染层据此解除绑定，「继续」走 resume。换成不带码的 `session.failed`，渲染层会保留绑定，对着已经关掉的连接发送；换成 `session.stopped`，会被当成用户自己点了停止。
  - **「继续」可用**：bridge 的 retry 接受上一回合以 `aborted` 结束（`RETRYABLE_TURN_ENDS`）。
- **真正误导人的是历史里的那条注记**：「This turn was interrupted when the engine stopped unexpectedly.」。它是 DSH 恢复时给没关闭的回合补的 `turn/end interrupted`。现在 DSH 自己关闭了 b2 的回合，b2 的历史里不再有这条注记（S5 断言）。卡死的 b1 仍然有，它确实是被 SIGKILL 的。
- **恢复**：与其他会话同一批次，排序不变（前台 → 在飞 → 其余），不扣会话预算，`restartAttempts` 为 0（单测与 S5 都有断言）。
- **回放的样子**：
  - 被打断的助手消息带 `incomplete: true` 和 `stopReason: 'aborted'`，没有 `stopCause`。
  - 渲染层 `turnEndCause` 对旧数据的兜底会把它读成 `user_stop`，效果只是这个回合结束后过程区默认展开。
  - 应用退出、登出等现有的 dispose 路径落盘的形状完全相同。本次不改，记为可选的后续。

### 6. 测试

- **`WorkerManager.test.ts`**（假 slot 与假宿主）：
  - [WMH-06c] 三个在忙的会话（两个回合在飞，一个只是 pong 报 busy）同时被问到，都应答之前不重启；空闲会话与卡死会话不发；重启那一刻三个已关，空闲的仍在；通知、恢复顺序、预算。
  - [WMH-06d] 两个永不应答、一个立即被拒、一个正常：2 999 ms 时还没重启，3 000 ms 时重启，不是每个 3 s 串行；正常的那个在重启前已关；其余随宿主走，通知相同。
  - [WMH-06e] 没有其他在忙的会话时不等待。
  - [WMH-lock-02] 「重启引擎」也先关在忙的会话。
  - 原 [WMH-06] 不改断言照样通过：`other` 现在是提前关的，通知与恢复顺序不变。
- **`dshChannelStopWatchdog.test.ts`**（真 WorkerSlot、DshChannelTransport、supervisor，加脚本化的假宿主）：[WMH-06c] 两个在忙通道的 `worker.dispose` 早于 `shutdown`，空闲的不发；一个不应答时，`shutdown` 推迟 3 s（8.9 s 时未发，9.1 s 时已发）；全部恢复。
- **真宿主集成测试 S5**：断言 b2 在阶梯 B 开头被关（`closed 1 of 1`）、早于旧宿主退出；恢复后历史保留已流出的正文，消息为 incomplete、aborted；b2 没有「引擎意外停止」注记，b1 有。

### 7. 实测：S5 改前与改后

改前取自决策 151 与证据 §3；改后是本次最终代码上的全量集成测试（35/35，141.5 s）。时间都从 Stop 算起。

| | 改前 | 改后 |
|---|---|---|
| DSH 记下 abort ignored | 53 ms | 51 ms |
| 界面收尾（b1 `stopped(forced)`） | 10 043 ms | 10 036 ms |
| b2 的通道关闭 | 随旧宿主一起，约 19.6 s | 16 010 ms，阶梯 B 开头，这一步用时 9 ms |
| 旧宿主退出（`stuck-session`、SIGKILL） | 19 571 ms | 19 554 ms |
| 三个会话全部 idle | 再过 1 014 ms | 再过 813 ms |
| b2 收到的通知 | `disconnected/engine_restarted`、`failed(dsh_engine_restarted)`、resumed、idle | 相同 |
| b2 恢复后的历史 | 只有用户消息和「引擎意外停止」注记 | 用户消息加已流出的正文：400 块里的 115 块，incomplete、aborted；没有注记 |
| 下一轮 | 三个会话都完成 | 相同 |

### 8. 已知现象（无害）

- 关 b2 时，宿主报 `session-projection-cache: turn/end write for "aiclient-b2" failed (cache stays stale): SessionHandleClosedError … flush on a closed handle`。
- 这是 DSH 投影缓存「写失败就放弃」的已知告警：见 [P1-3a 证据](../evidence/p1-3a-shared-host-2026-09-27.md) 第 2 条、[决策 146](146-real-gateway-followups.md)、P1-5 真网关证据的 GW-13。会话日志里 `turn/end` 已经写进去了，缓存下次冷读时自愈。
- S5 里 b2 恢复后的历史和下一轮都正常。

## 没做的

- 不改 DSH（裁决）。决策 151 第 5 节的选项 B（宿主 `shutdown` 先 dispose 没卡住的 agent）不做。
- 不改渲染层：失败卡、toast、绑定处理都沿用现有的 `engine_restarted` 语义（第 5 条）。
- 不改投影里 `turn/end aborted{disposed}` 的 `stopCause`（第 5 条末尾）。
- GUI 上走不到阶梯 B（决策 151 第 6 条），这次也没有点验界面。
- 没有补「被关会话的 dispose 在宿主里也卡住」的真宿主用例。单测 [WMH-06d] 和看门狗测试覆盖了 3 s 上限。
