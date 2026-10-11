# 决策 178：自动压缩在时间线上可见；手动压缩期间发消息改为排队；超窗失败卡改用 DSH 的说法

日期：2026-10-11。**状态：第 1 节为用户要求（2026-10-11）；第 2 节起为自主决定，待用户审批。**

代码提交：`c055d638`（直播可见）、`cecc7507`（压缩期间发消息排队）、`79701e79`（超窗失败卡）、`fc7ad7d4`（录制场景）；`compact` 样本重录 `3b16c96d`。

来源：用户 2026-10-11 的三条要求（经编排者转达，已拍板）；编排者同日的只读调研（`compaction/*` 不翻译、检查点不产生通知、`worker.send` 10 秒超时排在压缩之后、超窗失败卡沿用 1.0.x 预检说法）。代码：本决策的改动尚未提交（工作树，HEAD `e6605d39`）。

修订关系：

- [决策 176](176-session-commands-start-before-run.md) §3.2 第 4 条与 §5「压缩中 · 发消息」一行（「不在本决策范围，照旧送到 Main」）：由本决策第 4 节接手。启动阶段（「正在启动对话…」时发消息不发出、提示、留在输入框）不变。
- [决策 140](140-p1-7e-e2b-choices.md)（手动压缩成功即在时间线末尾出摘要行）、决策 144（摘要行标题随界面语言）：不变；自动压缩的摘要行是同一种行。
- 决策 099（直播映射表）：`liveEvents.ts` 的映射表加一行 `compaction/start` / `/end` → `session.compaction`。
- [决策 177](177-auto-compaction-policy-per-model.md)（按模型的自动压缩策略）：互不依赖；本决策的录制样本在 177 的宿主策略下录制（摘要 `maxTokens` 是 177 的 8192），177 提交后 `--check` 通过。

## 1 用户要求（2026-10-11）

1. **自动压缩时时间线显示进行中**：开始时在当前回合里显示「正在压缩上下文…」（照时间线现有的进行中行 / 状态行样式，遵守 `docs/design-system.md`）；完成后直接变成「上下文摘要」行，位置与重开对话时的投影一致（直播与回放收敛到同一行、同一个 id）；失败时显示一句弱提示（例如「自动压缩没有成功，这一轮继续使用完整上下文」），回合照常继续。超窗恢复那条路径同样显示。手动 `/compact` 的输入框状态行保持决策 176 的做法，不重复显示。
2. **手动压缩期间发消息**：不要再出现「先报发送失败、随后又开始这一轮」。推荐做法：压缩阶段按 Enter 时把消息放进现有的排队机制，压缩结束后自动发出；压缩失败也照常发出。若排队机制不适合，就与决策 176 启动阶段一致。选哪种写进决策并说明理由。
3. **超窗失败卡文案**改成符合 DSH 实际的说法：请求已发出、内核已尝试压缩仍放不下；建议换更大窗口的模型、新开对话或先 `/compact`。

## 2 现状与根因（HEAD `8e5f4556` 上逐条核实）

### 2.1 DSH 的压缩事务

`dsh-compaction-basic` 的 `compactSurfaceRegion`（`lib/index.js:450-522`）是手动与自动共用的同一个事务，日志依次写：

| 事件 | 数据 |
|---|---|
| `compaction/start` | `{compactionId, sourceCommandId?, turn}`：`turn` 是所属回合号；手动 `/compact` 为 `null` |
| `compaction/summary` | 摘要记录（原始输出、被替换的范围、模型、`maxTokens`、用量） |
| `user/message`（`source.kind: compact-checkpoint`，带 `compactionId`） | 替换型检查点，`surfaceOp: replace` |
| `compaction/end` | `{compactionId, sourceCommandId?, turn, error?}`；失败时只有 start 与带 `error` 的 end |

自动压缩两条路径（`_registerAutomaticCompaction`，`:834-888`）：

- **压力**：`agent/pre-step` 每步之前量一次请求压力（`dsh-agent-loop` 的 `preStep`，在 `step/start` 之前）。常见的是**新一轮第一步之前**——这时用户的新消息还没写进日志（它在 `step/start` 之后才 append），所以日志顺序是「检查点 → 用户消息」；也可能发生在同一轮两步之间。失败只 warn，回合继续。
- **超窗**：模型以超窗拒绝这一步的请求（`agent/request-error`，`CONTEXT_WINDOW_EXCEEDED`），压缩后重试**同一步**。这时这一步的直播消息已经被那次被拒的请求打开（`message.started`），重试的回复写进同一条消息。压缩失败则保留原错误，回合以 `CONTEXT_WINDOW_EXCEEDED` 失败。

### 2.2 为什么直播时看不见

| 环节 | 位置（HEAD） | 现状 |
|---|---|---|
| bridge | `liveEvents.ts:717-775` | `onSessionEvent` 不认 `compaction/*`，落进 `default` |
| bridge | `liveEvents.ts:853-854`、`dshNotices.ts:141-149` | 检查点的 `source` 不是通知形式，`dshNoticeText` 返回 `undefined`，不发通知 |
| 投影 | `projection.ts:721-739` | 检查点投成「上下文摘要」行，但不带 `liveMessageId`——直播里没有它的副本 |

结论：自动压缩只在重开对话后以摘要行出现；直播里一次压缩（可达几十秒）什么都不显示，失败更是无声。

### 2.3 手动压缩期间发消息

- 输入框：决策 176 只在「正在启动对话…」时挡住发送（`ChatComposer.tsx:1386-1399`）；「正在压缩上下文…」时 `decideSendAction`（`:1373`）答 `send`，照常 `runSend`。
- Main：`startTurn`（`WorkerManager.ts:2164` 起）不看 `compacting`，`worker.send` 用默认 10 秒超时（`WorkerSlot.ts:92`）。
- bridge：所有请求排在同一条链上（`bridgeRpcServer.ts` `receive`，约 269-319 行），`worker.compact` 最长约 45 秒。

于是：发送在 Main 10 秒后超时、输入框报「发送失败」，压缩结束后链轮到这条 `worker.send`，这一轮照样开始。编排者的推断成立。

### 2.4 超窗失败卡

`dshFailureCodes.ts:86` 把 DSH 的 `CONTEXT_WINDOW_EXCEEDED` 映射为 `CONTEXT_TOO_LARGE`，`sessionFailure.ts:302` 再别名到 1.0.x 的 `context_too_large`（`:107-113`）：标题「提示词已经超出现有模型的容量」、正文「…所以这一轮根本没有发出去」。那是 1.0.x 发送前预检的说法；DSH 下请求发出了、模型拒绝了，内核还先压缩重试过一次。

## 3 事件设计（自主决定）

### 3.1 新事件 `session.compaction`

```ts
interface SessionCompactionEvent {
  type: 'session.compaction';
  sessionId: string;
  payload: {
    messageId: string;                 // dsh-compaction-<compactionId>
    phase: 'started' | 'completed' | 'failed' | 'interrupted';
    trigger: 'pressure' | 'overflow';
    beforeMessageId?: string;          // overflow: the step message the refused request opened
    summary?: string;                  // completed: the row's text, as the history projects it
  };
}
```

- **新事件类型，不复用 `custom.message`**：`custom.message` 是一条一次成形的通知，表达不了「同一行从进行中变成摘要」，也带不了插入位置。旧渲染层的 reducer 对未知类型走 `default` 返回空补丁，不崩、不显示（与引入前一样）；Main 对 worker 事件按类型透传（`handleWorkerEvent`），不需要改。
- **只翻译回合自己的压缩**：`compaction/start.turn` 是数字才算自动压缩；`/compact`（`turn: null`）照决策 176 由输入框状态行显示，摘要行照决策 140 由 `worker.compact` 的答复带回，直播不重复显示。
- **一次压缩一行，id 用 `compactionId`**：开始时还不知道检查点消息的 id，`compactionId` 从 start 到 end 不变，而且写在检查点的 `source` 上，投影能据此给摘要行标出同一个 `liveMessageId`。
- **触发方式**：start 到来时有一步正处在 `step/start` 与 `step/end` 之间，就是超窗恢复；否则是压力。bridge 与投影用同一条规则（投影新记 `step/start` / `step/end`）。

### 3.2 bridge（`liveEvents.ts`）

| DSH 事件 | 直播事件 |
|---|---|
| `compaction/start`（`turn` 为数字） | `started`；超窗时带 `beforeMessageId` = 这一步已打开且未关闭的直播消息 |
| 检查点 `user/message`（其 `compactionId` 正在进行） | `completed`，`summary` = `dshCheckpointRowText(content)`（与投影同一个函数，「Context summary」+ 摘要） |
| `compaction/end` 带 `error` | `failed`；本回合已收到 Stop（`stop()` 调 `noteStopRequested()`）则 `interrupted`。DSH 的原因只写 bridge 日志（`[dsh-bridge] automatic compaction (<trigger>) ended without a summary: …`，截 500 字），不上屏 |
| `compaction/end` 无 `error`、没见到检查点 | `completed`（无摘要，只有标题；当前 DSH 不会出现，防止一直转圈） |

检查点出现即算完成，不等 end：检查点已经写进日志，投影也据此出摘要行；这样 end 写失败（DSH 故意留下未配对的 start）时直播也不会卡在进行中。

### 3.3 投影（`projection.ts`）

- 检查点所属的压缩是本回合的自动压缩时，摘要行带 `liveMessageId: dsh-compaction-<compactionId>`；`/compact` 的摘要行不带（录制样本 `rpc.compact.json` 不变）。
- 自动压缩以 `error` 结束：在它的位置追加一行备注（id `h:compaction-<compactionId>`，第一块 `…:compaction-failed:0`，文字与 `notice.key` 是下面的英文键，带同一个 `liveMessageId`）。
- 回合结束时：失败备注之后没有再开始任何一步、回合又是 `aborted`（Stop），改成「没有完成」；有 start 没有 end 的（引擎中途没了，DSH 恢复时以 `interrupted` 收尾）也补一行「没有完成」；检查点已落地的不补。

## 4 界面（自主决定）

### 4.1 三种行

| 状态 | 样式 | 中文 |
|---|---|---|
| 进行中 | 时间线轻量行（`dshLightRowClass`：`text-meta text-muted-foreground`、`gap-2`），`Spinner`（`size-3.5`，与输入框状态行同一个组件），单行截断 | 正在压缩上下文…（复用决策 176 状态行的词条） |
| 完成 | 就是现有的「上下文摘要」行（`NoticeMessage`，第一行标题随界面语言），与重开对话时同一种行 | 上下文摘要 … |
| 压力失败 | 轻量行，`Info` 图标 | 自动压缩没有成功，这一轮继续使用完整的上下文。 |
| 超窗失败 | 同上 | 自动压缩没有成功，请求仍然超出模型的上下文窗口。（随后是超窗失败卡） |
| 被 Stop 打断 / 引擎没了 | 同上 | 自动压缩没有完成，上下文没有压缩。 |

- 失败与打断用三句而不是用户举例的一句：超窗失败后回合会失败，说「这一轮继续」是错的；Stop 打断时也不是「没有成功」。
- 行由块 id 识别（`isDshCompactionNoteRow`，与 `isDshSummaryRow` 同法），直播与回放的行结构一致；`dshCompactionRowView` 给出图标与词条，`DshCompactionRow` 绘制，挂在时间线的 `notice` 分支、排在 DSH 通知行之前。
- 与摘要行一样，备注行不计入所在回合的「已工作」时长（`MessageTimeline` 的 `bodyMetadata`）：压力压缩常发生在下一条用户消息之前，会落在上一轮的末尾。
- 会话分支对话框里，备注行的预览按界面语言显示（`sessionTreeNodeTitle`）。

### 4.2 位置：与重开对话时一致

| 情形 | 直播 | 重开 |
|---|---|---|
| 新一轮第一步前（压力，最常见） | 上一轮回复之后、这条用户消息的回显之前；用户的待确认气泡在它下面（待确认气泡始终画在已确认消息之后） | 检查点在用户消息之前 |
| 两步之间（压力） | 两步的回复之间 | 同左 |
| 超窗恢复 | 插在被拒那一步的回复**之前**（`beforeMessageId`），重试的回复写进同一条消息，于是在摘要之后 | 检查点在这一步的 `assistant/message` 之前 |

第一种情形里，「正在压缩上下文…」出现在用户刚发的气泡上方，而不是下方。这是有意的：用户要求位置与重开一致，而 DSH 确实是在收下这条消息之前压缩的（摘要不含这条消息）。若希望出现在气泡下方，需要连同投影一起改（把这种检查点挪到用户消息之后），见第 9 节风险 1。

### 4.3 直播与回放收敛

`historyReplayMerge` 的「按 `liveMessageId` 精确归并」（P1-4d1）原样适用：恢复后历史里同一个 `liveMessageId` 的行替代直播行，留在历史的位置上，不重复、不挪位。已用三个录制场景的直播流 + 历史页验证（第 7 节）。

### 4.4 回合结束时还在转的行

渲染层收到 `session.completed` / `failed` / `stopped`（含 Main 的 `forced`）时，仍是进行中的压缩行一律改成「没有完成」：引擎崩溃或被结束时 bridge 不会再发 end。

## 5 手动压缩期间发消息（自主决定）

**选排队**（用户推荐的做法）：

1. `handleSend`：本窗口的 `/compact` 处在「压缩」阶段时，`decideSendAction` 按忙处理，Enter / 发送按钮把消息放进现有队列（与回合进行中按 Enter 同一套：队列条显示、可删除、可「立即发送」），输入框清空。
2. 队列释放：`useQueueRelease` 的 `isInFlight` 从「仅启动阶段」改为「`/compact` 在途的整个过程」（`compactPhase !== undefined`）。`/compact` 结束——压缩成功、失败或对话被结束——阶段清除，队列照常释放、自动发出。
3. Ctrl+Enter：压缩不是回合，不调 `interject`，同样排队（键盘上本来就只有「有回合可停」时 Ctrl+Enter 才是插话，这里是兜底）。
4. **Main 兜底**：`startTurn` 遇到 `entry.compacting` 当场答 `session_busy`（可重试），不再把发送排进 worker 的请求链。这样另一个窗口、失败卡的「继续」等不经过本窗口队列的发送也不会出现「先报失败、随后又开始」；渲染层对 `session_busy` 有现成的有限重试（8 × 250 ms），之后按「未被接收」处理（队列释放的会暂停队列，直接发送的武装重试），不会悄悄开始一轮。

理由：

- 排队是用户在「回合进行中按 Enter」时已经熟悉的行为，消息不丢、不需要重新按；压缩结束（成功或失败）后自动发出，满足「压缩失败也照常发出」。
- 发送在 `/compact` 的 IPC 答复之后才出去，那时 Main 的 `compacting` 已清、bridge 的请求链已空，不会再撞 10 秒超时。
- **启动阶段维持决策 176**（不发出、提示「等对话启动后再发送」、文字留在输入框）：用户这次只要求压缩阶段；把启动阶段也改成排队是一处可选的统一，列入待审批（第 10 节）。

## 6 超窗失败卡（自主决定措辞）

DSH 的 `CONTEXT_TOO_LARGE` 不再别名到 1.0.x 的 `context_too_large`，有自己的卡；`context_too_large` 原样保留给 1.0.x 记录下来的会话。

| 字段 | 英文键 | 中文 |
|---|---|---|
| 标题 | The conversation no longer fits the model’s context window | 对话已经超出模型的上下文窗口 |
| 原因 | The request was sent, and the model refused it as larger than its context window. The engine tried to compact the context and retry, and it still did not fit. | 请求已经发给模型，模型以超出上下文窗口为由拒绝了它。引擎已尝试压缩上下文后重试，仍然放不下。 |
| 建议 | Switch to a model with a larger context window, start a new chat, or run /compact first and then send a message to carry on. | 换用上下文窗口更大的模型、新开对话，或先输入 /compact 压缩上下文，再发消息接着做。 |

动作仍是 `configure`（没有「继续」按钮）：不改任何东西直接重试，多半再次超窗。原句（如 `prompt is too long: …`）照旧在卡片下方作为详情。

「引擎已尝试压缩」在两种边界下只是「尝试过」：没有可压缩的较早内容（这一条消息本身就超窗），或本 agent 的超窗重试次数已用完（`maxOverflowRetries` 默认 1，空闲后清零）。决策 177 判为「不会自动压缩」的模型，超窗恢复仍然会跑（177 第 2 节），措辞依然成立。

## 7 录制场景与假网关（自主决定）

### 7.1 假网关（`tools/fake-gateway.mjs`，`dsh-p0-2`）

- `P1-AUTOCOMPACT {"tag":"x","claim":150000}`：答一句「是否带着压缩检查点」；带 `claim` 时这次回复按 `claim` 个提示 token 计费。DSH 的 token meter 以服务商报告的用量为基线，于是下一步的压力越过 `fake-1`（200k / 8192）的阈值 126,272。
- `P1-OVERFLOW {"tag":"x"}`：请求里没有「在最后一条 assistant 之后的检查点」时答 HTTP 400 `prompt is too long: 250000 tokens > 200000 maximum`（pi-ai 与 DSH 都识别为 `CONTEXT_WINDOW_EXCEEDED`），否则答一句。
- 摘要请求的会话里任何地方带 `P1-COMPACT-REFUSE` 时，答 HTTP 400，让这次压缩失败。
- 不改 `cordis.patch.yml` / 压缩行的配置：用默认阈值触发，与决策 177 的「某层自设阈值键就跳过」互不干扰。

### 7.2 新场景（`tools/bridge-record.ts`，各自独占一个宿主，排在最后）

| 场景 | 内容 | 断言（`dshStreamReplay.test.ts`） |
|---|---|---|
| `auto-compact` | 两轮各约 40k token 填充（`zfill` 词，录制时归一成 `<filler>`），第二轮回复计费 150k；第三轮第一步前压缩掉第一轮 | 进行中行（Spinner 词条）→ 同 id 变摘要行，位于第三轮用户消息之前；重开同位置同文字；恢复后只剩历史那一行；回合中途被 `forced` 结束时行变「没有完成」 |
| `auto-compact-fail` | 同上，第一轮带 `P1-COMPACT-REFUSE` | 压力失败备注（中文核对），第三轮用完整上下文作答；重开同位置；恢复后只剩一行 |
| `overflow-compact` | 一轮；`P1-OVERFLOW` 被拒→压缩→重试作答；一轮带 `P1-COMPACT-REFUSE`；再一轮 `P1-OVERFLOW`，压缩被拒→回合以 `CONTEXT_TOO_LARGE` 失败 | 摘要行插在被拒那一步回复之前、用户消息之后（重开相同）；超窗失败备注在失败请求的空消息之前；失败卡用新文案、无「继续」；恢复后两行都归并 |

录制器在场景里自查压缩事件的阶段序列，不符合就报错而不是录下一份没用的样本。

## 8 验证（2026-10-11，开发机，一次一个测试进程，每次先看 `free -m`）

### 8.1 新增与改写的测试

- bridge `liveEvents.test.ts`：`[178-LIVE-1]`～`[178-LIVE-5]`（压力→摘要、超窗带 `beforeMessageId` 与日志行、压力失败 / Stop 打断与下一回合清零、手动 `/compact` 不出直播、无关检查点与 end 忽略），每例同时用投影核对 `liveMessageId` 与文字。
- 投影 `projection.test.ts`：`[178-PROJ-1]`～`[178-PROJ-3]`。
- 金样本 `dshHistoryGolden.test.ts`：场景清单加三项（投影、树、首页三项对拍自动覆盖新场景）。
- 渲染层 `dshStreamReplay.test.ts`：三个新场景的 `scenario(...)` 块；`overflow-compact` 进 `ENDS_FAILED` 与 `REOPEN_DIFFERS`（与 `fail` 同因：失败卡是直播的）。
- 输入框 `compactStartMount.test.ts`：`[178-C-01]`～`[178-C-03]`（Enter 排队不发送、Ctrl+Enter 排队不插话、压缩失败后消息仍在队列）；`compactQueueRelease.test.ts`（新）：`[178-Q-01]` 接线、`[178-Q-02]` 启动与压缩阶段都不释放、结束即释放。
- Main `WorkerManager.test.ts`：`[178-WM-1]`（压缩在途时发送当场 `session_busy`、worker 没收到 `worker.send`；压缩结束后同一条发出）。
- 失败卡 `sessionFailure.test.ts`：`[178-F1]` 与两份枚举；`e4CatalogKeys.test.ts`：`[178-TREE]`。
- 变异检查：把 `ChatComposer.tsx` 的两处改动（忙判定、`isInFlight`）临时换回 HEAD 写法，`[178-C-01]`～`[178-C-03]` 与 `[178-Q-01]` 失败；换回后 sha256 与换前一致。

### 8.2 门禁

- `pnpm typecheck`、`pnpm typecheck:dsh-host`：通过。
- `biome check`：本决策改动与新增的文件无问题（`i18n.ts` 只检查不写）。
- `vitest run src/dsh-host src/shared/dshHistory`：56 个文件通过、3 个跳过（真宿主集成），1268 项。
- `vitest run scripts`：13 个文件、230 项。
- `vitest run src/renderer/components/chat`：167 个文件、3321 项（最后一次改动之后重跑）。
- `vitest run src/renderer/stores src/main/services/agent-host`：72 个文件通过、1 个跳过，1465 项。
- `vitest run src/renderer/components/workspace-shell src/main/ipc`：94 个文件、1220 项。
- `vitest run Static Scan Wiring`：79 个文件、822 项。
- `vitest run src/shared/__tests__`：38 个文件、624 项（含词条覆盖）。
- `bridge-smoke.ts`：通过（exit 0）。
- `bridge-record.ts --check`（全部场景）：只有一处差异 `log.compact.json` 的 `$.events[28].data.maxTokens: 65536 -> 8192`，来自决策 177（看板已记为待重录），与本决策无关；本决策的直播事件与投影改动不改变任何已有场景的样本（已有场景都没有自动压缩，`/compact` 的摘要行不带 `liveMessageId`）。三个新场景用 `--update --only` 录制，`--check` 通过。
- 没有起 Electron、没有整包构建；模型请求只走本地假网关。

## 9 风险

1. **压力压缩的行在用户新消息上方**（§4.2）：符合「与重开一致」，但与「在当前回合里显示」的字面理解有出入。若用户更想看到它在新消息下方，需要把投影里这种「首批之前的检查点」挪到用户消息之后，直播与回放一起改。
2. **Stop 与失败的区分**：bridge 以「本回合已收到 Stop」判断打断，投影以「失败后没有再开始一步、回合以 aborted 结束」判断。压缩自己失败后、下一步开始前恰好按 Stop，直播显示「没有成功」、重开显示「没有完成」（措辞不同、位置相同）。
3. **新事件类型**：旧渲染层不显示（与现在一样），不会崩；第三方读事件流的工具会多见一种类型。
4. **压缩期间的其他发送入口**（失败卡「继续」、另一个窗口）：Main 当场答忙，有限重试后按「未被接收」处理；失败卡状态下输入框上方不显示原文（失败卡占着错误，`failureCardOwnsError`），用户再点一次即可。
5. **启动阶段仍是提示而不是排队**（决策 176），两段行为不同，见第 10 节待审批。
6. **录制样本依赖决策 177 的宿主策略**：新场景 `log.*.json` 里摘要 `maxTokens` 是 8192；177 的策略若再改，需要随 `compact` 一起重录。
7. **填充归一化**：录制器把连续两个以上 `zfill ` 换成 `<filler>`；别的场景若碰巧出现这个词会被一起归一（目前没有）。

## 10 Windows 现场清单（下一个测试包起）

1. **压力自动压缩**：长对话（或窗口较小的模型）里继续发消息，直到某一轮开始前自动压缩：上一轮回复下方、新消息上方出现转圈的「正在压缩上下文…」，完成后原地变成「上下文摘要」行（标题中文、可展开内容）；回复正常出现在新消息下方。
2. **重开一致**：压缩后关掉再打开这个对话：摘要行在同一位置、只有一行。
3. **超窗恢复**：用窗口很小的模型发一段很长的内容（或在接近上限时继续）：被拒那一步的回复上方出现「正在压缩上下文…」→ 摘要行，随后回复正常写出。
4. **超窗仍失败**：在一个连压缩后都放不下的对话里发送：先出现「自动压缩没有成功，请求仍然超出模型的上下文窗口。」，随后失败卡标题「对话已经超出模型的上下文窗口」，正文说请求已发出、引擎已尝试压缩；没有「继续」按钮。
5. **压缩中按 Stop**：「正在压缩上下文…」出现时按 Stop：该行变成「自动压缩没有完成，上下文没有压缩。」，不再转圈。
6. **手动压缩期间发消息**：输入 `/compact` 回车，状态行「正在压缩上下文…」时写一句话回车：消息进入排队条，输入框清空，不弹「发送失败」；压缩结束后这条消息自动发出，开始新一轮。
7. **手动压缩失败后**：用会失败的情形（例如很短的对话、或断网）重复第 6 条：失败提示照旧，排队的消息随后照常发出。
8. **启动阶段**：重启应用后打开老对话直接 `/compact`，在「正在启动对话…」时发消息：仍是「等对话启动后再发送」，文字留在输入框（决策 176 不变）。
9. **会话分支对话框**：有自动压缩失败备注的对话，打开「会话分支」：备注那一行显示中文。
10. 中文界面下所有新句子完整不截断；暗色主题下转圈与灰字可读。

## 11 用户审批

- [x] 第 1 节（用户 2026-10-11 的要求）
- [ ] 3.1 新事件类型 `session.compaction`（不复用 `custom.message`）、只翻译回合自己的压缩、一次压缩一行、按是否处在一步之中判定触发方式
- [ ] 3.2 / 3.3 检查点出现即完成；失败原因只进日志；投影的备注行与「没有完成」的补行规则
- [ ] 4.1 三种行的样式与三句文案（失败分压力 / 超窗、另有「没有完成」）
- [ ] 4.2 压力压缩的行在用户新消息上方（与重开一致）
- [ ] 4.4 回合结束时把仍在转的行改成「没有完成」
- [ ] 第 5 节手动压缩期间发消息改为排队、Ctrl+Enter 同样排队、Main 压缩在途时答 `session_busy`；启动阶段是否也改为排队（目前维持决策 176）
- [ ] 第 6 节超窗失败卡文案与仍不提供「继续」
- [ ] 第 7 节假网关脚本与三个录制场景
- [ ] 第 9 节风险的接受程度
- [ ] 第 10 节 Windows 现场清单

## 用户审批补记（2026-10-11）

- 每一轮开头的压力压缩，那一行显示在用户刚发的消息上方（与重开对话一致）：**用户接受**。
- 「正在启动对话…」阶段发消息仍为提示、文字留在输入框（与压缩阶段的排队不一致）：用户暂未要求统一，维持现状。
