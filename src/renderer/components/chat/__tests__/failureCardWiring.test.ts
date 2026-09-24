/**
 * D1 (2026-09-24 point-check) — the composer's half of keeping `failed` alive.
 *
 * The store now keeps `status: 'failed'` past the run's closing `idle`
 * (`chatSessionsFailureSettle.test.ts` executes that). Three composer facts
 * depend on it, and `ChatComposer.tsx` cannot be rendered in this node suite,
 * so they are pinned by source scan — the posture `composerStopStatic.test.ts`
 * documents:
 *
 *  1. the queue and "Send now" read `statusForNextTurn`, so a failed run the
 *     runtime has closed still releases queued messages exactly as the plain
 *     idle used to (a Ctrl+Enter interjection included);
 *  2. a new send retires the stale `failed` at its commit point, before its own
 *     wait (`status === 'failed'` is one of its release conditions) can read
 *     the previous run's failure as this one's;
 *  3. the red box above the composer steps down while the timeline card owns
 *     the error, instead of printing the same sentence a second time, raw.
 *
 * Plus the two other "may I act now" gates that compared against a raw
 * `'idle'` and would otherwise lock after every failure: the session-tree
 * (rewind) entry in `SessionBar` and "Load earlier messages" in the timeline.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { failureCardOwnsError } from '../sessionFailure';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPOSER = readFileSync(path.resolve(here, '../ChatComposer.tsx'), 'utf8');
const TIMELINE = readFileSync(path.resolve(here, '../MessageTimeline.tsx'), 'utf8');
const SESSION_BAR = readFileSync(
  path.resolve(here, '../../workspace-shell/SessionBar.tsx'),
  'utf8'
);

describe('D1 — composer wiring for a failure that outlives its idle', () => {
  it('[FW-01] the queue gates read statusForNextTurn, not the raw status', () => {
    expect(COMPOSER).toContain(
      "const nextTurnStatus = statusForNextTurn(activeSession) ?? 'idle';"
    );
    expect(COMPOSER).toContain('status: nextTurnStatus,');
    expect(COMPOSER).not.toContain("status: activeSession?.status ?? 'idle',\n    runEntry");
    expect(COMPOSER).toMatch(
      /canStop \|\| nextTurnStatus === 'idle' \|\| nextTurnStatus === 'completed'/
    );
  });

  it('[FW-02] a new send acknowledges the old failure before anything is dispatched', () => {
    const acknowledge = COMPOSER.indexOf('acknowledgeFailedStatus(state.sessions, sessionId)');
    expect(acknowledge).toBeGreaterThan(-1);
    // Inside runSend's synchronous prologue: after the guards, before the
    // commit point hands the turn to the handshake.
    expect(acknowledge).toBeGreaterThan(COMPOSER.indexOf('const runSend = async ('));
    expect(acknowledge).toBeLessThan(COMPOSER.indexOf('onSendStart?.(origin);'));
    expect(acknowledge).toBeLessThan(COMPOSER.indexOf('const sendAndWait = async ()'));
  });

  it('[FW-03] the red box steps down while the failure card owns the error', () => {
    expect(COMPOSER).toContain(
      'hasError: Boolean(lastError) && !failureCardOwnsError(activeSession?.status),'
    );
  });

  it('[FW-04] the card owns the error exactly while the session is failed', () => {
    expect(failureCardOwnsError('failed')).toBe(true);
    for (const status of ['idle', 'running', 'starting', 'completed', 'disconnected'] as const) {
      expect(failureCardOwnsError(status)).toBe(false);
    }
    expect(failureCardOwnsError(undefined)).toBe(false);
  });

  it('[FW-06] the session-tree (rewind) entry is not locked by a closed failure', () => {
    // Rewinding past the failed turn is a natural way out of it; a raw
    // `status === 'idle'` gate kept the button disabled until the next send.
    expect(SESSION_BAR).toContain(
      "const isIdle = (statusForNextTurn(activeSession) ?? 'idle') === 'idle';"
    );
    expect(SESSION_BAR).not.toContain(
      "const isIdle = (activeSession?.status ?? 'idle') === 'idle';"
    );
  });

  it('[FW-07] "Load earlier messages" is not locked by a closed failure', () => {
    expect(TIMELINE).toMatch(
      /const nextTurnStatus = useChatSessionsStore\(\s*\(state\) =>\s*statusForNextTurn\(state\.sessions\.find\(\(session\) => session\.id === sessionId\)\) \?\? status\s*\);/
    );
    expect(TIMELINE).toContain("disabled={loadingOlderHistory || nextTurnStatus !== 'idle'}");
    expect(TIMELINE).not.toContain("disabled={loadingOlderHistory || status !== 'idle'}");
  });

  it('[FW-05] premise: the timeline still renders the card on status === failed', () => {
    // The store fix is shaped around this gate. If it ever moves, FW-03's
    // step-down would hide the only copy of the error.
    expect(TIMELINE).toContain("{status === 'failed' && (");
  });
});
