# Retry 双发与错误态 Composer 占用诊断

诊断基线：`feat/openchamber-chat-refactor`，HEAD `8b45b03ab7320dcad5a5c148c566403d701f4488`。本报告只基于当前代码静态追踪；没有修改源码，也没有把无法静态确认的运行时顺序写成既成事实。

## 1. 缺陷 A 的双发触发链

### 1.1 结论：最符合现象的双发链是“原回合未终止 + Renderer 超时后武装 Retry + Retry 新建第二个逻辑回合”

第一发来自普通 Send。`handleSend()` 在可直发时把当前文本/附件快照交给 `runSend(..., origin: 'direct')`：

- `src/renderer/components/chat/ChatComposer.tsx:439-464`

  ```ts
  const handleSend = async () => {
    // ...
    if (action === 'send') {
      // ...
      const outcome = await runSend(trimmed, attachments.drafts, {
        clearComposerValue: true,
        origin: 'direct',
      });
  ```

`runSend()` 的实际 IPC 发送发生在 `sendAndWait()`；每次调用都会执行一次新的 `chat.send`：

- `src/renderer/components/chat/ChatComposer.tsx:939-948`

  ```ts
  const sendAndWait = async (): Promise<boolean> => {
    const sendResult = await window.electronAPI.chat.send({
      sessionId,
      text: trimmed,
      // ...
    });
    currentRequestId = sendResult?.requestId ?? null;
  ```

Main 侧也确实为每次调用生成新的 send `requestId` 并下发新的 `session.send`，所以 Renderer 再次调用不是对同一 IPC promise 的等待，而是一条新命令：

- `src/main/services/agent-host/AgentHostManager.ts:135-145`

  ```ts
  async sendMessage(
    payload: SessionSendCommand['payload'],
    requestId = nextRequestId('send')
  ): Promise<string> {
    await this.sendReady({
      requestId,
      type: 'session.send',
      payload,
    });
    return requestId;
  }
  ```

- `src/agent-host/index.ts:345-358`

  ```ts
  // Fire-and-forget: events stream on stdout while command loop continues.
  void rt.send({
    sessionId,
    text,
    // ...
    requestId: cmd.requestId,
  });
  ```

危险窗口出现在 Renderer 的等待预算耗尽之后。该分支明确选择“不 Stop 原 Host 回合”，因为它认为迟到的正确答案仍可能到达；但同一分支又生成文案 `Click Retry to resend`，并通过 `finalizeOutcome(timeoutOutcome)` 武装 Retry：

- `src/renderer/components/chat/ChatComposer.tsx:1175-1186`

  ```ts
  // the renderer is giving up on this turn ... a healthy turn can still land
  // ... this branch used to fire an implicit `chat.stop` here ...
  // the code must not press Stop FOR them
  ```

- `src/renderer/components/chat/ChatComposer.tsx:1217-1226`

  ```ts
  const abandonError = [
    'No assistant/tool progress after send ...',
    // ...
    `Click Retry to resend, or Stop — ${hint}`,
  ].join(' | ');
  useChatSessionsStore.setState({ lastError: abandonError });
  ```

- `src/renderer/components/chat/ChatComposer.tsx:1227-1256`

  ```ts
  const timeoutOutcome = decideRunEntryOutcome({
    fatalHostError: true,
    sawAssistantProgress,
    sawUserEcho,
  });
  if (timeoutOutcome === 'committed') {
    abandonMarkerRef.current = { sessionId, error: abandonError, committed, assistantCursor };
  }
  return finalizeOutcome(timeoutOutcome);
  ```

只要第一发已经出现用户回显，`decideRunEntryOutcome()` 就把它判为 `committed`；这表示 Host 已受理，而不是已经终止：

- `src/renderer/components/chat/queueRelease.ts:154-160`

  ```ts
  /** `message.started{role:'user'}` ... This is the only admission evidence. */
  sawUserEcho: boolean;
  ```

- `src/renderer/components/chat/queueRelease.ts:181-187`

  ```ts
  if (!input.fatalHostError) return 'committed';
  if (input.sawAssistantProgress || input.sawUserEcho) return 'committed';
  return 'rejected';
  ```

而 `finalizeOutcome()` 对 `committed` 也会武装 Retry；`shouldArmRetryable()` 只有 `rejected + release` 一个例外：

- `src/renderer/components/chat/ChatComposer.tsx:784-791`

  ```ts
  const finalizeOutcome = (outcome: RunEntryOutcome): RunEntryOutcome => {
    if (shouldArmRetryable(outcome, origin)) {
      setRetryable(committed);
    }
    // ...
  };
  ```

- `src/renderer/components/chat/queueRelease.ts:203-215`

  ```ts
  export function shouldArmRetryable(outcome, origin): boolean {
    return !(outcome === 'rejected' && origin === 'release');
  }
  ```

第二发来自用户点击 Retry。Retry 直接重用失败时保存的同一 `text + drafts` 快照，并以 `origin: 'retry'` 再次进入 `runSend()`：

- `src/renderer/components/chat/ChatComposer.tsx:586-603`

  ```ts
  const retryText = retryable?.text ?? /* failed-session fallback */;
  const retryDrafts = retryable?.drafts ?? [];
  ```

- `src/renderer/components/chat/ChatComposer.tsx:618-642`

  ```ts
  const handleRetry = async () => {
    if (!canRetry) return;
    setRetryable(null);
    const text = retryText ?? '';
    // ...
    const outcome = await runSend(text, retryDrafts, { origin: 'retry' });
  };
  ```

代码自身的注释已经承认该状态会导致 double-send，并尝试用“迟到进展后清 Retry”的 effect 缩短窗口：

- `src/renderer/components/chat/ChatComposer.tsx:258-264`

  ```ts
  // the 45s-abandon branch ... keeps the turn running server-side
  // ... clear the stale banner + retryable the moment real progress ... arrives,
  // instead of ... an armed Retry that would double-send.
  ```

- `src/renderer/components/chat/ChatComposer.tsx:1306-1310`

  ```ts
  // the 45s-abandon branch ... left [the turn] running server-side.
  // Once THIS session shows real NEW progress, clear ... Retry ...
  // ... a Retry that would double-send.
  ```

这个清理不是发送受理边界上的同步互斥，而是后续 React effect/raw-event listener：

- `src/renderer/components/chat/ChatComposer.tsx:1343-1353`

  ```ts
  useEffect(() => {
    const marker = abandonMarkerRef.current;
    // ...
    if (!landed) return;
    clearAbandonMarkerIfMatch(marker);
  }, [/* ... */]);
  ```

- `src/renderer/components/chat/ChatComposer.tsx:1364-1371`

  ```ts
  useEffect(() => {
    const unsubscribe = window.electronAPI.chat.onRuntimeEvent((event) => {
      const marker = abandonMarkerRef.current;
      if (!marker || !isSessionCompletedForSend(event, marker.sessionId)) return;
      clearAbandonMarkerIfMatch(marker);
    });
    return unsubscribe;
  }, [clearAbandonMarkerIfMatch]);
  ```

因此存在可证实的结构性竞态：第一发仍可能在 Host/SDK 中继续；Renderer 已结束 `sending` 并显示 Retry；用户点击后第二个 `runSend()` 立即清掉旧 marker，再发送相同快照。新发送开始时清 marker 的代码在：

- `src/renderer/components/chat/ChatComposer.tsx:721-735`

  ```ts
  setRetryable(null);
  // ...
  abandonMarkerRef.current = null;
  ```

这意味着一旦用户先点击 Retry，原回合之后到达的迟到进展不再有 marker 可用于取消第二发。最终可出现两个已受理回合：原回合的迟到用户/助手事件，以及 Retry 回合的新用户/助手事件。

### 1.2 `session_busy` 自动重试会产生多次 IPC send，但不是“Retry 按钮与自动重放同时可点”的主要证据

同一个 `runSend()` 遇到 `session_busy` 时会最多八次、每次等待 250ms 后再次调用 `sendAndWait()`：

- `src/renderer/components/chat/ChatComposer.tsx:1062-1087`

  ```ts
  let ok = await sendAndWait();
  let busyRetry = 0;
  while (fatalHostErrorCode === 'session_busy' && busyRetry < 8) {
    busyRetry += 1;
    // ...
    await sleep(250);
    // cancellation check
    ok = await sendAndWait();
  }
  ```

Host 的 `session_busy` gate 在 `beginTurn()` 之前直接返回，所以这些被拒请求不会产生用户回显，也不会成为两个已受理回合：

- `src/agent-host/claudeRuntime.ts:403-427`

  ```ts
  if (session.running) {
    this.opts.emit({
      type: 'host.error',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { code: 'session_busy', /* ... */ },
    });
    return;
  }
  ```

- `src/agent-host/claudeRuntime.ts:444-464`

  ```ts
  const queryFn = await this.ensureSdk();
  // ...
  session.running = true;
  // ...
  normalizer.beginTurn(input.text, input.attachments, input.requestId);
  ```

而自动 busy retry 进行期间 `sending === true`；`canRetry` 要求 `!sending`，动作按钮也会显示 Stop/Enqueue 而不是 Retry：

- `src/renderer/components/chat/ChatComposer.tsx:611-617`

  ```ts
  const canRetry =
    lastTurnFailed &&
    // ...
    !busy &&
    !sending &&
    attachments.reading === 0;
  ```

- `src/renderer/components/chat/queueRelease.ts:322-335`

  ```ts
  const canStop = isRunningStatus(input.status) || input.sending;
  if (canStop) return [{ kind: 'stop', disabled: false }, { kind: 'enqueue', /* ... */ }];
  if (input.hasFailed) return [{ kind: 'retry', disabled: false }, { kind: 'send', disabled: false }];
  ```

所以静态代码不支持“正常 busy-backoff 尚未结束时，用户同时点击了已启用 Retry”这一说法。它仍会制造多条不同 `requestId` 的 send 命令，但前七/八条应在 Host admission gate 被拒；真正的双受理仍需要另一个竞态或状态漂移。

### 1.3 队列 release 与 Retry 的职责当前是互斥的，未找到它们对同一 rejected entry 同时重放的生产路径

队列放行先弹出队首；若 `runEntry()` 返回 `skipped/rejected`，同一 entry 被恢复到队首：

- `src/renderer/components/chat/useQueueRelease.ts:64-93`

  ```ts
  const entry = useMessageQueueStore.getState().takeHead(sessionId);
  void runEntry(entry)
    .then((result) => {
      if (result === 'skipped' || result === 'rejected') {
        useMessageQueueStore.getState().restoreHead(entry);
      }
    })
    .catch(() => restoreHead(entry))
    .finally(() => { releasingRef.current = false; });
  ```

`release + rejected` 明确不武装 Retry，反而暂停队列，防止恢复后下一帧自动再放行：

- `src/renderer/components/chat/queueRelease.ts:203-215`
- `src/renderer/components/chat/queueRelease.ts:217-245`
- `src/renderer/components/chat/ChatComposer.tsx:784-790`

  ```ts
  if (shouldArmRetryable(outcome, origin)) setRetryable(committed);
  if (shouldPauseQueueOnRejection(outcome, origin)) {
    pauseSession(sessionId, 'send-rejected');
  }
  ```

`restoreHead()` 也只恢复原 entry 和 FIFO 顺序：

- `src/renderer/components/chat/messageQueue.ts:186-202`

  ```ts
  [entry.sessionId]: { ...bucket, entries: [entry, ...bucket.entries] }
  ```

因此，当前代码已经把“被拒的 release entry”恢复权交给队列，把“没有队列备份的 direct/retry”恢复权交给 Retry。未找到同一个 evidence-free rejected queue entry 同时进入本地 `retryable` 的生产代码。

补充风险：`activeSession.status === 'failed'` 时，Retry 文本会回退到时间线最后一条 user 消息，而不是暂停队列中的 entry（`ChatComposer.tsx:572-603`）。如果暂停队列里恰好还有同文案 entry，用户可能人为产生相同文本，但静态代码不能证明它就是本次真机“双发”的同一 payload；这项列入第 4 节动态核验。

### 1.4 `api_retry` 与 TTFT/stall watchdog 未发现 App 侧自动重放用户消息

SDK `system/api_retry` 只被记录并归一化为 `session.status.retry`；没有再次调用 `queryFn()`、`chat.send` 或 `session.send`：

- `src/agent-host/claudeRuntime.ts:703-712`

  ```ts
  if (eventType === 'system' && event.subtype === 'api_retry') {
    sawApiRetry = true;
  }
  // ...
  normalizer.ingest(event, input.requestId);
  ```

- `src/agent-host/eventNormalizer.ts:340-374`

  ```ts
  } else if (msg.subtype === 'api_retry') {
    this.emit({
      type: 'session.status',
      // ...
      payload: { status: 'running', retry: { /* ... */ } },
    });
  }
  ```

`queryFn()` 本身在一次 `claudeRuntime.send()` 中只创建一次 stream：

- `src/agent-host/claudeRuntime.ts:626-669`

  ```ts
  stream = queryFn({ prompt, options: { /* ... */ } });
  armStallTimer();
  ttftWatchdog.arm();
  ```

TTFT/stall watchdog 只会 `abort.abort()` 并最终发 failed，不会重放 prompt：

- `src/agent-host/claudeRuntime.ts:503-525`
- `src/agent-host/claudeRuntime.ts:553-603`

  ```ts
  stalled = true;
  abort.abort();
  ```

故未找到 `api_retry` 或 watchdog 在 App/Host 代码中自动发送第二份用户消息的证据。CLI/SDK 内部如何实现一次 query 内的网络重试不在本仓库可见范围内，但它不等价于 Renderer/Host 再创建一个用户回合。

## 2. 缺陷 B 的锁定谓词定位

### 2.1 当前代码没有“报错即 disabled textarea”的谓词

`ChatWorkspace` 传给 Composer 的 `disabled` 只取决于是否有 active session：

- `src/renderer/components/chat/ChatWorkspace.tsx:124-130`

  ```tsx
  <ChatComposer
    mode={mode}
    disabled={!activeSessionId}
    // ...
  />
  ```

textarea 本身也只在 `disabled || !activeSessionId` 时禁用；`lastError`、`failed`、`busy`、`sending` 都不在 disabled 表达式中：

- `src/renderer/components/chat/ChatComposer.tsx:1634-1639`

  ```tsx
  // only "nowhere to put this draft" still locks the textarea
  disabled={disabled || !activeSessionId}
  ```

普通 Enter 仍会进入 `handleSend()`：

- `src/renderer/components/chat/ChatComposer.tsx:1665-1672`

  ```ts
  if (event.key === 'Enter' && !event.shiftKey) {
    if (composingRef.current) return;
    event.preventDefault();
    void handleSend();
  }
  ```

失败态动作模型也明确返回 `Retry + Send` 两个按钮，而不是只返回 Retry：

- `src/renderer/components/chat/queueRelease.ts:317-336`

  ```ts
  if (input.hasFailed) {
    return [
      { kind: 'retry', disabled: false },
      { kind: 'send', disabled: false },
    ];
  }
  ```

`ChatComposer` 把 `canRetry` 作为 `hasFailed`，并分别把 Retry 映射到 `handleRetry()`、Send 映射到 `handleSend()`：

- `src/renderer/components/chat/ChatComposer.tsx:1694-1723`
- `src/renderer/components/chat/ChatComposer.tsx:1752-1766`

因此，“错误态只有 Retry、textarea 被 disabled”不能由当前 HEAD 静态代码证实。如果真机完全不能把字符写入 textarea，需要优先确认运行包是否确为 HEAD `8b45b03`，以及 DevTools 中 native `<textarea disabled>` 的实际值。

### 2.2 可证实的实际占用点：错误同时渲染为卡片上方 banner 和 Composer 同一横行的 statusLine，长错误会挤压输入区

错误首先作为独立 banner 渲染在 Composer 卡片上方；它没有替换整个 Composer：

- `src/renderer/components/chat/ChatComposer.tsx:1772-1787`

  ```tsx
  <ReadingColumn>
    {(lastError || !activeSessionId || !activeWorkspace || !cwd) && (
      <div className="mb-2 max-h-28 overflow-auto ...">
        {statusHint}
      </div>
    )}
    // Composer card continues below
  ```

但同一个 `lastError` 又使 `hasStatusError` 为真，并把完整 `Error: ${lastError}` 选为 statusLine：

- `src/renderer/components/chat/ChatComposer.tsx:391-403`

  ```ts
  const statusHint = /* ... */ lastError ? `Error: ${lastError}` : /* ... */;
  ```

- `src/renderer/components/chat/ChatComposer.tsx:1438-1467`

  ```ts
  const hasStatusError = Boolean(lastError || !activeSessionId || !activeWorkspace || !cwd);
  const statusLine = readingLine ?? (sending ? /* ... */ : (!hasStatusError && largeHint) || statusHint);
  ```

`shouldShowStatusLine()` 规定 session 模式只要有错误就显示该行；测试也把这个行为钉死：

- `src/renderer/components/chat/middleColumnLayout.ts:180-197`

  ```ts
  return input.sending || input.reading > 0 || input.hasStatusError || input.hasLargeHint;
  ```

- `src/renderer/components/chat/__tests__/middleColumnLayout.test.ts:338-348`

  ```ts
  it('shows it whenever the composer is in an error state', () => {
    expect(shouldShowStatusLine({ mode: 'session', hasStatusError: true, /* ... */ })).toBe(true);
  });
  ```

在 session 模式，textarea、statusLine、Model/Effort、动作按钮位于同一个横向 flex row：

- `src/renderer/components/chat/ChatComposer.tsx:1893-1908`

  ```tsx
  <div className="flex min-w-0 items-center gap-2">
    {textareaEl}
    {renderStatusLine('flex min-w-0 shrink items-center gap-1.5')}
    {modelEffortControls}
    {actionButtons}
  </div>
  ```

textarea 外层虽然是 `min-w-0 flex-1`，错误 status 也是可 shrink 的 flex item，但两者会竞争同一行宽度；Model/Effort 和两个动作按钮还占固定空间：

- `src/renderer/components/chat/middleColumnLayout.ts:120-137`

  ```ts
  return 'min-w-0 flex-1 ...';
  ```

因此可以静态确认：错误没有禁用 textarea，却会以“banner + composer 横行 status”重复出现；超长诊断（本代码会拼接 `rawEvents`、`hostAfter`、`sessionId`、`cwd`）在 follow-up 单行布局中会显著挤压空 textarea，使用户视觉上只剩错误和 Retry/Send 控件。这比“disabled 锁定”更符合当前代码。

建议把错误正文只放在卡片上方 banner/可展开详情中；session composer 横行只保留短状态（例如 `Send failed`）或完全不在错误态渲染 statusLine，把主要宽度稳定留给 textarea。

### 2.3 焦点丢失点：首次发送触发 empty → session 分支切换时，native textarea 位于不同 JSX 分支且没有焦点恢复

`runSend()` 通过 `onSendStart` 在首个 await 之前通知父组件：

- `src/renderer/components/chat/ChatComposer.tsx:741-746`

  ```ts
  onSendStart?.();
  ```

父组件把该 session 写进 sticky `sendAttempts`，随后 `deriveMiddleColumnMode()` 将模式切为 `session`：

- `src/renderer/components/chat/ChatWorkspace.tsx:52-73`

  ```ts
  const markSendAttempt = useCallback(() => {
    setSendAttempts((prev) => rememberSendAttempt(prev, currentSessionId));
  }, []);
  const mode = deriveMiddleColumnMode({
    sendAttempted: sendAttempts.includes(activeSessionId ?? ''),
    // ...
  });
  ```

- `src/renderer/components/chat/middleColumnLayout.ts:41-60`

  ```ts
  if (input.sendAttempted) return 'session';
  // ...
  if (input.status === 'failed') return 'session';
  ```

虽然 `<ChatComposer>` 组件实例只有一个，但 `textareaEl` 在 session/empty 模式被放进不同的条件分支和不同的父节点：

- `src/renderer/components/chat/ChatComposer.tsx:1893-1925`

  ```tsx
  {mode === 'session' ? (
    <div>
      <div>{textareaEl} ...</div>
    </div>
  ) : (
    <>
      {textareaEl}
      ...
    </>
  )}
  ```

当前唯一显式 `focus()` 只用于插入 @ mention 后恢复光标：

- `src/renderer/components/chat/ChatComposer.tsx:557-569`

  ```ts
  setTimeout(() => {
    ta.focus();
    ta.setSelectionRange(out.cursor, out.cursor);
  }, 0);
  ```

没有 mode 切换后的焦点恢复逻辑。根据 React reconciliation，这两个分支切换会重建 native textarea 的位置，存在丢失 DOM focus 的确定结构风险。是否恰好发生在本次“报错期间无法输入”的每一次复现，仍需 DevTools 动态确认；但首次发送同帧切 session mode 是当前代码中最明确的焦点丢失点。

### 2.4 与 T-19“运行中解禁输入 / FIFO / idle 自动放行”的关系

T-19 权威台账明确要求：运行中输入框不禁用、Enter 默认入队、每 session FIFO、idle 自动放行：

- `docs/plans/ledger-claude-mainline.md:108`

  > 输入框运行中从不禁用 / 回车默认入队 / 纯客户端 FIFO（每会话上限 20）/ idle 触发自动放行

点验清单也明确要求运行中可打字粘图、回车只入队、idle 后 FIFO 消费：

- `docs/plantree/plans/openchamber-chat-refactor/implementation-status.md:122`

`decideSendAction()` 的实现符合该设计：busy/sending/inFlight 时不是 blocked，而是 enqueue；只有无目标、全局 disabled、无内容或附件仍读取时 blocked：

- `src/renderer/components/chat/queueRelease.ts:53-63`

  ```ts
  if (!input.hasTarget || input.disabled) return 'blocked';
  if (!input.hasContent) return 'blocked';
  if (input.reading > 0) return 'blocked';
  if (input.busy || input.sending || input.inFlight) return 'enqueue';
  return 'send';
  ```

队列只在 `idle/completed` 自动放行，并尊重 pause：

- `src/renderer/components/chat/queueRelease.ts:120-132`

  ```ts
  if (input.paused != null) return { type: 'hold', reason: 'paused' };
  // ...
  if (input.status !== 'idle' && input.status !== 'completed') {
    return { type: 'hold', reason: 'not-idle' };
  }
  return { type: 'release', entryId: input.entries[0].id };
  ```

因此缺陷 B 不是 T-19 数据/调度层主动禁止输入，而是错误信息在 session 单行 Composer 中的布局占用，以及模式切换焦点稳定性没有与 T-19 的“持续可输入”体验一起闭环。若错误态 UI 让 textarea 实际不可见/难以聚焦，即使底层 `disabled=false`，产品行为仍与 T-19 的可输入承诺冲突。

## 3. 最小修复方案

### 3.1 去重权威层：Host admission 做最终幂等，Renderer attempt 状态机负责是否展示 Retry

建议分成一主一辅两道约束，避免只靠 React effect 消除竞态。

1. **最终幂等权威放在 Agent Host 的 `session.send` admission 边界。** Renderer/UI 无法可靠知道 SDK 回合是否仍在运行、是否刚完成、迟到事件是否已在 IPC/React 队列中；Host 的 `claudeRuntime.send()` 才持有 `session.running`、`beginTurn()` 和 query 生命周期（`src/agent-host/claudeRuntime.ts:403-464`）。应给每个“逻辑用户回合”增加稳定的 `clientTurnId`/`messageKey`：

   - direct 首发生成一次；
   - queue entry 可复用其稳定 entry id 或保存独立 turn id；
   - `session_busy` 的八次 transport/admission retry 必须复用同一个 id，而不是每次成为新的逻辑回合；
   - Host 对 `(sessionId, clientTurnId)` 记录 `rejected / admitted-active / terminal`，重复的 admitted-active/已成功 id 不再第二次 `beginTurn()`/`queryFn()`；
   - 真正终态失败后用户明确 Retry，应创建新的 attempt generation（或由 Host 明确允许 failed generation 重试），不能把所有历史同文本永久去重。文本哈希不能作为 key，因为用户合法地连续发送相同文本是允许的。

2. **Renderer 不应在“已受理但未证实终止”的 abandon 分支提供可立即重发的 Retry。** 当前 `sawUserEcho=true` 已证明 Host admission，且代码又明确不 Stop 原回合（`ChatComposer.tsx:1175-1256`）。最小行为修正应是：

   - `rejected`（无用户回显、无 assistant/tool/permission/terminal progress）才直接武装 Retry；
   - `committed + terminal failed/stopped` 才武装 Retry；
   - `committed + renderer timeout + Host 未证实 terminal` 显示“仍在后台等待 / Stop 后再重试”，保留 Stop，不把 Retry 当作安全动作；
   - 如果产品坚持允许此时 Retry，则点击 Retry 前必须先用同一 attempt identity 停止/确认旧回合终止，再启动下一 generation，不能“旧回合继续 + 新回合直接发”。

这比继续加 marker/effect 清理更可靠。当前 marker 清理只在迟到进展已经进入 React/raw-event 回调后生效，不能构成发送 admission 的原子互斥（`ChatComposer.tsx:1306-1371`）。

### 3.2 保持队列“不丢不重”的最小约束

修复不能破坏现有 origin 所有权：

- `release + rejected`：原 entry 恢复队首并暂停，不武装圆形 Retry；证据见 `useQueueRelease.ts:64-93`、`queueRelease.ts:203-245`。
- `direct/retry + rejected`：没有队列备份，武装本地 Retry；证据见 `queueRelease.ts:191-215`。
- 已有 user echo/assistant progress 的 `committed`：绝不能恢复同一 queue entry，否则会重复；证据见 `queueRelease.ts:137-187`。
- 恢复必须保持 FIFO；`restoreHead()` 和测试已钉住顺序：
  - `src/renderer/components/chat/messageQueue.ts:186-202`
  - `src/renderer/components/chat/__tests__/messageQueue.test.ts:209-244`
- `session_busy after create/resume + zero echo` 必须保持 `rejected`；现有回归测试：
  - `src/renderer/components/chat/__tests__/queueRelease.test.ts:599-613`
- origin→Retry/pause 的九组合真值表必须继续成立：
  - `src/renderer/components/chat/__tests__/queueRelease.test.ts:616-685`

需要新增一个跨组件/状态机测试，覆盖本次缺口：`direct admitted(user echo) → renderer timeout → original non-terminal → Retry action`。期望必须二选一且写死：Retry 不可用；或 Retry 先终止/复用同一 clientTurnId，Host 只 admission 一次。现有测试只覆盖纯函数真值表，`ChatComposer.tsx:648-667` 也明确承认 `.tsx` origin/finalize wiring 目前只是 inspection-verified。

### 3.3 报错态输入解禁与旧 Retry 的处置

最小 UI 行为建议：

1. 错误 banner 与可输入 Composer 始终并存。错误详情移出 session composer 的单行 flex row；该行只保留 textarea、Model/Effort 和动作按钮，或最多显示短错误摘要。不要用完整 `rawEvents/hostAfter/...` statusLine 与 textarea 争宽。
2. 失败态保留 `Retry + Send`，与当前 `deriveActionButtons()` 设计一致（`queueRelease.ts:330-335`）。用户输入新文本后点击 Send，应走 `origin:'direct'`，不是把新草稿附加到旧 Retry。
3. 新 direct 的 commit point 应原子地撤销旧 Retry/旧错误，并使旧 attempt 的迟到事件不能重新武装它。当前已有部分正确行为：新 `runSend()` 在首个 await 前执行 `setRetryable(null)`、清 `abandonMarkerRef`、清 `lastError`（`ChatComposer.tsx:721-739`）。修复时应把它提升为带 attempt id/generation 的显式状态转移，并增加测试，而不是依赖闭包对象引用。
4. 若旧状态代表“已受理但仍可能运行”，新消息应遵循 T-19：运行中就 enqueue；不能为了“新直发”绕过 active turn。等旧回合 terminal/Stop 后由 idle FIFO 放行。若旧状态已 terminal failed，则新消息可以 direct，并在 commit 时把旧 Retry 视为用户主动放弃，永久撤销。
5. empty→session 模式切换后恢复 textarea focus，或者重构为同一个稳定 DOM textarea 槽位只改 class/周边布局，避免 `ChatComposer.tsx:1893-1925` 的分支重挂载。该修复要保持 T-28 的模式布局，但不能牺牲 T-19“连续输入”的焦点契约。

## 4. 不确定点单列

1. **真机双发是否正好发生在 45s/附件扩展等待预算耗尽之后。** 静态代码确认该分支会“保留原回合 + 武装 Retry”，也确认代码作者将其标注为 double-send 风险；但报告没有附本次运行的时间戳、runtime event 序列或 Host log，无法静态确认用户点击时原回合处于 `running`、刚 `completed`，还是 store 已错误回落为 `idle`。需要动态记录：两次 `session.send` 的 `requestId`、同一 session 的 `message.started{role:user}` 次数、Retry 点击时 `session.status/sending/retryable/abandonMarker`。
2. **Retry 可见时 `busy` 为什么为 false。** `canRetry` 明确要求 `!busy && !sending`（`ChatComposer.tsx:611-617`）；正常仍-running Host 回合应让动作区显示 Stop/Enqueue，而非 Retry。可能是原回合刚 terminal、状态事件先到而迟到 assistant 事件后到，也可能是状态收敛错误；仅靠静态阅读无法选定。应在事件日志中对齐 `session.status`、`session.completed/failed/stopped`、user/assistant message 事件顺序。
3. **“输入框被报错占用”是视觉挤压、焦点丢失，还是实际 DOM disabled。** 当前 HEAD 的 native textarea disabled 只由 active session 决定，且错误态动作模型是 Retry+Send；所以“错误直接锁 textarea”未找到代码证据。需要 DevTools 检查 native textarea 的 `disabled`、client width、activeElement，以及运行包 commit/version。若 `disabled=false` 但宽度接近 0，支持本报告的 statusLine 挤压结论；若 DOM 被 disabled，则说明还有未纳入当前仓库的外层/旧构建逻辑。
4. **empty→session 分支切换是否就是本次焦点丢失。** JSX 结构存在重挂载风险且无 focus restoration，但错误发生时会话通常已经处于 session mode；如果用户是在既有会话失败后复现，焦点问题可能只发生于此前首发，而非错误出现瞬间。需要用 `document.activeElement` 或 React Profiler/DOM mutation 观察复现路径。
5. **暂停队列中是否存在与 status-failed Retry 回退文本完全相同的 entry。** `activeSession.status==='failed'` 时 Retry 会取时间线最后一条 user 文本（`ChatComposer.tsx:572-603`），而 release-rejected entry 会恢复队首并暂停。静态代码没有把该 entry 同时写入 `retryable`，所以不能断言这就是双发；但若用户/历史数据中恰有同文案，点击 Retry 后新 turn 清 pause（`ChatComposer.tsx:760-765`），后续队列仍可能发送另一个同文案 entry。需要抓取 queue entry id/text 与 Retry snapshot identity 才能排除。
6. **CLI/SDK 内部 `api_retry` 是否在一次 query 内部对上游重复提交并产生供应商侧重复副作用。** 本仓库只看得到一个 `queryFn()` stream 和 `system/api_retry` 控制事件，未找到 App/Host 创建第二用户回合的代码；SDK 内部网络协议与服务端幂等不可由本仓库静态确认。该问题与 UI 时间线出现两条 user echo 应分开诊断。

