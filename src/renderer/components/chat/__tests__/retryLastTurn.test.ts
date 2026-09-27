/**
 * T135 / decision 045 — the pure half of Continue-as-retry (`retryLastTurn.ts`)
 * and the source facts the composer and the IPC bridge must keep.
 *
 * `ChatComposer.tsx` cannot be rendered in this suite, so its retry path is
 * pinned by source scan — the posture `composerStopStatic.test.ts` documents.
 * The behaviour those lines produce on a real worker is executed end to end in
 * `src/runtime/__tests__/retryLastTurnIntegration.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import {
  CONTINUE_BLOCKED_IN_FLIGHT,
  CONTINUE_BLOCKED_UNSETTLED,
  continueBlockedReason,
  isRetryUnavailableError,
  retryRunningRequestId,
} from '../retryLastTurn';
import { stripComments } from './stripComments';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string) =>
  stripComments(readFileSync(path.resolve(here, relative), 'utf8'), relative);
const COMPOSER = read('../ChatComposer.tsx');
const TIMELINE = read('../MessageTimeline.tsx');
const PRELOAD = read('../../../../preload/index.ts');
const MAIN_IPC = read('../../../../main/ipc/chat.ts');

describe('retry admission evidence', () => {
  const running = (overrides: Record<string, unknown> = {}) => ({
    type: 'session.status',
    sessionId: 's1',
    requestId: 'send-1',
    payload: { status: 'running' },
    ...overrides,
  });

  it('is the run’s `running` status for this session, by request id', () => {
    expect(retryRunningRequestId(running(), 's1')).toBe('send-1');
  });

  it('ignores other sessions, other statuses, other events and id-less events', () => {
    expect(retryRunningRequestId(running({ sessionId: 's2' }), 's1')).toBeNull();
    expect(retryRunningRequestId(running({ payload: { status: 'idle' } }), 's1')).toBeNull();
    expect(retryRunningRequestId(running({ type: 'session.completed' }), 's1')).toBeNull();
    expect(retryRunningRequestId(running({ requestId: undefined }), 's1')).toBeNull();
  });
});

describe('retry_unavailable', () => {
  it('is read out of the Electron-wrapped IPC rejection', () => {
    expect(
      isRetryUnavailableError(
        new Error(
          "Error invoking remote method 'chat:retryLastTurn': Error: retry_unavailable: There is no cut-short turn to retry"
        )
      )
    ).toBe(true);
  });

  it('is not confused with other codes that merely contain the words', () => {
    expect(isRetryUnavailableError(new Error('session_busy: turn send-1 is active'))).toBe(false);
    expect(isRetryUnavailableError(new Error('worker_retry_unavailable_x'))).toBe(false);
    expect(isRetryUnavailableError('retry_unavailable')).toBe(true);
  });
});

describe('when the card’s Continue may be pressed', () => {
  it('waits for the failed run’s closing idle', () => {
    expect(continueBlockedReason({ failureSettled: false, sendInFlight: false })).toBe(
      CONTINUE_BLOCKED_UNSETTLED
    );
  });

  it('is disabled while a send is in flight, and free otherwise', () => {
    expect(continueBlockedReason({ failureSettled: true, sendInFlight: true })).toBe(
      CONTINUE_BLOCKED_IN_FLIGHT
    );
    expect(continueBlockedReason({ failureSettled: true, sendInFlight: false })).toBeNull();
  });

  it('has Chinese for every sentence it can show', () => {
    for (const key of [
      CONTINUE_BLOCKED_UNSETTLED,
      CONTINUE_BLOCKED_IN_FLIGHT,
      'Retry the last turn from where it failed',
      'There is no interrupted turn to retry',
      'The last turn left nothing to re-run — it may never have been recorded, or the history was compacted. Its prompt is back in the input box: check it, then send.',
      'The last turn left nothing to re-run — it may never have been recorded, or the history was compacted. Send your message again from the input box.',
    ]) {
      expect(zhTranslations[key], key).toBeTruthy();
    }
    expect(zhTranslations[CONTINUE_BLOCKED_UNSETTLED]).toBe('上一轮仍在收尾');
  });
});

describe('the composer retries instead of resending (source)', () => {
  function runSendBody(): string {
    const start = COMPOSER.indexOf('const runSend = async (');
    const end = COMPOSER.indexOf('useQueueRelease({', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return COMPOSER.slice(start, end);
  }

  it('[T135-R1] Continue goes through runSend in retry mode, carrying no text', () => {
    expect(COMPOSER).toContain(
      "runSend('', [], { origin: 'retry', retryLastTurn: { fallbackText } })"
    );
    expect(COMPOSER).not.toContain("runSend(text, [], { origin: 'retry' })");
  });

  it('[T135-R2] a retry dispatches chat.retryLastTurn, never chat.send', () => {
    const body = runSendBody();
    const dispatch = body.indexOf('retryLastTurn\n            ?');
    expect(dispatch).toBeGreaterThan(-1);
    const retry = body.indexOf('window.electronAPI.chat.retryLastTurn({', dispatch);
    const send = body.indexOf('window.electronAPI.chat.send({', dispatch);
    expect(retry).toBeGreaterThan(dispatch);
    expect(send).toBeGreaterThan(retry);
    // The retry payload has no text and no attachments.
    const retryPayload = body.slice(retry, send);
    expect(retryPayload).not.toContain('text:');
    expect(retryPayload).not.toContain('attachments');
  });

  it('[T135-R3] a retry publishes no optimistic user bubble', () => {
    const body = runSendBody();
    const publish = body.indexOf('usePendingUserMessagesStore.getState().publish(');
    expect(publish).toBeGreaterThan(-1);
    const guard = body.lastIndexOf('if (!retryLastTurn) {', publish);
    expect(guard).toBeGreaterThan(-1);
    expect(publish - guard).toBeLessThan(120);
    // Only the guarded publish exists.
    expect(body.split('usePendingUserMessagesStore.getState().publish(')).toHaveLength(2);
  });

  it('[T135-R4] the running status is the admission evidence, not a user echo', () => {
    const body = runSendBody();
    expect(body).toContain('retryRunningRequestId(event, sessionId)');
    expect(body).toContain('if (retryLastTurn && retryRunningIds.has(requestId)) acceptRetry();');
    const start = body.indexOf('const acceptRetry = () => {');
    const accept = body.slice(start, body.indexOf('\n    };', start));
    expect(accept).toContain('sawUserEcho = true;');
    // The prompt the failure put back into the composer is what the retry now
    // re-runs; an untouched copy goes, so it cannot be sent a second time.
    expect(accept).toContain('revokeRestoredDraftIfUntouched(sessionId);');
  });

  it('[T135-R5] the card is not acknowledged at the commit point of a retry', () => {
    const body = runSendBody();
    const acknowledge = body.indexOf('acknowledgeFailedStatus(state.sessions, sessionId)');
    expect(body.lastIndexOf('if (!retryLastTurn) {', acknowledge)).toBeGreaterThan(-1);
    expect(acknowledge - body.lastIndexOf('if (!retryLastTurn) {', acknowledge)).toBeLessThan(200);
    // …and the wait does not mistake the card's own `failed` for the retry's.
    expect(body).toContain("if (!retryLastTurn && session?.status === 'failed') return true;");
  });

  it('[T135-R6] a refused retry neither arms the round Retry nor restores a draft', () => {
    const body = runSendBody();
    const finalize = body.indexOf('const finalizeOutcome = (');
    const decide = body.indexOf('decideFailureAffordance(outcome, origin, context)', finalize);
    const early = body.indexOf('if (retryLastTurn) return outcome;', finalize);
    expect(early).toBeGreaterThan(finalize);
    expect(early).toBeLessThan(decide);
  });

  it('[T135-R7] nothing to re-run puts the prompt back unsent, it never resends it', () => {
    const body = runSendBody();
    const start = body.indexOf('if (retryUnavailable) {');
    expect(start).toBeGreaterThan(-1);
    const branch = body.slice(start, body.indexOf("return 'skipped';", start));
    expect(branch).toContain('updateValue(fallback)');
    expect(branch).toContain('composerEmpty');
    expect(branch).toContain("t('There is no interrupted turn to retry')");
    expect(branch).not.toContain('sendAndWait');
    expect(branch).not.toContain('electronAPI');
    // Checked before a generic failure could claim it.
    expect(start).toBeLessThan(body.indexOf('if (fatalHostError) {', start));
  });

  it('[T135-R8] the failure card gates Continue on the settled failure', () => {
    expect(TIMELINE).toContain('<FailureContinueButton');
    expect(TIMELINE).toMatch(
      /continueBlockedReason\(\{\s*failureSettled,\s*sendInFlight: sendStatus != null,\s*\}\)/
    );
  });

  it('[T135-R9] preload and Main carry the retry over its own channel', () => {
    expect(PRELOAD).toContain('ipcRenderer.invoke(IPC_CHANNELS.CHAT_RETRY_LAST_TURN, payload)');
    const handler = MAIN_IPC.indexOf('IPC_CHANNELS.CHAT_RETRY_LAST_TURN');
    expect(handler).toBeGreaterThan(-1);
    const body = MAIN_IPC.slice(handler, MAIN_IPC.indexOf('ipcMain.handle(', handler));
    // Same preamble as a send: ownership, then the TUI handover, then the turn.
    expect(body).toContain('claimSessionForSender(e, payload.sessionId)');
    expect(body).toContain('await handOverFromTui(payload.sessionId, ownerWebContentsId)');
    expect(body).toContain('workerManager.retryLastTurn(');
    expect(body).toContain('withWorkerErrorCode(error)');
  });
});
