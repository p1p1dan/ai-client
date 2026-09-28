# 证据：P1-4c1 开工前实验：steer 与 Stop 保留收件箱（2026-09-28）

Role: evidence。上位：[P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) §8 第 1 条；验证[决策 093](../decisions/093-interject-via-dsh-steer.md)、[决策 094](../decisions/094-stop-keeps-inbox.md) 的假设。

**结论：全部 17 项判定通过，与决策 093 / 094 的假设一致，P1-4c1 按原方案实现。**另外测到两条实现约束（第 3 节）。

## 1 怎么跑的

- 基线：分支 `feat/dsh-p0-probe`，HEAD `466d0a81`，加上本任务未提交的改动（只有实验脚本与假网关新场景）。
- 环境：Linux 开发机，随包 Node v24.18.0，源码态 DSH 宿主（`src/dsh-host/host.ts`），DSH `dsh-agent` / `dsh-agent-loop` 0.1.7-rc.2。
- 模型：只用本地假网关 `src/dsh-host/tools/fake-gateway.mjs`（plan `dsh-p0-2`，新加 `P1-STEER`、`P1-STEER-ONE` 两个场景）。
- 命令：

  ```bash
  out-node-runtime/node src/dsh-host/tools/steer-experiments.ts --out /tmp/p1-4c1-steer-exp.json
  ```

  退出码 0。
- 做法：
  - 每个会话都是产品 bridge 自己的会话：走 `worker.bootstrap` 开在一个通道上，用 `worker.send` 发消息，与 Main 的驱动方式相同。
  - bridge 还不会 steer，所以 steer / cancel 由一个只在实验里装的行（`tools/lib/steer-experiment-row.mjs`）做：它用 `ctx.agents.get(<DSH 会话 id>)` 拿到 bridge 的 agent，直接调 DSH 的 `agent.steer` / `agent.cancel`。
  - 判定全部读 DSH 自己的日志（`sessionQuery.observeSession`），外加模型的回答：假网关的回答里列出它在请求里看到的 `STEER-NOTE-<标记>`，证明消息确实到了模型。

## 2 结果

| 编号 | 场景 | 判定 | 结果 |
|---|---|---|---|
| E1 | 工具调用在我方审批卡上等待时 steer（ask 档） | 卡未答复前消息停在 next-step、没被取走；答复后在同一回合第 2 步被取走；回合继续到 `completed`；模型看到了 | 通过 |
| E2s | 在最后一步的 `step/end` 监听器里**同步** steer | DSH 拒绝：`session append cannot reenter while another append is being published` | 通过（符合预期的拒绝，见第 3 节） |
| E2a | 最后一步 `step/end` 之后**一个微任务** steer（回合正处在收尾边界） | 在同一回合第 2 步被取走，只有一个回合，模型看到了 | 通过 |
| E2b | 最后一步 `step/end` 之后**一个宏任务** steer（RPC 最快也只能这样到达） | 此时回合已经 `turn/end completed`，agent 空闲；steer 自己开了第 2 回合并被取走，没丢 | 通过 |
| E3 | 在 `agent/turn-stopping` 的 await 期间 steer（实验行挂了一个监听器把它挡住） | 在同一回合第 2 步被取走，回合 `completed`，模型看到了 | 通过 |
| E4 | 工具执行中 steer，然后 Stop：`cancel({kind:'user'},{keepInbox:true})`，再 followup | Stop 后消息仍在 next-step，agent 空闲，2 秒内没有自己开回合；followup 开的新回合第 1 步依次取走 [插话, followup]；模型看到了 | 通过 |
| E4c | 同上，但 Stop 不带 keepInbox（决策 094 之前 bridge 的写法） | 收件箱被清空，日志里只留一条 `inbox/spliced … (canceled)`；新回合里模型没看到插话 | 通过（证明现状会丢消息） |
| E5 | Stop（keepInbox）之后、回合还没收敛之前立即 steer | DSH 把它改投 next-turn，回合以 `aborted(user)` 结束后自己开了第 2 回合，消息被取走 | 通过（没丢，见第 3 节） |

判定原文（脚本输出的 `verdict`）：

```json
{
  "E1_parkedWhileCardUp": true,
  "E1_claimedAtNextStepSameTurn": true,
  "E1_turnContinued": true,
  "E1_modelSawIt": true,
  "E2S_refusedAsReentrantAppend": true,
  "E2A_delivered": true,
  "E2A_sameTurnNextStep": true,
  "E2B_delivered": true,
  "E3_claimedAtNextStepSameTurn": true,
  "E3_turnContinued": true,
  "E3_modelSawIt": true,
  "E4_keptAfterStop": true,
  "E4_noTurnOpenedByStop": true,
  "E4_goesOutWithNextTurn": true,
  "E4_modelSawIt": true,
  "E4C_lostWithoutKeepInbox": true,
  "E5_notLost": true
}
```

### 日志节选

消息 id 缩写成 `m1`、`m2`…（每个场景各自编号）；`runtime-context` 是 DSH 自己注入的上下文，正文略去。

**E1（审批卡等待时 steer）**：steer 在 seq 12 进 next-step，工具结果之后的 `step/end` 边界被取走（seq 15），作为第 2 步的输入（seq 17）。

```
10 assistant/message t1 s1 (+1 call)
11 tool/call bash
12 inbox/spliced next-step +[m3]
13 tool/result "steer-step-1"
14 step/end t1 s1
15 inbox/spliced next-step +[] -1
16 step/start t1 s2
17 user/message [user] m3 "STEER-NOTE-E1 also say hi."
18 assistant/message t1 s2 (+1 call)
...
23 assistant/message t1 s3 "P1-STEER finished; heard: STEER-NOTE-E1."
25 turn/end t1 completed
```

**E2a（最后一步刚结束）** 与 **E3（turn-stopping 期间）** 形状相同：

```
10 assistant/message t1 s1 "P1-STEER-ONE heard: -."
11 step/end t1 s1
12 inbox/spliced next-step +[m3]
13 inbox/spliced next-step +[] -1
14 step/start t1 s2
15 user/message [user] m3 "STEER-NOTE-E2A one more thing."
16 assistant/message t1 s2 "P1-STEER-ONE heard: STEER-NOTE-E2A."
18 turn/end t1 completed
```

**E2b（回合已关闭）**：steer 落在空闲的 agent 上，自己开了第 2 回合。

```
11 step/end t1 s1
12 turn/end t1 completed
13 inbox/spliced next-step +[m3]
14 turn/start t2
17 user/message [user] m3 "STEER-NOTE-E2B one more thing."
```

**E4（Stop 保留收件箱，再 followup）**：

```
12 inbox/spliced next-step +[m3]
13 tool/result (error) "Error: tool call aborted"
14 step/end t1 s1
15 turn/end t1 aborted(user)
16 inbox/spliced next-turn +[m4]          <- the followup, 2 s after the Stop
17 turn/start t2
18 inbox/spliced next-step +[] -1
19 inbox/spliced next-turn +[] -1
21 user/message [user] m3 "STEER-NOTE-E4 after this."
22 user/message [user] m4 "P1-STEER-ONE: after the stop. (E4)"
23 assistant/message t2 s1 "P1-STEER-ONE heard: STEER-NOTE-E4."
```

**E4c（Stop 不保留收件箱）**：

```
12 inbox/spliced next-step +[m3]
13 inbox/spliced next-step +[] -1 (canceled)
...
21 user/message [user] m4 "P1-STEER-ONE: after the stop. (E4C)"
22 assistant/message t2 s1 "P1-STEER-ONE heard: -."
```

**E5（Stop 还没收敛就 steer）**：

```
12 inbox/spliced next-turn +[m3]        <- redirected: the turn's signal is already aborted
13 tool/result (error) "Error: tool call aborted"
15 turn/end t1 aborted(user)
16 turn/start t2                        <- nobody sent a followup
19 user/message [user] m3 "P1-STEER-ONE STEER-NOTE-E5 steered while stopping."
```

## 3 对实现的影响

1. **决策 093 的假设成立**：回合进行中（包括等审批、最后一步刚结束、`turn-stopping` 期间）steer 的消息都在下一个步边界被当前回合取走，回合继续，不会丢。
2. **决策 094 的假设成立**：`keepInbox` 让没取走的插话留在收件箱，Stop 本身不开回合；下一次 followup 开的回合第 1 步先取插话、再取 followup。不带 `keepInbox`（现状）会把插话丢掉。
3. **DSH 把 steer 追加成 `user/message` 时沿用 `createUserMessage` 生成的 id**（E1 的 m3 从进收件箱到落盘是同一个 id）。bridge 回显插话时按这个 id 认。
4. **约束一：不能在 `session/event` 监听器里同步 steer**（E2s）。bridge 只在 RPC 处理里 steer，本来就满足；实现里不要把 steer 挪进事件回调。
5. **约束二：Stop 之后、回合收敛之前的插话会自己开一个新回合**（E5）。这是 DSH 的原样语义（`send` 在信号已中止时改投 next-turn 并置唤醒标志）。bridge 在收到 `turn/end` 之前仍持有回合，这时的 Ctrl+Enter 会走 steer，DSH 随后开出的回合对 bridge 来说是「合成回合」，插话按 id 回显。按决策 090「跟随 DSH」，不另做处理；写进决策 111。
6. **回合已关闭时 steer 会开新回合**（E2b）。bridge 在 `turn/end` 时已经放下回合，这时答 `turnActive:false`、不 steer，由渲染层按普通发送处理，结果与 E2b 相同。

## 4 复现

- 脚本：`src/dsh-host/tools/steer-experiments.ts`（驱动）、`src/dsh-host/tools/lib/steer-experiment-row.mjs`（实验行，只装进临时 DSH_HOME 里的探针包副本，不进产品包）。
- 可用内存低于 900 MB 时脚本拒绝启动；只向自己启动的子进程发信号；临时目录在结束时删除，输出里的临时路径替换为 `<scratch>`。
