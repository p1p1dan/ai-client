import { beforeEach, describe, expect, it } from 'vitest';
import {
  isPendingUserMessage,
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
});
