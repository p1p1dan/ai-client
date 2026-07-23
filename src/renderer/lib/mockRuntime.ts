import type { RuntimeEvent, SessionRuntimeStatus } from '@shared/types/runtimeEvents';

type RuntimeEventHandler = (event: RuntimeEvent) => void;

let seq = 0;
const handlers = new Set<RuntimeEventHandler>();

function nextSeq(): number {
  seq += 1;
  return seq;
}

function emit(event: Omit<RuntimeEvent, 'seq' | 'timestamp'>): void {
  const fullEvent = {
    ...event,
    seq: nextSeq(),
    timestamp: Date.now(),
  } as RuntimeEvent;

  for (const handler of handlers) {
    handler(fullEvent);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function subscribeMockRuntime(handler: RuntimeEventHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function emitSessionStatus(sessionId: string, status: SessionRuntimeStatus): void {
  emit({
    type: 'session.status',
    sessionId,
    payload: { status },
  });
}

/** Simulates idle → running → text delta → tool → permission → completed. */
export async function runMockConversation(sessionId: string, userText: string): Promise<void> {
  emitSessionStatus(sessionId, 'starting');
  await delay(250);
  emitSessionStatus(sessionId, 'running');

  const userMessageId = `msg-user-${Date.now()}`;
  const userBlockId = `${userMessageId}-text`;

  emit({
    type: 'message.started',
    sessionId,
    payload: { messageId: userMessageId, role: 'user' },
  });
  emit({
    type: 'message.delta',
    sessionId,
    payload: { messageId: userMessageId, blockId: userBlockId, text: userText },
  });
  emit({
    type: 'message.completed',
    sessionId,
    payload: { messageId: userMessageId },
  });

  await delay(350);

  const assistantMessageId = `msg-asst-${Date.now()}`;
  const assistantBlockId = `${assistantMessageId}-text`;

  emit({
    type: 'message.started',
    sessionId,
    payload: { messageId: assistantMessageId, role: 'assistant' },
  });

  const chunks = [
    'Got it. ',
    "I'll inspect the workspace ",
    'and suggest next steps. ',
    'Reading key files now...',
  ];

  for (const chunk of chunks) {
    await delay(90);
    emit({
      type: 'message.delta',
      sessionId,
      payload: {
        messageId: assistantMessageId,
        blockId: assistantBlockId,
        text: chunk,
      },
    });
  }

  await delay(200);

  const toolCallId = `tool-${Date.now()}`;
  emit({
    type: 'tool.started',
    sessionId,
    payload: {
      messageId: assistantMessageId,
      toolCallId,
      name: 'Read',
      input: { path: 'src/renderer/App.tsx' },
    },
  });

  await delay(450);

  emit({
    type: 'tool.completed',
    sessionId,
    payload: {
      messageId: assistantMessageId,
      toolCallId,
      ok: true,
      output: '2043 lines',
    },
  });

  await delay(250);

  const permissionId = `perm-${Date.now()}`;
  emit({
    type: 'permission.requested',
    sessionId,
    payload: {
      permissionId,
      toolName: 'Bash',
      description: 'Run pnpm typecheck',
      input: { command: 'pnpm typecheck' },
    },
  });
  emitSessionStatus(sessionId, 'waiting_permission');
}

export async function continueMockAfterPermission(
  sessionId: string,
  assistantMessageId: string,
  allow: boolean,
  permissionId: string
): Promise<void> {
  emit({
    type: 'permission.resolved',
    sessionId,
    payload: { permissionId, allow },
  });

  if (!allow) {
    emitSessionStatus(sessionId, 'idle');
    return;
  }

  emitSessionStatus(sessionId, 'running');
  await delay(200);

  const blockId = `${assistantMessageId}-tail`;
  emit({
    type: 'message.delta',
    sessionId,
    payload: {
      messageId: assistantMessageId,
      blockId,
      text: '\n\nPermission granted. Typecheck passed.',
    },
  });

  await delay(300);
  emit({
    type: 'message.completed',
    sessionId,
    payload: { messageId: assistantMessageId },
  });
  emitSessionStatus(sessionId, 'completed');
}
