/**
 * The turn's WORK GROUP — what folds, whether it is open, and what its head
 * says — plus the turn's own WORK ZONE row at the very end of it.
 *
 * T113 (2026-09-21, user decision) split those two apart. The head used to
 * carry both: 「已处理 N 个步骤」 for every group but the last, and the whole
 * TURN's duration/usage/thinking for that one — two different scopes wearing
 * one identical-looking line, which is what the user called 「有点不协调」. Now
 * the head reports its own thinking/tool/explanation chips, and everything true
 * of the turn rather than of a group lives on `deriveTurnWorkZone`'s row.
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
 * T107 kept every answer visible. Q1 now folds intermediate prose with the
 * process while keeping the last answer and notices outside. The last answer
 * retains its ordinary visual treatment; `countProcessSteps` only controls
 * the fold threshold, while separate counters supply the chips.
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

/**
 * Does this process group earn a fold at all?
 *
 * T112 (user decision 2026-09-21): 「如果只有一条，就直接显示，如果有多条一起，
 * 那就合并为 N 个步骤」. A single step behind a disclosure costs a click to read
 * one line that already fits, and the head hiding it would read 「1 个步骤」 —
 * the row itself, counted.
 *
 * This is the rule the TOOL ROWS have had since sign-off ②/A07 `:2348`
 * (`toolCard.ts`'s `deriveToolGroupRows`: "恰好 1 条不聚合"), applied one level
 * out to the group that wraps them. Measured in STEPS rather than items, so the
 * threshold is exactly the number the head would otherwise have printed.
 *
 * Zero counts as "no fold" alongside one, and that is not a new case: a group
 * with nothing to count already had no head, because `deriveTurnWorkGroupLabel`
 * returns `null` there. It renders in place either way.
 *
 * The authorization red line moves only in the safe direction: a group that
 * does not fold is unconditionally on screen, so an unanswered
 * permission/question that happens to be the group's only step becomes MORE
 * reachable, never less. `turnWorkGroupAwaitsUser` still governs every group
 * that does fold.
 */
export function turnProcessGroupFolds(items: readonly TurnItem[]): boolean {
  return countProcessSteps(items) > 1;
}

export type TurnWorkSection<T> =
  | { kind: 'finalAnswer'; segment: TurnSegment<T> }
  | { kind: 'notice'; segment: TurnSegment<T> }
  | { kind: 'processGroup'; segments: TurnSegment<T>[] };

/**
 * Is this the turn's FINAL reply, given that the turn has stopped streaming?
 *
 * The rule is 「其后不再跟着 process 段落」 — not 「它是最后一段 answer」. Under the
 * second rule a turn shaped `answer → 工具 → 结束` (the model narrates, then
 * makes one last call) had its trailing narration pulled out as the final reply
 * while a tool call still followed it, which is the T107-era 「各种调用穿插在
 * agent 的输出中」 complaint wearing a new shape.
 *
 * ⚠️ **THIS IS THE ONE FORWARD-LOOKING RULE IN THE SPLIT, AND IT IS DELIBERATE.**
 * `chatTurn.ts` records the segmenter's contract as "no reason to ever look
 * ahead", and the loop in `splitTurnWorkGroup` honours it — it walks forward
 * once. This predicate is where that contract is broken, on purpose and at one
 * point: "does process follow?" cannot be answered by a backward scan, because
 * the very thing that disqualifies a candidate sits AFTER it.
 *
 * Do not "simplify" the caller back to a backward scan for `lastAnswerIndex`.
 * That version passes every case where prose ends the turn and silently
 * mislabels the `answer → tool → end` shape, which is the case decision 033 D1
 * named by name.
 *
 * Only meaningful once `processSettled` is true — see `splitTurnWorkGroup`.
 */
export function isFinalAnswerSegment<T>(
  segments: readonly TurnSegment<T>[],
  index: number
): boolean {
  if (segments[index]?.kind !== 'answer') return false;
  for (let after = index + 1; after < segments.length; after += 1) {
    if (segments[after].kind === 'process') return false;
  }
  return true;
}

/**
 * Fold every process AND non-final answer segment into the process group; the
 * final answer segment stays outside with its ordinary answer styling.
 *
 * Notices remain outside in original order (FB4 — an error after the final
 * reply must never hide earlier prose). No process means no empty group.
 *
 * The no-answer case keeps the existing ordering exception: notices between
 * tool runs render after the single process group.
 *
 * ## `settled` is the whole of decision 033 D1's timing change
 *
 * While the turn streams (`settled === false`) there is **no final answer to
 * find**: the model has not stopped, so any segment picked now is a guess the
 * next tool call invalidates. Everything stays in the group and nothing is lit
 * up early — which is also why contention C from `1e33b7fe` (a colour that
 * flips mid-stream) cannot arise.
 *
 * Once settled, the final answer is `isFinalAnswerSegment`'s, and the group
 * keeps its `groupKey` (first item identity) across the extraction, so the
 * reader's expansion survives the one structural change the turn makes.
 *
 * `settled` is REQUIRED rather than optional with a default: a call site that
 * forgot to thread it would freeze the turn at "streaming" forever, and a type
 * error is the cheaper alarm than a transcript that never separates its reply.
 */
export function splitTurnWorkGroup<T>(
  segments: readonly TurnSegment<T>[],
  settled: boolean
): TurnWorkSection<T>[] {
  // The LAST answer, then the forward-looking test — in that order. Scanning
  // forward for the first segment that passes `isFinalAnswerSegment` picks the
  // WRONG paragraph whenever a turn ends `answer → notice → answer`: the
  // earlier one also has no process after it, so a forward scan extracts it and
  // folds the turn's actual last paragraph into the group.
  //
  // Taking the last answer first makes the two rules one: if process follows
  // it, no earlier answer can qualify either (that same process follows them
  // all), so a failed test here means the turn simply has no final reply — the
  // `answer → 工具 → 结束` shape decision 033 D1 named.
  let finalAnswerIndex = -1;
  if (settled) {
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (segments[index].kind !== 'answer') continue;
      finalAnswerIndex = isFinalAnswerSegment(segments, index) ? index : -1;
      break;
    }
  }

  if (finalAnswerIndex === -1) {
    // Streaming, or a turn with no final answer at all: ONE group holds every
    // process and answer segment. Notices still stay outside, in order.
    const grouped = segments.filter((segment) => segment.kind !== 'notice');
    const sections: TurnWorkSection<T>[] = grouped.length
      ? [{ kind: 'processGroup', segments: grouped }]
      : [];
    for (const segment of segments) {
      if (segment.kind === 'notice') sections.push({ kind: 'notice', segment });
    }
    return sections;
  }

  const sections: TurnWorkSection<T>[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.kind === 'notice') {
      sections.push({ kind: 'notice', segment });
    } else if (index === finalAnswerIndex) {
      sections.push({ kind: 'finalAnswer', segment });
    } else {
      // Process or non-final answer → process group.
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
  settled?: boolean;
}

/** Authorization wins; manual choices apply within the current turn phase. */
export function turnWorkGroupOpen(input: TurnWorkGroupOpenInput): boolean {
  if (input.forcedOpen) return true;
  if (input.userOpen !== null) return input.userOpen;
  return !input.settled;
}

/**
 * What the turn is doing RIGHT NOW, for the live clause on the turn's work zone
 * row (T105, D6; moved off the group head by T113).
 *
 * ## Why this exists at all
 *
 * With every process group collapsed, this clause is the ONLY progress evidence
 * a running turn has on screen — the row is one line, and if that line is a
 * bare ticking clock the turn is indistinguishable from a hung one. The user's
 * own report on the arrangement before it was exactly that: a 50-second wait
 * whose only signal was a counter.
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
 * `toolCard`'s argument formatting and of any translator: the caller
 * translates the verb. T108 omits the arguments, so the words are still
 * composed at paint where every other verb in this app becomes words. `verb`
 * is the catalog key for that name, resolved through the same `toolVerb` table
 * the row itself uses.
 *
 * T113 changed WHICH translator that is, and it is worth stating: this clause
 * used to be composed on the English-only group head (decision 031 D7), and it
 * now rides the work zone row, which is Chinese like the rest of the chat
 * surface. The verbs have had Chinese entries all along (`toolVocabulary`), so
 * the move is a swap of translator, not of vocabulary.
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

/*
 * `TurnWorkGroupLabel` / `deriveTurnWorkGroupLabel` retired with the head shape
 * they chose between (T113, 2026-09-21).
 *
 * Their whole job was picking one of three things for a head to say — 「工作中
 * N 秒」 while running, 「已工作 57 秒」 once settled, 「已处理 N 个步骤」 when no
 * clock was ever measured — and returning `null` for the turn that knew none of
 * them. Every one of those branches has moved:
 *
 *  - the two duration forms are now the WORK ZONE row's two states
 *    (`deriveTurnWorkZone` below), where they describe the turn rather than
 *    whichever group happened to be last;
 *  - the step count is what a head says, always, and it is `countProcessSteps`
 *    directly — no choice left to make;
 *  - the `null` case cannot arise any more. T112 stopped rendering a head for a
 *    group of fewer than two steps, so by the time one exists it has a count.
 *
 * The A07 `:2399` rule they enforced did NOT retire with them: an unmeasured
 * duration is still omitted rather than printed as `0 秒`, and that is now
 * `deriveTurnWorkZone`'s `null` return.
 *
 * ## What the deleted doc block used to argue, and what survives of it
 *
 * Its 2026-09-18 note explained why the running head had been given the clock
 * at all: it used to say a bare 「工作中」 on the ground that a second-by-second
 * status row already existed above the composer, and the user's report after
 * living with that was that the row sits far from the reply it describes and a
 * 50-second wait behind it reads as a hang. That reasoning is intact — the
 * clock still lives next to the output it belongs to. T113 only moved it one
 * line further down, off a group head and onto the turn's own row, because a
 * clock riding the LAST group is a turn-level fact wearing a group-level line.
 *
 * ## One claim from that block was simply wrong, and is not carried forward
 *
 * It said 「The composer row keeps its own count; the two are derived from
 * different origins」 and left an open question about retiring one of them.
 * There is no second count: that row moved INTO the turn in T-31 §3
 * (`ChatComposer.tsx`, with its three status values in
 * `stores/turnSendStatus.ts`). A reviewer was misled by the sentence once —
 * into expecting two clocks stacked on screen — which is why it is corrected
 * here rather than deleted quietly. What DOES need to stay a relay is this row
 * and `PendingTurnHead`, and `statusOwnedByPendingHead` is what arranges it.
 */

/**
 * How many TOOL CALLS this turn made — the 「8 次工具调用」 clause of the row
 * below, and one of the four figures the user named for it.
 *
 * Counts `run` entries, so a group holding four calls is four, the same way
 * `countProcessSteps` refuses to call it one. It deliberately does NOT reuse
 * `turnTiming.ts`'s `deriveTurnStats`, which was the obvious candidate: that
 * one buckets into tools / searches / edits and would print three numbers where
 * the user asked for one, and it reads raw `ChatBlock`s, which this layer does
 * not have.
 *
 * ## What it counts, stated plainly
 *
 * Every call the turn ISSUED, including one that failed. `deriveTurnStats`
 * excluded refused calls, and for a good reason that does not apply here: it
 * printed 「1 edit」, a claim that an edit HAPPENED, which is false for a write
 * the user declined. 「8 次工具调用」 claims only that eight calls were made,
 * which stays true whatever came back — and the refusal set it would need
 * (`refusedToolCallIds`) is derived from blocks, one layer below this one.
 *
 * A thinking block is not a call and is not counted, even though
 * `countProcessSteps` counts it as a step. The two numbers answer different
 * questions and are allowed to differ; the row and the head say so by using
 * different words for them.
 */
export function countTurnToolCalls(items: readonly TurnItem[]): number {
  return items.reduce(
    (total, item) =>
      item.kind === 'toolGroup'
        ? total + item.entries.filter((entry) => entry.kind === 'run').length
        : total,
    0
  );
}

/**
 * The turn's tail row, in its two states.
 *
 * `working.elapsed` is `null` for a turn running with NO clock at all — a
 * session already in flight when this window opened replays no
 * `message.started`, so there is no origin to count from and the row says a
 * bare 「工作中」 rather than a fabricated 「工作中 0 秒」.
 *
 * The settled shape carries NUMBERS and a timestamp, never formatted text: the
 * render site turns them into catalog keys so Chinese writes 「已工作 1 分 6
 * 秒」 instead of interpolating an English "1m 6s" into a Chinese sentence.
 */
export type TurnWorkZone =
  | { kind: 'working'; elapsed: WorkedForParts | null }
  | {
      kind: 'worked';
      /**
       * `null` for a turn whose span nothing measured — a replayed entry Pi
       * could not date. The render site prints the bare state word there, never
       * 「已工作 0 秒」 (A07 `:2399`).
       */
      worked: WorkedForParts | null;
      /** Wall-clock completion, or `null` for a turn that replayed no timing. */
      completedAtMs: number | null;
      /** `null` rather than `0` — a turn that called nothing says nothing here. */
      toolCalls: number | null;
      /** `null` when the provider reported no reasoning at all. */
      thinkingMs: number | null;
    };

/**
 * The turn's own line: 「✻ 工作中 47 秒」 while it runs, 「✻ 已工作 54 秒 · 完成
 * 于 17:05 · 8 次工具调用 · 思考 12 秒」 once it stops.
 *
 * ## The four settled figures are the user's list, and it is closed
 *
 * Duration, completion time, tool calls, thinking time (2026-09-21). Token
 * usage was considered and explicitly left off — do not add it back here
 * because the numbers happen to be available; `turnProgress.ts` still formats
 * them for whoever needs them next, and this row is not that surface.
 *
 * ## Why this ALWAYS returns a zone, and the row decides its own silence
 *
 * It used to return `null` for a settled turn with no measured span, and the
 * two elements reading it both dropped out together: no tail row (correct) AND
 * a fold head with no text at all (the 2026-09-22 defect 「现在折叠头和尾栏都
 * 没了」). A head must still say WHAT STATE the turn is in when it cannot say
 * how long — that is a fact it always has — so the absence now lives INSIDE the
 * zone as `worked: null`, and each reader answers for itself: the head prints
 * the bare state word, and `TurnWorkZoneRow` renders nothing when it has no
 * clause to print.
 *
 * A07 `:2399` is unchanged by that move — an unmeasured figure is still omitted
 * rather than printed as a zero. What changed is that "unmeasured" is now
 * representable, instead of being signalled by deleting the whole row.
 *
 * ## Running beats settled, and the reason it is a branch and not a merge
 *
 * A running turn has no completion timestamp, and `workedMs` on an unsettled
 * turn is whatever a PREVIOUS message in it happened to close with. So the two
 * states read different inputs on purpose; `running` is the caller's
 * `!processSettled`, which is also what keeps this row and `PendingTurnHead`
 * a relay rather than two clocks side by side.
 */
export function deriveTurnWorkZone(input: {
  /** The turn is still going (`!processSettled` at the call site). */
  running: boolean;
  /** Seconds since the turn's own clock started, or `null` when it has none. */
  elapsedSeconds: number | null;
  /** Whole-turn span once settled, or `null` when the turn replayed no timing. */
  workedMs: number | null;
  completedAtMs: number | null;
  toolCalls: number;
  thinkingMs: number | null;
}): TurnWorkZone {
  if (input.running) {
    return {
      kind: 'working',
      elapsed:
        input.elapsedSeconds === null ? null : splitWorkedForDuration(input.elapsedSeconds * 1000),
    };
  }
  return {
    kind: 'worked',
    worked: input.workedMs === null ? null : splitWorkedForDuration(input.workedMs),
    completedAtMs: input.completedAtMs,
    toolCalls: input.toolCalls > 0 ? input.toolCalls : null,
    thinkingMs: input.thinkingMs,
  };
}
