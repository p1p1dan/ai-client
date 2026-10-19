# 决策 202：委派行的「后台运行中」与 DSH 自开回合期间的发送

日期：2026-10-18（北京时间）。**状态：实现完成；标「自主」的是实现时的自主决定，待用户审批（第 4 节汇总）。** 分支 `claude/vibrant-panini-8dd759`，从 main 的 `19f6f5ef` 切出，本地提交，未推送。

起因：排查 决策 201（「立即发送」不再停子代理，分支 `claude/sub-agent-delegation-blocking-3a8feb`）时顺带发现两处问题，不在 201 的范围里，单独修。编号已登记在会话组共享笔记的 `decision-number-claims.md`。

## 1 委派行在主回合结束后仍显示为运行中（渲染端）

### 现象

- 后台子代理（委派工具很快回了 ack，子代理接着在后台跑）的泳道状态一直是 `running`。
- 委派行的 `running` 原来是 `lane.status === 'running' || (lane.status === null && parentRunning)`：
  - 主回合结束、会话已空闲后，这一行仍按前台运行画（运行中的计时、`live` 键）；
  - 看起来像子代理在前台跑、主对话被占着，其实输入框可以照常发送。

### 做法

- 新的纯函数 `subagentHeaderLiveness(laneStatus, parentRunning)`（`subagentActivityModel.ts`），三种结果：
  - `running`：泳道在跑，委派调用本身也还在跑（前台委派）；或泳道还没有状态、委派调用在跑（沿用原来的回退）；
  - `background`：泳道在跑，但委派调用已经结束；
  - `settled`：其余情况。
- `ToolRows.tsx` 的委派行只从这一个值取：`running` 才是前台运行态；`background` 时 `running: false`，另设 `backgroundRunning: true`。
- `backgroundRunning` 在结果词的位置画「· 后台运行中」（`data-slot="tool-row-background"`），用 `toolRowPermissionClass()`，与「后台 · bash-2」「已转后台」同一位置、同一色调，不是红色，不转圈。
- 文案：`'Running in background': '后台运行中'`（`src/shared/i18n.ts`）。
- **自主**：判断「后台」用的是「委派调用已结束」，不是「主回合已结束」。
  - 两者的差别只在主回合还在跑、后台委派的 ack 已经回来的那段时间：这时子代理确实是在后台跑，写「后台运行中」也是对的；
  - 委派行拿不到回合状态，改用回合状态要多接一层 context，收益不大。
- **自主**：不加图标或动画，只加一个词。设计规范里结果词一栏都是纯文字。

### 测试

- `src/renderer/components/chat/__tests__/subagentBackgroundRow.test.ts`：
  - `subagentHeaderLiveness` 的各组合（前台、后台、无状态、各终态）；
  - `ToolRows.tsx` 的接线（只从 liveness 取值、不再有旧表达式、slot 与翻译键在、中文是「后台运行中」）。
  - 渲染端单测跑在 node 环境里，没有 DOM，所以照 `dshToolVocabulary.test.ts` 的做法读源码断言接线。

## 2 DSH 自开回合期间的一次直接发送被合成回合结算吞掉（bridge）

### 现象

- DSH 自己会开回合：子代理结算通知、后台任务唤醒、目标轮次。bridge 给它一个合成的 `dsh-turn-*` requestId。
- 两道门都放过了这时的发送：
  - Main 的 `session_busy` 只看自己设的 `activeRequestId`；
  - bridge 的 `assertNoOwnTurn` 只拒绝非合成回合。
- 于是一次直接发送（队列放出，或用户恰好在那一刻发）走了 `startSend`：
  1. 覆盖 `this.turn`，`agent.followup(message)`；
  2. 合成回合的 `turn/end` 到来时，`onTurnEnd` 以**用户的** requestId 发出 `session.completed` 和 `idle`，`closeTurn` 把用户回合丢掉；Main 也在这时清掉 `activeRequestId`；
  3. 用户真正的回合随后作为新的合成 `dsh-turn-*` 打开，回显丢了 `userMessageId`/`attemptId` 配对（输入框的那条消息配不上回显）。
- 还有一个更窄的窗口：DSH 先把 agent 标成 running，再写 `turn/start`（`idle()` 的注释里写过）。这期间 `this.turn` 还是空的，发送同样会走 followup，随后的 `turn/start` 看到已有回合，就不开合成回合，唤醒回合直接顶着用户的 requestId 跑。

### 复现

- `src/dsh-host/bridge/__tests__/runtimeSyntheticTurnSend.test.ts`（fakeHost 照 `runtimeJobs.test.ts`）：
  - `[202-SYNTH-SEND]`：合成回合开着时发送，应当 steer、不 followup；回显带输入框的 attemptId；回合以合成 id 结算，用户的 requestId 不出现在任何事件上；之后会话空闲，下一次发送是普通回合。
  - `[202-PRE-START]`：agent 已 running、`turn/start` 还没来时发送，同样 steer；随后的回合以合成 id 打开和结算。
  - `[202-OWN-TURN]`：自己发的回合在跑时，第二次发送仍是 `WORKER_SESSION_BUSY`。
- 改之前前两条失败（`followup` 被调用），第三条通过。

### 做法

- `startSend` 在附件准入之后、建回合之前：只要已经有任意来源的回合在跑（`steerable()`：会话没关、有 agent、不空闲；自己的回合已经被 `assertNoOwnTurn` 挡掉了），这条消息就走 `steer`，和 Ctrl+Enter 一样进当前回合的 inbox，在下一个步边界被取走。
  - 回显：`steer` 记下了 attemptId，`user/message` 到来时 `takeSteered` 配上，回显带 attemptId。
  - 结算：合成回合照常以自己的 id 结算。Main 收到 `session.completed` 就清 `activeRequestId`（它不看 requestId），这条发送的闩随之放开。
  - 返回：仍是 `{ accepted: true, requestId: 用户的 requestId }`，Main 的 ack 校验不变。
  - 模型与 effort：`applyRoute` 照常先执行，用户这次选的模型从合成回合的下一步起生效。
- 合成回合结束时消息还没被取走（例如回合已在最后一步）：消息留在 inbox，DSH 会再开一个回合取它，这个回合是合成的，回显照样由 `takeSteered` 配上 attemptId。这与 Ctrl+Enter 的既有行为（决策 093、094）一致。
- 命令行（`/goal` 等）不受影响：命令在这一步之前就分走了。
- **自主**：选 steer，不选「让合成回合结束时不结算用户回合、把用户回合排到下一回合」。
  - 后一种要在 bridge 里排队并在 `onTurnEnd` 里把下一个回合交接过去；
  - 而且 Main 收到合成回合的 `session.completed` 就会清掉闩（`WorkerManager` 不按 requestId 匹配），还得同时改 Main，改动面大；
  - steer 复用现成路径，用户看到的是「这条消息并进了正在跑的回合」，与 Ctrl+Enter 相同。

## 3 验证

- `pnpm typecheck`、`pnpm typecheck:dsh-host` 通过。
- 新增两个测试文件全部通过；`src/dsh-host` 与 `src/renderer/components/chat` 下的既有测试中，与本次相关的（`dshSessionRuntime`、`commandsAndState`、`liveEvents`、`runtimeJobs`、`subagentActivityModel`、`dshToolVocabulary`）全部通过。
- 本机（Windows）上失败的是环境问题，与本次无关：创建符号链接 EPERM（`bashGate`）、只在 Linux 有效的 systemd 用例、`sessionGc`、Electron 未装好导致 `src/main/services/agent-host` 下几个文件加载失败。
- 没有在真宿主或打包应用里实测。

## 4 待审批

1. 「后台运行中」按「委派调用已结束、泳道仍在跑」判断，不看主回合状态（第 1 节）。
2. 「后台运行中」只是结果词位置上的一个词，不加图标、动画（第 1 节）。
3. DSH 自开回合期间的直接发送并入当前回合（steer），不排成下一回合（第 2 节）。
