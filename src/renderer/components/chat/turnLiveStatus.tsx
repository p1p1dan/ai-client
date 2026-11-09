/**
 * Decision 211 (user, 2026-11-09): a running turn says what it is doing ONCE.
 *
 * The live row already says it — `∴ Thinking…`, `Bash(跑测试)` over
 * `⎿ Running…`, the desktop run's `Reading a.ts` under its passing light — and
 * a line of its own at the turn's foot used to say it again
 * (「思考中… (10 分 37 秒 · esc 中断)」). Now the turn's clock rides on that row:
 *
 *   ∴ Thinking… (10m 37s · esc 中断)       terminal, a thought streaming
 *   ● Bash(跑测试) (12s · esc 中断)         terminal, a step running
 *   Reading a.ts 4m 18s ›                   desktop, a run working
 *
 * and the line of its own is drawn only when no row is live: before the first
 * output and between two steps. While the reply streams it is not drawn at
 * all, as Claude Code hides its spinner line then (`replyStreaming`).
 *
 * Who decides: the turn's last tool group (`ToolGroup`), which holds the rows.
 * `ChatTurn` marks that group with `TurnLiveSlotContext` and leaves its own
 * foot line out; the group puts the clock on its last live row, or draws the
 * line itself at its end when none can carry it. One place answers, so the
 * status can be neither doubled nor lost. The row or run that carries it is
 * marked `data-turn-live-host`.
 */

import { createContext, useContext } from 'react';
import { StatusIcon } from '@/components/ui/status-icon';
import {
  terminalGutterClass,
  terminalLiveLineClass,
  terminalLiveTailClass,
  turnClockRowClass,
  turnLiveClockClass,
} from './chatTimelineLayout';
import type { TurnItem } from './chatTurn';
import { isDelegationRow, isSpecialStepRow } from './stepPresentation';
import type { StepRunEntry } from './stepRuns';
import { TranscriptStyleContext } from './TranscriptBlocks';
import type { ToolRowView } from './toolCard';
import {
  formatTerminalLiveActivity,
  formatTerminalLiveTail,
  formatTurnLiveLine,
  liveClockText,
  type TurnLivePhase,
} from './turnLiveHead';
import type { WorkedForParts } from './turnTiming';

/**
 * Stable: `true` only around the running turn's last item. Reset to `false`
 * inside a group, so rows that nest another group never draw a second line.
 */
export const TurnLiveSlotContext = createContext(false);

/** What the running turn's status says, once a second (`useTurnLiveClock`). */
export interface TurnLiveClock {
  /** Terminal, the line of its own: what the turn is doing, `Thinking…`. */
  activity: string;
  /** Terminal: 「(12s · esc 中断)」, at the end of the live row or the line. */
  tail: string;
  /** Desktop, the line of its own: `Thinking… 12s`. */
  line: string;
  /** Desktop: the bare clock after a live run's words, `4m 18s`; null unmeasured. */
  clock: string | null;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The words for `phase`, `elapsed` into the turn — or into the send, for the
 * head a send shows before its turn exists (`PendingTurnHead`), which draws
 * the same line.
 */
export function turnLiveClockOf(
  t: Translate,
  phase: TurnLivePhase,
  elapsed: WorkedForParts | null,
  stepWords: string | null = null
): TurnLiveClock {
  return {
    activity: formatTerminalLiveActivity(phase, stepWords),
    tail: formatTerminalLiveTail(t, elapsed),
    line: formatTurnLiveLine(phase, elapsed),
    clock: liveClockText(elapsed),
  };
}

/**
 * Ticking: the running turn's words, `null` everywhere else. Read only by the
 * leaves below, so a tick re-renders them and nothing above.
 */
export const TurnLiveClockContext = createContext<TurnLiveClock | null>(null);

/**
 * A live row that keeps its own drawing (a todo list, findings) carries no
 * status; the line of its own follows it. A subagent is a step like the
 * others since decision 212, and carries it.
 */
function carriesNoStatus(row: ToolRowView): boolean {
  return isSpecialStepRow(row) && !isDelegationRow(row);
}

/**
 * Terminal style: the row the status rides on — the newest live thought or
 * step, a subagent included. `-1` when nothing is live, or when the newest
 * live row keeps its own drawing (`carriesNoStatus`).
 */
export function liveRowHostIndex(rows: readonly ToolRowView[]): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index] as ToolRowView;
    if (!row.running) continue;
    return carriesNoStatus(row) ? -1 : index;
  }
  return -1;
}

/** Desktop style: the run (or the subagent's line) the status rides on, by the same rule. */
export function liveRunHostIndex(entries: readonly StepRunEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as StepRunEntry;
    if (entry.kind === 'special') {
      if (entry.row.running) return carriesNoStatus(entry.row) ? -1 : index;
      continue;
    }
    if (entry.rows.some((row) => row.running)) return index;
  }
  return -1;
}

/**
 * The reply is streaming into the turn's last item. Claude Code (2.1.273)
 * hides its spinner line once streamed text shows, and so does the line of
 * its own here: the words arriving say the turn is alive.
 */
export function replyStreaming(
  item: TurnItem | undefined,
  streamingBlockId: string | null
): boolean {
  return (
    item?.kind === 'text' && item.block.id === streamingBlockId && Boolean(item.block.text?.trim())
  );
}

/** Terminal: the status at the end of the live row, 「 (12s · esc 中断)」. */
export function TurnLiveTail() {
  const live = useContext(TurnLiveClockContext);
  if (!live) return null;
  return (
    <span data-slot="turn-live-tail" className={terminalLiveTailClass()}>
      {' '}
      {live.tail}
    </span>
  );
}

/** Desktop: the turn's clock after the live run's words, `4m 18s`. */
export function TurnLiveRunClock() {
  const live = useContext(TurnLiveClockContext);
  if (!live?.clock) return null;
  return (
    <span data-slot="turn-live-clock" className={turnLiveClockClass()}>
      {live.clock}
    </span>
  );
}

/**
 * The status as a line of its own, when no row is live (PiLab R1's foot line):
 * the CLI's star, what the turn is doing, how long, and how to stop it. At the
 * turn's foot the words come as `live`; at a group's end, from the context.
 */
export function TurnLiveLine({ live: given }: { live?: TurnLiveClock | null }) {
  const fromContext = useContext(TurnLiveClockContext);
  const live = given ?? fromContext;
  const terminal = useContext(TranscriptStyleContext) === 'terminal';
  if (!live) return null;
  if (terminal) {
    // Decision 208 (user ruling 2026-11-03, the comparison mockup's ①).
    return (
      <div data-slot="turn-live-line" className={terminalLiveLineClass()}>
        <span aria-hidden className={terminalGutterClass()}>
          <StatusIcon status="running" shape="star" />
        </span>
        <span className="min-w-0 truncate" title={live.activity}>
          {live.activity}
        </span>
        <span className={terminalLiveTailClass()}> {live.tail}</span>
      </div>
    );
  }
  return (
    <div data-slot="turn-live-line" className={turnClockRowClass()}>
      <StatusIcon status="running" />
      <span className="min-w-0 truncate" title={live.line}>
        {live.line}
      </span>
    </div>
  );
}
