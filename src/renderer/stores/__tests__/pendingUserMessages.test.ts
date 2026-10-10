import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chatSessions';
import {
  isAwaitingDeliveryMessage,
  isPendingUserMessage,
  mergePendingUserRows,
  type PendingUserMessage,
  pendingUserToChatMessage,
  usePendingUserMessagesStore,
} from '../pendingUserMessages';

function pending(overrides: Partial<PendingUserMessage> = {}): PendingUserMessage {
  return {
    attemptId: 'attempt-1',
    sessionId: 's1',
    text: 'hi',
    attachments: [],
    startedAt: 100,
    ...overrides,
  };
}

beforeEach(() => {
  usePendingUserMessagesStore.setState({ bySession: {} });
});

describe('pending user message reconciliation', () => {
  it('publishes by stable attempt id and clears exactly that attempt', () => {
    const store = usePendingUserMessagesStore.getState();
    store.publish(pending());
    store.publish(pending({ attemptId: 'attempt-2', text: 'same text' }));

    expect(usePendingUserMessagesStore.getState().bySession.s1).toHaveLength(2);

    usePendingUserMessagesStore.getState().clear('attempt-1');

    expect(
      usePendingUserMessagesStore.getState().bySession.s1?.map((item) => item.attemptId)
    ).toEqual(['attempt-2']);
  });

  it('pairs identical consecutive prompts by exact attempt even when echoes arrive out of order', () => {
    const store = usePendingUserMessagesStore.getState();
    store.publish(pending());
    store.publish(pending({ attemptId: 'attempt-2', text: 'hi' }));

    usePendingUserMessagesStore.getState().acknowledgeAttempt('s1', 'attempt-2', 'echo-2');
    expect(usePendingUserMessagesStore.getState().bySession.s1).toEqual([
      expect.objectContaining({ attemptId: 'attempt-1' }),
      expect.objectContaining({ attemptId: 'attempt-2', authoritativeMessageId: 'echo-2' }),
    ]);
    expect(
      usePendingUserMessagesStore.getState().bySession.s1?.[0]?.authoritativeMessageId
    ).toBeUndefined();

    usePendingUserMessagesStore.getState().acknowledgeAttempt('s1', 'attempt-1', 'echo-1');
    usePendingUserMessagesStore.getState().acknowledgeAttempt('s1', 'attempt-1', 'echo-redelivery');
    usePendingUserMessagesStore.getState().acknowledgeAttempt('s2', 'attempt-1', 'wrong-session');

    expect(usePendingUserMessagesStore.getState().bySession.s1).toEqual([
      expect.objectContaining({ attemptId: 'attempt-1', authoritativeMessageId: 'echo-1' }),
      expect.objectContaining({ attemptId: 'attempt-2', authoritativeMessageId: 'echo-2' }),
    ]);
  });

  it('converts to a display-only user message with attachment metadata', () => {
    const converted = pendingUserToChatMessage(
      pending({
        attachments: [{ kind: 'image', mediaType: 'image/png', name: 'shot.png' }],
      })
    );

    expect(isPendingUserMessage(converted)).toBe(true);
    expect(converted.role).toBe('user');
    expect(converted.blocks).toEqual([
      { id: 'pending-user-block:attempt-1', type: 'text', text: 'hi' },
    ]);
    expect(converted.attachments).toEqual([
      { kind: 'image', mediaType: 'image/png', name: 'shot.png' },
    ]);
  });

  it('prunes attempts whose session no longer exists', () => {
    const store = usePendingUserMessagesStore.getState();
    store.publish(pending());
    store.publish(pending({ attemptId: 'attempt-2', sessionId: 's2' }));

    usePendingUserMessagesStore.getState().pruneSessions(['s2']);

    expect(usePendingUserMessagesStore.getState().bySession).toEqual({
      s2: [expect.objectContaining({ attemptId: 'attempt-2' })],
    });
  });

  it('[P1-4c1] a Ctrl+Enter message awaiting delivery is still a pending row, told apart', () => {
    const sending = pendingUserToChatMessage(pending());
    const awaiting = pendingUserToChatMessage(
      pending({ attemptId: 'interject-1', text: 'also this', awaitingDelivery: true })
    );
    expect(isPendingUserMessage(awaiting)).toBe(true);
    expect(isAwaitingDeliveryMessage(awaiting)).toBe(true);
    expect(isAwaitingDeliveryMessage(sending)).toBe(false);
    // Retired by its echo exactly like a send's bubble.
    const store = usePendingUserMessagesStore.getState();
    store.publish(pending({ attemptId: 'interject-1', awaitingDelivery: true }));
    usePendingUserMessagesStore.getState().acknowledgeAttempt('s1', 'interject-1', 'dsh-user-7');
    expect(usePendingUserMessagesStore.getState().bySession.s1?.[0]).toMatchObject({
      authoritativeMessageId: 'dsh-user-7',
      awaitingDelivery: true,
    });
  });
});

describe('mergePendingUserRows (issue #8, decision 172)', () => {
  const stored = (id: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({
    id,
    sessionId: 's1',
    role,
    blocks: [],
  });
  const BUCKET = [stored('u1'), stored('a1', 'assistant')];

  it('hands back the store rows themselves when nothing is pending', () => {
    const merged = mergePendingUserRows(BUCKET, []);
    expect(merged.rows).toBe(BUCKET);
    expect(merged.awaitingDelivery).toEqual([]);
  });

  it('a pending send is a turn row; a Ctrl+Enter message awaiting delivery is not', () => {
    const merged = mergePendingUserRows(BUCKET, [
      pending({ attemptId: 'interject-1', text: 'also this', awaitingDelivery: true }),
      pending({ attemptId: 'attempt-2', text: 'next prompt' }),
    ]);
    expect(merged.rows.map((row) => row.id)).toEqual(['u1', 'a1', 'pending-user:attempt-2']);
    expect(merged.awaitingDelivery.map((row) => row.id)).toEqual([
      'pending-user:steer:interject-1',
    ]);
    // Only awaiting rows: the store's rows go through untouched, so the turns
    // cut from them — and the running one among them — keep their identity.
    const waiting = mergePendingUserRows(BUCKET, [
      pending({ attemptId: 'interject-1', awaitingDelivery: true }),
    ]);
    expect(waiting.rows).toBe(BUCKET);
    expect(waiting.awaitingDelivery).toHaveLength(1);
  });

  it('a row leaves once the message its echo named is in the store, not before', () => {
    const acknowledged = pending({
      attemptId: 'interject-1',
      awaitingDelivery: true,
      authoritativeMessageId: 'dsh-user-7',
    });
    // Acknowledged on the wire, not yet flushed into the store: still drawn.
    expect(mergePendingUserRows(BUCKET, [acknowledged]).awaitingDelivery).toHaveLength(1);
    // The echo is in: the store's own row stands where DSH took it in.
    const delivered = [...BUCKET, stored('dsh-user-7')];
    const merged = mergePendingUserRows(delivered, [acknowledged]);
    expect(merged.awaitingDelivery).toEqual([]);
    expect(merged.rows).toBe(delivered);
  });
});
