# P1-3 共享宿主 supervisor：方案

Role: topic。建立：2026-09-26。上位：[roadmap P1-3](../roadmap.md)。依据：[决策 002](../decisions/002-defer-encrypted-machine-and-shared-host.md) 第 3 条（共享宿主）、[P0-6 证据](../evidence/p0-6-shared-host-2026-09-26.md)（§P1 必补清单）、[P1-0 证据](../evidence/p1-0-sync-main-2026-09-26.md) 第 39 行（Stop 强杀会连带其他会话）、[P1-1 方案](p1-1-engine-cutover.md)与决策 005～010、[P1-2 方案](p1-2-host-packaging.md) §3.4。状态：只读调研（worktree HEAD `941ab5b1`，没有改代码），**方案待拍板**（§4 的 D1～D9）。

明细分片：[01 现状与「一进程」假设](p1-3-shared-host/01-current-state.md) · [02 目标架构与故障处理](p1-3-shared-host/02-design.md) · [03 环境策略与日志清理](p1-3-shared-host/03-env-and-logs.md) · [04 改动清单、切分与测试](p1-3-shared-host/04-changes-and-tests.md)。

约定：Main 与子包的行号指 HEAD `941ab5b1`。另一个代理正在同一 worktree 实现 P1-1，读基线要用 `git show HEAD:<路径>`。DSH 包的行号指 `src/dsh-host/node_modules/@deepseek-ai/<包>/lib/index.js`（`0.1.7-rc.2`），简写为 `<包>:行号`。「推断」表示读码得出、没有运行验证。

## 1 结论先行

1. **能做。推荐「虚拟 slot」形态。**
   - Main 新增 `DshHostSupervisor`，全局只管一个宿主进程。
   - 每个会话仍是一个 `WorkerSlot`，只是 transport 换成 `DshChannelTransport`：按通道寻址，所有会话复用同一条 IPC。
   - WorkerManager 的会话状态机原样保留（generation、身份提交、T144 语义、排空窗口），改动集中在宿主级策略。
   - 宿主侧：P0-6 的 `shared-bridge.js` 去掉测量操作，转正为唯一的 bridge；另加宿主控制消息（ready 握手、ping/pong、关通道、关停）。
2. **现有代码有 9 处默认「一个 slot 就是一个进程」**，逐条见分片 01 §2：
   - slot 的 dispose、crash、强杀最后都落到杀进程上（`WorkerSlot.ts:284-301,348-394,570-592`）；`kill()` 只发 SIGTERM（`WorkerTransport.ts:136-138`）。
   - generation 靠进程环境变量传进宿主（`devDshEngine.ts:92`、`bridge.js:33`）；bridge 收到 `worker.dispose` 就停掉整个宿主（`bridge.js:61-63`）。
   - 崩溃时按 entry 各自重启、各扣各的预算（`WorkerManager.ts:3169-3216,3254-3265`）；Stop 看门狗走的就是这条重启（`:2205-2213`）。
   - stderr 按 entry 归属（`:2626-2698`）；容量分档按「一个进程一份上下文」算（`:438-456`）；退出时逐个 slot 等 ACK 和进程退出（`:2472-2506`）。
3. **宿主级故障的处理。**
   - 检测：每 5 s 心跳，20 s 收不到宿主的任何消息就判定卡死。
   - 强杀：对确切 pid 发 `SIGKILL`，等到 `exit`（最多 5 s）才拉新宿主。这是单宿主不变式：P0-6 证明卡死的宿主会一直持有会话锁（`p0-6…md:160-161`）。
   - 恢复：崩溃后宿主只重启一次，活着的会话在同一个批次里按「前台 → 在飞 → 其余」依次恢复。宿主是单线程的，串行和并行差不多（P0-6：ready 后 55 ms 内 5 个会话全部恢复）。
   - 预算：宿主 5 min 内最多重启 3 次。某个会话连续两次出现在崩溃现场就熔断，不再自动恢复它。预算用完时所有会话进入一致的 error（`dsh_host_unavailable`）；用户每次打开或重试，都允许再拉起一次。
4. **Stop 升级阶梯。**
   - 10 s 时的界面收尾不变，T144 的承诺不动。
   - 之后先做会话级 `worker.dispose`（3 s）。DSH 在 dispose 时会把已经流出的正文作为 `interrupted` 落盘，并释放会话锁（`dsh-agent-loop:1069-1085,1662-1694`）。成功就在同一个宿主上重开这个会话，其他会话不受影响。
   - dispose 不回才重启宿主：先优雅关停，这样其他会话在飞的正文同样落盘为 interrupted；3 s 还不退再 SIGKILL。被牵连的会话会收到 `engine_restarted`，随后自动恢复。
5. **环境策略。**
   - 宿主的环境就是工具环境的底子。DSH 只再洗掉两类：名字匹配 `KEY|PASSWORD|SECRET|TOKEN` 的，以及 `DSH_*`（`dsh-subprocess:32,50-56`）。
   - P1-1 的 17 项白名单会让工具丢掉 `SSH_AUTH_SOCK`、`JAVA_HOME`、代理、`XDG_RUNTIME_DIR` 等变量。1.0.x 的 worker 则把 Main 的全部环境交给工具（`src/runtime/host/worker.ts:62-68`），两者不对等。
   - 推荐改为：继承 Main 的环境，剔除敏感名、运行时注入项和应用内部项，再显式补齐需要的变量。
   - **`.env` 的唯一读取点是 `host.ts:105` 自己调用的 `loadLayeredEnv`**，它还会把读到的值写进 `process.env`（`dsh-app-boot:3432-3457`）。换成只含进程层的 `createLaunchEnvironmentSnapshot`，就彻底不读 `.env`。
6. **日志清理。**
   - 产品本来就没有删除入口，归档只是一个标志（`SessionIndexService.ts:19-28`）；1.0.x 的 pi 会话文件也从来不删。
   - P1-3 只清同时满足三个条件的 DSH 会话：索引里没有引用、只有 header 或没有事件、已超过 24 h。决策 007 留下的会话属于这一类。
   - 由宿主在 ready 后执行：先取写锁确认无人占用，再删整个会话目录。绝不单独删锁文件（`dsh-session-persistence-jsonl/README.md:164`）。有内容的无主日志默认保留。
7. **规模**：约 1.5～2 人周（粗估），产品代码约 1.5k 行（另有工具脚本约 100 行），测试约 2.3k 行，切成 P1-3a～e 五步（§5）。a 要排在 P1-2 把 bridge 搬家之后；b 和 P1-2 改的文件不重叠，可以并行。
8. **建议用户拍板两项**：D6 环境策略（工具里能看到的环境变量会变）；D8 日志删除范围（涉及删除用户数据）。其余按工作方式自主决定，各补一份决策文件。

## 2 现状（明细见分片 01）

| 主题 | 事实 | 依据 |
|---|---|---|
| entry 状态机 | `creating / ready / restarting / crashed / disposing / error`；所有生命周期操作排在一条 `serialize` 链上 | `WorkerManager.ts:121-127,2900-2907` |
| slot 状态机 | `running / replacing / disposing / crashed / dispose-failed / disposed`。dispose 依次是：RPC（3 s）→ 杀进程 → 等进程退出（3 s） | `WorkerSlot.ts:13-19,92-94,348-394,595-622` |
| 崩溃 | transport 退出 → slot 进入 crash → `handleLifecycle`：在飞的回合发 `disconnected` 与 `session.failed`，正在停止的发 `stopped(forced)`，然后 `serialize(restartEntry)` | `WorkerSlot.ts:470-482,570-592`；`WorkerManager.ts:3169-3216` |
| 重启 | 先确认旧进程已退出，generation 加 1 后重拉。预算每个 entry 60 s 内 2 次，用完进 `error`。缺 `initialHistory` 时抛 `worker_restart_history_missing` | `WorkerManager.ts:3240-3379`（预算在 `:3254-3265`） |
| Stop | `STOP_WATCHDOG_MS = 10_000`，在发出 `worker.stop` 之前就布防。到点执行 `forceStop`：`enterCrashed`，发 `stopped(forced)` 与 idle，再 `restartEntry` | `:382,2080-2106,2183-2213` |
| 容量 | 默认上限 10；≤8 GiB 的机器 6，≤4 GiB 的 3。满了驱逐一个既不在前台、也没有在飞回合的会话；空闲 15 min 回收 | `:436-472,2909-2946,3001-3009` |
| 退出 | `disposeAll` 逐个 slot dispose；全局 7 s 截止后走同步的 `forceKillAllNow`；Main 8 s 强制退出 | `:2472-2533`；`ipc/index.ts:100-116`；`index.ts:103,916-954` |
| P0-6 原型 | 一条 IPC 上用 `{slot, rpc}` 信封；每个 slot 一套原样的 `PiWorkerRpcServer` 加 `DshSessionRuntime`；generation 取该 slot 的首条消息；`worker.dispose` 只删这个 slot | `shared-bridge.js:10-13,169-194,316-342` |
| P0-6 的缺口 | 恢复时不带 `initialHistory`，`history` 返回 0 条，中断补写只在日志里；Main 两次重试后停在 error。P1-1 的决策 010 用空页补上了前一半 | `p0-6…md:24,185-197` |
| P1-1 的目标形态 | `DshHostProcess` 里的布局、home、环境三个函数由 P1-3 复用；每槽一进程的 `forkDshHost` 由 P1-3 换掉；宿主 cwd 目前是 `DSH_HOME` | [P1-1 inventory](p1-1-engine-cutover/inventory.md) 第 140 行；`devDshEngine.ts:80-82,97` |

## 3 方案（明细见分片 02、03）

**3.1 拓扑**
- 每个应用实例一个宿主，也就是每个 profile 的 `DSH_HOME` 一个。单实例锁（`index.ts:319-333`）加上按 profile 分开的 userData（`:155-168`）保证不会有第二个应用实例共用它。
- 不分片：同一个 `DSH_HOME` 上跑多个宿主不是 DSH 支持的形态（P1-1 §9）。
- 一次性补全和导入仍走 native，直到 P1-15 / P1-12。

**3.2 协议**（Node IPC，JSON）
- Main → 宿主：
  - `{ch, rpc}`：会话 RPC。`ch` 由 supervisor 为每个虚拟 slot 单独铸一个，不复用。
  - `{host:'ping'}`、`{host:'close', ch}`、`{type:'shutdown'}`。最后一个沿用 `host.ts:193-195`。
- 宿主 → Main：
  - `{type:'ready', pid}`：沿用 `host.ts:234-247`，Main 核对 pid。
  - `{ch, rpc}`；`{host:'pong', eldMaxMs, rssMb, channels:[{ch, busy}]}`；`{host:'closed', ch}`。
- 只有 `worker.bootstrap` 能建通道。原型里任何消息都会建 slot（`shared-bridge.js:318-321`），正式版要收紧。
- 删掉：单会话 bridge 模式，以及靠环境变量传的 generation。测量操作挪到测试专用 bundle，理由同决策 015。

**3.3 Supervisor**
- 状态：`idle → starting → ready → restarting | stopping → failed | disposed`。
- 接口：`ensureHost()`、`openChannel()`、`restart(reason)`（单飞）、`shutdown()`、`forceKillNow()`、`status()`。
- 拉起：
  - 复用 P1-1 的布局与 home 函数，stdio 为 `ignore,pipe,pipe,ipc`。
  - cwd 改为私有空目录。
  - 60 s 内要等到 `ready`，并且 pid 与子进程一致。
- 宿主的 stderr 归宿主本身：脱敏后进日志和环形缓冲，崩溃时回放一次。不再转发成某个会话的 `session.stderr`。

**3.4 宿主级故障**（分片 02 §3）
- 判定卡死：心跳每 5 s 一次；20 s 内收不到任何消息即判卡死。以下两种情况不算：Main 自己的计时器迟到超过 1 s，以及系统从休眠中唤醒。
- 强杀：只用 `child.kill('SIGKILL')`；不用 `process.kill` 去算 pid，不杀进程组。
- 在飞的回合：Main 立刻发 `disconnected`，再发带 `errorCode: 'dsh_host_crashed'` 的 `session.failed`，正在停止的发 `stopped(forced)`。恢复时 DSH 自己会补写 `turn/end interrupted` 和 `TOOL_OUTCOME_UNKNOWN`，由 P1-4 投影进历史。
- 只有自身原因导致的恢复失败（`dsh_session_missing`、`session_cwd_mismatch`、日志损坏）才扣会话自己的预算（每 60 s 2 次）；宿主崩溃不扣会话预算。

**3.5 Stop 阶梯**（时序见分片 02 §4）

| 时刻 | 动作 |
|---|---|
| t0 | `worker.stop`，DSH 执行 `agent.cancel({kind:'user'})` |
| t0 + 10 s | 界面收尾：`stopped(forced)` + idle |
| 同时 | A：会话级 dispose，3 s 内回 ACK 就在同一个宿主上重开 |
| A 失败 | B：宿主优雅关停（3 s），不退再 SIGKILL，然后按宿主崩溃流程恢复所有会话 |
| 另一路 | 心跳也会独立发现卡死的事件循环，走同一个 `restart` |

**3.6 生命周期**
- 空闲关停：没有会话满 10 min，就优雅关停宿主（省约 180 MB），下次按需冷启动，约 0.8 s。
- `invalidateAll()`（登录、登出、模型、插件变更）：除了处理会话，还要优雅关停宿主，保证凭据和路由不会残留在宿主进程里。
- 应用退出：直接发宿主级 `shutdown`（DSH 会 dispose 全部 agent 并落盘），3 s 不退就 SIGKILL，等进程退出；同步兜底路径直接 SIGKILL。
- 更新：`quitAndInstall` 之前先 `await` 宿主关停，因为 NSIS 覆盖安装时，`koffi.node` / `conpty.node` 还被宿主占着会失败（P1-2 §7）。
- profile bundles：宿主每次启动都重申产品 bundle（`writeProfileBundles`，`dsh-app-boot:1084-1097`）。插件带来的 bundle 加载失败只告警、不拒绝启动；产品 bundle 失败仍然明确报错。

**3.7 事件循环争用**
- 自动压缩保持默认开启。P0-6 为了测量把它关掉了，所以 0.2～0.3 s 的卡顿是在不压缩的 2000 条历史上测得的（推断：开着压缩时会明显变小）。
- pong 带上 ELD 和 RSS，超阈值写日志。这是 P1-8 长会话回归的观测点。
- 容量统一为 10（≤4 GiB 的机器 6）。不做分片。

**3.8 环境、`.env` 与用户层**（分片 03 §1～3）
- 宿主环境 = Main 环境，按 D6 剔除；再显式设置 `DSH_HOME`、`DSH_TELEMETRY_DISABLED=1`、`NARB_NATIVE_CACHE_DIR=<状态根>/dsh-native-cache`。
- `XDG_RUNTIME_DIR` 与 `DBUS_SESSION_BUS_ADDRESS` 随继承带过去，DSH 于是走 systemd scope 收容，降级警告消失（`p0-6…md:254-260`）。
- `.env`：不再调用 `loadLayeredEnv`。
- `$DSH_HOME/cordis.patch.yml`：私有 home 下保留 DSH 的读取行为，但在 `overlays` 末位重申隐私相关的行保持关闭，保留启动审计，文件存在就告警。

**3.9 日志清理**（分片 03 §4）
- 引用集合由 Main 从索引算出，归档行也算在内。
- 由宿主执行 `gc`：列出 `aiclient-*` 会话，逐个检查、取写锁、删目录，再删对应的桩。
- 每次运行只做一次，在宿主 ready、会话恢复完之后。

## 4 需要拍板的决策点

| # | 决策 | 选项 | 推荐 | 理由 | 代价 |
|---|---|---|---|---|---|
| D1 | 宿主数量与容量 | A 全局一个；B 按需开第二个宿主分担长会话 | A；容量 10（≤4 GiB 的机器 6） | DSH 不支持多个宿主共用一个 home；每个会话只增加 3～46 MB | 一个会话出问题会牵连全部（D3 兜底） |
| D2 | 多路复用形态 | A 虚拟 slot，保留 WorkerSlot / WorkerManager；B WorkerManager 直接管宿主、去掉 WorkerSlot；C 每个会话一个宿主 | A | 3600 行 WorkerManager 测试可以复用，改动是增量的；C 违反决策 002 | 进程语义变间接：旧通道没被确认关闭时，必须升级为重启宿主 |
| D3 | 崩溃恢复与预算 | 宿主 3 次 / 5 min；会话预算只算自身原因；熔断连续两次出现在崩溃现场的会话；预算耗尽全部进入 error、用户操作再试一次 | 如左 | P0-6 必补清单第 3 条；避免一个坏会话拖垮全部 | 熔断会误伤恰好在跑的正常会话，但可以手动重试 |
| D4 | 心跳与强杀 | 5 s 心跳 / 20 s 判卡死；只用 `child.kill('SIGKILL')`；5 s 等不到退出就进 failed，不再并存第二个宿主 | 如左 | 卡死的宿主会一直持锁；在内存紧张会换页的机器上 20 s 足够保守 | 真卡死时所有会话最多停顿 20 s |
| D5 | Stop 升级 | A 会话级 dispose，失败后**立即**优雅重启宿主；B 等其他会话空闲，最多 60 s；C P1-4 之后用种子分叉续聊，不动宿主 | A，P1-4 之后评估 C | 升级到 B 是 DSH 缺陷导致的罕见情况；优雅关停时其他会话的正文会落盘为 interrupted | 其他会话在飞的回合被中断，需要用户手动继续 |
| D6 | 宿主环境（**建议用户拍板**） | A 严格白名单（P1-1 现状，外加 XDG、显示、SSH、代理）；B 继承 Main 环境再剔除 | B | 与 1.0.x 工具可见的环境对等；DSH 本来就会洗掉敏感名 | 工具里不再有 `NODE_OPTIONS` 和敏感名变量；Main 的杂项变量会进工具 |
| D7 | `.env` / cwd / 用户层 patch | 不读 `.env`；cwd 用私有空目录；home 层 patch 保留、加 overlay、存在即告警 | 如左 | 改一处调用就行，不给 DSH 打补丁 | 用户不能再用 `$DSH_HOME/.env` 配代理 |
| D8 | 日志删除范围（**建议用户拍板**） | A 只删「无主 + 空 / 仅 header + 超过 24 h」；B 无主的一律宽限后删；C 先进回收站、到期再删 | A | 与 1.0.x「会话文件永不删」一致，只清决策 007 的副产物 | 被截断出索引、但有内容的日志会一直留着 |
| D9 | 生命周期 | 空闲 10 min 关停；`invalidateAll` 连宿主一起关；退出走宿主级关停；更新前等宿主关停；启动时重申 bundles | 如左 | NSIS 覆盖、凭据不残留、升级时 bundles 不被冻住 | 冷启动约 0.8 s（Windows 未测） |

## 5 改动清单与子任务切分（明细见分片 04）

| 子任务 | 内容 | 主要文件 | 规模（产品 / 测试） | 依赖 |
|---|---|---|---|---|
| P1-3a 宿主侧 | 多路复用 bridge（只有 bootstrap 能建通道、ping/pong、close/closed、shutdown）；`host.ts` 改为不读 `.env`、加 overlay、reconcile bundles、ready 统一走 IPC；测量操作移出产品；bridge-smoke、p0-6-probe 改用信封 | `src/dsh-host/bridge/plugin.ts`（P1-2 之后）、`host.ts`、`bundle/cordis.patch.yml`、`tools/*` | 约 300 / 300 | P1-1、P1-2 的 bridge 搬家 |
| P1-3b Main supervisor | `DshHostSupervisor` 与 `DshChannelTransport`；`DshHostProcess` 改环境、cwd、NARB，删掉 `forkDshHost`；接入 `createPiWorkerSlot`；同步清理时杀宿主 | `agent-host/DshHostSupervisor.ts`（新）、`DshChannelTransport.ts`（新）、`shared/types/dshHostProtocol.ts`（新，宿主与 Main 共用）、`WorkerTransport.ts`、`DshHostProcess.ts`、`createPiWorkerSlot.ts`、`ipc/workerManager.ts` | 约 550 / 770 | P1-1；可以和 P1-2 并行 |
| P1-3c WorkerManager 宿主级语义 | 批次恢复与优先级、两级预算、熔断、Stop 阶梯升级、退出走宿主级关停、`invalidateAll` 连带宿主、errorCode 与 `engine_restarted`、渲染层文案 | `WorkerManager.ts`、`runtimeEvents.ts`、`chatSessions.ts` 与文案 | 约 350 / 600 | b |
| P1-3d 日志清理与收尾 | 宿主 `gc` 操作、Main 计算引用集合并触发、清理孤立的桩；空闲关停；更新前关停 | bridge、`WorkerManager.ts`、`AutoUpdater.ts` | 约 250 / 250 | a、c |
| P1-3e 验收 | 按需运行的集成测试（真宿主，复现 P0-6 的 kill1/2/3、SIGSTOP、Stop 卡死）；探针 bundle 加卡死开关；GUI 点验；证据 | `__tests__/dshSharedHost.integration.test.ts`、`tools/probe-bundle` | 约 50 / 400 | a～d |

与其他任务的边界：
- P1-1：复用它的布局、home、环境函数。
- P1-2：打包冒烟（决策 017）要改用信封协议；`NARB_NATIVE_CACHE_DIR` 由 P1-3 设置。
- P1-4：历史投影、中断标记、`TOOL_OUTCOME_UNKNOWN` 的工具行、已流出正文的交代，都由 P1-4 负责；P1-3 只保证恢复一定发生，并发出刷新。
- P1-5：凭据注入。开发用的网关 key 会被敏感名规则剔除，要显式补回。
- P1-6：权限插件跑在共享宿主里，会话授权记忆必须按会话隔离。
- P1-8：防空转与 500 轮上限是在保护整个宿主；长会话回归用 pong 里的 ELD。
- P1-10：插件 bundle 失败降级为告警，由 P1-3a 的 reconcile 实现。
- P1-11：TUI 不许在我方 `DSH_HOME` 上另起宿主。

## 6 测试方案（明细见分片 04 §3）

- **单测**（不起真实进程）：
  - supervisor 注入假的 `spawn` 和假 `ChildProcess`（`kill` 是 `vi.fn`，pid 固定为一个假值）。另外 `vi.spyOn(process,'kill')` 做绊线，一旦被调用就让测试失败。
  - 覆盖：握手、启动超时、心跳误判防护、只有旧进程确认退出后才会再次 spawn、预算、熔断、空闲关停、退出顺序。
  - WorkerManager 沿用现有 harness：N 个会话共用一个假宿主，模拟宿主崩溃、Stop 阶梯 A / B、预算耗尽后的手动恢复；原有的 `[T144-wm-01～11]` 全部重跑。
  - bridge 用假 ctx 测通道隔离与 ping。
  - `host.ts` 静态守卫：不出现 `loadLayeredEnv`、`loadEnv`、`loadEnvFile`；另有 `reconcileProductBundles` 纯函数测试。
- **静态守卫**：supervisor 里没有 `process.kill(`、负 pid、`detached: true`；WorkerManager 不直接杀进程。
- **应用内复现**：分两层。
  - L1 按需运行的集成测试（`AICLIENT_DSH_INTEGRATION=1`，mock 掉 electron）：用真实的 supervisor、WorkerManager、createPiWorkerSlot 和真宿主，加假网关，把 P0-6 的 kill1 / kill2 / kill3、SIGSTOP、Stop 卡死再跑一遍。开发机上一次只跑它，不同时开 Electron。
  - L2 一次 GUI 点验（CDP 配方）：3 个会话分别处于空闲、流式输出、`sleep 30` 工具中，按宿主 pid 发 SIGKILL，看界面。
- **「会话不停在 error」的判据**：每个会话都满足以下全部：
  - kill 之后事件序列是 `disconnected`（在飞的另有 `session.failed{dsh_host_crashed}`），然后在 5 s 内出现 `session.resumed` + `status: idle`；
  - `getSlotSnapshots()` 全部为 `ready`，generation 加 1，manager 不是 `degraded`；
  - 再发一轮能跑到 `session.completed`，RECALL 标记都在；
  - 宿主只重启了一次，只有一个宿主 pid 存活，没有孤儿工具进程；
  - SIGSTOP 那一轮：25 s 内判定并满足以上各条。
  - GUI 上：没有错误卡，输入框可用，下一轮能正常完成。
- **Windows**：要在 CI 上跑一遍「杀宿主」，看 Job 对象、命名信号量和 ConPTY 的行为。需要推分支，推送前征得用户确认，可以放到 P1-14。

## 7 风险与未覆盖

- **爆炸半径**：`installFailLoud` 遇到任何未捕获的异常或 rejection，都会在 2 s 内让整个宿主 `exit(1)`（`dsh-app-boot:3740,3781-3819`，`host.ts:160-162`）。一个会话的 bridge 缺陷或插件缺陷，就会中断全部会话。缓解：bridge 不留悬空 promise（加 lint 与测试）、快速重启、D3 熔断。
- **内存**：所有会话共用一个 V8 堆，长会话多加上子代理时，有可能 OOM 连坐。P1-8 要测上限；需要时给宿主设置堆参数。
- **后台 jobs**（推断）：宿主重启和会话回收都会结束该会话的后台任务。`isSafeToEvict` 要参考 pong 里的 `busy`，与 P1-7 联动。
- **卡死判定的代价**：最坏情况下所有流式输出停顿 20 s。在换页严重的机器上阈值是否合适，要看告警日志再调。
- **Windows**：`child.kill` 是 TerminateProcess；ConPTY 不在 Job 里，可能留下孤儿进程（`p0-4…md:171`）；NSIS 升级时会不会连带结束 `node.exe` 子进程，没有核实。
- **孤儿宿主**：Main 崩溃时，如果宿主正好卡死，它不会退出（`host.ts:197` 的断连处理依赖事件循环），会一直持锁，下次启动时表现为 `session_locked`。可选的缓解：宿主内起一个 worker 线程做自检，发现断连且主线程无响应时自杀（推断，未验证）。
- **没能确认的事实**：
  - 当 `cancel` 收不了尾时，会话级 dispose 能不能成功。两者都会等 `whenIdle`，所以阶梯 A 可能只在卡点位于我方 RPC 链上时才有用（推断）。
  - `sessionPersistence.list()` / `stat()` 返回什么字段（清理规则依赖它），以及子代理会话的 id 和目录布局。
  - 开着自动压缩时，长会话的争用实际有多大。
  - Windows 冷启动与关停的耗时。
  - worker 线程能否 `process.kill(process.pid,'SIGKILL')`。
  - 能否借一个哨兵 DSH 会话充当跨平台的 home 锁。
