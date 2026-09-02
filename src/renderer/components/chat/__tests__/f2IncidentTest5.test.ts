/**
 * INCIDENT REGRESSION FIXTURE `[I-1]` — "the 45s give-up path and the retry
 * banner contradicting each other on one screen".
 *
 * ## Provenance (recorded verbatim so the next agent can re-check it)
 *
 * - Source: real machine, build 0.4.0-test.5, 2026-08-18, two user screenshots.
 * - Session config: Claude Opus 5 / Medium, explicitly selected.
 * - Three mutually contradictory elements on ONE screen:
 *
 *   | element        | copy, verbatim                                                                    |
 *   |----------------|-----------------------------------------------------------------------------------|
 *   | blue banner    | `Upstream error 503 — retrying 3/10, the turn is still running · Next attempt in 2s · server_error 503` |
 *   | turn head      | `Waiting for Agent Host reply · Retry 1/10 · 39s (up to 45s)`                      |
 *   | red error card | `Error: No assistant/tool progress after send (status may still show idle/stopped — Host did not emit failed; the SDK stream likely hung or errored without a result event). \| status=running \| rawEvents=[session.resumed ; session.history ; session.status(idle) ; message.started ; message.delta ; message.completed ; session.status(running) ; session.stderr ; session.status(running) ; session.status(running,retry 1/10) ; session.stat…]` |
 *   | composer       | the user's own text, `给我完整的函数`, replayed into the input box                  |
 *
 * ## Why this is the batch's strongest positive control
 *
 * The `rawEvents` string contains, in plain sight, the frame
 * `session.status(running, retry 1/10)`. The link was talking. The CLI was
 * retrying. The Host never emitted `failed`. And the renderer's FIXED 45s
 * deadline — which had no reset condition of any kind — elapsed on schedule,
 * wrote `lastError`, and replayed the draft anyway.
 *
 * One sample, three falsifications:
 *  1. the budget did not look at liveness at all (defect 1);
 *  2. "stopped waiting" was reported as "the turn failed" (defect 2);
 *  3. the draft replay was the product of a guess (defect 3).
 *
 * ## Standing (spec §9.1, decision D5)
 *
 * The renderer half of F2 ships WITHOUT a feature flag — a deliberate,
 * user-approved deviation from engineering standard #6, on the grounds that
 * this half is not a new capability but the withdrawal of a wrong verdict, and
 * a flag would keep "prints a red X over a live turn" as a configuration
 * option. Revertability is provided by three things instead: the two budgets
 * are plain constants, S3 can be reverted on its own, and THIS FIXTURE. It is
 * the third leg; do not delete it because it looks redundant with the unit
 * suites — its job is to replay the real frame sequence end to end.
 */

import { describe, expect, it } from 'vitest';
import { classifyTurnLiveness } from '../assistantProgress';
import { composerSendingLine } from '../attachments';
import {
  decideAdmittedTimeoutOutcome,
  decideFailureAffordance,
  type RunSendOrigin,
  shouldArmRetryable,
  shouldPauseQueueOnRejection,
} from '../queueRelease';
import { deriveRetryBanner } from '../retryBanner';
import { createSendWaitBudget, SEND_SILENCE_CEILING_MS } from '../sendBudgets';
import { deriveTurnStatus } from '../turnStatus';

const SESSION = 'session-test5';
const ORIGINS: readonly RunSendOrigin[] = ['direct', 'retry', 'release'];

/** The retry payload the screenshot's banner and turn head were both built from. */
const RETRY_FRAME = {
  attempt: 1,
  maxRetries: 10,
  delayMs: 2000,
  errorStatus: '503',
  error: 'server_error',
};

/**
 * The incident's frame sequence, reconstructed from the `rawEvents` string in
 * the red card, one entry per frame, all scoped to the same session. One frame
 * per second is not the real cadence — it is a deliberate, readable stand-in;
 * what the fixture asserts is the RESET behaviour, which does not depend on the
 * spacing.
 */
const FRAMES: readonly { atMs: number; type: string; payload?: Record<string, unknown> }[] = [
  { atMs: 0, type: 'session.resumed' },
  { atMs: 1_000, type: 'session.history' },
  { atMs: 2_000, type: 'session.status', payload: { status: 'idle' } },
  // The user echo triple — `EventNormalizer.beginTurn`, i.e. the proof the Host
  // admitted this turn's text. Liveness, deliberately NOT progress (§2.1).
  { atMs: 3_000, type: 'message.started', payload: { messageId: 'u-1', role: 'user' } },
  { atMs: 3_100, type: 'message.delta', payload: { messageId: 'u-1', blockId: 'b1', text: '给' } },
  { atMs: 3_200, type: 'message.completed', payload: { messageId: 'u-1' } },
  { atMs: 4_000, type: 'session.status', payload: { status: 'running' } },
  { atMs: 6_000, type: 'session.stderr', payload: { line: 'some cli chatter' } },
  { atMs: 7_000, type: 'session.status', payload: { status: 'running' } },
  // THE frame. "The CLI is retrying", not "the CLI is wedged".
  { atMs: 8_000, type: 'session.status', payload: { status: 'running', retry: RETRY_FRAME } },
  // ...and then a long silence, with no assistant frame ever arriving.
];

const LAST_FRAME_AT = FRAMES[FRAMES.length - 1].atMs;

/** Replays the fixture through the two modules that own the wait. */
function replay(): ReturnType<typeof createSendWaitBudget> {
  const budget = createSendWaitBudget(0);
  for (const frame of FRAMES) {
    const signal = classifyTurnLiveness(
      { type: frame.type, sessionId: SESSION, payload: frame.payload },
      SESSION
    );
    if (signal === 'liveness') budget.markLiveness(frame.atMs);
  }
  return budget;
}

describe('[I-1] incident 0.4.0-test.5 — retry banner vs no-progress card (F2 §12.4)', () => {
  /**
   * `[I-1a]` POSITIVE CONTROL — the budget sees the link talking.
   *
   * This is the dividing line between the old shape and the new one: the old
   * fixed deadline expired at 45s on this exact sequence, with a retry frame
   * seven seconds behind it. Every liveness frame now pushes the deadline
   * forward, so at both sample points the wait is simply still waiting.
   */
  it('[I-1a] every frame in the sequence resets the silence budget', () => {
    const budget = createSendWaitBudget(0);
    for (const frame of FRAMES) {
      const signal = classifyTurnLiveness(
        { type: frame.type, sessionId: SESSION, payload: frame.payload },
        SESSION
      );
      // `session.history` is a replay/listing frame and says nothing about this
      // turn — it is the one entry in the incident's own sequence that is
      // correctly NOT liveness.
      if (frame.type === 'session.history') {
        expect(signal).toBe('ignore');
        continue;
      }
      expect(signal, `${frame.type} must count as liveness`).toBe('liveness');
      budget.markLiveness(frame.atMs);
      expect(budget.lastLivenessAtMs()).toBe(frame.atMs);
    }

    // The two sample points the spec names. 45s is where the OLD budget died.
    expect(budget.isExpired(LAST_FRAME_AT + 45_000)).toBe(false);
    expect(budget.isExpired(LAST_FRAME_AT + 299_000)).toBe(false);
  });

  /**
   * The user echo is the sharpest case in the sequence: it is admission
   * evidence and it is liveness, but it is NOT assistant progress. Widening
   * the progress classifier to cover it — instead of adding a second
   * classifier — is the regression the triage explicitly forbids.
   */
  it('[I-1a] the user echo counts as liveness without becoming progress', () => {
    for (const type of ['message.started', 'message.delta', 'message.completed']) {
      expect(
        classifyTurnLiveness(
          { type, sessionId: SESSION, payload: { messageId: 'u-1', role: 'user' } },
          SESSION
        )
      ).toBe('liveness');
    }
  });

  /**
   * `[I-1b]` POSITIVE CONTROL — reaching the ceiling is not a verdict.
   *
   * Past the ceiling the renderer does stop waiting; what it must not do is
   * conclude anything. With an echo on record the turn was admitted, so the
   * outcome is `'pending'` and all three failure affordances stay off.
   */
  it('[I-1b] past the ceiling the turn is pending, not failed', () => {
    const budget = replay();
    expect(budget.isExpired(LAST_FRAME_AT + SEND_SILENCE_CEILING_MS + 1)).toBe(true);

    const outcome = decideAdmittedTimeoutOutcome({
      // The echo triple above.
      sawUserEcho: true,
      // Not one assistant frame ever arrived — that is the whole incident.
      sawAssistantProgress: false,
    });
    expect(outcome).toBe('pending');

    for (const origin of ORIGINS) {
      // Defect 3: no replay into the composer.
      expect(decideFailureAffordance(outcome, origin)).toBe('none');
      // Defect 2: no one-click resend of a turn that is still running.
      expect(shouldArmRetryable(outcome, origin)).toBe(false);
      expect(shouldPauseQueueOnRejection(outcome, origin)).toBe(false);
    }
  });

  /**
   * `[I-1c]` NEGATIVE CONTROL — the contradiction itself is unconstructible.
   *
   * The source-level half is `[S-2]` (the ceiling branch writes no
   * `lastError`). This is the pure-function half: with the retry frame live,
   * the banner is visible AND the turn head is a waiting state — never
   * `'failed'`. "Retry banner visible + no-progress error" cannot be one
   * screen again.
   */
  it('[I-1c] a visible retry banner and a failed turn head cannot co-exist', () => {
    const banner = deriveRetryBanner({
      retry: RETRY_FRAME,
      inFlight: true,
      outputSinceRetry: false,
    });
    expect(banner).not.toBeNull();
    expect(banner?.title).toContain('the turn is still running');

    // The same instant, in the head. Sampled across the whole window the
    // incident spanned, including past the point the old budget died.
    for (const elapsedSeconds of [12, 39, 45, 62, 179, 299]) {
      const status = deriveTurnStatus({
        active: true,
        phase: 'awaiting',
        elapsedSeconds,
        budgetMs: SEND_SILENCE_CEILING_MS,
        attachmentCount: 0,
        attachmentBytes: 0,
        retry: { attempt: RETRY_FRAME.attempt, maxRetries: RETRY_FRAME.maxRetries },
        hasBlocks: false,
      });
      expect(status).not.toBeNull();
      expect(status?.kind, `at ${elapsedSeconds}s`).not.toBe('failed');
      expect(status?.text).not.toContain('No assistant/tool progress');
    }
  });

  /**
   * `[I-1d]` The copy window §9.3 change 4 opens.
   *
   * A text-only send never reached this branch before: the old budget and the
   * hint threshold were both 45, so the wait ended in the same second the copy
   * would have changed. With a 300s ceiling the `45s -> 300s` span becomes a
   * visible waiting state, and this is the first batch in which a user sees
   * this sentence on a plain text send.
   *
   * Compared by delegation to `composerSendingLine`, not pinned word for word
   * — `attachments.test.ts` owns the verbatim pin, and two verbatim copies of
   * one string is the drift this repo keeps designing against.
   */
  it('[I-1d] at 62s the head says it is still waiting, and keeps the retry count', () => {
    const status = deriveTurnStatus({
      active: true,
      phase: 'awaiting',
      elapsedSeconds: 62,
      budgetMs: SEND_SILENCE_CEILING_MS,
      attachmentCount: 0,
      attachmentBytes: 0,
      retry: { attempt: RETRY_FRAME.attempt, maxRetries: RETRY_FRAME.maxRetries },
      hasBlocks: false,
    });
    expect(status?.kind).toBe('slow');
    expect(status?.text).toBe(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: 62,
        budgetMs: SEND_SILENCE_CEILING_MS,
        attachmentCount: 0,
        attachmentBytes: 0,
        retry: { attempt: RETRY_FRAME.attempt, maxRetries: RETRY_FRAME.maxRetries },
      })
    );
    // The one fact the incident's own head got right and must keep.
    expect(status?.text).toContain('Retry 1/10');
    // And the one it got wrong: no deadline is predicted any more, because
    // nothing happens when the ceiling is reached.
    expect(status?.text).not.toContain('up to');
  });
});
