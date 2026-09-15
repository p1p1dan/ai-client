/**
 * F5 gate — the `ask` tool and the worker-side question gate.
 *
 * What needs pinning here is everything that fails QUIETLY. A question that is
 * never emitted, an answer that reaches the wrong key, a skip that reads as an
 * answer, a parked promise nobody settles on dispose — none of those throws.
 * Each one instead leaves a turn waiting forever on a card that is either not
 * on screen or no longer answerable, which is precisely the state F5 exists to
 * get out of.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import type { AskUser, RuntimeQuestionAnswer } from '../plugins/tools/ask.ts';
import { createQuestionPrompt } from '../worker/questionPrompt.ts';
import { neverAsked } from './fixtures/approval.ts';

function collector() {
  const events: RuntimeEventDraft[] = [];
  const prompt = createQuestionPrompt({ sessionId: 's1', emit: (event) => events.push(event) });
  return { events, prompt };
}

const REQUEST = {
  questionId: 'call-1',
  questions: [
    {
      id: 'call-1-0',
      question: 'Which database?',
      header: 'Storage',
      options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite' }],
    },
    {
      id: 'call-1-1',
      question: 'Which database?',
      options: [{ label: 'Yes' }, { label: 'No' }],
      multiSelect: true,
    },
  ],
};

describe('F5 question gate', () => {
  it('emits the question with per-item ids, then resolves it with the answer', async () => {
    const { events, prompt } = collector();
    const pending = prompt.ask(REQUEST, undefined);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'question.requested',
      sessionId: 's1',
      payload: { questionId: 'call-1' },
    });
    const payload = (events[0] as { payload: { questions: { id: string }[] } }).payload;
    // Two questions worded identically. The ids are what tells them apart —
    // the answers map is keyed by them, and the text would collide.
    expect(payload.questions.map((item) => item.id)).toEqual(['call-1-0', 'call-1-1']);

    expect(
      prompt.respond({
        questionId: 'call-1',
        answers: { 'call-1-0': 'Postgres', 'call-1-1': 'Yes' },
      })
    ).toBe(true);
    await expect(pending).resolves.toEqual({
      outcome: 'answered',
      answers: { 'call-1-0': 'Postgres', 'call-1-1': 'Yes' },
    });
    expect(events[1]).toMatchObject({
      type: 'question.resolved',
      payload: { questionId: 'call-1', outcome: 'answered' },
    });
  });

  it('treats Skip as cancelled rather than as an empty answer', async () => {
    const { events, prompt } = collector();
    const pending = prompt.ask(REQUEST, undefined);
    expect(prompt.respond({ questionId: 'call-1', cancel: true })).toBe(true);
    await expect(pending).resolves.toEqual({ outcome: 'cancelled' });
    expect(events[1]).toMatchObject({ payload: { outcome: 'cancelled' } });
  });

  it('reports false for an id nobody is waiting on, and answers only once', async () => {
    const { prompt } = collector();
    expect(prompt.respond({ questionId: 'nothing', cancel: true })).toBe(false);
    const pending = prompt.ask(REQUEST, undefined);
    expect(prompt.respond({ questionId: 'call-1', answers: { 'call-1-0': 'Postgres' } })).toBe(
      true
    );
    // A card that was a moment behind the runtime is not an error; it is late.
    expect(prompt.respond({ questionId: 'call-1', cancel: true })).toBe(false);
    await expect(pending).resolves.toMatchObject({ outcome: 'answered' });
  });

  it('settles on abort, so stopping the turn does not strand the tool call', async () => {
    const { events, prompt } = collector();
    const controller = new AbortController();
    const pending = prompt.ask(REQUEST, controller.signal);
    controller.abort();
    await expect(pending).resolves.toEqual({ outcome: 'cancelled' });
    expect(events.at(-1)).toMatchObject({ type: 'question.resolved' });
  });

  it('settles immediately when the signal is already aborted', async () => {
    const { prompt } = collector();
    await expect(prompt.ask(REQUEST, AbortSignal.abort())).resolves.toEqual({
      outcome: 'cancelled',
    });
  });

  it('drains everything still parked, so dispose cannot leave a promise open', async () => {
    const { prompt } = collector();
    const first = prompt.ask(REQUEST, undefined);
    const second = prompt.ask({ ...REQUEST, questionId: 'call-2' }, undefined);
    prompt.drain('session_closed');
    await expect(first).resolves.toEqual({ outcome: 'cancelled' });
    await expect(second).resolves.toEqual({ outcome: 'cancelled' });
  });
});

describe('F5 ask tool', () => {
  let dir: string;
  const runtimes: RuntimeHandle[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-ask-'));
  });
  afterEach(async () => {
    for (const handle of runtimes.splice(0)) await handle.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  async function runtime(ask?: AskUser) {
    const faux = fauxProvider({
      provider: 'test',
      models: [{ id: 'test', name: 'Test', contextWindow: 128_000 }],
    });
    const handle = await createRuntime({
      env: {},
      traceDir: null,
      providers: [faux.provider],
      tools: { cwd: dir, ...(ask ? { ask } : {}) },
      permissions: { approve: neverAsked },
    });
    runtimes.push(handle);
    return { handle, faux };
  }

  function askCall(args: Record<string, unknown>) {
    const message = fauxAssistantMessage('');
    message.content = [{ type: 'toolCall', id: 'call-1', name: 'ask', arguments: args }];
    message.stopReason = 'toolUse';
    return message;
  }

  it('is not advertised at all when the host has nowhere to show a question', async () => {
    const { handle } = await runtime();
    expect(handle.ctx.runtimeTools.list().map((tool) => tool.name)).not.toContain('ask');
  });

  it('hands the model back each question next to its answer', async () => {
    const asked: unknown[] = [];
    const ask: AskUser = async (request) => {
      asked.push(request);
      return {
        outcome: 'answered',
        answers: { 'call-1-0': 'Postgres', 'call-1-1': 'Yes, No' },
      } satisfies RuntimeQuestionAnswer;
    };
    const { handle, faux } = await runtime(ask);
    faux.setResponses([
      askCall({
        questions: [
          {
            question: 'Which database?',
            header: 'Storage',
            options: [{ label: 'Postgres' }, { label: 'SQLite' }],
          },
          {
            question: 'Which extras?',
            multiSelect: true,
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      }),
      fauxAssistantMessage('done'),
    ]);
    const texts: string[] = [];
    const result = await handle.run({
      prompt: 'decide',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'ask') {
          expect(event.isError).toBeFalsy();
          for (const part of event.result.content) if (part.type === 'text') texts.push(part.text);
        }
      },
    });
    expect(result.success).toBe(true);
    expect(asked).toHaveLength(1);
    // Ids are assigned by the tool, not by the model, and are unique per item.
    expect((asked[0] as { questions: { id: string }[] }).questions.map((item) => item.id)).toEqual([
      'call-1-0',
      'call-1-1',
    ]);
    // Up to four answers come back as one tool result; without the questions
    // beside them the model has to guess which answer belongs to which.
    expect(texts.join('\n')).toContain('Which database?\nPostgres');
    expect(texts.join('\n')).toContain('Which extras?\nYes, No');
  });

  it('tells the model to pick a default when the user skips', async () => {
    const { handle, faux } = await runtime(async () => ({ outcome: 'cancelled' }));
    faux.setResponses([
      askCall({ questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }),
      fauxAssistantMessage('done'),
    ]);
    const texts: string[] = [];
    const result = await handle.run({
      prompt: 'decide',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'ask') {
          // A skip is NOT a failed tool call: the turn has to keep going.
          expect(event.isError).toBeFalsy();
          for (const part of event.result.content) if (part.type === 'text') texts.push(part.text);
        }
      },
    });
    expect(result.success).toBe(true);
    expect(texts.join('\n')).toContain('skipped');
  });

  it('rejects a question with only one option instead of showing an unanswerable card', async () => {
    const { handle, faux } = await runtime(async () => ({ outcome: 'cancelled' }));
    faux.setResponses([
      askCall({ questions: [{ question: 'Which?', options: [{ label: 'Only' }] }] }),
      fauxAssistantMessage('recovered'),
    ]);
    let errored = false;
    await handle.run({
      prompt: 'decide',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'ask')
          errored = event.isError;
      },
    });
    expect(errored).toBe(true);
  });

  it('stays available in plan mode, which is when asking matters most', async () => {
    const { handle } = await runtime(async () => ({ outcome: 'cancelled' }));
    handle.permissions?.configure({ mode: 'plan', gear: 'ask' });
    const names = handle.ctx.runtimeTools.list().map((tool) => tool.name);
    expect(names).toContain('ask');
    expect(names).not.toContain('write');
  });
});
