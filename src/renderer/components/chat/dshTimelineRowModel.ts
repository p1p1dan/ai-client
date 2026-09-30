import { CONTEXT_SUMMARY_TITLE } from '@shared/dshHistory/types';
import type { Translate } from '@shared/i18n';
import type { TurnOrigin } from '@shared/types/sessionHistory';
import type { ChatMessage } from '@/stores/chatSessions';

/**
 * dsh-rebase P1-7a (decisions 072 rules 3-4, 099 rules 7-8, 106, 118): the
 * pure half of the two light rows a DSH timeline adds — the head of a turn
 * the engine started by itself, and a notice in the middle of one.
 *
 * Both come from DSH `user/message`s nobody typed, sorted by the table the
 * bridge and the history projection share (`@shared/dshNotices`):
 *
 *   - a turn head is a user message with an `origin` (a goal round, a
 *     background task's or a subagent's wake-up, a subagent's message). It
 *     still opens its turn — the clock and the work group count per round —
 *     but it is drawn as one muted line with a rule and the time, never as a
 *     bubble: nobody typed it. This replaces the empty bubble decision 106
 *     rule 36 accepted until now.
 *   - a notice is a system row: live, the `custom.message` of kind
 *     `dsh:<source>` (`ChatMessage.noticeKind`); replayed, a history row named
 *     after its live copy (`liveMessageId` `dsh-notice-<seq>`). One line, an
 *     info icon, DSH's own summary. A command send's answer (`dsh:command`,
 *     decision 113) is the same row with the answer in full, since the user
 *     asked for it.
 */

/** Live id prefix of a notice's echo (`liveEvents.ts`), which history rows name as `liveMessageId`. */
export const DSH_NOTICE_ID_PREFIX = 'dsh-notice-';

export type DshNoticeRowKind = 'notice' | 'command' | 'command-error';

export interface DshNoticeRowView {
  kind: DshNoticeRowKind;
  text: string;
  /** A notice longer than one line (a subagent's message): it opens in place. */
  expandable: boolean;
}

/** Past this, or with a line break, a notice line offers to open in full. */
const NOTICE_LINE_CHARS = 160;

function textOf(message: ChatMessage): string {
  return message.blocks
    .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
    .join('\n');
}

/** The light row a system message is drawn as, or null for the Alert every other notice keeps. */
export function dshNoticeRowView(message: ChatMessage): DshNoticeRowView | null {
  if (message.role !== 'system') return null;
  let kind: DshNoticeRowKind;
  if (message.noticeKind !== undefined) {
    kind =
      message.noticeKind === 'command'
        ? 'command'
        : message.noticeKind === 'command-error'
          ? 'command-error'
          : 'notice';
  } else if (message.liveMessageId?.startsWith(DSH_NOTICE_ID_PREFIX)) {
    kind = 'notice';
  } else {
    return null;
  }
  const text = textOf(message);
  return {
    kind,
    text,
    expandable: kind === 'notice' && (text.includes('\n') || text.length > NOTICE_LINE_CHARS),
  };
}

export interface AutoTurnHeadView {
  origin: TurnOrigin;
  /** DSH's one-line account (a task's, a subagent's), or the relayed message; none for a goal round. */
  detail: string;
  /** A relayed message longer than its line opens in place. */
  expandable: boolean;
}

/** The head a user message with an `origin` is drawn as, or null for an ordinary prompt. */
export function autoTurnHeadView(message: ChatMessage | null): AutoTurnHeadView | null {
  if (!message || message.role !== 'user' || !message.origin) return null;
  const detail = message.origin.kind === 'goal' ? '' : textOf(message);
  return {
    origin: message.origin,
    detail,
    expandable:
      message.origin.kind === 'agent-message' &&
      (detail.includes('\n') || detail.length > NOTICE_LINE_CHARS),
  };
}

/**
 * dsh-rebase P1-7e (decision 144; decision 140 rule 16 left it here): a
 * context summary's text opens with `CONTEXT_SUMMARY_TITLE`, in English
 * because the row is projected transcript data. Shown, that title follows the
 * UI language; the summary after it is the model's own text and stays as it
 * is. Text that does not open with the title as a whole word comes back
 * untouched, so this is safe on any string the caller is unsure about.
 */
export function localizeContextSummaryTitle(text: string, t: Translate): string {
  if (!text.startsWith(CONTEXT_SUMMARY_TITLE)) return text;
  const rest = text.slice(CONTEXT_SUMMARY_TITLE.length);
  if (rest !== '' && !/^\s/.test(rest)) return text;
  return `${t(CONTEXT_SUMMARY_TITLE)}${rest}`;
}
