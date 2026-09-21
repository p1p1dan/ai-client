/**
 * The turn's WORK GROUP: what goes behind the 「工作中 / 已工作 57 秒」 line, what
 * stays outside it, and whether it is open.
 *
 * Pure, and in its own `.ts`: the vitest suite runs `environment: node` and
 * only collects `*.test.ts`, so anything living inside `MessageTimeline.tsx`
 * can only be asserted by scanning source. Every rule here is a question worth
 * a real test, so they live where a test can import them.
 *
 * ## What this replaces (2026-09-18, user decision)
 *
 * 2026-09-10 folded each COMPLETED `process` segment on its own, behind 「已处理
 * N 个步骤」. That left prose and process runs alternating down the turn — the
 * user's report was 「各种调用、授权穿插在 agent 的输出中，严重影响我的观感」.
 * That led to a single group containing everything before the last answer.
 * T107 (2026-09-21, user-confirmed B shape) supersedes that placement: EVERY
 * answer stays visible, and only process segments fold. The FB4 lesson still
 * applies: ending on an error must never hide earlier prose or the error.
 * `countProcessSteps` remains the head's fallback when timing is unavailable.
 */

import type { TurnItem, TurnSegment } from './chatTurn';
import { type ToolRun, type ToolVerbState, toolVerb } from './toolCard';
import { splitWorkedForDuration, type WorkedForParts } from './turnTiming';

/**
 * How many steps a folded process segment says it took.
 *
 * A tool group is not one step: it is the run(s) and thinking blocks inside it,
 * which is what the user watched happen. Counting groups instead would report
 * "1 步骤" for a turn that ran four tools.
 */
export function countProcessSteps(items: readonly TurnItem[]): number {
  return items.reduce((total, item) => {
    if (item.kind === 'toolGroup') return total + item.entries.length;
    if (item.kind === 'permissionActivity') return total + item.blocks.length;
    return total + 1;
  }, 0);
}

export type TurnWorkSection<T> =
  | { kind: 'answer'; segment: TurnSegment<T> }
  | { kind: 'notice'; segment: TurnSegment<T> }
  | { kind: 'processGroup'; segments: TurnSegment<T>[] };

/**
 * T107: preserve every answer and fold only consecutive process segments.
 * Notices remain outside, including errors after the final answer (FB4).
 * No process means no empty group or disclosure affordance.
 *
 * The no-answer case keeps the existing ordering exception: notices between
 * tool runs render after the single process group. Changing that behavior is
 * outside T107; with answers present, segment order remains exact.
 *
 * Unlike the former last-answer boundary, appending prose does not reparent
 * earlier tool rows, so their expansion state survives streaming naturally.
 */
export function splitTurnWorkGroup<T>(segments: readonly TurnSegment<T>[]): TurnWorkSection<T>[] {
  if (!segments.some((segment) => segment.kind === 'answer')) {
    const process = segments.filter((segment) => segment.kind === 'process');
    const sections: TurnWorkSection<T>[] = process.length
      ? [{ kind: 'processGroup', segments: process }]
      : [];
    for (const segment of segments) {
      if (segment.kind === 'notice') sections.push({ kind: 'notice', segment });
    }
    return sections;
  }

  const sections: TurnWorkSection<T>[] = [];
  for (const segment of segments) {
    if (segment.kind !== 'process') {
      sections.push({ kind: segment.kind, segment });
    } else {
      const previous = sections.at(-1);
      if (previous?.kind === 'processGroup') previous.segments.push(segment);
      else sections.push({ kind: 'processGroup', segments: [segment] });
    }
  }
  return sections;
}

/**
 * The authorization red line, as a predicate.
 *
 * An unanswered `permission` or `question` card inside the group forces it
 * open and keeps it open: a collapsed group would bury the only Allow/Deny
 * surface in the app, and a turn stuck waiting for an answer the user cannot
 * see is a turn that looks frozen.
 *
 * `resolved !== true` rather than `resolved === false`: an older card carries no
 * `resolved` field at all, and "we don't know whether this was answered" must
 * fail OPEN.
 *
 * ## Status after 2026-09-18: a conservative backstop, kept on purpose
 *
 * Neither live card renders inside the group any more — both moved above the
 * composer (`PendingQuestionDock`, `PendingPermissionDock`), and the timeline
 * renders an unanswered one as nothing at all. So the thing this predicate
 * protects is no longer IN the group, and it can now only over-trigger: a turn
 * whose group holds an unsettled card keeps that group expanded for a card that
 * is being answered somewhere else on screen.
 *
 * That direction is safe (more shown, never less), which is why it stays rather
 * than being deleted with the arrangement it was written for. Do not "fix" it
 * by narrowing the condition — if the dock arrangement is ever reverted, this
 * is the guard that keeps the only Allow/Deny surface reachable.
 */
export function turnWorkGroupAwaitsUser(segments: readonly TurnSegment<TurnItem>[]): boolean {
  return segments.some((segment) =>
    segment.items.some(
      (item) =>
        (item.kind === 'permission' || item.kind === 'question') && item.block.resolved !== true
    )
  );
}

export interface TurnWorkGroupOpenInput {
  /** `turnWorkGroupAwaitsUser` over the grouped segments. */
  forcedOpen: boolean;
  /** The user's own click, or `null` while they have not expressed one. */
  userOpen: boolean | null;
}

/**
 * Authorization wins, then the user's choice, then the closed default.
 *
 * D6 first closed groups to avoid a wall of tools. ef26ca5f opened them to
 * expose hidden prose. T107 now keeps ALL prose outside and, with the user's
 * explicit confirmation, restores closed process groups. Neither live nor
 * restored turns need a `settled` input to choose their default.
 *
 * Keep this derived: an effect/ref under StrictMode can run twice and close
 * a group the reader just opened. Explicit choices always outrank defaults.
 */
export function turnWorkGroupOpen(input: TurnWorkGroupOpenInput): boolean {
  if (input.forcedOpen) return true;
  if (input.userOpen !== null) return input.userOpen;
  return false;
}

/**
 * What the turn is doing RIGHT NOW, for the head's live clause (T105, D6).
 *
 * ## Why this exists at all
 *
 * Once the work group is always collapsed, this clause is the ONLY progress
 * evidence a running turn has on screen — the head is one line, and if that
 * line is a bare ticking clock the turn is indistinguishable from a hung one.
 * The user's own report on the previous arrangement was exactly that: a
 * 50-second wait whose only signal was a counter.
 *
 * ## The fallback is the point, not a nicety
 *
 * Between two tool calls — while the model thinks, while a request is being
 * dispatched, in the gap after a result lands — no run is `running`. Returning
 * `null` there would blink the clause off and on several times a second while
 * the seconds kept counting: a head that reads as stuck. So the scan falls back
 * to the LAST completed run and describes it, which is also the honest answer
 * to "what has it been doing" one second after a call finished. The verb state
 * travels with it (`'running'` vs `'refused'` = the plain infinitive) so the
 * caller never has to guess which grammar the sentence needs.
 *
 * Returning the RUN rather than a formatted string keeps this module free of
 * `toolCard`'s argument formatting and of any translator: the caller already
 * holds both (`MessageTimeline.tsx` renders in English — user decision
 * 2026-09-19 — with `formatToolArg`), so the words are composed at paint where
 * every other verb in this app becomes words. `verb` is the catalog key for
 * that name, resolved through the same `toolVerb` table the row itself uses.
 *
 * Reverse order on both levels, so the newest news wins: the last `toolGroup`
 * item that holds any run, and within it the last running run (or, failing
 * that, the last run at all).
 */
export interface TurnCurrentAction {
  run: ToolRun;
  /** Catalog key for the operation's name — `running` or `refused` (the infinitive). */
  verb: string;
  state: Extract<ToolVerbState, 'running' | 'refused'>;
}

export function deriveTurnCurrentAction(items: readonly TurnItem[]): TurnCurrentAction | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind !== 'toolGroup') continue;
    let last: ToolRun | null = null;
    for (let entryIndex = item.entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
      const entry = item.entries[entryIndex];
      if (entry.kind !== 'run') continue;
      last = last ?? entry.run;
      if (entry.run.status === 'running') {
        return actionOf(entry.run, 'running');
      }
    }
    if (last) return actionOf(last, 'refused');
  }
  return null;
}

function actionOf(run: ToolRun, state: Extract<ToolVerbState, 'running' | 'refused'>) {
  return { run, verb: toolVerb(run.toolName, state), state };
}

/**
 * What the group's head says about itself.
 *
 * Both duration variants carry NUMBERS, not a formatted string: the render site
 * turns them into one of the catalog keys so Chinese can write 「已工作 1 分 6
 * 秒」 instead of interpolating an English "1m 6s" into a Chinese sentence.
 *
 * `working.elapsed` is `null` for a turn that is running with NO clock at all —
 * a session that was already in flight when this window opened replays no
 * `message.started`, so there is no origin to count from and the head says a
 * bare 「工作中」 rather than a fabricated 「工作中 0 秒」.
 */
export type TurnWorkGroupLabel =
  | { kind: 'working'; elapsed: WorkedForParts | null }
  | { kind: 'worked'; minutes: number; seconds: number }
  | { kind: 'steps'; steps: number };

/**
 * Head copy for the work group. `null` means the head has nothing honest to
 * say and does not render at all.
 *
 * ## 2026-09-18 (second pass): the running head carries the clock
 *
 * It used to say 「工作中」 and nothing else, on the ground that "there is
 * already a second-by-second status row" — that row being the one above the
 * composer. The user's report after living with it: that row is the ONLY
 * evidence a turn is alive, it sits far from the reply it describes, and a
 * 50-second wait behind it reads as a hang. So the clock moves here, next to
 * the output it belongs to. The composer row keeps its own count; the two are
 * derived from different origins (`activity.since` vs `message.started`) and
 * can legitimately differ by a second — see the report for the open question
 * about retiring one of them.
 *
 * ## The `null` cases, and why neither is a zero
 *
 *  - **settled, no duration, no steps** — a restored history turn that replayed
 *    no timing events and folded no work. Printing 「已工作 0 秒」 or 「已处理 0
 *    个步骤」 would both be claims about a turn this window never watched
 *    (A07 `:2399`, and `deriveTurnWorkedMs`'s own note).
 *  - **settled, no duration, some steps** — still reports the STEP count, which
 *    is the fallback that has been here since 2026-09-10 and is the one thing
 *    such a turn does know about itself.
 */
export function deriveTurnWorkGroupLabel(input: {
  settled: boolean;
  workedMs: number | null;
  steps: number;
  /** Seconds since the turn's own clock started, or `null` when it has none. */
  elapsedSeconds: number | null;
}): TurnWorkGroupLabel | null {
  if (!input.settled) {
    return {
      kind: 'working',
      elapsed:
        input.elapsedSeconds === null ? null : splitWorkedForDuration(input.elapsedSeconds * 1000),
    };
  }
  if (input.workedMs === null) {
    return input.steps > 0 ? { kind: 'steps', steps: input.steps } : null;
  }
  return { kind: 'worked', ...splitWorkedForDuration(input.workedMs) };
}
