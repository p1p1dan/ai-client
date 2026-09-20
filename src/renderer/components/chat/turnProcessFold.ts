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
 * The reply the user actually wants is the LAST thing the model said; the rest
 * is evidence they open when they choose to.
 *
 * So the unit is no longer "one process run" but "everything before the final
 * output": one head, one collapsible body, and the final output permanently
 * outside it. `countProcessSteps` survives unchanged — it is now the head's
 * FALLBACK sentence, used when the turn has no timestamps to report.
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

/** Where each segment renders, once the final output has been identified. */
export interface TurnWorkGroupSplit<T> {
  /**
   * Outside the group, ABOVE it. Non-empty only in the one case where a group
   * would be an empty shell — see `splitTurnWorkGroup`'s "no process, no head".
   */
  leading: TurnSegment<T>[];
  /** Inside the group, in order. Empty means no group head renders at all. */
  grouped: TurnSegment<T>[];
  /** The final output. `null` when the turn produced no prose at all. */
  finalAnswer: TurnSegment<T> | null;
  /** Outside the group, BELOW the final output, in order. */
  trailing: TurnSegment<T>[];
}

/**
 * Split a turn's ordered segments into "the work" and "the answer".
 *
 * **The final output is the LAST `answer` SEGMENT.** Everything before it goes
 * into the group; everything after it stays outside, in order.
 *
 * ## Why "last answer segment" and not "the trailing run of text items"
 *
 * Because the trailing-run rule is the FB4 defect, and this is the third time
 * the repo has had to write the rule down. Under it, `answer` was the run of
 * `text` items at the very end of the turn — so a turn that ended in an error
 * notice had NO answer, and every paragraph the model had written went into the
 * collapsed segment. The user's report then was "my prose disappeared into
 * Worked for".
 *
 * The difference is exactly this: notices do not participate in the scan. They
 * cannot end the answer (a notice after the final output stays in `trailing`,
 * visible), and they cannot create one. `chatTurn.ts`'s head note carries the
 * other half of the same ruling — a notice is its own segment kind precisely so
 * this stays expressible.
 *
 * ## The three shapes
 *
 *  - **an answer exists** — `grouped` is everything before it, `trailing` is
 *    everything after it. A notice BETWEEN two prose runs therefore does go
 *    inside, which is the spec's own ruling ("它之前的所有 segment"): it is part
 *    of what happened on the way to the answer that followed it.
 *  - **no answer at all** (a turn that only ran tools, or ended on an error) —
 *    the `process` segments go in and the `notice` segments stay out. NOT
 *    "everything in", which would collapse the whole turn to a single line and
 *    hide the error that is the only thing it has to say.
 *  - **no process before the answer** — no group at all. A one-paragraph reply
 *    must not grow an empty shell, and the same reasoning covers the case where
 *    the only thing before the answer is a notice: a head that hides no work is
 *    a head that hides an error message.
 *
 * ## Known ordering deviation, stated rather than hidden
 *
 * In the no-answer shape the two buckets are FILTERED, so a notice that
 * happened between two tool runs renders below the group instead of between
 * them. Everywhere else order is exact. The alternative — splitting the group
 * in two around the notice — would put two heads on one turn and report the
 * same duration twice, which is the shape 2026-09-10 shipped and this replaces.
 *
 * Streaming: `trailing` can legitimately hold `process` segments while a turn
 * runs (the model spoke, then called a tool, and has not spoken again yet).
 * They move into `grouped` when the next prose arrives. That boundary move is
 * expected — `segmentTurnBody` itself never reorders, and every expandable row
 * inside restores its open/closed state from `toolExpansion.ts` at mount, so a
 * remount costs no user state.
 */
export function splitTurnWorkGroup<T>(segments: readonly TurnSegment<T>[]): TurnWorkGroupSplit<T> {
  let lastAnswer = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].kind === 'answer') {
      lastAnswer = index;
      break;
    }
  }

  if (lastAnswer === -1) {
    return {
      leading: [],
      grouped: segments.filter((segment) => segment.kind === 'process'),
      finalAnswer: null,
      trailing: segments.filter((segment) => segment.kind !== 'process'),
    };
  }

  const before = segments.slice(0, lastAnswer);
  const hidesWork = before.some((segment) => segment.kind === 'process');
  return {
    leading: hidesWork ? [] : before,
    grouped: hidesWork ? before : [],
    finalAnswer: segments[lastAnswer],
    trailing: segments.slice(lastAnswer + 1),
  };
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
 * Whether the group is open. Two rules, in precedence order.
 *
 *  1. an unanswered authorization/question wins over everything (red line
 *     above) — the user cannot collapse away the card they are being asked to
 *     answer, and neither can the auto-collapse;
 *  2. otherwise the user's own choice, once made, is permanent for this turn;
 *  3. otherwise the group is CLOSED — while the turn runs just as much as once
 *     it has ended.
 *
 * ## Rule 3 is the 2026-09-19 change (user decision, D6)
 *
 * It used to read `return !input.settled`, i.e. a running turn kept its group
 * open and the tuple collapsed itself at the transition. The user's report was
 * about the running case specifically: a long tool sequence left a wall of
 * 「Read / Grep / Read / Edit」 on screen for the whole turn, and the head above
 * it was lost in the middle. So the group starts folded and STAYS folded, and
 * the head — which now carries the current action, not just a clock — is the
 * one-line answer to "what is it doing".
 *
 * `settled` was DELETED from the input rather than kept and ignored: an
 * exported input nothing reads is a rule waiting to be mistaken for a live one
 * (§13 ①), and `TurnProgressHead` still takes `settled` for its own reasons
 * (spinner, label, the current-action clause) — it simply no longer decides
 * this.
 *
 * What survives from the old rule set: rule 1 unchanged (the authorization red
 * line), and rule 2 unchanged, which is what keeps a reader's click from being
 * overridden by any later render.
 *
 * ## Why this is still derived rather than an effect
 *
 * "Collapse when the turn ends" was the one-shot that motivated deriving this
 * in the first place, and the objection holds even more strongly now that the
 * group is always closed: an `useEffect` + ref would fire twice under
 * StrictMode and could slam the group shut under a reader who had just opened
 * it. Deriving makes both unreachable — rule 2 outranks the default forever
 * after, and no render can override a choice.
 *
 * It also keeps the restored-history case for free: a turn that was never in
 * flight in this window mounts collapsed without anything having to detect that
 * it is history.
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
