# P1-3 分片 02 · 目标架构与故障处理

Role: detail shard。上位：[P1-3 方案](../p1-3-shared-host.md)。回答调研问题 3（目标架构）、4（宿主级故障）、5（Stop 看门狗）、8（生命周期边界）。按方案 §4 的推荐选项写。行号约定同[分片 01](01-current-state.md)。

## 1 拓扑

```
Main ── WorkerManager（entry 状态机不变）
          │ 每个会话一个 WorkerSlot（generation、请求超时、排空窗口不变）
          │   transport = DshChannelTransport(ch)          ← 新
          └─ DshHostSupervisor（全局 1 个）                ← 新
               └─ 一条 Node IPC ── DSH 宿主进程（随包 node + host.ts / host.js）
                                     └─ aiclient-bridge：按 ch 分发，每个 ch 一套
                                        PiWorkerRpcServer + DshSessionRuntime（原样）
```

- **宿主数**：一个应用实例一个。单实例锁按 userData 生效（`index.ts:319-333`），userData 又是按 profile 分的（`:155-168`），`DSH_HOME` 取 `~/.pilab/<profile>/dsh-home`（决策 008）。所以一个 `DSH_HOME` 只会有一个宿主。
- **没有分片、没有上限之外的第二宿主**：多个宿主共用一个 `DSH_HOME` 时，profile 与存储的写入没有跨进程协调（P1-1 §9）。
- **会话上限**：沿用 `capacity`（上限 10）。默认分档改为 ≤4 GiB 的机器 6，其余 10。依据是每个会话的增量：空会话约 3 MB，2000 条历史约 20～46 MB（`p0-6…md:36-43`）。

## 2 协议（Node IPC，默认 JSON 序列化）

| 方向 | 消息 | 说明 |
|---|---|---|
| Main → 宿主 | `{ch, rpc}` | 会话 RPC。`ch` 由 supervisor 为每个虚拟 slot 单独铸一个，形如 `c<宿主代>-<序号>`，永不复用 |
| Main → 宿主 | `{host:'ping', id}` | 心跳 |
| Main → 宿主 | `{host:'close', ch}` | 关闭通道。runtime 还没 dispose 的，由宿主来 dispose；做完回 `closed`。**卡住就不回** |
| Main → 宿主 | `{type:'shutdown'}` | 宿主级优雅关停，沿用 `host.ts:193-195` |
| Main → 宿主 | `{host:'gc', claimed, graceMs}` | 日志清理（P1-3d，见分片 03 §4） |
| 宿主 → Main | `{type:'ready', pid, …}` / `{type:'fatal'}` | 握手，沿用 `host.ts:77,234-247`。Main 核对 `pid === child.pid` |
| 宿主 → Main | `{ch, rpc}` | 回复与 RuntimeEvent |
| 宿主 → Main | `{host:'pong', id, eldMaxMs, rssMb, channels:[{ch, busy}]}` | `busy` 表示该通道的 agent 不在空闲态，包括 goal 自动续跑（推断：也包括后台 job） |
| 宿主 → Main | `{host:'closed', ch}` | 这个通道的 runtime 已经 dispose，会话锁已释放 |
| 宿主 → Main | `{type:'stopped'}` | 关停完成，沿用 `host.ts:176-178` |

宿主侧的规则：

- 只有 `worker.bootstrap` 能建通道。发给未知通道的其他请求，回 `WORKER_CHANNEL_UNKNOWN`。
- 通道的 generation 取 bootstrap 里的值，由每个通道的 server 负责校验（`piWorkerRpcServer.ts:378-385`）。
- `onDisposed` 触发时，删除这个通道并回 `closed`。
- 保留 `host.ts` 对早到消息的缓冲，改成在产品模式下始终开启（`host.ts:59-73`）。ready 统一走 IPC。
- 去掉：`AICLIENT_PI_WORKER_GENERATION`、单会话 bridge 模式（`bridge.js:33,61-63`）、测量操作（`shared-bridge.js:215-314`），测量操作挪进测试 bundle。

Main 侧 `DshChannelTransport` 对 `WorkerTransport` 接口的实现（`WorkerTransport.ts:11-19`）：

| 接口 | 行为 |
|---|---|
| `pid` | 宿主 pid，只用于诊断 |
| `postMessage` | 发送 `{ch, rpc}` |
| `onMessage` | 由 supervisor 按 `ch` 分发 |
| `onStderr` | 永远不触发 |
| `kill()` | 发送 `{host:'close', ch}` 并返回 `true` |
| `onExit` | 两种情况触发：收到 `closed` 时 `{code:0, signal:null, cause:'channel-closed'}`；宿主退出时 `{code, signal, cause:'host-exit'}`，此时所有通道同时触发 |

这样 `WorkerSlot` 的 dispose 与 crash 流程不用改：
- dispose：RPC → `kill` → 等 exit；
- crash：宿主退出 → 所有 slot 同时 crash。

「旧进程已退出」就变成「宿主确认通道已关」。确认不了时 slot 停在 `dispose-failed`（`WorkerSlot.ts:606-613`），由 WorkerManager 升级处理（§4）。

## 3 Supervisor 与宿主级故障

### 3.1 状态机

| 状态 | 进入 | 出口 |
|---|---|---|
| `idle` | 初始；空闲关停后；`invalidateAll` 之后 | `ensureHost()` → `starting` |
| `starting` | 拉起进程（参数与环境见分片 03） | 在 60 s 内收到 `ready` 且 pid 相符 → `ready`；`exit` / `fatal` / 超时 → 计入预算 → `restarting` 或 `failed` |
| `ready` | 握手完成 | 崩溃 / 卡死 / 升级 → `restarting`；空闲 / invalidate / 退出 → `stopping` |
| `restarting` | 非计划退出 | 旧进程 `exit` 已确认 → `starting`；5 s 内确认不了 → `failed` |
| `stopping` | 计划内关停 | 退出后 → `idle`（应用退出时 → `disposed`） |
| `failed` | 预算耗尽，或旧进程无法确认退出 | 只有**用户发起**的 create / resume 调 `ensureHost` 时，才允许再试一次 |
| `disposed` | 应用退出 | 一律拒绝 |

- `ensureHost()` 与 `restart()` 都是单飞的：同一时刻只有一次拉起。
- 不变式：`child` 的 `exit` 没有观察到之前，绝不 spawn 第二个宿主。

### 3.2 心跳与判定

- 最近 5 s 没有收到宿主的任何消息时，发一次 ping。会话流量本身就算存活证明。
- 距上次收到消息超过 20 s，并且至少有 2 个 ping 没有回音 → 判定卡死。
- 两种情况不计入判定：
  - Main 自己的计时器迟到超过 1 s（比如 Main 卡住，或机器在换页）：把迟到的时长从计时里扣掉；
  - `powerMonitor` 的 `resume` 事件：系统刚从休眠唤醒，重置计时。
- 近乎超时也要记下来，用于调阈值：pong 往返超过 2 s，或 `eldMaxMs` 超过 200 ms，都写 `console.warn`，附上通道数与 RSS。
- 依据：P0-6 实测最坏的事件循环阻塞是 0.3 s，2000 条历史的恢复是 0.25 s，新宿主第一次用工具是 63～82 ms（`p0-6…md:41,261,271`）。20 s 比这些高两个数量级。

### 3.3 强杀（`killHost`）

1. 前置校验：
   - `child.pid` 是大于 1 的安全整数，不等于 `process.pid`，并且等于握手时报的 pid；
   - `child.exitCode` 与 `child.signalCode` 都还是 `null`。
2. 计划内的关停先走优雅路径：发 `{type:'shutdown'}`，最多等 3.5 s。宿主自己在 dispose 之后 3 s 会强制退出（`host.ts:182-187`）。
3. 硬杀：`child.kill('SIGKILL')`，在 Windows 上就是 TerminateProcess。然后最多等 `exit` 5 s。
4. 仍然没有 `exit` → 进入 `failed`，原因记为 `host_exit_unconfirmed`（比如进程卡在 D 状态）。不拉新宿主。

判定为卡死的路径跳过第 2 步。禁止的做法：用算出来的 pid 调 `process.kill`、负数 pid、按进程组杀、按名字杀（kill(-1) 事故就是这么来的）。

### 3.4 崩溃后的收尾与恢复

- **在飞回合的收尾**：沿用 `handleLifecycle`（`WorkerManager.ts:3169-3216`），只补字段：
  - `session.failed` 带上 `errorCode`：崩溃为 `dsh_host_crashed`，计划内重启为 `dsh_engine_restarted`；
  - 计划内重启时，`disconnected` 带上 `disconnectReason: 'engine_restarted'`（在 `runtimeEvents.ts:209` 追加这个值）。
  - 恢复时 DSH 会自己补写 `turn/end interrupted`、`TOOL_OUTCOME_UNKNOWN` 和 `session/end-seed`（`p0-6…md:19-23,145`），由 P1-4 投影。
  - 挂着的审批卡由渲染层收到终止事件后收起（推断，P1-3c 核对）。
- **只重启一次**：宿主退出时，所有通道的 slot 同时 crash。WorkerManager 不再给每个 entry 各排一个 `restartEntry`，而是把它们放进 `pendingHostRecovery`，只排**一个** `serialize(recoverHostEntries)`，用微任务合并。批次内部：
  1. `await supervisor.ensureHost()`；
  2. 按顺序逐个 `restartEntry(entry, {hostCrash: true})`：先前台（`ownerWebContentsId` 不为空），再在飞 / 停止中 / 上次 pong 报告 busy 的，其余按 `lastUsedAt` 从近到远；
  3. 宿主在批次中途又崩了，就中止这个批次，等下一次 `exit` 重新排。
- **为什么串行**：宿主是单线程的。P0-6 实测 5 个会话逐个恢复每个 9.8 ms，并行是 ready 后 55 ms，差不多（`p0-6…md:16-17`）。关键在于只重启一次宿主，而不是拉 N 个进程。串行还便于判断是谁把宿主弄崩的。
- **两级预算**：
  - 宿主级：5 min 滑动窗口内，非计划重启（崩溃、卡死、Stop 升级、启动失败）最多 3 次。超过就进入 `failed`，所有活着的 entry 转为 `error`，错误码 `dsh_host_unavailable`，manager 进入 `degraded`。
  - 会话级：沿用每 60 s 2 次，但只计这个会话自身导致的恢复失败（`dsh_session_missing`、`session_cwd_mismatch`、日志损坏等）。宿主崩溃不扣会话预算。
- **可疑会话熔断**：
  - supervisor 为每次非计划退出记下当时「活动」的会话：有在飞回合、正在停止、或正在批次里恢复。
  - 同一个会话连续两次出现在这个集合里，就标为可疑。之后的批次跳过它，把它置为 `error`，错误码 `dsh_session_suspect`。
  - 用户重试照常走「error 先退役、再走冷路径」（`WorkerManager.ts:921-927,1160-1166`），并清掉一次可疑标记。
- **单个会话的降级**：只有这个会话进 `error`，其他会话不受影响；用户点重试就能恢复。
- **退出判据「会话不停在 error」**由上面几条共同保证：
  - 宿主崩溃不扣会话预算；
  - P1-1 的空页 `initialHistory` 消除了 `worker_restart_history_missing`；
  - 真的进了 error，用户一次操作就能退出。

## 4 Stop 看门狗的升级阶梯

```
t0        Stop → 布防 10 s（不变）→ worker.stop → DSH agent.cancel({kind:'user'})
          正常情况：turn/end aborted → session.stopped → 解除看门狗（不变）
t0+10s    forceStop → enterCrashed → session.stopped{forced} + idle   ← T144 承诺在这里兑现，不变
          → serialize(restartEntry)
阶梯 A    旧 slot dispose → 通道 worker.dispose（等 ACK 3 s）→ 宿主内 agent dispose：
          cancel(disposed) → whenIdle → 关句柄、释放锁（已流出的正文记为 interrupted）
          → closed → exit{channel-closed} → 新通道、generation+1、resume → resumed + refresh + idle
          其他会话无感
阶梯 B    ACK 超时，或 3 s 内没收到 closed → slot 停在 dispose-failed，而 exit.cause 不是 host-exit
          → restartEntry 不再重试本会话，改调 supervisor.restart('stuck-session')（计入宿主预算）
          → 优雅关停（3.5 s）→ 不退就 SIGKILL → 所有通道 exit{host-exit} → 按 §3.4 恢复，卡住的会话排最前
心跳 C    任何时刻事件循环卡死 → 20 s 判定 → SIGKILL → 同上
```

- **时间上限**：
  - Stop 的界面收尾：10 s，不变。
  - 会话重新可用：走阶梯 A 约 13 s；走阶梯 B 最坏约 10 + 3 + 3.5 + 5 + 0.8 + 恢复时间 ≈ 23 s（Linux 实测值推算）。
- **对其他会话的影响与告知**（只在阶梯 B / C 出现）：
  - 在飞的回合收到 `session.failed{errorCode:'dsh_engine_restarted'}`，文案写明「为恢复卡住的会话 X 重启了引擎」；
  - 空闲的会话收到 `disconnected{disconnectReason:'engine_restarted'}`，渲染层提示一次，写法同 `capacity_reclaimed`（`chatSessions.ts:1262-1272`，`useCapacityReclaimNotice.ts:30`）；
  - 优雅关停时，DSH 会把它们已经流出的正文也记为 interrupted（`dsh-agent-loop:1069-1085`），不像 SIGKILL 那样丢掉；
  - 之后自动恢复。
- **阶梯 A 的局限**（推断）：dispose 与 cancel 都要等 `whenIdle`，所以 cancel 收不了尾时，A 多半也会超时。A 真正能挽回的是卡点在我方 RPC 链或 bridge 映射上的情况。每次走到 B，都要记下是哪个会话、哪个阶段，作为给上游报缺陷的素材。
- **备选**：
  - B 的有界延迟版：等其他会话空闲，最多 60 s。
  - C：P1-4 做完种子分叉之后，把桩指向一个新的种子会话，卡住的旧 agent 留到下一次自然重启再清理，这样完全不动宿主。

## 5 生命周期边界

- **空闲关停**：没有 entry、也没有进行中的 create / resume，持续 10 min，就优雅关停；下次按需冷启动，约 0.8 s（`p0-6…md:15`，Windows 没有测过）。
- **`invalidateAll()`**（调用方：`auth/index.ts:70`、`onboarding.ts:122`、`piModels.ts:48`、`piPlugins/index.ts:123-139`、`userProviders/index.ts:110` 等）：先 dispose 所有 entry（现有逻辑，`WorkerManager.ts:2464-2470`），再 `supervisor.shutdown()`。原因：
  - 登出后凭据不能留在宿主进程里；
  - P1-5 的路由、P1-10 的插件都是宿主级配置；插件装完要重启宿主才生效（`p0-2…md:10`）。
- **应用退出**：`disposeAll('app-shutdown')` 在本地退役所有 entry（发 `stopped(forced)`），不再逐个通道 RPC，然后 `await supervisor.shutdown()`：优雅关停最多 3.5 s，再 SIGKILL 并等 1.5 s，总共落在 7 s 截止之内（`ipc/index.ts:107`）。同步兜底 `forceKillAllNow()` 额外调用 `supervisor.forceKillNow()`，即 `child.kill('SIGKILL')`。
- **自动更新**：
  - `AutoUpdaterService.quitAndInstall()`（`AutoUpdater.ts:191-196`）改成先 `await` 宿主关停并确认退出（最多 5 s），再调 `autoUpdater.quitAndInstall()`；`will-quit` 那条路径作为第二道保险。
  - 理由：`koffi.node`、`conpty.node` 是从安装目录原地加载的，宿主不退，NSIS 覆盖就会失败（P1-2 方案第 87、122 行）。NARB 走缓存副本，不占安装目录（`node-addon-native-custom-loader/lib/index.js:74-93`）。
  - NSIS 升级时会不会顺带结束 `node.exe` 子进程，没有核实，要在 Windows CI 上验证（P1-14）。
- **第二个应用实例**：
  - 同一个 profile 的第二个实例会直接退出；不同 profile 用的是不同的 `DSH_HOME`。
  - 1.0.x 与 DSH 分支构建共用 userData，所以不能同时运行；1.0.x 也不碰 `DSH_HOME`。
  - 剩下的风险来自外来的 DSH 进程，比如 P1-11 的 TUI，或者用户手动把 `DSH_HOME` 指到我方目录：会话锁能保护日志（表现为 `session_locked`），但 profile 与存储的写入没有协调。规则：谁都不许在我方 `DSH_HOME` 上另起宿主。可选的 home 锁（借一个哨兵会话加内核锁，推断）留作后续。
- **profile bundles 在首次启动时冻结**（P1-2 提出）：
  - `initProfile` 只在清单不存在时才写（`dsh-app-boot:575-591`）；之后以清单为准（`:919-920`）；`host.ts` 里的 `BUNDLES` 只起播种作用（`host.ts:93-94`）；DSH 只会规整它自己发行的 bundle 组合（`:854-872`）。
  - 升级时的后果：
    - 新增的产品 bundle 静默不加载；
    - 产品 bundle 改名或删除，会进 `skippedBundles`，宿主拒绝启动（`host.ts:95-98`）；
    - P1-10 装的插件 bundle 在 DSH 升级后 peer 不匹配，同样会让宿主拒绝启动。
  - 修法（P1-3a）：
    - 每次启动时 `reconcileProductBundles(当前, PRODUCT, RETIRED)`：产品 bundle 放在最前，保留插件 bundle，剔除已退役的；有差异才用 `writeProfileBundles` 写回（`:1084-1097`）。
    - 产品 bundle 被跳过 → 明确报错；插件 bundle 被跳过 → 告警，并在 ready 里带上 `skippedPlugins` 报给 Main。

## 6 事件循环争用的缓解

- **事实**：
  - 1～8 个会话并发时，p99 ≤ 6 ms。
  - 2000 条历史、不压缩时，每次拼请求阻塞 45 ms；4 个这样的会话同时发请求，卡 190～290 ms。
  - 每次 bash 调用有一次同步 spawn，耗时 5～25 ms（`p0-6…md:25-33,254-273`）。
- **P1-3 做的**：
  - 自动压缩保持默认开启。P0-6 是用 `AICLIENT_DSH_COMPACTION_AUTO=0` 关掉后测的（`p0-6…md:88`），开着压缩时请求被窗口封顶（推断：阻塞会随之下降，未实测）。
  - pong 带上 ELD 与 RSS，超阈值写日志。
  - 容量上限 10。
  - 心跳阈值远高于这些阻塞。
  - 恢复时串行。
- **不做**：分片（不受支持）；向上游报同步 spawn、做 `MALLOC_ARENA_MAX` 对比（`p0-6…md:360`）归 P1-8。

## 7 WorkerManager 改动要点（P1-3c）

1. `handleLifecycle`：读取 `exit.cause`，补 `errorCode` 与 `disconnectReason`；遇到 `host-exit` 就改走批次恢复（§3.4）。
2. `restartEntry(entry, {hostCrash})`：宿主崩溃时不扣会话预算；supervisor 处于 `failed` 时直接置 `error`（`dsh_host_unavailable`）；旧 slot 没确认关闭且原因不是宿主退出时，升级为 `supervisor.restart('stuck-session')`（§4 B）。
3. 可疑会话熔断的记账：崩溃历史由 supervisor 提供，由 WorkerManager 裁决。
4. `disposeAll('app-shutdown')` 改成宿主级关停；`forceKillAllNow()` 与 `invalidateAll()` 带上 supervisor。
5. entry 数变为 0 时通知 supervisor，启动空闲计时；有新 entry 时取消。
6. 默认容量分档改为 10 / 6；`getStatus()` 可以带上 `host: {state, pid, restarts, lastExit}`，供诊断用。
7. stderr：DSH 通道不再产生 `session.stderr`。按 entry 收集 stderr 的逻辑留给 native 与导入路径，到 P1-12 删除。宿主的 stderr 由 supervisor 在崩溃时回放。
