import { INTERRUPTED_TURN_NOTICE_KEY } from '@shared/dshHistory/types';
import type { ChatTurnEnd } from '@/stores/chatSessions';
import { deriveSessionFailure, toSessionFailureCode } from './sessionFailure';

/**
 * dsh-rebase P1-7e (problem 7, decision 140): the note a reopened turn ends
 * with when it saved no reply (`ChatMessage.turnEnd`).
 *
 * It used to be an English sentence replayed AS the reply — under 「最终输出」
 * and beside 「完成于」 — so a turn the model service refused read like one
 * that finished. It is a note now, drawn like the interrupted-turn note, and a
 * failed turn says why in the words its live card used: the card's title for
 * the code the history recorded, and the engine's own sentence as the detail
 * (unless the card itself would not have printed it).
 *
 * 「没有保存任何回复」 is only said when it is true: a turn whose earlier steps
 * did save something (tool calls, a thought, prose) before the request that
 * failed ends on the note without that clause.
 *
 * Catalog keys only; the component translates. The reason is itself a key (a
 * card title), which is why it rides beside `key` instead of in `params`.
 */
export interface TurnEndNoticeView {
  key: string;
  /** Card title of the failure, translated into `{{reason}}` of `key`. */
  reasonKey?: string;
  /** The engine's sentence, printed as evidence under the note. */
  detail?: string;
}

export interface TurnEndNoticeOptions {
  /** Something of this turn was saved before the note (see `turnEndNotesAfterWork`). */
  afterWork?: boolean;
}

const NOTE_KEYS = {
  stopped: {
    alone: 'This turn was stopped. No reply was saved.',
    afterWork: 'This turn was stopped.',
  },
  interrupted: {
    alone: 'This turn was interrupted. No reply was saved.',
    afterWork: 'This turn was interrupted.',
  },
  failedWithReason: {
    alone: 'This turn did not finish: {{reason}}. No reply was saved.',
    afterWork: 'This turn did not finish: {{reason}}.',
  },
  failed: {
    alone: 'This turn did not finish. No reply was saved.',
    afterWork: 'This turn did not finish.',
  },
} as const;

export function deriveTurnEndNotice(
  turnEnd: ChatTurnEnd,
  options: TurnEndNoticeOptions = {}
): TurnEndNoticeView {
  const form = options.afterWork ? 'afterWork' : 'alone';
  if (turnEnd.kind === 'stopped') return { key: NOTE_KEYS.stopped[form] };
  if (turnEnd.kind === 'interrupted') return { key: NOTE_KEYS.interrupted[form] };
  const known = toSessionFailureCode(turnEnd.errorCode) !== 'unknown';
  const view = deriveSessionFailure({ error: turnEnd.error, errorCode: turnEnd.errorCode });
  const detail = turnEnd.error && view.showsDetail ? turnEnd.error : undefined;
  return known
    ? {
        key: NOTE_KEYS.failedWithReason[form],
        reasonKey: view.title,
        ...(detail ? { detail } : {}),
      }
    : { key: NOTE_KEYS.failed[form], ...(detail ? { detail } : {}) };
}

/**
 * Whether a turn's body ends on such a note: it then has no completion time
 * to report (「完成于」 is for a turn that finished).
 *
 * P1-14 GUI recheck finding 2: the engine's interrupted-turn note counts too
 * (`INTERRUPTED_TURN_NOTICE_KEY`, a system row the history adds after a host
 * crash). A turn the engine stopped while a tool ran used to end on that note
 * and still say 「完成于 13:05 · 1 次工具调用」 under it.
 */
export function turnEndsWithoutReply(
  body: readonly {
    turnEnd?: ChatTurnEnd;
    role?: string;
    blocks?: readonly { notice?: { key?: string } }[];
  }[]
): boolean {
  const last = body.at(-1);
  if (!last) return false;
  if (last.turnEnd !== undefined) return true;
  return last.role === 'system' && last.blocks?.[0]?.notice?.key === INTERRUPTED_TURN_NOTICE_KEY;
}

/**
 * Decision 156 (decision 145 rule 17): live, whether the turn's last request
 * failed — its newest assistant message is the one `session.failed` stamped
 * `stopReason: 'error'`. Such a turn did not finish either; the failure card
 * says so while it is the last turn, and this keeps 「完成于」 off it, then and
 * after a later turn takes the card's place.
 *
 * P1-14 GUI recheck finding 2: the stamp no longer needs an empty message. A
 * request that fails after the turn's earlier steps ran tools (a reply the
 * loop guard cut, a host crash mid-tool) leaves a message with blocks, and the
 * turn used to say 「完成于」 beside its failure card.
 */
export function turnEndsOnFailedRequest(
  body: readonly { role: string; blocks: readonly unknown[]; stopReason?: string }[]
): boolean {
  for (let index = body.length - 1; index >= 0; index -= 1) {
    const message = body[index];
    if (message?.role !== 'assistant') continue;
    return message.stopReason === 'error';
  }
  return false;
}

/**
 * The ids of a turn's end notes that follow something the turn saved — an
 * assistant message with any block — so their wording leaves out 「没有保存任何
 * 回复」. DSH writes a failed turn's placeholder after every step it did
 * record, not only for a turn that failed on its first request.
 */
export function turnEndNotesAfterWork(
  body: readonly { id: string; role: string; blocks: readonly unknown[]; turnEnd?: ChatTurnEnd }[]
): ReadonlySet<string> {
  const ids = new Set<string>();
  let saved = false;
  for (const message of body) {
    if (message.turnEnd) {
      if (saved) ids.add(message.id);
      continue;
    }
    if (message.role === 'assistant' && message.blocks.length > 0) saved = true;
  }
  return ids;
}

/**
 * Decision 193 rule 2: the id of the failed end note the session's failure
 * card already says, or null. After an engine restart the chat keeps its
 * failure card (and badge) and is reopened from the history, which closes the
 * same turn with its own note of the same failure; drawing both printed it
 * twice. While the card is up — the session failed and this is its last
 * turn — the note at the very end of the turn is left out; once the user sends
 * again the card goes and the note is drawn as the record.
 */
export function failedEndNoteCoveredByCard(
  body: readonly { id: string; turnEnd?: ChatTurnEnd }[],
  cardShown: boolean
): string | null {
  if (!cardShown) return null;
  const last = body.at(-1);
  return last?.turnEnd?.kind === 'failed' ? last.id : null;
}
