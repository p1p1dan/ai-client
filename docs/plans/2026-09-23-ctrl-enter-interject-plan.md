# Ctrl+Enter 插话实现计划

> **目标**：Agent 执行中，用户按 Ctrl+Enter 可在不中断当前执行的前提下，于下一个安全边界（turn 结束）优雅停止，然后自动发送插话消息。
> **模型**：Claude Code 优先级队列 — Enter = later（排队等待），Ctrl+Enter = next（当前 turn 完成后停止并发送），"立即发送" = now（中止当前 turn 后立即发送）。

---

## 数据流总览

```
Ctrl+Enter
  ↓
ChatComposer.handleInterject()
  ↓ enqueue({ priority: 'next' }) + interjectSession() IPC
  ↓
Main IPC → WorkerManager.interject(sessionId)
  ↓ worker.interject RPC
NativeWorkerRuntime.interject()
  ↓ agentLoop.interject() → 设置 _interjected 标志
  ↓
Agent loop 当前 iteration 结束
  ↓ shouldStopAfterTurn() 检查标志 → return true
  ↓
loop 退出 → session → idle
  ↓
useQueueRelease 检测到 idle + 队列有 entry
  ↓ takeHead → runSend → 新 turn 开始
```

---

## Phase 1: 数据模型 — `messageQueue.ts`

### 1.1 给 `QueuedMessage` 加 `priority` 字段

```typescript
// src/renderer/components/chat/messageQueue.ts

export type MessagePriority = 'next' | 'later';

export interface QueuedMessage {
  id: string;
  sessionId: string;
  text: string;
  attachments: readonly AttachmentDraft[];
  queuedAt: number;
  failure?: { message: string };
  /**
   * 'next' = Ctrl+Enter 插话，当前 turn 完成后优先发送
   * 'later' = 普通排队（默认）
   */
  priority?: MessagePriority;
}
```

### 1.2 新增 `interject` reducer

类似 `enqueue`，但设置 `priority: 'next'` 并返回新 entry 的 id（供 UI 高亮）。

```typescript
export function interject(
  state: MessageQueueState,
  message: QueuedMessage,
  limits: EnqueueLimits = DEFAULT_ENQUEUE_LIMITS
): EnqueueResult {
  // 复用 enqueue 逻辑，但强制 priority: 'next'
  const result = enqueue(state, { ...message, priority: 'next' }, limits);
  return result;
}
```

> **注意**：实际上可以直接用 `enqueue` + 在调用处设置 `priority: 'next'`，不需要单独的 reducer。但为了语义清晰和未来的扩展（如 interject 可能有不同的限制），保留独立函数。

---

## Phase 2: Store — `stores/messageQueue.ts`

添加 `interject` action：

```typescript
// src/renderer/stores/messageQueue.ts

interject: (message: QueuedMessage) => EnqueueResult;

// 实现
interject: (message) => {
  const result = interject(get().state, message);
  if (result.ok) set({ state: result.state });
  return result;
},
```

---

## Phase 3: 键盘快捷键 — `ChatComposer.tsx`

### 3.1 新增 `handleInterject` 函数

```typescript
const handleInterject = async () => {
  const trimmed = value.trim();
  if (!trimmed && attachments.drafts.length === 0) return;
  if (!activeSessionId) return;

  // 如果空闲，直接发送（同 Enter）
  const action = decideSendAction({ ... });
  if (action === 'send') {
    void handleSend();
    return;
  }
  if (action === 'blocked') return;

  // 忙碌中：入队 + 发 interject 信号
  const entry: QueuedMessage = {
    id: crypto.randomUUID(),
    sessionId: activeSessionId,
    text: trimmed,
    attachments: attachments.drafts,
    queuedAt: Date.now(),
    priority: 'next',
  };
  const result = useMessageQueueStore.getState().interject(entry);
  if (!result.ok) return;

  updateValue('');
  attachments.clearDrafts();

  // 通知 worker 在下一个 turn 边界优雅停止
  await window.electronAPI.chat.interject({ sessionId: activeSessionId });
};
```

### 3.2 键盘绑定

在现有 Enter 处理之前加 Ctrl+Enter 分支：

```typescript
// 在 onKeyDown 中，Enter 处理之前
if (event.key === 'Enter' && event.ctrlKey && !event.shiftKey && !event.altKey) {
  if (composingRef.current) return;
  event.preventDefault();
  void handleInterject();
  return;
}

// 现有 Enter 处理（不变）
if (event.key === 'Enter' && !event.shiftKey) {
  ...
}
```

> **注意**：macOS 上 Ctrl+Enter 可能不习惯，可考虑同时支持 Cmd+Enter（`event.metaKey`）。但 Claude Code 用的是 Ctrl+Enter，先保持一致。

---

## Phase 4: IPC 通道

### 4.1 添加 channel 常量

```typescript
// src/shared/types/ipc.ts

CHAT_INTERJECT: 'chat:interject',
```

### 4.2 Preload 暴露

```typescript
// src/preload/index.ts

interject: (payload: { sessionId: string }): Promise<{ requestId: string }> =>
  ipcRenderer.invoke(IPC_CHANNELS.CHAT_INTERJECT, payload),
```

### 4.3 Main IPC handler

```typescript
// src/main/ipc/chat.ts

ipcMain.handle(
  IPC_CHANNELS.CHAT_INTERJECT,
  async (e, payload: { sessionId: string }): Promise<{ requestId: string }> => {
    claimSessionForSender(e, payload.sessionId);
    const requestId = await workerManager.interject(payload.sessionId);
    return { requestId };
  }
);
```

---

## Phase 5: WorkerManager — `interject()` 方法

```typescript
// src/main/services/agent-host/WorkerManager.ts

async interject(sessionId: string): Promise<string> {
  const requestId = nextRequestId('interject');
  const entry = this.entriesBySession.get(sessionId);
  // 没有活跃的 worker 或 session 未就绪，静默成功（同 stop 的行为）
  if (!entry?.slot || entry.state !== 'ready') return requestId;
  entry.lastUsedAt = this.now();
  const payload: WorkerInterjectPayload = { logicalSessionId: sessionId };
  const result = await entry.slot.request<WorkerInterjectResult, WorkerInterjectPayload>(
    'worker.interject',
    payload
  );
  if (!isWorkerInterjectResult(result)) {
    throw new WorkerManagerError(
      'worker_invalid_interject_ack',
      'Pi worker returned an invalid interject acknowledgement'
    );
  }
  return requestId;
}
```

---

## Phase 6: Worker RPC 类型

```typescript
// src/shared/types/workerRpc.ts

export interface WorkerInterjectPayload {
  logicalSessionId: string;
}

export interface WorkerInterjectResult {
  interjected: boolean;
}
```

在 RPC 类型联合中添加 `'worker.interject'`。

---

## Phase 7: Worker RPC Server — 处理 `worker.interject`

```typescript
// src/agent-host/piWorkerRpcServer.ts

// dispatch() 中添加 case
case 'worker.interject':
  await this.handleInterject(request);
  break;

// 新增 handler
private async handleInterject(request: WorkerRpcRequest): Promise<void> {
  if (!this.runtime) {
    this.respondSuccess(request, { interjected: false });
    return;
  }
  const interjected = await this.runtime.interject(request.payload);
  this.respondSuccess(request, { interjected });
}
```

---

## Phase 8: NativeWorkerRuntime — `interject()` 方法

```typescript
// src/runtime/worker/nativeWorkerRuntime.ts

async interject(input: WorkerInterjectPayload): Promise<WorkerInterjectResult> {
  this.assertLogicalSession(input.logicalSessionId);
  const turn = this.turn;
  if (!turn) return { interjected: false };

  // 通过 AgentLoopPlugin 设置标志
  const loop = this.requireHandle().loop;
  if (loop && typeof (loop as any).interject === 'function') {
    (loop as AgentLoopPlugin).interject();
  }
  return { interjected: true };
}
```

> **类型安全改进**：在 `AgentLoopService` 接口中添加可选的 `interject?(): void` 方法，避免 `as any` 转型。

---

## Phase 9: AgentLoopPlugin — 核心机制

### 9.1 添加 `interject()` 方法和标志

```typescript
// src/runtime/plugins/agent-loop/index.ts

export class AgentLoopPlugin extends Service implements AgentLoopService {
  private _interjected = false;

  /**
   * 标记当前 turn 完成后应停止。
   * 由 worker.interject RPC 触发，在 shouldStopAfterTurn 中消费。
   * 一次性标志：被 shouldStopAfterTurn 读取后自动清除。
   */
  interject(): void {
    this._interjected = true;
  }

  // ... 现有代码
}
```

### 9.2 修改 `shouldStopAfterTurn` 回调

```typescript
// 在 run() 方法中，shouldStopAfterTurn 回调添加 interject 检查
shouldStopAfterTurn: () => {
  // 插话检查：用户按了 Ctrl+Enter，当前 turn 完成后优雅退出
  if (this._interjected) {
    this._interjected = false;  // 消费标志
    trace.note('note', { event: 'turn_stopped_by_interjection' });
    return true;
  }
  // 现有逻辑
  if (this.config.singleTurn || ceiling !== 'none') return true;
  turns += 1;
  if (turns < this.config.turnCeiling) return false;
  ceiling = 'reached';
  trace.note('note', { event: 'turn_ceiling_reached', turns });
  return true;
},
```

---

## Phase 10: 队列释放 — 自动衔接

**无需修改**。现有 `useQueueRelease` + `decideQueueRelease` 机制已经处理：

1. Agent loop 退出 → session status → `'idle'`
2. `useQueueRelease` effect 触发
3. `decideQueueRelease` 检查：`status === 'idle'` ✓，`entries.length > 0` ✓
4. 返回 `{ type: 'release', entryId }`
5. `releaseQueueHead` → `takeHead` → `runSend` → 新 turn 开始

**关键点**：`priority: 'next'` 的 entry 和普通 entry 在释放逻辑上没有区别。区别仅在于：
- 插话消息会触发 `worker.interject` 信号，导致当前 turn 优雅停止
- 普通排队消息不会触发信号，需要等 turn 自然结束

---

## Phase 11: UI 反馈（可选，建议后续迭代）

### 11.1 队列条中标记插话消息

在 `QueueStrip` 组件中，`priority: 'next'` 的 entry 显示特殊标记（如 ⚡ 图标或不同颜色），让用户区分插话和普通排队。

### 11.2 按钮变化

当 turn 运行中，输入框下方可显示 "Ctrl+Enter 插话" 提示，替代或补充现有的 "Enter 发送" 提示。

---

## 测试计划

### 单元测试

1. **`messageQueue.test.ts`**：
   - `interject` 创建的 entry 有 `priority: 'next'`
   - 多个 interject entry 保持 FIFO 顺序

2. **`queueRelease.test.ts`**：
   - `priority: 'next'` 的 entry 在 idle 时正常释放（与 'later' 行为一致）

3. **`agent-loop` 测试**：
   - `interject()` 设置标志
   - `shouldStopAfterTurn` 消费标志后返回 true
   - 标志被消费后自动清除，不影响后续 turn

### 集成测试

1. **插话流程**：
   - 启动一个长 turn（多工具调用）
   - 按 Ctrl+Enter 输入消息
   - 验证：当前 turn 完成后停止，新 turn 自动开始

2. **多次插话**：
   - 连续按两次 Ctrl+Enter
   - 验证：第一次 turn 完成后停止，第一条消息发送
   - 第二条消息留在队列中，等第二次 turn 完成后释放

3. **空闲时插话**：
   - 空闲状态按 Ctrl+Enter
   - 验证：行为与普通 Enter 相同（直接发送）

4. **与 "Send now" 对比**：
   - "Send now"：立即中止当前 turn
   - Ctrl+Enter：等当前 turn 完成后停止

---

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/renderer/components/chat/messageQueue.ts` | 修改 | 添加 `MessagePriority` 类型，`QueuedMessage.priority` 字段，`interject()` reducer |
| `src/renderer/stores/messageQueue.ts` | 修改 | 添加 `interject` action |
| `src/renderer/components/chat/ChatComposer.tsx` | 修改 | 添加 `handleInterject`，Ctrl+Enter 键盘绑定 |
| `src/shared/types/ipc.ts` | 修改 | 添加 `CHAT_INTERJECT` channel |
| `src/preload/index.ts` | 修改 | 添加 `chat.interject` API |
| `src/main/ipc/chat.ts` | 修改 | 添加 `CHAT_INTERJECT` handler |
| `src/main/services/agent-host/WorkerManager.ts` | 修改 | 添加 `interject()` 方法 |
| `src/shared/types/workerRpc.ts` | 修改 | 添加 `WorkerInterjectPayload`/`Result` 类型 |
| `src/agent-host/piWorkerRpcServer.ts` | 修改 | 添加 `worker.interject` dispatch case 和 handler |
| `src/runtime/worker/nativeWorkerRuntime.ts` | 修改 | 添加 `interject()` 方法 |
| `src/runtime/plugins/agent-loop/index.ts` | 修改 | 添加 `_interjected` 标志，`interject()` 方法，修改 `shouldStopAfterTurn` |

---

## 风险与注意事项

1. **Agent loop 粒度**：当前 iteration 边界是「一个完整 assistant turn + 其所有工具调用」，不是单个工具调用之间。这意味着 Ctrl+Enter 后，当前正在执行的工具会跑完，然后整个 turn 结束才停止。这是设计决策，不是 bug。

2. **`shouldStopAfterTurn` 顺序**：在 agent-loop.js 中，`shouldStopAfterTurn` 在 steering message poll 之前。如果返回 true，steering 消息不会被消费，留在队列中供下次 `prompt()` 使用。这正好是我们需要的行为。

3. **多次 interject 信号**：`_interjected` 是布尔标志，多次设置是幂等的。第一个 turn 完成后消费标志，后续消息通过正常队列释放。

4. **资源约束**：本实现不涉及重型操作，无 OOM 风险。

5. **向后兼容**：`priority` 字段可选，默认 `'later'`。现有队列 entry 无需迁移。

---

## 实现顺序建议

1. **Phase 1-2**：数据模型 + Store（纯逻辑，可独立测试）
2. **Phase 9**：AgentLoopPlugin 核心机制（可独立测试）
3. **Phase 6-8**：RPC 链路（类型 + Worker 侧）
4. **Phase 4-5**：IPC 链路（Main 侧）
5. **Phase 3**：UI 集成（ChatComposer）
6. **Phase 10-11**：验证队列释放 + UI 反馈

每个 Phase 完成后跑 typecheck + 相关测试，确保不引入回归。
