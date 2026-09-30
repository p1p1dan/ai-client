import { describe, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '../../../shared/types/runtimeEvents.ts';
import {
  answerItemFor,
  createDshQuestionPrompt,
  type DshQuestionItem,
  DshQuestionWithdrawn,
  dshAnswerFor,
  questionItemFor,
  questionKeys,
  skippedAnswer,
} from '../questions.ts';

/**
 * dsh-rebase P1-4d3 (decisions 098, 114): the bridge's answerer of DSH's
 * `user-questions/request`, on 1.0.x's question card. Field mapping per P1-4
 * shard 01 §1; the real waterfall is exercised by bridge-record's `question`.
 */

const SCOPE: DshQuestionItem = {
  id: 'scope',
  header: 'Scope',
  question: 'Which part first?',
  options: [
    { label: 'Bridge (Recommended)', description: 'The worker side' },
    { label: 'Renderer' },
  ],
};
const CHECKS: DshQuestionItem = {
  id: 'checks',
  question: 'Which checks afterwards?',
  multiSelect: true,
  options: [{ label: 'tsc' }, { label: 'smoke, then record' }, { label: 'smoke' }],
};

type Emitted = Omit<RuntimeEventDraft, 'sessionId'>;

function prompt() {
  const events: Emitted[] = [];
  let next = 0;
  const questions = createDshQuestionPrompt({
    emit: (event) => events.push(event),
    newId: () => `dsh-question-${++next}`,
  });
  return { questions, events };
}

describe('the card a DSH question becomes', () => {
  it('keeps the model’s ids as the answer keys, unique where they repeat', () => {
    expect(questionKeys([SCOPE, CHECKS])).toEqual(['scope', 'checks']);
    expect(
      questionKeys([
        { id: 'q', question: 'a' },
        { id: 'q', question: 'b' },
        { id: 'q#2', question: 'c' },
        { id: 'q', question: 'd' },
      ])
    ).toEqual(['q', 'q#3', 'q#2', 'q#4']);
  });

  it('maps question, header, options and multi-select; detail joins the question; intent is dropped', () => {
    expect(questionItemFor(SCOPE, 'scope')).toEqual({
      id: 'scope',
      header: 'Scope',
      question: 'Which part first?',
      options: [
        { label: 'Bridge (Recommended)', description: 'The worker side' },
        { label: 'Renderer' },
      ],
    });
    expect(questionItemFor(CHECKS, 'checks')).toMatchObject({ multiSelect: true });
    expect(
      questionItemFor(
        {
          id: 'plan-review',
          question: 'Approve this plan?',
          detail: '# Plan\n\n1. Do it\n',
          options: [{ label: 'Approve' }],
          intent: { kind: 'plan-review', approve: 'Approve' },
        },
        'plan-review'
      )
    ).toEqual({
      id: 'plan-review',
      question: 'Approve this plan?\n\n# Plan\n\n1. Do it',
      options: [{ label: 'Approve' }],
    });
    // A free-text question: the card offers only Other.
    expect(questionItemFor({ id: 'name', question: 'Name?' }, 'name').options).toEqual([]);
  });
});

describe('an answer back in DSH’s shape', () => {
  it('single-select: one label, or the Other text as `custom`', () => {
    expect(answerItemFor(SCOPE, 'Renderer')).toEqual({ id: 'scope', selected: ['Renderer'] });
    expect(answerItemFor(SCOPE, 'Both, in turn')).toEqual({
      id: 'scope',
      selected: [],
      custom: 'Both, in turn',
    });
  });

  it('multi-select: the labels first (a label may hold ", "), the Other text last', () => {
    expect(answerItemFor(CHECKS, 'tsc, smoke, then record')).toEqual({
      id: 'checks',
      selected: ['tsc', 'smoke, then record'],
    });
    expect(answerItemFor(CHECKS, 'smoke, tsc, also lint')).toEqual({
      id: 'checks',
      selected: ['smoke', 'tsc'],
      custom: 'also lint',
    });
    expect(answerItemFor(CHECKS, 'nothing listed')).toEqual({
      id: 'checks',
      selected: [],
      custom: 'nothing listed',
    });
  });

  it('an unanswered question: nothing selected, or the free-text response', () => {
    expect(answerItemFor(SCOPE, undefined)).toEqual({ id: 'scope', selected: [] });
    expect(answerItemFor(SCOPE, undefined, 'you decide')).toEqual({
      id: 'scope',
      selected: [],
      custom: 'you decide',
    });
  });

  it('a whole response: answers by key; nothing, or a Skip, is null', () => {
    const keys = questionKeys([SCOPE, CHECKS]);
    expect(
      dshAnswerFor([SCOPE, CHECKS], keys, {
        answers: { scope: 'Bridge (Recommended)', checks: 'tsc' },
      })
    ).toEqual({
      answers: [
        { id: 'scope', selected: ['Bridge (Recommended)'] },
        { id: 'checks', selected: ['tsc'] },
      ],
    });
    expect(dshAnswerFor([SCOPE, CHECKS], keys, { response: 'skip the checks' })).toEqual({
      answers: [
        { id: 'scope', selected: [], custom: 'skip the checks' },
        { id: 'checks', selected: [], custom: 'skip the checks' },
      ],
    });
    expect(dshAnswerFor([SCOPE], ['scope'], { cancel: true, answers: { scope: 'Renderer' } })).toBe(
      null
    );
    expect(dshAnswerFor([SCOPE], ['scope'], { answers: {} })).toBe(null);
    expect(dshAnswerFor([SCOPE], ['scope'], { response: '   ' })).toBe(null);
  });

  it('maps a repeated id back to the model’s id', () => {
    const twice = [
      { id: 'q', question: 'First?', options: [{ label: 'A' }] },
      { id: 'q', question: 'Second?', options: [{ label: 'B' }] },
    ];
    const keys = questionKeys(twice);
    expect(dshAnswerFor(twice, keys, { answers: { q: 'A', 'q#2': 'B' } })).toEqual({
      answers: [
        { id: 'q', selected: ['A'] },
        { id: 'q', selected: ['B'] },
      ],
    });
  });
});

describe('createDshQuestionPrompt', () => {
  it('raises the card, and Continue settles it with the answer DSH reads', async () => {
    const { questions, events } = prompt();
    const asked = questions.ask({ questions: [SCOPE, CHECKS] });
    expect(questions.pending).toBe(1);
    expect(events).toEqual([
      {
        type: 'question.requested',
        payload: {
          questionId: 'dsh-question-1',
          questions: [questionItemFor(SCOPE, 'scope'), questionItemFor(CHECKS, 'checks')],
        },
      },
    ]);
    const answers = { scope: 'Renderer', checks: 'smoke, then record, also lint' };
    expect(questions.respond({ questionId: 'dsh-question-1', answers })).toBe(true);
    await expect(asked).resolves.toEqual({
      answers: [
        { id: 'scope', selected: ['Renderer'] },
        { id: 'checks', selected: ['smoke, then record'], custom: 'also lint' },
      ],
    });
    expect(events[1]).toEqual({
      type: 'question.resolved',
      payload: { questionId: 'dsh-question-1', outcome: 'answered', answers },
    });
    expect(questions.pending).toBe(0);
    // Settled once: a second answer finds nothing waiting.
    expect(questions.respond({ questionId: 'dsh-question-1', cancel: true })).toBe(false);
    expect(events).toHaveLength(2);
  });

  it('Skip answers every question with nothing selected, and resolves the card cancelled', async () => {
    const { questions, events } = prompt();
    const asked = questions.ask({ questions: [SCOPE, CHECKS] });
    expect(questions.respond({ questionId: 'dsh-question-1', cancel: true })).toBe(true);
    await expect(asked).resolves.toEqual(skippedAnswer([SCOPE, CHECKS]));
    expect(skippedAnswer([SCOPE, CHECKS])).toEqual({
      answers: [
        { id: 'scope', selected: [] },
        { id: 'checks', selected: [] },
      ],
    });
    expect(events[1]).toEqual({
      type: 'question.resolved',
      payload: { questionId: 'dsh-question-1', outcome: 'cancelled' },
    });
  });

  it('echoes a free-text response on the resolved card', async () => {
    const { questions, events } = prompt();
    const asked = questions.ask({ questions: [SCOPE] });
    questions.respond({ questionId: 'dsh-question-1', response: 'you pick' });
    await expect(asked).resolves.toEqual({
      answers: [{ id: 'scope', selected: [], custom: 'you pick' }],
    });
    expect(events[1]).toEqual({
      type: 'question.resolved',
      payload: { questionId: 'dsh-question-1', outcome: 'answered', response: 'you pick' },
    });
  });

  it('knows no other id', () => {
    const { questions } = prompt();
    void questions.ask({ questions: [SCOPE] });
    expect(questions.respond({ questionId: 'dsh-question-9', cancel: true })).toBe(false);
    expect(questions.pending).toBe(1);
  });

  it('the asker’s abort takes the card down and rejects the waterfall', async () => {
    const { questions, events } = prompt();
    const controller = new AbortController();
    const asked = questions.ask({ questions: [SCOPE], signal: controller.signal });
    controller.abort();
    await expect(asked).rejects.toBeInstanceOf(DshQuestionWithdrawn);
    expect(events.map((event) => event.type)).toEqual(['question.requested', 'question.resolved']);
    // Decision 144: marked `stopped`, so the card does not read as a Skip.
    expect(events[1]).toEqual({
      type: 'question.resolved',
      payload: { questionId: 'dsh-question-1', outcome: 'cancelled', stopped: true },
    });
    expect(questions.respond({ questionId: 'dsh-question-1', answers: { scope: 'A' } })).toBe(
      false
    );
  });

  it('an already-aborted request raises no card', async () => {
    const { questions, events } = prompt();
    const controller = new AbortController();
    controller.abort();
    await expect(
      questions.ask({ questions: [SCOPE], signal: controller.signal })
    ).rejects.toBeInstanceOf(DshQuestionWithdrawn);
    expect(events).toEqual([]);
  });

  it('drain withdraws every card still up', async () => {
    const { questions, events } = prompt();
    const first = questions.ask({ questions: [SCOPE] });
    const second = questions.ask({ questions: [CHECKS] });
    questions.drain('closing');
    await expect(first).rejects.toThrow('closing');
    await expect(second).rejects.toThrow('closing');
    const resolved = events.filter((event) => event.type === 'question.resolved');
    expect(resolved).toHaveLength(2);
    // Decision 144: nobody answered these either.
    expect(resolved.map((event) => event.payload)).toEqual([
      expect.objectContaining({ outcome: 'cancelled', stopped: true }),
      expect.objectContaining({ outcome: 'cancelled', stopped: true }),
    ]);
    expect(questions.pending).toBe(0);
  });
});
