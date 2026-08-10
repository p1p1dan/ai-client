/**
 * Stop-hang fix (2026-08-10) — source-scan guards for `ChatComposer.tsx`.
 *
 * `runSend` is a `.tsx`-local closure and this suite runs `environment: 'node'`
 * with `include: *.test.ts` (vitest.config.ts) — no component ever renders
 * here, so the ORDER and ABSENCE facts the Stop path depends on cannot be
 * asserted by calling anything. They are asserted over the source instead
 * (the same posture `composerFormStatic` / `composerTargetGuards` take for
 * their own untestable facts, and the honest replacement for the
 * "INSPECTION-VERIFIED" note in `runSend`'s own S3 header).
 *
 * What each guard protects is stated at its own `it`. All of them are about
 * one bug: Stop looked dead because `runSend`'s wait had no release condition
 * a stopped turn can satisfy, so the renderer sat on a 50ms poll until the 45s
 * abandon budget expired and then reported the turn as failed.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPOSER_PATH = path.resolve(__dirname, '../ChatComposer.tsx');

/**
 * Comments are blanked (parser-backed strip, see `./stripComments`): every
 * identifier below is also quoted at length in the doc comments that explain
 * WHY it is there, and a scan that cannot tell code from prose would force a
 * choice between keeping the guard and keeping the explanation.
 */
const source = stripComments(readFileSync(COMPOSER_PATH, 'utf8'), 'ChatComposer.tsx');

/** All start offsets of `needle` in the stripped source. */
function offsets(needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
}

/** Sole start offset of `needle` — fails loudly if it is absent or duplicated. */
function only(needle: string): number {
  const found = offsets(needle);
  expect(found, `expected exactly one occurrence of ${JSON.stringify(needle)}`).toHaveLength(1);
  return found[0];
}

describe('runSend cancellation-token ordering (F6 + 2026-08-10 stop-hang fix)', () => {
  /**
   * THE precondition for the wait predicate's `sendGenerationRef.current !==
   * myGeneration` check. `runSend` bumps the shared generation ref on entry
   * and snapshots it immediately afterwards; the snapshot must be taken AFTER
   * the bump, or every attempt would start out already looking cancelled and
   * the predicate would release the wait on the very first poll — turning
   * every send into an instant no-progress exit.
   *
   * Pinned before the predicate change that consumes it, and deliberately
   * pinned as an ORDER (not as "line 826/827"), so a future reshuffle of
   * `runSend`'s prologue cannot invert the two without a red test.
   */
  it('bumps sendGenerationRef BEFORE snapshotting myGeneration', () => {
    const snapshot = only('const myGeneration = sendGenerationRef.current;');
    const bumps = offsets('sendGenerationRef.current += 1;');
    // Two writers by design: `runSend`'s own entry bump, and `handleStop`.
    expect(bumps).toHaveLength(2);
    const [runSendBump, handleStopBump] = bumps;
    expect(runSendBump).toBeLessThan(snapshot);
    // `handleStop` lives further down the component; asserting it is NOT the
    // bump that precedes the snapshot keeps the first assertion honest even
    // if the two functions are ever reordered.
    expect(handleStopBump).toBeGreaterThan(snapshot);
  });

  /**
   * `myGeneration` is a `const` snapshot, never reassigned — the whole
   * "compare the shared ref against MY value" scheme collapses if a later
   * edit refreshes it mid-attempt (the attempt would then re-adopt the very
   * generation a Stop just installed and never notice the cancellation).
   */
  it('never reassigns myGeneration after the snapshot', () => {
    // Exactly one write in the whole file, and it is the `const` snapshot
    // itself (`=(?!=)` skips the `!==` comparisons that read it).
    const writes = source.match(/\bmyGeneration\s*=(?!=)/g) ?? [];
    expect(writes).toHaveLength(1);
    expect(source).toMatch(/const myGeneration = sendGenerationRef\.current;/);
  });

  /**
   * `handleStop` must bump SYNCHRONOUSLY (before/independently of the async
   * `stopActiveSession()` IPC): the whole point is that an in-flight attempt
   * notices the cancellation on its next poll rather than waiting for the
   * Host round-trip that produces `session.stopped`.
   */
  it('handleStop bumps the generation before awaiting anything', () => {
    const stopBump = offsets('sendGenerationRef.current += 1;')[1];
    const stopCall = only('void stopActiveSession();');
    expect(stopBump).toBeLessThan(stopCall);
  });
});

/** `sendAndWait`'s post-dispatch wait predicate, source text only. */
function waitPredicateBody(): string {
  const start = only('return waitUntil(() => {');
  const end = source.indexOf('}, timeoutMs);', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('sendAndWait release set (2026-08-10 stop-hang fix)', () => {
  /**
   * The wait's release set used to contain nothing a STOPPED turn produces:
   * `fatalHostError` (a Stop is not an error), `sawAssistantProgress` (a Stop
   * prevents it), status `failed`/`waiting_permission`/`waiting_question`
   * (a Stop lands on `idle`), and a NEW assistant message (there is none).
   * `session.stopped` — read off the wire, because the store collapses it
   * into the same `idle` a completion produces — is what ends it now.
   *
   * `session.completed` joins it for the same class of bug one step over: a
   * turn that completes with no assistant BLOCKS (side-effect-only turns)
   * also satisfied nothing in the old set.
   */
  it('releases the wait on this send’s own session.stopped / session.completed', () => {
    const body = waitPredicateBody();
    expect(body).toContain('sawSessionStopped');
    expect(body).toContain('sawSessionCompleted');
  });

  /**
   * The cancellation token is the ONLY release condition that works when the
   * Host never answers at all (Stop pressed while the Host is wedged): no
   * `session.stopped` will ever arrive, so without this the wait still burns
   * the full 45s budget and lands in the abandon branch.
   */
  it('releases the wait when a newer generation supersedes this attempt', () => {
    expect(waitPredicateBody()).toContain('sendGenerationRef.current !== myGeneration');
  });

  /**
   * Both terminal checks sit at the HEAD of the predicate — ahead of the
   * store reads below them. Not a micro-optimisation: a stopped turn can also
   * have a stale `fatalHostError` (e.g. a `session_busy` from earlier in the
   * same attempt) and must still be classified as a Stop, not as a failure.
   */
  it('checks the terminal/cancellation signals before the error and store reads', () => {
    const body = waitPredicateBody();
    const stopCheck = body.indexOf('sawSessionStopped');
    const generation = body.indexOf('sendGenerationRef.current !== myGeneration');
    const fatal = body.indexOf('fatalHostError');
    const storeRead = body.indexOf('useChatSessionsStore.getState()');
    expect(stopCheck).toBeGreaterThanOrEqual(0);
    expect(stopCheck).toBeLessThan(fatal);
    expect(generation).toBeLessThan(storeRead);
  });

  /**
   * The flags must come from the shared, unit-tested wire predicates
   * (`assistantProgress.ts`), not from a re-inlined `event.type === '…'`
   * check that silently drops the sessionId scoping — a background session's
   * Stop ending THIS attempt's wait is exactly the class of bug R3/S4 closed
   * for the other terminals.
   */
  it('sets both flags from the sessionId-scoped wire predicates', () => {
    expect(source).toMatch(/isSessionStoppedForSend\(event, sessionId\)/);
    expect(source).toMatch(/isSessionCompletedForSend\(event, sessionId\)/);
    expect(source).toMatch(/let sawSessionStopped = false;/);
    expect(source).toMatch(/let sawSessionCompleted = false;/);
  });

  /**
   * sessionId scoping alone is not enough for a TERMINAL: the previous turn's
   * `session.stopped` can still be in flight when the next attempt starts
   * (which is now reachable precisely because a Stop returns `runSend`
   * immediately — `'stopping'` is not a busy status, so the next send is not
   * blocked). Accepting it would end the new attempt's wait before its own
   * echo, and the Stop exit would classify a turn the Host had just admitted
   * as never-admitted — bouncing the text back behind a double-sending Retry.
   * `sawUserEcho` is the "this terminal is MINE" evidence, and it is checked
   * when the flag is RECORDED (not when it is read), so a stale pre-echo
   * terminal is dropped for good rather than lying in wait.
   */
  it('records a terminal only once THIS attempt has been admitted', () => {
    const gate = only('if (sawUserEcho) {');
    expect(gate).toBeLessThan(only('if (isSessionStoppedForSend(event, sessionId)) {'));
    expect(gate).toBeLessThan(only('if (isSessionCompletedForSend(event, sessionId)) {'));
    // The echo itself is recorded earlier in the same listener, so an echo
    // and a terminal arriving in one batch still resolve in the right order.
    expect(only('if (isUserEchoForSend(event, sessionId)) {')).toBeLessThan(gate);
  });
});

describe('sendAndWait dispatch guard (2026-08-10 stop-hang fix)', () => {
  /**
   * The companion to the wait's cancellation check, and the reason that check
   * is safe. Stop is live from `setSending(true)` onward, so it can land
   * during the (multi-second) ensureHost/create/resume handshake that runs
   * BEFORE the first dispatch. Guarding the dispatch itself means a cancelled
   * turn is never handed to the Host — and, just as importantly, that the
   * wait's generation check can never fire on a turn that WAS just dispatched
   * but has not echoed yet, which would classify a live turn as
   * never-admitted and arm a Retry that double-sends it.
   *
   * It has to sit before `chat.send` and inside `sendAndWait` (not at one
   * call site): `sendAndWait` is invoked from three places — the first send,
   * the `session_busy` resend loop, and the `session_not_found` fallback.
   */
  it('refuses to dispatch once the attempt has been cancelled', () => {
    const guard = only('if (sendGenerationRef.current !== myGeneration) return false;');
    const dispatch = only('const sendResult = await window.electronAPI.chat.send({');
    const sendAndWaitStart = only('const sendAndWait = async (): Promise<boolean> => {');
    expect(guard).toBeGreaterThan(sendAndWaitStart);
    expect(guard).toBeLessThan(dispatch);
    // Three dispatch sites, one guard: `sendAndWait` is the only place that
    // calls `chat.send`, so no caller can route around it.
    expect(offsets('window.electronAPI.chat.send(')).toHaveLength(1);
    expect(offsets('await sendAndWait();')).toHaveLength(3);
  });
});

/** `runSend`'s Stop exit: from its `if (` to the success gate that follows. */
function stopBranchBody(): string {
  const start = only(
    'if (sawSessionStopped || sawSessionCompleted || sendGenerationRef.current !== myGeneration) {'
  );
  const end = source.indexOf('const statusAfter = useChatSessionsStore', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('runSend Stop exit is a clean end, not the 45s abandon (2026-08-10)', () => {
  /**
   * Order matters twice over. Before the success gate: that gate reads
   * `statusAfter === 'idle'`, which a Stop satisfies only once the store has
   * processed the event — so leaving classification to it would make a Stop
   * come out as a clean 'committed' or as a 45s-style abandon depending on
   * store timing. Before the abandon block: that block is what fabricated the
   * red "No assistant/tool progress after send …" banner the user actually
   * complained about.
   */
  it('classifies a Stop before both the success gate and the abandon branch', () => {
    const stop = only(
      'if (sawSessionStopped || sawSessionCompleted || sendGenerationRef.current !== myGeneration) {'
    );
    expect(stop).toBeLessThan(only('const statusAfter = useChatSessionsStore'));
    expect(stop).toBeLessThan(only('const abandonError = ['));
    expect(stop).toBeLessThan(only('abandonMarkerRef.current = {'));
  });

  /**
   * `unbindHost()` drops the Host registry binding, forcing the NEXT message
   * through a resume (or create) handshake it does not need. The 45s abandon
   * has a reason to distrust the binding; a user Stop does not — the Host
   * answered, promptly and correctly.
   */
  it('never unbinds the Host on the Stop path', () => {
    expect(stopBranchBody()).not.toContain('unbindHost()');
  });

  /**
   * A Stop is not a failure: no `lastError` may survive it (the banner is
   * cleared, never written), and no abandon marker is armed — there is no
   * "still running server-side" turn left for a marker to wait on.
   */
  it('clears lastError and arms no abandon marker on the Stop path', () => {
    const body = stopBranchBody();
    expect(body).toContain('useChatSessionsStore.setState({ lastError: null });');
    expect(body).not.toContain('abandonMarkerRef.current = {');
    expect(body).not.toContain('setCreateTimeoutError');
  });

  /**
   * Timing-independence, which is the whole reason this exit exists rather
   * than letting the gate below handle it: `chatSessions.ts` applies runtime
   * events on a batched 16ms flush (throttled further in a background
   * window), so `session.status` is routinely still `'running'` at the moment
   * the wire event releases the wait. Any store READ here would reintroduce
   * that race — writes (the `lastError` clear) are fine.
   */
  it('decides without reading session status back out of the store', () => {
    expect(stopBranchBody()).not.toContain('.getState()');
  });

  /**
   * Admission evidence still decides the outcome, via the same unit-tested
   * classifier every other exit uses. An echoed turn is spent ('committed' —
   * resending would double-send it); a turn the Host never admitted must come
   * back as 'rejected' so `useQueueRelease` restores the entry instead of
   * swallowing it (T-19 decision 3.3).
   */
  it('classifies through decideRunEntryOutcome rather than hardcoding an outcome', () => {
    const body = stopBranchBody();
    expect(body).toContain('decideRunEntryOutcome({');
    expect(body).toContain('sawUserEcho');
    expect(body).toContain('finalizeOutcome(');
  });
});
