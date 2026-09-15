# 批次 D 补审：渲染层事件词汇表与状态机全量比对

- **区域**：chat-event-vocab（渲染层事件词汇表与状态机全量比对）
- **任务**：T029（批评者缺口 8 的事件半边，cross-and-critic.md 第 71 行）
- **节点判定对象**：P4-5、P3-4 渲染半边、F5、F7a/F7c 代码侧
- **基线**：HEAD `ebc82f16`（批次 A / B / C 与 T036 全部落地后）
- **日期**：2026-09-15
- **方式**：只读通读源码与 golden 录制，未构建、未跑测试、未起 Electron

---

## 总评

事件词汇表这一面的状况比审计当时好很多，批评者缺口 8 点名的那条具体回归（主时间线工具动词表不认 native 的小写工具名）确实已修（T020）：`RUNTIME_TOOL_NAMES` 现在逐字对上了 runtime 侧真正注册的九个工具名与 `mcp__` 前缀，逐个查表点我都核过一遍，没有残留。T005（内部标记消息不画用户气泡）在**实时与回放两条路上都成立**——`projector.ts:275` 与 `piSessionTimeline.ts:265` 各有一道同源守卫，这是本轮少数两条路口径一致的地方。T017 的重试横幅、T020 的子代理花费与面板、T034 的 recovery rider、T024 的容量限额，生产者侧都真的接上了。

但「每种事件都有消费者、消费都正确」这句话还不成立，我找到三类问题：

第一类是**某一端凭空缺一半**。最干净的例子是 `tool.updated`：整个 native runtime 没有任何一个工具调用过 pi 给的第四个参数 `update`，所以 `tool_execution_update` 永不触发，T017 给这条事件补的 `input` 字段、渲染层的三个消费者（时间线改写工具参数、Run 面板的工具进度行、回合存活判定）全部是死的。反方向的例子是权限审计行：runtime 把 `delegationId` / `agentName` 发出来了，渲染层把它们原样存进 block，然后一个字都不画——真正会画「代子 Agent 请求」的那个分支读的是 `forwarded` / `requesterAgentName`，而这两个字段自旧引擎退役后再没有生产者。

第二类是**状态机没有回程**。渲染层自己把会话状态推成 `waiting_permission` / `waiting_question`，而生产者从来不发一条「批准完了，继续跑」的 `session.status: running`，也没有任何地方在 `permission.resolved` / `question.resolved` 时把状态推回去。结果是 Run 面板从用户点「允许」那一刻起，整个回合剩下的时间都挂着「Waiting for approval」和 attention 色。

第三类是**单槽位装了可以并发的东西**。权限请求在 store 里是一条队列（`pendingPermissions` 数组 + 每会话取队首），问答却是一个全局单槽 `pendingQuestion`；而 `ask` 工具明确不设超时，pi 的工具执行默认并行。第二个问题一到，第一个问题就既不可见（时间线对 pending 的问答卡直接 `return null`）也不可答（唯一的作答位是 dock），它的 promise 永不结算，那一整个回合挂到用户按 Stop 为止。

还有一条数据面的：子代理花费的那次 `usage.updated`（决策 005）没有带上下文占用字段，而渲染层是整体替换而非逐字段合并，所以只要这条事件是本轮最后一条（Stop / 失败 / 后台委派收尾），输入框上方的上下文百分比徽标就直接消失。

## 优点

1. **工具词汇表已全量对齐**。`piToolNames.ts` 把「pi SDK 自带集」与「本仓 runtime 注册集」分成两张表并写清了为什么不能互读，`TOOL_VERBS` 覆盖 read/write/edit/bash/glob/grep/browser_preview/ask/skill/new_context/Task*，`mcp__` 走前缀兜底。批评者当时点名的漂移不存在了。Claude 期的大写名（`Read`/`WebSearch`/`TodoWrite` …）**不是**死代码——P5-4 导入的旧会话回放时正是这些名字，保留正确。
2. **内部标记消息两条路一致**。实时由 projector 跳过，回放由 `piSessionTimeline` 跳过，注释还互相点名。这是 T005 做得最扎实的一处。
3. **子代理活动 reducer 的乱序与幂等处理是本区域质量最高的代码**。`tool.completed` 找不到对应 started 时补一条已结算行而不是丢弃、terminal 不被迟到的 `running` 复活、`failed/cancelled/stopped/truncated` 不被泛化的 `completed` 覆盖、`text/thinking` 按 id 去重、lane 与 row 各有环形上限且溢出计数外露（`droppedRows`）。`capped` 分支也接上了 T020 的生产者。
4. **权限卡的倒计时与自动拒绝是闭环的**。`timeoutMs` → `permissionExpiresAt` → 每秒 tick → 归零时发一次 `deny`，与引擎自己的 abort 是同一个答案，谁先到都不矛盾（F7a/F7c 的倒计时半边成立）。
5. **`permission.activity` 的两相合并写得对**。prompt 开行、decision 填行，同 `requestId` 只有一行，合并时空值不覆盖旧值，且无变化时返回同一个引用，不会白白重建消息。
6. **批处理不丢不乱序**。`initRuntime` 的 16ms 队列按到达顺序整批折叠，卸载时 drain 而不是丢弃，`applyRuntimeEvents` 让批内后一条看得见前一条的效果。

## 弱点

1. `tool.updated` 在 native 下彻底没有生产者，连带三个消费者与 T017 的修复一起失效（chat-event-04）。
2. 委派归属只发不画：`permission.activity` 的 `delegationId`/`agentName` 无渲染，能画的分支无生产者（chat-event-05、-06）。
3. `waiting_*` 状态没有回程，Run 面板停在「等待审批」（chat-event-02）。
4. 问答只有一个全局槽位，第二问丢失且回合卡住（chat-event-01）。
5. 子代理花费那条 `usage.updated` 丢 `context`，整体替换后上下文徽标消失（chat-event-03）。
6. 审批行的 resolution 枚举中文词条只配了两个，其余（含最常见的 `session_grant`）直出英文/下划线形态；`gate_error` 分支还绕过了 humanize（chat-event-07）。
7. `host.ready` / `host.error` 全仓零生产者，诊断横幅的 error / starting 两臂与 Node 24 提示不可达（chat-event-08）；`session.status.liveness` 同样零生产者（chat-event-09）；`subagent.activity` 的 `kind:'progress'` 同样（chat-event-10）。
8. `seq` 没有任何消费者，且 Main 在槽位未 ready 时丢事件、丢完之后才重新编号，丢失在协议上不可检测（chat-event-11）。
9. 回放丢三类 block：已决权限卡行、权限审计行、已答问答卡（chat-event-12）。
10. golden 录制到目前为止一条 `tool.updated`、`session.failed`、`session.stopped`、`session.stderr`、`custom.*`、`preview.requested` 都没有录到。

## 事件 × 消费者比对表

生产者列只记 native 现役生产者（runtime + Main），不含旧引擎。

| 事件 / 字段 | 生产者 | 消费者 | 结论 |
|---|---|---|---|
| `host.ready` | **无** | `hostStatus.reduceHostStatus` | 死（chat-event-08） |
| `host.error` | **无**（`chat.ts:204` 自己写明） | `ChatComposer` 致命错误分支、`hostStatus` | 死，但已在 `sendDispatchError.ts` 文档化 |
| `session.created` / `resumed` | WorkerManager | chatSessions、permissionGate、useSessionCapabilities、subagent lane 清扫 | 正常 |
| `session.updated` | WorkerManager | chatSessions（runtimeIdentity） | 正常 |
| `session.history`（含 `subagents`） | WorkerManager | chatSessions 合并、subagentActivityModel 重建 lane | 正常，但只还原四类 block（chat-event-12） |
| `session.status.status` | projector.start/finish、WorkerManager | chatSessions、sessionActivity、runPanelModel、queueRelease、composer | `waiting_*` 无回程（chat-event-02） |
| `session.status.retry` | agent-loop `onRetry` | retryBanner、sessionActivity、contextSurface、composer | 正常（T017） |
| `session.status.recovery` | projector.recovery（T034） | chatSessions 存进 `ChatSession.recovery` | **无 UI 消费者**——T034 落地记录明写「无 UI 组件」，属已取舍，未立发现 |
| `session.status.liveness` | **无** | `ChatComposer` 诊断格式化 | 死（chat-event-09） |
| `session.status.disconnectReason` | WorkerManager `evictForCapacity` | useCapacityReclaimNotice、chatSessions 解绑 | 正常 |
| `session.stderr` | WorkerManager（T017 接的） | contextSurfaceModel stderr 环 | 正常，但无 golden 录制 |
| `message.started/delta/completed` | projector | chatSessions、messageMetadata、assistantProgress | 正常；`role:'error'` 无生产者 |
| `message.started.model` | projector | messageMetadata（store 故意不存） | 正常 |
| `thinking.*` | projector | chatSessions、thinkingCard | 正常 |
| `tool.started` | projector | chatSessions、sessionActivity、runPanelModel | 正常 |
| `tool.updated`（`input`/`status`） | **无** | chatSessions 改写参数、contextSurface `activeToolStatus`、Run 面板进度行、liveness | 死（chat-event-04） |
| `tool.completed` | projector | chatSessions、toolCard、Run 面板计数 | 正常 |
| `custom.message` | projector（role=custom） | chatSessions（system 行） | 有生产者，无录制 |
| `custom.entry` | SessionPlugin.appendEntry（非内部 customType） | 同上 | 有生产者，无录制 |
| `permission.requested`（含 `agentId`/`agentName`/`timeoutMs`/`decisions`/`detail`/`action`） | permissionPrompt | chatSessions 建卡 + 队列、subagentActivityModel 建 origin 索引、questionCardModel | 正常；但 store 未拷贝 `agentId`/`agentName` 到 block，卡片的「来自子代理」完全依赖相邻 store 的索引 |
| `permission.resolved`（含 `decision`/`autoReason`） | permissionPrompt | chatSessions 冻结卡、subagent lane 清 pending | 正常；`autoReason` 原样当文案（chat-event-07） |
| `permission.activity.phase/requestId/surface/value` | permissions/activity.ts | permissionActivityRow | 正常 |
| `permission.activity.delegationId/agentName` | permissions/activity.ts（T005） | **仅声明，未渲染** | chat-event-05 |
| `permission.activity.toolSurface/origin/matchedPattern/forwarded/requesterAgentName` | **无** | permissionActivityRow 有分支 | 死（chat-event-06） |
| `question.requested` | questionPrompt（F5） | chatSessions 单槽 + PendingQuestionDock | 单槽（chat-event-01） |
| `question.resolved` | questionPrompt | chatSessions 冻结卡、清 dock | 正常 |
| `question.requested.autoResolutionMs` | **无**（ask 明确不设超时） | 无 | 一致，无需处理 |
| `preview.requested` | browserPreview 工具 | Main `servePreview`（不经渲染层） | 正常；未进 liveness 词表 |
| `usage.updated`（turn_end 路） | projector.observe | messageMetadata、contextSurfaceModel、Run 面板、ComposerUsageChip | 正常 |
| `usage.updated`（delegated 路，决策 005） | projector.delegated | 同上 | 丢 `context`（chat-event-03） |
| `subagent.activity` started/text/thinking/tool.*/status/report/capped | subagent/records.ts | subagentActivityModel | 正常 |
| `subagent.activity` `kind:'progress'` | **无** | subagentActivityModel 有分支 | 死（chat-event-10） |
| `session.completed/failed/stopped` | projector.finish | chatSessions、subagent lane 清扫、assistantProgress | 正常；后两类无录制 |
| `seq` | Main `dispatch` 重新编号 | **无** | chat-event-11 |
| trace 的 `trace_rotate_failed`（T024） | trace.ts:222 | 只进 trace 文件与 dispose 抛错 | 不在 GUI 事件词汇表内，见「未经执行验证的声明」 |

---

## 发现

### [chat-event-01] medium correctness | F5 | src/renderer/stores/chatSessions.ts:1266 | 问答卡只有一个全局槽位，第二个问答会把第一个挤掉，并让那一回合永久挂起

DESC: `question.requested` 无条件把 `pendingQuestion` 覆盖成本次的 `{sessionId, questionId, messageId}`，而这是整个 store 里唯一一个问答槽（对照：权限请求用的是 `pendingPermissions` 数组 + 每会话取队首）。唯一的可作答界面 `PendingQuestionDock` 只认这个槽，时间线对未决问答卡直接 `return null`，`respondQuestion` 也只会把答案发给槽里那一个 `questionId`。生产者侧 `questionPrompt.ts` 的 `pending` 是一个 Map，明确支持并发多问，并且**刻意不设超时**（模块注释第 9-12 行写明理由）。两边一合，被挤掉的那个问答既不显示也不可答，它在 worker 里的 promise 永不结算，`ask` 工具所在的那一轮工具执行就一直卡着。

EVIDENCE:
```ts
// src/renderer/stores/chatSessions.ts:1264-1272
      return {
        messages: withBucket(state, sessionId, upsertMessage(bucket, updated)),
        pendingQuestion: {
          sessionId,
          questionId,
          messageId,
        },
        sessions: upsertSessionStatus(state.sessions, sessionId, 'waiting_question'),
      };
```
```tsx
// src/renderer/components/chat/MessageTimeline.tsx:2018-2020
      const state = deriveQuestionCardState(item.block);
      if (state === 'pending') return null;
      return <QuestionCard variant="frozen" block={item.block} />;
```
```ts
// src/runtime/worker/questionPrompt.ts:9-12
 * - **No timeout.** A permission gate needs one because a forgotten dialog
 *   blocks a tool call the user may not even know is waiting. A question is on
 *   screen, in the session the user is looking at, and an auto-answer would put
 *   a decision in their mouth. The turn's own abort still settles it.
```

SCENARIO: 会话 A 正在跑，模型调 `ask`，卡片出现在 dock。用户不答，切到会话 B 发一条消息（worker 池默认容量 ≥3，见 `WorkerManager.ts:322-326`，B 能并行跑），B 的模型也调了 `ask`。第二条 `question.requested` 把 `pendingQuestion` 覆盖成 B 的。此时切回 A：dock 因 `pendingQuestion.sessionId !== A` 不渲染，时间线因 `state === 'pending'` 返回 null，A 的界面上一张卡都没有，状态停在 `waiting_question`，输入框被判为 busy。A 那一轮再也不会结束，只能按 Stop。
同一会话内也可达但需要模型配合：pi 的工具执行默认并行（`pi-agent-core/dist/agent-loop.js:286-291`，只有声明 `executionMode: 'sequential'` 的工具才串行，而 `askTool` 没有声明），所以一条 assistant 消息里出现两个 `ask` 调用时，两个 `question.requested` 会先后到达，后者挤掉前者。

FIX: 把 `pendingQuestion` 改成与 `pendingPermissions` 同形的队列（每会话取队首可答，其余画成 waiting），或者退一步：`question.requested` 命中已有未决问答时不覆盖，而是排队，并在 `question.resolved` 出队。两者都要同时给 `MessageTimeline` 的 `question` 分支一个「本会话队首之外的未决问答」呈现方式，否则被排队的那张卡仍然不可见。另可考虑给 `ask` 加一个足够长的兜底超时（结算为 `cancelled`，工具已经把 cancelled 当正常结果处理），这样即便界面侧漏掉也不会永久挂住回合。

---

### [chat-event-02] medium correctness | P3-4 渲染半边 | src/renderer/stores/chatSessions.ts:1174 | `waiting_permission` / `waiting_question` 没有回程，Run 面板从用户点「允许」起就一直显示「等待审批」

DESC: 这两个状态不是生产者发的，是渲染层自己在 `permission.requested` / `question.requested` 时用 `upsertSessionStatus` 推上去的。但 `permission.resolved` / `question.resolved` 两个分支都没有把状态推回 `running`，生产者侧也不会在闸门放行后补一条 `session.status: running`——projector 只在 `start()`、`retry()`、`recovery()`、`recovered()`、`finish()` 五处发状态（`projector.ts:162-168/427-470/542-546`），WorkerManager 侧的九处 `session.status` 全是 `idle` / `disconnected` / 一次 `running`（`WorkerManager.ts:697`，只在重复 create 时回报现状）。于是从审批被回答到回合结束为止，会话行的 `status` 一直是 `waiting_permission`。`runPanelModel` 的活动细化（「Running a tool」/「Thinking」）只在 `status === 'running'` 时才计算，所以 Run 面板整段时间显示「Waiting for approval」+ attention 色，即使工具早就跑完、正文早就在流式输出。

EVIDENCE:
```ts
// src/renderer/stores/chatSessions.ts:1170-1176（permission.requested 出口）
        pendingPermissions: queueAlreadyHasEntry ? state.pendingPermissions : [...],
        sessions: upsertSessionStatus(state.sessions, sessionId, 'waiting_permission'),
      };
    }

    case 'permission.resolved': {
      const { permissionId, allow, decision, autoReason } = event.payload;
```
```ts
// src/renderer/components/workspace-shell/surfaces/runPanelModel.ts:266-276
  const activity: RunActivity =
    status === 'running'
      ? tools.activeTool
        ? 'tool'
        : isThinking(input.messages)
          ? 'thinking'
          : null
      : null;

  const presentation = status ? STATUS_PRESENTATION[status] : null;
```
`permission.resolved` 分支（:1178-1226）返回的只有 `messages` 与 `cleared`（`withoutPermission`，:474-484 只动 `pendingPermissions`），没有任何 `sessions` 补丁。

SCENARIO: 一次普通的写文件回合。模型调 `write` → 弹审批卡 → 会话状态 `waiting_permission` → 用户点「允许」→ `permission.resolved` 到达，卡片冻结、队列清空，但状态仍是 `waiting_permission`。接下来工具执行、模型继续输出、可能还有好几个工具轮次，Run 面板全程写着「Waiting for approval」，直到 `finish()` 发出 `idle`。输入框上方的 `SessionActivityStatus` 不受影响（它读的是 `session.activity`，`tool.started` 会把 phase 推到 `tool`），所以同一屏上两处状态互相矛盾。

FIX: 在 `permission.resolved` / `question.resolved` 分支里，若该会话当前状态是对应的 `waiting_*`，就推回 `running`（注意别覆盖同一轮里紧接着到来的第二张审批卡——可以先检查 `pendingPermissions` 是否已清空再推）。或者由生产者补一条：`permissionPrompt.settle` / `questionPrompt.settle` 结算后经 projector 发一条 `session.status: running`，与 `recovered()` 同形。前者改动更小且不加协议面。

---

### [chat-event-03] medium correctness | P4-5 | src/runtime/events/projector.ts:520 | 子代理花费那条 `usage.updated` 不带 `context`，而渲染层整体替换，导致上下文占用徽标消失

DESC: 决策 005 让 projector 在委派结算时补发一条 `usage.updated`，重述上一条已结算回合的账并更新 `session` / `delegated` 两块。但这条补发调用 `buildPiUsagePayload` 时第二个参数（上下文占用）传的是 `undefined`，而 `buildPiUsagePayload` 是「给了才带」（`piUsage.ts:237` `...(context ? { context } : {})`），所以这条 payload 没有 `context` 键。消费侧 `foldSettledUsage` 是**整体替换**这个会话的 `usage`，不是逐字段合并。于是这条事件一落地，`facts.usage.context` 就没了：输入框上方的上下文百分比徽标直接 `return null` 消失，Run 面板的占用条也退回「只知道窗口大小、不知道占了多少」。

EVIDENCE:
```ts
// src/runtime/events/projector.ts:519-526
    if (this.lastTurnUsage === undefined) return;
    const payload = buildPiUsagePayload(
      this.lastTurnUsage,
      undefined,
      viewTurnRollup(this.rollup),
      this.delegatedUsage
    );
    if (payload) this.emit({ type: 'usage.updated', sessionId: this.sink.sessionId, payload });
```
```ts
// src/renderer/components/workspace-shell/surfaces/contextSurfaceModel.ts:576-585
function foldSettledUsage(...): SessionRuntimeFactsState {
  const sessionId = event.sessionId;
  if (!sessionId) return prev;
  const usage = readPiUsagePayload(event.payload);
  if (!usage) return prev;
  return { ...prev, [sessionId]: { ...prev[sessionId], usage } };
}
```
```tsx
// src/renderer/components/chat/ComposerUsageChip.tsx:111-112
  const occupancy = deriveContextOccupancy(usage?.context);
  if (!usage || !occupancy) return null;
```
现成的证据在 golden 录制里：`src/shared/__tests__/fixtures/nativeGuiSubagentEventStream.json` 第 21 条（数组下标 20）的 `usage.updated` 键集是 `["input","output","cacheRead","cacheWrite","totalTokens","costUsd","session","delegated"]`——没有 `context`，而它前后两条都有。

SCENARIO: 两种形态。
（1）**永久形态**：一次带委派的回合被用户 Stop，或以失败告终。`agent-loop/index.ts:573-578` 的 `collectFinished` 循环条件是 `!request.signal?.aborted`，被中止时整段不进；随后 `:636` 的收尾 `foldDelegatedUsage()` 把已结算委派的花费取出来并发出这条无 `context` 的 `usage.updated`，紧接着就是 `projected.finish(...)`。它因此是本轮**最后一条** `usage.updated`，上下文徽标从此消失，直到下一轮 `turn_end` 再发一条带 `context` 的为止。后台委派（`run_in_background`）在父回合 `turn_end` 之后才结算时同理。
（2）**闪烁形态**：正常同步委派时，`:577` 的 per-pass fold 先发一条无 `context` 的，父代理拿到报告再跑一整轮才发下一条带 `context` 的——这中间是一整个模型回合的时间，徽标在这段时间里是消失的。

FIX: 两处任选其一，建议都做。生产者侧：projector 记住最后一次算出的上下文占用块（与 `lastTurnUsage` 并排存），`delegated()` 重述时一并带上——它本来就是「重述而非重新计费」，上下文占用同属该回合的事实。消费者侧：`foldSettledUsage` 对 `context` 做「新值缺失则沿用旧值」的逐字段保留，理由和 `mergePermissionActivity`、`mergeUsage` 写过的完全一样（后到的事件不该抹掉它没说的字段）。

---

### [chat-event-04] low dead-code | P4-5 | src/runtime/plugins/tools/index.ts:139 | `tool.updated` 在 native 下没有任何生产者，T017 给它补的 `input` 与三个渲染层消费者一起失效

DESC: pi 的 `AgentTool.execute` 第四个参数 `update` 是工具汇报中间进度的唯一入口，`pi-agent-core/dist/agent-loop.js:455-463` 只在这个回调里发 `tool_execution_update`。本仓 runtime 的工具包装层把 `update` 原样透传下去（`tools/index.ts:125/139`），但**全部**具体工具的 `execute` 都只声明三个参数、从不调用它：read/write/edit/bash/glob/grep（`tools/index.ts:297/337/379/443/502/567`）、`ask`、`browser_preview`、`skill`、`new_context`、MCP 桥、四个 `Task*`。子代理的权限作用域包装（`subagent/index.ts:1135-1139`）只是把 `onUpdate` 再透传一层，自己也不调。结论：`tool_execution_update` 永不触发 → projector 的 `case 'tool_execution_update'`（`projector.ts:343-367`）永不执行 → `tool.updated` 这个事件在 native 后端上根本不存在。于是渲染层三处消费全是死的：chatSessions 的「按 `input` 改写工具行参数」（:989-1005）、`contextSurfaceModel.foldActiveToolStatus`（:456）与它喂的 Run 面板工具进度行（`runPanelModel.ts:247-250`，`RunToolFacts.activeToolStatus` 恒为 null）、以及 `TURN_LIVENESS_EVENT_TYPES` 里的这一项。T017 落地记录里的「`tool.updated` 带 input」因此是一次不可达路径上的修复。

EVIDENCE:
```ts
// src/runtime/plugins/tools/index.ts:125-139（唯一持有 update 的地方，只透传）
      execute: async (id, params, signal, update) => {
        ...
        return tool.execute(id, params as Static<T>, signal, update);
      },
```
```
$ grep -rn "execute: async (\|execute: (" src/runtime/plugins src/runtime/worker --include=*.ts | grep -v __tests__
（共 17 处；除 tools/index.ts:125 与 subagent/index.ts:1135 这两个透传包装外，全部只声明 (id, args, signal) 或更少）
```
```ts
// src/renderer/components/workspace-shell/surfaces/runPanelModel.ts:76-79
  /**
   * T38-c: that tool's own latest progress line, `null` when it published none.
   * Reported by the runtime, never derived from the tool's output body.
   */
  activeToolStatus: string | null;
```
五份 golden 录制里 `tool.updated` 出现 0 次，与此一致。

SCENARIO: 用户让模型跑一条耗时几分钟的 `bash`（构建、全量测试）。Run 面板的工具行只显示工具名，永远不会出现那条「工具自己报的最新一行」；时间线上的参数也不会中途修正。界面没有报错，只是这条被文档描述过的能力从来不出现——这正是审计里说的「失败模式是沉默」。

FIX: 先决定要不要这条能力。要的话，最小落点是 `bash`：`runtimeExec.run` 已经在收流，按行节流调用 `update({content:[{type:'text',text:lastLine}]})` 即可，projector 那半边是现成的。不要的话，把 `ToolUpdatedEvent` 连同三处消费者一并退役（与 T036 退 extensionUi 同一口径），并把 `RunToolFacts.activeToolStatus` 的注释改成实况，别让下一个人以为它只是暂时没数据。无论选哪条，都应在 golden 录制里留一份阳性或阴性对照。

---

### [chat-event-05] medium contract-gap | P3-4 渲染半边 | src/renderer/components/chat/permissionActivityRow.ts:141 | 子代理审批行的归属信息只发不画：能画它的分支读的是两个没有生产者的字段

DESC: T005 让权限闸门在 `permission.activity` 上带出 `delegationId` 与 `agentName`，事件类型的注释也写明这是「这次闸门是为谁抬起的」。渲染层把 payload 整体存进 block（`chatSessions.ts:1073` `const incoming: PermissionActivityRecord = { ...event.payload };`），`PermissionActivityRecord` 也把这两个字段声明了出来（:52-53）——然后 `derivePermissionActivityRow` 从头到尾没有读过它们。真正会在行尾写「代子 Agent {{name}} 请求」的分支（:115-120）读的是 `record.forwarded` 与 `record.requesterAgentName`，而这两个字段在 native 下没有任何生产者（`permissions/activity.ts:55-69` 的构造里没有它们，全仓也没有别的 `permission.activity` 生产者）。净结果：子代理触发的闸门和主代理自己的闸门，在时间线审计行上完全无法区分。

EVIDENCE:
```ts
// src/runtime/plugins/permissions/activity.ts:62-68（生产者确实发了）
      ...(detail ? { value: detail } : {}),
      ...(delegation
        ? { delegationId: delegation.delegationId, agentName: delegation.agentName }
        : {}),
```
```ts
// src/renderer/components/chat/permissionActivityRow.ts:113-120, 141-148（消费者只认另一对字段）
  const notes: string[] = [];

  if (record.forwarded) {
    const requester = record.requesterAgentName?.trim();
    notes.push(requester ? t('for subagent {{name}}', { name: requester }) : t('for a subagent'));
  }
  ...
  const byUser = record.resolution ? USER_RESOLUTIONS.has(record.resolution) : false;
  const tone: PermissionActivityTone = ...;
  if (record.resolution && !byUser) notes.push(humanizeResolution(record.resolution, t));
  if (record.matchedPattern) notes.push(t('matched {{pattern}}', { pattern: record.matchedPattern }));
  if (record.origin) notes.push(t('from {{origin}}', { origin: record.origin }));
```
T004+T005 的 roadmap Done 行自己写了「权限活动的委派归属展示留 UI 批次」——UI 批次（T026）改的是插件页与侧栏，没有碰这里。

SCENARIO: 一个 `explorer` 子代理被委派去读代码，它的 `read` 撞上 deny 规则。父会话时间线上出现一行红色「Denied read · /path/x」，挂在父代理那条 assistant 消息下面（`permission.activity` 分支固定挑最近一条非历史 assistant 消息）。用户看到的是「我自己这一轮被拒了一次读」，而实际上是某个子代理被拒。`delegationId`/`agentName` 就在这条 block 的数据里，只是没人画。

FIX: 在 `derivePermissionActivityRow` 里把 `record.agentName`（回退到 `record.delegationId`）接进已有的 `notes` 逻辑，复用现成的 `'for subagent {{name}}'` / `'for a subagent'` 两个词条（中文词条 `i18n.ts:2524-2525` 已存在）；`forwarded` 那条分支可以并进同一段，或按 chat-event-06 一起退役。同时建议把 `permission.requested` 的 `agentId`/`agentName` 也拷进 block，让权限卡的「来自子代理」不必完全依赖相邻 store 的索引。

---

### [chat-event-06] low dead-code | P3-4 渲染半边 | src/shared/types/runtimeEvents.ts:974 | `permission.activity` 有五个字段自旧引擎退役后再无生产者，渲染层为它们保留了三段分支

DESC: `PermissionActivityEvent.payload` 声明了 `toolSurface`、`origin`、`matchedPattern`、`forwarded`、`requesterAgentName` 五个可选字段，它们来自 `@gotgenes/pi-permission-system` 的广播。P6-5 退役旧引擎、决策 012 退役 extensionUi 之后，唯一的生产者 `permissions/activity.ts` 一个都不发。渲染层为其中四个保留了输出分支（`forwarded`→两个词条、`matchedPattern`→`matched {{pattern}}`、`origin`→`from {{origin}}`），`toolSurface` 则连声明都没同步过去。i18n 字典里 `'matched {{pattern}}'` / `'from {{origin}}'` / `'for a subagent'` / `'for subagent {{name}}'` 四个中文词条也随之成为死条目。

EVIDENCE:
```ts
// src/shared/types/runtimeEvents.ts:970-978
    /** Actual gate surface, e.g. `path` or `external_directory`. */
    surface?: string;
    /** Prompt display/tool surface when it differs from the actual gate. */
    toolSurface?: string;
```
```ts
// src/runtime/plugins/permissions/activity.ts:55-69（全仓唯一生产者，只发 7 个键）
  return {
    type: 'permission.activity',
    sessionId,
    payload: {
      phase: record.phase,
      requestId: request.toolCallId,
      surface: request.tool,
      ...(detail ? { value: detail } : {}),
      ...(delegation ? { delegationId: ..., agentName: ... } : {}),
      ...(record.phase === 'decision' ? { result: ..., resolution: ... } : {}),
    },
  };
```
另外 `PermissionActivityRows.tsx:16-20` 的模块注释仍写「the plugin asks its question through the Extension UI modal」，`permissionActivityRow.ts:18-29` 仍称这些值是「第三方插件广播的数据」——两处在 T036 之后都不再成立。

SCENARIO: 不会咬人，是退役清扫的尾巴。代价在阅读：下一个人按注释以为这些字段还有来源，就会继续维护三段永不执行的分支和四个永不命中的词条；`origin` 尤其容易被误认为「规则来自哪个配置层」这件事已经在画了——实际上自有权限内核知道 scope，只是没往事件上放。

FIX: 二选一并写进 decision。（a）退役：删掉五个字段、三段分支与四个词条，同时把两处注释改成实况；（b）接线：`origin` 与 `matchedPattern` 由自有权限内核补发（它在判定时确实知道命中的 scope 与规则），`forwarded`/`requesterAgentName` 与 chat-event-05 合并为「委派归属」一条路，`toolSurface` 删除。若选 (b)，可顺带解掉 chat-event-05。

---

### [chat-event-07] low i18n | P3-4 渲染半边 | src/renderer/components/chat/permissionActivityRow.ts:122 | 审批行的 resolution 与 `autoReason` 直出原始枚举：中文界面上最常见的两种自动放行显示为英文/下划线形态，`gate error` 词条是死的

DESC: 三处都把机器枚举当文案用。（1）`gate_error` 分支提前返回，`note` 直接给 `record.resolution` 原文，绕过了 `humanizeResolution`，界面上出现的是 `gate_error` 这个带下划线的原串，而字典里专门配的 `'gate error': '闸门出错'` 因此永不命中。（2）非用户决定的其余 resolution 走 `humanizeResolution`（把下划线换空格后当词条键），但字典只配了 `'policy allow'` 与 `'gate error'` 两条；自有闸门实际会产出的 `session_grant`、`policy_deny`、`timed_out`、`cancelled` 四种全部没有中文词条，中文界面直接显示 `session grant` / `policy deny` / `timed out` / `cancelled`。其中 `session_grant` 是「用户之前选过本会话内允许」的常规路径，出现频率很高。（3）权限卡与工具行尾的 `auto: {{reason}}` 把 `autoReason` 原样插值，于是中文界面显示「自动：timed_out」「自动：session_closed」。

EVIDENCE:
```ts
// src/renderer/components/chat/permissionActivityRow.ts:122-129
  if (record.resolution?.includes('error')) {
    return {
      requestId: record.requestId,
      tone: 'denied',
      label: t('Permission check failed — {{surface}}', { surface }),
      detail: record.value,
      note: record.resolution,      // ← 原串，未 humanize、未翻译
    };
  }
```
```ts
// src/runtime/plugins/permissions/activity.ts:27-39（实际会产出的九种 resolution）
const RESOLUTION: Record<PermissionDecisionSource, string> = {
  policy: 'policy_allow',
  'session-grant': 'session_grant',
  'allow-once': 'user_approved',
  'allow-session': 'user_approved',
  'policy-deny': 'policy_deny',
  'user-denied': 'user_denied',
  'timed-out': 'timed_out',
  cancelled: 'cancelled',
  error: 'gate_error',
};
```
```
$ grep -n "'session grant'\|'policy deny'\|'timed out'\|'cancelled'" src/shared/i18n.ts
（无输出；同文件 2534-2535 行只有 'policy allow' 与 'gate error'）
```

SCENARIO: 中文界面用户对某次 `bash` 选了「本会话内允许」。之后同一会话里每一次 `bash` 都由 session-grant 自动放行，展开「Approval details」看到的是「已允许 bash · session grant」——半中半英。若某次闸门自身出错，看到的是「权限检查失败 —— bash · gate_error」。

FIX: 把四个缺失的键补进 `zhTranslations`（`'session grant'`、`'policy deny'`、`'timed out'`、`'cancelled'`），并让 `gate_error` 分支也走 `humanizeResolution`。`autoReason` 同理：给四个值（`unsupported`/`session_closed`/`aborted`/`timed_out`）配一张小映射表再进 `t()`，与 `PERMISSION_ACTION_LABELS` 的做法一致（T023 已经为权限卡建立了「runtime 发 id、渲染层查词典」的先例，这里是同一类漏网）。

---

### [chat-event-08] low dead-code | P4-5 | src/renderer/components/chat/hostStatus.ts:140 | `host.ready` / `host.error` 全仓零生产者，诊断横幅的 error / starting 两臂与 Node 24 指引不可达

DESC: `RuntimeEventType` 的头两个成员 `host.ready` / `host.error` 在 src/ 下没有任何 dispatch 点（`chat.ts:204` 的注释已经为 `host.error` 记过一笔，`sendDispatchError.ts:4-8` 也写了「grep confirms the type exists and nothing dispatches it」，但 `host.ready` 没人记）。`HostStatus.state` 的注释说「`starting` 和 `error` 只会来自 Runtime Event」——既然事件没有生产者，这两个状态就只能来自 `primeHostStatus` 透传的 Main 快照，而 `WorkerManager` 的状态机只产出 `stopped` / `ready` / `degraded`（`updateManagerState()`，:2765-2775；`getStatus()`，:455-475）。于是 `describeHostStatus` 的 `'error'` 与 `'starting'` 两臂、`isNode24ResolutionFailure`、以及横幅上那颗 Retry 按钮的 error 形态全部不可达；`useHostStatus.ts:64-65` 注释里的「a recovered Host reappears via host.ready」也已不成立。

EVIDENCE:
```ts
// src/main/services/agent-host/WorkerManager.ts:2765-2775（状态只有三种）
  private updateManagerState(): void {
    const entries = [...this.entriesBySession.values()];
    if (entries.some((entry) => entry.state === 'error' || entry.state === 'crashed')) {
      this.state = 'degraded';
    } else if (entries.length > 0) {
      this.state = 'ready';
    } else if (this.state === 'degraded') {
      this.state = 'ready';
    }
  }
```
```ts
// src/renderer/components/chat/hostStatus.ts:92-102
export function describeHostStatus(status: HostStatus): HostStatusBannerModel | null {
  switch (status.state) {
    case 'error':
      return { tone: 'error', title: status.lastFatalError ?? 'Pi session service failed', ... };
```
```
$ grep -rn "'host.ready'" src --include=*.ts --include=*.tsx | grep -v __tests__
src/shared/types/runtimeEvents.ts:16  |  src/shared/types/runtimeEvents.ts:70  |  src/renderer/components/chat/hostStatus.ts:140
（三处全是类型声明与消费者，零生产者）
```

SCENARIO: Node 24 解析失败时 `ensureHost()` 的 invoke 直接 reject，`useHostStatus` 的 `.catch(() => undefined)` 吞掉它，状态停在 `'unknown'`，横幅的 default 分支返回 null——用户看不到那句本来写好的「设置 AICLIENT_NODE24_PATH」指引，只会在发送时吃一个原始错误。（注：这条更可能是 P4 载体半边的事，我只从事件词汇表这一侧给出「没有生产者」的判定。）

FIX: 判断产品上还要不要一条全局宿主横幅。要的话，让 Main 在 `ensureHost` 失败与 worker 池整体不可用时发 `host.error{fatal:true}`（或让 `getStatus` 能返回 `error`），横幅与 Node 24 指引立刻恢复可达；不要的话，把 `host.ready`/`host.error` 两个类型与 `hostStatus` 的两个 case、`isNode24ResolutionFailure` 一并退役，并修正 `useHostStatus` 的注释。无论哪条，Node 24 失败的用户可见出口都需要单独确认。

---

### [chat-event-09] low dead-code | P4-5 | src/shared/types/runtimeEvents.ts:154 | `session.status.liveness` rider 没有生产者，只剩 composer 诊断里的一段格式化分支

DESC: `SessionLivenessNote`（F2 的看门狗「我看过了，回合还活着」）在 src/ 下没有任何构造点——全仓只有类型声明、`SessionStatusEvent.payload.liveness` 的字段声明，以及 `ChatComposer.tsx:208` 在 `rawEvents=[...]` 诊断串里读它。它属于随 Claude CLI 后端一起退役的那一层（该后端有自己的 watchdog；自有 agent-loop 的存活判断走的是渲染层 `classifyTurnLiveness` + 静默预算）。类型上那段很长的 GUARD 注释（「如果你想把它升成独立事件类型，必须先证明旧 reducer 对未知类型是 no-op」）现在指向一个不存在的生产者。

EVIDENCE:
```
$ grep -rn "liveness" src/runtime src/main --include=*.ts | grep -v __tests__ | grep -v node_modules
src/main/services/agent-host/WorkerManager.ts:2071:   * runtime-facts ring, the turn-liveness classifier — since T-35, and no
（唯一命中是一句注释）
```
```tsx
// src/renderer/components/chat/ChatComposer.tsx:208, 216-221
  const liveness = payload?.liveness;
  ...
    const livenessSuffix = liveness
      ? `,${liveness.source ?? '?'}-${liveness.degraded ? 'degraded' : (liveness.reason ?? '?')}`
      : '';
```

SCENARIO: 没有运行期后果，诊断串里永远不会出现 `,ttft-degraded` 这类后缀。代价是读代码的人会以为宿主侧存在一个看门狗在汇报「我判定回合还活着」，从而在排查「回合卡住」时去找一个不存在的信号源。

FIX: 与 chat-event-06 同批处理：删 `SessionLivenessNote`、`payload.liveness` 与 composer 的格式化分支；若将来自有 agent-loop 要加看门狗，再按同一形状（`session.status` 的可选 rider）重建。

---

### [chat-event-10] low dead-code | P4-5 | src/renderer/components/chat/subagentActivityModel.ts:369 | `subagent.activity` 的 `kind:'progress'` 没有生产者，lane 的 progress 槽永远为空

DESC: `SubagentActivityPayload` 的八个 kind 里，native 侧 `records.ts` 只产出 started / text / thinking / tool.started / tool.completed / status / report，加上 `subagent/index.ts:575` 的 capped，共八种中的七种；唯独 `progress`（旧引擎 `task_progress` 心跳）没有任何生产者。渲染层为它保留了完整分支：`SubagentLane.progress` 字段、`SubagentProgress` 接口、reducer 的 `case 'progress'`，以及面板里据此显示的「最近在做什么 / 上一个工具」。

EVIDENCE:
```
$ grep -n "kind: '" src/runtime/plugins/subagent/records.ts src/runtime/plugins/subagent/index.ts | grep -v __tests__
records.ts:439 'thinking' / 448 'text' / 460 'tool.started' / 471 'tool.completed' / 495 'status' / 506 'report'
index.ts:575 'capped' / 1021,1035 'started'
（无 'progress'）
```
```ts
// src/renderer/components/chat/subagentActivityModel.ts:369-378
    case 'progress': {
      const progress: SubagentProgress = {
        description: asString(payload.description),
        lastToolName: asString(payload.lastToolName),
      };
      return withLane(state, { ...lane, progress, usage: mergeUsage(lane.usage, readUsage(payload.usage)) });
    }
```

SCENARIO: 一个长时间运行的子代理，面板上只会看到它的工具行逐条出现，不会有「正在做什么」的一句话概述。没有错误显示，只是这一栏恒空。

FIX: 要么由 `SubagentRun` 在每 N 次工具调用或每隔一段时间发一条 `progress`（它手上有 `description` 与最后一个工具名），要么把 kind、字段与分支一并退役。倾向前者：子代理面板本来就是为了回答「它在干什么」，而现在只有工具流水。

---

### [chat-event-11] low contract-gap | P4-5 | src/shared/types/runtimeEvents.ts:61 | `seq` 没有任何消费者，且它在 Main 丢弃事件之后才重新编号，事件丢失在协议上不可检测

DESC: `RuntimeEventBase.seq` 的注释是「Host 进程内的单调序号（用于乱序处理）」。渲染层对它零引用（`grep -rn "\.seq\b" src/renderer` 无非测试命中），所有顺序保证实际来自「IPC 单通道有序 + `initRuntime` 的队列按到达顺序整批折叠」。更要紧的是它的编号时点：`WorkerManager.handleWorkerEvent` 会在槽位尚未 `ready`、代次不匹配或 sessionId 不符时**直接 return**，而 `seq` 是在这道过滤之后的 `dispatch` 里才 `++this.eventSequence` 戳上去的。也就是说被丢掉的事件根本没拿到过号，渲染层收到的 seq 永远连续，丢失不可能被发现。projector 自己的 `recovery()` 注释就点名了这条丢弃路径（「worker 在 bootstrap 期发事件时 Main 还在 creating，`handleWorkerEvent` 会丢掉所有早于 ready 的事件」），并为此把提示改成按 run 重发——一个用绕路解决、但协议层没有承认的问题。

EVIDENCE:
```ts
// src/main/services/agent-host/WorkerManager.ts:2428-2433（先丢）
  private handleWorkerEvent(entry: ManagedSlot, slot: WorkerSlot, message: WorkerRpcEvent): void {
    if (!this.isAuthoritative(entry, message.generation) || entry.slot !== slot) return;
    if (entry.state !== 'ready' || message.type !== 'runtime.event') return;
```
```ts
// src/main/services/agent-host/WorkerManager.ts:2777-2784（后编号）
  private dispatch(event: RuntimeEventDraft): void {
    const stamped = { ...event, seq: ++this.eventSequence, timestamp: this.now() } as RuntimeEvent;
```
```ts
// src/runtime/events/projector.ts:443-447
   * Emitted per RUN rather than once at open. A worker emits during bootstrap
   * while Main still has the session in `creating`, and `handleWorkerEvent`
   * drops everything that arrives before the slot is `ready` — so an open-time
   * event would be correct and invisible.
```

SCENARIO: worker 在 bootstrap 期发出的任何事件（T034 的会话文件修复提示是已知一例）被静默丢弃，渲染层既收不到事件，也看不出少了东西——seq 依旧从 1 连号。将来任何一条「开会话时就该说的话」都会重复踩这个坑，而且照样是静默的。

FIX: 最小改动是把注释改成实况（`seq` = Main 的派发序号，不能用于检测丢失），并在 `handleWorkerEvent` 的每个 return 分支加一条带原因的 debug 日志，让丢弃至少在日志里可见。若确实需要「丢失可检测」，就要在 worker 侧编号、Main 侧透传，并让渲染层在跳号时记一笔——这是更大的改动，需要决策。

---

### [chat-event-12] low correctness | P3-4 渲染半边 | src/renderer/stores/chatSessions.ts:524 | 回放只还原四类 block，重开会话后权限卡行、审批审计行与已答问答卡全部消失

DESC: 实时路上渲染层会往消息里挂六类 block：text / thinking / tool_call / tool_result / permission_request / permission_activity / question。回放路（`session.history` → `mapHistoryBlock`）只认前四类，其余 `return null` 被过滤掉。于是重开一个会话后：已决权限卡收起后的那一行（`Allowed write — …`）没了、权限审计行（包括「Approval details」折叠里那些 `policy_allow`）没了、已答问答卡（问题与用户选的答案）也没了，只剩下裸的工具调用与结果。`PermissionActivityEvent` 的类型注释说这行是「`policy_allow` 从不弹窗，所以它是这次调用被闸门管过、而不是根本没检查的**唯一证据**」——重开会话后这份唯一证据就不在了。

EVIDENCE:
```ts
// src/renderer/stores/chatSessions.ts:524-567
function mapHistoryBlock(block: HistoryMessage['blocks'][number]): ChatBlock | null {
  switch (block.type) {
    case 'text': ...
    case 'thinking': ...
    case 'tool_call': ...
    case 'tool_result': ...
    default:
      return null;
  }
}
```
对照实时路的 `permission.activity`（:1059-1099）、`permission.requested`（:1102-1176）、`question.requested`（:1228-1273）三个分支产出的 block 类型，都不在上表里。`src/agent-host/piSessionTimeline.ts` 的 `HistoryBlock` 也只有 text / thinking / tool_call / tool_result 四种，所以缺口在会话文件与投影两层，不只是 store。

SCENARIO: 用户今天批准了三次写文件、拒绝了一次 `bash`，明天重开这个会话想确认「我当时到底批了什么」——时间线上只有工具行，被拒的那次表现为一次失败的工具调用，批准与自动放行的记录一条不剩。问答同理：模型问过什么、用户选了哪个，回放后只剩一次 `ask` 工具调用及其文本结果。

FIX: 按「值不值得进会话文件」分两档。审批决定（谁、什么、允许还是拒绝、是不是规则自动放行）建议落成 `custom` 条目并在 `piSessionTimeline` 投影成一类新的 HistoryBlock——它是审计证据，且体积很小；问答卡可以用同样的办法，或接受「工具行即记录」并把类型注释改成实况。无论选哪档，都应把「实时可见、回放不可见」这条差异写进契约，否则下一个人还会以为它在。

---

## 测试缺口

1. **golden 录制缺六类事件**：`tool.updated`、`session.failed`、`session.stopped`、`session.stderr`、`custom.message` / `custom.entry`、`preview.requested` 在五份录制里一次都没出现。P4-5 的「GUI 无回归」签收正是建立在这套录制上，缺席的这几类恰好包含两类终态与唯一的诊断流。
2. **没有一条用例断言审批/问答结算后的会话状态**。全仓对 `waiting_permission` / `waiting_question` 的断言都只覆盖「进入」，没有覆盖「离开」，所以 chat-event-02 一直绿着。
3. **没有并发问答用例**。`chatSessionsQuestion.test.ts` 只测单问单答，第二条 `question.requested` 覆盖第一条这件事没有任何反向断言。
4. **没有断言 `usage.updated` 的 `context` 在委派折算后仍然存在**。`nativeGuiSubagentEventStream.json` 里已经录到了一条无 `context` 的 payload，但回放测试只看 lane 重建，不看上下文占用。
5. **`permission.activity` 的 `delegationId`/`agentName` 没有渲染层用例**（自然如此——没人渲染它）；`permissionActivityRow.test.ts` 只覆盖 `forwarded` 这条无生产者的分支。
6. **回放与实时的 block 类型差异没有对照用例**。现有 `nativeStreamReplay.test.ts` 只跑实时流，没有「同一段会话先实时、再从 history 重建，比较两次的 block 集合」这一形态。
7. **`T034` 的 `recovery` rider 没有任何界面侧断言**（落地记录已声明无 UI 组件，此处仅记账）。
8. **`eventRing` 的高频折叠前缀表与实际事件词汇没有一致性用例**：`HIGH_FREQUENCY_PREFIXES` 硬编码三个类型名，若将来 `formatRuntimeEvent` 改格式或新增高频类型，折叠会静默失效。

## 未经执行验证的声明

以下结论我只做了静态阅读，需要在批次 E 或带模型的环境里坐实：

1. chat-event-01 的跨会话形态需要两个会话真的并发跑到 `ask`；我按 worker 池容量（≥3）与 store 结构推断可达，没有实跑。**static_inference**
2. chat-event-01 的「同一条 assistant 消息里两个 `ask` 并行」依赖 pi 的并行工具执行路径（`agent-loop.js:286-291`）与模型真的这么调；前者是代码事实，后者是概率。**static_inference**
3. chat-event-03 的「永久形态」需要一次真实的 Stop 或失败回合，且此前有委派结算；我从 `agent-loop/index.ts:573/636` 两个 fold 点与 `takeUsage()` 的排干语义推出，没有实跑。**static_inference**
4. chat-event-02 / -03 的用户可见后果（Run 面板停在「等待审批」、上下文徽标消失）都是从纯函数与组件源码推的，没有起过 Electron。**static_inference**
5. chat-event-08 里「Node 24 缺失时用户什么都看不到」只验证了渲染层这一侧没有可达的 error 状态；Main 侧是否有别的出口（日志、对话框、发送时的错误 toast）不在本区域范围内，未核。
6. `trace_rotate_failed`（T024）在 GUI 事件词汇表里没有对应事件，它只写进 trace 文件并在 dispose 时经 `flush()` 抛出。这条抛出会不会被 Main 当成一次「会话关闭失败」呈现给用户，属于 Main 侧载体的问题，本区域未核。
7. 所有 Windows / 加密机 / Electron utility 载体相关的结论本轮一条都没有——本区域的代码面不含平台分支，故未列入。

## 上机检查单

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| 审批后 Run 面板状态 | 点「允许」之后，Run 面板标题从「等待审批」变为「运行中 / 正在运行工具」，attention 色消失 | 起应用，跑一次触发 write 审批的对话，批准后截 Run 面板 | real-model |
| 上下文徽标在委派后仍在 | 一次用到 Task 的对话，正常结束与中途 Stop 两种收尾下，输入框上方的百分比徽标都不消失 | 同一会话各跑一次，分别截图；对照 devtools 里最后一条 `usage.updated` 的键集 | real-model |
| 并发问答 | 会话 A 的 `ask` 未答时，在会话 B 触发 `ask`；切回 A 检查是否还有可作答卡片，A 的回合是否还能自己结束 | 两个会话各发一条会触发 `ask` 的指令，切换观察；必要时用 devtools 直接读 `pendingQuestion` | real-model |
| 子代理审批行归属 | 委派一个会撞 deny 的子代理，时间线审批行上能读出是哪个子代理 | 起应用跑一次委派，截时间线审批行 | real-model |
| 中文界面审批行用词 | 中文语言设置下，「本会话内允许」之后的自动放行行不出现英文 `session grant` | 切中文，先批一次「本会话内允许」，再触发同类工具，展开「审批详情」截图 | real-model |
| 工具进度行 | 跑一条 >60s 的 bash，Run 面板是否出现工具自报的进度行（按当前代码应当**永不出现**，用来确认 chat-event-04） | 起应用跑 `sleep 90 && echo done`，观察 Run 面板 | real-model |
| 宿主诊断横幅 | 人为让 Node 24 解析失败，确认用户能否看到可操作的提示 | 清掉 `AICLIENT_NODE24_PATH` 并让默认 node 不可用，起应用 | dev-box |
| 回放差异 | 一个批过审批、答过问答的会话，关掉再打开，检查审批行与问答卡是否还在 | 跑完一轮后重启应用打开同一会话，前后截图对比 | real-model |

## 读过的文件

**契约与生产者**
- src/shared/types/runtimeEvents.ts
- src/shared/piUsage.ts
- src/shared/i18n.ts（权限/审批相关词条段）
- src/shared/internalMessage.ts（经引用核对）
- src/runtime/events/index.ts
- src/runtime/events/projector.ts
- src/runtime/plugins/permissions/activity.ts
- src/runtime/plugins/permissions/index.ts（delegation 字段段）
- src/runtime/worker/permissionPrompt.ts
- src/runtime/worker/questionPrompt.ts
- src/runtime/plugins/tools/ask.ts
- src/runtime/plugins/tools/index.ts
- src/runtime/plugins/tools/new-context.ts
- src/runtime/plugins/tools/browserPreview.ts（注册名）
- src/runtime/plugins/skills/index.ts（注册名）
- src/runtime/plugins/subagent/index.ts
- src/runtime/plugins/subagent/records.ts
- src/runtime/plugins/agent-loop/index.ts
- src/runtime/plugins/agent-loop/providerRetry.ts
- src/runtime/plugins/session/index.ts
- src/runtime/trace.ts
- src/runtime/bootstrap.ts（dispose flush 段）
- src/runtime/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js（工具并行与 tool_execution_update）

**Main 侧事件面**
- src/main/services/agent-host/WorkerManager.ts（事件转发、状态机、dispatch、session.status 九处）
- src/main/services/chat/NativeSessionIndexAdapter.ts
- src/main/ipc/chat.ts（host.error 注释段）
- src/preload/index.ts（onRuntimeEvent 段）
- src/agent-host/piSessionTimeline.ts

**渲染层消费者**
- src/renderer/stores/chatSessions.ts
- src/renderer/stores/runtimeEventBus.ts
- src/renderer/stores/sessionActivity.ts
- src/renderer/stores/sessionRuntimeFacts.ts
- src/renderer/stores/subagentActivity.ts
- src/renderer/stores/permissionGate.ts
- src/renderer/components/chat/hostStatus.ts
- src/renderer/components/chat/useHostStatus.ts
- src/renderer/components/chat/retryBanner.ts
- src/renderer/components/chat/turnStatus.ts
- src/renderer/components/chat/SessionActivityStatus.tsx
- src/renderer/components/chat/assistantProgress.ts
- src/renderer/components/chat/thinkingCard.ts
- src/renderer/components/chat/messageMetadata.ts
- src/renderer/components/chat/ComposerUsageChip.tsx
- src/renderer/components/chat/questionCardModel.ts
- src/renderer/components/chat/QuestionCard.tsx（权限卡段）
- src/renderer/components/chat/PendingQuestionDock.tsx
- src/renderer/components/chat/PermissionActivityRows.tsx
- src/renderer/components/chat/permissionActivityRow.ts
- src/renderer/components/chat/subagentActivityModel.ts
- src/renderer/components/chat/eventRing.ts
- src/renderer/components/chat/turnProcessFold.ts
- src/renderer/components/chat/toolCard.ts（TOOL_VERBS 段）
- src/renderer/components/chat/piToolNames.ts
- src/renderer/components/chat/MessageTimeline.tsx（渲染分派段）
- src/renderer/components/chat/ChatComposer.tsx（事件监听与诊断段）
- src/renderer/components/workspace-shell/surfaces/contextSurfaceModel.ts
- src/renderer/components/workspace-shell/surfaces/runPanelModel.ts
- src/renderer/components/workspace-shell/surfaces/RunSurfaceView.tsx（usage 段）
- src/renderer/components/workspace-shell/useSessionCapabilities.ts

**测试与录制**
- src/runtime/__tests__/guiEventContract.test.ts
- src/renderer/stores/__tests__/nativeStreamReplay.test.ts
- src/shared/__tests__/fixtures/nativeGuiEventStream.json
- src/shared/__tests__/fixtures/nativeGuiSubagentEventStream.json
- src/shared/__tests__/fixtures/nativeGuiQuestionEventStream.json
- src/shared/__tests__/fixtures/nativeGuiCompactionEventStream.json
- src/shared/__tests__/fixtures/nativeGuiRetryEventStream.json

**计划文档**
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md（第二、五、八节）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md（第 71 行及 CRITIC 段）
- docs/plantree/plans/runtime-hardening/roadmap.md
- docs/plantree/plans/runtime-evolution/README.md（F 缺陷表段）
