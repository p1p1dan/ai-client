/**
 * F2 S3 (2026-08-18) — source-scan guards for `MessageTimeline.tsx`'s pending
 * turn head.
 *
 * Same posture, and the same reason, as `composerStopStatic.test.ts:1-16`:
 * `ChatTurn` is a `.tsx`-local memo component and this suite runs
 * `environment: 'node'` with `include: *.test.ts` (vitest.config.ts), so no
 * component ever renders here. The facts below are about which identifiers
 * take part in two specific derivations — which is exactly the kind of fact a
 * source scan CAN assert honestly, and a unit test cannot assert at all
 * without standing up a renderer this suite has deliberately never had.
 *
 * What both guards protect is one defect: a turn the Host admitted, never
 * answered and never failed used to lose its head entirely at the renderer's
 * budget — `inFlight` dies with the composer's snapshot (`runSend`'s `finally`
 * clears it) and `streamStartedAt` requires a first assistant message that by
 * definition never arrived. The head vanishing takes the Stop button with it,
 * on a turn that is still running server-side. `pendingReply` is the third
 * term that keeps it on screen; these assert it is actually wired into both
 * the "is this turn active" test and the seconds ticker, rather than being a
 * store slot with no reader.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TIMELINE_PATH = path.resolve(__dirname, '../MessageTimeline.tsx');

/**
 * Comments are blanked (parser-backed strip): every identifier below is also
 * discussed at length in the doc comments that explain WHY it is there, so a
 * scan that could not tell code from prose would pass on the explanation alone.
 */
const source = stripComments(readFileSync(TIMELINE_PATH, 'utf8'), 'MessageTimeline.tsx');

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

describe('MessageTimeline pending turn head (F2 S3 §4.5)', () => {
  /**
   * `[TS-2]` — the load-bearing line. All three terms must be present in the
   * SAME assignment: dropping `pendingActive` restores the lost-stopwatch
   * defect exactly, and it does so silently (no type error, no other test
   * fails, the head just disappears at 300s on a live turn).
   */
  it('[TS-2] turnActive is derived from all three activity terms', () => {
    const assignment = source.match(/const turnActive = [^;]+;/);
    expect(assignment, 'turnActive assignment not found').not.toBeNull();
    const line = assignment?.[0] ?? '';
    expect(line).toContain('inFlight');
    expect(line).toContain('streamStartedAt');
    expect(line).toContain('pendingActive');
    // Exactly one derivation of it — a second one somewhere else in the file
    // would be a fork of the same judgement.
    expect(offsets('const turnActive =')).toHaveLength(1);
  });

  /**
   * `pendingActive` itself must come from the watch, and must stay scoped to
   * the last turn — the ticking props reach only that turn (F7's memo
   * discipline), so a head painted on an older turn would both be wrong and
   * defeat the memo session-wide.
   */
  it('[TS-2] pendingActive comes from the session-scoped watch, last turn only', () => {
    const assignment = source.match(/const pendingActive = [^;]+;/);
    expect(assignment, 'pendingActive assignment not found').not.toBeNull();
    const line = assignment?.[0] ?? '';
    expect(line).toContain('isLastTurn');
    expect(line).toContain('pendingReply');
    // The selector is session-scoped at its source, like `sendStatus` and
    // `baseline` next to it — a session switch mid-wait must not paint this
    // timeline's head with another session's clock.
    expect(source).toContain('state.pendingReply.sessionId === sessionId');
  });

  /**
   * `[TS-3]` — without this the clock stops the moment the composer's snapshot
   * is cleared, and the head freezes at whatever second the ceiling happened
   * to land on. A frozen clock reads as "this is dead", which is precisely the
   * false verdict this batch exists to remove.
   */
  it('[TS-3] the seconds ticker stays enabled while a reply is pending', () => {
    // Anchored on the CALL, not on the declaration a few hundred lines above
    // it (`function useSecondsTick(enabled: boolean)` would match a bare
    // `useSecondsTick(` needle first).
    const call = source.match(/const nowMs = useSecondsTick\([^)]*\)/);
    expect(call, 'useSecondsTick call site not found').not.toBeNull();
    const args = call?.[0] ?? '';
    expect(args).toContain('pendingReply');
    // The other two enable terms are unchanged — this is an addition, not a
    // replacement (dropping `sendStatus` would break the handshake clock).
    expect(args).toContain('inFlightSession');
    expect(args).toContain('sendStatus');
  });

  /**
   * The elapsed seconds are RECOMPUTED from the watch's arm time rather than
   * carried over from a frozen snapshot. This is why no second ticker had to
   * be built: `useSecondsTick` above already runs for exactly as long as the
   * watch does, and `nowMs - turnStartedAtMs` is the whole clock.
   */
  it('[TS-3] pending elapsed seconds are recomputed from the watch, not frozen', () => {
    expect(source).toContain('pendingReply.turnStartedAtMs');
    // The retired byte-scaled budget must not come back through this file —
    // it was `sendTimeoutMs`'s last consumer in the whole renderer.
    expect(source).not.toContain('sendTimeoutMs');
    expect(source).toContain('const DEFAULT_REPLY_BUDGET_MS = SEND_SILENCE_CEILING_MS;');
  });
});
