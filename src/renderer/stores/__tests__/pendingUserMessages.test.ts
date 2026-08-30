import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chatSessions';
import {
  hasAuthoritativeUserEcho,
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
    baselineMessageId: null,
    startedAt: 100,
    ...overrides,
  };
}

function message(id: string, role: ChatMessage['role']): ChatMessage {
  return { id, sessionId: 's1', role, blocks: [] };
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

  it('recognises only an authoritative user message after the commit baseline', () => {
    const item = pending({ baselineMessageId: 'old-assistant' });

    expect(
      hasAuthoritativeUserEcho(
        [message('old-user', 'user'), message('old-assistant', 'assistant')],
        item
      )
    ).toBe(false);
    expect(
      hasAuthoritativeUserEcho(
        [
          message('old-user', 'user'),
          message('old-assistant', 'assistant'),
          message('new-user', 'user'),
        ],
        item
      )
    ).toBe(true);
  });

  it('does not guess when a non-null baseline disappeared during a history replacement', () => {
    expect(
      hasAuthoritativeUserEcho(
        [message('new-user', 'user')],
        pending({ baselineMessageId: 'missing' })
      )
    ).toBe(false);
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
