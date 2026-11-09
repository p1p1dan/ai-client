/**
 * Route B S-6 feedback 11c (user, 2026-10-17): a running turn says what it is doing on
 * ONE line, verb first, the way the Claude Code status line does:
 *
 *   Connecting… 1s
 *   Thinking… 3s                     (waiting for the first byte, or thinking)
 *   Replying… 12s                    (the reply streaming)
 *   Running… 20s                     (a tool running: its own verb)
 *   Working… 30s                     (nothing more specific is known)
 *
 * (Decision 211 made the words English and the clock `12s`; they were 「思考中 3 秒」.)
 *
 * It used to be 「✻ 工作中 N 秒」 over a second status row (「思索中… · ↑ 15 字符 · 2s」)
 * whose seconds counted the same wait again. That row is drawn now only when it says
 * something this line cannot: the slow and stalled hints and a failure (`ChatTurn`).
 * 「工作中」 stays as the fallback, so the line never reads as a bare stopwatch.
 *
 * User, 2026-10-19: no ↑/↓ counts on this line. They read as token figures that
 * did not match the Claude client's and never moved after the send.
 *
 * Decision 211 (user, 2026-11-09): the clock reads `12s` / `4m 18s`, the thought
 * row's units, and the line is drawn only when no row is live — otherwise the
 * clock rides on that row (`turnLiveStatus.tsx`).
 *
 * Pure: the turn's clock (`useTurnLiveClock`) derives the phase and words it.
 */

import type { TurnItem } from './chatTurn';
import type { TurnCurrentAction } from './turnProcessFold';
import type { WorkedForParts } from './turnTiming';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The send attached to the turn, while the composer still holds it (`TurnSendStatus`). */
export interface TurnLiveSend {
  phase: 'handshake' | 'awaiting';
  promptChars: number;
}

export type TurnLivePhase =
  | { kind: 'connecting' }
  | { kind: 'thinking'; promptChars: number }
  | { kind: 'replying'; replyChars: number }
  | { kind: 'tool'; verb: string }
  | { kind: 'working' };

/** The reply's characters so far: the same count the status row used (`countAssistantReplyChars`). */
function replyCharsOf(items: readonly TurnItem[]): number {
  let total = 0;
  for (const item of items) {
    if (item.kind !== 'text' || !item.block.text) continue;
    total += [...item.block.text].length;
  }
  return total;
}

/**
 * What the running turn is doing. A running tool outranks everything once the send has
 * connected; otherwise the newest item decides: text streaming is the reply, a thought
 * or a finished tool call means the model is working out what comes next.
 */
export function deriveTurnLivePhase(input: {
  send: TurnLiveSend | null;
  items: readonly TurnItem[];
  action: TurnCurrentAction | null;
}): TurnLivePhase {
  if (input.send?.phase === 'handshake') return { kind: 'connecting' };
  if (input.action?.state === 'running') return { kind: 'tool', verb: input.action.verb };
  const last = input.items[input.items.length - 1];
  if (!last) {
    return input.send
      ? { kind: 'thinking', promptChars: input.send.promptChars }
      : { kind: 'working' };
  }
  if (last.kind === 'text') return { kind: 'replying', replyChars: replyCharsOf(input.items) };
  if (last.kind === 'toolGroup') return { kind: 'thinking', promptChars: 0 };
  return { kind: 'working' };
}

/** 「3 秒」, 「1 分」, 「1 分 5 秒」 (the settled turn's bill); null when nothing measured the turn. */
export function turnElapsedText(t: Translate, elapsed: WorkedForParts | null): string | null {
  if (!elapsed) return null;
  if (elapsed.minutes === 0) return t('{{seconds}}s', { seconds: elapsed.seconds });
  if (elapsed.seconds === 0) return t('{{minutes}}m', { minutes: elapsed.minutes });
  return t('{{minutes}}m {{seconds}}s', { minutes: elapsed.minutes, seconds: elapsed.seconds });
}

/**
 * Decision 211: the running turn's clock, `12s`, `4m`, `4m 18s`, in the
 * thought row's units (`Thought for 12s`) — the clock now rides on that row
 * and on the step rows, and keeps one form wherever it is drawn. Null when
 * nothing measured the turn.
 */
export function liveClockText(elapsed: WorkedForParts | null): string | null {
  if (!elapsed) return null;
  if (elapsed.minutes === 0) return `${elapsed.seconds}s`;
  return elapsed.seconds === 0 ? `${elapsed.minutes}m` : `${elapsed.minutes}m ${elapsed.seconds}s`;
}

/**
 * What the turn is doing, in the words of the thought row (`Thinking…`) and of
 * the CLI's spinner verbs: English, never translated, always ending on 「…」.
 * A running step says it in its own words (`stepWords`: what its parentheses
 * say), else its verb.
 *
 * Decision 211 (user, 2026-11-09: 「怎么又有思考中又有 thinking？肯定得统一啊」):
 * the line of its own used to say 「思考中…」 while the live thought row above it
 * said `Thinking…`, and the status moves between the two. One word, wherever
 * it is drawn.
 */
function liveWords(phase: TurnLivePhase, stepWords: string | null = null): string {
  switch (phase.kind) {
    case 'connecting':
      return 'Connecting…';
    case 'thinking':
      return 'Thinking…';
    case 'replying':
      return 'Replying…';
    case 'tool':
      return `${stepWords ?? phase.verb}…`;
    case 'working':
      // A clock with no subject reads as a stopwatch: the fallback still names itself.
      return 'Working…';
  }
}

/**
 * Desktop style: the line of its own, `Thinking… 12s` after the running icon —
 * the same words and clock a live run carries (decision 211), so no `✻` of its
 * own beside the icon.
 */
export function formatTurnLiveLine(phase: TurnLivePhase, elapsed: WorkedForParts | null): string {
  const clock = liveClockText(elapsed);
  return `${liveWords(phase)}${clock ? ` ${clock}` : ''}`;
}

/**
 * Decision 208, terminal style (user ruling 2026-11-03, the comparison
 * mockup's ①): what the live line says the turn is doing (`liveWords`).
 */
export function formatTerminalLiveActivity(phase: TurnLivePhase, stepWords: string | null): string {
  return liveWords(phase, stepWords);
}

/**
 * The status's closing words: 「(12s · esc 中断)」, or 「(esc 中断)」 with no
 * clock — at the end of the live row (decision 211), or of the line of its own.
 */
export function formatTerminalLiveTail(t: Translate, elapsed: WorkedForParts | null): string {
  const clock = liveClockText(elapsed);
  const interrupt = t('esc to interrupt');
  return `(${clock ? `${clock} · ${interrupt}` : interrupt})`;
}
