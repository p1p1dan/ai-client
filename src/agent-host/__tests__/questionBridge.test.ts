import { describe, expect, it } from 'vitest';

import { QuestionBridge } from '../questionBridge.ts';

function createBridge(peerHasPending?: (sessionId: string) => boolean) {
  const events: Record<string, unknown>[] = [];
  const bridge = peerHasPending
    ? new QuestionBridge(
        (e) => events.push(e),
        () => undefined,
        peerHasPending
      )
    : new QuestionBridge((e) => events.push(e));
  return { events, bridge };
}

describe('QuestionBridge.request/respond', () => {
  it('emits question.requested then session.status waiting_question, using toolUseId as questionId', async () => {
    const { events, bridge } = createBridge();
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-1',
      input: { questions: [{ question: 'Pick one', options: [{ label: 'A' }] }] },
      signal: controller.signal,
      toolUseId: 'tool-1',
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'question.requested', sessionId: 'sess-1' });
    expect(events[1]).toMatchObject({
      type: 'session.status',
      sessionId: 'sess-1',
      payload: { status: 'waiting_question' },
    });

    bridge.respond({ sessionId: 'sess-1', questionId: 'tool-1', answers: { 'Pick one': 'A' } });
    await promise;
  });

  it('resolves with allow + answers and emits question.resolved then session.status running', async () => {
    const { events, bridge } = createBridge();
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-2',
      input: { questions: [{ question: 'Pick one', options: [{ label: 'A' }] }] },
      signal: controller.signal,
      toolUseId: 'tool-2',
    });

    const returned = bridge.respond({
      sessionId: 'sess-2',
      questionId: 'tool-2',
      answers: { 'Pick one': 'A' },
    });
    expect(returned).toBe(true);

    const result = await promise;
    expect(result.behavior).toBe('allow');

    const statusEvents = events.filter((e) => e.type === 'session.status');
    expect(statusEvents.at(-1)).toMatchObject({ payload: { status: 'running' } });
  });

  it('refuses a bare allow with no answers/response (cli.js would silently re-ask)', async () => {
    const { bridge } = createBridge();
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-3',
      input: { questions: [{ question: 'Pick one', options: [{ label: 'A' }] }] },
      signal: controller.signal,
      toolUseId: 'tool-3',
    });

    expect(bridge.respond({ sessionId: 'sess-3', questionId: 'tool-3' })).toBe(false);

    bridge.respond({ sessionId: 'sess-3', questionId: 'tool-3', cancel: true });
    await promise;
  });

  it('does not emit running when a SECOND question is still parked on this session (own-pending check)', async () => {
    const { events, bridge } = createBridge();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const promiseA = bridge.request({
      sessionId: 'sess-4',
      input: { questions: [{ question: 'A?', options: [{ label: 'yes' }] }] },
      signal: controllerA.signal,
      toolUseId: 'tool-4a',
    });
    bridge.request({
      sessionId: 'sess-4',
      input: { questions: [{ question: 'B?', options: [{ label: 'yes' }] }] },
      signal: controllerB.signal,
      toolUseId: 'tool-4b',
    });

    const eventsBeforeRespondA = events.length;
    bridge.respond({ sessionId: 'sess-4', questionId: 'tool-4a', answers: { 'A?': 'yes' } });
    await promiseA;

    const newEventsAfterA = events.slice(eventsBeforeRespondA);
    expect(newEventsAfterA.some((e) => e.type === 'session.status')).toBe(false);
    expect(bridge.hasPending('sess-4')).toBe(true);
  });
});

describe('QuestionBridge — peer pending (S8, round-2 iteration-3 review)', () => {
  it('emits waiting_permission (not running) when the sibling bridge still holds a pending item for this session', async () => {
    const { events, bridge } = createBridge((sessionId) => sessionId === 'sess-peer-1');
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-peer-1',
      input: { questions: [{ question: 'Pick one', options: [{ label: 'A' }] }] },
      signal: controller.signal,
      toolUseId: 'tool-peer-1',
    });

    bridge.respond({ sessionId: 'sess-peer-1', questionId: 'tool-peer-1', answers: { x: 'A' } });
    await promise;

    const statusEvents = events.filter((e) => e.type === 'session.status');
    expect(statusEvents.at(-1)).toMatchObject({ payload: { status: 'waiting_permission' } });
    expect(statusEvents.some((e) => (e.payload as { status?: string }).status === 'running')).toBe(
      false
    );
  });

  it('emits running when the sibling bridge has nothing pending for this session', async () => {
    const { events, bridge } = createBridge(() => false);
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-peer-2',
      input: { questions: [{ question: 'Pick one', options: [{ label: 'A' }] }] },
      signal: controller.signal,
      toolUseId: 'tool-peer-2',
    });

    bridge.respond({ sessionId: 'sess-peer-2', questionId: 'tool-peer-2', answers: { x: 'A' } });
    await promise;

    const statusEvents = events.filter((e) => e.type === 'session.status');
    expect(statusEvents.at(-1)).toMatchObject({ payload: { status: 'running' } });
  });
});

describe('QuestionBridge.rejectSession / rejectAll', () => {
  it('rejectSession settles only the pending prompts for that session', async () => {
    const { bridge } = createBridge();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const promiseA = bridge.request({
      sessionId: 'A',
      input: { questions: [{ question: 'A?', options: [{ label: 'yes' }] }] },
      signal: controllerA.signal,
      toolUseId: 'tool-a',
    });
    const promiseB = bridge.request({
      sessionId: 'B',
      input: { questions: [{ question: 'B?', options: [{ label: 'yes' }] }] },
      signal: controllerB.signal,
      toolUseId: 'tool-b',
    });

    bridge.rejectSession('A');

    const resultA = await promiseA;
    expect(resultA).toMatchObject({ behavior: 'deny', message: 'Session closed' });
    expect(bridge.hasPending('A')).toBe(false);
    expect(bridge.hasPending('B')).toBe(true);

    bridge.respond({ sessionId: 'B', questionId: 'tool-b', answers: { x: 'yes' } });
    await promiseB;
  });
});
