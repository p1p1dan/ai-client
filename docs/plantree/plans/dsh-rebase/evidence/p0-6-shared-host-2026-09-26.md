# P0-6 共享宿主补验：崩溃恢复、并发回合延迟、带历史会话的内存（2026-09-26，Linux 开发机）

Role: evidence。对应 [roadmap P0-6](../roadmap.md)，是[决策 002](../decisions/002-defer-encrypted-machine-and-shared-host.md) 第 3 条要求的进 P1 前补验。测量方法与口径沿用 [P0-1](p0-1-host-probe-2026-09-25.md)，事件与 bridge 映射见 [P0-2](p0-2-goal-and-plugins-2026-09-25.md) / [P0-3](p0-3-bridge-2026-09-25.md)。原始数据（已去掉本机路径与 stderr）在同目录 [p0-6-shared-host-2026-09-26.data.json](p0-6-shared-host-2026-09-26.data.json)，由 `src/dsh-host/p0-6-probe.ts` 生成（代码提交 `2f9a44a7`）。

## 结论先行

1. **崩溃恢复：引擎层成立；产品层还差 bridge 和 Main 两块，都是 P1 的活，不是阻塞项。** 决策 002 不需要重议。
   - 3 轮、每轮 3 次 SIGKILL：逐项核对的恢复共 24 次，另有 15 次只计时的快路径恢复，结果全部一致：
     - 存盘日志逐事件一致（摘要哈希相同），读回不报损坏。
     - 写锁随进程死亡由内核释放。`flock -n` 实测：活着时 held，被杀后 free，恢复后又是 held。
     - 恢复后都能继续跑回合。下一轮请求里，模型能看到之前的工具输出和回复。
     - 宿主被杀时正在跑的工具子进程（bwrap → bash → `sleep 30`）1 秒内全部消失，没有孤儿。
   - **耗时（中位数）：**
     - 宿主被杀后约 19 ms（15～24）观察到退出。
     - 重启到 ready 796 ms（760～852）。
     - 逐个恢复时每个会话 9.8 ms（6.8～23，新宿主里第一个约 18 ms）。
     - 5 个会话并行恢复，ready 后 55 ms 全部完成。
     - **从 kill 到所有会话可用 888 ms**（844～891）。
   - **回合进行到一半被杀，这一轮的结局是「正文丢失 + 标记中断」：**
     - 已经流到 GUI 的正文没有落盘。DSH 在一步结束时才写 `assistant/message`，被杀前 GUI 已画出约 18 块正文，全部丢失。
     - 用户消息保留。恢复时 DSH 补写 `step/end` 和 `turn/end {kind:'interrupted'}`。
     - 工具执行中被杀的，另补一条合成的错误工具结果 `TOOL_OUTCOME_UNKNOWN`，告诉模型「结果未知，只读或幂等操作才重试」。
     - 这些补写**不会**经 `session/event` 实时发出，只能从日志里读到。
   - **现有 bridge 接不住恢复，GUI 会显示错。** `worker.bootstrap` 恢复时不返回 `initialHistory`，`worker.history` 返回 0 条，恢复过程中一条 RuntimeEvent 也不发。Main 的 `restartEntry` 因此会抛 `worker_restart_history_missing`，两次重试后会话停在 `error`。完整补项清单见[§P1 必补清单](#p1-必补清单main--bridge)。
2. **并发回合延迟：8 个会话同时流式输出也没有可感知的变慢。真正的争用来自长会话。**
   - 1 / 2 / 4 / 8 个会话错开 350 ms 同时跑回合，每 30 ms 一块，中间夹 bash / read / bash：
     - 从假网关发出 delta 到 bridge 收到：p50 0.3～0.4 ms，p99 1.3 / 1.6 / 5.0 / 5.7 ms，单次最大 23 ms。
     - 到 Main 进程收到对应 RuntimeEvent：p50 再多约 0.1～0.2 ms，p99 再多 0.1～1 ms。
     - 事件循环延迟（已减去 10 ms 采样间隔）：p99 1.9 / 2.5 / 5.9 / 6.1 ms。
     - 回合耗时没有变化（6.55 s）。宿主 CPU 最高 14%。
   - **风险有两处：**
     - **长会话。** 一个 2000 条消息的会话，每次发模型请求都要把约 2.4 M 字符的上下文拼一遍，单次阻塞约 45 ms。4 个这样的会话同一时刻发请求，事件循环一次卡住 **190～290 ms**，这期间所有会话的流式输出都停住。
     - **每次 bash 调用。** DSH 都会同步 spawn 一次 `systemd-run` 或 `systemctl` 探测，每次阻塞 5～25 ms。
3. **带历史会话的内存：每会话的历史成本两种引擎差不多，共享宿主只付一次基线，所以总量明显更省。** 以下 RSS 为 3 轮中位数，heap 在强制 GC 后测。

   | 会话规模 | DSH 共享宿主：恢复后 RSS 增量 / heap 增量 | 我方 native worker：比空会话 worker 多出的 RSS | 恢复耗时（DSH / worker） |
   |---|---|---|---|
   | 空会话 | +2.8 / +0.4 MB | 基线 95 MB | 10 ms / 213 ms（含进程启动） |
   | 100 条 | +2.4 / +1.4 MB | +1.7 MB | 74 ms / 238 ms |
   | 500 条 | +4.5 / +3.8 MB | +5.7 MB | 62 ms / 244 ms |
   | 2000 条 | **+46 / +12 MB** | **+54 MB** | 247 ms / 298 ms |

   - **同一宿主依次恢复 4 个不同的 2000 条会话：** RSS 186 → 231 → 237 → 263 → 268 MB（中位数）。4 个合计 +82 MB（3 轮 75～116），平均每个约 +20 MB，比单独恢复一个的 +46 MB 少；heap 每个会话约 +10.5 MB。4 个会话各跑一轮后 RSS 约 300 MB，峰值 341 MB。
   - **同样 4 个会话换成 native worker：** 按单 worker 实测外推，约 4 × 150 ≈ 600 MB RSS。

## 方法

- **机器与纪律**
  - 开发机 2 核 / 3.3 GB，内核 7.0.0-34。每组数据跑 3 轮取中位数。
  - 每轮开跑前记下 `/proc/meminfo` 和负载（见 data.json 各轮的 `machine` 字段）：
    - MemAvailable 1.66～1.86 GB；
    - 1 分钟负载 0.3～1.2；
    - swap 已用 1.06～1.28 GB，会话开始前就已占用约 0.96 GB。
  - 开跑前等 vitest 进程清零。没起 Electron，没跑全量测试。
  - 同时存活的宿主除「卡死宿主」一项是 2 个外，其余始终只有 1 个，并发会话最多 8 个。
- **载体：** 宿主、假网关、驱动都跑在随包 Node v24.18.0 上。DSH 包全是 0.1.7-rc.2，没打补丁；cordis 4.0.4。与 P0-1 相同。
- **隔离与联网：** 沿用 P0-1 的做法。
  - 每轮都新建 `/var/tmp/aiclient-dsh-p0-6-*`（0700），环境变量走白名单。
  - 宿主启动目录是私有目录，不是工作区（P0-2 的结论）。
  - 预载 `lib/probe-hooks.mjs`：非回环连接一律断开，所有 spawn 都记录。本次在它基础上给同步 spawn 加了耗时记录。
  - 全部轮次都没有被拦截的连接，也没有 DNS 查询。模型请求只打本地假网关（`dsh-p0-2` 方案），P0-2 关掉的官方行保持关闭。
- **杀进程：** 驱动里所有信号都经 `killPid(pid, signal)`。
  - 它拒绝非整数、≤1、等于自身的 pid。不存在 -1、负 pid、进程组或按名字的 kill。
  - 被杀对象只有宿主本身的 pid（`child.pid`，并与宿主 ready 消息里的 `process.pid` 核对）。
  - 孤儿检查按「pid + 启动时刻」判定。本次一个孤儿都没有，所以清理步骤一次也没用上。
- **拓扑（共享宿主原型）：** 新增 bundle 行 `aiclient-shared-bridge`（`AICLIENT_DSH_SHARED_BRIDGE=1` 时启用，同时关掉 `aiclient-probe`）。
  - 一条 Node IPC 上跑多个 slot。每条消息带 slot 键，每个 slot 各有一套**原样的** `PiWorkerRpcServer` 和 `DshSessionRuntime`，也就是 P0-3 的那一对。
  - 驱动扮演 Main：发 `worker.bootstrap` / `worker.send` / `worker.history` / `worker.dispose`，收 RuntimeEvent。
  - 另有一组测量操作：`eld-start` / `eld-stop`、`mem`、`read-session`（只读打开存盘日志，不拿锁）、`live`。
  - 8 个会话并发时没有出现串会话。
- **假网关：** 在 `fake-gateway.mjs` 的 `dsh-p0-2` 方案里新增：
  - 场景：`P0-CRASH`（一次 bash 再回文本）、`P0-PACED`（慢速长正文）、`P0-SLEEPTOOL`（`sleep 30`）、`P0-LOAD`（4 步，带时间戳的流式帧夹 bash / read / bash）、`P0-HIST`（一次 read，每 10 轮换成 bash，再回约 1 KB 正文）。
  - `P0-RECALL` 支持多个标记，并记录恢复后请求里的消息结构。
- **口径**
  - **重启到 ready：** 从 spawn 算到宿主经 IPC 发出 `ready`，与 P0-1 相同。
  - **会话恢复：** 从发出 `worker.bootstrap {sessionFile}` 算到收到响应。bridge 读桩文件后调用 `ctx.agents.resume`。
  - **事件循环延迟：** 宿主内的 `perf_hooks.monitorEventLoopDelay({resolution: 10})`，从回合开始统计到全部结束。直方图记录的是两次采样的间隔，所以原始值自带 10 ms，**正文里的数字已减去 10 ms**，data.json 里是原始值。
  - **端到端延迟：** 假网关写出每个 SSE 文本帧时，把当时的 `process.hrtime`（CLOCK_MONOTONIC，本机各进程共用）写进文本。
    - 「bridge 收到」在宿主里读，挂在 bridge 所用的同一个 `agent/assistant-stream` 事件上。
    - 「Main 收到」在驱动进程收到 `message.delta` RuntimeEvent 时读。
  - **内存：** 宿主以 `--expose-gc` 启动。
    - heap：先两次 `gc()`，再读 `process.memoryUsage()`。
    - RSS / PSS：再过 1 秒一次、采 5 次，取中位数。
    - 增量：恢复后的值减去同一宿主 ready 后静置 4 s 的值。
  - **消息条数：** 数存盘日志里的 `user/message`（人类发的加 1 条运行时上下文快照）、`assistant/message`、`tool/result` 三类事件。native 数 pi 会话文件里 `type: message` 的行。
- **历史的造法：** 用假网关真实跑出来，不手写会话文件。
  - 一个会话连跑 500 轮 `P0-HIST`，每轮 4 条消息。在 25 / 125 / 500 轮时各复制一份 `DSH_HOME`，得到 101 / 501 / 2001 条。
  - 用 `AICLIENT_DSH_COMPACTION_AUTO=0` 关掉自动压缩（默认仍开）。否则 2000 条（约 2.4 M 字符）远超 200k 窗口，DSH 会调模型做摘要，日志就不再是回合原样写下的东西了。
  - native 对照组用同一个工作区、同一个脚本，经我方 worker 跑出 pi 会话。模型窗口设成 1000 万，同样不压缩。
  - 两边的 read 结果都小于 8 KB，不会触发 DSH 的 `tool-result-pruner`。

复现命令（在 `src/dsh-host` 下，依赖同 P0-1）：

```bash
N=../../out-node-runtime/node
$N p0-6-probe.ts crash --runs 3 --out /var/tmp/p06-crash.json
$N p0-6-probe.ts crash --runs 1 --systemd-scope --out /var/tmp/p06-crash-scope.json
$N p0-6-probe.ts latency --runs 3 --out /var/tmp/p06-latency-lockstep.json
$N p0-6-probe.ts latency --runs 3 --stagger 350 --out /var/tmp/p06-latency-stagger.json
$N p0-6-probe.ts latency --runs 3 --stagger 350 --systemd-scope --out /var/tmp/p06-latency-stagger-scope.json
$N p0-6-probe.ts history-gen            # 500 轮，快照放 /var/tmp/aiclient-dsh-p0-6-hist
$N p0-6-probe.ts history --runs 3 --out /var/tmp/p06-history.json
$N p0-6-probe.ts history-multi-gen      # 4 个会话 × 500 轮
$N p0-6-probe.ts history-multi --runs 3 --out /var/tmp/p06-multi.json
$N p0-6-probe.ts worker-history-gen     # 需要 out-agent-host/worker.js（pnpm build:agent-host）
$N p0-6-probe.ts worker-history --runs 3 --out /var/tmp/p06-worker-history.json
```

`--systemd-scope` 会把 `XDG_RUNTIME_DIR`、`DBUS_SESSION_BUS_ADDRESS` 交给宿主，见 §2 的说明。data.json 由上面这些输出合并、裁剪而成。

## 1 崩溃恢复

### 场景

每轮在一个宿主上依次做：

- **kill 1：3 个会话都空闲。**
  - 先开 3 个会话，各跑一轮 `P0-CRASH`：一次 bash，再回文本。
  - 空闲 1 秒，读一遍存盘日志，用 `flock -n` 查锁，记下进程树，然后 SIGKILL 宿主 pid。
  - 核对退出、孤儿进程、锁、文件大小。拉起新宿主后，先读日志，再逐个恢复。之后读日志、读 `worker.history`，每个会话再跑一轮 `P0-RECALL`，最后查一次锁。
- **kill 2：在 kill 1 拉起的宿主上，5 个会话处在三种状态。**
  - 3 个已经恢复过一次的会话，空闲。
  - s4 正在流式输出 `P0-PACED`：60 块、每块 150 ms，GUI 已收到约 18 块。
  - s5 的 bash 正在跑 `sleep 30`，此时已收到 `tool.updated`。
  - 杀掉后的核对流程与 kill 1 相同。
- **kill 3：只测 Main 侧的关键路径。** SIGKILL 后一见退出立刻拉新宿主，ready 后 5 个会话并行恢复，中间不做任何检查。
- **第 1 轮额外测一次卡死宿主：** 对宿主 SIGSTOP，再起第二个宿主去恢复同一个会话，然后 SIGKILL 被停住的宿主，再恢复一次。
- **单独跑 1 轮 `--systemd-scope`：** 流程同上，只是让 DSH 走 systemd transient scope 这条进程收容路径。

### 数据（3 轮）

| 项 | kill 1（3 个空闲） | kill 2（空闲 + 流式中 + 工具中） | kill 3（快路径） |
|---|---|---|---|
| SIGKILL 到观察到退出 | 16.7 / 15.5 / 19.9 ms | 24.1 / 23.0 / 18.8 ms | 15.0 / 18.9 / 18.6 ms |
| 重启到 ready | 852 / 814 / 778 ms | 760 / 796 / 763 ms | 808 / 816 / 776 ms |
| 每个会话恢复（逐个） | 6.8～20.0 ms | 7.6～23.1 ms | — |
| 5 个会话并行恢复，从 ready 算起 | — | — | 64 / 56 / 49 ms |
| **从 kill 到全部会话可用** | — | — | **888 / 891 / 844 ms** |
| 被杀时宿主的子进程 / 1 秒后仍存活的 | 0 / 0 | 4 / 0（bwrap×2、bash、`sleep 30`） | — |
| 锁：被杀前 → 被杀后 → 恢复后 | held → free → held（3/3） | held → free → held（5/5） | — |
| 日志：被杀前 ↔ 重启后未恢复时 | 事件数与摘要哈希都相同（9/9） | 前缀哈希相同（15/15） | — |
| 恢复后再跑一轮 | 9/9 `session.completed`，RECALL 两个标记都在 | 15/15 completed | — |

- kill 1 / kill 2 列的「重启到 ready」「每个会话恢复」是在核对步骤之间测的。kill 3 是纯关键路径。
- **每次恢复，DSH 都往日志追加 1 个 `session/end-seed` 事件。** 所以空闲会话恢复后事件数从 21 变成 22。

### 逐项核对

- **历史完整：**
  - 空闲会话被杀前后，日志逐事件一致（按 `[seq, type, data]` 算哈希）。
  - 恢复后下一轮请求里，模型确实看到了上一轮的 bash 输出（`crash-probe <token>`）和助手回复（`P0-CRASH <token> finished`）。3 轮全部 present。
  - 被杀两次的会话（kill 1、kill 2 都经历了）同样完整。
- **会话文件没损坏：**
  - 重启后以只读方式打开、全量读回，没有报错。
  - 被杀前后 `session.v4.jsonl.zstd` 的字节数不变。
  - DSH 的「残帧修复」路径这次没有触发：写入按 200 ms 攒批后 fsync，SIGKILL 没有正好落在写入中途。
- **能继续跑回合：** 24 次恢复后的回合全部是 `session.completed`。
- **写锁不残留：**
  - 锁是 `session.lock` 上的 `flock(2)`，内核在进程死亡时自动释放，不需要清理。
  - 反例是「卡死宿主」：进程被 SIGSTOP 后仍然活着，锁一直 held。第二个宿主恢复同一个会话时被拒：`session "aiclient-s1" is already owned by an active write handle`。SIGKILL 这个 pid 并等它退出后，再恢复只用 17.9～20.4 ms。
  - **所以 Main 必须先确认旧宿主已经退出，才能恢复会话。**
- **工具进程：**
  - 被杀时正在跑的 bash 是宿主 → bwrap（`--die-with-parent`）→ bwrap → bash → sleep 这一串，宿主死后 1 秒内全部消失。
  - `--systemd-scope` 那一轮也一样：这时 DSH 用 systemd transient scope 收容，不再报「weaker process-tree containment」。

### 回合进行到一半被杀，恢复后是什么状态

| | 流式输出中（s4） | 工具执行中（s5） |
|---|---|---|
| 被杀前 GUI 已经看到的 | 约 18 块 `message.delta`（`STREAMED-<token> 〔2〕流式正文片段。…`） | `tool.started` 和 `tool.updated`（bash 行显示「运行中」） |
| 被杀前已落盘的（13 / 15 个事件） | `turn/start`、`step/start`、`system/message`、人类消息、运行时上下文快照、`request/header`、`request/context`、`session/title`；**没有 `assistant/message`** | 同左，另有 `assistant/message`（其中的 tool-call）和 `tool/call` |
| 恢复时 DSH 补写的 | `step/end`、`turn/end {kind:'interrupted'}`、`session/end-seed` | `tool/result`（isError，`error.code: TOOL_OUTCOME_UNKNOWN`，正文见下）、`step/end`、`turn/end {kind:'interrupted'}`、`session/end-seed` |
| 恢复后模型看到的 | 只有那条人类消息。流式正文**丢失**（RECALL：`STREAMED-` 标记 missing） | 人类消息、tool_use，以及一条错误结果：*The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry…*。命令的输出**丢失**，命令本身也被杀了 |
| bridge 实时发出的 | 无。补写的事件是预置种子，不走 `session/event` | 无 |
| 驱动（Main）这边的这一轮 | 永远等不到 `session.completed` / `failed`。真实的 Main 会在进程退出时为这一轮发 `session.status disconnected` 和 `session.failed` | 同左 |

结论：这一轮是「**丢失 + 标记中断**」，不是「半截」。

- 已经流出的正文、没跑完的工具输出都不会恢复。
- 日志里留下一个 `interrupted` 结尾。工具执行中被杀的，还多一条「结果未知」的合成工具结果。
- 另外，DSH 按 200 ms 攒批落盘，被杀前 200 ms 内的事件可能丢失。本次两种状态下，被杀前读到的日志与重启后的前缀一致，没有观察到这种丢失。

### bridge 要补什么，GUI 才能显示对

1. **恢复时 `bootstrap` 必须带 `initialHistory`，`history` / `tree` 也要读 DSH 日志。**
   - 现状：`initialHistory` 缺失，`history` 返回 0 条，`leaf` 是空。
   - Main 至少在两个地方强制要求 `initialHistory`：
     - `WorkerManager.restartEntry`：崩溃重启时，缺失就抛 `worker_restart_history_missing`；
     - resume 路径：缺失就抛 `worker_resume_history_missing`。
   - 所以今天的 bridge 下，崩溃重启和重开会话都会失败，而且重试预算（2 次 / 60 s）用完后会话停在 `error`。
   - 需要把 DSH 日志（含补写的收尾事件）投影成 `WorkerHistoryResult`，这正是 P0-3 列的「会话读写」缺口。
2. **中断标记。** `turn/end {kind:'interrupted'}` 只在日志里出现，实时事件里没有。
   - 投影历史时，要把它显示成「宿主崩溃，本轮中断」一类的标记。
   - 现有的 `turn/end` 映射会把它当作 `session.failed "DSH turn ended: {kind:'interrupted'}"`，而且前提是能收到这个事件，但实际收不到。
3. **合成工具结果要单独映射。** 带 `error.code` = `TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED` 的 `tool/result`，工具行应显示「结果未知（宿主中断）」或「未执行」，不要当普通失败显示英文长句。
4. **已流出的正文要有交代。** 用历史刷新时间线时，GUI 上已经画出的半截正文会消失。P1 要定是接受丢失（只显示中断标记），还是由 Main 或渲染层把半截正文保留成一条本地注记。
5. **身份与 leaf。** `leaf` 要能映射 DSH 的日志位置。Main 的 `commitPiLeaf` 和 `leafCheckpoint` 依赖它，现在是 `EMPTY_LEAF`。

### 对 Main 的含义

见[§P1 必补清单](#p1-必补清单main--bridge)的 Main 部分。

## 2 并发回合延迟

### 负载

- 每个会话跑一轮 `P0-LOAD`，共 4 步，每步都是流式正文，每块约 5 个字符加一个时间戳，每 30 ms 一块：
  1. 40 块正文 + bash（`ls -la; wc -c *.txt; cat module-*.ts`，输出约 25 KB）；
  2. 40 块正文 + read（读一个约 3 KB 的源文件）；
  3. 40 块正文 + bash（`seq 1 20000 | awk …; grep -c …`）；
  4. 80 块收尾正文。
- 一轮共 200 块。
- 每档 N 个会话的开跑方式分两种：
  - **错开**：第 i 个会话晚 i × 350 ms 开跑，这样一个会话的工具阶段会和别的会话的流式输出交叠。这是主口径。
  - **齐步**：所有会话同时开跑，脚本完全相同，工具阶段全部撞在一起。这是最坏对齐。
- 每个宿主先跑一轮热身（1 个会话），不计入结果。

### 数据：错开开跑（3 轮中位数；ELD 已减去 10 ms）

| N | ELD p50 / p99 / max | bridge 收到：p50 / p99 / max | Main 收到：p50 / p99 / max | 回合耗时 | 宿主 CPU | 宿主 RSS 峰值 | 同步 spawn：次数 × 最长 = 合计 |
|---|---|---|---|---|---|---|---|
| 空闲 | 0.5 / 0.6～1.8 / 1.5～3.0 | — | — | — | — | — | — |
| 1 | 0.5 / 1.9 / 9.5 | 0.38 / 1.26 / 1.32 ms | 0.55 / 2.08 / 7.1 ms | 6.56 s | 4% | 165 MB | 2 × 5.4 = 10.7 ms |
| 2 | 0.5 / 2.5 / 10.0 | 0.40 / 1.55 / 1.85 | 0.57 / 2.58 / 4.84 | 6.57 s | 7% | 168 MB | 4 × 6.6 = 23.6 |
| 4 | 0.5 / 5.9 / 14.1 | 0.25 / 5.01 / 11.8 | 0.36 / 5.12 / 13.7 | 6.58 s | 10% | 178 MB | 8 × 8.1 = 47.4 |
| 8 | 0.5 / 6.1 / 9.5 | 0.29 / 5.74 / 9.21 | 0.41 / 6.19 / 10.7 | 6.55 s | 14% | 199 MB | 16 × 7.3 = 94.3 |

- 每一档的时间戳都全部收到：200 × N 块，host 和 Main 两侧都一样，没有丢块、没有串会话。
- 所有轮次里单个 delta 的最大延迟：bridge 侧 23.3 ms，Main 侧 23.5 ms（N=2 第 1 轮）。ELD 单次最大 21 ms（N=4 第 2 轮）。
- GC 单次最长多在 10 ms 以内，最长一次 19.6 ms（N=1 第 3 轮）。

### 数据：齐步开跑（3 轮中位数；最坏对齐）

| N | ELD p99 / max（3 轮最大） | bridge 收到：p99 / max | Main 收到：p99 / max | 回合耗时 | 宿主 CPU |
|---|---|---|---|---|---|
| 1 | 2.0 / 9.7（11.1） | 2.27 / 2.76 | 2.89 / 3.03 | 6.58 s | 4% |
| 2 | 2.0 / 12.7（14.6） | 0.93 / 3.05 | 1.54 / 3.10 | 6.63 s | 6% |
| 4 | 3.6 / 25.3（56.9） | 1.69 / 3.14 | 2.13 / 4.20 | 6.74 s | 10% |
| 8 | 6.3 / 51.4（52.8） | 2.03 / 4.08 | 2.14 / 9.84 | 6.99 s | 16% |

齐步时 ELD 最大值更高：8 个会话的工具调用同时到，同步 spawn 和工具结果处理串成一段约 50 ms 的阻塞。但这时没有会话在流式输出，所以 delta 延迟反而更低。这组说明阻塞发生在哪里，不代表体感。

### 数据：交给宿主 systemd 变量（`--systemd-scope`，错开，3 轮中位数）

| N | ELD p99 / max | bridge 收到：p50 / p99 / max | Main 收到：p99 / max | 同步 spawn 合计 |
|---|---|---|---|---|
| 1 | 2.1 / 11.4 | 0.37 / 1.38 / 2.35 | 2.62 / 2.91 | 15.1 ms |
| 2 | 3.3 / 9.7 | 0.31 / 2.34 / 9.15 | 2.56 / 10.0 | 30.4 |
| 4 | 5.3 / 24.1 | 0.30 / 3.91 / 7.19 | 4.91 / 8.05 | 64.2 |
| 8 | 9.8 / 13.7 | 0.32 / 8.35 / 23.1 | 9.29 / 23.2 | 131.5 |

### 三处阻塞源

1. **每次 bash 调用都有一次同步 spawn，这是 DSH `subprocess-local` 的写法。**
   - 探针进程的环境变量走白名单，**Main 的开发开关启动器 `devDshEngine.ts` 也是这样**，都不带 `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS`。
     - 这时 `systemd-run --user` 连不上 user manager，DSH 退回较弱的收容方式，每次 bash 调用都同步重探一遍 `systemd-run`，每次 5～8 ms，最长 15 ms。
   - 交给宿主这两个变量后：
     - 每个宿主第一次调用 bash 时深度探测一次，约 29 ms 的 `systemd-run` 加 13 ms 的 `systemctl`；
     - 之后每次调用还有一次同步的 `systemctl --user show`，8～12 ms，最长 25 ms。
   - 本机 user systemd 虽然报 degraded，但 scope 实际可用。在我们的白名单环境下，DSH 看不到它。
2. **每个新宿主第一轮用工具时，会一次性阻塞 63～82 ms。** 这来自懒加载模块和沙箱探测，见各轮的热身数据。崩溃重启后，每个会话的第一轮都会碰上。
3. **长会话拼请求。** 这是共享宿主里最实在的争用。
   - 造历史时，每轮的 ELD 最大值随会话变长而上升：

     | 已有消息 | 约 100 条 | 500 条 | 1000 条 | 1800 条 | 2000 条 |
     |---|---|---|---|---|---|
     | 该轮 ELD 最大值（减 10 ms 后） | 1 ms | 3 ms | 10 ms | 26 ms | **45 ms** |
     | 该轮耗时 | 46 ms | 49 ms | 93 ms | 158 ms | 280 ms |

     2000 条时请求体约 2.4 M 字符。
   - **4 个 2000 条会话同一时刻各发一轮请求，ELD 最大值为 192 / 200 / 291 ms（3 轮）。** 这是恢复后的第一次请求，同时 4 份上下文在同一个事件循环里拼。4 个回合各用 0.47～0.78 s。
   - 在这 0.2～0.3 s 里，同一宿主上其他会话的流式输出会整体停顿。

**判断：** 典型负载下，共享宿主的延迟代价可以忽略。要落到 P1 的是：长会话的请求拼装做成可观测的指标，比如在 bridge 里记 ELD 与请求字节；同步 spawn 和长会话拼请求报给上游，或在我方插件层规避。

## 3 带历史会话的内存

### 一个宿主恢复一个会话（3 轮中位数）

| 历史（DSH 消息数） | 盘上大小（zstd） | 宿主 ready 后 RSS | 恢复后 RSS | 增量 RSS / heap（GC 后） | 恢复耗时 | 再跑一轮后 RSS / heapUsed / 峰值 | 那一轮的请求大小 | RECALL（首轮、末轮标记） |
|---|---|---|---|---|---|---|---|---|
| 0（新建空会话） | — | 180.3 MB | 183.1 | +2.8 / +0.4 | 10 ms | — | — | — |
| 101 | 108 KB | 180.7 | 183.1 | +2.4 / +1.4 | 74 ms | 189.7 / 42.7 / 189.7 | 141 K 字符 | 3/3 present |
| 501 | 510 KB | 181.3 | 185.8 | +4.5 / +3.8 | 62 ms | 196.2 / 45.1 / 197.2 | 619 K 字符 | 3/3 present |
| 2001 | 2.02 MB | 179.4 | 229.7 | **+46.0**（31～50）/ **+12.2** | 247 ms | 239.1 / 53.6 / 244.5 | 2.41 M 字符 | 3/3 present |

- **heap 基本随历史线性增长，每条消息约 6～8 KB。** 2000 条时 RSS 多出的部分远大于 heap（+46 对 +12）。
  - `external` / `arrayBuffers` 没有变化，所以多出的这块不是 Buffer。
  - 可能的来源是恢复过程中解压和解析的瞬时峰值，glibc 分配器没有把这部分内存还给系统。
  - 支持这一判断的证据：同一宿主里再恢复更多长会话时，平均每个的 RSS 增量明显更小（见下表）。
- 恢复不会立刻把上下文拼好。第一轮请求时才构建，所以「再跑一轮后」的数字更接近真实常驻值。

### 一个宿主依次恢复 4 个不同的 2000 条会话（3 轮中位数）

| 已恢复 | 0 | 1 | 2 | 3 | 4 | 4 个各跑一轮后 |
|---|---|---|---|---|---|---|
| RSS（MB） | 185.8 | 230.9 | 236.5 | 262.5 | 268.0 | 299.9（峰值 341.4） |
| heapUsed（GC 后，MB） | 36.4 | 48.7 | 60.2 | 67.0 | 78.2 | 84 |
| 该会话的恢复耗时 | — | 248 ms | 178 ms | 181 ms | 180 ms | — |

- 4 个会话共 8004 条消息。在共享宿主里恢复完约 268 MB，跑过一轮约 300 MB。
- 这 4 个会话生成时是在同一个宿主里并发各跑 500 轮，共 2000 次请求，用时 119 s。

### 同口径对照：我方 native worker（一个进程一个会话，3 轮中位数）

| 历史（pi 消息数） | 盘上大小（明文 JSONL） | bootstrap 耗时（含进程启动） | RSS / PSS | 比空会话 worker 多出 | 再跑一轮后 RSS / 峰值 | RECALL |
|---|---|---|---|---|---|---|
| 0 | — | 213 ms | 95.2 / 64.1 MB | — | — | — |
| 100 | 156 KB | 238 ms | 96.9 / 65.8 | +1.7 | 101.6 / 101.6 | 3/3 present |
| 500 | 774 KB | 244 ms | 100.9 / 69.6 | +5.7 | 115.6 / 115.6 | 3/3 present |
| 2000 | 3.09 MB | 298 ms | 149.6 / 115.5 | **+54.4** | 154.7 / 171.0 | 3/3 present |

- worker 的 `initialHistory` 返回 80 条一页，`totalCount` 1500。它恢复时顺带把一页历史投影给 Main，DSH bridge 目前没有这一步。
- native 这边的 pi 消息数比 DSH 少 1，因为没有运行时上下文快照那一条。

### 换算

| 会话组合 | 共享 DSH 宿主 | 一会话一 native worker（现状） |
|---|---|---|
| 4 个空会话（P0-1） | 约 181 MB | 387 MB |
| 4 个 2000 条会话 | **268 MB 恢复后 / 300 MB 各跑一轮后 / 峰值 341 MB（实测）** | 约 600 MB RSS / 约 460 MB PSS（按单 worker 实测 × 4 外推） |
| 1 个 2000 条会话加 7 个空会话 | 约 230 + 7 × 3 ≈ 250 MB（外推） | 150 + 7 × 95 ≈ 815 MB（外推） |

**判断：** 历史本身的内存两种引擎处在同一量级。共享宿主省下的是每会话重复一份的 95～180 MB 基线，会话越多越省。长会话多的时候，瓶颈会先落在事件循环（§2 第 3 点），而不是内存。

## P1 必补清单（Main / bridge）

**Main（WorkerManager / WorkerTransport）**

1. **一个宿主进程承载多个 slot。** 消息带 slot 键，各 slot 各自一套 generation。「slot 关闭」和「进程退出」要分开：关一个会话只 dispose 那个 slot。本次的 `aiclient-shared-bridge` 已证明宿主一侧这样做可行。
2. **崩溃处理改成宿主级。**
   - 宿主退出时，给**所有**有活动请求的 slot 发 `session.status disconnected` 和 `session.failed`。现有逻辑是按 entry 逐个处理的。
   - 然后**只重启一次宿主**，再给每个 slot 带 `sessionFile` 重新 bootstrap，可以并行。实测 5 个会话在 ready 后 55 ms 内全部恢复。
   - 现有的 `restartEntry` 是按 entry 串行拉起新进程的，不能照搬。
3. **重启预算放到宿主级。** 现在是每个 entry 60 s 内 2 次。宿主反复崩溃时，不能按 N 个会话重复消耗预算。预算用完后，所有会话要进入一致的错误状态。
4. **先确认旧宿主退出，再重启。** 会话写锁要等持有进程退出才释放，卡死（活着但不响应）的宿主会让所有会话都恢复不了。所以 Main 要有存活探测，比如 IPC 心跳加超时。超时后按确切 pid 发 SIGKILL，等 `exit` 事件，再拉新宿主。不能按名字或进程组去杀。
5. **启动环境要定。** 交不交 `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS`，决定 Linux 上走 systemd scope 收容，还是退回较弱的收容并报 warn。
   - 两条路本次都实测了：宿主被杀后工具进程都会被回收，每次 bash 调用也都有 5～25 ms 的同步阻塞。
   - 推荐交，这样收容更强，warn 也会消失。
6. **崩溃后的首轮体验。** 重启约 0.8 s，每个会话第一次用工具时还要多等约 70 ms 的一次性开销。
7. **进程与资源。** 宿主以外，Main 不需要额外清理：锁由内核释放，Linux 上工具进程随宿主一起退出。Windows 上是 Job 对象加命名信号量，要在 P0-4 CI 上补验同样的「杀宿主」场景。

**bridge（DshSessionRuntime）**

1. 恢复时返回 `initialHistory`，并实现 `history` / `tree` / `leaf`（投影 DSH 日志）。否则 Main 的崩溃重启和重开会话都会失败。
2. 把 `turn/end {kind:'interrupted'}` 投影成「本轮因宿主崩溃中断」。
3. 把 `TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED` 这类合成工具结果映射成专门的工具行状态。
4. 定下已流出但没落盘的正文怎么处理。
5. 长会话请求的可观测性：每次模型请求记下上下文字节和构建耗时，作为 P1 的回归指标。
6. 多 slot 的传输层：本次原型只证明了可行，正式实现属于 WorkerTransport 的工作。

## 其他风险与意外

1. **4 个长会话同时请求，阻塞 0.2～0.3 s（见 §2）。** 这是共享宿主的真实代价，比失去崩溃隔离更常见。建议在 P1 用 N 个长会话并发作回归场景。必要时考虑把特别长的会话挪到第二个宿主（「一会话一宿主」留作逃生口，P0-1 已提）。
2. **每次 bash 都同步 spawn，这是 DSH 上游的写法。** 8 个会话 16 次 bash 共阻塞约 95～150 ms，分散在 9 s 里，目前不影响体感。会话多、工具密集时会累加。
3. **正文要到一步结束才落盘，而且落盘按 200 ms 攒批。** 宿主崩溃时，这一步已流出的正文一定丢失；最后 200 ms 内的其他事件也可能丢失。
4. **每次恢复都往日志追加一个 `session/end-seed`。** 会话被反复恢复时，日志会逐次变长，量很小，只需知道有这回事。
5. **DSH 的「残帧修复」这次没有被触发。** 它的实现与 README 相符，但本次的 SIGKILL 都没落在 fsync 中途，所以这条路径没有实测到。
6. **关会话时有投影缓存的 warn。** 一轮刚结束马上 `worker.dispose`，宿主会报 `session projection cache: turn/end write … failed (cache stays stale): SessionHandleClosedError`。这只影响缓存，不影响日志。
7. **历史会话压缩前后 RSS 差距大。** 2000 条会话里，heap 只占 12 MB，RSS 却多出 46 MB。在内存紧的机器上，恢复长会话会让宿主 RSS 明显上跳。可以考虑在 P1 给宿主设 `MALLOC_ARENA_MAX` 这类参数，并做对比实验。
8. **盘上大小。** DSH 每批写一个 zstd 帧，小批压缩率低：2000 条消息 2.02 MB，明文的 pi 文件是 3.09 MB。长期不清理会累积，DSH README 也写明「Nothing deletes session files」。

## 局限

- 只测了 Linux。Windows 的会话锁是命名信号量，工具进程用 Job 对象收容，被杀后的回收要到 P0-4 CI 再补。
- 假网关的流式速率和 token 分块是按「接近真实」拟的：每 30 ms 一块，每块约 5 个字符。真实模型的块大小和间隔波动更大。
- 端到端延迟只测到 Main 进程收到 RuntimeEvent 为止，没有经过 Electron 的 IPC 和渲染层。
- 「从 kill 到全部可用」没有包含 Main 发现卡死所需的探测时间，只测了进程已死的情况。
- native 对照组在 4 个会话时的数字是按单 worker 实测外推的，没有同时起 4 个 worker。
- 自动压缩是关掉测的。真实的长会话会被压缩，压缩后请求变小，但日志里历史事件照样保留。

## 本次新增和改动的文件

代码提交 `2f9a44a7`：

- `src/dsh-host/p0-6-probe.ts`（新增）：驱动。模式有 crash、latency、history-gen、history、history-multi-gen、history-multi、worker-history-gen、worker-history。
- `src/dsh-host/bundle/lib/shared-bridge.js`（新增）：共享宿主原型行，加测量操作。
- `src/dsh-host/bundle/cordis.patch.yml`：
  - 共享模式下关掉 `aiclient-probe`；
  - 插入 `aiclient-shared-bridge` 行；
  - `compaction-basic.auto` 可以用环境变量关掉，默认不变。
- `src/dsh-host/bundle/package.json`：导出 `./shared-bridge`。
- `src/dsh-host/lib/probe-hooks.mjs`：同步 spawn 加记耗时，记录类型是 `spawn-sync-ms`。其他驱动只认 `spawn` 和 `spawn-sync`，不受影响。
- `docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/tools/fake-gateway.mjs`：
  - 新增 P0-6 场景和带时间戳的流式帧；
  - RECALL 支持多标记，并记录请求形状；
  - 参数对象后面可以跟正文。原有参数格式照常能解析。

回归：

- 改完之后重跑了 P0-3 的 `bridge-smoke.ts`，6 项判定全部为真。
- 格式化之后又各跑了 1 轮 crash 和 latency（N=2），结果与正文一致。
- `pnpm exec tsc --noEmit -p src/dsh-host/tsconfig.json` 和 biome 都通过。

没有改动 `src/agent-host`、`src/shared`、`src/runtime`、`src/main`、渲染层，也没有改 DSH 包。
