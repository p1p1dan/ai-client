# 决策 201：「立即发送」不再连带停掉子代理（DSH 与 SDK 两个引擎）

日期：2026-10-19（北京时间）。**状态：用户 2026-10-19 批准方案 A（「立即发送」只停主回合、不动子代理，停止按钮维持全停）；标「自主」的是实现时的自主决定，待用户审批（第 6 节汇总）。** 分支 `claude/sub-agent-delegation-blocking-3a8feb`，从 `main` 的 `19f6f5ef` 切出，本地提交，未推送。修订[决策 069](069-stop-and-background-lifecycle.md) 第 1 条的适用范围。编号已登记在会话组共享笔记的 `decision-number-claims.md`。

修订注记（2026-10-19，[决策 203](203-stop-main-turn-background-and-subagent-page.md)）：停止按钮与 Esc 也改为只停主回合，第 3 节中"停止按钮维持全停"不再适用于 DSH。第 6 节第 4 条的能力判断移到消息进入 CLI 队列时：插话那一刻 CLI 可能还没发出 `system/init`。

## 1 起因

用户在 1.1.1 测试包上用 Claude Opus 5.5（SDK 引擎，路线 B）让模型委派子代理，子代理运行期间在输入框点了「立即发送」，委派随即中止。用户的预期与官方 Claude Code 一致：子代理与主对话并行，拉起后可以照常跟主对话交流。

## 2 原因

「立即发送」原来的做法是「把消息排到队首 + 按停止」（`ChatComposer.tsx` 的 `mode === 'sendNow'` 与队列条的 `handleQueueSendNow`），停止稳定后队列放出这条消息。停止在两个引擎上都会结束子代理：

| 引擎 | 停止做了什么 | 子代理 |
|---|---|---|
| DSH | 决策 069 第 1 条：先 `children.interruptAll()` 打断可续子代理的当前运行，`stopSubagentJobs` 停掉一次性后台子代理，再取消父回合 | 被打断 |
| SDK | `Query.interrupt()`，即 CLI 的 Stop | CLI 结束后台 Agent（探针实测：子代理任务记为 `killed`，它的命令也没了） |

1.0.x 的 runtime-hardening [决策 041](../../runtime-hardening/decisions/041-interject-does-not-wait-for-background-delegates.md) 本来就区分「插话」（子代理继续跑）和「Stop」（全停）。「立即发送」在用户眼里是一次插话，实现上却走了 Stop 那条路。

## 3 结论

- **停止按钮与 Esc**：不变，仍然连带停子代理（决策 069 第 1 条）。
- **「立即发送」**（输入框的按钮与队列条的按钮）：只结束主回合正在做的事，后台子代理继续运行，跑完照常把结果交回主对话。
  - DSH：停止请求加范围参数 `scope: 'turn'`，宿主跳过打断子代理的两步，只取消父回合（`keepInbox` 照旧）。停稳后队列放出消息，与原来一样。
  - SDK：不再停止。消息先按插话交给 CLI，等 CLI 报告这条消息已排队（`command_lifecycle` 的 `queued`），再发 CLI 自己的 Send now：一个带 `send_now: true` 和 `message_uuid` 的 `interrupt`。CLI 打断当前步骤，消息立刻送达模型，回复留在同一个回合里；CLI 的说明写明它「不结束 Stop 会结束的后台任务」。
- **前台委派仍会中止**：模型传了 `run_in_background: false`（或用了 DSH 的 `subagent_fork`）时，子代理就是主回合正在等的那一步，结束主回合必然结束它。这次不改。

## 4 实现

| 位置 | 改动 |
|---|---|
| `src/shared/types/workerRpc.ts` | `WorkerStopPayload.scope?: 'all' \| 'turn'`（缺省读作 `all`）；`WorkerInterjectPayload.sendNow?: boolean`；两个守卫都校验新字段 |
| `src/main/ipc/chat.ts`、`src/preload/index.ts`、`WorkerManager.ts` | `chat:stop` 带 `scope`（只认 `turn`，其余一律当 `all`），`chat:interject` 带 `sendNow`，原样转给宿主 |
| `src/renderer/stores/chatSessionActions.ts` | `stopChatSession(sessionId, scope = 'all')` |
| `src/renderer/components/chat/ChatComposer.tsx` | `handleStop` 拆成 `stopSession(scope)`：`handleStop` 传 `all`（停止按钮、Esc），`stopForSendNow` 传 `turn`（两个「立即发送」）。SDK 会话有回合在跑时，「立即发送」改走 `interjectIntoTurn(..., { sendNow: true })`；队列条先把那条移出队列再插话，没送出去就放回队首、按原路放出 |
| `src/dsh-host/bridge/dshSessionRuntime.ts` | `stop()` 在 `scope === 'turn'` 时不调用 `children.interruptAll()` 与 `jobs.stopSubagentJobs()` |
| `src/claude-sdk-host/sdkSessionRuntime.ts` | `system/init.capabilities` 含 `interrupt_send_now_v1` 才用 Send now；插话带 `sendNow` 时记为待发，收到该消息的 `queued` 后经 `Query.request()` 发 `{subtype: 'interrupt', send_now: true, message_uuid}` |

## 5 验证

- 根 `pnpm typecheck`、`pnpm typecheck:dsh-host` 通过；biome 通过。
- 单测：
  - DSH `[STOP-TURN]`：`scope: 'turn'` 时 `interrupt` 与 `jobs.kill` 都不调用，父回合照常取消，会话因子代理仍在跑而保持 busy。原有 `[P7B-STOP]`（全停）不变。
  - 渲染端 `[STOP-SCOPE]`（源码扫描）：停止按钮与 Esc 走 `all`，两个「立即发送」走 `turn`。
  - SDK「Send now (decision 201)」3 条：消息排队后才发 `send_now`，只发一次，不调用 Stop 的 `interrupt()`；CLI 未声明能力时不发；Ctrl+Enter 不发。
  - `workerRpc` 守卫。
- 路线 B 探针新组 `agentstop`（本机 Windows、假网关，`probe-suite.ts --only agentstop`）。场景：父回合先拉起一个后台子代理（子代理的脚本是两步：`sleep`，然后 `echo`），接着父回合自己跑一个长 `sleep`，两个 `sleep` 都起来之后：
  - `agent-sendnow`：带 `sendNow` 插话。CLI 回答 `stopped`；回合以 `session.completed` 结束，消息按 attemptId 回显并得到回复；子代理任务以 completed 结束，脚本跑完两步。
  - `agent-stop-all`：停止。回合以 `session.stopped` 结束；子代理任务记为 `killed`，两边的 `sleep` 都清掉。
  - 改动前的基线：「立即发送」在 SDK 引擎上与停止一样，子代理被 `killed`。

## 6 自主决定（待审批）

1. **SDK 引擎的「立即发送」改为插话加 CLI 的 Send now，而不是「只停主回合」。** CLI 的 Stop 一定会结束后台 Agent，宿主无法只停主回合；Send now 是 CLI 为这个按钮准备的协议（`interrupt_send_now_v1`）。可见差别是：消息与回复留在同一个回合里，不再是「已停止」加一个新回合。
2. **SDK 引擎上，Send now 会把子代理正在跑的命令转到后台。** 2.1.300 实测：CLI 把父、子两边正在跑的前台 Bash 都转成了后台任务；父回合那条随打断结束，子代理拿到「已转后台」的结果后继续往下走。这是 CLI 自己的行为，照它（决策 090）。
3. **已知限制，Windows**：「立即发送」打断父回合的 Bash 后，Git Bash 起的 MSYS 子进程（如 `sleep`）会残留到自己结束，与[路线 B README](../../claude-sdk-engine/README.md) §11.2 #52 同类。停止那条路径会按采样清理这些进程，但这份采样分不出哪些属于后台子代理，用在「立即发送」上可能误杀子代理的命令，所以这次不清。探针在 Windows 上把这一项记为只报告。
4. **CLI 不支持 Send now 时退回普通插话**：消息在下一个步骤边界送达，不打断。不退回「停止 + 发送」，因为那样会结束子代理。
5. **DSH 的「立即发送」仍是「只停主回合 + 发送」，不改成插话。** DSH 的插话要等到下一个步骤边界，前台工具跑得久时就不「立即」了；DSH 也没有对应 Send now 的机制。
