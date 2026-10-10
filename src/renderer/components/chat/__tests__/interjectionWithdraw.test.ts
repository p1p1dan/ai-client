// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentDraft } from '@/components/chat/attachments';
import { resetComposerDraftsForTests, useComposerDraftsStore } from '@/stores/composerDrafts';
import { type PendingUserMessage, usePendingUserMessagesStore } from '@/stores/pendingUserMessages';
import { onComposerFocusRequest } from '../composerFocus';
import { withdrawInterjection } from '../interjectionWithdraw';

/**
 * GitHub issue #8 (dsh-rebase decision 172 §4): what the awaiting bubble's
 * 「撤回」 does with each answer the engine can give.
 */

const IMAGE: AttachmentDraft = {
  id: 'att-1',
  kind: 'image',
  mediaType: 'image/png',
  name: 'shot.png',
  byteLength: 4,
  data: 'AAAA',
};

function awaiting(overrides: Partial<PendingUserMessage> = {}): PendingUserMessage {
  return {
    attemptId: 'interject-1',
    sessionId: 's1',
    text: 'also run lint',
    attachments: [{ kind: 'image', mediaType: 'image/png', name: 'shot.png' }],
    startedAt: 0,
    awaitingDelivery: true,
    drafts: [IMAGE],
    ...overrides,
  };
}

const row = () => usePendingUserMessagesStore.getState().bySession.s1?.[0];
const answer = (outcome: 'withdrawn' | 'delivered' | 'not_found') =>
  vi.fn(async () => ({ outcome }));

let focused: string[] = [];
let stopListening: () => void = () => undefined;

beforeEach(() => {
  usePendingUserMessagesStore.setState({ bySession: {} });
  resetComposerDraftsForTests();
  focused = [];
  stopListening = onComposerFocusRequest(
    () => 's1',
    () => focused.push('s1')
  );
});

afterEach(() => stopListening());

describe('withdrawInterjection', () => {
  it('[I8-W1] withdrawn: the bubble goes, its words and attachments go back to its box', async () => {
    usePendingUserMessagesStore.getState().publish(awaiting());
    const ask = answer('withdrawn');

    await expect(withdrawInterjection('s1', 'interject-1', ask)).resolves.toEqual({
      outcome: 'withdrawn',
    });
    expect(ask).toHaveBeenCalledWith({ sessionId: 's1', attemptId: 'interject-1' });
    expect(row()).toBeUndefined();
    const drafts = useComposerDraftsStore.getState();
    expect(drafts.offered).toEqual({ s1: 'also run lint' });
    expect(drafts.offeredAttachments).toEqual({ s1: [IMAGE] });
    // The box takes the keyboard, so the words can be edited straight away.
    expect(focused).toEqual(['s1']);
  });

  it('[I8-W2] while the engine is asked, a second press does nothing', async () => {
    usePendingUserMessagesStore.getState().publish(awaiting());
    let release: (value: { outcome: 'withdrawn' }) => void = () => undefined;
    const ask = vi.fn(
      () =>
        new Promise<{ outcome: 'withdrawn' }>((resolve) => {
          release = resolve;
        })
    );
    const first = withdrawInterjection('s1', 'interject-1', ask);
    expect(row()?.withdrawal).toBe('pending');
    await expect(withdrawInterjection('s1', 'interject-1', ask)).resolves.toEqual({
      outcome: 'skipped',
    });
    release({ outcome: 'withdrawn' });
    await expect(first).resolves.toEqual({ outcome: 'withdrawn' });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('[I8-W3] delivered: the bubble stays for its echo, and cannot be withdrawn any more', async () => {
    usePendingUserMessagesStore.getState().publish(awaiting());
    await expect(withdrawInterjection('s1', 'interject-1', answer('delivered'))).resolves.toEqual({
      outcome: 'delivered',
    });
    expect(row()?.withdrawal).toBe('delivered');
    expect(useComposerDraftsStore.getState().offered).toEqual({});
    expect(focused).toEqual([]);
  });

  it('[I8-W4] not found: the engine connection it went to is gone; nothing can name it', async () => {
    usePendingUserMessagesStore.getState().publish(awaiting());
    await expect(withdrawInterjection('s1', 'interject-1', answer('not_found'))).resolves.toEqual({
      outcome: 'not_found',
    });
    expect(row()?.withdrawal).toBe('unavailable');
    expect(useComposerDraftsStore.getState().offered).toEqual({});
  });

  it('[I8-W5] a failed request leaves it withdrawable, unless the connection went meanwhile', async () => {
    usePendingUserMessagesStore.getState().publish(awaiting());
    const failing = vi.fn(async () => {
      throw new Error('worker gone');
    });
    await expect(withdrawInterjection('s1', 'interject-1', failing)).resolves.toEqual({
      outcome: 'failed',
      error: 'worker gone',
    });
    expect(row()).not.toHaveProperty('withdrawal');

    const lostMeanwhile = vi.fn(async () => {
      usePendingUserMessagesStore.getState().markWithdrawalsUnavailable('s1');
      throw new Error('disconnected');
    });
    await withdrawInterjection('s1', 'interject-1', lostMeanwhile);
    expect(row()?.withdrawal).toBe('unavailable');
  });

  it('[I8-W6] the echo landing while the answer travelled leaves nothing to mark', async () => {
    usePendingUserMessagesStore.getState().publish(awaiting());
    const echoedMeanwhile = vi.fn(async () => {
      usePendingUserMessagesStore.getState().clear('interject-1');
      return { outcome: 'delivered' as const };
    });
    await expect(withdrawInterjection('s1', 'interject-1', echoedMeanwhile)).resolves.toEqual({
      outcome: 'delivered',
    });
    expect(usePendingUserMessagesStore.getState().bySession).toEqual({});
  });

  it('[I8-W7] nothing is asked for a send, an echoed message, or one past withdrawing', async () => {
    const ask = answer('withdrawn');
    const store = usePendingUserMessagesStore.getState();
    store.publish(awaiting({ attemptId: 'attempt-send', awaitingDelivery: undefined }));
    store.publish(
      awaiting({ attemptId: 'interject-echoed', authoritativeMessageId: 'dsh-user-9' })
    );
    store.publish(awaiting({ attemptId: 'interject-lost', withdrawal: 'unavailable' }));
    for (const attemptId of ['attempt-send', 'interject-echoed', 'interject-lost', 'nobody']) {
      await expect(withdrawInterjection('s1', attemptId, ask)).resolves.toEqual({
        outcome: 'skipped',
      });
    }
    expect(ask).not.toHaveBeenCalled();
  });
});
