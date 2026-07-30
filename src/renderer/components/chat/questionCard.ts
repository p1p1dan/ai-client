import type { QuestionItem } from '@shared/types/runtimeEvents';
import type { ChatBlock } from '@/stores/chatSessions';

/**
 * T-05 question/permission pure view model. `QuestionCard.tsx` (batch 3)
 * renders three variants off this module: interactive (pending, answerable),
 * frozen (answered/skipped, read-only), and permission (thin adapter over
 * the same card shape). No React, no store writes — freezing logic only
 * reads the store's already-resolved fields (`resolved` / `questionOutcome` /
 * `questionAnswers` / `questionResponse`), never re-implements them.
 */

// ---- State ----

export type QuestionCardState = 'pending' | 'answered' | 'skipped';

/** `resolved !== true` -> 'pending'; outcome 'answered' -> 'answered'; 'cancelled' | 'rejected' -> 'skipped'. */
export function deriveQuestionCardState(block: ChatBlock): QuestionCardState {
  if (block.resolved !== true) return 'pending';
  return block.questionOutcome === 'answered' ? 'answered' : 'skipped';
}

export const QUESTION_TITLE = 'Questions';
export const ANSWERS_TITLE = 'Answers';
export const SKIPPED_TITLE = 'Questions skipped';

/** Header copy: Questions / Answers / Questions skipped (A07 :2654/:2679). */
export function deriveCardTitle(state: QuestionCardState): string {
  if (state === 'answered') return ANSWERS_TITLE;
  if (state === 'skipped') return SKIPPED_TITLE;
  return QUESTION_TITLE;
}

// ---- Selection state (controlled, pure) ----

export interface QuestionSelection {
  /** Question index -> selected labels (single-select is always <= 1 entry). */
  byQuestion: Record<number, string[]>;
  /** Question index -> the Other free-text input. */
  otherText: Record<number, string>;
  /** Question index -> whether the Other row is selected. */
  otherSelected: Record<number, boolean>;
}

export const emptySelection: QuestionSelection = {
  byQuestion: {},
  otherText: {},
  otherSelected: {},
};

/** Single-select: replace (re-clicking the same label keeps it selected, never toggles to empty). Multi-select: toggle. */
export function toggleOption(
  sel: QuestionSelection,
  qIndex: number,
  label: string,
  multiSelect: boolean
): QuestionSelection {
  const current = sel.byQuestion[qIndex] ?? [];
  const nextLabels = multiSelect
    ? current.includes(label)
      ? current.filter((item) => item !== label)
      : [...current, label]
    : [label];

  return {
    ...sel,
    byQuestion: { ...sel.byQuestion, [qIndex]: nextLabels },
    // Picking a structured option in single-select mode is exclusive with Other.
    otherSelected: multiSelect ? sel.otherSelected : { ...sel.otherSelected, [qIndex]: false },
  };
}

/** Selecting Other: single-select clears structured options; multi-select coexists. */
export function toggleOther(
  sel: QuestionSelection,
  qIndex: number,
  multiSelect: boolean
): QuestionSelection {
  if (multiSelect) {
    const isSelected = sel.otherSelected[qIndex] ?? false;
    return { ...sel, otherSelected: { ...sel.otherSelected, [qIndex]: !isSelected } };
  }
  return {
    ...sel,
    byQuestion: { ...sel.byQuestion, [qIndex]: [] },
    otherSelected: { ...sel.otherSelected, [qIndex]: true },
  };
}

export function setOtherText(
  sel: QuestionSelection,
  qIndex: number,
  text: string
): QuestionSelection {
  return { ...sel, otherText: { ...sel.otherText, [qIndex]: text } };
}

// ---- Option rows ----

export interface OptionRow {
  /** 'A'…'Z'; beyond 26 falls back to a plain number string. */
  letter: string;
  label: string;
  isOther: boolean;
}

export const OTHER_LABEL = 'Other…';

export function optionLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/** Options in order, plus a trailing Other… row (always present, always lettered — A07 :2609). */
export function buildOptionRows(item: QuestionItem): OptionRow[] {
  const rows: OptionRow[] = item.options.map((option, index) => ({
    letter: optionLetter(index),
    label: option.label,
    isOther: false,
  }));
  rows.push({ letter: optionLetter(item.options.length), label: OTHER_LABEL, isOther: true });
  return rows;
}

// ---- Submission ----

/** Every question needs a selection (or Other with non-empty text) before Continue is enabled. */
export function canContinue(sel: QuestionSelection, items: readonly QuestionItem[]): boolean {
  return items.every((_, index) => {
    const structured = sel.byQuestion[index] ?? [];
    if (structured.length > 0) return true;
    if (!sel.otherSelected[index]) return false;
    return (sel.otherText[index] ?? '').trim().length > 0;
  });
}

/**
 * Continue payload, aligned with `respondQuestion` (`chatSessions.ts:125-129`/`:781-798`):
 *  - key is `item.question`, verbatim (runtimeEvents.ts :224 contract).
 *  - multi-select joins with ', '.
 *  - a selected Other contributes its trimmed text, joined alongside any
 *    structured picks.
 *  - `answers` and `response` are mutually exclusive (:227-230) — this
 *    function only ever produces `answers`.
 */
export function buildRespondPayload(
  sel: QuestionSelection,
  items: readonly QuestionItem[]
): { answers: Record<string, string> } {
  const answers: Record<string, string> = {};
  items.forEach((item, index) => {
    const parts = [...(sel.byQuestion[index] ?? [])];
    if (sel.otherSelected[index]) {
      const text = (sel.otherText[index] ?? '').trim();
      if (text.length > 0) parts.push(text);
    }
    if (parts.length > 0) {
      answers[item.question] = parts.join(', ');
    }
  });
  return { answers };
}

/** Skip = cancel (store side turns this into outcome 'cancelled' -> frozen as skipped). */
export function buildSkipPayload(): { cancel: true } {
  return { cancel: true };
}

export const SKIP_LABEL = 'Skip';
export const CONTINUE_LABEL = 'Continue';
export const CONTINUE_KBD = '⏎';
export const SKIPPED_MARK = 'Skipped';

// ---- Pagination ----

export interface PagerView {
  visible: boolean;
  label: string;
  canPrev: boolean;
  canNext: boolean;
}

export function clampPage(count: number, page: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(page, 0), count - 1);
}

/** A single question never shows a pager (A07 :2586); multiple questions show `${i} of ${count}` with edges disabled. */
export function derivePager(count: number, page: number): PagerView {
  if (count <= 1) {
    return { visible: false, label: '', canPrev: false, canNext: false };
  }
  const clamped = clampPage(count, page);
  return {
    visible: true,
    label: `${clamped + 1} of ${count}`,
    canPrev: clamped > 0,
    canNext: clamped < count - 1,
  };
}

// ---- Frozen (read-only) ----

export interface FrozenPair {
  question: string;
  answer: string | null;
  skipped: boolean;
}

/**
 * Frozen render data, entirely from fields the store already froze (no
 * reimplementation of D20 logic):
 *  - answered: `answer = questionAnswers[item.question] ?? questionResponse ?? null`.
 *  - skipped: every question shows `answer: null, skipped: true`.
 *  - missing `questions` (history/edge case) -> empty array.
 */
export function deriveFrozenPairs(block: ChatBlock): FrozenPair[] {
  const items = block.questions ?? [];
  if (items.length === 0) return [];

  if (deriveQuestionCardState(block) === 'skipped') {
    return items.map((item) => ({ question: item.question, answer: null, skipped: true }));
  }

  return items.map((item) => ({
    question: item.question,
    answer: block.questionAnswers?.[item.question] ?? block.questionResponse ?? null,
    skipped: false,
  }));
}

// ---- Permission thin adapter ----

export const PERMISSION_TITLE = 'Permission';
export const PERMISSION_ALLOW = 'Allow';
export const PERMISSION_DENY = 'Deny';
export const PERMISSION_ALLOWED = 'Allowed';
export const PERMISSION_DENIED = 'Denied';
export const PERMISSION_WAITING = 'Waiting';

export interface PermissionCardView {
  title: string;
  prompt: string;
  state: 'pending' | 'resolved';
  /** Two rows (Allow/Deny) when pending and answerable, otherwise empty. */
  options: OptionRow[];
  /** Read-only row (Allowed/Denied) once resolved. */
  frozen: FrozenPair[];
  waiting: boolean;
}

function derivePermissionPrompt(block: ChatBlock): string {
  const toolName = block.toolName ?? '';
  return block.toolDescription ? `${toolName} — ${block.toolDescription}` : toolName;
}

export function derivePermissionCardView(
  block: ChatBlock,
  canRespond: boolean
): PermissionCardView {
  const prompt = derivePermissionPrompt(block);

  if (block.resolved === true) {
    return {
      title: PERMISSION_TITLE,
      prompt,
      state: 'resolved',
      options: [],
      frozen: [
        {
          question: prompt,
          answer: block.allowed ? PERMISSION_ALLOWED : PERMISSION_DENIED,
          skipped: false,
        },
      ],
      waiting: false,
    };
  }

  if (canRespond) {
    return {
      title: PERMISSION_TITLE,
      prompt,
      state: 'pending',
      options: [
        { letter: 'A', label: PERMISSION_ALLOW, isOther: false },
        { letter: 'B', label: PERMISSION_DENY, isOther: false },
      ],
      frozen: [],
      waiting: false,
    };
  }

  return {
    title: PERMISSION_TITLE,
    prompt,
    state: 'pending',
    options: [],
    frozen: [],
    waiting: true,
  };
}

// ---- Dock layout (A07 :2709 — 8px gap above the Composer) ----

export const QUESTION_DOCK_WRAPPER_CLASS = 'shrink-0 px-6 pb-2';
/** Expanded card's own scroll window (sign-off ② generic 60vh; A07 gives no number). */
export const QUESTION_CARD_BODY_MAX_CLASS = 'max-h-[60vh] overflow-auto';

// ---- Pending selector ----

/**
 * Pull the pending question block from `messages`; returns the block
 * reference itself (stable under streaming append, so it can back a zustand
 * selector directly).
 */
export function selectPendingQuestionBlock(
  messages: Record<string, { id: string; blocks: ChatBlock[] }[]>,
  pending: { sessionId: string; questionId: string; messageId: string } | null,
  activeSessionId: string | null
): ChatBlock | undefined {
  if (!pending || !activeSessionId || pending.sessionId !== activeSessionId) return undefined;
  const bucket = messages[pending.sessionId];
  if (!bucket) return undefined;
  const message = bucket.find((item) => item.id === pending.messageId);
  if (!message) return undefined;
  return message.blocks.find(
    (block) => block.type === 'question' && block.questionId === pending.questionId
  );
}
