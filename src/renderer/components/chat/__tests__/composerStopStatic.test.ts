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
 * a stopped turn can satisfy, so the renderer sat on a 50ms poll until the wait
 * budget expired and then reported the turn as failed.
 *
 * F2 (2026-08-18 S3): the prose below said "the 45s abandon" throughout. Both
 * halves of that phrase are now wrong and are corrected in place rather than
 * left as folklore:
 *  - the budget is no longer 45s and is no longer a DEADLINE at all — it is a
 *    silence ceiling that any liveness frame for the session resets
 *    (`sendBudgets.ts`);
 *  - reaching it is no longer an "abandon" — the renderer stops waiting and
 *    says nothing about the turn, because the Host is the only verdict-holder
 *    and its own stall watchdog necessarily speaks first.
 * The guards themselves are unchanged in substance; several moved their anchor
 * onto the `case` labels of `runSend`'s discriminated wait exit (§4.2), which
 * is a steadier anchor than the variable names they used to point at.
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

/**
 * `sendAndWait`'s post-dispatch wait predicate, source text only.
 *
 * F2 (2026-08-18): the closing anchor moved from `}, timeoutMs);` to the
 * injected expiry rule — `waitUntil` now takes an `expired()` predicate rather
 * than a fixed number of milliseconds. The six groups below are unchanged and
 * are themselves the regression evidence for that signature change.
 */
function waitPredicateBody(): string {
  // Anchored on tokens the formatter cannot reflow: the sole main-wait
  // `waitUntil(` call, and the injected expiry rule that closes its argument
  // list. The previous anchors carried their own line breaks and broke the
  // moment biome rewrapped the multi-line call.
  //
  // F2 S3: the call is now `await`ed into a local rather than returned
  // directly, because its boolean is classified into the four-member
  // `WaitResult` before it leaves `sendAndWait` (§4.2).
  const start = only('const released = await waitUntil(');
  const end = source.indexOf('() => budget.isExpired(Date.now())', start);
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
   * the full silence ceiling before it can even be classified.
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
    expect(only('if (isUserEchoForSend(event, sessionId, attemptId)) {')).toBeLessThan(gate);
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
    // F2 S3: both anchors moved with the discriminated return type — the
    // guard now names WHY it refused ('cancelled') instead of a bare `false`
    // that used to mean both "cancelled" and "budget elapsed". There are TWO
    // such returns by design, and asserting the pair is stronger than
    // asserting either alone: the first refuses to DISPATCH a cancelled turn,
    // the second CLASSIFIES one cancelled while waiting. Both must exist —
    // dropping the first hands the Host a turn nobody wants; dropping the
    // second reports that turn as a no-progress failure.
    const cancelReturns = offsets(
      "if (sendGenerationRef.current !== myGeneration) return 'cancelled';"
    );
    expect(cancelReturns).toHaveLength(2);
    const [guard, classification] = cancelReturns;
    const dispatch = only('const sendResult = await window.electronAPI.chat.send({');
    const sendAndWaitStart = only('const sendAndWait = async (): Promise<WaitResult> => {');
    expect(classification).toBeGreaterThan(dispatch);
    expect(guard).toBeGreaterThan(sendAndWaitStart);
    expect(guard).toBeLessThan(dispatch);
    // Three dispatch sites, one guard: `sendAndWait` is the only place that
    // calls `chat.send`, so no caller can route around it.
    expect(offsets('window.electronAPI.chat.send(')).toHaveLength(1);
    // Initial send, busy retry, post-create send, and T32 exact-file reopen send.
    expect(offsets('await sendAndWait();')).toHaveLength(4);
  });
});

/**
 * `runSend`'s Stop exit — F2 S3: now a `case` of the discriminated wait exit
 * (§4.2) rather than an `if` ahead of the success gate. The slice runs from its
 * first label to the success case that follows it.
 *
 * Anchoring on the labels is deliberately STRONGER than the old anchor: the
 * previous one was a 100-character boolean expression that any refactor of the
 * predicate would have silently detached, whereas `case 'terminal':` changes
 * only if the vocabulary itself changes — which is exactly when these guards
 * SHOULD be re-read.
 */
function stopBranchBody(): string {
  const start = only("case 'terminal':");
  const end = source.indexOf("case 'progress': {", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('runSend Stop exit is a clean end, not a timeout (2026-08-10)', () => {
  /**
   * Order matters twice over. Before the success gate: that gate reads
   * `statusAfter === 'idle'`, which a Stop satisfies only once the store has
   * processed the event — so leaving classification to it would make a Stop
   * come out as a clean 'committed' or as a timeout-style abandon depending on
   * store timing. Before the abandon block: that block is what fabricated the
   * red "No assistant/tool progress after send …" banner the user actually
   * complained about.
   */
  it('classifies a Stop as its own case, so no later gate can claim it', () => {
    // F2 S3: the ordering this used to assert is now STRUCTURAL. A Stop was
    // previously classified by an `if` placed ahead of the success gate,
    // because that gate reads `statusAfter` and the store applies runtime
    // events on a batched 16ms flush — leaving it to the gate made the SAME
    // user action come out as a clean end or as an abandon depending on a
    // timer. With a discriminated exit the labels are mutually exclusive, so
    // 'terminal'/'cancelled' cannot fall through into either of the other two
    // no matter where they sit in the source.
    //
    // What still has to be pinned is that the classification happens where the
    // evidence is fresh: inside `sendAndWait`, the instant the wait returns,
    // off the synchronously-written wire flags rather than a store read.
    const classified = only("if (sawSessionStopped || sawSessionCompleted) return 'terminal';");
    // The SECOND of the two (the first is `sendAndWait`'s dispatch guard, see
    // the group above) — the one that classifies a cancellation after waiting.
    const cancelled = offsets(
      "if (sendGenerationRef.current !== myGeneration) return 'cancelled';"
    )[1];
    const storeRead = only('const statusAfter = useChatSessionsStore');
    expect(classified).toBeLessThan(cancelled);
    expect(cancelled).toBeLessThan(storeRead);
    // Three mutually exclusive labels, one each.
    expect(offsets("case 'terminal':")).toHaveLength(1);
    expect(offsets("case 'cancelled':")).toHaveLength(1);
    expect(offsets("case 'ceiling': {")).toHaveLength(1);
  });

  /**
   * `unbindHost()` drops the Host registry binding, forcing the NEXT message
   * through a resume (or create) handshake it does not need. An unadmitted
   * turn has a reason to distrust the binding; a user Stop does not — the Host
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
  it('clears lastError and arms no pending watch on the Stop path', () => {
    const body = stopBranchBody();
    expect(body).toContain('useChatSessionsStore.setState({ lastError: null });');
    expect(body).not.toContain('pendingReplyRef.current = {');
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

/**
 * F2 S2 (2026-08-18) — the liveness wiring, `[S-6]`.
 *
 * `classifyTurnLiveness` is deliberately a SECOND function rather than a third
 * member on `AssistantProgressSignal`: a three-member union invites a
 * `!== 'ignore'` read, which is precisely the "let message.delta count as
 * progress" regression the triage forbids. That separation is a fact about
 * `runSend`'s listener, and the listener is a `.tsx`-local closure — so it is
 * asserted over the source, the same posture the groups above take.
 *
 * `classifyAssistantProgress`'s own contamination surface is why this matters:
 * its verdict feeds the wait release, the admission decision AND Retry arming,
 * so a single widening would poison all three at once.
 */
describe('liveness budget wiring (F2 S-6)', () => {
  it('[S-6] progress and liveness are classified by two separate calls, each exactly once', () => {
    const progressAt = only(
      "classifyAssistantProgress(event, assistantMessageIds) === 'assistant'"
    );
    const livenessAt = only("classifyTurnLiveness(event, sessionId) === 'liveness'");
    // Adjacent inside the same runtime-event listener, so a reader sees the
    // two questions side by side and cannot mistake one for the other.
    expect(livenessAt).toBeGreaterThan(progressAt);
    expect(livenessAt - progressAt).toBeLessThan(600);
  });

  it('[S-6] only the liveness classifier resets the wait budget', () => {
    const markAt = only('budget.markLiveness(');
    const livenessAt = only("classifyTurnLiveness(event, sessionId) === 'liveness'");
    expect(markAt).toBeGreaterThan(livenessAt);
    // One budget, opened once per send.
    expect(offsets('createSendWaitBudget(')).toHaveLength(1);
  });

  /**
   * "Producer with no consumer" discipline (§3.4): S1 emits
   * `session.status.payload.liveness`, and this batch owes it TWO reachable
   * readers. The first is `classifyTurnLiveness` (covered by `[L-3]`, which
   * feeds it a real liveness note). The second is the `rawEvents=[...]`
   * diagnostic string — a `.tsx`-local function, hence a source guard.
   */
  it('[S-6] formatRuntimeEvent consumes the liveness note into the rawEvents diagnostic', () => {
    expect(source).toContain('const liveness = payload?.liveness;');
    const suffixAt = only('const livenessSuffix = liveness');
    // Declared once and interpolated once. A declaration with no use would be
    // exactly the "producer with no consumer" shell this guard rejects.
    const uses = offsets('livenessSuffix');
    expect(uses).toHaveLength(2);
    expect(uses[1]).toBeGreaterThan(suffixAt);
  });

  it('[S-6] the main wait expires on the resettable budget, and the handshakes keep fixed deadlines', () => {
    expect(offsets('budget.isExpired(Date.now())')).toHaveLength(1);
    // Create handshake, explicit resume, and direct-binding exact-file reopen.
    expect(offsets('deadlineAt(5000)')).toHaveLength(3);
    // The retired byte-scaled formula must not come back through any door.
    expect(source).not.toContain('sendTimeoutMs(');
  });
});

/**
 * F2 S3 (2026-08-18) — `[S-1]`~`[S-7]`: the admitted-timeout branch neither
 * declares death nor replays input.
 *
 * ## The slice, and why the anchors are `case` labels
 *
 * `runSend`'s wait now returns a discriminated `WaitResult` (§4.2), and the
 * `'ceiling'` case is the whole of "we stopped waiting and the Host has said
 * nothing". The slice below runs from that label to the next one. The spec
 * chose label anchors over an "the pending branch body" anchor deliberately:
 * the latter depends on VARIABLE NAMES surviving, the former only on the
 * vocabulary surviving — and if the vocabulary changes, these guards are
 * exactly what should be re-read rather than silently detached.
 *
 * The unadmitted half (no echo, no progress — a turn the Host never took) is
 * lifted into a NAMED function outside the switch, which is what lets these
 * negative controls read the slice at all: everything they forbid is still
 * correct behaviour over there, and always was.
 *
 * ## What is being forbidden, and why each one mattered
 *
 * Every item below was in the old 45s abandon path, and every one of them was
 * a statement about a turn that was, in the reported incident, demonstrably
 * still running — the same screen carried a blue "retrying 3/10, the turn is
 * still running" banner AND a red "no assistant/tool progress after send" card.
 */
describe('admitted-timeout branch neither judges nor replays (F2 S3 §4.2)', () => {
  /** The `'ceiling'` case body: its label to the next one. */
  function ceilingBranchBody(): string {
    const start = only("case 'ceiling': {");
    const end = source.indexOf("case 'terminal':", start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  /**
   * `[S-1]` — dropping the Host binding forces the NEXT message through a
   * resume handshake it does not need, and does so on the strength of a guess.
   * Keeping the binding is also what makes the turn head's "Stop to abort."
   * copy executable: Stop still reaches a Host we are still bound to.
   */
  it('[S-1] never unbinds the Host', () => {
    expect(ceilingBranchBody()).not.toContain('unbindHost()');
  });

  /**
   * `[S-2]` — no error is written, because none has occurred. This is the
   * literal source-level half of the incident's core contradiction: with no
   * `lastError` written here, "retry banner visible" and "no-progress error
   * card" can no longer appear on one screen.
   */
  it('[S-2] writes no lastError', () => {
    expect(ceilingBranchBody()).not.toContain('lastError');
  });

  /**
   * `[S-3]` — the load-bearing negative control, paired with `[P-2]`'s pure
   * function half (spec §12.2 assertion 4 asks for both layers). The user's
   * ruling is that input is replayed only for a CONFIRMED dead turn; a
   * timeout is a guess, and a replay on a guess is a double-send waiting for
   * the user to click.
   */
  it('[S-3] restores no draft and arms no Retry', () => {
    const body = ceilingBranchBody();
    expect(body).not.toContain('restoreDraftIfComposerEmpty');
    expect(body).not.toContain('setRetryable(');
  });

  /**
   * `[S-4]` — the positive half. The turn head (and the Stop button inside it)
   * must survive the ceiling, or the UI silently drops a turn that is still
   * running: `runSend`'s `finally` clears the composer's status snapshot
   * moments later, and without this watch there is nothing left to render.
   */
  it('[S-4] arms the pending-reply watch', () => {
    const body = ceilingBranchBody();
    expect(body).toContain('armPendingReply(');
    // And keeps the found-material for the one case that may still replay it.
    expect(body).toContain('pendingReplyRef.current = {');
  });

  /**
   * `[S-5]` — the pending exit returns directly. `finalizeOutcome` is the
   * single authority for every outcome that needs an affordance, and
   * `'pending'` is defined to need none (`decideFailureAffordance('pending',*)
   * === 'none'`, `shouldPauseQueueOnRejection` false), so routing through it
   * would be a no-op whose only effect is to hide these guards behind a
   * function call. Same posture the Stop exit's `'committed'` half already
   * takes.
   *
   * The classifier itself must appear exactly once in the file: two call sites
   * would mean two places that can disagree about what "admitted" means.
   */
  it('[S-5] returns directly, and classifies in exactly one place', () => {
    expect(ceilingBranchBody()).not.toContain('finalizeOutcome(');
    expect(offsets('decideAdmittedTimeoutOutcome(')).toHaveLength(1);
    // It is the SECOND-layer classifier: it may only run once the first layer
    // has already ruled out a terminal and a cancellation, both of which are
    // decided inside `sendAndWait`.
    expect(only('decideAdmittedTimeoutOutcome(')).toBeGreaterThan(
      only("if (sawSessionStopped || sawSessionCompleted) return 'terminal';")
    );
  });

  /**
   * `[S-7]` — §4.2's explicit negative: no `getHostStatus()` vote. It costs an
   * IPC round-trip and, worse, invites the inference "the Host is not `ready`,
   * so the turn is dead" — a single failed probe is on the spec's list of
   * things that are NOT death evidence. The probe stays where it belongs, in
   * the unadmitted path's diagnostic string.
   */
  it('[S-7] takes no Host-status vote on a turn it has no verdict about', () => {
    expect(ceilingBranchBody()).not.toContain('getHostStatus(');
    // Still exactly one caller in the file — the unadmitted diagnostic.
    expect(offsets('chat.getHostStatus()')).toHaveLength(1);
  });

  /**
   * §4.3 consumption point 6, asserted where the consumer lives. The silent
   * default here would have SKIPPED the title for a first message whose reply
   * timed out — a second, quieter way of pretending the turn never happened.
   */
  it('[S-8] the auto-title gate asks whether the turn was admitted', () => {
    expect(source).toContain('if (!isAdmittedOutcome(outcome)) return;');
    expect(source).not.toContain("if (outcome !== 'committed') return;");
  });

  /**
   * §5.4 step ordering, and §5.1's causality: the ONLY automatic draft restore
   * that survives is the one a real `session.failed` triggers. Both restores
   * (this one and `finalizeOutcome`'s `'restore-draft'`) go through the same
   * lifted function, so both write provenance and both are revocable by the
   * same rule.
   */
  it('[S-9] a confirmed death — and only that — replays the payload', () => {
    expect(source).toContain('if (isSessionFailedForSend(event, watch.sessionId)) {');
    // Exactly two automatic restores in the whole file, both through the
    // lifted, provenance-writing function.
    // Two CALL sites (the definition reads `= useCallback(`, so it does not
    // match): `finalizeOutcome`'s 'restore-draft' affordance, and this one.
    expect(offsets('restoreDraftIfComposerEmpty(')).toHaveLength(2);
    expect(offsets('restoredDraftRef.current = {')).toHaveLength(1);
    // The watch is frozen before it is dropped (§5.4 step 2), or the payload
    // would be gone by the time the restore runs.
    const freeze = only('const committed = watch.committed;');
    const drop = only('resolvePendingReplyLanded(watch.sessionId);\n        restoreDraft');
    expect(freeze).toBeLessThan(drop);
  });

  /**
   * `[D-1]` — §5.4's chain is ordered, and the order IS the contract.
   *
   * Cleanup has to run before the reducer applies the new fact, or the cleared
   * state overwrites it; and the session check has to come first, or a marker
   * from one turn reaches into another. Both are order facts about a closure,
   * so both are pinned here.
   */
  it('[D-1] the late-event cleanup chain runs in its declared order', () => {
    // Step 1 (scope) precedes every step that touches state.
    const scope = only('if (isSessionFailedForSend(event, watch.sessionId)) {');
    const freeze = only('const committed = watch.committed;');
    expect(scope).toBeLessThan(freeze);
    // Steps 4 and 8 for the watch, then step 7 for the draft — inside the one
    // function both callers go through, so neither can do half the chain.
    const chain = source.slice(
      only('const resolvePendingReplyLanded = useCallback('),
      only('  useEffect(() => {\n    const watch = pendingReplyRef.current;')
    );
    const dropRef = chain.indexOf('pendingReplyRef.current = null;');
    const dropSlot = chain.indexOf('clearPendingReply(sessionId);');
    const revoke = chain.indexOf('revokeRestoredDraftIfUntouched(sessionId);');
    expect(dropRef).toBeGreaterThanOrEqual(0);
    expect(dropRef).toBeLessThan(dropSlot);
    expect(dropSlot).toBeLessThan(revoke);
    // One cleanup authority; the three endings a pending turn can have (new
    // progress, a confirmed failure, a clean completion) all route into it.
    expect(offsets('resolvePendingReplyLanded(')).toHaveLength(3);
  });

  /**
   * `[D-4]` — the strongest form of "does not replay input": the `'pending'`
   * branch contains no writer of the composer AT ALL. Not "we checked and it
   * looked fine" — there is structurally nothing in there that could write.
   *
   * `updateValue` is the single write path for the text (F4 fix), and the two
   * attachment mutations are the only ways the draft list changes from this
   * component, so their joint absence is the whole surface.
   */
  it('[D-4] the pending branch contains no writer of the composer draft', () => {
    const body = ceilingBranchBody();
    for (const writer of [
      'updateValue(',
      'attachments.addDrafts(',
      'attachments.removeDrafts(',
      'restoredDraftRef.current',
      'setValue(',
    ]) {
      expect(body, `pending branch must not contain ${writer}`).not.toContain(writer);
    }
  });
});
