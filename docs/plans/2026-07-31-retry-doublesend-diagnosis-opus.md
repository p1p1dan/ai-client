# 第四轮点验缺陷诊断（Opus / deep-reasoner）— Retry 双发 + 报错态输入框被占

- 日期：2026-07-31
- 仓库/分支：`ai-client` @ `feat/openchamber-chat-refactor`，HEAD `8b45b03`（工作树干净）
- 范围：**只诊断不改码**。以下所有行号对应 HEAD `8b45b03` 的文件内容。
- 输入：用户第四轮 GUI 真机点验
  - 缺陷 A：看到 network retry → 看到报错 → Retry 按钮出现 → **点一次 Retry，消息发了两次**
  - 缺陷 B：报错期间 **composer 被报错占用，无法输入新消息，只能点 Retry**

---

## 0. 结论速览

| 缺陷 | 一句话根因 |
|---|---|
| A | `shouldArmRetryable` 把 **`'committed'`（= Host 已受理并已回显本条文本）** 也武装成 Retry，而 Retry 走的是同一个 `runSend` 全量重发 → 第二条 `chat.send` → 第二次 `beginTurn` → 第二条 user 回显 + 第二次真实投递。**同一份"已受理"证据，队列层用来禁止重排（"never requeue"），Retry 层却用来允许重发。** |
| B | 会话态 composer 把 **状态行和 textarea 放进同一个 flex 行**；报错时状态行文案是超长的 `Error: <abandonError/TTFT 全文>`，其 `flex-basis:auto`（巨大），而 textarea 是 `flex-1`（`flex-basis:0`）。负剩余空间下 **缩放收缩因子 = shrink × base**，textarea 的 base 为 0 → 分不到任何收缩额度 → **textarea 被压成 0 宽**。不是 `disabled` 谓词回归，是布局回归。 |

---

## 1. 缺陷 A：点一次 Retry，消息发两次

### 1.1 关键事实链（先立三条硬事实）

**事实 1 — Host 一旦受理 send，必定先回显 user，再才跑模型。**
`src/agent-host/claudeRuntime.ts:403-471`：`send()` 依次过 `session_not_found`(404) → `session_busy`(416-428) → driver 检查(430-442)，随后

```ts
// claudeRuntime.ts:460-464
const normalizer = new EventNormalizer(session.sessionId, this.opts.emit, this.log);
normalizer.beginTurn(input.text, input.attachments, input.requestId);
```

`beginTurn`（`src/agent-host/eventNormalizer.ts:156-178`）无条件 emit `message.started{role:'user', messageId:'user-<sid>-<ts>'}`，**在 `queryFn()` 之前**。
⇒ 只要 `chat.send` 被受理，`sawUserEcho`（`ChatComposer.tsx:842-844`，判据 `assistantProgress.ts:57-61`）必为 true。

**事实 2 — 于是"受理后的任何失败"都被判成 `'committed'`。**
`queueRelease.ts:181-187`：

```ts
export function decideRunEntryOutcome(input) {
  if (!input.fatalHostError) return 'committed';
  if (input.sawAssistantProgress || input.sawUserEcho) return 'committed';
  return 'rejected';
}
```

TTFT 看门狗（`claudeRuntime.ts:591-602`，`sawApiRetry` 为真时 32s 触发 `abort()`）→ `claudeRuntime.ts:745-750` `emitFailed(...)` + `status='failed'` → renderer 侧 `isSessionFailedForSend` 把它折进 `fatalHostError`（`ChatComposer.tsx:885-888`）→ 走 `ChatComposer.tsx:1133-1150` 的 `if (fatalHostError)` 分支 → `decideRunEntryOutcome({fatalHostError:true, sawAssistantProgress:false, sawUserEcho:true})` = **`'committed'`**。

**事实 3 — `'committed'` 却仍然武装 Retry。**
`queueRelease.ts:213-215`：

```ts
export function shouldArmRetryable(outcome: RunEntryOutcome, origin: RunSendOrigin): boolean {
  return !(outcome === 'rejected' && origin === 'release');
}
```

`'committed' + 'direct'` → `true` → `ChatComposer.tsx:784-792` `finalizeOutcome` 执行 `setRetryable(committed)`。
同时 `chatSessions.ts:473-479` 把 status 置 `'failed'` 并写 `lastError` → `lastTurnFailed` 双重成立（`ChatComposer.tsx:595`）。

**这三条事实合起来就是矛盾**：`queueRelease.ts:142-145` 对 `'committed'` 的定义原文是

> `'committed'`: the Host admitted the turn (it may still go on to fail mid-stream) — **never requeue, the entry has already been spent**

以及 `decideRunEntryOutcome` 头注释（`queueRelease.ts:164-166`）：

> Classifies a post-commit `runSend` failure as `'committed'` (the Host DID start the turn — **a duplicate resend would be wrong**)

**同一个判据，队列层拿来禁止重排，Retry 层拿来允许重发。** 这就是 A 的权威冲突根因。

### 1.2 两次发送的完整触发链（行级）

| # | 来源 | 链路 |
|---|---|---|
| 第一发 | 用户 Send（`origin:'direct'`） | `ChatComposer.tsx:439-468` `handleSend` → `461` `runSend(..., {origin:'direct'})` → `1062` `sendAndWait()` → `941-947` `chat.send` → Host `claudeRuntime.ts:444+` 受理 → `460-464` **beginTurn ⇒ user 回显#1 落时间线**（`chatSessions.ts:488-505` upsert，id `user-<sid>-<ts>`）→ 模型侧只见 `system/api_retry`（状态行的 network retry，`ChatComposer.tsx:848-855` + `1460-1465`）→ 32s TTFT 看门狗 `claudeRuntime.ts:598-602` abort → `745-750` `session.failed` → renderer `1133-1150` → `'committed'` → `784-792` **武装 `retryable` + 红色报错横幅**（`1783-1787`） |
| 第二发 | 用户点 Retry（`origin:'retry'`） | `ChatComposer.tsx:1715-1724` Retry 按钮（`deriveActionButtons` 在 `queueRelease.ts:330-335` 返回 `[retry, send]`）→ `618-646` `handleRetry` → `642` `runSend(retryText, retryDrafts, {origin:'retry'})` → 再次 `941-947` `chat.send`（**同一份 text/drafts，无任何去重**）→ Host 再次 `beginTurn` ⇒ **user 回显#2** |

⇒ 用户视角：**时间线两条一模一样的 user 气泡**（不是"一条 user 两条 assistant"）。而且这不只是视觉重复：若 CLI 已把第一条写进 JSONL transcript（中断发生在 `beginTurn` 之后），Retry 走 resume 续接时模型**真的会看到同一条消息两遍**。

### 1.3 同一现象的另外 4 条并存机制（都需排除/一并修）

**A2 — 第二个"无证据"的武装权威（必然重复，且能在 Retry 后再次自我武装）**
`ChatComposer.tsx:586-595`：

```ts
const retryText =
  retryable?.text ??
  (activeSession?.status === 'failed'
    ? lastUserPrompt?.blocks.find((b) => b.type === 'text' && b.text)?.text
    : undefined);
const lastTurnFailed = retryable !== null || activeSession?.status === 'failed';
```

`lastUserPrompt`（`572-574`）取自**时间线里最后一条 user 消息**——而一条 user 消息之所以在时间线里，恰恰**证明 Host 已受理过它**。因此这条兜底路径是"结构上保证重复"的：它把已投递的文本再投一次。
更糟的是它**不受 `setRetryable(null)` 影响**：`handleRetry:620` 清了 `retryable`，但只要 status 还停在 `'failed'`，Retry 按钮会在下一帧重新出现并再次可点（第二次点 → 第三条）。

**A3 — busy 重试循环里的"已受理仍重发"漏洞（一次 runSend 内就能双发）**
`ChatComposer.tsx:1072-1087`：

```ts
let busyRetry = 0;
while (fatalHostErrorCode === 'session_busy' && busyRetry < 8) {
  ...
  ok = await sendAndWait();   // 同一份 text 再发一次
}
```

- `fatalHostErrorCode` 是整个 `runSend` 共享的可变量，**成功后从不清零**，且 `isHostErrorForSend`（`assistantProgress.ts:40-46`）只要 `event.sessionId` 命中就认账，**不校验 requestId**。
- 因此任一"本会话的、别的请求引发的" `session_busy`（典型来源：`sessionIndex/useResumeSession.ts:40` 的 LeftNav 点选 resume，Host `claudeRuntime.ts:298-311` 对 running 会话回 `session_busy`）会在本次 send **已被受理之后**污染这个变量 → 循环重发同一文本，最多 8 次；一旦上一轮 turn 在 250ms 退避间隙结束，其中一次就会被真受理 ⇒ **一次点击、两条真实投递**。
- 循环条件里**没有 `!sawUserEcho` 护栏**——这与 `decideRunEntryOutcome` 的"已回显即不可重发"语义直接冲突。

**A4 — Retry 顺手解掉了队列的 `send-rejected` 暂停 → 队列在 Retry 之后再放一条**
`ChatComposer.tsx:765`（`runSend` commit point，三个 origin 共用）：

```ts
useMessageQueueStore.getState().clearPause(sessionId);
```

但 `send-rejected` 这类暂停是 `finalizeOutcome`（`788-790`，`shouldPauseQueueOnRejection`，`queueRelease.ts:241-246`）为"被退回队首的条目"专门加的保护，**不是**用户 Stop。Retry 把它清掉后，`useQueueRelease.ts:49-93` 会在本轮 turn 落到 idle 的瞬间放行队首 ⇒ 用户一次点击看到"两条消息发出去"（此形态下两条**文本不同**）。

**A5 — Retry 走 resume 时的历史重放，会再复制一份（不发送也重复）**
失败分支统一 `unbindHost()`（`ChatComposer.tsx:1110/1116/1121/1134/1175/1258`），所以 Retry 的前导必然是 `resume`（`sendPreamble.ts:28-39`，runtimeIdentity 已由 `session.updated` 写入）或 `create`。
走 resume 时 Host `claudeRuntime.ts:312-328` → `replayHistory` → `session.history`；renderer `chatSessions.ts:407-420` 是**"只替换 `h:` 前缀"的幂等前缀替换**：

```ts
const withoutOldHistory = bucket.filter((m) => !m.id.startsWith(HISTORY_MESSAGE_ID_PREFIX));
const messages = withBucket(state, sessionId, [...historyMessages, ...withoutOldHistory]);
```

运行时的 `user-*` 回显#1 被完整保留，而 JSONL 里同一条被映射成 `h:*` 再插到前面 ⇒ **同文本两条气泡，且这一份在"第二次 send 之前"就已出现**。
（若 resume 因 `session.running` 未落而拿到 `session_busy`，`ChatComposer.tsx:1026-1049` 会回退到 `runCreateSequence()` = close+create，此时无历史重放，但**丢掉 runtimeIdentity → Retry 变成新会话**，属另一个独立缺陷，本轮附带记录。）

### 1.4 用户看到的到底是哪一种？可区分观察点

代码只能证明"多条链路都会产生两条同文本 user 气泡"，无法唯一定解。区分观察点（下次点验直接照抄）：

| 观察点 | 判据 |
|---|---|
| O1 | store 里两条重复气泡的 **message id 前缀**：都是 `user-<sid>-*` ⇒ 两次真实 send（A1/A3）；一条 `h:*` + 一条 `user-*` ⇒ 历史重放（A5） |
| O2 | Host 日志/事件流里本会话 **`message.started{role:'user'}` 出现次数**：1 次 ⇒ 纯 A5；2 次 ⇒ 确有第二次投递 |
| O3 | 重复气泡出现的**时刻**：点 Retry 后"立刻"（IPC 一个来回内）⇒ A5 的历史重放；等到第二次 `session.status running` 之后 ⇒ A1/A3 |
| O4 | 两条气泡**文本是否相同**：不同 ⇒ A4（队列被解暂停后放行了另一条） |
| O5 | `lastError` 里的 `rawEvents=[...]`（`ChatComposer.tsx:114-141` 已透传 `api_retry`）中 `message.started` 与 `session.status(running)` 的出现次数 |
| O6 | Host 日志里两条 `chat.send` 的 **requestId 是否不同**；若相同前缀且间隔约 250ms×N ⇒ A3 的 busy 循环 |

---

## 2. 缺陷 B：报错态 composer 被占用、无法输入

### 2.1 不是 `disabled` 谓词

textarea 的禁用条件（`ChatComposer.tsx:1634-1639`）是：

```ts
disabled={disabled || !activeSessionId}
```

`disabled` 由 `ChatWorkspace.tsx:127` 传入，值为 `!activeSessionId`。**报错/`failed` 状态完全不参与**——T-19「运行中解禁输入」的裁定在这里是完好的，没有回归。
Send 按钮（`ChatComposer.tsx:1752-1766`）的 `!canSend` 也不含错误项：`canSend = activeSessionId && cwd && !disabled && !canStop`（`352`），`canStop = busy || sending`（`336`），`'failed'` 不在 `isRunningStatus`（`queueRelease.ts:297-304`）里 ⇒ 逻辑上"报错态可直发"本来就成立。

### 2.2 真因：会话态把状态行和输入框塞进同一 flex 行，长错误文案吃光宽度

`ChatComposer.tsx:1893-1908`（session 分支）：

```tsx
<div className="flex min-w-0 items-center gap-2">
  {textareaEl}                                              // 外层 span: composerTextareaClass('session')
  {renderStatusLine('flex min-w-0 shrink items-center gap-1.5')}
  {modelEffortControls}
  {actionButtons}
</div>
```

- `composerTextareaClass('session')`（`middleColumnLayout.ts:136`）= `min-w-0 flex-1 …` ⇒ **`flex: 1 1 0%`，flex base size = 0，min-width = 0**。
  （`ui/textarea.tsx:15-26` 证实 `unstyled` 时 `className` 落在外层 `<span>`，即真正的 flex item；内层 `<textarea>` 是 `w-full`。）
- 状态行包装 div 只有 `shrink`（`flex-shrink:1`）+ `min-w-0`，**没有 `basis`** ⇒ `flex-basis:auto` ⇒ base size = 内容 max-content 宽。
- `shouldShowStatusLine`（`middleColumnLayout.ts:186-197`）在会话态对 `hasStatusError` 返回 true；此时 `statusLine`（`1449-1467`）取 `statusHint` = ``Error: ${lastError}``（`391-403`），而 `lastError` 是 TTFT 看门狗全文或 `abandonError`（`1217-1226`：含 `rawEvents=[...]`、`hostAfter=JSON`、`cwd=`），**数百到上千字符**，`whitespace nowrap`（`truncate`）下 max-content 轻松几千 px。

CSS flex 收缩算法：负剩余空间按 **scaled shrink factor = flex-shrink × flex base size** 分摊。

- textarea：`1 × 0 = 0` ⇒ **分不到任何收缩额度，停在 base = 0**；
- 状态行：`1 × 巨大` ⇒ 吃掉全部收缩，最终占满整行余宽。

且负剩余空间下 `flex-grow` 不参与，textarea 无从长回来，`min-w-0` 也不给地板。
⇒ **输入框宽度 0 px：看不见、点不进、打不了字**。Send 按钮因 `(!value.trim() && drafts.length===0)`（`1762`）恒 disabled，而 Retry 的 `spec.disabled` 恒 false（`queueRelease.ts:331`）⇒ **"只能点重试"**，与用户描述逐字吻合。

补充：同一份错误文案在 `ChatComposer.tsx:1783-1787` 的红色横幅里**已经完整显示过一次**（`max-h-28 overflow-auto`），行内状态行是纯重复渲染。

### 2.3 定性：回归还是从未覆盖

**"从未覆盖的态" + T-28 引入的布局回归**，不是 T-19 回归：

- T-19（`1b350ff`）的解禁矩阵只枚举了 `disabled` 谓词（textarea / paste / Enter 派发），从未把"输入框被同行元素挤成 0 宽"建模进去；
- 会话态"单行 docked 卡片"是 T-28（`4c1e4d7`）引入的形态，空态分支（`1910-1924`）把状态行放在**独立的下一行**，因此空态永不复现；
- 平时 `sending` 时状态行文案很短（`Sending to Agent Host…`），正剩余空间下 textarea 靠 `flex-grow` 撑开，所以**只有错误态**（长文案）才触发，之前三轮点验都没撞上。

---

## 3. 最小修复方案

### 3.0 去重权威的落层裁定（回答"放哪层"）

分三层，各管一件事，互不重叠：

| 层 | 权威 | 管什么 |
|---|---|---|
| L1 **发送层（唯一去重权威）** | `sawUserEcho` / `decideRunEntryOutcome` 的 `'committed'` | **"Host 已回显本条文本"= 本条不得再被任何路径自动重发**。这是唯一的事实证据，队列层已经这么用（never requeue），Retry 层必须与之对齐 |
| L2 **武装态互斥（单写者）** | `retryable`（唯一 Retry 快照） | 任意时刻只允许一条"待重发载荷"；直发 commit 即撤销旧武装（现有 `726` 行为保留） |
| L3 **队列互斥** | `paused: 'send-rejected'` | 仅归 `useQueueRelease` / 用户 Resume 管；Retry 不得代为解除 |

**不要把去重放到 Host 忙位**：`session.running` 只表达"此刻有 turn"，不表达"这条文本已投递过"，用它去重会把合法的"用户主动再问一遍"也误杀。

### 3.1 缺陷 A 的改动清单

| 文件 | 改动要点 | 红线/测试影响 |
|---|---|---|
| `src/renderer/components/chat/queueRelease.ts` | ① `shouldArmRetryable` 改为**证据门控**：`outcome === 'rejected' && origin !== 'release'` 才武装（即只有"从未被受理"的失败才允许一键重发）。② 为"已受理但失败"新增纯函数 `decideFailureAffordance({outcome, origin}) → 'resend' \| 'restore-draft' \| 'none'`，`'committed'` → `'restore-draft'`（把文本+附件放回 composer，让用户自己按 Send），`'rejected'` → `'resend'`。③ `shouldPauseQueueOnRejection` 保持"`shouldArmRetryable` 的补集"这一不变式（同步改动即可，仍是一行）。 | 纯函数、非红线；`queueRelease.test.ts` 已有针对 `shouldArmRetryable('committed', …)` 的断言需改写（见 §4） |
| `src/renderer/components/chat/ChatComposer.tsx` | ① `retryable` 增加 `admitted: boolean` 字段（值来自 `finalizeOutcome` 拿到的 `outcome === 'committed'`，**不引入新证据源**）。② `handleRetry` 按 `decideFailureAffordance` 分流：`'resend'` → 现行 `runSend(origin:'retry')`；`'restore-draft'` → 只做 `setValue(text)` + `attachments.addDrafts(drafts)` + 清 `retryable`，**不发 IPC**（按钮文案/`title` 相应改为"把上一条放回输入框"）。③ **删除 `586-595` 的 `status==='failed'` + `lastUserPrompt` 兜底重发权威**；重开一个已 `failed` 的会话时改为"横幅 + 可选的放回草稿"，绝不自动持有一个一键重发。④ busy 循环（`1072-1087`）加两道闸：循环条件补 `!sawUserEcho`；每次 `sendAndWait()` 前把 `fatalHostError/fatalHostErrorCode` 归零，使循环只对**本次 attempt** 的 `session_busy` 生效。⑤ `765` 的 `clearPause` 改为 reason 限定（见下一行）。 | `.tsx` 无单测（文件 `648-667` 的 S3 注释已自认"inspection-verified"），故把 ④ 的判定抽成纯函数 `shouldRetryBusySend(...)` 放进 `queueRelease.ts` 并补测 |
| `src/renderer/components/chat/messageQueue.ts` + `src/renderer/stores/messageQueue.ts` | `clearPause(state, sessionId, opts?: { only?: QueuePauseReason })`：`runSend` 的 commit point 传 `{ only: 'stopped' }`，即"新 turn 只解除用户 Stop 造成的暂停，不解除 `send-rejected` 保护"。用户点 strip 上的 Resume 仍是无参全清。 | 非红线；`messageQueue.test.ts` 加断言（见 §4），既有断言默认参数不变 ⇒ 不破 |
| `src/renderer/components/chat/assistantProgress.ts` | `isHostErrorForSend` 增加"requestId 已知时必须匹配"的严格模式（新增可选参数 `strict`），供 busy 循环使用；默认行为不变以免动既有断言。 | 纯函数，已有测试；新增用例 |
| **零改动**（明确不动） | `src/renderer/stores/chatSessions.ts`、`src/shared/types/runtimeEvents.ts`、`src/agent-host/**` | 满足红线约束 |

**为什么"已受理失败"不再一键重发，而是放回草稿**：
`'committed'` 意味着这条文本已经进 Host、已进时间线、极可能已进 CLI 的 JSONL transcript。此时"重发"在语义上等于**重新问一遍**，不是"补发"——用户完全有权这么做，但必须是**有意识的一次 Send**，而不是一个叫 "Retry" 的按钮悄悄替他做。放回草稿同时解决了"文本丢失"顾虑（原武装逻辑的初衷），且天然满足用户的诉求"可以重试，也可以新写消息发送"。

**残留的 A5（历史重放重复）不在最小修复内**：它需要 `chatSessions.ts`（红线）在 `session.history` 合并时按 `(role, text)` 折叠运行时回显，或 Host 侧在 `replayHistory` 里跳过本次进程已 emit 过的 turn。本轮建议**先只做观察点 O1/O2 取证**，确认是否真的在真机复现，再单独立项。

### 3.2 缺陷 B 的改动清单

期望行为（裁定）：**报错横幅 + Retry 保留；输入框始终可编辑、可直发；直发后旧武装按 L2 单写者规则撤销。**

| 文件 | 改动要点 | 测试影响 |
|---|---|---|
| `src/renderer/components/chat/middleColumnLayout.ts` | ① `shouldShowStatusLine` 会话态分支**去掉 `hasStatusError`**（错误由 `1783-1787` 的横幅独占，行内不再重复渲染）：`return input.sending \|\| input.reading > 0 \|\| input.hasLargeHint;`。② `composerTextareaClass('session')` 把 `min-w-0` 换成 `min-w-32`（给输入框一条 128px 硬地板，任何长状态文案都无法再把它压成 0）。 | ① 需改写 `middleColumnLayout.test.ts:337-347`「shows it whenever the composer is in an error state」→ 改为断言会话态**不**显示、空态**仍**显示。② `composerTextareaClass` 的既有断言全是 `toContain`/`not.toContain`（`test:191-231`），未断言 `min-w-0` ⇒ **零破坏** |
| `src/renderer/components/chat/ChatComposer.tsx` | 会话态状态行包装类由 `flex min-w-0 shrink items-center gap-1.5` 改为 `flex min-w-0 shrink basis-0 items-center gap-1.5`（把 base size 从 max-content 降到 0，收缩分摊不再被单个长字符串垄断）。作为纵深防御，即使将来又有长文案进入这一行也不会压垮输入框。 | `.tsx` 内联类名，无单测 |
| （可选，观感）`ChatComposer.tsx:1217-1226` | `abandonError` 的**首行**（人话结论）与诊断尾巴（`rawEvents=`/`hostAfter=`）拆开：横幅只渲染首行，完整串保留在 `title`/可展开区。当前横幅 `max-h-28 overflow-auto` 会顶掉 112px 时间线高度。 | 建议把首行抽成纯函数 `formatSendFailureHeadline()` 并补测 |

**"新直发后旧武装重试如何处置" 裁定**：**撤销**（保留 `ChatComposer.tsx:726` 现有 `setRetryable(null)`）。理由：

1. 单写者规则——两条互不知情的活跃发送路径（自动 Retry + 用户 Send）同时存在，正是本轮 A 类缺陷的产生模式；
2. 撤销不会丢数据：`admitted===true` 的载荷本就在时间线里；`admitted===false` 的载荷在 B 修好之后用户随时可以自己重打，且更稳妥的做法是**撤销时把未受理载荷 `enqueue` 到队尾**（队列 strip 可见、可编辑、可删除，满足"不丢"），若 `enqueue` 被拒（队列满）则保持武装不撤——这条建议列为可选增强，因为它会改变发送顺序语义，需产品拍板。

---

## 4. 需新增的断言点清单（§4「先定验证再改码」）

**A 类（纯函数层，`vitest environment:'node'` 可直接跑）**

1. `queueRelease.test.ts`：`shouldArmRetryable('committed', 'direct'|'retry'|'release') === false` —— **已受理的失败绝不武装一键重发**（替换现有相反断言，并在用例名里写明本次事故编号）。
2. `queueRelease.test.ts`：`shouldPauseQueueOnRejection` 仍严格等于 `!shouldArmRetryable` 的补集（不变式回归）。
3. `queueRelease.test.ts`：新 `decideFailureAffordance` 的 3×3 全矩阵（outcome × origin）。
4. `queueRelease.test.ts`：新 `shouldRetryBusySend({fatalCode:'session_busy', sawUserEcho:true, attempts:0})` === `false` —— **已回显即禁止循环重发**；`sawUserEcho:false` 且 `attempts<8` 才 true。
5. `assistantProgress.test.ts`：`isHostErrorForSend(event, {sessionId, requestId}, {strict:true})` 对"sessionId 命中但 requestId 不同"返回 false（关掉 A3 的串扰口）。
6. `messageQueue.test.ts`：`clearPause(state, sid, {only:'stopped'})` 对 `paused==='send-rejected'` 无效、对 `'stopped'` 有效；无参调用行为不变。
7. `messageQueue.test.ts`：**不重不变式**——一条 entry 在 `'committed'` outcome 下永不回队（已有）+ 新增"Retry 期间队列 pause 保持"的组合用例。

**B 类（布局纯函数层）**

8. `middleColumnLayout.test.ts`：会话态 `shouldShowStatusLine({hasStatusError:true, ...})` === `false`；空态仍 `true`。
9. `middleColumnLayout.test.ts`：`composerTextareaClass('session')` 含 `min-w-32` 且**不含** `min-w-0`（输入框宽度地板契约）。
10. `middleColumnLayout.test.ts`（新增契约注释 + 断言）：会话态卡片内"与 textarea 同行的任何辅助文本槽位必须是 `basis-0`"——以类名字符串断言兜住。

**C 类（流程/事故回归，§7 incident 层 + §8 真实失败样本）**

11. Host 契约（`claudeRuntimeOptions.test.ts`）：**一次被受理的 `send` 恰好 emit 一次 `message.started{role:'user'}`**（钉死"回显=受理证据"的前提，防止未来把 `beginTurn` 挪位）。
12. 新增 incident case `retry-after-admitted-failure`：模拟「send 受理 → api_retry → TTFT 失败」，断言 **`chat.send` 调用总数 == 1**（Retry 不再自动第二次投递），且 UI 侧暴露 `restore-draft` 而非 `resend`。
13. 新增 incident case `stale-session-busy-after-admit`：在 `sendAndWait` 成功之后注入一条本会话的 `host.error{session_busy}`，断言不触发任何额外 `chat.send`。
14. 新增 incident case `retry-does-not-drain-queue`：队列因 `send-rejected` 暂停时点 Retry，断言队列**仍为 paused**、无自动放行。
15. 追踪指标（§13）：给 runSend 的 trace 加 `sendAttempts` 计数与 `origin`，报表里出现 `sendAttempts>1 && sawUserEcho` 即判失败。

---

## 5. 我不确定的点

1. **用户真机看到的重复形态**：代码可证 A1/A3/A4/A5 四条链路都会产生"两条"，但无法唯一定解。必须用 §1.4 的 O1–O6 取证（尤其 O1 的 message id 前缀与 O2 的 `message.started` 计数）。
2. **CLI 的 JSONL 是否已写入被中断那一轮的 user 行**：决定"模型是否真的看了两遍"。需直接读该会话的 transcript 文件确认；本诊断按"很可能写入"处理。
3. **Retry 实际走的是 resume 还是 create**：取决于点击时 Host 侧 `session.running` 是否已随 abort 落回 false（`claudeRuntime.ts:832-842` 的 `finally`）。走 create 会额外丢失会话连续性（新 runtimeIdentity），这是本轮附带发现、未展开的第三个缺陷。
4. **是否有并发 resume 参与**（A3 的触发前提）：需确认点验时是否点过左树会话项（`useResumeSession.ts:40`）。若无并发 resume，A3 在本次事故里只是潜在洞而非现场元凶——但仍应修。
5. **textarea 是否被压到严格 0 px 还是"极窄"**：CSS 收缩推导给出 0，但 `field-sizing-content`（`ui/textarea.tsx:31`）在个别引擎下的 intrinsic 贡献未实测；需 DevTools 量一次实际 `getBoundingClientRect().width` 坐实。结论方向不受影响。
6. **"直发撤销未受理武装"是否应改为自动入队**：涉及发送顺序语义变化（旧消息会排在新消息之后发出），属产品裁定，非纯工程判断。
7. **`shouldShowStatusLine` 改动的观感影响**：会话态出错时行内不再有 spinner/文案，仅剩横幅——需 D25 形态口径确认这不违反 A07 的状态可见性要求。
