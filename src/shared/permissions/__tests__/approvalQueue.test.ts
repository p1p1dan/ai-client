import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEventDraft } from '../../types/runtimeEvents.ts';
import type { PermissionGear } from '../../types/runtimePermission.ts';
import { createPermissionPrompt } from '../cardEmitter.ts';
import type {
  PermissionActivityRecord,
  PermissionConfig,
  PermissionGate,
  ToolPermissionRequest,
} from '../gate.ts';
import { buildGate, outcome } from './gateHarness.ts';

/**
 * Moved from src/runtime/__tests__/permissionQueue.test.ts (dsh-rebase P1-12
 * step 2): the approval gate serves one card at a time.
 *
 * The gate is a FIFO queue: the holder is the only request that has announced
 * itself, called `approve` or started a clock. What these cases pin down is
 * mostly what does NOT happen — no second card, no second timer, no request
 * stuck behind one that was already cancelled, and no auto-allowed read
 * dragged into the line behind a write that needs a human.
 *
 * The runtime's "graph torn down" is the gate's own `dispose`, which is what
 * the runtime's teardown called and what the DSH bridge calls when a session
 * closes.
 */

type Card = Extract<RuntimeEventDraft, { type: 'permission.requested' }>;
type Resolution = Extract<RuntimeEventDraft, { type: 'permission.resolved' }>;

let dir: string;
const gates: PermissionGate[] = [];
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'perm-queue-')));
});
afterEach(async () => {
  vi.useRealTimers();
  for (const gate of gates.splice(0)) gate.dispose();
  await rm(dir, { recursive: true, force: true });
});

/** Let every already-resolved continuation run. Not a wait for anything real. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A real gate on `ask`, answering through the approver given. */
async function engine(
  approve: NonNullable<PermissionConfig['approve']>,
  timeoutMs?: number,
  options: { gear?: PermissionGear; autoAllow?: PermissionConfig['autoAllow'] } = {}
): Promise<{ permissions: PermissionGate; activity: PermissionActivityRecord[] }> {
  const activity: PermissionActivityRecord[] = [];
  const built = await buildGate(dir, {
    gear: options.gear ?? 'ask',
    approve,
    timeoutMs,
    ...(options.autoAllow ? { autoAllow: options.autoAllow } : {}),
  });
  gates.push(built.gate);
  built.gate.onActivity((record) => activity.push(record));
  return { activity, permissions: built.gate };
}

/** The production pair: the card as the gate's approver, and its `autoAllow`. */
async function cardGate(timeoutMs?: number, gear?: PermissionGear) {
  const events: RuntimeEventDraft[] = [];
  const prompt = createPermissionPrompt({
    sessionId: 'logical',
    cwd: dir,
    emit: (event) => events.push(event),
    timeoutMs,
  });
  const rest = await engine(prompt.approve, timeoutMs, {
    ...(gear ? { gear } : {}),
    autoAllow: prompt.autoAllow,
  });
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
const ask = (permissions: PermissionGate, id: string, signal?: AbortSignal) =>
  outcome(permissions.authorize(request(id), signal));

it('raises one card at a time, however many calls arrive together', async () => {
  const { prompt, shown, permissions } = await cardGate();
  const pending = ['a', 'b', 'c'].map((id) => ask(permissions, id));
  await settle();

  // Two of the three are in line, having emitted nothing.
  expect(shown()).toEqual(['a']);
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
    ask(permissions, id).then((result) => answered.push(id) && result)
  );

  for (const id of ids) {
    await settle();
    expect(cards().at(-1)?.payload.permissionId).toBe(id);
    expect(prompt.respond({ permissionId: id, decision: 'allow' })).toBe(true);
  }
  await Promise.all(pending);
  expect(answered).toEqual(ids);
});

it("starts a queued request's deadline when its card appears, not when it was made", async () => {
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

  // 119 seconds after its card went up: still answerable.
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
  expect(asked).toEqual(['w']);

  answer?.('allow-once');
  expect(await parked).toBe('allowed');
});

it('lets the next request up when a drain arrives without an abort', async () => {
  // `drain` reaches only what has already been ASKED: draining is "answer the
  // card", not "cancel the burst".
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

it('wakes everything queued when the gate is torn down', async () => {
  const { shown, permissions } = await cardGate();
  const pending = ['a', 'b', 'c'].map((id) => ask(permissions, id));
  await settle();
  expect(shown()).toEqual(['a']);

  permissions.dispose();

  // Nothing is left hanging, and nothing was put on screen on the way out.
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

/**
 * Moving the gear WHILE the cards are up: a widened gear ANSWERS what it would
 * not have asked, re-judges rather than waves through, leaves a narrowed
 * gear's existing questions alone, and keeps the grants.
 */
describe('a gear change while requests are waiting', () => {
  /** Outside the workspace: `ask` and `accept-edits` both stop for it. */
  const outside = (id: string): ToolPermissionRequest => ({
    tool: 'write',
    toolCallId: id,
    path: join(dir, '..', `queue-${id}.txt`),
  });

  it('answers the card on screen and the queue behind it', async () => {
    const { shown, resolutions, activity, permissions } = await cardGate();
    const pending = ['a', 'b', 'c'].map((id) => ask(permissions, id));
    await settle();
    expect(shown()).toEqual(['a']);

    permissions.setGear('auto');
    expect(await Promise.all(pending)).toEqual(['allowed', 'allowed', 'allowed']);

    // The card that was up came down as ALLOWED, in the shape a press produces.
    expect(resolutions()).toHaveLength(1);
    expect(resolutions()[0]?.payload).toEqual({
      permissionId: 'a',
      allow: true,
      decision: 'allow',
    });
    // The two behind it were re-judged as they came up, never put on screen.
    expect(shown()).toEqual(['a']);
    // Nobody pressed anything, so the audit rows must not say a person did.
    for (const id of ['a', 'b', 'c'])
      expect(
        activity.find((record) => record.phase === 'decision' && record.request.toolCallId === id)
      ).toMatchObject({ decision: 'allow', source: 'policy', gear: 'auto' });
  });

  it('keeps asking about the call the wider gear still stops for', async () => {
    // `auto` still asks about an operand the shell analysis could not resolve:
    // widening RE-JUDGES each waiting request.
    const { shown, prompt, resolutions, permissions } = await cardGate();
    const unresolved = outcome(
      permissions.authorize({
        tool: 'bash',
        toolCallId: 'cmd',
        path: dir,
        command: 'rm -rf $TARGET',
        unresolvedPaths: true,
      })
    );
    const write = ask(permissions, 'w');
    await settle();
    expect(shown()).toEqual(['cmd']);

    permissions.setGear('auto');
    await settle();
    expect(resolutions()).toHaveLength(0);
    expect(shown()).toEqual(['cmd']);

    expect(prompt.respond({ permissionId: 'cmd', decision: 'allow' })).toBe(true);
    expect(await unresolved).toBe('allowed');
    // ...while the ordinary write behind it never needed a card once the gear had moved.
    expect(await write).toBe('allowed');
    expect(shown()).toEqual(['cmd']);
  });

  it('leaves a waiting card alone when the gear narrows', async () => {
    const { shown, resolutions, prompt, permissions } = await cardGate(undefined, 'accept-edits');
    const parked = outcome(permissions.authorize(outside('n')));
    await settle();
    expect(shown()).toEqual(['n']);

    permissions.setGear('ask');
    await settle();
    // A question already asked stays asked.
    expect(resolutions()).toHaveLength(0);
    expect(shown()).toEqual(['n']);

    expect(prompt.respond({ permissionId: 'n', decision: 'deny' })).toBe(true);
    expect(await parked).toBe('tool_denied');
  });

  it('keeps the session grants a `configure` would have cleared', async () => {
    const { shown, activity, prompt, permissions } = await cardGate();
    const first = outcome(permissions.authorize(outside('g')));
    await settle();
    expect(prompt.respond({ permissionId: 'g', decision: 'allow_session' })).toBe(true);
    expect(await first).toBe('allowed');

    // `accept-edits` does not cover this path (it is outside the workspace),
    // so the grant is the only thing that can be allowing it.
    permissions.setGear('accept-edits');
    const again = outcome(permissions.authorize(outside('g')));
    expect(await again).toBe('allowed');
    expect(shown()).toEqual(['g']);
    expect(
      activity.filter((record) => record.phase === 'decision' && record.request.toolCallId === 'g')
    ).toMatchObject([
      { decision: 'allow', source: 'allow-session' },
      { decision: 'allow', source: 'session-grant' },
    ]);
  });
});
