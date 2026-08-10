import type { QuestionItem } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import {
  answerKeyFor,
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
  derivePermissionRowView,
  deriveQuestionCardState,
  emptySelection,
  isMaskedAnswer,
  questionReactKey,
  SECRET_MASK,
  selectPendingQuestionBlock,
  setOtherText,
  toggleOption,
  toggleOther,
} from '../questionCardModel';

/** Every non-empty contiguous slice of `s`, for "mask must not leak any substring of the plaintext" checks. */
function allSubstrings(s: string): string[] {
  const subs: string[] = [];
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j <= s.length; j++) {
      subs.push(s.slice(i, j));
    }
  }
  return subs;
}

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

describe('answerKeyFor', () => {
  it('uses item.id when present', () => {
    const item = questionItem(['A'], { id: 'q-42', question: 'Pick one' });
    expect(answerKeyFor(item)).toBe('q-42');
  });

  it('falls back to the question text verbatim when id is absent', () => {
    const item = questionItem(['A'], { question: 'What is your favorite color?' });
    expect(answerKeyFor(item)).toBe('What is your favorite color?');
  });
});

describe('questionReactKey', () => {
  it('produces distinct keys for two id-less questions with identical text (the reason it is split from the protocol key)', () => {
    const first = questionItem(['A'], { question: 'Pick one' });
    const second = questionItem(['B'], { question: 'Pick one' });
    const firstKey = questionReactKey(first, 0);
    const secondKey = questionReactKey(second, 1);
    expect(firstKey).not.toBe(secondKey);
  });

  it('uses item.id when present, ignoring the index', () => {
    const item = questionItem(['A'], { id: 'q-7' });
    expect(questionReactKey(item, 3)).toBe('q-7');
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

  it('uses item.id as the key when the item carries one (Codex-style ids)', () => {
    const items = [questionItem(['A'], { id: 'q-42', question: 'Pick one' })];
    const sel = toggleOption(emptySelection, 0, 'A', false);
    expect(buildRespondPayload(sel, items).answers).toEqual({ 'q-42': 'A' });
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
      { key: '0', question: 'Q1', answer: 'A', skipped: false },
      { key: '1', question: 'Q2', answer: 'C', skipped: false },
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
      { key: '0', question: 'Q1', answer: 'free text reply', skipped: false },
      { key: '1', question: 'Q2', answer: 'free text reply', skipped: false },
    ]);
  });

  it('cancelled: every question shows skipped=true with a null answer', () => {
    const block = questionBlock({ resolved: true, questionOutcome: 'cancelled', questions: items });
    expect(deriveFrozenPairs(block)).toEqual([
      { key: '0', question: 'Q1', answer: null, skipped: true },
      { key: '1', question: 'Q2', answer: null, skipped: true },
    ]);
  });

  it('returns an empty array when questions is missing', () => {
    const block = questionBlock({ resolved: true, questionOutcome: 'answered' });
    expect(deriveFrozenPairs(block)).toEqual([]);
  });

  it('with no item.id, the answer is still looked up by the question text — the protocol key equals the question', () => {
    const idLess = questionItem(['A'], { question: 'What is your name?' });
    expect(answerKeyFor(idLess)).toBe(idLess.question);

    const block = questionBlock({
      resolved: true,
      questionOutcome: 'answered',
      questions: [idLess],
      questionAnswers: { 'What is your name?': 'Ada' },
    });
    expect(deriveFrozenPairs(block)).toEqual([
      { key: '0', question: 'What is your name?', answer: 'Ada', skipped: false },
    ]);
  });
});

describe('isMaskedAnswer / SECRET_MASK (A10)', () => {
  it('masks a free-text answer when the question is marked isSecret', () => {
    const item = questionItem(['A', 'B'], { isSecret: true });
    expect(isMaskedAnswer(item, 'sk-live-abcdef123456')).toBe(true);

    const block = questionBlock({
      resolved: true,
      questionOutcome: 'answered',
      questions: [item],
      questionAnswers: { [item.question]: 'sk-live-abcdef123456' },
    });
    expect(deriveFrozenPairs(block)[0].answer).toBe(SECRET_MASK);
  });

  it('produces a byte-identical mask for two different-length free-text answers, with no plaintext substring leaked', () => {
    const item = questionItem([], { isSecret: true });
    const short = 'x1';
    const long = 'a-much-longer-secret-value-here';
    expect(short.length).not.toBe(long.length);

    const block = (answer: string) =>
      questionBlock({
        resolved: true,
        questionOutcome: 'answered',
        questions: [item],
        questionAnswers: { [item.question]: answer },
      });

    const shortMasked = deriveFrozenPairs(block(short))[0].answer;
    const longMasked = deriveFrozenPairs(block(long))[0].answer;

    // Same fixed-width output regardless of input length...
    expect(shortMasked).toBe(longMasked);
    expect(shortMasked).toBe(SECRET_MASK);

    // ...and the mask never contains any non-empty piece of either plaintext.
    for (const sub of [...allSubstrings(short), ...allSubstrings(long)]) {
      expect(SECRET_MASK.includes(sub)).toBe(false);
    }
  });

  it("does not mask when the answer is one of the question's own option labels, even if isSecret is true", () => {
    const item = questionItem(['Use environment variable', 'Paste inline'], { isSecret: true });
    expect(isMaskedAnswer(item, 'Use environment variable')).toBe(false);

    const block = questionBlock({
      resolved: true,
      questionOutcome: 'answered',
      questions: [item],
      questionAnswers: { [item.question]: 'Use environment variable' },
    });
    expect(deriveFrozenPairs(block)[0].answer).toBe('Use environment variable');
  });

  it('never masks when isSecret is absent or false', () => {
    const withoutFlag = questionItem(['A'], {});
    const withFalseFlag = questionItem(['A'], { isSecret: false });
    expect(isMaskedAnswer(withoutFlag, 'plain answer')).toBe(false);
    expect(isMaskedAnswer(withFalseFlag, 'plain answer')).toBe(false);
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

describe('derivePermissionRowView (2026-08-10: resolved permission collapses to a tool row)', () => {
  it('allowed: verb "Allowed", arg is the prompt, not failed', () => {
    const row = derivePermissionRowView(
      permissionBlock({ resolved: true, allowed: true, toolDescription: 'run tests' })
    );
    expect(row).toEqual({
      key: 'p1',
      verb: 'Allowed',
      arg: 'Bash — run tests',
      argKind: 'prose',
      running: false,
      failed: false,
      expandable: false,
    });
  });

  it('denied: verb "Denied", failed=true (reuses tool-row destructive semantics)', () => {
    const row = derivePermissionRowView(
      permissionBlock({ resolved: true, allowed: false, toolDescription: 'rm -rf /' })
    );
    expect(row?.verb).toBe('Denied');
    expect(row?.failed).toBe(true);
  });

  it('with an origin label: appended to arg with " · "', () => {
    const row = derivePermissionRowView(
      permissionBlock({ resolved: true, allowed: true, toolDescription: 'run tests' }),
      'From subagent · reviewer'
    );
    expect(row?.arg).toBe('Bash — run tests · From subagent · reviewer');
  });

  it('pending: returns null (pending/waiting stays the QA card)', () => {
    const row = derivePermissionRowView(permissionBlock({ resolved: false }));
    expect(row).toBeNull();
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

  it('G6: only the session queue HEAD is answerable — later entries wait their turn (serialized ruling)', () => {
    const twoForOneSession = [
      { sessionId: 's1', permissionId: 'perm-1' },
      { sessionId: 's1', permissionId: 'perm-2' },
    ];
    expect(canRespondToPermission(twoForOneSession, 's1', 'perm-1')).toBe(true);
    expect(canRespondToPermission(twoForOneSession, 's1', 'perm-2')).toBe(false);
  });

  it('G7: after the head resolves (dequeued), the next entry becomes answerable', () => {
    const afterHeadResolved = [{ sessionId: 's1', permissionId: 'perm-2' }];
    expect(canRespondToPermission(afterHeadResolved, 's1', 'perm-2')).toBe(true);
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
