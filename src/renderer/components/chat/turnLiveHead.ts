/**
 * Route B S-6 feedback 11c (user, 2026-10-17): a running turn says what it is doing on
 * ONE line, verb first, the way the Claude Code status line does:
 *
 *   ✻ 正在连接对话引擎… 1 秒
 *   ✻ 思考中 3 秒                    (waiting for the first byte, or thinking)
 *   ✻ 回复中 12 秒                    (the reply streaming)
 *   ✻ 运行中 20 秒                    (a tool running: its own verb)
 *   ✻ 工作中 30 秒                    (nothing more specific is known)
 *
 * It used to be 「✻ 工作中 N 秒」 over a second status row (「思索中… · ↑ 15 字符 · 2s」)
 * whose seconds counted the same wait again. That row is drawn now only when it says
 * something this line cannot: the slow and stalled hints and a failure (`ChatTurn`).
 * 「工作中」 stays as the fallback, so the line never reads as a bare stopwatch.
 *
 * User, 2026-10-19: no ↑/↓ counts on this line. They read as token figures that
 * did not match the Claude client's and never moved after the send.
 *
 * Pure: the clock line (`useTurnClockLine`) derives the phase and words it.
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

/** 「3 秒」, 「1 分」, 「1 分 5 秒」; null when nothing measured the turn. */
export function turnElapsedText(t: Translate, elapsed: WorkedForParts | null): string | null {
  if (!elapsed) return null;
  if (elapsed.minutes === 0) return t('{{seconds}}s', { seconds: elapsed.seconds });
  if (elapsed.seconds === 0) return t('{{minutes}}m', { minutes: elapsed.minutes });
  return t('{{minutes}}m {{seconds}}s', { minutes: elapsed.minutes, seconds: elapsed.seconds });
}

/** The verb, as a literal catalog key per phase (the i18n coverage gate scans literals). */
function phaseVerb(t: Translate, phase: Exclude<TurnLivePhase, { kind: 'working' }>): string {
  switch (phase.kind) {
    case 'connecting':
      return t('Connecting to the chat engine…');
    case 'thinking':
      return t('Thinking');
    case 'replying':
      return t('Replying');
    case 'tool':
      return t(phase.verb);
  }
}

/** The whole line for a phase other than the fallback, which the clock line words itself. */
export function formatTurnLiveLine(
  t: Translate,
  phase: Exclude<TurnLivePhase, { kind: 'working' }>,
  elapsed: WorkedForParts | null
): string {
  const clock = turnElapsedText(t, elapsed);
  return `✻ ${phaseVerb(t, phase)}${clock ? ` ${clock}` : ''}`;
}
