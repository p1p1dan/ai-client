import type { QuestionItem } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import {
  buildOptionRows,
  buildRespondPayload,
  buildSkipPayload,
  canContinue,
  canRespondToPermission,
  clampPage,
  deriveCardTitle,
  deriveFrozenPairs,
  derivePager,
  derivePermissionCardView,
  deriveQuestionCardState,
  emptySelection,
  selectPendingQuestionBlock,
  setOtherText,
  toggleOption,
  toggleOther,
} from '../questionCard';

function questionBlock(overrides: Partial<ChatBlock> = {}): ChatBlock {
  return { id: 'q1', type: 'question', questionId: 'q1', ...overrides };
}

function permissionBlock(overrides: Partial<ChatBlock> = {}): ChatBlock {
  return { id: 'p1', type: 'permission_request', toolName: 'Bash', ...overrides };
}

function questionItem(optionLabels: string[], overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    question: 'Pick one',
    options: optionLabels.map((label) => ({ label })),
    ...overrides,
  };
}

describe('deriveQuestionCardState / deriveCardTitle', () => {
  it('treats resolved !== true as pending, with title "Questions"', () => {
    expect(deriveQuestionCardState(questionBlock())).toBe('pending');
    expect(deriveCardTitle('pending')).toBe('Questions');
  });

  it('treats outcome "answered" as answered, with title "Answers"', () => {
    const block = questionBlock({ resolved: true, questionOutcome: 'answered' });
    expect(deriveQuestionCardState(block)).toBe('answered');
    expect(deriveCardTitle('answered')).toBe('Answers');
  });

  it('treats outcome "cancelled" as skipped, with title "Questions skipped"', () => {
    const block = questionBlock({ resolved: true, questionOutcome: 'cancelled' });
    expect(deriveQuestionCardState(block)).toBe('skipped');
    expect(deriveCardTitle('skipped')).toBe('Questions skipped');
  });

  it('treats outcome "rejected" as skipped too', () => {
    const block = questionBlock({ resolved: true, questionOutcome: 'rejected' });
    expect(deriveQuestionCardState(block)).toBe('skipped');
  });
});

describe('selection', () => {
  it('single-select: picking another option replaces the previous one', () => {
    let sel = toggleOption(emptySelection, 0, 'A', false);
    sel = toggleOption(sel, 0, 'B', false);
    expect(sel.byQuestion[0]).toEqual(['B']);
  });

  it('single-select: re-clicking the same option keeps it selected (never toggles to empty)', () => {
    let sel = toggleOption(emptySelection, 0, 'A', false);
    sel = toggleOption(sel, 0, 'A', false);
    expect(sel.byQuestion[0]).toEqual(['A']);
  });

  it('multi-select: accumulates picks and toggles one back off', () => {
    let sel = toggleOption(emptySelection, 0, 'A', true);
    sel = toggleOption(sel, 0, 'B', true);
    expect(sel.byQuestion[0]).toEqual(['A', 'B']);
    sel = toggleOption(sel, 0, 'A', true);
    expect(sel.byQuestion[0]).toEqual(['B']);
  });

  it('selecting Other in single-select mode clears the structured selection', () => {
    let sel = toggleOption(emptySelection, 0, 'A', false);
    sel = toggleOther(sel, 0, false);
    expect(sel.byQuestion[0]).toEqual([]);
    expect(sel.otherSelected[0]).toBe(true);
  });

  it('setOtherText only touches the given question index', () => {
    let sel = setOtherText(emptySelection, 0, 'hello');
    sel = setOtherText(sel, 1, 'world');
    expect(sel.otherText).toEqual({ 0: 'hello', 1: 'world' });
  });

  it('every mutator returns a new object and leaves the input untouched', () => {
    const before = emptySelection;
    const after = toggleOption(before, 0, 'A', false);
    expect(after).not.toBe(before);
    expect(before.byQuestion).toEqual({});
  });
});

describe('buildOptionRows / optionLetter', () => {
  it('letters 3 options A/B/C, with Other… as trailing D', () => {
    const rows = buildOptionRows(questionItem(['Alpha', 'Beta', 'Gamma']));
    expect(rows).toEqual([
      { letter: 'A', label: 'Alpha', isOther: false },
      { letter: 'B', label: 'Beta', isOther: false },
      { letter: 'C', label: 'Gamma', isOther: false },
      { letter: 'D', label: 'Other…', isOther: true },
    ]);
  });

  it('Other is always last and always has a letter', () => {
    expect(buildOptionRows(questionItem([]))).toEqual([
      { letter: 'A', label: 'Other…', isOther: true },
    ]);
  });

  it('falls back to a numeric string past the 26th letter', () => {
    const labels = Array.from({ length: 26 }, (_, i) => `Option ${i}`);
    const rows = buildOptionRows(questionItem(labels));
    expect(rows[26]).toEqual({ letter: '27', label: 'Other…', isOther: true });
  });
});

describe('canContinue', () => {
  const items: QuestionItem[] = [
    questionItem(['A', 'B']),
    questionItem(['C', 'D'], { question: 'Pick two' }),
  ];

  it('is false when only one of two questions is answered', () => {
    const sel = toggleOption(emptySelection, 0, 'A', false);
    expect(canContinue(sel, items)).toBe(false);
  });

  it('is false when Other is selected but its text is empty', () => {
    let sel = toggleOption(emptySelection, 0, 'A', false);
    sel = toggleOther(sel, 1, false);
    expect(canContinue(sel, items)).toBe(false);
  });

  it('is true once Other has non-empty text', () => {
    let sel = toggleOption(emptySelection, 0, 'A', false);
    sel = toggleOther(sel, 1, false);
    sel = setOtherText(sel, 1, 'custom answer');
    expect(canContinue(sel, items)).toBe(true);
  });

  it('is true once every question has an answer', () => {
    let sel = toggleOption(emptySelection, 0, 'A', false);
    sel = toggleOption(sel, 1, 'C', false);
    expect(canContinue(sel, items)).toBe(true);
  });
});

describe('buildRespondPayload', () => {
  it('uses item.question verbatim as the key', () => {
    const items = [questionItem(['A'], { question: 'What is your favorite color?' })];
    const sel = toggleOption(emptySelection, 0, 'A', false);
    expect(buildRespondPayload(sel, items).answers).toEqual({
      'What is your favorite color?': 'A',
    });
  });

  it('joins multi-select picks with ", "', () => {
    const items = [questionItem(['A', 'B', 'C'], { multiSelect: true })];
    let sel = toggleOption(emptySelection, 0, 'A', true);
    sel = toggleOption(sel, 0, 'B', true);
    expect(buildRespondPayload(sel, items).answers[items[0].question]).toBe('A, B');
  });

  it('uses the trimmed Other text as the answer', () => {
    const items = [questionItem(['A'])];
    let sel = toggleOther(emptySelection, 0, false);
    sel = setOtherText(sel, 0, '  custom text  ');
    expect(buildRespondPayload(sel, items).answers[items[0].question]).toBe('custom text');
  });

  it('only ever produces answers, never response', () => {
    const items = [questionItem(['A'])];
    const sel = toggleOption(emptySelection, 0, 'A', false);
    const payload = buildRespondPayload(sel, items);
    expect(payload).toEqual({ answers: { [items[0].question]: 'A' } });
    expect('response' in payload).toBe(false);
  });
});

describe('buildSkipPayload', () => {
  it('returns { cancel: true }', () => {
    expect(buildSkipPayload()).toEqual({ cancel: true });
  });
});

describe('derivePager / clampPage', () => {
  it('hides the pager for a single question', () => {
    expect(derivePager(1, 0).visible).toBe(false);
  });

  it('shows "1 of 3" with canPrev=false at page 0 of 3', () => {
    expect(derivePager(3, 0)).toEqual({
      visible: true,
      label: '1 of 3',
      canPrev: false,
      canNext: true,
    });
  });

  it('clamps an out-of-range page', () => {
    expect(clampPage(3, 5)).toBe(2);
    expect(clampPage(3, -1)).toBe(0);
  });
});

describe('deriveFrozenPairs', () => {
  const items: QuestionItem[] = [
    questionItem(['A', 'B'], { question: 'Q1' }),
    questionItem(['C'], { question: 'Q2' }),
  ];

  it('answered: reads each answer by question text from questionAnswers', () => {
    const block = questionBlock({
      resolved: true,
      questionOutcome: 'answered',
      questions: items,
      questionAnswers: { Q1: 'A', Q2: 'C' },
    });
    expect(deriveFrozenPairs(block)).toEqual([
      { question: 'Q1', answer: 'A', skipped: false },
      { question: 'Q2', answer: 'C', skipped: false },
    ]);
  });

  it('falls back to questionResponse when questionAnswers is missing', () => {
    const block = questionBlock({
      resolved: true,
      questionOutcome: 'answered',
      questions: items,
      questionResponse: 'free text reply',
    });
    expect(deriveFrozenPairs(block)).toEqual([
      { question: 'Q1', answer: 'free text reply', skipped: false },
      { question: 'Q2', answer: 'free text reply', skipped: false },
    ]);
  });

  it('cancelled: every question shows skipped=true with a null answer', () => {
    const block = questionBlock({ resolved: true, questionOutcome: 'cancelled', questions: items });
    expect(deriveFrozenPairs(block)).toEqual([
      { question: 'Q1', answer: null, skipped: true },
      { question: 'Q2', answer: null, skipped: true },
    ]);
  });

  it('returns an empty array when questions is missing', () => {
    const block = questionBlock({ resolved: true, questionOutcome: 'answered' });
    expect(deriveFrozenPairs(block)).toEqual([]);
  });
});

describe('derivePermissionCardView', () => {
  it('pending + canRespond: two lettered options, Allow/Deny', () => {
    const view = derivePermissionCardView(permissionBlock(), true);
    expect(view.state).toBe('pending');
    expect(view.options).toEqual([
      { letter: 'A', label: 'Allow', isOther: false },
      { letter: 'B', label: 'Deny', isOther: false },
    ]);
  });

  it('pending + cannot respond: waiting=true with no options', () => {
    const view = derivePermissionCardView(permissionBlock(), false);
    expect(view.waiting).toBe(true);
    expect(view.options).toEqual([]);
  });

  it('resolved + allowed: frozen row says "Allowed"', () => {
    const view = derivePermissionCardView(
      permissionBlock({ resolved: true, allowed: true }),
      false
    );
    expect(view.state).toBe('resolved');
    expect(view.frozen[0].answer).toBe('Allowed');
  });

  it('resolved + denied: frozen row says "Denied"', () => {
    const view = derivePermissionCardView(
      permissionBlock({ resolved: true, allowed: false }),
      false
    );
    expect(view.frozen[0].answer).toBe('Denied');
  });
});

describe('canRespondToPermission', () => {
  const queue = [
    { sessionId: 's1', permissionId: 'perm-1' },
    { sessionId: 's2', permissionId: 'perm-2' },
  ];

  it('G1: true when the permissionId is parked for the active session', () => {
    expect(canRespondToPermission(queue, 's1', 'perm-1')).toBe(true);
  });

  it('G2: false when the permissionId is parked but under a different session', () => {
    // perm-2 is only queued under s2, so asking as s1 must not answer it.
    expect(canRespondToPermission(queue, 's1', 'perm-2')).toBe(false);
  });

  it('G3: false when the permissionId is not in the queue at all (already resolved / replayed, E9)', () => {
    expect(canRespondToPermission(queue, 's1', 'perm-does-not-exist')).toBe(false);
  });

  it('G4: false when permissionId is undefined', () => {
    expect(canRespondToPermission(queue, 's1', undefined)).toBe(false);
  });

  it('G5: false when activeSessionId is null', () => {
    expect(canRespondToPermission(queue, null, 'perm-1')).toBe(false);
  });
});

describe('selectPendingQuestionBlock', () => {
  const pendingBlock = questionBlock({ questionId: 'q1' });
  const messages = { s1: [{ id: 'm1', blocks: [pendingBlock] }] };

  it('returns the block reference when session and questionId match', () => {
    const found = selectPendingQuestionBlock(
      messages,
      { sessionId: 's1', questionId: 'q1', messageId: 'm1' },
      's1'
    );
    expect(found).toBe(pendingBlock);
  });

  it('returns undefined when the pending question belongs to a different session', () => {
    const found = selectPendingQuestionBlock(
      messages,
      { sessionId: 's1', questionId: 'q1', messageId: 'm1' },
      's2'
    );
    expect(found).toBeUndefined();
  });

  it('still returns the block even when it is already resolved (caller decides the state)', () => {
    const resolvedBlock = questionBlock({ questionId: 'q2', resolved: true });
    const withResolved = { s1: [{ id: 'm1', blocks: [resolvedBlock] }] };
    const found = selectPendingQuestionBlock(
      withResolved,
      { sessionId: 's1', questionId: 'q2', messageId: 'm1' },
      's1'
    );
    expect(found).toBe(resolvedBlock);
  });

  it('returns undefined when the messages bucket is missing', () => {
    const found = selectPendingQuestionBlock(
      {},
      { sessionId: 's1', questionId: 'q1', messageId: 'm1' },
      's1'
    );
    expect(found).toBeUndefined();
  });
});
