Role: detail shard

# P1-8 / P1-11 分片 05 · 长会话争用回归、测试方案与改动清单

上位：[P1-8 / P1-11 方案](../p1-8-p1-11-guards-and-terminal.md)。回答调研问题 6，并给出两项的测试方案与逐文件改动。行号约定同[分片 03](03-guards-facts.md)。

## 1 P0-6 基线（Linux 开发机 2 核 / 3.3 GB；3 轮中位数；ELD 已减去 10 ms 采样间隔）

| 负载 | ELD | RSS | 依据（[P0-6 证据](../../evidence/p0-6-shared-host-2026-09-26.md)） |
|---|---|---|---|
| 空闲宿主 | p99 0.6～1.8 ms，max 1.5～3.0 ms | ready 后约 180 MB | 第 222、282 行 |
| 8 个普通会话错开 350 ms | p99 6.1 ms，max 9.5 ms；所有轮次单次最大 21 ms | 峰值 199 MB | 第 226、229 行 |
| 8 个普通会话齐步 | p99 6.3 ms，max 51.4 ms（3 轮最大 52.8） | — | 第 239 行 |
| 1 个 2000 条会话跑一轮 | 拼一次请求阻塞约 45 ms | 恢复后 +46 MB | 第 267、285 行 |
| 4 个 2000 条会话同时请求 | max 192 / 200 / 291 ms | 恢复后 268 MB，各跑一轮后 300 MB，峰值 341 MB | 第 271、297 行 |
| 对照：4 个 native worker | — | 约 600 MB（外推） | 第 44、321 行 |

另有两处已知阻塞：每次 bash 调用一次同步 spawn（宿主拿到 systemd 变量后每次 8～12 ms，最长 25 ms，第 254-260 行）；新宿主第一轮用工具时一次性 63～82 ms（第 261 行）。

## 2 观测点

- pong：`{host:'pong', id, eldMaxMs, rssMb, channels}`，`eldMaxMs` 是上次 pong 以来的最坏值（`shared/types/dshHostProtocol.ts:110-119`，P1-3b 已落地）。
- supervisor：每 5 s 一次心跳，20 s 没有任何消息判卡死；ELD 超 200 ms、pong 往返超 2 s 写告警，同类 60 s 最多一次（`main/services/agent-host/DshHostSupervisor.ts:62-65,76-79,644-671`）。
- 宿主侧的 pong 由 P1-3a 实现（施工中，未提交）。落地时核对 ELD 的口径：P0-6 的数字扣掉了 10 ms 分辨率，pong 若没扣，下面的门槛各加 10 ms。
- LC-2 的正常值（约 0.2～0.3 s）本来就超过 200 ms 的告警线。这是有意的可观测，场景里断言「告警出现，且没有判卡死」。

## 3 场景

- **驱动**：新脚本 `dsh-host/tools/contention-probe.ts`，由 `p0-6-probe.ts` 的 latency 与 history-multi 模式演变而来。它直接讲 P1-3 的信封协议，不经 Electron；回合进行中每 250 ms 发一次 ping、收 pong；受害会话记下 Main 侧相邻两个 delta 的最大间隔。
- **历史**：不再真跑 500 轮（P0-6 并发造 4×500 轮用了 119 s，第 302 行），改用 `seedSession`（[决策 054](../../decisions/054-seed-session-host-op.md)）或 `agents.create({seed})` 合成 4 个 2000 条会话，每个约 2.4 M 字符（分片 04 的 E7）。
- **模型**：只用假网关 `dsh-host/tools/fake-gateway.mjs`：`P0-LOAD`、`P0-PACED`、`P0-HIST`，外加 §6 的 P8 场景。

| 场景 | 内容 | 频率 |
|---|---|---|
| LC-0 | 宿主 ready 后空闲 10 s | 每次推送 |
| LC-1 | 8 个普通会话错开 350 ms 跑 `P0-LOAD`（含 bash、read） | 每次推送 |
| LC-2 | 4 个 2000 条会话（关自动压缩，最坏情况）同时发一轮；同时 1 个会话流式输出 `P0-PACED` 当受害者 | 每次推送 |
| LC-3 | 同 LC-2，开自动压缩（产品默认），先只记录 | 手动 |
| LC-4 | 10 个 2000 条会话恢复并各跑一轮；再跑一次 `MALLOC_ARENA_MAX=2` 对照；据此决定要不要给宿主设堆参数 | 手动 |

LC-4 对应 P1-3 留给 P1-8 的两件事：`MALLOC_ARENA_MAX` 对比（[P1-3 分片 02](../p1-3-shared-host/02-design.md) 第 191 行；P0-6 第 360 行），以及「长会话多加上子代理时可能 OOM 连坐，要测上限」（[P1-3 方案](../p1-3-shared-host.md)第 180 行）。

## 4 门槛

硬门槛失败即红；软门槛只写进 CI 步骤摘要，跑满 5 次后按实测收紧。每个场景跑 3 次：硬门槛看最大值，软门槛看中位数。结果 JSON 作为 CI 产物上传。

| 场景 | 硬门槛 | 软门槛 |
|---|---|---|
| LC-0 | ELD ≤ 50 ms；RSS ≤ 300 MB | ELD ≤ 10 ms；RSS ≤ 230 MB |
| LC-1 | 200 × 8 块全部到达、没有串会话；ELD ≤ 150 ms；RSS ≤ 350 MB | ELD ≤ 60 ms；RSS ≤ 260 MB |
| LC-2 | 5 个回合全部 completed；ELD ≤ 1000 ms；受害者最大 delta 间隔 ≤ ELD + 150 ms；RSS ≤ 600 MB；没有判卡死，没有超过 2 s 的 pong | ELD ≤ 450 ms；RSS ≤ 450 MB |
| LC-3、LC-4 | 全部完成，宿主没有崩溃 | 首跑后定 |

- 硬门槛取「用户能感知的冻结」（1 s）与「和 4 个 native worker 相当的内存」（约 600 MB）；软门槛约为 P0-6 × 1.3～1.5。
- 超门槛时按这个顺序查：先看是不是 DSH 升级让拼请求变慢（对比升级前后的 LC-2）；再看压缩有没有生效（LC-3）；最后才考虑把超长会话挪到第二个宿主（P0-6 第 354 行的逃生口；P1-3 的 D1 目前不做）。

## 5 进 CI

- 与 P1-4e 共用 `dsh-bridge-gate.yml`，推送到本分支或手动触发（[P1-4 分片 05](../p1-4-bridge-parity/05-gate-and-changes.md) 第 88～92 行）。一个 Linux job 里依次跑：bridge 录制门禁、§6 的 G1～G7、LC-0～LC-2。随包 node 用 `scripts/fetch-node-runtime.mjs` 取。LC-3、LC-4 做成 `workflow_dispatch` 的输入项。
- `build.yml` 的 gate 只在推 `v*` tag 或手动触发时运行（`.github/workflows/build.yml:3-7`），所以不挂在那里。
- runner 规格没有核实（仓库公开时 ubuntu-latest 是 4 核 16 GB，私有时 2 核 7 GB，推断），软门槛前 5 次只记录。
- 推分支之前要用户确认，与 P1-2、P1-4e 相同。
- 开发机上跑：先 `free -m`，一次只起一个宿主，不和全量测试、Electron 同时跑。

## 6 防护场景（真宿主 + 假网关）

| # | 假网关场景 | 断言 |
|---|---|---|
| G1 | `P8-REPEAT`：流里不停地写同一个 `job_list {}` | 第 3 个写完后上游被断开；没有 `tool/call`；有 `assistant/attempt`；`turn/end error{tool_call_repetition}`；bridge 发 `session.failed`；下一轮请求里没有这条回复 |
| G2 | 17 个参数各不相同的 `job_output` | 第 17 个写完时掐断 |
| G3 | `P8-FANOUT`：10 个任务各不相同的 `subagent` | 不掐，全部执行 |
| G4 | `P8-LOOP`：每轮都调一次 `read`，上限设为 3 | 第 4 次请求带收尾指令，仍声明工具；收尾里的调用被拒，没有 `permission.requested`；`session.completed{stopCause:'turn_limit'}`；历史里看不到收尾指令 |
| G5 | 同 G4 | 用户插话开新纪元；`P8-WAKE` 的后台完成通知不清零；goal 回合各自计数 |
| G6 | 同 G1 | 经 Main 转发 `AICLIENT_RUNTIME_LOOP_GUARD=0` 后不掐；G4 照常 |
| G7 | 子代理里跑 `P8-REPEAT` | 子代理那一步被掐，父会话拿到失败的子代理结果（推断，E3 之后定） |

## 7 单测（根 vitest，假 ctx，不装 DSH）

- 1.0.x `runtime/__tests__/subagentLoopGuard.test.ts` 的规则用例换成 DSH 工具名照搬：签名规范化、第 3 次、超过 16 个、只判完整的块、正常扇出不受影响。
- 包装层：喂合成的 chunk 序列，断言触发时关了下游（调用了 `return()`）、只吐一个 `finish`、之后不再吐；不是 loop 请求时原样透传。
- 计数纪元、`pre-step` 的决定、`pre-execute` 的拒绝、`request-error` 的拦截、开关解析。
- 静态守卫：`DshHostProcess` 转发 `AICLIENT_RUNTIME_LOOP_GUARD`；bundle 里有 `aiclient-loop-guard` 行，且在必须启用清单里；`shared/runGuards.ts` 的错误码与渲染层失败卡的键一致（`renderer/components/chat/sessionFailure.ts:82,124`）。
- P1-11：新静态守卫 `noPiTuiInDshBuild.test.ts`（main、preload、renderer 里不再出现 `piTui` IPC、`PiTuiPty`、pi CLI 路径）；设置迁移（老值 `tui` 读出为 `gui`）；改写 `main/ipc/__tests__/onboardingLogoutSequence.test.ts`。

## 8 改动清单

### P1-11（选 A1）

| 子任务 | 删除 / 修改 | 规模 |
|---|---|---|
| P1-11a Main | 删 `main/services/terminal/{PiTuiPty,piTuiSession,piTuiStrandedSessions}.ts`、`main/ipc/piTui.ts`、`shared/types/piTui.ts` 与相关 IPC 通道、preload 的 `piTui`；`main/ipc/chat.ts` 去掉 `handOverFromTui`、`reloadSessionFromDisk` 与 `CHAT_RELOAD_SESSION`；`main/ipc/{index,onboarding}.ts`、`main/windows/MainWindow.ts` 去掉 TUI 收尾。`piCliLayout.ts` 与 pi 插件服务留给 P1-10c | 删约 1.9k，改约 60 |
| P1-11b 渲染层 | `SessionBar.tsx` 去掉开关；`WorkspaceShell.tsx`、`ChatWorkspace.tsx` 去掉 TUI 分支；删 `usePresentationSwitch.ts`、`AgentTerminal.tsx`、`hooks/piTuiOpenError.ts`；`useXterm.ts` 去掉 pi 分支；`stores/settings` 把 `presentationMode` 固定为 gui 并迁移老值；`stores/worktreeActivity.ts`、`useSessionIndex.ts`、`auth/signInLossModel.ts`、`shared/i18n.ts` 清理 | 删约 600，改约 80 |
| P1-11c 测试与说明 | 删分片 01 §4 的 TUI 测试；更新 `t35FinalAbsence`、`piCliIsBundledToolOnly`、`tuiEditorAndRailAlignStatic` 等静态测试；加新守卫；发版说明加「内嵌 pi 终端移除」 | 删约 2.7k，新增约 200 |

顺序：在 P1-9d 之前做。之后：P1-5e 在 P1-15 落地后停写 `auth.json`、`models.json`，并删 `managedCredentialsStartup` 为 TUI 做的重写；P1-10c 把插件页改成只读列出、下线 pi CLI 装卸；P1-12 整体删 `resources/agent-host`。

### P1-8

| 子任务 | 内容 | 主要文件 | 产品 / 测试（行，粗估） | 依赖 |
|---|---|---|---|---|
| P1-8a 流式掐断与开关 | 纯函数跟踪器（由 `delegationLoopGuard.ts` 改写）、`llm/stream` 包装、`request-error` 拦截、开关转发、共享常量 | `dsh-host/guards/{repetition,plugin}.ts`（新）、`dsh-host/bundle/cordis.patch.yml`、`shared/runGuards.ts`（新）、`main/services/agent-host/DshHostProcess.ts` | 350 / 450 | 纯函数现在就能做；接线在 P1-3a 之后 |
| P1-8b 500 轮上限 | 计数纪元、收尾步、`pre-execute` 拒绝、`step/end` 收尾 | `dsh-host/guards/ceiling.ts`（新）；P1-6b 的守卫查询；P1-4d 的映射与投影 | 300 / 500 | P1-4c 的 `step/end` 实验、P1-6b、P1-4d |
| P1-8c 争用回归与 CI | 驱动脚本、P8 假网关场景、门槛、CI 步骤 | `dsh-host/tools/contention-probe.ts`（新）、`dsh-host/tools/fake-gateway.mjs`、`.github/workflows/dsh-bridge-gate.yml` | 450 / 50 | P1-3a 的 pong；P1-4e 的 CI 骨架 |
| P1-8d（可选）内存与上游 | `MALLOC_ARENA_MAX` 与堆参数对照（LC-4）；同步 spawn 的上游问题草稿，提交与否由用户定 | 证据 | 约 20 | c |

合计约 1.5～2 人周（粗估）。跑测试的并行代理不超过 2 个。
