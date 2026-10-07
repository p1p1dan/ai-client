# 决策 151：P1-3e 探针卡死开关与 S5 的实现取舍

日期：2026-10-07。**状态：自主决定，待用户审批。**

依据：

- [P1-3 方案](../topics/p1-3-shared-host.md) §5 的 P1-3e 行、§6；[分片 04](../topics/p1-3-shared-host/04-changes-and-tests.md) §3.2 的 S5。原文是「测试 bundle 的卡死开关（审批处理器不理会 abort）」。
- [决策 015](015-probe-plugin-out-of-product.md)：探针代码不进安装包。
- [决策 021](021-stop-escalation-ladder.md)：Stop 升级阶梯。
- [决策 075](075-stop-orphan-tool-scopes-after-host-death.md)：宿主死后回收工具的 scope。
- [pre-P1-14 清单](../topics/pre-p1-14-remaining-2026-10-07.md) 第 4 条。

代码提交 `4f461ece`。实测数字见 [P1-3 汇总证据](../evidence/p1-3-shared-host-2026-10-07.md)。**第 1、4、5 条请重点审批。**

## 规则

### 1. 卡点放在「工具执行不理会 abort」，不放在审批处理器（请重点审批）

- **计划写的审批处理器做不出卡死。**
  - dsh-user-approval 的 `decide` 让 `approval/request` 的应答和调用的 signal 赛跑（`dsh-user-approval/lib/index.js:172-189`）。
  - abort 一到，它就返回 `cancelled`。处理器自己挂多久都不影响 Stop 收尾，走不到阶梯 B。
- **工具体做得出。**
  - dsh-tools 明文规定「Cancellation never abandons the body」（`dsh-tools/lib/index.js:3288-3317`）。
  - agent loop 的 `runGroup` 等每个已派发的调用落定（`dsh-agent-loop/lib/index.js:551`、`:633`）。
  - 会话 dispose 是先 `cancel({kind:'disposed'})`、再 `whenIdle()`（同文件 `:1673-1674`）。
  - 所以，一个不理会 abort 的工具体能同时卡住 Stop 和会话级 dispose。这正是阶梯 B 要兜底的情形：DSH 自身卡死。
- **做法。** 探针 bundle 新增一行 `aiclient-probe-stuck`（`src/dsh-host/tools/probe-bundle/lib/stuck.js`）：
  - 在 `tools/execute` 瀑布上，挂住 JSON 参数里含 `AICLIENT_DSH_PROBE_STUCK_TOOL` 那段文本的调用；
  - 挂住的方式是不调 `next()`，返回一个永远不落定的 promise；
  - abort 到来时只写一条告警；
  - 挂住和忽略 abort 都以 `[dsh-host] warn aiclient-probe-stuck: …` 打到宿主 stderr，测试据此同步。
- **挂在 bridge 之前。** 这一行在宿主启动时注册，排在 bridge 每个会话的包装之前，所以：
  - 被挂住的调用不起任何进程；
  - bridge 看不到这个调用「开始执行」，工具行没有执行起点。这只影响界面上的计时，与本测试无关。
- **永不释放，本行被卸载时也不放。** 真实卡死就是这样。要是放了，优雅关停会顺利收尾，阶梯 B 的 SIGKILL 兜底就测不到。

### 2. 怎么打开开关，为什么进不了产品

有三道门：

1. **探针 bundle 物理上不在产物里。**
   - 构建只拷 `bundle/` 里列明的文件，以及 `BRIDGE_ENTRIES` / `HOST_ENTRY` 的 esbuild 产物（`scripts/dsh-host-build-lib.mjs` 的 `STAGED_BUNDLE_FILES`、`BRIDGE_ENTRIES`）。`tools/` 不进 `out-dsh-host`，`electron-builder.yml` 也不引用它。
   - 产物校验会拒绝产品 bundle 里出现探针行或探针插件（同文件，「The product bundle」一段）。
   - 依据决策 015。动工前已经核实这一点，否则会停下来报告。
2. **宿主只在源码形态、并且 `AICLIENT_DSH_PROBE_BUNDLE=1` 时，才叠加探针 bundle**（`host.ts:330-333`）。没有探针层却组合出了探针行，宿主直接 fatal（`host.ts:518-524`）。新行的名字 `@aiclient/dsh-probe/stuck` 也在这条判据之内。
3. **这一行本身默认关闭**：`disabled: !!js "!process.env.AICLIENT_DSH_PROBE_STUCK_TOOL"`。`apply` 里还会再判一次，变量为空就不注册。

另外，Main 从不转发 `AICLIENT_` 前缀的变量（`dshHostEnvironment.ts` 的剔除前缀）。`DshHostProcess.test.ts` 补了断言：新变量会被剔除。所以这个开关在应用里打不开。代价见第 6 条。

**集成测试的打开方式**：
- 第二阶段的 supervisor 用 `resolveLaunch`，在 Main 自己算出的 launch 环境上加三项：
  - `AICLIENT_DSH_PROBE_BUNDLE=1`；
  - `AICLIENT_DSH_PROBE_ROW=0`，关掉会自动批准的 IPC 行；
  - `AICLIENT_DSH_PROBE_STUCK_TOOL=P13ESTUCK`。
- `beforeAll` 里用 `installProbeBundle` 把探针 bundle 放进 DSH home 的 profile。
- 走的是 supervisor 现成的注入点，没有去改测试的 spawn 包装。

**第二阶段与其他阶段共用一个 DSH home**：
- `afterAll` 调新增的 `removeProbeBundle`（`tools/lib/probe-bundle.ts`）还原 profile：删两份拷贝，去掉 manifest 里的依赖和 bundles 条目。
- 本次全量运行中，后面的阶段没有再出现「bundle 未组合」告警。
- 第二阶段的 SIGSTOP 用例也跑在叠加了探针 bundle 的宿主上。这不影响它：
  - 只有带 needle 的调用会被挂住，SIGSTOP 用例的回合里没有 needle；
  - 测量行只响应 `{p06…}` 消息。

### 3. S5 改成真实卡死后，断言怎么改

- **同步点**：从「`sleep` 进程出现」改为「卡死行写出 holding」。另断言命令从未启动，即 `sleep-tool <token>` 的进程数为 0。
- **新增的断言**：
  - Stop 之后 10 s 内，卡死行写出 abort ignored。这证明 Stop 到达了 DSH，不是消息丢在半路。
  - b1 收到的事件依次是 `status:stopping`（bridge 收到 `worker.stop` 后发出）、`stopped(forced)`、`idle`。改前没有 `stopping`。
  - 旧宿主的 `lastExit` 是 `stuck-session`，并且 `signal: SIGKILL`。原因：真实卡死时，DSH 自己的 teardown 也在等这个调用。`host.ts` 的 `stopOnce` 卡在 `fiber.dispose()`，自退计时器要等它返回才会设，所以优雅关停 3.5 s 收不了尾。
  - 恢复后，b1 历史里挂住的那次调用是一条 `ok: false` 的工具结果，即结果未知。
- **删掉的断言**：「卡住会话的工具随旧宿主一起消失」。现在不起进程，这条没有意义。改为断言：调用只挂住过一次，恢复时不会重跑。
- **只记录、不断言**：b2 已流出的正文是否留在历史里。本次是没留下，见第 5 条。

### 4. IPC 丢消息那条路：Stop 阶梯 B 不再用，也不另外保留（请重点审批）

不另外保留「Stop 消息到不了 DSH」的用例，理由：

- 对 Main 来说，两种情况走的是同一条路：看门狗 → `restartEntry` → dispose RPC 等 3 s → close 等 3 s → `dispose-failed` → `restart('stuck-session')`。差别只在宿主内部。
- Main 这一侧已有单测覆盖：
  - `dshChannelStopWatchdog.test.ts` 的 [WMH-05] / [WMH-06]（真 supervisor 加脚本化的假宿主）；
  - `WorkerManager.test.ts` 的 [WMH-05] / [WMH-06] / [WMH-06b]。
- 第二阶段 supervisor 的预算是 5 min 3 次。现在已经用了两次（SIGSTOP 一次、阶梯 B 一次），再加一次就贴到上限。
- 开发机上每多跑一次阶梯 B，要多约 25 s。

「消息到不了 DSH」这种情形本身还保留：第三阶段「关不掉的通道」照旧在 IPC 边上丢掉 close，覆盖 bridge 弄丢了某个通道 close 的情况。spawn 包装和 `dropToHost` 的注释已经改成只说这一处。

### 5. 实测发现，本次不改（请重点审批后续怎么处理）

1. **决策 021「取舍」第 2 点（取消收不了尾时，会话级 dispose 可能也等不到）实测成立。** 阶梯 A 等 3 s 没有 ACK，再等 3 s 没有 `closed`，落到阶梯 B。
2. **决策 021 第 3 条、分片 02 §4 的「优雅关停时，其他会话在飞的正文同样落盘为 interrupted」，在卡点位于 DSH 内部时不成立。**
   - DSH 的 teardown 在等卡住的那个会话，3.5 s 收不了尾，宿主被 SIGKILL。
   - b2 流了约 20 s 的正文，恢复后的历史里一块都没有，只有用户消息和「引擎意外停止」注记。这和宿主崩溃时的结局相同。
   - 界面上 b2 收到 `failed(dsh_engine_restarted)`，告知没有问题。
   - 如果要保住这些正文，有两个选项：
     - A：阶梯 B 关宿主之前，先对其他在飞的通道逐个发 `worker.dispose`（每个 3 s，可以并发）；
     - B：宿主的 `shutdown` 先 dispose 没卡住的 agent，再整体 dispose。
   - 都没做，由用户定是否要做、放在哪个任务。
3. **阶梯 B 本次的总时长**：Stop 之后 10.0 s 界面收尾，19.6 s 旧宿主被杀，20.6 s 全部会话 idle。与分片 02 §4 估的「最坏约 23 s」一致。
4. 另一项发现与本开关无关，记在证据 §4.2 的 S2 一节：没有 systemd user bus、工具在沙箱外运行时，宿主被 SIGKILL 后工具进程仍在。这与决策 075 第 2 条的前提不符。

### 6. 没做的，以及代价

- **GUI 上走不到阶梯 B。** 开关在应用里打不开（第 2 条），这是有意为之。P1-14 的 GUI 专项如果要看阶梯 B 的界面（b1 先「停止中」10 s，其他会话收到 `engine_restarted` 提示），需要另做一条开发专用的触发方式。本决策不做。
- **`p0-6-probe` 没有加卡死场景。** S5 只在 L1 集成测试里跑。
- **文档**：探针 bundle 的 `package.json` 说明已更新，`cordis.patch.yml` 的新行自带注释。方案 topic 的原文「审批处理器不理会 abort」没有改，以本决策为准。
