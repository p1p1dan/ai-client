/**
 * permissions-08 ∥ rpc-projector-18 — what the gate says when nobody answers.
 *
 * The 120-second deadline is enforced by aborting the same signal a cancel
 * aborts, so before T017 "you ran out of time" and "you pressed stop" reached
 * every surface as the identical event. Two records were wrong because of it:
 * the approval card reported the countdown as `aborted`, and the audit row fell
 * back on a vocabulary that draws a timeout as a decision somebody made.
 *
 * Nothing here throws on the old behaviour — the tool call is denied either way.
 * What changes is only what the transcript can afterwards say happened, which
 * is exactly why it needed a test rather than a look.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ExtensionUiRequest } from '../../agent-host/extensionUiBridge.ts';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import { permissionActivityEvent } from '../plugins/permissions/activity.ts';
import { createRuntimeApprovalBridge } from '../plugins/permissions/bridge.ts';
import {
  PERMISSION_TIMEOUT_REASON,
  type PermissionActivityRecord,
} from '../plugins/permissions/index.ts';
import { createPermissionPrompt } from '../worker/permissionPrompt.ts';

let dir: string;
const runtimes: RuntimeHandle[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-permissions-'));
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

/**
 * The real pair: the worker's card as the gate's `approve`, so one deadline
 * drives both records. Wired by hand rather than through `NativeWorkerRuntime`
 * because the deadline has to be short enough to wait out in a test.
 */
async function gate(timeoutMs: number) {
  const events: RuntimeEventDraft[] = [];
  const activity: PermissionActivityRecord[] = [];
  const prompt = createPermissionPrompt({
    sessionId: 'logical',
    cwd: dir,
    emit: (event) => events.push(event),
    timeoutMs,
  });
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  faux.setResponses([fauxAssistantMessage('ok')]);
  const runtime = await createRuntime({
    env: {},
    traceDir: null,
    providers: [faux.provider],
    tools: { cwd: dir },
    permissions: { gear: 'ask', approve: prompt.approve, timeoutMs },
  });
  runtimes.push(runtime);
  runtime.ctx.runtimePermissions.onActivity((record) => activity.push(record));
  return { events, activity, permissions: runtime.ctx.runtimePermissions };
}

const REQUEST = (path: string) => ({ tool: 'write', toolCallId: 'call-1', path });

it('records a countdown that ran out as a timeout, on the card and in the audit row', async () => {
  const { events, activity, permissions } = await gate(25);
  await expect(permissions.authorize(REQUEST(join(dir, 'note.txt')))).rejects.toMatchObject({
    code: 'tool_denied',
  });

  // The card: `timed_out`, which the block has always been able to draw and
  // which nothing anywhere produced.
  expect(events.map((event) => event.type)).toEqual([
    'permission.requested',
    'permission.resolved',
  ]);
  expect(events[1].payload).toMatchObject({ allow: false, autoReason: 'timed_out' });

  // The audit row: its own source, mapped to its own resolution. `cancelled`
  // would say the turn was stopped and `user_denied` would say the user
  // refused; both are statements about a person who was not there.
  const decision = activity.find((record) => record.phase === 'decision');
  expect(decision).toMatchObject({ decision: 'deny', source: 'timed-out' });
  expect(permissionActivityEvent('logical', decision!).payload).toMatchObject({
    result: 'deny',
    resolution: 'timed_out',
  });
});

it('still calls a cancelled request cancelled', async () => {
  // The other arm of the same abort. A stop is a thing the user did, and the
  // two must not be reported as one.
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
  // `AbortSignal.any` forwards the reason as given, and the prompt compares it
  // by value; an already-aborted signal takes the early-return path, which had
  // its own hard-coded `aborted`.
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

/**
 * T023 — the gate describes itself with an id, never with a sentence.
 *
 * Until 2026-09-15 the four tools below emitted finished Chinese copy from a
 * worker that cannot know the window's language, so an English install read
 * its permission cards in Chinese. The wording moved to the renderer; what
 * crosses the boundary now is `action`, and the test that would have caught
 * the original defect is the CJK assertion at the bottom — the same check
 * `noHardcodedChinese.test.ts` now runs over `src/runtime` as a whole.
 */
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
    // `description` is reserved for prose the ASKING AGENT wrote. The runtime
    // filling it in is what made the card unable to tell copy from content.
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
  // Better than inventing one: the card already shows the tool's own name, and
  // a guessed sentence for an unknown tool would be a claim about behaviour
  // this runtime has not looked at.
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

/**
 * cutover-17 — the Extension UI fallback gate.
 *
 * This arm is unreachable from the app (`nativeWorkerRuntime` always supplies
 * its own `approve`, so `bootstrap`'s `??` never falls through) but it is a
 * supported way to embed the runtime, and it had two defects worth a test:
 * three hardcoded Chinese options, and an answer mapped back by comparing the
 * returned string to those literals — so any re-wording turned "allow" into
 * "deny" silently. Both assertions below fail on the old code.
 */
async function offeredChoices() {
  const requests: ExtensionUiRequest[] = [];
  const approval = createRuntimeApprovalBridge({
    runtimeId: 'bridge-1',
    onRequest: (request) => requests.push(request),
  });
  const controller = new AbortController();
  const decision = approval.approve(
    { tool: 'write', toolCallId: 'call-1', path: join(dir, 'note.txt') },
    controller.signal
  );
  // The select is emitted synchronously by `ui.select`, so one microtask turn
  // is enough; no polling helper needed here.
  await Promise.resolve();
  const args = requests[0]?.args as { options?: string[] } | undefined;
  return { approval, requests, decision, values: args?.options ?? [] };
}

it('offers the fallback approval options in the catalog language, not Chinese', async () => {
  const { approval, requests, decision, values } = await offeredChoices();
  expect(values).toEqual(['Allow once', 'Allow for this session', 'Deny']);
  expect(values.some((value) => /[一-鿿]/.test(value))).toBe(false);
  approval.bridge.respond({
    runtimeId: requests[0].runtimeId,
    uiRequestId: requests[0].uiRequestId,
    ok: true,
    value: values[1],
  });
  await expect(decision).resolves.toBe('allow-session');
  approval.bridge.dispose();
});

it('denies a fallback answer it did not offer rather than guessing at it', async () => {
  const { approval, requests, decision } = await offeredChoices();
  approval.bridge.respond({
    runtimeId: requests[0].runtimeId,
    uiRequestId: requests[0].uiRequestId,
    ok: true,
    // What a translated or re-worded dialog would send back. Position in the
    // array we sent is the mapping now, so an unknown string is unknown —
    // it cannot accidentally be position 0 and allow the write.
    value: '允许一次',
  });
  await expect(decision).resolves.toBe('deny');
  approval.bridge.dispose();
});
