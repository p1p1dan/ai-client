import type { PermissionDecisionId, QuestionItem } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import {
  answerKeyFor,
  buildOptionRows,
  buildPermissionOptionRows,
  buildRespondPayload,
  buildSkipPayload,
  canContinue,
  canRespondToPermission,
  clampPage,
  countDiffStat,
  deriveCardTitle,
  deriveFrozenPairs,
  derivePager,
  derivePermissionCardView,
  derivePermissionDetailView,
  derivePermissionOmittedNote,
  derivePermissionRowView,
  derivePermissionVerb,
  deriveQuestionCardState,
  emptySelection,
  isMaskedAnswer,
  PERMISSION_DECISION_LABELS,
  PERMISSION_NO_COMMAND_NOTE,
  permissionDecisionAllows,
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
    // Slice 4 contract migration: the rows now carry the decision they send,
    // because the card used to recover it from the LABEL. Labels and the A/B
    // order are asserted unchanged on purpose — "copy did not change" is a
    // separate claim from "the object did not change".
    expect(view.options).toEqual([
      { letter: 'A', label: 'Allow', isOther: false, decision: 'allow' },
      { letter: 'B', label: 'Deny', isOther: false, decision: 'deny' },
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

/**
 * S3 slice 4 (Codex permission projection), renderer half. Every assertion
 * below is one of the acceptance rows the spec froze BEFORE the code existed:
 * A19 (rows carry their decision), A21 (no decisions -> the historical pair,
 * verbatim; omitted-count note), A22 (resolved verbs + auto provenance), and
 * the renderer halves of A7 / A8 (grantRoot and the exec extras must be
 * VISIBLE, not merely carried).
 */
describe('permission decisions: rows carry the id they send (A19, §3.3 label trap)', () => {
  it('three offered decisions render three lettered rows, each with its own id', () => {
    const view = derivePermissionCardView(
      permissionBlock({ permissionDecisions: ['allow', 'allow_session', 'deny'] }),
      true
    );
    expect(view.options).toEqual([
      { letter: 'A', label: 'Allow', isOther: false, decision: 'allow' },
      { letter: 'B', label: 'Allow for session', isOther: false, decision: 'allow_session' },
      { letter: 'C', label: 'Deny', isOther: false, decision: 'deny' },
    ]);
  });

  it('pressing row B sends allow_session with allow=true; row C sends deny with allow=false', () => {
    // The trap this replaces: the card derived allow/deny from the LABEL, so
    // "Allow for session" failed `label === 'Allow'` and went out as a DENY.
    const view = derivePermissionCardView(
      permissionBlock({ permissionDecisions: ['allow', 'allow_session', 'deny'] }),
      true
    );
    const second = view.options[1].decision;
    const third = view.options[2].decision;
    expect(second).toBe('allow_session');
    expect(third).toBe('deny');
    expect(second && permissionDecisionAllows(second)).toBe(true);
    expect(third && permissionDecisionAllows(third)).toBe(false);
  });

  it('allow is derived from the decision in exactly one direction, for all four ids', () => {
    expect(permissionDecisionAllows('allow')).toBe(true);
    expect(permissionDecisionAllows('allow_session')).toBe(true);
    expect(permissionDecisionAllows('deny')).toBe(false);
    expect(permissionDecisionAllows('cancel')).toBe(false);
  });

  it('"Deny and stop" is not spelled like a synonym of Deny (it interrupts the turn)', () => {
    expect(PERMISSION_DECISION_LABELS.cancel).toBe('Deny and stop');
    expect(PERMISSION_DECISION_LABELS.cancel).not.toBe(PERMISSION_DECISION_LABELS.deny);
  });

  it('a cancel-bearing card renders the stop row with its own id', () => {
    const rows = buildPermissionOptionRows(['allow', 'deny', 'cancel']);
    expect(rows.map((row) => row.decision)).toEqual(['allow', 'deny', 'cancel']);
    expect(rows.map((row) => row.label)).toEqual(['Allow', 'Deny', 'Deny and stop']);
  });

  it('waiting cards still offer nothing (queue gating is unchanged)', () => {
    const view = derivePermissionCardView(
      permissionBlock({ permissionDecisions: ['allow', 'deny', 'cancel'] }),
      false
    );
    expect(view.waiting).toBe(true);
    expect(view.options).toEqual([]);
  });

  it('drops an id this build has no label for rather than rendering a blank row', () => {
    const block = permissionBlock({
      permissionDecisions: ['allow', 'allow_forever' as PermissionDecisionId, 'deny'],
    });
    const view = derivePermissionCardView(block, true);
    expect(view.options.map((row) => row.decision)).toEqual(['allow', 'deny']);
    expect(view.options.map((row) => row.letter)).toEqual(['A', 'B']);
  });

  it('never invents an Allow, and never leaves an unanswerable card, when nothing survives', () => {
    // Unreachable through the Host (its output always contains a deny), so
    // this pins the fail-safe direction for a payload that broke that promise.
    const view = derivePermissionCardView(permissionBlock({ permissionDecisions: [] }), true);
    expect(view.options.map((row) => row.decision)).toEqual(['deny']);
  });

  it('a prototype key is not a decision (these ids arrive off the wire)', () => {
    // `'constructor' in labels` is TRUE, which would have "labelled" the row
    // with `Object.prototype.constructor` — a function rendered as a button.
    const view = derivePermissionCardView(
      permissionBlock({
        permissionDecisions: [
          'constructor' as PermissionDecisionId,
          'toString' as PermissionDecisionId,
        ],
      }),
      true
    );
    expect(view.options.map((row) => row.decision)).toEqual(['deny']);
    expect(view.options.map((row) => row.label)).toEqual(['Deny']);
  });
});

describe('permission card regressions (A21)', () => {
  it('no decisions key: exactly the historical two rows, copy byte-identical', () => {
    const view = derivePermissionCardView(permissionBlock(), true);
    expect(view.options).toHaveLength(2);
    expect(view.options.map((row) => row.label)).toEqual(['Allow', 'Deny']);
    expect(view.options.map((row) => row.letter)).toEqual(['A', 'B']);
  });

  it('omittedDecisionCount absent or 0: no note', () => {
    expect(derivePermissionCardView(permissionBlock(), true).omittedNote).toBeNull();
    expect(
      derivePermissionCardView(permissionBlock({ omittedDecisionCount: 0 }), true).omittedNote
    ).toBeNull();
    expect(derivePermissionOmittedNote(undefined)).toBeNull();
    expect(derivePermissionOmittedNote(0)).toBeNull();
  });

  it('omittedDecisionCount > 0: one note naming the count, in the card-bottom slot', () => {
    const view = derivePermissionCardView(
      permissionBlock({ permissionDecisions: ['allow', 'deny'], omittedDecisionCount: 2 }),
      true
    );
    expect(view.omittedNote).not.toBeNull();
    expect(view.omittedNote).toContain('2');
    // The note is its own field rather than an extra option row: a decision
    // the build cannot model must never become something a user can press.
    expect(view.options).toHaveLength(2);
  });
});

describe('resolved permission verbs and provenance (A22)', () => {
  const cases: Array<[PermissionDecisionId, boolean, string]> = [
    ['allow', true, 'Allowed'],
    ['allow_session', true, 'Allowed for session'],
    ['deny', false, 'Denied'],
    ['cancel', false, 'Denied, turn stopped'],
  ];

  for (const [decision, allowed, verb] of cases) {
    it(`${decision} -> "${verb}"`, () => {
      const block = permissionBlock({ resolved: true, allowed, permissionDecision: decision });
      expect(derivePermissionVerb(block)).toBe(verb);
      expect(derivePermissionRowView(block)?.verb).toBe(verb);
      expect(derivePermissionCardView(block, false).frozen[0].answer).toBe(verb);
    });
  }

  it('no decision: falls back to the allowed boolean (Claude side is untouched)', () => {
    expect(derivePermissionVerb(permissionBlock({ resolved: true, allowed: true }))).toBe(
      'Allowed'
    );
    expect(derivePermissionVerb(permissionBlock({ resolved: true, allowed: false }))).toBe(
      'Denied'
    );
    expect(derivePermissionRowView(permissionBlock({ resolved: true, allowed: true }))?.verb).toBe(
      'Allowed'
    );
  });

  it('autoReason is appended at the tail, so "nobody was asked" is legible', () => {
    const block = permissionBlock({
      resolved: true,
      allowed: false,
      permissionDecision: 'deny',
      permissionAutoReason: 'aborted',
      toolDescription: 'rm -rf /',
    });
    expect(derivePermissionCardView(block, false).frozen[0].answer).toBe('Denied · auto: aborted');
    const row = derivePermissionRowView(block, 'From subagent · reviewer');
    // Verb stays the decision alone; provenance rides the tail of the arg,
    // after the origin chip.
    expect(row?.verb).toBe('Denied');
    expect(row?.arg).toBe('Bash — rm -rf / · From subagent · reviewer · auto: aborted');
  });

  it('no autoReason: nothing is appended (a human decided, and the row says so by omission)', () => {
    const block = permissionBlock({ resolved: true, allowed: true, permissionDecision: 'allow' });
    expect(derivePermissionCardView(block, false).frozen[0].answer).toBe('Allowed');
    expect(derivePermissionRowView(block)?.arg).toBe('Bash');
  });
});

describe('permission card body — exec (A8 renderer half)', () => {
  it('command, cwd and the managed-network target all reach the card', () => {
    const view = derivePermissionDetailView(
      permissionBlock({
        permissionDetail: {
          kind: 'exec',
          command: 'curl https://example.com',
          cwd: '/repo',
          network: { host: 'example.com', protocol: 'https' },
        },
      })
    );
    expect(view?.kind).toBe('exec');
    expect(view?.command).toBe('curl https://example.com');
    expect(view?.meta).toEqual(['cwd: /repo', 'Network: https://example.com']);
    expect(view?.warnings).toEqual([]);
    expect(view?.notes).toEqual([]);
  });

  it('additionalPermissions surface as a warning naming the count and the network flag', () => {
    const view = derivePermissionDetailView(
      permissionBlock({
        permissionDetail: {
          kind: 'exec',
          command: 'ls',
          extraPermissions: { fileSystemEntries: 3, networkRequested: true },
        },
      })
    );
    expect(view?.warnings).toHaveLength(1);
    expect(view?.warnings[0]).toContain('3');
    expect(view?.warnings[0]).toContain('是');
  });

  it('no extra permissions: no warning line at all', () => {
    const view = derivePermissionDetailView(
      permissionBlock({ permissionDetail: { kind: 'exec', command: 'ls' } })
    );
    expect(view?.warnings).toEqual([]);
  });

  it('command absent: the body is NOT empty — it says what codex did not report', () => {
    // The rejected alternative was auto-denying a null command. `command` is
    // typed string|null by the contract, so that would refuse a whole declared
    // class of approval on the user's behalf.
    const view = derivePermissionDetailView(
      permissionBlock({
        permissionDetail: {
          kind: 'exec',
          network: { host: 'example.com', protocol: 'https' },
          extraPermissions: { fileSystemEntries: 0, networkRequested: true },
        },
      })
    );
    expect(view?.command).toBeNull();
    expect(view?.notes).toEqual([PERMISSION_NO_COMMAND_NOTE]);
    expect(view?.meta).toEqual(['Network: https://example.com']);
    expect(view?.warnings).toHaveLength(1);
  });

  it('half a network context is not rendered as a target (the Host drops it, the card has none)', () => {
    const view = derivePermissionDetailView(
      permissionBlock({ permissionDetail: { kind: 'exec', command: 'ls' } })
    );
    expect(view?.meta).toEqual([]);
  });
});

describe('permission card body — file_change (A7 renderer half)', () => {
  it('one row per file: badge, path and the +/- counted off the diff', () => {
    const view = derivePermissionDetailView(
      permissionBlock({
        permissionDetail: {
          kind: 'file_change',
          changes: [
            {
              path: 'src/a.ts',
              change: 'update',
              diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n+added one\n+added two\n-removed one\n',
            },
            { path: 'src/b.ts', change: 'add' },
          ],
        },
      })
    );
    expect(view?.files).toEqual([
      {
        key: '0:src/a.ts',
        path: 'src/a.ts',
        change: 'update',
        badge: 'M',
        stat: '+2/-1',
        truncated: false,
      },
      {
        key: '1:src/b.ts',
        path: 'src/b.ts',
        change: 'add',
        badge: 'A',
        // No diff arrived: that is not the same statement as "+0/-0".
        stat: null,
        truncated: false,
      },
    ]);
  });

  it('A6(b): the patch never arrived -> no body at all, and the card still asks', () => {
    // The Host always sends a detail for a patch approval, empty when the diff
    // had not landed (it never delays the card for one). An empty body would
    // render as a blank padded box under the prompt, so it collapses to "no
    // body" — while the prompt and the buttons stay exactly where they were.
    const block = permissionBlock({
      toolName: 'Apply patch',
      permissionDetail: { kind: 'file_change', changes: [] },
    });
    expect(derivePermissionDetailView(block)).toBeNull();
    const view = derivePermissionCardView(block, true);
    expect(view.detail).toBeNull();
    expect(view.prompt).toBe('Apply patch');
    expect(view.options).toHaveLength(2);
  });

  it('an empty change list still renders a body when grantRoot is the whole story', () => {
    const view = derivePermissionDetailView(
      permissionBlock({
        permissionDetail: { kind: 'file_change', changes: [], grantRoot: '/repo' },
      })
    );
    expect(view?.files).toEqual([]);
    expect(view?.warnings).toHaveLength(1);
  });

  it('grantRoot renders a warning: an Allow for one patch is a session-long directory grant', () => {
    const view = derivePermissionDetailView(
      permissionBlock({
        permissionDetail: {
          kind: 'file_change',
          changes: [{ path: 'src/a.ts', change: 'update' }],
          grantRoot: '/repo/src',
        },
      })
    );
    expect(view?.warnings).toHaveLength(1);
    expect(view?.warnings[0]).toContain('/repo/src');
  });

  it('no grantRoot: no such line', () => {
    const view = derivePermissionDetailView(
      permissionBlock({
        permissionDetail: { kind: 'file_change', changes: [{ path: 'a', change: 'delete' }] },
      })
    );
    expect(view?.warnings).toEqual([]);
    expect(view?.files[0].badge).toBe('D');
  });

  it('omittedFileCount and a clamped diff are both stated, never hidden', () => {
    const view = derivePermissionDetailView(
      permissionBlock({
        permissionDetail: {
          kind: 'file_change',
          changes: [{ path: 'big.ts', change: 'update', diff: '+one\n', truncated: true }],
          omittedFileCount: 5,
        },
      })
    );
    expect(view?.files[0].truncated).toBe(true);
    expect(view?.notes).toHaveLength(1);
    expect(view?.notes[0]).toContain('5');
  });

  it('a rename lists both sides without colliding on a React key', () => {
    const view = derivePermissionDetailView(
      permissionBlock({
        permissionDetail: {
          kind: 'file_change',
          changes: [
            { path: 'same.ts', change: 'rename' },
            { path: 'same.ts', change: 'rename' },
          ],
        },
      })
    );
    expect(view?.files[0].key).not.toBe(view?.files[1].key);
    expect(view?.files[0].badge).toBe('R');
  });

  it('no detail at all: null body, and the card still renders its prompt and rows', () => {
    const block = permissionBlock();
    expect(derivePermissionDetailView(block)).toBeNull();
    const view = derivePermissionCardView(block, true);
    expect(view.detail).toBeNull();
    expect(view.options).toHaveLength(2);
  });
});

describe('countDiffStat', () => {
  it('counts body lines only — file headers are not changes', () => {
    expect(countDiffStat('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n')).toEqual({
      added: 1,
      removed: 1,
    });
  });

  it('ignores the no-newline marker (it starts with a backslash)', () => {
    expect(countDiffStat('+one\n\\ No newline at end of file\n')).toEqual({
      added: 1,
      removed: 0,
    });
  });

  it('absent diff is null, empty diff is 0/0 — the two are different claims', () => {
    expect(countDiffStat(undefined)).toBeNull();
    expect(countDiffStat('')).toEqual({ added: 0, removed: 0 });
  });

  // The defect the hunk-awareness fixes. A body line is the marker glued to the
  // file's own text, so a source line that itself starts with `--` / `++` comes
  // back looking like a file header — and the prefix-only rule dropped it,
  // under-counting exactly the changes that look most like chrome.
  it('body lines that look like file headers are counted, not skipped', () => {
    // Deleting `--foo` and adding `++bar` inside a real hunk.
    expect(countDiffStat('--- a/x\n+++ b/x\n@@ -1 +1 @@\n---foo\n+++bar\n')).toEqual({
      added: 1,
      removed: 1,
    });
    // …and a body line that IS spelled like a header (`--- ` with the space)
    // still counts once we are inside a hunk.
    expect(countDiffStat('@@ -1 +1 @@\n--- a/x\n+++ b/x\n')).toEqual({ added: 1, removed: 1 });
  });

  it('real file headers are still skipped, and only before the first hunk', () => {
    expect(countDiffStat('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n')).toEqual({
      added: 1,
      removed: 1,
    });
    // A `diff ` separator restarts the header window, so a two-file patch does
    // not charge the second file's headers as one add and one delete.
    expect(
      countDiffStat(
        'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n' +
          'diff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-c\n+d\n'
      )
    ).toEqual({ added: 2, removed: 2 });
  });

  // Codex sends bare file CONTENT for an `add` [实测
  // codex-filechange-approval-turn.jsonl:8]. There is no patch to count, and
  // the pre-existing 0/0 is kept on purpose — a `+N` invented from a body
  // nobody called a diff would be a number with nothing behind it.
  //
  // Stated limitation, so it is not mistaken for a claim this function makes:
  // content is only distinguishable from a patch by the markers, so a bare body
  // whose lines happen to start with `+`/`-` is still counted. That is the
  // pre-existing behavior and it cannot be tightened here — the no-newline row
  // above pins that a header-less `+one` DOES count, i.e. a hunk header is not
  // required before a line is a change.
  it('bare file content (codex `add`) still counts 0/0', () => {
    expect(countDiffStat('hi\n')).toEqual({ added: 0, removed: 0 });
    expect(countDiffStat('line one\nline two\n')).toEqual({ added: 0, removed: 0 });
    // A content line spelled exactly like a header is read as one while no hunk
    // has been seen — the same rule, applied to input that carries no evidence
    // of being a patch either way.
    expect(countDiffStat('--- not a header, just prose\n')).toEqual({ added: 0, removed: 0 });
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
