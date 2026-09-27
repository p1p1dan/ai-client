# P1-3a / P1-3b 共享宿主：实现与验证（2026-09-27，Linux 开发机）

Role: evidence。对应 [roadmap P1-3](../roadmap.md) 的子任务 P1-3a、P1-3b，按[方案](../topics/p1-3-shared-host.md)与决策 019～025 施工。代码提交：P1-3b `04ba4166`（Main 侧组件，未接线），P1-3a `1427a870`（宿主侧多路复用与接线）。原始报告（已去掉本机路径）在同名目录 [p1-3a-shared-host-2026-09-27/](p1-3a-shared-host-2026-09-27/)。

## 结论

所有聊天会话现在共用一个 DSH 宿主进程。宿主崩溃与卡死都能在应用内恢复，会话不停在 error。P1-3 的其余部分（批次恢复与两级预算、Stop 阶梯 B、日志清理、空闲关停、更新前关宿主）在 P1-3c / P1-3d。

## 验证

| 项 | 结果 | 报告 |
|---|---|---|
| 类型检查 | 根、agent-host、dsh-host 三套退出 0（编排器复跑） | — |
| 单测 | agent-host、ipc、shared/types、dsh-host、构建库共 55 个文件、754 例通过，4 例是默认跳过的集成测试（编排器复跑） | — |
| 真宿主集成测试 | 4/4 通过（编排器用 `AICLIENT_DSH_INTEGRATION=1` 复跑）。① 多个会话共用一个宿主；② 一个会话在跑 `sleep` 工具时 SIGKILL 宿主，三个会话 0.8～0.9 s 内全部 resumed + idle，generation 都到 2，在飞的会话收到 `session.failed`，2 s 内没有孤儿工具进程，宿主只重启一次，再跑一轮 RECALL，标记都在；③ SIGSTOP 宿主后，心跳在 24.8 s 判卡死并强杀，恢复用 0.8～1.5 s，下一轮正常完成；④ 回合刚结束就关一个会话，宿主和其他会话不受影响 | `integration.log` |
| bridge-smoke | 27 项判定全部为真：原有 18 项加 9 项协议检查。带 `--systemd-scope` 再跑一遍也通过 | `bridge-smoke.json`、`bridge-smoke-systemd-scope.json` |
| 打包冒烟 | 重建 `out-dsh-host` 后跑 L0 / L1，37 项全过（编排器复跑） | `packaged-smoke-l1*.json` |
| P0-6 延迟探针 | 抽跑一轮，通过 | `p0-6-latency.json` |

## 两个开工实验

1. **工具进程不继承宿主的 IPC 句柄（Linux）**：Node 24 给 IPC fd 设了 `O_CLOEXEC`（fdinfo flags `02004002`），并且在用户代码运行前删掉了 `NODE_CHANNEL_FD`。bash 在沙箱内、升级出沙箱、systemd scope、回退路径这四种情况下，都只有 fd 0/1/2，`NODE_CHANNEL_FD` 都未设。**[决策 034](../decisions/034-per-request-credential-pull.md) 的前置条件在 Linux 上成立**；Windows、macOS 留给 P1-14 的 CI。
2. **projection-cache 告警**：回合一结束就 dispose 时，共享宿主下仍会出现 `turn/end write … flush on a closed handle`；经 WorkerManager 走正常关闭时不出现。判断无害：这是 DSH 投影缓存按设计「失败即放弃」的写入，下次冷读会自愈；会话日志完好，另起宿主能召回全部标记。

## Stop 看门狗在通道下的行为

- `forceStop` 不调 `forceKillNow`，而是走 `restartEntry`：先对旧 slot 发 `worker.dispose`，3 s 没回应再发 `{host:'close'}`。两步在通道上都不发信号，所以不会杀掉宿主。
- 宿主能关掉这个通道时，只在同一个宿主上重开这个会话，其他会话无感。宿主一直不回应时，界面在 10 s 照常收到 `stopped(forced)` 和 idle；约 16 s 这个会话进入 error；宿主不被杀，其他会话照常可用。
- 取舍：卡住的 agent 会一直持有这个会话的 DSH 锁，直到宿主重启，用户重试会得到 `session_locked`。由 P1-3c 的阶梯 B 解决（[决策 021](../decisions/021-stop-escalation-ladder.md)）。

## 与方案的偏离

- `host.js` 从单纯转译改成 esbuild 打包（`host.ts` 加 `lib/`，npm 包全部外置），另加 `checkHostMetafile` 与产物校验，目的是让纯规则可测试并能进安装包。已补记到[决策 011](../decisions/011-host-ships-as-build-artifact.md)。
- 测试 bundle 里的自动批准行改由 `AICLIENT_DSH_PROBE_ROW=0` 关闭，因为原来用的两个 bridge 环境变量已删。
- 新增三道防护：bridge 没接管 IPC 时宿主直接报 fatal，不发 ready；宿主记住已关闭的通道 id，迟到的 bootstrap 不能复活它；supervisor 对刚关闭通道重复发来的 `closed` 不再告警。
- 修正 P1-3b 的一处归因：被 SIGKILL 的宿主会先断 IPC 再报退出，原来 `lastExit.reason` 记成 `disconnected`，现在记为 `crashed`。这是集成测试发现的。
- 打包冒烟默认 `--narb dir`，与 Main 一致；能识别经 `systemd-run … -- runner -- 工具` 启动的 rg。
- P0-4 上机包补拷 lib，并把 bridge 打包进去；只验证了打包这一步，整包没跑，因为要 `npm ci` win32 依赖。

## 留给 P1-3c / P1-3d

- 宿主崩溃现在会扣每个会话自己的重启预算，每个会话扣 1 次；60 s 内第 3 次宿主故障，会话会停在 error。需要批次恢复与两级预算（[决策 020](../decisions/020-host-fault-handling-and-budgets.md)）。
- 还缺：`dsh_host_crashed` / `engine_restarted` 错误码；阶梯 B（通道确认不了关闭时调 `supervisor.restart('stuck-session')`）；「重启预算耗尽」换成专门的错误码。
- `disposeAll('app-shutdown')` 仍然逐个通道发 RPC；`invalidateAll` 还不会连带关停宿主。
- SIGSTOP 判定用了 24.8 s，贴着集成测试 25 s 的判据线，P1-3e 要放宽判据或调心跳参数。
- P1-3d：日志清理、空闲关停、更新前关宿主。
