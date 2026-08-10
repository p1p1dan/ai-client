import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QuestionItem } from '../../shared/types/runtimeEvents.ts';
import {
  answerKeyFor,
  readAutoResolutionMs,
  toCodexAnswerBody,
  toQuestionItems,
} from '../codexQuestionBridge.ts';

/**
 * S3 slice 3 — the Codex question bridge.
 *
 * Two evidence sources, and the difference between them matters:
 *
 *  - `codex-question-requests.jsonl` — REAL captured frames. It holds only TWO
 *    inbound `item/tool/requestUserInput` bodies (ids 0 and 1, five questions
 *    total). The turn produced four exchanges, but the request bodies for ids
 *    2 and 3 were never captured; the fixture README forbids reconstructing
 *    them, because a replay test fed with an invented request proves nothing.
 *    So ids 2/3 are used only as corroboration for the ANSWER shape.
 *  - `codex-question-schema.json` — the binary's own generated schema. It is
 *    what makes the field reads evidence rather than habit.
 */

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures', 'codex');

interface FixtureEnvelope {
  dir: string;
  raw: {
    method?: string;
    id?: number;
    params?: Record<string, unknown>;
    result?: { answers: Record<string, { answers: string[] }> };
  };
}

const frames = readFileSync(path.join(FIXTURES, 'codex-question-requests.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as FixtureEnvelope);

/** Inbound question requests we actually hold bodies for. */
const capturedRequests = frames.filter(
  (frame) => frame.dir === '<-' && frame.raw.method === 'item/tool/requestUserInput'
);

/** Every reply we sent in that turn, including the two whose request is lost. */
const capturedReplies = frames.filter((frame) => frame.dir === '->' && frame.raw.result);

interface SchemaShape {
  _from: string;
  required: string[];
  propertyNames: string[];
}

const questionSchema = JSON.parse(
  readFileSync(path.join(FIXTURES, 'codex-question-schema.json'), 'utf8')
) as {
  codexVersion: string;
  ToolRequestUserInputParams: SchemaShape;
  ToolRequestUserInputQuestion: SchemaShape;
  ToolRequestUserInputOption: SchemaShape;
  ToolRequestUserInputResponse: SchemaShape;
  ToolRequestUserInputAnswer: SchemaShape;
  ToolRequestUserInputQuestionOptionsType: { type: string[] };
};

function question(over: Partial<QuestionItem> & { question: string }): QuestionItem {
  return { options: [], ...over };
}

describe('the fixtures are what this file thinks they are', () => {
  // A pinning test whose corpus silently shrank passes vacuously. These two
  // numbers are the ones the spec's acceptance table was corrected to, after a
  // review found it had copied "4 requests / 10 questions" out of the design
  // doc — a count the repo does not hold.
  it('holds exactly 2 captured request bodies covering 5 questions', () => {
    expect(capturedRequests).toHaveLength(2);
    const total = capturedRequests.reduce(
      (sum, frame) => sum + (frame.raw.params?.questions as unknown[]).length,
      0
    );
    expect(total).toBe(5);
  });

  it('holds 4 replies, i.e. 2 whose request body was never captured', () => {
    expect(capturedReplies).toHaveLength(4);
  });

  it('records which codex build the schema came from', () => {
    expect(questionSchema.codexVersion).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe('toQuestionItems — replay of the real captured requests', () => {
  it('maps every captured question field for field', () => {
    for (const frame of capturedRequests) {
      const raw = frame.raw.params?.questions as Array<Record<string, unknown>>;
      const { items, dropped } = toQuestionItems(frame.raw.params);

      expect(dropped).toBe(0);
      expect(items).toHaveLength(raw.length);
      items.forEach((item, index) => {
        const source = raw[index];
        expect(item.question).toBe(source.question);
        expect(item.header).toBe(source.header);
        expect(item.id).toBe(source.id);
        expect(item.options).toEqual(
          (source.options as Array<Record<string, string>>).map((option) => ({
            label: option.label,
            description: option.description,
          }))
        );
        // All five retained samples are `isSecret:false`, and the protocol
        // reads an absent flag as false — so the mapped item must not carry it.
        expect(item.isSecret).toBeUndefined();
        // codex has no multi-select field, so inventing one would be inventing
        // a capability. This is what makes a codex answer a single string.
        expect(item.multiSelect).toBeUndefined();
      });
    }
  });

  it('passes autoResolutionMs through as the captured null', () => {
    for (const frame of capturedRequests) {
      expect(readAutoResolutionMs(frame.raw.params)).toBeNull();
    }
  });
});

describe('toCodexAnswerBody — replay against the real replies', () => {
  /** Renderer shape: one joined string per question, keyed the C8 way. */
  function rendererAnswers(result: {
    answers: Record<string, { answers: string[] }>;
  }): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(result.answers)) out[key] = value.answers.join(', ');
    return out;
  }

  it('reproduces the two replies whose request we hold, deep-equal', () => {
    // Deep-equal, not byte-equal: JSON key order is an implementation detail of
    // whichever object literal produced the frame, and asserting it would fail
    // for a body that is correct on the wire.
    for (const request of capturedRequests) {
      const reply = capturedReplies.find((frame) => frame.raw.id === request.raw.id);
      if (!reply?.raw.result) throw new Error(`no reply for request ${String(request.raw.id)}`);
      const { items } = toQuestionItems(request.raw.params);
      const { body, unmatched, responseIgnored } = toCodexAnswerBody(items, {
        answers: rendererAnswers(reply.raw.result),
      });
      expect(body).toEqual(reply.raw.result);
      expect(unmatched).toBe(0);
      expect(responseIgnored).toBe(false);
    }
  });

  it('[旁证] the two replies with no captured request still corroborate the answer shape', () => {
    // Weak on purpose. Without the request body there is nothing to drive the
    // bridge with, so all these frames can pin is that every answer the server
    // accepted was a single-element array — the same fact `toCodexAnswerBody`
    // relies on when it declines to split values.
    const orphans = capturedReplies.filter(
      (reply) => !capturedRequests.some((request) => request.raw.id === reply.raw.id)
    );
    expect(orphans).toHaveLength(2);
    for (const reply of orphans) {
      for (const answer of Object.values(reply.raw.result?.answers ?? {})) {
        expect(answer.answers).toHaveLength(1);
        expect(typeof answer.answers[0]).toBe('string');
      }
    }
  });
});

describe('toQuestionItems — shapes the contract allows but no sample shows', () => {
  it.each([
    ['null', null],
    ['absent', undefined],
    ['a string', 'nope'],
    ['an object', { label: 'x' }],
  ])('reads options that are %s as an empty list, keeping the question', (_label, options) => {
    // The generated contract types `options` as ["array","null"]; the retained
    // samples never show one. A question with no options is still answerable
    // because the card always appends an "Other…" row.
    const { items, dropped } = toQuestionItems({
      questions: [{ id: 'q', header: 'H', question: 'Which?', options }],
    });
    expect(dropped).toBe(0);
    expect(items).toHaveLength(1);
    expect(items[0].options).toEqual([]);
  });

  it('drops options with no usable label but keeps the rest', () => {
    const { items } = toQuestionItems({
      questions: [
        {
          id: 'q',
          question: 'Which?',
          options: [{ label: 'Keep' }, { description: 'no label' }, { label: '' }],
        },
      ],
    });
    expect(items[0].options).toEqual([{ label: 'Keep' }]);
  });

  it('drops unreadable questions and counts them', () => {
    const { items, dropped } = toQuestionItems({
      questions: [{ id: 'a', question: 'Real?' }, { id: 'b' }, null, { question: '' }],
    });
    expect(items).toHaveLength(1);
    expect(dropped).toBe(3);
  });

  it('omits id rather than minting one when the agent sent none', () => {
    // A synthesized id would key the answers map with something the server
    // never sent; the answer would then be dropped server-side with no error.
    const { items } = toQuestionItems({ questions: [{ question: 'Which?' }] });
    expect(items[0].id).toBeUndefined();
    expect(answerKeyFor(items[0])).toBe('Which?');
  });

  it('marks isSecret only when it is literally true', () => {
    const { items } = toQuestionItems({
      questions: [
        { id: 'a', question: 'A', isSecret: true },
        { id: 'b', question: 'B', isSecret: false },
        { id: 'c', question: 'C', isSecret: 'yes' },
        { id: 'd', question: 'D' },
      ],
    });
    expect(items.map((item) => item.isSecret)).toEqual([true, undefined, undefined, undefined]);
  });

  it.each([
    ['a number', 3000, 3000],
    ['null', null, null],
    ['absent', undefined, undefined],
    ['a string', '3000', undefined],
    ['NaN', Number.NaN, undefined],
  ])('reads autoResolutionMs that is %s', (_label, raw, expected) => {
    expect(readAutoResolutionMs({ questions: [], autoResolutionMs: raw })).toBe(expected);
  });
});

describe('toCodexAnswerBody — the value is never split', () => {
  // The S2 design said to split on ", ". The generated contract then showed
  // codex questions have no multi-select field, so the renderer never joins
  // parts for them — leaving a split rule that could only ever fire on free
  // text the user typed, and damage it. Every row here is a value that a split
  // would have corrupted.
  const items = [
    question({
      id: 'q',
      question: 'Which host?',
      options: [{ label: 'Enable' }, { label: 'Disable' }, { label: 'A, B' }],
    }),
  ];

  it.each([
    ['free text containing a comma', 'db.internal, port 5432'],
    ['a label that itself contains a comma', 'A, B'],
    ['free text that happens to be entirely option labels', 'Enable, Disable'],
    ['a plain label', 'Enable'],
    ['text with a trailing comma', 'one,'],
  ])('keeps %s verbatim as a single answer', (_label, value) => {
    const { body } = toCodexAnswerBody(items, { answers: { q: value } });
    expect(body.answers.q.answers).toEqual([value]);
  });
});

describe('toCodexAnswerBody — cancel, response and unanswered questions', () => {
  const two = [question({ id: 'a', question: 'A?' }), question({ id: 'b', question: 'B?' })];

  it('turns cancel into the empty answers map', () => {
    // The clean cancel on this wire: the model does not re-ask. This is the
    // OPPOSITE of the Claude CLI, whose bridge refuses empty payloads.
    const { body } = toCodexAnswerBody(two, { cancel: true, answers: { a: 'ignored' } });
    expect(body).toEqual({ answers: {} });
  });

  it('folds a free-text response in only when the card asked exactly one question', () => {
    const one = [question({ id: 'a', question: 'A?' })];
    const single = toCodexAnswerBody(one, { response: 'staging' });
    expect(single.body.answers.a.answers).toEqual(['staging']);
    expect(single.responseIgnored).toBe(false);
  });

  it('never broadcasts one response across several questions', () => {
    // Broadcasting would tell the model it answered questions it was never
    // asked, and the transport forwards `response` for every agent.
    const many = toCodexAnswerBody(two, { response: 'staging' });
    expect(many.body).toEqual({ answers: {} });
    expect(many.responseIgnored).toBe(true);
    expect(many.unmatched).toBe(2);
  });

  it('omits keys for questions with no answer and reports the count', () => {
    const { body, unmatched } = toCodexAnswerBody(two, { answers: { a: 'yes', b: '' } });
    expect(Object.keys(body.answers)).toEqual(['a']);
    expect(unmatched).toBe(1);
  });

  it('keys by question text when the item carries no id (Claude shape)', () => {
    const claude = [question({ question: 'Pick one' })];
    const { body } = toCodexAnswerBody(claude, { answers: { 'Pick one': 'yes' } });
    expect(body.answers['Pick one'].answers).toEqual(['yes']);
  });
});

describe('the bridge and the generated contract agree, in both directions', () => {
  /** Records every property name the code under test actually reads. */
  function recordingProxy<T extends object>(target: T, seen: Set<string>): T {
    return new Proxy(target, {
      get(obj, prop, receiver) {
        if (typeof prop === 'string') seen.add(prop);
        return Reflect.get(obj, prop, receiver);
      },
    });
  }

  const questionKeys = new Set<string>();
  const paramKeys = new Set<string>();
  const probeQuestion = recordingProxy(
    { id: 'q', header: 'H', question: 'Which?', isOther: true, isSecret: false, options: [] },
    questionKeys
  );
  const probeParams = recordingProxy(
    {
      threadId: 't',
      turnId: 'u',
      itemId: 'call_1',
      autoResolutionMs: null,
      questions: [probeQuestion],
    },
    paramKeys
  );
  toQuestionItems(probeParams);
  readAutoResolutionMs(probeParams);

  it('reads no question field the contract does not declare', () => {
    // Both sides come from live values: the left from what the code touched,
    // the right from the generated schema. Nothing here is a literal the
    // implementation could be wrong about in the same way twice.
    for (const key of questionKeys) {
      expect(questionSchema.ToolRequestUserInputQuestion.propertyNames).toContain(key);
    }
  });

  it('reads every question field the contract marks required', () => {
    for (const required of questionSchema.ToolRequestUserInputQuestion.required) {
      expect([...questionKeys]).toContain(required);
    }
  });

  it('reads no params field the contract does not declare', () => {
    for (const key of paramKeys) {
      expect(questionSchema.ToolRequestUserInputParams.propertyNames).toContain(key);
    }
    // Deliberately NOT asserted: that the bridge reads every REQUIRED param.
    // `threadId` / `turnId` / `itemId` are the runtime's business (thread
    // ownership and correlation), not the translator's.
    expect(paramKeys.has('questions')).toBe(true);
  });

  it('writes an answer body whose shape the contract requires', () => {
    const { body } = toCodexAnswerBody([question({ id: 'q', question: 'Q?' })], {
      answers: { q: 'yes' },
    });
    expect(Object.keys(body)).toEqual(questionSchema.ToolRequestUserInputResponse.required);
    expect(Object.keys(body.answers.q)).toEqual(questionSchema.ToolRequestUserInputAnswer.required);
    expect(Array.isArray(body.answers.q.answers)).toBe(true);
  });

  it('records the nullable options type the fault-tolerant read depends on', () => {
    // The fixture README once claimed this nullability was fake. It is not,
    // and the tolerant read above is justified by exactly this node.
    expect(questionSchema.ToolRequestUserInputQuestionOptionsType.type).toEqual(['array', 'null']);
  });
});
