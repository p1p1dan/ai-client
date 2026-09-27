# P1-3 分片 04 · 改动清单、子任务切分与测试

Role: detail shard。上位：[P1-3 方案](../p1-3-shared-host.md)。回答调研问题 9（测试方案）和问题 10（改动清单与切分）。按方案 §4 的推荐选项写。规模是粗估的行数（产品 / 测试），不含删除的行。

## 1 子任务切分与顺序

```
P1-1 ──► P1-2（bridge 搬到 bridge/plugin.ts）──► P1-3a 宿主侧 ──┐
   └───► P1-3b Main supervisor（与 P1-2 并行）──► P1-3c ─────────┼──► P1-3d ──► P1-3e 验收
```

| 子任务 | 退出判据 | 规模 | 可交给谁 |
|---|---|---|---|
| **P1-3a 宿主侧协议与启动卫生** | bridge 多路复用的单测通过；bridge-smoke 用信封协议跑通；`.env` 金丝雀不进工具环境；bundles 的 reconcile 单测通过 | 约 300 / 300，另有工具脚本约 100 | opus（要改 bridge 与 host.ts） |
| **P1-3b Main supervisor 与虚拟通道** | supervisor 与 transport 的单测全部通过（`process.kill` 绊线从未触发）；开发机上所有会话共用一个宿主进程 | 约 550 / 770 | opus |
| **P1-3c WorkerManager 宿主级语义** | `WMH-*` 用例与 `[T144-wm-01～11]` 全部通过 | 约 350 / 600 | opus |
| **P1-3d 日志清理与生命周期收尾** | `GC-*` 用例通过；空闲关停和更新前关停都有单测 | 约 250 / 250 | sonnet（规则明确） |
| **P1-3e 应用内复现与证据** | 集成测试 S1～S7 全部满足判据；GUI 点验一次；证据写入 `evidence/p1-3-shared-host-<日期>.md` | 约 50 / 400 | opus 执行，编排器复核 |

- a 与 b 可以同时做：一个改 `src/dsh-host`，一个改 `src/main`，文件不重叠。协议以分片 02 §2 为准，先把消息类型写进 `src/shared/types/dshHostProtocol.ts`，两边共用。
- c 依赖 b 提供的 transport 与 supervisor 接口；d 依赖 a 的 `gc` 操作和 c 的空闲通知。
- 如果 P1-2 迟迟不落地，a 可以先改 `bundle/lib/bridge.js`，等 P1-2 搬家时一起挪。代价是 P1-2 要合并这次改动。

## 2 改动清单（按文件）

### 2.1 `src/dsh-host`（P1-3a、P1-3d）

| 文件 | 改什么 | 约 |
|---|---|---|
| `bridge/plugin.ts`（P1-2 之后；之前是 `bundle/lib/bridge.js`） | 从 `shared-bridge.js` 转正：按 `ch` 分发；只有 bootstrap 能建通道；`closed` 回执；ping/pong（附带 `busy`、ELD、RSS）；`close`；`shutdown`；P1-3d 再加 `gc` | 200 |
| `bundle/lib/shared-bridge.js` | 删除。测量操作挪到 `tools/probe-bundle/`（决策 015 的形态） | -350 / +120 |
| `bundle/cordis.patch.yml`、`bundle/package.json` | 两行 bridge 并成一行，去掉 `AICLIENT_DSH_BRIDGE` / `AICLIENT_DSH_SHARED_BRIDGE` 门控，删掉 `./shared-bridge` 导出 | 15 |
| `host.ts` | ① `loadLayeredEnv` 换成只含进程层的快照；② overlays 重申隐私行；③ `reconcileProductBundles`，产品 bundle 跳过就报错、插件 bundle 跳过只告警；④ ready 一律走 IPC，缓冲一律开启；⑤ home 层有 `.env` 或 patch 时告警 | 80 |
| `lib/reconcileBundles.ts`（新） | 纯函数，便于测试 | 30 |
| `tools/{bridge-smoke,p0-6-probe,goal-probe,measure}.ts` | 改用信封协议；p0-6-probe 改为加载测试 bundle | 100 |
| 测试：`bridge/__tests__/plugin.mux.test.ts`、`__tests__/hostStatic.test.ts`、`lib/__tests__/reconcileBundles.test.ts` | BR / HS 用例（§3.1） | 300 |

### 2.2 `src/main` 与 `src/shared`（P1-3b～d）

| 文件 | 改什么 | 约 |
|---|---|---|
| `services/agent-host/DshHostSupervisor.ts`（新） | 状态机、拉起与握手、心跳、`killHost`、两类重启、预算、崩溃历史、空闲关停、stderr 环形缓冲、`status()` | 420 |
| `services/agent-host/DshChannelTransport.ts`（新） | 按分片 02 §2 的表实现 `WorkerTransport` | 80 |
| `services/agent-host/WorkerTransport.ts` | `WorkerTransportExit` 增加可选的 `cause` | 5 |
| `services/agent-host/DshHostProcess.ts`（P1-1 新建） | 环境改用规则 B；cwd 改为私有空目录；加 `NARB_NATIVE_CACHE_DIR`；删掉 `forkDshHost`，改为导出拉起参数 | 60 |
| `services/agent-host/createPiWorkerSlot.ts` | 默认 transport 改为 `await dshHostSupervisor.openChannel(...)`；`WORKER_WORKSPACE_MISSING` 检查移到这里 | 20 |
| `services/agent-host/WorkerManager.ts` | 分片 02 §7 的 7 点 | 300 |
| `ipc/workerManager.ts`、`index.ts` | 同步清理时调 `supervisor.forceKillNow()`；`powerMonitor` 的 `resume` 通知 supervisor | 10 |
| `services/updater/AutoUpdater.ts`（P1-3d） | `quitAndInstall` 之前等宿主关停 | 10 |
| `shared/types/runtimeEvents.ts` | `SessionDisconnectReason` 追加 `'engine_restarted'` | 3 |
| `shared/types/dshHostProtocol.ts`（新） | 信封与宿主控制消息的类型、类型守卫，宿主与 Main 共用 | 60 |
| 渲染层：`stores/chatSessions.ts`、通知 hook、文案（中英） | `engine_restarted` 解除宿主绑定并提示一次；四个错误码的文案 | 40 |
| 测试 | SH / CT / WMH / SG / GC 用例（§3.1） | 1400 |

### 2.3 与其他任务的边界

- **P1-1**：复用 `resolveDshHostLayout` / `resolveDshHome` 和环境函数。P1-1 里「四条路径走 DSH」的单测不受影响，因为它们桩掉的是 `createSlot`。决策 010 说的「P1-3 之前一个会话一个宿主、不出包」到此解除。
- **P1-2**：
  - 打包冒烟（决策 017）要改用信封协议和 ready 握手，而且要等宿主真正退出。
  - `NARB_NATIVE_CACHE_DIR` 由 Main 设置。
  - 构建脚本只打一个 bridge 入口。
- **P1-4**：P1-3 保证「恢复一定发生，并发出 resumed、refresh、idle」。P1-4 负责：
  - `initialHistory` 与 `history` 的投影；
  - `interrupted` 标记和 `TOOL_OUTCOME_UNKNOWN` 的工具行；
  - 已流出正文的交代；
  - 分叉。
  - D5 的选项 C（种子分叉续聊）要等 P1-4。
- **P1-5**：凭据走凭据接口注入。按敏感名规则，开发用的网关 key 必须显式补回；P1-5 删掉之后，这条补回也一起删。`invalidateAll` 连带关停宿主，登出后凭据不会留在宿主里。
- **P1-6**：权限插件跑在共享宿主里，会话授权记忆必须按会话 id 隔离。宿主崩溃时，挂着的审批要随 `session.failed` 从界面上收起。
- **P1-7**：`busy` 会被 goal 条、jobs 面板用到；`isSafeToEvict` 要把「有后台 job」也算进来。
- **P1-8**：防空转、500 轮上限、单条回复里工具调用失控的熔断，都是在保护整个共享宿主。长会话并发的回归场景用 pong 里的 ELD 和 RSS 来量。
- **P1-10**：插件 bundle 跳过时降级为告警（P1-3a）；装完插件后用 `invalidateAll` 或 `restart('config')` 让它生效。
- **P1-11**：内嵌终端不管最后用什么，都不许在我方 `DSH_HOME` 上另起宿主。
- **P1-12 / P1-15**：native 的补全和导入进程与 supervisor 无关，删 runtime 时顺带删掉按 entry 收集 stderr 的逻辑。P1-15 可以考虑把一次性补全做成共享宿主上的一种特殊通道。

## 3 测试方案

### 3.1 单测（根 vitest，不起真实进程）

绊线：所有 supervisor 与 WorkerManager 的测试都加 `vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('real kill forbidden'); })`。子进程是注入的假对象（`EventEmitter` 加 `send` 加 `kill: vi.fn()`，pid 固定为 `424242`）。原因：kill(-1) 曾经灭掉整个会话。

**supervisor（SH）**

| ID | 要证明的事 |
|---|---|
| SH-01 | 并发的 `ensureHost()` 只 spawn 一次（单飞） |
| SH-02 | ready 的 pid 不符，或收到 `fatal` → 对这个假子进程发 `SIGKILL`，启动失败并计入预算 |
| SH-03 | 60 s 内没有 ready → 杀掉并计入预算 |
| SH-04 | 20 s 无消息且有 2 个 ping 没回 → 只 kill 一次；有流量就重置计时；Main 计时器迟到超过 1 s 不计；`resume` 事件重置计时 |
| SH-05 | pid ≤ 1、等于自身、与握手不符、进程已退出 → 不调 kill；绊线从未触发 |
| SH-06 | kill 之后，假子进程没有发出 `exit` 就不再 spawn；5 s 后进入 `failed` |
| SH-07 | 宿主退出时，每个通道恰好触发一次 exit，`cause` 为 `host-exit`；收到 `closed` 时只有对应通道退出 |
| SH-08 | 5 min 内非计划重启到第 4 次进入 `failed`；计划内的关停不计；用户发起的调用在 `failed` 下放行一次 |
| SH-09 | `shutdown()`：先发 `{type:'shutdown'}`，3.5 s 后再 SIGKILL；收到 `stopped` 就提前结束；进入 `disposed` 后拒绝一切 |
| SH-10 | `forceKillNow()` 同步执行、幂等 |
| SH-11 | 通道数为 0 持续 10 min 后关停；期间开了新通道就取消 |
| SH-12 | stderr 脱敏后进环形缓冲，崩溃时 `console.error` 回放一次，从不以 `session.stderr` 发出 |
| SH-13 | spawn 的参数按金样本核对：命令、参数、cwd、环境、`ipc`、`windowsHide`，并且没有 `detached` |

**通道 transport（CT）**

- CT-01：收发都只针对自己的 `ch`。
- CT-02：`kill()` 只发一次 `close`；在收到 `closed` 或宿主退出之前，不触发 exit。
- CT-03：exit 之后监听器全部解除，晚到的消息被忽略。

**WorkerManager（WMH）**：扩展现有 harness（`WorkerManager.test.ts:128-413`），给所有假 slot 加一个共享的 `hostCrash()`。

| ID | 场景与断言 |
|---|---|
| WMH-01 | 3 个会话，分别是前台空闲、后台在飞、后台空闲，宿主崩溃：<br>· 事件：都收到 `disconnected`；在飞的另有 `failed{dsh_host_crashed}`；<br>· 只有一个恢复批次，`createSlot` 的调用顺序是 前台 → 在飞 → 其余；<br>· 全部 `ready`，generation 为 2；<br>· 会话预算没有被扣 |
| WMH-02 | 连续多次崩溃：第 4 次后全部进入 `error{dsh_host_unavailable}`，manager 为 `degraded`；随后用户 `resumeSession` 能走冷路径恢复 |
| WMH-03 | 同一个会话连续两次在崩溃现场 → 下一个批次跳过它，置为 `error{dsh_session_suspect}`；其他会话正常恢复；用户重试一次后清除标记 |
| WMH-04 | 只有一个会话自己恢复失败（`dsh_session_missing`）→ 只扣它自己的预算，其他会话不受影响 |
| WMH-05 | Stop 阶梯 A：`[T144-wm-04]` 的时序不变；只重建这一个会话；没有调用 `supervisor.restart` |
| WMH-06 | Stop 阶梯 B：旧 slot 停在 `dispose-failed` 且原因不是宿主退出 → 调用一次 `restart('stuck-session')`；宿主退出后卡住的会话排在最前；其他在飞的收到 `failed{dsh_engine_restarted}`，空闲的收到 `disconnected{engine_restarted}` |
| WMH-07 | `disposeAll('app-shutdown')` 不再逐个通道 RPC，改为等 `supervisor.shutdown()`；`forceKillAllNow()` 会调 `supervisor.forceKillNow()` |
| WMH-08 | `invalidateAll()` 之后，宿主也被关停 |
| WMH-09 | 批次进行中宿主再次崩溃 → 中止当前批次，只重新排一次，不会重复重启 |
| WMH-10 | 默认容量：≤4 GiB 为 6，其余为 10 |
| — | 现有的 `[T144-wm-01～11]`、`[T144-wm-*]` 与崩溃恢复各用例，全部原样通过 |

**bridge（BR，在 `src/dsh-host` 里用假 ctx，写法同 P1-1 的 `DshBridgeContext`）**

- BR-01：bootstrap 能建通道；发给未知通道的其他请求回 `WORKER_CHANNEL_UNKNOWN`。
- BR-02：两个通道的事件不会串到对方。
- BR-03：`worker.dispose` 之后回 `closed`，通道被移除。
- BR-04：runtime 的 dispose 一直不返回时，不回 `closed`。
- BR-05：ping 在消息处理里直接回 pong，并带上 `busy`。
- BR-06：`shutdown` 会调用宿主的 stop。

**host.ts（HS）**

- HS-01：`host.ts` 里不出现 `loadLayeredEnv(`、`loadEnv(`、`loadEnvFile(`。
- HS-02：overlays 覆盖了全部 `REQUIRED_DISABLED`。
- HS-03：`reconcileProductBundles` 覆盖这几种情况：全新安装、旧版组合、保留插件、剔除已退役的、重复执行结果不变。

**静态守卫（SG）**

- SG-01：`DshHostSupervisor.ts` 里没有 `process.kill(`、`kill(-`、`detached: true`，唯一的 kill 是对子进程调 `.kill('SIGKILL')`。
- SG-02：`WorkerManager.ts` 里没有 `.kill(`。
- SG-03：敏感名规则的字面量固定不变。DSH 升级流程（决策 003）里加一项：核对它与 `dsh-subprocess` 的 `SENSITIVE_ENV_PATTERN` 是否一致。

**日志清理（GC）**

- GC-01：引用集合的计算：包含已归档的行；桩丢失时按 `aiclient-<id>` 补。
- GC-02：宿主侧 `gc` 用假 persistence 加临时目录测：前缀、引用、24 h、只有 header 这几条规则；锁被占就跳过；删目录和桩；绝不单独删锁文件。
- GC-03：每次运行只触发一次，时机在 ready 且恢复批次完成之后。

### 3.2 应用内复现：按需运行的集成测试（L1，退出判据的主证据）

- **文件**：`src/main/services/agent-host/__tests__/dshSharedHost.integration.test.ts`。只有同时满足三个条件才运行：`AICLIENT_DSH_INTEGRATION=1`，`out-node-runtime/node` 存在，`src/dsh-host/node_modules` 存在。默认的 vitest 不跑它。
- **装配**：
  - `vi.mock('electron')`：`app.getPath` 指向 `/var/tmp` 下的 0700 目录，`isPackaged=false`，`getAppPath()` 指向 worktree，`powerMonitor` 用桩。
  - 真实的 `DshHostSupervisor`、`createPiWorkerSlot`、`WorkerManager`；索引服务用内存桩。
  - 假网关用 `tools/fake-gateway.mjs` 的 `dsh-p0-2` 方案，跑 `P0-CRASH` / `P0-PACED` / `P0-SLEEPTOOL` / `P0-RECALL`。
- **场景**（对应 P0-6 §1）：

| ID | 场景 | 额外断言 |
|---|---|---|
| S1 | kill1：3 个会话，各跑一轮后空闲，按宿主 pid 发 SIGKILL | RECALL 的两个标记都在 |
| S2 | kill2：5 个会话，其中 s4 在流式输出、s5 在跑 `sleep 30` | s4、s5 收到 `failed{dsh_host_crashed}`；1 s 内没有孤儿工具进程（按 pid 加启动时刻判断，同 P0-6） |
| S3 | kill3：只测关键路径的耗时 | 从 kill 到全部 `ready` ≤ 2 s（P0-6 是 888 ms） |
| S4 | 卡死：对宿主 SIGSTOP | 25 s 内判定卡死并 SIGKILL，然后恢复；`afterAll` 里补发 SIGKILL 兜底 |
| S5 | Stop 卡死：测试 bundle 的卡死开关（审批处理器不理会 abort） | 10 s 时界面已经 `stopped(forced)`，阶梯 A 超时，走阶梯 B，全部恢复 |
| S6 | 预算：5 min 内 kill 4 次 | 进入 `failed`；用户 resume 后恢复 |
| S7 | `.env` 金丝雀：宿主 cwd 与 `DSH_HOME` 下各放一个 | bash 工具的环境里没有金丝雀 |

- **判据（每个会话都要满足）**：
  - kill 之后的事件依次是 `disconnected`（在飞的加 `session.failed`），然后在 5 s 内出现 `session.resumed` 和 `status: idle`；
  - `getSlotSnapshots()` 全部 `ready`，generation 加 1，没有 `error`；manager 不是 `degraded`；
  - 再发一轮能跑到 `session.completed`，RECALL 标记都在；
  - supervisor 的状态记录显示只重启了一次，存活的宿主 pid 只有一个；
  - 会话自己的 `restartAttempts` 没有增加。
- **跑法纪律**：
  - 用 kill 发信号时，只用测试代码里带校验的 `killPid`（拒绝 ≤1、负数、等于自身的 pid），目标只能是 supervisor 报出来的宿主 pid。
  - 开发机上单独跑：不开 Electron，不同时跑全量测试。宿主约占 200～350 MB。

### 3.3 GUI 点验（L2，一次，CDP 配方）

- 用 `pnpm dev` 加 `--remote-debugging-port` 启动，HOME 隔离，配假网关的环境变量，不设任何开关。
- 开 3 个会话：A 空闲，B 流式输出 `P0-PACED`，C 在跑 `sleep 30`。从主进程日志或 `getStatus().host.pid` 读出宿主 pid，在终端里执行 `kill -KILL <pid>`。
- 要看到的：
  - B 显示的是「引擎崩溃，本轮中断」这一类文案，而不是 `Worker exited …`；
  - C 的工具行已经收尾；
  - 三个会话都没有错误卡，输入框可用，各自再发一条都能完成。
- 截图放进证据。再做一轮 SIGSTOP，25 s 内应当自愈。
- 点验期间，不能有别的代理在改渲染层，否则热更新会伪造出界面故障。

### 3.4 Windows

- 在 windows-2022 上跑管理员、标准用户两轮「杀宿主」：
  - TerminateProcess 之后，Job 里的工具进程是否全部结束；
  - 命名信号量是否释放，表现为能重新 resume；
  - ConPTY 下的 pwsh 会不会留下孤儿进程（`p0-4…md:171`）。
- NSIS 升级覆盖安装时宿主会不会占住文件，放到 P1-14 的安装包实测里验证。
- 两者都要推送分支，推送前先征得用户确认。
