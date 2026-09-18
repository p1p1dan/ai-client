/**
 * The approval gate serves one card at a time.
 *
 * A model that asks for five tools in one message produced five gates at once,
 * and every one of them raised its card AND started its own 120-second deadline
 * at the same instant. The user answers the top card; cards four and five are
 * counting down behind it and can be auto-denied before they are ever seen —
 * a refusal nobody made, on a call nobody read.
 *
 * So the gate is a FIFO queue now: the holder is the only request that has
 * announced itself, called `approve` or started a clock. What these cases pin
 * down is mostly what does NOT happen — no second card, no second timer, no
 * request stuck behind one that was already cancelled, and no auto-allowed read
 * dragged into the line behind a write that needs a human.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import type {
  PermissionActivityRecord,
  PermissionConfig,
  RuntimePermissionsService,
  ToolPermissionRequest,
} from '../plugins/permissions/index.ts';
import { createPermissionPrompt } from '../worker/permissionPrompt.ts';

type Card = Extract<RuntimeEventDraft, { type: 'permission.requested' }>;
type Resolution = Extract<RuntimeEventDraft, { type: 'permission.resolved' }>;

let dir: string;
const runtimes: RuntimeHandle[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-permission-queue-'));
});
afterEach(async () => {
  vi.useRealTimers();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

/** Let every already-resolved continuation run. Not a wait for anything real. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A real graph, gated on `ask`, answering through the approver given. */
async function engine(
  approve: NonNullable<PermissionConfig['approve']>,
  timeoutMs?: number
): Promise<{
  runtime: RuntimeHandle;
  permissions: RuntimePermissionsService;
  activity: PermissionActivityRecord[];
}> {
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  faux.setResponses([fauxAssistantMessage('ok')]);
  const activity: PermissionActivityRecord[] = [];
  const runtime = await createRuntime({
    env: {},
    traceDir: null,
    providers: [faux.provider],
    tools: { cwd: dir },
    permissions: { gear: 'ask', approve, timeoutMs },
  });
  runtimes.push(runtime);
  runtime.ctx.runtimePermissions.onActivity((record) => activity.push(record));
  return { runtime, activity, permissions: runtime.ctx.runtimePermissions };
}

/**
 * The production pair: the worker's card as the gate's approver, so what the
 * renderer would see is exactly what these cases read.
 */
async function cardGate(timeoutMs?: number) {
  const events: RuntimeEventDraft[] = [];
  const prompt = createPermissionPrompt({
    sessionId: 'logical',
    cwd: dir,
    emit: (event) => events.push(event),
    timeoutMs,
  });
  const rest = await engine(prompt.approve, timeoutMs);
  const cards = () =>
    events.filter((event): event is Card => event.type === 'permission.requested');
  const shown = () => cards().map((card) => card.payload.permissionId);
  const resolutions = () =>
    events.filter((event): event is Resolution => event.type === 'permission.resolved');
  return { ...rest, events, prompt, cards, shown, resolutions };
}

const request = (id: string, tool = 'write'): ToolPermissionRequest => ({
  tool,
  toolCallId: id,
  path: join(dir, `${id}.txt`),
});

/** One gated call, as a promise that reports rather than throws. */
const ask = (permissions: RuntimePermissionsService, id: string, signal?: AbortSignal) =>
  permissions.authorize(request(id), signal).then(
    () => 'allowed',
    (error: unknown) => (error as { code?: string }).code ?? 'failed'
  );

it('raises one card at a time, however many calls arrive together', async () => {
  const { prompt, shown, permissions } = await cardGate();
  const pending = ['a', 'b', 'c'].map((id) => ask(permissions, id));
  await settle();

  // The whole point: two of the three are in line, having emitted nothing.
  expect(shown()).toEqual(['a']);

  // ...which is also the measurement that rules out counting the queue in the
  // renderer. Its pending list is built from these events, so while card `a` is
  // up the list holds exactly one entry — it cannot know two more are waiting,
  // and a card drawn from it could only ever say "1 of 1".
  expect(shown()).toHaveLength(1);

  expect(prompt.respond({ permissionId: 'a', decision: 'allow' })).toBe(true);
  await settle();
  expect(shown()).toEqual(['a', 'b']);

  expect(prompt.respond({ permissionId: 'b', decision: 'allow' })).toBe(true);
  await settle();
  expect(shown()).toEqual(['a', 'b', 'c']);

  prompt.respond({ permissionId: 'c', decision: 'deny' });
  expect(await Promise.all(pending)).toEqual(['allowed', 'allowed', 'tool_denied']);
});

it('serves the queue first come, first served', async () => {
  const { prompt, cards, permissions } = await cardGate();
  const ids = ['a', 'b', 'c', 'd'];
  const answered: string[] = [];
  const pending = ids.map((id) =>
    ask(permissions, id).then((outcome) => answered.push(id) && outcome)
  );

  for (const id of ids) {
    await settle();
    // Both halves matter: the card on screen is this one, and the parked
    // approver keyed to this id is the one an answer reaches.
    expect(cards().at(-1)?.payload.permissionId).toBe(id);
    expect(prompt.respond({ permissionId: id, decision: 'allow' })).toBe(true);
  }
  await Promise.all(pending);
  expect(answered).toEqual(ids);
});

it("starts a queued request's deadline when its card appears, not when it was made", async () => {
  // The defect this queue exists for. Under the old code both deadlines began
  // together, so `b` was denied 119 seconds before anyone could have seen it.
  const { prompt, shown, resolutions, permissions } = await cardGate(120_000);
  vi.useFakeTimers();

  const first = ask(permissions, 'a');
  const second = ask(permissions, 'b');
  await vi.advanceTimersByTimeAsync(1);
  expect(shown()).toEqual(['a']);

  // Nearly the whole budget passes while `b` waits its turn.
  await vi.advanceTimersByTimeAsync(119_000);
  expect(shown()).toEqual(['a']);
  expect(resolutions()).toHaveLength(0);

  expect(prompt.respond({ permissionId: 'a', decision: 'allow' })).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(await first).toBe('allowed');
  expect(shown()).toEqual(['a', 'b']);

  // 238 seconds after `b` was made, and 119 after its card went up: still
  // answerable, because the clock it runs on is its own.
  await vi.advanceTimersByTimeAsync(119_000);
  expect(resolutions().some((event) => event.payload.permissionId === 'b')).toBe(false);

  // And it does still expire — one budget after being shown, not after being made.
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await second).toBe('tool_denied');
  expect(resolutions().at(-1)?.payload).toMatchObject({
    permissionId: 'b',
    allow: false,
    autoReason: 'timed_out',
  });
});

it('drops a request cancelled while it waited, with no card and no hold-up behind it', async () => {
  const { prompt, shown, activity, permissions } = await cardGate();
  const stop = new AbortController();
  const first = ask(permissions, 'a');
  const second = ask(permissions, 'b', stop.signal);
  const third = ask(permissions, 'c');
  await settle();
  expect(shown()).toEqual(['a']);

  stop.abort();
  expect(await second).toBe('tool_denied');
  // It left the line where it stood: no card was ever raised for it, and the
  // audit row says the turn was stopped rather than that anyone refused.
  expect(shown()).toEqual(['a']);
  expect(
    activity.find((record) => record.phase === 'decision' && record.request.toolCallId === 'b')
  ).toMatchObject({ decision: 'deny', source: 'cancelled' });

  prompt.respond({ permissionId: 'a', decision: 'allow' });
  await settle();
  // `c` moved up into the freed slot instead of queueing behind a dead entry.
  expect(shown()).toEqual(['a', 'c']);
  prompt.respond({ permissionId: 'c', decision: 'allow' });
  expect(await Promise.all([first, third])).toEqual(['allowed', 'allowed']);
});

it('hands the gate on when the approver itself throws', async () => {
  // The gate is held across a call into host code. A throw there that skipped
  // the release would stop every later approval in the session, silently.
  const asked: string[] = [];
  const { permissions } = await engine(async (incoming) => {
    asked.push(incoming.toolCallId);
    if (incoming.toolCallId === 'a') throw new Error('approval UI crashed');
    return 'allow-once';
  });
  const first = ask(permissions, 'a');
  const second = ask(permissions, 'b');

  expect(await first).toBe('failed');
  expect(await second).toBe('allowed');
  expect(asked).toEqual(['a', 'b']);
});

it('never queues a call the policy decides on its own', async () => {
  // Reads resolve inside `evaluate` and must not be dragged into the line
  // behind a write that needs a human — the whole turn would serialize on it.
  const asked: string[] = [];
  let answer: ((decision: 'allow-once') => void) | undefined;
  const { permissions } = await engine((incoming) => {
    asked.push(incoming.toolCallId);
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  const parked = ask(permissions, 'w');
  await settle();
  expect(asked).toEqual(['w']);

  await expect(
    Promise.all([
      permissions.authorize(request('r1', 'read')),
      permissions.authorize(request('r2', 'read')),
    ])
  ).resolves.toEqual([undefined, undefined]);
  // They went through while the card was still up, and the approver never
  // heard about them.
  expect(asked).toEqual(['w']);

  answer?.('allow-once');
  expect(await parked).toBe('allowed');
});

it('lets the next request up when a drain arrives without an abort', async () => {
  // `drain` can only reach what has already been ASKED: the queue behind the
  // card never called `approve`, so the prompt's pending table has never heard
  // of it. Both production callers abort in the same breath — `dispose` stops
  // the turn one line later, `reload` only runs while the worker is idle — so
  // this is a contract note for the next caller, not a live path. Meaning it:
  // draining is "answer the card", not "cancel the burst".
  const { prompt, shown, permissions } = await cardGate();
  const pending = ['a', 'b'].map((id) => ask(permissions, id));
  await settle();
  expect(shown()).toEqual(['a']);

  prompt.drain('session_closed');
  await settle();
  expect(shown()).toEqual(['a', 'b']);

  prompt.drain('session_closed');
  expect(await Promise.all(pending)).toEqual(['tool_denied', 'tool_denied']);
});

it('wakes everything queued when the graph is torn down', async () => {
  const { runtime, shown, permissions } = await cardGate();
  const pending = ['a', 'b', 'c'].map((id) => ask(permissions, id));
  await settle();
  expect(shown()).toEqual(['a']);

  await runtime.dispose();

  // Nothing is left hanging, and nothing was put on screen on the way out: a
  // queued request fails where it stands rather than flashing a card for a
  // session that no longer exists.
  expect(await Promise.all(pending)).toEqual(['tool_denied', 'tool_denied', 'tool_denied']);
  expect(shown()).toEqual(['a']);
});

it('tells each card where it sits in a queue that is still growing', async () => {
  const { prompt, cards, permissions } = await cardGate();
  const pending = ['a', 'b', 'c'].map((id) => ask(permissions, id));
  await settle();
  expect(cards().at(-1)?.payload).toMatchObject({
    permissionId: 'a',
    queuePosition: 1,
    queueDepth: 3,
  });

  // Two more calls from the same turn land while the user is still reading.
  pending.push(ask(permissions, 'd'), ask(permissions, 'e'));
  await settle();
  prompt.respond({ permissionId: 'a', decision: 'allow' });
  await settle();
  // The total is larger on this card than it was on the last one. That is the
  // documented semantic — a snapshot of what the gate knows, not a promise.
  expect(cards().at(-1)?.payload).toMatchObject({
    permissionId: 'b',
    queuePosition: 2,
    queueDepth: 5,
  });

  for (const id of ['b', 'c', 'd', 'e']) {
    prompt.respond({ permissionId: id, decision: 'allow' });
    await settle();
  }
  expect(await Promise.all(pending)).toEqual(Array(5).fill('allowed'));

  // The burst is over, so counting starts again rather than carrying on at 6.
  const alone = ask(permissions, 'z');
  await settle();
  expect(cards().at(-1)?.payload).toMatchObject({
    permissionId: 'z',
    queuePosition: 1,
    queueDepth: 1,
  });
  prompt.respond({ permissionId: 'z', decision: 'allow' });
  expect(await alone).toBe('allowed');
});

it('drops a queued request when the permission settings change under it', async () => {
  // Same rule the holder has always followed: a request evaluated under the
  // old posture is not answered under the new one. Doing it before the card
  // means the user is never asked a question that was already void.
  const { prompt, shown, activity, permissions } = await cardGate();
  const first = ask(permissions, 'a');
  const second = ask(permissions, 'b');
  await settle();
  expect(shown()).toEqual(['a']);

  permissions.configure({ gear: 'auto' });
  prompt.respond({ permissionId: 'a', decision: 'allow' });

  expect(await second).toBe('tool_denied');
  expect(await first).toBe('tool_denied');
  expect(shown()).toEqual(['a']);
  expect(
    activity.find((record) => record.phase === 'decision' && record.request.toolCallId === 'b')
  ).toMatchObject({ decision: 'deny', source: 'cancelled' });
});
