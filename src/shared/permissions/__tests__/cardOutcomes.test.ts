import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '../../types/runtimeEvents.ts';
import { permissionActivityEvent } from '../activity.ts';
import { createPermissionPrompt } from '../cardEmitter.ts';
import {
  PERMISSION_TIMEOUT_REASON,
  type PermissionActivityRecord,
  type PermissionGate,
} from '../gate.ts';
import { buildGate } from './gateHarness.ts';

/**
 * Moved from src/runtime/__tests__/permissions.test.ts (dsh-rebase P1-12 step 2):
 * permissions-08 ∥ rpc-projector-18 — what the gate says when nobody answers,
 * and T023 — the card describes the call with an id, never a sentence.
 *
 * The 120-second deadline is enforced by aborting the same signal a cancel
 * aborts, so "you ran out of time" and "you pressed stop" once reached every
 * surface as the identical event. The gate is built from the pure library the
 * way the runtime's bootstrap (and the DSH bridge) builds it; the card is the
 * shared `createPermissionPrompt`, the gate's `approve`.
 */

let dir: string;
const gates: PermissionGate[] = [];
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'perm-card-outcomes-')));
});
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.dispose();
  await rm(dir, { recursive: true, force: true });
});

/** The real pair: the card as the gate's `approve`, so one deadline drives both records. */
async function gate(timeoutMs: number) {
  const events: RuntimeEventDraft[] = [];
  const activity: PermissionActivityRecord[] = [];
  const prompt = createPermissionPrompt({
    sessionId: 'logical',
    cwd: dir,
    emit: (event) => events.push(event),
    timeoutMs,
  });
  const built = await buildGate(dir, { gear: 'ask', approve: prompt.approve, timeoutMs });
  gates.push(built.gate);
  built.gate.onActivity((record) => activity.push(record));
  return { events, activity, permissions: built.gate };
}

const REQUEST = (path: string) => ({ tool: 'write', toolCallId: 'call-1', path });

it('records a countdown that ran out as a timeout, on the card and in the audit row', async () => {
  const { events, activity, permissions } = await gate(25);
  await expect(permissions.authorize(REQUEST(join(dir, 'note.txt')))).rejects.toMatchObject({
    code: 'tool_denied',
  });

  // The card: `timed_out`, which the block has always been able to draw.
  expect(events.map((event) => event.type)).toEqual([
    'permission.requested',
    'permission.resolved',
  ]);
  expect(events[1].payload).toMatchObject({ allow: false, autoReason: 'timed_out' });

  // The audit row: its own source, mapped to its own resolution.
  const decision = activity.find((record) => record.phase === 'decision');
  expect(decision).toMatchObject({ decision: 'deny', source: 'timed-out' });
  expect(
    permissionActivityEvent('logical', decision as PermissionActivityRecord).payload
  ).toMatchObject({
    result: 'deny',
    resolution: 'timed_out',
  });
});

/**
 * chat-tool-06 — the audit row's `value` is "what was evaluated", and for MCP
 * and skills that is NOT the path.
 */
it.each([
  [
    { tool: 'mcp__github__create_issue', path: '/repo', policyValue: 'github:create_issue' },
    'github:create_issue',
  ],
  [
    { tool: 'skill', path: '/repo/.claude/skills/plan-tree/SKILL.md', policyValue: 'plan-tree' },
    'plan-tree',
  ],
  // Unchanged where the gate really does match on the command or the path.
  [{ tool: 'bash', path: '/repo', command: 'ls -la' }, 'ls -la'],
  [{ tool: 'read', path: '/repo/src/a.ts' }, '/repo/src/a.ts'],
])('records the value the gate matched on, not the path it was handed', (request, value) => {
  const event = permissionActivityEvent('logical', {
    phase: 'decision',
    request: { toolCallId: 't1', ...request },
    decision: 'allow',
    source: 'policy',
    mode: 'agent',
    gear: 'ask',
  } as PermissionActivityRecord);
  expect(event.payload).toMatchObject({ value });
});

it('still calls a cancelled request cancelled', async () => {
  // The other arm of the same abort: a stop is a thing the user did.
  const { events, activity, permissions } = await gate(10_000);
  const controller = new AbortController();
  const pending = permissions.authorize(REQUEST(join(dir, 'note.txt')), controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'tool_denied' });
  expect(events[1].payload).toMatchObject({ autoReason: 'aborted' });
  expect(activity.find((record) => record.phase === 'decision')).toMatchObject({
    source: 'cancelled',
  });
});

it('reads the reason off the signal even when the card is asked after it aborted', () => {
  // An already-aborted signal takes the early-return path, which once had its
  // own hard-coded `aborted`.
  const events: RuntimeEventDraft[] = [];
  const prompt = createPermissionPrompt({
    sessionId: 'logical',
    cwd: dir,
    emit: (e) => events.push(e),
  });
  const controller = new AbortController();
  controller.abort(PERMISSION_TIMEOUT_REASON);
  return prompt.approve(REQUEST(join(dir, 'note.txt')), controller.signal).then((decision) => {
    expect(decision).toBe('deny');
    expect(events.at(-1)?.payload).toMatchObject({ autoReason: 'timed_out' });
  });
});

it('sends an action id for each gated tool and no prose of its own', async () => {
  const seen: Record<string, unknown> = {};
  for (const [tool, expected] of [
    ['bash', 'run_command'],
    ['write', 'write_file'],
    ['edit', 'edit_file'],
    ['read', 'read_file'],
  ] as const) {
    const events: RuntimeEventDraft[] = [];
    const prompt = createPermissionPrompt({
      sessionId: 'logical',
      cwd: dir,
      emit: (event) => events.push(event),
    });
    const controller = new AbortController();
    const pending = prompt.approve(
      { tool, toolCallId: `call-${tool}`, path: join(dir, 'note.txt'), command: 'ls' },
      controller.signal
    );
    const payload = events[0]?.payload as { action?: string; description?: string };
    seen[tool] = payload.action;
    expect(payload.action).toBe(expected);
    // `description` is reserved for prose the ASKING AGENT wrote.
    expect(payload.description).toBeUndefined();
    controller.abort();
    await pending;
  }
  expect(seen).toEqual({
    bash: 'run_command',
    write: 'write_file',
    edit: 'edit_file',
    read: 'read_file',
  });
});

it('sends no action at all for a tool it has no sentence for', async () => {
  const events: RuntimeEventDraft[] = [];
  const prompt = createPermissionPrompt({
    sessionId: 'logical',
    cwd: dir,
    emit: (event) => events.push(event),
  });
  const controller = new AbortController();
  const pending = prompt.approve(
    { tool: 'mcp__notion__search', toolCallId: 'call-x', path: join(dir, 'note.txt') },
    controller.signal
  );
  expect(events[0]?.payload).not.toHaveProperty('action');
  controller.abort();
  await pending;
});
