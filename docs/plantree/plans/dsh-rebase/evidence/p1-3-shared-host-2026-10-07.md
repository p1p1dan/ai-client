# P1-3 共享宿主：验收汇总（P1-3a～e，2026-10-07，Linux 开发机）

Role: evidence。对应 [roadmap P1-3](../roadmap.md)，按[方案](../topics/p1-3-shared-host.md) §6 与[分片 04](../topics/p1-3-shared-host/04-changes-and-tests.md) §3 的场景 S1～S7 汇总。决策：[019](../decisions/019-one-host-per-app-virtual-slots.md)～[025](../decisions/025-host-lifecycle.md)、[075](../decisions/075-stop-orphan-tool-scopes-after-host-death.md)、[151](../decisions/151-p1-3e-stuck-switch-choices.md)。前一份证据：[P1-3a / 3b](p1-3a-shared-host-2026-09-27.md)。本次重跑的原始数字（已去掉本机路径）在 [p1-3-shared-host-2026-10-07.data.json](p1-3-shared-host-2026-10-07.data.json)。

代码提交：P1-3b `04ba4166`、P1-3a `1427a870`、P1-3c `613d0568`、P1-3d `b3b58f2b`、P1-3e `4f461ece`（探针卡死开关、S5 改用真实卡死）。

## 结论先行

1. **L1（真宿主集成测试）的判据在本机成立。** S1、S3、S4、S5 都在 `dshSharedHost.integration.test.ts` 里满足方案 §6 的判据：每个会话先 `disconnected`、再 `session.resumed` 和 `idle`，generation 加 1，会话自己的重启次数不变，存活宿主只有一个，下一轮能跑完、RECALL 标记都在。整份文件 35/35 通过，耗时 145.7 s。
2. **S5 现在是真实卡死。** 探针 bundle 的 `aiclient-probe-stuck` 行挂住一个工具调用并忽略它的 abort。DSH 收到了 Stop（53 ms 时记下「abort ignored」），但这一轮结束不了，会话级 dispose 也结束不了，于是走到阶梯 B。时间线：10.0 s 界面收尾，19.6 s 旧宿主被 SIGKILL，20.6 s 三个会话全部 idle。
3. **S2、S6、S7 不在 L1 里：**
   - S2（5 个会话，含流式输出和 `sleep 30`）由 L0 的 `p0-6-probe crash` 覆盖。L1 把这两种在飞状态拆在 S1、S5 里分别测。
   - S6（5 min 内第 4 次故障）只有单测，用的是真 supervisor 加脚本化的假宿主。
   - S7（`.env` 金丝雀）由 bridge-smoke 覆盖。
4. **两个新发现**，都没在本次改，见 §4：
   - 卡死源在 DSH 内部时，优雅关停收不了尾，被牵连会话已经流出的正文会丢；
   - 宿主没有 systemd user bus、工具又在沙箱外运行时，宿主被 SIGKILL 之后工具进程 1 s 后仍在。
5. **没做：**
   - L2 GUI 专项：空闲、流式、`sleep 30` 三个会话同时在场时杀宿主，再加一轮 SIGSTOP；
   - Windows 上杀宿主。
   这两项都归 P1-14，见 §5。

## 1 怎么跑的

- **基线**：worktree `.claude/worktrees/agent-a84b7bf3214a2affd`，分支 `feat/dsh-p0-probe`。开工时是 `26099763`，验证跑在 `4f461ece` 的代码上（先跑验证，再提交）。
- **机器**：2 核 / 3.3 GB；随包 Node v24.18.0；DSH 钉 `0.1.7-rc.2`。每条命令开跑前用 `free -m` 看过，可用内存 2.0～2.1 GB。
- **纪律**：
  - 一次只跑一条命令；没起 Electron，没跑 `pnpm build`。
  - 模型只走本地假网关 `src/dsh-host/tools/fake-gateway.mjs`（plan `dsh-p0-2`），没有用任何真实 provider、真实 key 或私人网关。
  - 发信号只针对本次拉起的子进程：
    - 集成测试用 `ChildProcess.kill`；
    - supervisor 只对自己 spawn 的子进程发 `SIGKILL`；
    - p0-6-probe 走带校验的 `killPid`，拒绝 ≤1、负数和自身 pid。
  - 没有对进程组或 `-1` 发过信号。

| 命令 | 结果 | 时间（本地 −04:00） |
|---|---|---|
| `pnpm typecheck && pnpm typecheck:dsh-host` | 退出 0（两套共 35 s） | 10:01 |
| `pnpm lint` | 退出 0。8 条 warning、1 条 info，都在既有文件里（`docs/.../evidence/*/tools/*.mjs`、`scripts/run-f3-dev-probe.mjs`），本次改动 0 条 | 10:02 |
| `pnpm exec vitest run Static Scan Wiring` | 75 个文件、759 例通过 | 10:02:58 |
| `pnpm exec vitest run src/dsh-host` | 39 个文件通过、2 个跳过（win32）；764 例通过、11 例跳过 | 10:04:05 |
| `AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run …/dshSharedHost.integration.test.ts` | **35/35 通过**，145.7 s | 10:04:28 |
| `(cd src/dsh-host && ../../out-node-runtime/node tools/bridge-smoke.ts --out /tmp/bs.json)` | 退出 0；**66 项判定全部为真**（含 `dotEnvNotRead`），39.8 s | 10:11 |
| `out-node-runtime/node src/dsh-host/tools/bridge-record.ts --check` | 退出 0；**28 个场景、0 处差异**，51.6 s。金样本没有重录 | 10:12 |
| `pnpm exec vitest run src/main/services/agent-host` | 25 个文件通过、1 个跳过（集成测试默认不跑）；474 例通过、35 例跳过 | 10:13:18 |
| `pnpm exec vitest run scripts`（探针 bundle 被打包配置测试读到，加跑） | 12 个文件、208 例通过 | 10:13:42 |
| `(cd src/dsh-host && ../../out-node-runtime/node tools/p0-6-probe.ts crash --runs 1 --out …)` | 三次 kill 都做完，报告已写出；最后清理临时目录时 `rmSync` 报 `ENOTEMPTY`，退出码 1（工具自身的清理竞争；临时目录已手工删除） | 10:13:57～10:14:13 |

另外两次只跑第二阶段的开发运行（09:5x），数字与全量运行一致：

- SIGSTOP 判定用了 23 658 ms；
- 阶梯 B 两次的读数（abort ignored / 界面收尾 / 旧宿主被杀 / 全部 idle）：
  - 52 / 10 035 / 19 538 / +810 ms；
  - 51 / 10 042 / 19 563 / +808 ms。

## 2 场景覆盖（S1～S7）

L1 = 真宿主集成测试（真 `DshHostSupervisor`、`WorkerManager`、`createDshChatSlot`，真宿主进程，假网关）。L0 = 驱动脚本自己扮演 Main，直连产品 bridge。单测 = 真 supervisor 或 WorkerManager 加脚本化的假宿主，不起进程，`process.kill` 有绊线。

| 场景 | 覆盖 | 本次结果与数字 |
|---|---|---|
| **S1** kill1：3 个会话各跑一轮，SIGKILL 宿主 | L1 第一阶段「recovers every session after the host is SIGKILLed, a tool call in flight」：比方案多一项，s3 正在跑 `sleep` 工具。L0 `p0-6-probe crash` 的 kill1：3 个空闲会话 | **L1**：<br>· 三个会话 914 ms 内全部 resumed + idle；<br>· 在飞的 s3 收到 `failed(dsh_host_crashed)`；<br>· generation 都是 2，`restartAttempts` 都是 0；<br>· 宿主 `recentFaults` 为 1，`lastExit` 为 crashed / SIGKILL；<br>· systemd scope 里的工具 922 ms 内消失（决策 075）；<br>· RECALL 三个会话都是 `missing=-`。<br>**L0**：<br>· 22.2 ms 观察到退出，879 ms 重启到 ready，967 ms 逐个恢复完 3 个；<br>· 写锁：held → 被杀后 free → 恢复后 held；<br>· RECALL `missing=-` |
| **S2** kill2：5 个会话，s4 流式输出、s5 在 `sleep 30` | L0 `p0-6-probe crash` 的 kill2（只有这里有 5 个会话同场）。L1 把两种在飞状态拆开测：工具在飞（S1 的 s3），流式在飞（S5 的 b2，阶梯 B 宿主重启时） | **L0**：<br>· 杀之前 s4 已画出 19 块正文，s5 的工具在跑；<br>· 21.8 ms 观察到退出，745 ms ready，1 601 ms 逐个恢复完 5 个（单个 15～34 ms）；<br>· RECALL：s4 是 `missing=STREAMED-R1S4`，已流出的正文丢失，与 P0-6 一致；s5 是 `missing=sleep-tool R1S5 started`；<br>· **1 s 后仍有孤儿**：`bash -c …sleep-tool R1S5…` 和 `sleep 30`，由驱动按 pid 回收，见 §4.2。<br>**L1** 的 S5：b2 收到 `failed(dsh_engine_restarted)`，恢复后照常跑完下一轮 |
| **S3** kill3：只测关键路径 | L1 第一阶段「two more SIGKILLs in the same minute」：断言 < 5 s，方案目标 ≤ 2 s。L0 kill3 快路径 | **L1**：<br>· 第 2、3 次 SIGKILL 分别在 912、864 ms 内全部 resumed + idle，三次 SIGKILL 落在同一分钟内（第 3 次离第 1 次 2 872 ms）；<br>· generation 到 4，`recentFaults` 为 3，会话预算没被扣。<br>**L0**：<br>· 25.3 ms 观察到退出，857 ms ready；<br>· 5 个会话并行恢复 75～78 ms；<br>· **从 kill 到全部可用 964 ms**（P0-6 原型是 888 ms） |
| **S4** SIGSTOP 宿主 | L1 第二阶段「kills a SIGSTOPped host on its heartbeat」。L0 kill2 后的 wedge 检查 | **L1**：<br>· **24 261 ms 判卡死并 SIGKILL**（上限 30 000 ms = 20 s 静默 + 5 s 心跳 + 1 s 计时器迟到 + 4 s 余量，推导见测试里的 `HUNG_DETECTION_BOUND_MS`；方案原写的 25 s 没有给本机调度留余量，P1-3a 已提）；<br>· 之后 1 118 ms 全部 idle；generation 2，`restartAttempts` 都是 0；<br>· 下一轮完成。<br>**L0**：被停住的宿主仍持有锁，第二个宿主恢复同一会话得到 `session_locked`；SIGKILL 之后 31.4 ms 恢复成功 |
| **S5** Stop 卡死 | L1 第二阶段「Stop ladder B: a tool call that ignores its abort …」（本次改成真实卡死，见 §3）。单测：`dshChannelStopWatchdog.test.ts` 的 [WMH-05]、[WMH-06]，`WorkerManager.test.ts` 的 [WMH-05]、[WMH-06]、[WMH-06b] | **L1**：<br>· b1 的 bash 调用被挂住，命令从未启动；<br>· Stop 后 53 ms 卡死行记下「abort ignored」；<br>· b1 收到 `status:stopping` → 10 043 ms `stopped(forced)` → `idle`；<br>· 阶梯 A 超时；19 571 ms 旧宿主以 `stuck-session`、`SIGKILL` 退出；<br>· 再过 1 014 ms 三个会话全部 idle：b1 恢复，`restartAttempts` 为 1；b2 收到 `disconnected/engine_restarted` 和 `failed(dsh_engine_restarted)`；b3 收到 `disconnected/engine_restarted`；<br>· 恢复后 b1 的历史里，挂住的调用是一条 `ok: false` 的工具结果（结果未知），外加「引擎意外停止」注记；<br>· 三个会话下一轮都完成 |
| **S6** 预算：5 min 内第 4 次故障 | **只有单测**：<br>· `DshHostSupervisor.test.ts` 的三条 [SH-08]：第 4 次拒绝自动启动、计划内关停不计、阶梯 B 超预算进入 failed；<br>· `dshChannelStopWatchdog.test.ts` 的 [WMH-02]；<br>· `WorkerManager.test.ts` 的 [WMH-02]：全部会话进入同一个 error，用户打开后重新拉起宿主。<br>L1 只覆盖到第 3 次（S3），没在真宿主上做第 4 次 | 本次单测运行通过：`src/main/services/agent-host` 474 例 |
| **S7** `.env` 金丝雀 | bridge-smoke 的 `dotEnvNotRead`：宿主 cwd 和 `DSH_HOME` 下各放一个 `.env` 金丝雀，bash 打出 `hostcwd=unset`、`dshhome=unset`。`hostStatic.test.ts` 的 HS-01：`host.ts` 里没有 `loadLayeredEnv`。不在 L1 里 | 本次 bridge-smoke 66 项判定全部为真，含这一项；`src/dsh-host` 单测通过 |

同一份集成测试里另外几项与 P1-3 有关、本次也通过：

- 回合刚结束就关会话：0 条 projection-cache 告警。
- gc 只删了无主的空会话 `aiclient-g-empty`；跳过的有 claimed 1、content 5、locked 1。
- 关不掉的通道（第三阶段，在 IPC 边上丢掉 close）：`closeSession` 6 954 ms 返回，宿主重启一次，另一个会话 50 ms 后 idle。
- 空闲关停：最后一个会话关掉后 3 085 ms 宿主退出，退出码 0。
- 后面各阶段（P1-4a/4b、P1-5、P1-6、P1-9、P1-10、P1-15）也全部通过，数字见 data.json。

## 3 S5：改前与改后

| | 改前（P1-3c `613d0568` 起） | 改后（P1-3e `4f461ece`） |
|---|---|---|
| 怎么造「卡住」 | 集成测试包住 `child.send`，把 b1 的 `worker.stop`、`worker.dispose`、`{host:'close'}` 在 IPC 边上丢掉。DSH 什么也没收到 | 第二阶段的宿主叠加探针 bundle，`aiclient-probe-stuck` 在 `tools/execute` 上挂住参数里含 `P13ESTUCK` 的调用：不调用 `next()`，不理会 abort。Stop、dispose、close 都真实到达 DSH |
| b1 在 Stop 之后收到的 | `stopped(forced)`、`idle` | `stopping`（bridge 收到了 Stop）、`stopped(forced)`、`idle` |
| 阶梯 A | 消息被丢，等满 3 s + 3 s | DSH 的 dispose 自己在等这一轮结束（`cancel` 之后 `whenIdle`），同样等满 3 s + 3 s。**决策 021 里「取消收不了尾时，dispose 可能也等不到」这一点实测成立** |
| 阶梯 B 的关停 | DSH 不卡，优雅关停成功（宿主自己退出），约 16 s 时宿主已重启（P1-3c 提交说明） | DSH 自己的 teardown 也在等这个调用，3.5 s 内收不了尾，**被 SIGKILL**；19.6 s 时旧宿主退出 |
| 被牵连会话已流出的正文 | 宿主是优雅退出的，按决策 021 应作为 interrupted 落盘（当时没有断言，未核实） | **没有落盘**：b2 流了约 20 s 的正文（Stop 之后还收到约 100 块），恢复后的历史里一块也没有，见 §4.1 |
| 卡住会话的工具 | 一个真实的 `sleep 60`，断言它随旧宿主消失 | 不起进程，断言命令从未启动、调用只挂过一次、恢复时不会重跑 |
| IPC 丢消息这条路 | 用在阶梯 B 和第三阶段 | 只留在第三阶段（close 到不了 DSH）。取舍见决策 151 第 4 条 |

## 4 新发现（本次没改，交给用户与后续任务）

### 4.1 阶梯 B 遇到真实卡死时，其他会话已流出的正文会丢

- 现象：S5 里 b2 流式输出约 20 s 后被阶梯 B 牵连（Stop 之后还收到约 100 块，每块 150 ms）。宿主收到优雅关停后，DSH 的 `fiber.dispose()` 在等 b1 卡住的那一轮（`host.ts:544-561`，自退计时器要等 dispose 返回才会设），3.5 s 后被 supervisor SIGKILL。恢复后 b2 的历史里只有用户消息和「This turn was interrupted when the engine stopped unexpectedly.」，`STREAMED-P13CPACED…` 不在。
- 与决策 021 第 3 条、分片 02 §4 的出入：那里写的是「优雅关停时，其他会话在飞的正文同样落盘为 interrupted」。这一条只在卡点不在 DSH 内部时成立，例如卡在我方 RPC 链上，或者像改前那样消息被丢。
- 界面上的告知没有问题：b2 收到 `failed(dsh_engine_restarted)`。结局与宿主崩溃时相同，P0-6 已经记录过「正文丢失加标记中断」。
- 可选的补法，见决策 151 第 5 条：阶梯 B 关宿主之前，先对其他在飞的通道逐个 `worker.dispose`；或者宿主的 shutdown 先 dispose 没卡住的 agent。

### 4.2 没有 systemd user bus、工具在沙箱外运行时，宿主被杀后工具进程仍在

- 现象：`p0-6-probe crash` 的 kill2 中，s5 的 `bash -c … sleep 30` 和 `sleep 30` 在宿主被 SIGKILL 1 s 后仍然活着，最后由驱动按 pid 回收。
  - 驱动的环境是白名单，没有 `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS`，DSH 走回退收容。
  - 会话按 P1-6b 以 `bypass` 打开，工具树里没有 bwrap。
- 对照：2026-09-26 的 P0-6 原始数据里，同一个工具跑在 `bwrap … --die-with-parent` 里，1 s 内全部消失。
- 与决策 075 第 2 条的出入：那一条写「没有 user bus 时，回退收容本来就会随宿主一起回收」。这个前提对沙箱外的调用不成立，包括 `bypass` 和升级出沙箱的调用。
- 影响范围（推断）：
  - 桌面 Linux 有 user bus，Main 的环境会把它带给宿主，决策 075 的 scope 回收能兜住。L1 实测 922 ms 消失。
  - 没有 user bus 的 Linux（无图形会话、部分容器）上，沙箱外的工具会一直跑到自己结束。
  - Windows 走 Job 对象，P1-14 验证。
- 本次只记录，没有改。

### 4.3 其他

- `p0-6-probe` 收尾时 `rmSync` 偶发 `ENOTEMPTY`，退出码因此为 1，报告照常写出。疑似与刚回收的孤儿或宿主的最后一次写盘竞争。属于工具自身问题，不影响结论。
- SIGSTOP 那一轮的宿主卡在 gc 中途被杀，Main 记下 `DSH session collection failed: … exited during gc 1`。这是 gc 按设计放弃的情况（P1-3d），下一次运行会再做。

## 5 GUI 点验（L2）：已有记录与尚未做的

已有记录，都是按确切 pid 对宿主发 `SIGKILL`，引用原证据：

- [P1-1 GUI](p1-1-gui-2026-09-26.md) 第 2 项「回合中杀宿主」：0.8 s 内拉起新宿主并恢复会话，状态停在 `failed`，下一轮正常，30 s 后没有残留的 `sleep`。当时还是每个会话一个宿主，在共享宿主之前，只作参照。
- [P1-7d 第 1 批](p1-7d-gui-2026-09-30.md)，已经是共享宿主：
  - A2：`P0-SLEEPTOOL` 运行中杀宿主。约 0.8 s 出现失败卡「对话引擎意外退出」，新宿主 1 s 内就绪；命令行显示「结果未知」，附注记「引擎意外停止，这一轮没有完成。」；下一轮正常，没有残留的 `sleep`。
  - B4：活动目标在跑时杀宿主。0.75 s 目标条变「已挂起」，5.9 s 后出现「继续」。
  - C3：两个后台任务在跑时杀宿主。0.33 s 两行变「引擎重启，任务已结束」；当时 1.75 s 后整窗被清空（问题 17，决策 142 已修）。
- [P1-7e 复点验](p1-7e-recheck-2026-09-30.md)：
  - **#8** ✅：杀宿主前后，工作区前 8 行顺序完全相同，没有跳到顶部的「now」。
  - **#22** ✅：杀宿主 0.44 s 时两行变「引擎重启，任务已结束」，只剩「移除」；20 s 后仍在，可以逐行移除。
  - #1 ⚠️：宿主重启后对话仍留在「正在活动」（问题 37）。决策 145 用 `released` 断开原因修了，e6 `5e29f08d` 的复点验还没做（[pre-P1-14 清单](../topics/pre-p1-14-remaining-2026-10-07.md) (b) 类）。
  - #26 ⚠️：问题 39，决策 145 第 9 条已修，同样待复点验。

**尚未做，归 P1-14：**

- **方案 §3.3 的 GUI 专项**：A 空闲、B 流式输出 `P0-PACED`、C 在跑 `sleep 30`，三个会话同时在场时按 `getStatus().host.pid` 杀宿主。要看：
  - B 显示「引擎崩溃，本轮中断」一类文案；
  - C 的工具行已收尾；
  - 三个会话都没有错误卡，输入框可用，各自再发一条都能完成。
  另做一轮 SIGSTOP，25～30 s 内应自愈。
- **Windows 上杀宿主**（方案 §3.4）：管理员、标准用户各一轮。看三件事：Job 里的工具进程是否全部结束；命名信号量是否释放，表现为能重新 resume；ConPTY 下的 pwsh 会不会留下孤儿。要推送分支，推送前征得用户同意。可以随 P1-8c 的工作流一起写。
- **阶梯 B 的界面**：b1 先「停止中」10 s 再强制收尾；另外两个会话收到 `engine_restarted` 的提示。这些没在 GUI 上看过。探针开关在应用里故意打不开（决策 151 第 2 条），要看得另找开发专用的触发方式。
