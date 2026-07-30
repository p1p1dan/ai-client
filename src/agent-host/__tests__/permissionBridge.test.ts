import { describe, expect, it } from 'vitest';

import { PermissionBridge } from '../permissionBridge.ts';

function createBridge() {
  const events: Record<string, unknown>[] = [];
  const bridge = new PermissionBridge((e) => events.push(e));
  return { events, bridge };
}

describe('PermissionBridge.request', () => {
  it('emits permission.requested then session.status waiting_permission, using toolUseId as permissionId', async () => {
    const { events, bridge } = createBridge();
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      signal: controller.signal,
      toolUseId: 'tool-1',
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'permission.requested',
      sessionId: 'sess-1',
      payload: { permissionId: 'tool-1', toolName: 'Bash', input: { command: 'ls' } },
    });
    expect(events[1]).toMatchObject({
      type: 'session.status',
      sessionId: 'sess-1',
      payload: { status: 'waiting_permission' },
    });

    bridge.respond({ sessionId: 'sess-1', permissionId: 'tool-1', allow: true });
    await promise;
  });

  it('resolves with allow and emits permission.resolved then session.status running on respond(allow: true)', async () => {
    const { events, bridge } = createBridge();
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-2',
      toolName: 'Read',
      input: {},
      signal: controller.signal,
      toolUseId: 'tool-2',
    });

    const returned = bridge.respond({ sessionId: 'sess-2', permissionId: 'tool-2', allow: true });
    expect(returned).toBe(true);

    const result = await promise;
    expect(result).toEqual({ behavior: 'allow', toolUseID: 'tool-2' });

    expect(events).toHaveLength(4);
    expect(events[2]).toMatchObject({
      type: 'permission.resolved',
      sessionId: 'sess-2',
      payload: { permissionId: 'tool-2', allow: true },
    });
    expect(events[3]).toMatchObject({
      type: 'session.status',
      sessionId: 'sess-2',
      payload: { status: 'running' },
    });
  });

  it('resolves with a deny result on respond(allow: false), and emits permission.resolved with allow: false', async () => {
    const { events, bridge } = createBridge();
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-3',
      toolName: 'Write',
      input: {},
      signal: controller.signal,
      toolUseId: 'tool-3',
    });

    const returned = bridge.respond({ sessionId: 'sess-3', permissionId: 'tool-3', allow: false });
    expect(returned).toBe(true);

    const result = await promise;
    expect(result).toEqual({
      behavior: 'deny',
      message: 'User denied permission',
      toolUseID: 'tool-3',
    });
    expect(events[2]).toMatchObject({
      type: 'permission.resolved',
      sessionId: 'sess-3',
      payload: { permissionId: 'tool-3', allow: false },
    });
  });

  it('ignores a second respond for an already-settled permissionId (single settle), with no extra events', async () => {
    const { events, bridge } = createBridge();
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-4',
      toolName: 'Bash',
      input: {},
      signal: controller.signal,
      toolUseId: 'tool-4',
    });

    const first = bridge.respond({ sessionId: 'sess-4', permissionId: 'tool-4', allow: true });
    await promise;
    const eventCountAfterFirst = events.length;

    const second = bridge.respond({ sessionId: 'sess-4', permissionId: 'tool-4', allow: false });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(events).toHaveLength(eventCountAfterFirst);
  });

  it('returns false for an unknown permissionId, and false without settling for a wrong sessionId', async () => {
    const { bridge } = createBridge();
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-5',
      toolName: 'Bash',
      input: {},
      signal: controller.signal,
      toolUseId: 'tool-5',
    });

    expect(
      bridge.respond({ sessionId: 'sess-5', permissionId: 'does-not-exist', allow: true })
    ).toBe(false);
    expect(
      bridge.respond({ sessionId: 'wrong-session', permissionId: 'tool-5', allow: true })
    ).toBe(false);
    // Wrong-session respond must not have settled the pending entry.
    expect(bridge.hasPending('sess-5')).toBe(true);

    expect(bridge.respond({ sessionId: 'sess-5', permissionId: 'tool-5', allow: true })).toBe(true);
    const result = await promise;
    expect(result).toEqual({ behavior: 'allow', toolUseID: 'tool-5' });
  });

  it('resolves immediately with deny+interrupt for an already-aborted signal, emitting no events', async () => {
    const { events, bridge } = createBridge();
    const controller = new AbortController();
    controller.abort();

    const result = await bridge.request({
      sessionId: 'sess-6',
      toolName: 'Bash',
      input: {},
      signal: controller.signal,
      toolUseId: 'tool-6',
    });

    expect(result).toEqual({
      behavior: 'deny',
      message: 'Session aborted before permission prompt',
      interrupt: true,
      toolUseID: 'tool-6',
    });
    expect(events).toHaveLength(0);
    expect(bridge.hasPending()).toBe(false);
  });

  it('denies a duplicate request for a permissionId that is already pending, with no extra events', async () => {
    const { events, bridge } = createBridge();
    const controller = new AbortController();
    const firstPromise = bridge.request({
      sessionId: 'sess-7',
      toolName: 'Bash',
      input: {},
      signal: controller.signal,
      toolUseId: 'tool-7',
    });
    const eventsAfterFirst = events.length;

    const secondController = new AbortController();
    const secondResult = await bridge.request({
      sessionId: 'sess-7',
      toolName: 'Bash',
      input: {},
      signal: secondController.signal,
      toolUseId: 'tool-7',
    });

    expect(secondResult).toEqual({
      behavior: 'deny',
      message: 'Duplicate permission request',
      toolUseID: 'tool-7',
    });
    expect(events).toHaveLength(eventsAfterFirst);

    bridge.respond({ sessionId: 'sess-7', permissionId: 'tool-7', allow: true });
    await firstPromise;
  });

  it('settles with deny+interrupt on abort while pending, without emitting session.status running', async () => {
    const { events, bridge } = createBridge();
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-8',
      toolName: 'Bash',
      input: {},
      signal: controller.signal,
      toolUseId: 'tool-8',
    });
    const eventsBeforeAbort = events.length;

    controller.abort();
    const result = await promise;

    expect(result).toEqual({
      behavior: 'deny',
      message: 'Session stopped while waiting for permission',
      interrupt: true,
      toolUseID: 'tool-8',
    });

    const newEvents = events.slice(eventsBeforeAbort);
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0]).toMatchObject({
      type: 'permission.resolved',
      sessionId: 'sess-8',
      payload: { permissionId: 'tool-8', allow: false },
    });
    expect(bridge.hasPending('sess-8')).toBe(false);
  });

  it('emits nothing extra when the signal aborts after respond already settled the promise', async () => {
    const { events, bridge } = createBridge();
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-9',
      toolName: 'Bash',
      input: {},
      signal: controller.signal,
      toolUseId: 'tool-9',
    });

    bridge.respond({ sessionId: 'sess-9', permissionId: 'tool-9', allow: true });
    await promise;
    const eventsAfterSettle = events.length;

    controller.abort();

    expect(events).toHaveLength(eventsAfterSettle);
  });
});

describe('PermissionBridge — concurrent same-session park (design spec §2.2)', () => {
  it('B1: two concurrent park in one session — respond(A) only settles A; B stays pending; hasPending stays true', async () => {
    const { bridge } = createBridge();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const promiseA = bridge.request({
      sessionId: 'sess-14',
      toolName: 'Read',
      input: {},
      signal: controllerA.signal,
      toolUseId: 'tool-14a',
    });
    const promiseB = bridge.request({
      sessionId: 'sess-14',
      toolName: 'Read',
      input: {},
      signal: controllerB.signal,
      toolUseId: 'tool-14b',
    });

    let bSettled = false;
    void promiseB.then(() => {
      bSettled = true;
    });

    bridge.respond({ sessionId: 'sess-14', permissionId: 'tool-14a', allow: true });
    const resultA = await promiseA;

    expect(resultA).toEqual({ behavior: 'allow', toolUseID: 'tool-14a' });
    expect(bSettled).toBe(false);
    expect(bridge.hasPending('sess-14')).toBe(true);

    bridge.respond({ sessionId: 'sess-14', permissionId: 'tool-14b', allow: true });
    await promiseB;
  });

  it('B2: B still pending when A settles — no running yet; respond(B) then emits running exactly once (primary case)', async () => {
    const { events, bridge } = createBridge();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const promiseA = bridge.request({
      sessionId: 'sess-15',
      toolName: 'Read',
      input: {},
      signal: controllerA.signal,
      toolUseId: 'tool-15a',
    });
    const promiseB = bridge.request({
      sessionId: 'sess-15',
      toolName: 'Read',
      input: {},
      signal: controllerB.signal,
      toolUseId: 'tool-15b',
    });
    const eventsBeforeRespondA = events.length;

    bridge.respond({ sessionId: 'sess-15', permissionId: 'tool-15a', allow: true });
    await promiseA;

    const newEventsAfterA = events.slice(eventsBeforeRespondA);
    expect(newEventsAfterA).toHaveLength(1);
    expect(newEventsAfterA[0]).toMatchObject({
      type: 'permission.resolved',
      sessionId: 'sess-15',
      payload: { permissionId: 'tool-15a', allow: true },
    });
    expect(newEventsAfterA.some((event) => event.type === 'session.status')).toBe(false);

    const eventsBeforeRespondB = events.length;
    bridge.respond({ sessionId: 'sess-15', permissionId: 'tool-15b', allow: true });
    await promiseB;

    const newEventsAfterB = events.slice(eventsBeforeRespondB);
    const runningEvents = newEventsAfterB.filter(
      (event) =>
        event.type === 'session.status' &&
        (event as { payload?: { status?: string } }).payload?.status === 'running'
    );
    expect(runningEvents).toHaveLength(1);
  });

  it('B3: a (sessionId, permissionId) mismatch with both entries parked settles neither and emits nothing', async () => {
    const { events, bridge } = createBridge();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const promiseA = bridge.request({
      sessionId: 'sess-16',
      toolName: 'Read',
      input: {},
      signal: controllerA.signal,
      toolUseId: 'tool-16a',
    });
    const promiseB = bridge.request({
      sessionId: 'sess-16',
      toolName: 'Read',
      input: {},
      signal: controllerB.signal,
      toolUseId: 'tool-16b',
    });
    const eventsBefore = events.length;

    // tool-16a exists but under the wrong sessionId.
    const returned = bridge.respond({
      sessionId: 'wrong-session',
      permissionId: 'tool-16a',
      allow: true,
    });

    expect(returned).toBe(false);
    expect(events).toHaveLength(eventsBefore);
    expect(bridge.hasPending('sess-16')).toBe(true);

    // Both entries must still be genuinely present — a false positive on the
    // mismatch check would show up here as `respond` returning false because
    // the entry was already (wrongly) settled.
    const stillA = bridge.respond({ sessionId: 'sess-16', permissionId: 'tool-16a', allow: true });
    const stillB = bridge.respond({ sessionId: 'sess-16', permissionId: 'tool-16b', allow: true });
    expect(stillA).toBe(true);
    expect(stillB).toBe(true);
    await Promise.all([promiseA, promiseB]);
  });

  it('B4: rejectSession with two parked in one session settles both, each with its own toolUseID', async () => {
    const { bridge } = createBridge();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const promiseA = bridge.request({
      sessionId: 'sess-17',
      toolName: 'Read',
      input: {},
      signal: controllerA.signal,
      toolUseId: 'tool-17a',
    });
    const promiseB = bridge.request({
      sessionId: 'sess-17',
      toolName: 'Read',
      input: {},
      signal: controllerB.signal,
      toolUseId: 'tool-17b',
    });

    bridge.rejectSession('sess-17', 'Session stopped');
    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

    expect(resultA).toEqual({
      behavior: 'deny',
      message: 'Session stopped',
      interrupt: true,
      toolUseID: 'tool-17a',
    });
    expect(resultB).toEqual({
      behavior: 'deny',
      message: 'Session stopped',
      interrupt: true,
      toolUseID: 'tool-17b',
    });
    expect(bridge.hasPending('sess-17')).toBe(false);
  });
});

describe('PermissionBridge.rejectSession / rejectAll', () => {
  it('rejectSession settles only the pending prompts for that session', async () => {
    const { bridge } = createBridge();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const promiseA = bridge.request({
      sessionId: 'A',
      toolName: 'Bash',
      input: {},
      signal: controllerA.signal,
      toolUseId: 'tool-a',
    });
    const promiseB = bridge.request({
      sessionId: 'B',
      toolName: 'Bash',
      input: {},
      signal: controllerB.signal,
      toolUseId: 'tool-b',
    });

    bridge.rejectSession('A');

    const resultA = await promiseA;
    expect(resultA).toEqual({
      behavior: 'deny',
      message: 'Session closed',
      interrupt: true,
      toolUseID: 'tool-a',
    });
    expect(bridge.hasPending('A')).toBe(false);
    expect(bridge.hasPending('B')).toBe(true);

    bridge.respond({ sessionId: 'B', permissionId: 'tool-b', allow: true });
    await promiseB;
  });

  it('rejectAll settles every pending prompt across sessions', async () => {
    const { bridge } = createBridge();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const promiseA = bridge.request({
      sessionId: 'A',
      toolName: 'Bash',
      input: {},
      signal: controllerA.signal,
      toolUseId: 'tool-a',
    });
    const promiseB = bridge.request({
      sessionId: 'B',
      toolName: 'Bash',
      input: {},
      signal: controllerB.signal,
      toolUseId: 'tool-b',
    });

    bridge.rejectAll();

    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
    expect(resultA).toMatchObject({
      behavior: 'deny',
      message: 'Host shutting down',
      interrupt: true,
    });
    expect(resultB).toMatchObject({
      behavior: 'deny',
      message: 'Host shutting down',
      interrupt: true,
    });
    expect(bridge.hasPending()).toBe(false);
  });
});

describe('PermissionBridge — peer pending (S8, round-2 iteration-3 review)', () => {
  it('emits waiting_question (not running) when the sibling bridge still holds a pending item for this session', async () => {
    const events: Record<string, unknown>[] = [];
    const bridge = new PermissionBridge(
      (e) => events.push(e),
      () => undefined,
      (sessionId) => sessionId === 'sess-peer-1' // sibling still pending on this session
    );
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-peer-1',
      toolName: 'Bash',
      input: {},
      signal: controller.signal,
      toolUseId: 'tool-peer-1',
    });

    bridge.respond({ sessionId: 'sess-peer-1', permissionId: 'tool-peer-1', allow: true });
    await promise;

    const statusEvents = events.filter((e) => e.type === 'session.status');
    expect(statusEvents.at(-1)).toMatchObject({ payload: { status: 'waiting_question' } });
    expect(statusEvents.some((e) => (e.payload as { status?: string }).status === 'running')).toBe(
      false
    );
  });

  it('emits running when the sibling bridge has nothing pending for this session', async () => {
    const events: Record<string, unknown>[] = [];
    const bridge = new PermissionBridge(
      (e) => events.push(e),
      () => undefined,
      () => false
    );
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-peer-2',
      toolName: 'Bash',
      input: {},
      signal: controller.signal,
      toolUseId: 'tool-peer-2',
    });

    bridge.respond({ sessionId: 'sess-peer-2', permissionId: 'tool-peer-2', allow: true });
    await promise;

    const statusEvents = events.filter((e) => e.type === 'session.status');
    expect(statusEvents.at(-1)).toMatchObject({ payload: { status: 'running' } });
  });

  it('a peer pending on a DIFFERENT session must not suppress running here', async () => {
    const events: Record<string, unknown>[] = [];
    const bridge = new PermissionBridge(
      (e) => events.push(e),
      () => undefined,
      (sessionId) => sessionId === 'sess-other' // pending, but on a different session
    );
    const controller = new AbortController();
    const promise = bridge.request({
      sessionId: 'sess-peer-3',
      toolName: 'Bash',
      input: {},
      signal: controller.signal,
      toolUseId: 'tool-peer-3',
    });

    bridge.respond({ sessionId: 'sess-peer-3', permissionId: 'tool-peer-3', allow: true });
    await promise;

    const statusEvents = events.filter((e) => e.type === 'session.status');
    expect(statusEvents.at(-1)).toMatchObject({ payload: { status: 'running' } });
  });
});

describe('PermissionBridge.createCanUseTool', () => {
  it('forwards toolName/input/signal/toolUseID and falls back to title for description', async () => {
    const { events, bridge } = createBridge();
    const canUseTool = bridge.createCanUseTool('sess-11');
    const controller = new AbortController();

    const promise = canUseTool(
      'Bash',
      { command: 'ls' },
      { signal: controller.signal, toolUseID: 'tool-11', title: 'Fallback Title' }
    );

    expect(events[0]).toMatchObject({
      type: 'permission.requested',
      sessionId: 'sess-11',
      payload: {
        permissionId: 'tool-11',
        toolName: 'Bash',
        description: 'Fallback Title',
        input: { command: 'ls' },
      },
    });

    bridge.respond({ sessionId: 'sess-11', permissionId: 'tool-11', allow: true });
    const result = await promise;
    expect(result).toEqual({ behavior: 'allow', toolUseID: 'tool-11' });
  });

  it('prefers options.description over title/displayName', async () => {
    const { events, bridge } = createBridge();
    const canUseTool = bridge.createCanUseTool('sess-12');
    const controller = new AbortController();

    const promise = canUseTool(
      'Read',
      {},
      {
        signal: controller.signal,
        toolUseID: 'tool-12',
        title: 'Ignored Title',
        displayName: 'Ignored Display',
        description: 'Preferred Description',
      }
    );

    expect(events[0]).toMatchObject({
      payload: { description: 'Preferred Description' },
    });

    bridge.respond({ sessionId: 'sess-12', permissionId: 'tool-12', allow: true });
    await promise;
  });

  it('falls back to displayName for description when neither description nor title is present', async () => {
    const { events, bridge } = createBridge();
    const canUseTool = bridge.createCanUseTool('sess-13');
    const controller = new AbortController();

    const promise = canUseTool(
      'Bash',
      { command: 'ls' },
      { signal: controller.signal, toolUseID: 'tool-13', displayName: 'Fallback Display' }
    );

    expect(events[0]).toMatchObject({
      type: 'permission.requested',
      sessionId: 'sess-13',
      payload: { description: 'Fallback Display' },
    });

    bridge.respond({ sessionId: 'sess-13', permissionId: 'tool-13', allow: true });
    await promise;
  });
});
