# P1-3 分片 01 · 现状与「一进程」假设

Role: detail shard。上位：[P1-3 方案](../p1-3-shared-host.md)。回答调研问题 1（WorkerManager 现状）和问题 2（P0-6 的 shared-bridge 做了什么）。Main 与子包的行号指 HEAD `941ab5b1`；DSH 包的行号指 `src/dsh-host/node_modules/@deepseek-ai/<包>/lib/index.js`（`0.1.7-rc.2`）。

## 1 WorkerManager：一会话、一 slot、一进程

### 1.1 两层状态

- **entry**（`ManagedSlot`，`WorkerManager.ts:140-267`）
  - 状态：`creating / ready / restarting / crashed / disposing / error`（`:121-127`）。
  - 与本任务相关的字段：`slot`、`generation`、`restartAttempts`、`activeRequestId`、`stopWatchdog`、`reportedStatus`，以及 stderr 的三件套 `stderrPending / recentStderr / stderrForwarded`。
- **slot**（`WorkerSlot.ts:133`）
  - 注释写明它「拥有一个 utility process 的一代」（`:127-131`）。
  - 状态：`running / replacing / disposing / crashed / dispose-failed / disposed`（`:13-19`）。
  - 每个请求都带上 slot 的 generation，回来的消息 generation 对不上就丢弃（`:411-421,531-534`）。
- **生命周期串行化**：create、resume、rewind、reload、fork、close、回收、invalidate、dispose、restart 全部经 `serialize` 排在同一条 `lifecycleChain` 上（`:542,2900-2907`）。

### 1.2 transport 与进程

- `WorkerTransport` 接口：`pid`、`postMessage`、`onMessage`、`onError`、`onExit`、`onStderr`、`kill()`（`WorkerTransport.ts:11-19`）。
- Node 子进程版的 `kill()` 就是 `proc.kill()`（`:136-138`）。在 POSIX 上它发 SIGTERM，宿主会走优雅停止（`host.ts:191`）；在 Windows 上 Node 一律硬杀。
- 拉起点：`createPiWorkerSlot` 每次调用都 fork 一个新进程（`createPiWorkerSlot.ts:70-75`）。
  - 开发开关下拉的是 DSH 宿主（`devDshEngine.ts:103-120`），cwd 等于 `DSH_HOME`（`:80-82,97`），generation 通过环境变量传入（`:92`）。
  - bootstrap 超时 60 s（`:58`）；bootstrap 失败就 dispose 这个 slot（`:143-151`）。

### 1.3 崩溃与重启

- **检测**：transport 的 `exit` 或 `error` → `WorkerSlot.crash()`：拒绝所有挂起请求，杀掉 transport，发出 `crashed` 生命周期事件（`WorkerSlot.ts:459-494,570-592`）。
- **`handleLifecycle`**（`WorkerManager.ts:3169-3216`）：
  - 先 `enterCrashed`（`:3223-3238`）：清掉看门狗，回放 stderr，清 latch。
  - 然后按 entry 发事件：正在停止的发 `stopped(forced)` 加 idle；有在飞回合的发 `disconnected` 加 `session.failed`；都没有的发 `disconnected`。
  - 最后 `serialize(restartEntry)`。
- **`restartEntry`**（`:3240-3379`）：
  1. 预算：每个 entry 在 60 s 内最多 2 次（`:373-374,3254-3265`），用完进 `error`。
  2. `oldSlot.dispose('slot-replace')`：「确认旧进程退出前，绝不在替代进程里打开同一个会话文件」（`:3281-3294`）。
  3. generation 加 1，`spawnForEntry`。
  4. 核对重新打开的是不是同一个文件（`:3336-3342`）。
  5. 要求返回 `initialHistory`，缺失就抛 `worker_restart_history_missing`（`:3343-3349`）。
  6. `commitPiLeaf`，然后发 `session.resumed`、`session.history(refresh)` 和 idle（`:3355-3366,2853-2876`）。
  7. 任何一步失败：回到 `crashed`，再排一次重启（`:3367-3378`）。
- **`error` 不是终点**：之后用户再 create 或 resume，会先退役这个 entry，然后走冷路径（`:921-927,1160-1166`）。所以在 error 上点「重试」，本来就能恢复。

### 1.4 Stop 看门狗（T144 / 决策 046）

- `STOP_WATCHDOG_MS = 10_000`（`:376-382`）。在发出 `worker.stop` 之前就布防，而不是等收到 ACK 才布防（`:2091-2093`）；第二次 Stop 沿用第一次的截止时间（`:2182-2192`）。
- 回合的终止事件会解除看门狗（`:3101-3112`）。
- 到点时执行 `forceStop`（`:2205-2213`）：`enterCrashed`，发 `stopped(forced)` 与 idle（`:2216-2230`），再 `restartEntry`。重启里的 dispose 允许丢 ACK，只要进程确认退出就行（`:3285-3292`）。
- 另外两条收尾路径：
  - 找不到 slot 或回合时，直接由 Main 回 `no_active_turn`（`:2143-2180`）；
  - 关闭会话时，由 `retireEntry` 发 `stopped(forced)` 与 disconnected（`:3019-3058`）。

### 1.5 容量、回收与强杀

- 容量上限 10，环境变量可调（`:435-472`）。默认值按机器内存分档：≤4 GiB 为 3，≤8 GiB 为 6。分档的理由写的是「一个 slot 就是一个 utilityProcess 加一份模型上下文」（`:446-451`）。
- 满了就驱逐：优先驱逐已经 error 的，其次是最久没用的空闲会话（`:2909-2936`），并发 `capacity_reclaimed`（`:3001-3009`）。空闲 15 min 回收（`:371,2938-2946`）。
- `forceKillAllNow`：清空两个 map，然后对每个 slot 调 `forceKillNow` → `transport.kill()`（`:2508-2533`；`WorkerSlot.ts:284-301`）。

### 1.6 退出

- `will-quit` 时：`event.preventDefault()` → `cleanupAllResources()`，全局 7 s 截止；到点先执行 `cleanupWorkerManagerSync()`，Main 在 8 s 时强制退出（`index.ts:103,916-954`；`ipc/index.ts:100-116`）。
- `cleanupWorkerManager` 调用 `workerManager.disposeAll('app-shutdown')` 与 `piUtilityService.disposeAll()`；同步版本调用两者的 `forceKillAllNow()`（`ipc/workerManager.ts:6-28`）。
- `disposeAll` 先处理导入 slot，再对每个 entry 做 dispose（ACK 3 s，加进程退出 3 s）（`WorkerManager.ts:2472-2506`；`WorkerSlot.ts:92-94`）。

## 2 「一个 slot 就是一个进程」的假设清单

| # | 位置 | 假设 | 共享宿主下的问题 |
|---|---|---|---|
| 1 | `WorkerSlot.ts:348-394,595-622` | dispose = RPC + 杀进程 + 等进程退出 | 关一个会话不能杀宿主。「确认退出」要改成「宿主确认通道已关」 |
| 2 | `WorkerSlot.ts:459-494,570-592` | transport 退出 = 这个会话崩溃 | 宿主退出时所有通道要同时进入 crash；单个通道也能单独关闭 |
| 3 | `WorkerSlot.ts:284-301`；`WorkerTransport.ts:136-138` | 强杀 = `proc.kill()`，POSIX 上是 SIGTERM | 卡死的宿主 3 s 内退不掉（P1-1 §9）。要对确切 pid 发 SIGKILL，并且只由 supervisor 执行 |
| 4 | `devDshEngine.ts:92`；`bridge.js:33` | generation 是进程级的环境变量 | 一个宿主要同时服务多个会话、多代 generation，generation 只能放在消息里 |
| 5 | `bridge.js:61-63` | `worker.dispose` 之后宿主整体退出 | 只关这一个会话，宿主继续运行（原型里已经这样做，`shared-bridge.js:187-190`） |
| 6 | `WorkerManager.ts:3169-3216,3240-3379` | 崩溃按 entry 各自重启，各扣各的预算 | 宿主崩一次会扣掉 N 个 entry 的预算；连崩两次，全部进入 error |
| 7 | `WorkerManager.ts:2205-2213` | Stop 强制重启 = 重启这个会话的进程 | 共享宿主下会杀掉整个宿主，连带其他会话（P1-0 证据第 39 行） |
| 8 | `WorkerManager.ts:2626-2698` | stderr 属于某一个会话 | 宿主的 stderr 没法归到具体会话 |
| 9 | `WorkerManager.ts:438-456,2472-2506` | 容量分档和退出流程都按进程计 | 每多一个会话只增加 3～46 MB（`p0-6…md:36-43`）；退出可以改成宿主级一次关停 |

## 3 P0-6 的 shared-bridge 做了什么

- **启用方式**：`AICLIENT_DSH_SHARED_BRIDGE=1`，同时关掉 `aiclient-probe`（`p0-6…md:66`）。此时宿主不处于单会话 bridge 模式，`ready` 走 IPC 发给父进程（`host.ts:65,247`），驱动等收到 ready 后再发消息（`p0-6-probe.ts:292-301`）。
- **寻址**：两个方向都用 `{slot, rpc}` 信封，另有测量用的 `{p06, requestId}` / `{p06Reply}`（`shared-bridge.js:10-24`）。
- **每个 slot 一套原样的实现**：`PiWorkerRpcServer` 加 `DshSessionRuntime`，与 P0-3 同一对（`:169-194`）。
  - generation 取这个 slot 首条消息里的值（`:319-321`）。
  - **任何类型的消息都会新建 slot**（`:318-321`），正式版要改成只有 bootstrap 能建。
- **关闭**：`worker.dispose` 只删掉这个 slot，宿主继续运行（`:187-190`）。
  - `PiWorkerRpcServer` 按 slot 串行处理请求（`piWorkerRpcServer.ts:371-374`），并且只有在 runtime 真正 dispose 完之后才回 ACK（`:1040-1062`）。
- **恢复路径**：驱动在 kill 之后拉起一个新宿主，给每个 slot 带上 `sessionFile` 重发 `worker.bootstrap`（`p0-6-probe.ts:769-772,616-640`）。bridge 读取桩文件后调 `agents.resume`。
- **测量操作**：`eld-start/stop`、`mem`、`read-session`、`live`（`shared-bridge.js:215-314`）。这些都不能进产品，与决策 015 的理由相同。
- **证据里记下的缺口**：
  - 恢复时不带 `initialHistory`，`history` 返回 0 条，`leaf` 为空（`p0-6…md:24,185-191`）。
  - `turn/end interrupted` 和 `TOOL_OUTCOME_UNKNOWN` 只写在日志里，不会实时发出（`:21-23,174,192-195`）。
  - Main 两次重试后停在 error（`:24,190`）。P1-1 决策 010 第 1 条用空页的 `initialHistory` 补上了这一半。
  - 多 slot 传输只证明了可行，正式实现属于 transport（`:350`）。
  - Main 必须先确认旧宿主已经退出（`:160-161,336`）。

## 4 DSH 侧与本任务有关的事实

- **cancel 与 dispose**：
  - `cancel` 只是 abort 当前阶段的信号（`dsh-agent-loop:815-821`）。
  - agent 句柄的 dispose 依次做：`cancel({kind:'disposed'})` → `await machine.whenIdle()` → `scope.dispose()` → `handle.close()`（`:1662-1694`）。所以 `cancel` 收不了尾的场景，dispose 很可能也会卡在 `whenIdle`（推断）。
- **中断时的落盘**：流式输出被 abort 时，已经流出的块会写成 `assistant/message {interrupted: true}`（`:1069-1085`）。所以优雅关停不丢正文，而 SIGKILL 会丢（`p0-6…md:20`）。
- **fail-loud**：任何未捕获的异常或 rejection 都会让宿主在 2 s 内 `exit(1)`（`dsh-app-boot:3740,3781-3819`；`host.ts:160-162`）。
- **锁**：POSIX 上是 `session.lock` 上的 `flock`，Windows 上是命名信号量。进程一死锁就释放；活着但卡住的持有者会一直挡住别人。在 POSIX 上删锁文件等于放弃互斥（`dsh-session-persistence-jsonl/README.md:164`）。DSH 没有删除会话的 API（`:163`）。
- **宿主停止**：`stop()` 执行 `fiber.dispose()`，3 s 后强制退出；在非单会话 bridge 模式下，会先发 `{type:'stopped'}` 再断开 IPC（`host.ts:164-188`）。IPC 断开也会触发停止（`:197`）。
- **工具子进程**：宿主退出时，`subprocess-local` 会在 `exit` 监听里终止所有受管进程（`dsh-subprocess-local:1286-1306`）。在 Linux 上被 SIGKILL 时，靠的是 bwrap `--die-with-parent` 或 systemd scope（`p0-6…md:162-164`）。
