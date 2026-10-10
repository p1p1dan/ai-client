import { useComposerDraftsStore } from '@/stores/composerDrafts';
import { type PendingUserMessage, usePendingUserMessagesStore } from '@/stores/pendingUserMessages';
import { requestComposerFocus } from './composerFocus';

/**
 * GitHub issue #8 (dsh-rebase decision 172 §4): the 「撤回」 of a Ctrl+Enter
 * message awaiting delivery — while its turn runs, or after a Stop left it in
 * DSH's inbox (decision 094).
 *
 * The engine answers for the message, never this window: DSH removes it from
 * its inbox, or reports that a turn took it in first. Both happen on the
 * host's one thread, so there is no third state to guess at.
 *
 *  - `withdrawn`: the bubble goes and its text and attachments go back to its
 *    chat's message box — straight in when the box is empty, after what is
 *    already typed otherwise (decision 139 rule 2's merge) — and the box takes
 *    the keyboard.
 *  - `delivered`: the bubble stays for its echo to replace, and can no longer
 *    be withdrawn.
 *  - `not_found`: the engine connection it was handed to is gone (or a rewind
 *    left it behind); it can no longer be withdrawn either.
 *  - `failed`: the request itself failed; the bubble can be tried again.
 *  - `skipped`: nothing to do — not an awaiting row, or one already being
 *    withdrawn or past withdrawing.
 */
export type InterjectionWithdrawOutcome =
  | { outcome: 'withdrawn' | 'delivered' | 'not_found' | 'skipped' }
  | { outcome: 'failed'; error: string };

type AskEngine = (payload: {
  sessionId: string;
  attemptId: string;
}) => Promise<{ outcome: 'withdrawn' | 'delivered' | 'not_found' }>;

const askEngine: AskEngine = (payload) => window.electronAPI.chat.withdrawInterjection(payload);

function pendingRow(sessionId: string, attemptId: string): PendingUserMessage | undefined {
  return usePendingUserMessagesStore
    .getState()
    .bySession[sessionId]?.find((message) => message.attemptId === attemptId);
}

export async function withdrawInterjection(
  sessionId: string,
  attemptId: string,
  ask: AskEngine = askEngine
): Promise<InterjectionWithdrawOutcome> {
  const row = pendingRow(sessionId, attemptId);
  // An echo already seen (`authoritativeMessageId`) means a turn has it.
  if (!row?.awaitingDelivery || row.withdrawal || row.authoritativeMessageId) {
    return { outcome: 'skipped' };
  }
  const pending = usePendingUserMessagesStore.getState();
  pending.setWithdrawal(attemptId, 'pending');
  let outcome: 'withdrawn' | 'delivered' | 'not_found';
  try {
    ({ outcome } = await ask({ sessionId, attemptId }));
  } catch (error) {
    // Withdrawable again, unless a disconnect decided otherwise meanwhile.
    if (pendingRow(sessionId, attemptId)?.withdrawal === 'pending') {
      pending.setWithdrawal(attemptId, null);
    }
    return { outcome: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  if (outcome === 'withdrawn') {
    pending.clear(attemptId);
    useComposerDraftsStore
      .getState()
      .offerDraft(sessionId, { text: row.text, attachments: row.drafts ?? [] });
    requestComposerFocus(sessionId);
    return { outcome };
  }
  // The row may be gone already: its echo landed while the answer travelled.
  if (pendingRow(sessionId, attemptId)) {
    pending.setWithdrawal(attemptId, outcome === 'delivered' ? 'delivered' : 'unavailable');
  }
  return { outcome };
}
