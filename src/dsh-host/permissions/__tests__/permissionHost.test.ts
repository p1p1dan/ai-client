import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type PermissionActivityRecord,
  PermissionGate,
  type ToolPermissionRequest,
} from '../../../shared/permissions/gate.ts';
import { loadPermissionPolicy } from '../../../shared/permissions/policy.ts';
import { modeSegment, permissionGearSegment } from '../../../shared/permissions/promptText.ts';
import type { PermissionGear, RuntimeMode } from '../../../shared/types/runtimePermission.ts';
import type { DshPreToolDecision } from '../dshTypes.ts';
import {
  type AttachableGate,
  type DshPermissionHost,
  defaultAttachmentRoot,
  denialDecision,
  isAttachmentPath,
  isSpillPath,
  PERMISSION_HOST_SERVICE,
  spillRootOf,
} from '../permissionHost.ts';
import { apply, inject, name } from '../plugin.ts';
import { PERMISSION_PROMPT_CONTEXT } from '../promptContext.ts';
import { authorizeCall } from '../requestBuilder.ts';
import { agent, call, createFakeDsh, type FakeDsh } from './fakeDsh.ts';

/**
 * dsh-rebase P1-6b — the aiclient-permissions row against a fake DSH context
 * (shard 04, class D): routing, request construction, pre-execute decisions,
 * the fail-closed guard, one card per call id, and search-result filtering.
 * Real `PermissionGate`s, a real workspace on disk and the real tree-sitter
 * wasm from the host package; no host, no model.
 */

let ws: string;
let outside: string;
let spill: string;

beforeAll(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'perm-row-ws-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'perm-row-out-')));
  spill = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-spill-')));
  writeFileSync(join(ws, 'notes.txt'), 'notes\n');
  writeFileSync(join(ws, '.env'), 'SECRET=1\n');
  writeFileSync(join(outside, 'far.txt'), 'far\n');
  mkdirSync(join(ws, 'a'));
  mkdirSync(join(ws, 'b'));
  mkdirSync(join(spill, 'session-1'));
  writeFileSync(join(spill, 'session-1', 'grep-results.txt'), 'spilled\n');
});

afterAll(() => {
  for (const dir of [ws, outside, spill]) rmSync(dir, { recursive: true, force: true });
});

type Answer = 'allow-once' | 'allow-session' | 'deny';

interface Setup {
  fake: FakeDsh;
  host: DshPermissionHost;
}

function setup(): Setup {
  const fake = createFakeDsh();
  apply(fake.ctx);
  return { fake, host: fake.services.get(PERMISSION_HOST_SERVICE) as DshPermissionHost };
}

/** A real gate whose cards are answered by `answer` (default: allow once). */
function realGate(
  options: {
    gear?: PermissionGear;
    mode?: RuntimeMode;
    timeoutMs?: number;
    answer?: (request: ToolPermissionRequest, signal: AbortSignal) => Answer | Promise<Answer>;
  } = {}
) {
  const asked: ToolPermissionRequest[] = [];
  const gate = new PermissionGate({
    cwd: ws,
    gear: options.gear ?? 'ask',
    mode: options.mode ?? 'agent',
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    approve: async (request, signal) => {
      asked.push(request);
      return options.answer ? options.answer(request, signal) : 'allow-once';
    },
  });
  return { gate, asked };
}

/** A gate that records every request and allows it. */
function recordingGate() {
  const seen: ToolPermissionRequest[] = [];
  const gate: AttachableGate = {
    authorize: async (request) => {
      seen.push(request);
    },
    canTraverse: () => true,
    onActivity: () => () => {},
  };
  return { gate, seen };
}

const root = (id = 'aiclient-root') => agent(id, { cwd: ws });

describe('the aiclient-permissions row', () => {
  it('is a tools-injecting row that publishes the attach service', () => {
    const { fake } = setup();
    expect(name).toBe('aiclient-permissions');
    expect(inject).toEqual(['tools']);
    expect(fake.hooks('tools/pre-execute').map((hook) => hook.prepend)).toEqual([true]);
    expect(fake.hooks('tools/post-execute').map((hook) => hook.prepend)).toEqual([true]);
    for (const event of ['approval/request', 'tools/result', 'session/created', 'session/disposed'])
      expect(fake.hooks(event), event).toHaveLength(1);
    expect(
      typeof (fake.services.get(PERMISSION_HOST_SERVICE) as DshPermissionHost).attachGate
    ).toBe('function');
  });
});

describe('the aiclient:permission prompt context (P1-6b; design shard 03 §8)', () => {
  const posture = (mode: RuntimeMode, gear: PermissionGear) =>
    `${modeSegment(mode).text}\n${permissionGearSegment(gear).text}`;

  it("is registered once, right after DSH's approval policy", () => {
    const { fake } = setup();
    expect(fake.contexts.map((context) => [context.name, context.order])).toEqual([
      [PERMISSION_PROMPT_CONTEXT, 116],
    ]);
  });

  it("tells each session its own mode and gear, a delegate its root's, and follows a change", () => {
    const { fake, host } = setup();
    const one = realGate({ gear: 'ask' });
    const two = realGate({ mode: 'plan', gear: 'bypass' });
    host.attachGate('c1-1', { dshSessionId: 'aiclient-one', gate: one.gate });
    host.attachGate('c1-2', { dshSessionId: 'aiclient-two', gate: two.gate });
    const text = (view?: ReturnType<typeof agent>) => fake.contexts[0]?.text({ agent: view });
    expect(text(agent('aiclient-one', { cwd: ws }))).toBe(posture('agent', 'ask'));
    expect(text(agent('aiclient-two'))).toBe(posture('plan', 'bypass'));
    expect(text(agent('child-1', { parentSession: 'aiclient-one' }))).toBe(posture('agent', 'ask'));
    // The next assembly after a change says so; DSH appends it as a new snapshot.
    one.gate.setGear('auto');
    expect(text(agent('aiclient-one'))).toBe(posture('agent', 'auto'));
    one.gate.configure({ mode: 'plan', gear: 'ask' });
    expect(text(agent('aiclient-one'))).toBe(posture('plan', 'ask'));
  });

  it('says nothing for an agent no gate owns, or a gate that does not tell its posture', () => {
    const { fake, host } = setup();
    host.attachGate('c1-1', { dshSessionId: 'aiclient-quiet', gate: recordingGate().gate });
    const text = (view?: ReturnType<typeof agent>) => fake.contexts[0]?.text({ agent: view });
    expect(text(agent('aiclient-stranger'))).toBe('');
    expect(text(undefined)).toBe('');
    expect(text(agent('aiclient-quiet'))).toBe('');
  });
});

describe('the loop guard goes first (decision 081 rule 2)', () => {
  it("refuses a wrap-up step's call with the loop guard's words, before any card", async () => {
    const { fake, host } = setup();
    const { gate, asked } = realGate();
    host.attachGate('c1-1', { dshSessionId: 'aiclient-root', gate });
    const refusing = new Set(['aiclient-root']);
    fake.services.set('aiclientLoopGuard', {
      refusalFor: (exec: { agent?: { id: string } }) =>
        exec.agent && refusing.has(exec.agent.id) ? 'Refused: turn ceiling.' : undefined,
    });
    const write = { file_path: 'notes.txt', content: 'x' };
    expect(await fake.prepare(call('write', write, root()))).toEqual({
      kind: 'deny',
      reason: 'Refused: turn ceiling.',
      info: { name: 'LoopGuard', code: 'turn_ceiling' },
    });
    // Internal tools too: the guard's refusal is about the step, not the tool.
    expect((await fake.prepare(call('todo_write', { todos: [] }, root()))).kind).toBe('deny');
    expect(asked).toHaveLength(0);
    refusing.clear();
    expect((await fake.prepare(call('write', write, root()))).kind).toBe('allow');
    expect(asked).toHaveLength(1);
  });

  it('gates as before on a host without the loop guard', async () => {
    const { fake, host } = setup();
    const { gate } = recordingGate();
    host.attachGate('c1-1', { dshSessionId: 'aiclient-root', gate });
    expect(fake.services.has('aiclientLoopGuard')).toBe(false);
    expect((await fake.prepare(call('read', { file_path: 'notes.txt' }, root()))).kind).toBe(
      'allow'
    );
  });
});

describe('routing (decision 042 rule 1)', () => {
  it('refuses a call from a session nobody attached', async () => {
    const { fake } = setup();
    const decision = await fake.prepare(call('read', { file_path: 'notes.txt' }, root()));
    expect(decision).toEqual({
      kind: 'deny',
      reason: 'permission gate not attached',
      info: { name: 'PermissionDenial', code: 'tool_denied', reason: 'unattached' },
    });
    const internal = await fake.prepare(call('todo_write', { todos: [] }, root()));
    expect(internal.kind).toBe('deny');
    expect(await fake.prepare(call('read', { file_path: 'notes.txt' }, undefined))).toMatchObject({
      kind: 'deny',
      reason: 'permission gate not attached',
    });
  });

  it('routes subagent and nested delegate calls to the root gate, naming the delegate', async () => {
    const { fake, host } = setup();
    const { gate, seen } = recordingGate();
    host.attachGate('c1-1', { dshSessionId: 'aiclient-root', gate });
    fake.emit('session/created', {
      id: 'child',
      header: { id: 'child', cwd: ws, parentSession: 'aiclient-root', agentPreset: 'reviewer' },
    });
    fake.emit('session/created', {
      id: 'grandchild',
      header: { id: 'grandchild', cwd: ws, parentSession: 'child' },
    });
    const child = agent('child', { cwd: ws, parentSession: 'aiclient-root' });
    const grandchild = agent('grandchild', { cwd: ws, parentSession: 'child' });
    expect((await fake.prepare(call('read', { file_path: 'notes.txt' }, root()))).kind).toBe(
      'allow'
    );
    expect((await fake.prepare(call('read', { file_path: 'notes.txt' }, child))).kind).toBe(
      'allow'
    );
    expect((await fake.prepare(call('read', { file_path: 'notes.txt' }, grandchild))).kind).toBe(
      'allow'
    );
    expect(seen.map((request) => request.delegation)).toEqual([
      undefined,
      { delegationId: 'child', agentName: 'reviewer' },
      { delegationId: 'grandchild', agentName: 'subagent' },
    ]);
  });

  it('resolves a delegate the row never saw announced through its own header', async () => {
    const { fake, host } = setup();
    const { gate, seen } = recordingGate();
    host.attachGate('c1-1', { dshSessionId: 'aiclient-root', gate });
    const late = agent('late-child', { cwd: ws, parentSession: 'aiclient-root' });
    expect((await fake.prepare(call('read', { file_path: 'notes.txt' }, late))).kind).toBe('allow');
    expect(seen[0]?.delegation?.delegationId).toBe('late-child');
    // A session with lineage to nothing attached stays refused.
    const stray = agent('stray', { cwd: ws, parentSession: 'somebody-else' });
    expect((await fake.prepare(call('read', { file_path: 'notes.txt' }, stray))).kind).toBe('deny');
  });

  it('keeps chat sessions apart: a session grant in one never answers the other', async () => {
    const { fake, host } = setup();
    const one = realGate({ answer: () => 'allow-session' });
    const two = realGate({ answer: () => 'deny' });
    host.attachGate('c1-1', { dshSessionId: 'aiclient-one', gate: one.gate });
    host.attachGate('c1-2', { dshSessionId: 'aiclient-two', gate: two.gate });
    const write = { file_path: 'notes.txt', content: 'x' };
    expect((await fake.prepare(call('write', write, root('aiclient-one')))).kind).toBe('allow');
    expect((await fake.prepare(call('write', write, root('aiclient-one')))).kind).toBe('allow');
    expect(one.asked).toHaveLength(1);
    expect(await fake.prepare(call('write', write, root('aiclient-two')))).toMatchObject({
      kind: 'deny',
      reason: 'permission denied',
    });
    expect(two.asked).toHaveLength(1);
  });

  it('refuses a detached root and its delegates', async () => {
    const { fake, host } = setup();
    const { gate } = recordingGate();
    const attached = host.attachGate('c1-1', { dshSessionId: 'aiclient-root', gate });
    fake.emit('session/created', {
      id: 'child',
      header: { id: 'child', cwd: ws, parentSession: 'aiclient-root' },
    });
    expect(host.isAttached('c1-1')).toBe(true);
    attached.detach();
    expect(host.isAttached('c1-1')).toBe(false);
    expect(host.detachGate('c1-1')).toBe(false);
    const child = agent('child', { cwd: ws });
    expect((await fake.prepare(call('read', { file_path: 'notes.txt' }, root()))).kind).toBe(
      'deny'
    );
    expect((await fake.prepare(call('read', { file_path: 'notes.txt' }, child))).kind).toBe('deny');
  });

  it('re-points a channel to a new DSH id and keeps the old id on the same gate', async () => {
    const { fake, host } = setup();
    const first = recordingGate();
    const second = recordingGate();
    const stale = host.attachGate('c1-1', { dshSessionId: 'aiclient-old', gate: first.gate });
    fake.emit('session/created', {
      id: 'child',
      header: { id: 'child', cwd: ws, parentSession: 'aiclient-old' },
    });
    host.attachGate('c1-1', { dshSessionId: 'aiclient-new', gate: second.gate });
    stale.detach(); // no longer current: a no-op
    expect(host.isAttached('c1-1')).toBe(true);
    for (const caller of [root('aiclient-old'), root('aiclient-new'), agent('child', { cwd: ws })])
      expect((await fake.prepare(call('read', { file_path: 'notes.txt' }, caller))).kind).toBe(
        'allow'
      );
    expect(first.seen).toHaveLength(0);
    expect(second.seen.map((request) => request.delegation?.delegationId)).toEqual([
      undefined,
      undefined,
      'child',
    ]);
  });

  it('refuses to attach one DSH session to two channels', () => {
    const { host } = setup();
    host.attachGate('c1-1', { dshSessionId: 'aiclient-root', gate: recordingGate().gate });
    expect(() =>
      host.attachGate('c1-2', { dshSessionId: 'aiclient-root', gate: recordingGate().gate })
    ).toThrow(/already attached to channel c1-1/);
  });
});

describe('request construction (design shard 03 §2)', () => {
  async function requestFor(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ decision: DshPreToolDecision; seen: ToolPermissionRequest[] }> {
    const { fake, host } = setup();
    const { gate, seen } = recordingGate();
    host.attachGate('c1-1', { dshSessionId: 'aiclient-root', gate });
    const decision = await fake.prepare(call(toolName, args, root(), { callId: 'c' }));
    return { decision, seen };
  }

  it('reads and searches name the canonical file or root', async () => {
    expect((await requestFor('read', { file_path: 'notes.txt' })).seen).toEqual([
      expect.objectContaining({ tool: 'read', toolCallId: 'c', path: join(ws, 'notes.txt') }),
    ]);
    expect((await requestFor('read_image', { file_path: 'a/../notes.txt' })).seen[0]).toMatchObject(
      { tool: 'read', path: join(ws, 'notes.txt') }
    );
    expect((await requestFor('glob', { pattern: '*' })).seen[0]).toMatchObject({
      tool: 'glob',
      path: ws,
    });
    expect((await requestFor('grep', { pattern: 'x', path: 'a' })).seen[0]).toMatchObject({
      tool: 'grep',
      path: join(ws, 'a'),
    });
  });

  it('writes preview their content; edits name the file', async () => {
    expect((await requestFor('write', { file_path: 'new.txt', content: 'hello' })).seen[0]).toEqual(
      expect.objectContaining({
        tool: 'write',
        path: join(ws, 'new.txt'),
        preview: { label: 'Content', text: 'hello' },
      })
    );
    const edit = (await requestFor('edit', { file_path: 'notes.txt', old_string: 'a' })).seen[0];
    expect(edit).toMatchObject({ tool: 'edit', path: join(ws, 'notes.txt') });
    expect(edit?.preview).toBeUndefined();
  });

  it('analyses bash with tree-sitter and resolves workdir', async () => {
    const { seen } = await requestFor('bash', {
      command: 'cat notes.txt > copy.txt',
      workdir: 'a',
    });
    expect(seen[0]).toMatchObject({
      tool: 'bash',
      path: join(ws, 'a'),
      command: 'cat notes.txt > copy.txt',
      commands: ['cat notes.txt'],
      unresolvedPaths: false,
      exploration: false,
    });
    expect(seen[0]?.paths).toEqual(
      expect.arrayContaining([join(ws, 'a', 'notes.txt'), join(ws, 'a', 'copy.txt')])
    );
    expect((await requestFor('bash', { command: 'ls -la' })).seen[0]).toMatchObject({
      exploration: true,
      unresolvedPaths: false,
      path: ws,
    });
  });

  it('reads pwsh with its own analysis, operands checked as for bash (P1-6d)', async () => {
    const command = 'ls a; Get-Content notes.txt > copy.txt';
    const seen = (await requestFor('pwsh', { command })).seen[0];
    expect(seen).toMatchObject({
      tool: 'pwsh',
      path: ws,
      command,
      commands: ['Get-ChildItem a', 'Get-Content notes.txt'],
      unresolvedPaths: false,
      exploration: false,
    });
    expect(seen?.paths).toEqual(
      expect.arrayContaining([join(ws, 'a'), join(ws, 'notes.txt'), join(ws, 'copy.txt')])
    );
    // The gate judges both shells under the `bash` surface itself (decision 129).
    expect(seen).not.toHaveProperty('policySurface');
    expect(seen).not.toHaveProperty('ungrantable');
    expect((await requestFor('pwsh', { command: 'Get-ChildItem' })).seen[0]).toMatchObject({
      exploration: true,
      unresolvedPaths: false,
      path: ws,
    });
    expect(
      (await requestFor('pwsh', { command: 'Get-ChildItem | % { $_.Name }' })).seen[0]
    ).toMatchObject({ unresolvedPaths: true, exploration: false, ungrantable: true });
  });

  it("expands pwsh's $env: from the chat's environment", async () => {
    const { fake, host } = setup();
    const { gate, seen } = recordingGate();
    host.attachGate('c1-1', {
      dshSessionId: 'aiclient-root',
      gate,
      env: { PERM_ROW_OUT: outside },
    });
    await fake.prepare(
      call('pwsh', { command: 'Get-Content $env:PERM_ROW_OUT/far.txt' }, root(), { callId: 'c' })
    );
    expect(seen[0]).toMatchObject({ unresolvedPaths: false });
    expect(seen[0]?.paths).toContain(join(outside, 'far.txt'));
  });

  it('treats programs as opaque and plugin tools by their own policy rule', async () => {
    expect(
      (await requestFor('run_code', { code: 'return 1', description: 'x' })).seen[0]
    ).toMatchObject({
      tool: 'run_code',
      path: ws,
      policySurface: 'run_code',
      policyValue: 'run_code',
      unresolvedPaths: true,
      preview: { label: 'Program', text: 'return 1' },
    });
    expect((await requestFor('workflow', { script: 'return 2', meta: {} })).seen[0]).toMatchObject({
      tool: 'workflow',
      unresolvedPaths: true,
      preview: { label: 'Program', text: 'return 2' },
    });
    const plugin = (await requestFor('fixture_ping', { path: 'r.docx' })).seen[0];
    expect(plugin).toMatchObject({ tool: 'fixture_ping', policySurface: 'fixture_ping', path: ws });
    expect(plugin?.unresolvedPaths).toBeUndefined();
    expect(plugin?.fileWrite).toBeUndefined();
    expect(plugin?.preview?.text).toContain('r.docx');
  });

  it("gates an allowlisted plugin's reads and writes on the file its review names (P1-10d)", async () => {
    // dsh-office-tools: reads are DSH reads of `path`...
    expect((await requestFor('word_read', { path: 'notes.txt' })).seen).toEqual([
      expect.objectContaining({ tool: 'read', toolCallId: 'c', path: join(ws, 'notes.txt') }),
    ]);
    expect((await requestFor('excel_read', { path: 'a/../notes.txt' })).seen[0]).toMatchObject({
      tool: 'read',
      path: join(ws, 'notes.txt'),
    });
    // ...writes keep their own name, carry `path` and the `write` rules, and
    // preview the whole argument object (the content they are about to write).
    const create = (
      await requestFor('word_create', { path: 'report.docx', paragraphs: ['draft body'] })
    ).seen[0];
    expect(create).toMatchObject({
      tool: 'word_create',
      path: join(ws, 'report.docx'),
      policySurface: 'write',
      fileWrite: true,
      preview: { label: 'Arguments' },
    });
    expect(create?.policyValue).toBeUndefined();
    expect(create?.unresolvedPaths).toBeUndefined();
    expect(create?.preview?.text).toContain('draft body');
    expect((await requestFor('excel_update', { path: 'notes.txt' })).seen[0]).toMatchObject({
      tool: 'excel_update',
      path: join(ws, 'notes.txt'),
      fileWrite: true,
    });
  });

  it('matches skills on their name at a trusted path', async () => {
    expect((await requestFor('skill', { name: 'librarian' })).seen[0]).toMatchObject({
      tool: 'skill',
      policySurface: 'skill',
      policyValue: 'librarian',
      trustedPath: true,
    });
  });

  it('never asks the gate about internal tools', async () => {
    for (const tool of ['todo_write', 'subagent', 'job_output', 'exit_plan_mode']) {
      const { decision, seen } = await requestFor(tool, {});
      expect(decision.kind, tool).toBe('allow');
      expect(seen, tool).toEqual([]);
    }
  });

  it('trusts reads of DSH spill files only', async () => {
    const file = join(spill, 'session-1', 'grep-results.txt');
    expect(isSpillPath(file)).toBe(true);
    expect(isSpillPath(join(ws, 'notes.txt'))).toBe(false);
    expect((await requestFor('read', { file_path: file })).seen[0]?.trustedPath).toBe(true);
    expect(
      (await requestFor('read', { file_path: 'notes.txt' })).seen[0]?.trustedPath
    ).toBeUndefined();
    expect(
      (await requestFor('bash', { command: 'ls', workdir: spill })).seen[0]?.trustedPath
    ).toBeUndefined();
  });
});

describe('pre-execute decisions (decision 042 rule 2)', () => {
  function attached(options: Parameters<typeof realGate>[0] = {}) {
    const { fake, host } = setup();
    const real = realGate(options);
    host.attachGate('c1-1', { dshSessionId: 'aiclient-root', gate: real.gate });
    return { fake, ...real };
  }

  it('passes an allowed call on to the rest of the chain', async () => {
    const { fake, asked } = attached({ gear: 'auto' });
    fake.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'downstream said no' }));
    expect(await fake.prepare(call('write', { file_path: 'x.txt', content: '' }, root()))).toEqual({
      kind: 'deny',
      reason: 'downstream said no',
    });
    expect(asked).toEqual([]);
  });

  it("follows the gear for an allowlisted plugin's reads and writes like DSH's own (P1-10d)", async () => {
    const readCall = () => call('word_read', { path: 'notes.txt' }, root());
    const writeCall = (file = 'report.docx') =>
      call('word_create', { path: file, paragraphs: ['x'] }, root());
    // ask: the write raises a card naming the plugin tool; the workspace read does not.
    const ask = attached();
    expect((await ask.fake.prepare(readCall())).kind).toBe('allow');
    expect((await ask.fake.prepare(writeCall())).kind).toBe('allow');
    expect(ask.asked.map((request) => [request.tool, request.path])).toEqual([
      ['word_create', join(ws, 'report.docx')],
    ]);
    // accept-edits: a workspace write goes through as write / edit do; outside still asks.
    const edits = attached({ gear: 'accept-edits' });
    expect((await edits.fake.prepare(writeCall())).kind).toBe('allow');
    expect(edits.asked).toEqual([]);
    expect((await edits.fake.prepare(writeCall(join(outside, 'far.docx')))).kind).toBe('allow');
    expect(edits.asked.map((request) => request.path)).toEqual([join(outside, 'far.docx')]);
    // plan: the write is refused without a card, the read runs.
    const plan = attached({ mode: 'plan' });
    expect((await plan.fake.prepare(writeCall())).kind).toBe('deny');
    expect((await plan.fake.prepare(readCall())).kind).toBe('allow');
    expect(plan.asked).toEqual([]);
  });

  it('refuses secrets before resolving them, in the 1.0.x words', async () => {
    const { fake, asked } = attached({ gear: 'bypass' });
    expect(await fake.prepare(call('read', { file_path: '.env' }, root()))).toEqual({
      kind: 'deny',
      reason: `access denied: ${join(ws, '.env')}`,
      info: { name: 'PermissionDenial', code: 'tool_denied', reason: 'policy-deny' },
    });
    expect(await fake.prepare(call('bash', { command: 'cat .env' }, root()))).toMatchObject({
      kind: 'deny',
      reason: `shell operand is denied: ${join(ws, '.env')}`,
    });
    // P1-6d: pwsh the same way — and a name inside code the analysis cannot
    // read still meets the deny list.
    for (const command of [
      'Get-Content .env',
      'Get-Content (Join-Path . \x27.env\x27)',
      'iex "cat .env"',
    ])
      expect(await fake.prepare(call('pwsh', { command }, root())), command).toMatchObject({
        kind: 'deny',
        reason: `shell operand is denied: ${join(ws, '.env')}`,
      });
    expect(asked).toEqual([]);
  });

  it('reports each refusal source', async () => {
    const plan = attached({ mode: 'plan' });
    expect(
      await plan.fake.prepare(call('write', { file_path: 'x.txt', content: '' }, root()))
    ).toEqual({
      kind: 'deny',
      reason: `access denied: write ${join(ws, 'x.txt')}`,
      info: { name: 'PermissionDenial', code: 'tool_denied', reason: 'policy-deny' },
    });
    const denied = attached({ answer: () => 'deny' });
    expect(
      await denied.fake.prepare(call('write', { file_path: 'x.txt', content: '' }, root()))
    ).toEqual({
      kind: 'deny',
      reason: 'permission denied',
      info: { name: 'PermissionDenial', code: 'tool_denied', reason: 'user-denied' },
    });
    const slow = attached({ timeoutMs: 20, answer: () => new Promise<Answer>(() => {}) });
    expect(
      await slow.fake.prepare(call('write', { file_path: 'x.txt', content: '' }, root()))
    ).toEqual({
      kind: 'deny',
      reason: 'nobody answered the permission request in time',
      info: { name: 'PermissionDenial', code: 'tool_denied', reason: 'timed-out' },
    });
  });

  it('turns a Stop while the card is up into cancel (ABORTED_BEFORE_DISPATCH)', async () => {
    const stop = new AbortController();
    let cardUp!: () => void;
    const shown = new Promise<void>((done) => {
      cardUp = done;
    });
    const { fake } = attached({
      answer: (_request, signal) =>
        new Promise<Answer>((done) => {
          cardUp();
          signal.addEventListener('abort', () => done('deny'), { once: true });
        }),
    });
    const pending = fake.prepare(
      call('write', { file_path: 'x.txt', content: '' }, root(), { signal: stop.signal })
    );
    await shown;
    stop.abort();
    expect(await pending).toEqual({ kind: 'cancel' });
    // Already stopped: never reaches a card.
    expect(
      await fake.prepare(
        call('write', { file_path: 'y.txt', content: '' }, root(), { signal: stop.signal })
      )
    ).toEqual({ kind: 'cancel' });
  });

  it('refuses a target that moved while the card was up', async () => {
    const link = join(ws, 'moving');
    symlinkSync(join(ws, 'a'), link);
    try {
      const { fake } = attached({
        answer: () => {
          unlinkSync(link);
          symlinkSync(join(ws, 'b'), link);
          return 'allow-once';
        },
      });
      expect(
        await fake.prepare(call('write', { file_path: 'moving/x.txt', content: '' }, root()))
      ).toEqual({
        kind: 'deny',
        reason: 'path changed during approval; retry to authorize the new target',
        info: { name: 'PermissionDenial', code: 'path_changed' },
      });
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('asks about a command whose operands it cannot read, even under auto', async () => {
    const { fake, asked } = attached({ gear: 'auto' });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    await fake.prepare(call('bash', { command: 'echo a > ${TARGET}' }, root()));
    expect(asked.map((request) => request.tool)).toEqual(['bash']);
    await fake.prepare(call('bash', { command: 'echo a > out.txt' }, root()));
    expect(asked).toHaveLength(1);
    await fake.prepare(call('run_code', { code: 'return 1', description: 'x' }, root()));
    expect(asked.map((request) => request.tool)).toEqual(['bash', 'run_code']);
  });

  it('refuses a bash command the analyzer cannot parse', async () => {
    const { fake, asked } = attached({ gear: 'bypass' });
    expect(await fake.prepare(call('bash', { command: 'echo "unterminated' }, root()))).toEqual({
      kind: 'deny',
      reason: 'bash command could not be parsed',
      info: { name: 'PermissionDenial', code: 'invalid_tool_arguments' },
    });
    expect(asked).toEqual([]);
  });

  it('records the sandbox escalation a call asks for in its own arguments', async () => {
    const { gate } = recordingGate();
    const context = {
      gate,
      cwd: ws,
      fs: { realpath: async (path: string) => path, readDirectory: async function* () {} },
      analyzeBash: async () => ({
        paths: [],
        commands: [],
        unresolvedPaths: false,
        exploration: true,
      }),
    };
    expect(
      await authorizeCall(
        {
          name: 'write',
          callId: 'e1',
          arguments: {
            file_path: 'x.txt',
            content: '',
            sandbox_permissions: 'danger-full-access',
            justification: 'needs it',
          },
        },
        context
      )
    ).toEqual({
      kind: 'gated',
      toolClass: 'write',
      escalation: { mode: 'danger-full-access', justification: 'needs it' },
    });
    expect(
      await authorizeCall({ name: 'read', callId: 'e2', arguments: { file_path: 'x' } }, context)
    ).toEqual({ kind: 'gated', toolClass: 'read' });
    expect(
      await authorizeCall({ name: 'todo_write', callId: 'e3', arguments: {} }, context)
    ).toEqual({ kind: 'internal' });
  });

  it('maps errors that are not refusals to a coded deny', () => {
    const coded = Object.assign(new Error('bad input'), { code: 'invalid_tool_arguments' });
    expect(denialDecision(coded)).toEqual({
      kind: 'deny',
      reason: 'bad input',
      info: { name: 'PermissionDenial', code: 'invalid_tool_arguments' },
    });
    expect(denialDecision(new Error('EIO'))).toEqual({
      kind: 'deny',
      reason: 'permission check failed: EIO',
      info: { name: 'PermissionDenial', code: 'permission_error' },
    });
  });
});

describe('the guard (fail closed)', () => {
  it('refuses a call another listener allowed before the gate ran', async () => {
    const { fake, host } = setup();
    const { gate, seen } = recordingGate();
    host.attachGate('c1-1', { dshSessionId: 'aiclient-root', gate });
    // Registered later with prepend, so it runs first and never calls next().
    fake.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true });
    expect(await fake.prepare(call('read', { file_path: 'notes.txt' }, root()))).toEqual({
      kind: 'deny',
      reason: 'permission gate did not run',
    });
    expect(seen).toEqual([]);
  });
});

describe('approval/request: one card per call id (design shard 03 §5)', () => {
  function attached(options: Parameters<typeof realGate>[0] = {}) {
    const { fake, host } = setup();
    const real = realGate(options);
    host.attachGate('c1-1', { dshSessionId: 'aiclient-root', gate: real.gate });
    return { fake, ...real };
  }
  const escalate = (callId: string, signal?: AbortSignal) => ({
    agent: root(),
    toolName: 'write',
    callId,
    reason: 'escalate sandbox to danger-full-access: outside file',
    displayReason: { en: 'Write one file outside the workspace' },
    ...(signal ? { signal } : {}),
  });

  it('answers an escalation of a call whose card the user already approved', async () => {
    const { fake, asked } = attached();
    const write = call(
      'write',
      {
        file_path: join(outside, 'far.txt'),
        content: 'x',
        sandbox_permissions: 'danger-full-access',
        justification: 'outside file',
      },
      root(),
      { callId: 'w1' }
    );
    expect((await fake.prepare(write)).kind).toBe('allow');
    expect(await fake.approval(escalate('w1'))).toBe('allowed-once');
    expect(asked.map((request) => request.toolCallId)).toEqual(['w1']);
    // The result closes the call's record; a late ask is a new question.
    fake.emit('tools/result', write, { isError: false });
    expect(await fake.approval(escalate('w1'))).toBe('allowed-once');
    expect(asked).toHaveLength(2);
  });

  it('raises the one card itself when the gate allowed the call without asking', async () => {
    const { fake, asked } = attached({ gear: 'accept-edits' });
    expect(
      (
        await fake.prepare(
          call('write', { file_path: 'in.txt', content: '' }, root(), { callId: 'w2' })
        )
      ).kind
    ).toBe('allow');
    expect(asked).toEqual([]);
    expect(await fake.approval(escalate('w2'))).toBe('allowed-once');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      tool: 'write',
      toolCallId: 'w2',
      unresolvedPaths: true,
      preview: { label: 'Reason', text: 'Write one file outside the workspace' },
    });
  });

  it('rejects an escalation of a refused call without a card', async () => {
    const { fake, asked } = attached({ answer: () => 'deny' });
    await fake.prepare(
      call('write', { file_path: 'in.txt', content: '' }, root(), { callId: 'w3' })
    );
    expect(await fake.approval(escalate('w3'))).toBe('rejected');
    expect(asked).toHaveLength(1);
  });

  it('follows the gear for asks it has no card for', async () => {
    const bypass = attached({ gear: 'bypass' });
    expect(await bypass.fake.approval(escalate('x1'))).toBe('allowed-once');
    expect(bypass.asked).toEqual([]);
    const plan = attached({ mode: 'plan' });
    expect(await plan.fake.approval(escalate('x2'))).toBe('rejected');
    const auto = attached({ gear: 'auto', answer: () => 'deny' });
    expect(await auto.fake.approval(escalate('x3'))).toBe('rejected');
    expect(auto.asked).toHaveLength(1);
  });

  it('reports a Stop during the escalation card as cancelled', async () => {
    const stop = new AbortController();
    const { fake } = attached({
      answer: (_request, signal) =>
        new Promise<Answer>((done) => {
          queueMicrotask(() => stop.abort());
          signal.addEventListener('abort', () => done('deny'), { once: true });
        }),
    });
    expect(await fake.approval(escalate('x4', stop.signal))).toBe('cancelled');
  });

  it('leaves sessions it does not own to the next answerer', async () => {
    const { fake } = attached();
    expect(await fake.approval({ ...escalate('x5'), agent: root('someone-else') })).toBe(
      'unavailable'
    );
  });

  it("marks the ask as the host's own: one answer for one call, an escalation as such (P1-6b)", async () => {
    const { fake, asked } = attached();
    expect(await fake.approval(escalate('x6'))).toBe('allowed-once');
    expect(await fake.approval({ ...escalate('x7'), reason: 'a plugin wants to publish' })).toBe(
      'allowed-once'
    );
    expect(asked.map((request) => request.hostAsk)).toEqual([
      { sandbox: true },
      { sandbox: false },
    ]);
  });
});

describe('search results (decision 048)', () => {
  function attached() {
    const { fake, host } = setup();
    const real = realGate({ gear: 'ask' });
    host.attachGate('c1-1', { dshSessionId: 'aiclient-root', gate: real.gate });
    const downstream: string[] = [];
    // Stands in for tool-fs-search's spill, which runs after this row.
    fake.on('tools/post-execute', async (exec: unknown) => {
      downstream.push((exec as { callId: string }).callId);
      return { kind: 'accept' };
    });
    return { fake, downstream };
  }

  it('drops denied glob entries and keeps the list off the spill path', async () => {
    const { fake, downstream } = attached();
    const glob = call('glob', { pattern: '**/*' }, root(), { callId: 'g1' });
    const decision = await fake.postExecute(glob, {
      isError: false,
      value: { root: '.', paths: ['notes.txt', '.env', 'keys/server.key', 'a/id_rsa', 'a/b.pem'] },
    });
    expect(decision).toEqual({ kind: 'accept', value: { root: '.', paths: ['notes.txt'] } });
    expect(downstream).toEqual([]);
  });

  it('drops grep matches in denied files, nested program calls included', async () => {
    const { fake } = attached();
    const grep = call('grep', { pattern: 'x' }, root(), { callId: 'g2', nested: true });
    const decision = await fake.postExecute(grep, {
      isError: false,
      value: {
        matches: [
          { path: 'notes.txt', lineNumber: 1, line: 'x' },
          { path: 'server.key', lineNumber: 2, line: 'x' },
          { path: '.env.local', lineNumber: 1, line: 'x' },
        ],
      },
    });
    expect(decision).toEqual({
      kind: 'accept',
      value: { matches: [{ path: 'notes.txt', lineNumber: 1, line: 'x' }] },
    });
  });

  it('passes clean, failed and non-search results down the chain untouched', async () => {
    const { fake, downstream } = attached();
    await fake.postExecute(call('glob', {}, root(), { callId: 'g3' }), {
      isError: false,
      value: { root: '.', paths: ['notes.txt'] },
    });
    await fake.postExecute(call('grep', {}, root(), { callId: 'g4' }), { isError: true });
    await fake.postExecute(call('read', {}, root(), { callId: 'g5' }), {
      isError: false,
      value: { path: '.env' },
    });
    expect(downstream).toEqual(['g3', 'g4', 'g5']);
  });
});

describe('audit wiring', () => {
  it('marks prompts through the gate it was given, and stops listening on detach', async () => {
    const { fake, host } = setup();
    const records: PermissionActivityRecord[] = [];
    const real = realGate();
    real.gate.onActivity((record) => records.push(record));
    const attachedGate = host.attachGate('c1-1', {
      dshSessionId: 'aiclient-root',
      gate: real.gate,
    });
    await fake.prepare(
      call('write', { file_path: 'x.txt', content: '' }, root(), { callId: 'a1' })
    );
    expect(records.map((record) => record.phase)).toEqual(['prompt', 'decision']);
    attachedGate.detach();
    expect(await fake.approval({ agent: root(), toolName: 'write', callId: 'a1' })).toBe(
      'unavailable'
    );
  });
});

/**
 * dsh-rebase P1-4c2 (decisions 097, 112): what the user attached lives in
 * dsh-attachment-local's store, `<DSH_HOME>/attachments/v1`, and the model is
 * told to read it there. Reads of it are trusted: no card, under the bundled
 * policy too (the app keeps DSH_HOME under `~/.pilab`, outside every
 * workspace). A deny still refuses; nothing else about the home is trusted.
 */
describe('the attachment store is trusted for reads (P1-4c2)', () => {
  let home: string;
  let store: string;
  const file = (...parts: string[]) => join(store, ...parts);

  beforeAll(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'perm-row-dsh-home-')));
    store = join(home, 'attachments', 'v1');
    mkdirSync(file('files', 'ab', 'digest'), { recursive: true });
    mkdirSync(file('objects', 'cd'), { recursive: true });
    writeFileSync(file('files', 'ab', 'digest', 'notes.txt'), 'attached\n');
    writeFileSync(file('files', 'ab', 'digest', 'secrets.env'), 'SECRET=1\n');
    writeFileSync(file('objects', 'cd', 'cdef'), 'png');
    writeFileSync(join(home, 'other.txt'), 'not attached\n');
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('is strictly below the store', () => {
    expect(isAttachmentPath(file('files', 'ab', 'digest', 'notes.txt'), store)).toBe(true);
    expect(isAttachmentPath(file('objects', 'cd', 'cdef'), store)).toBe(true);
    expect(isAttachmentPath(store, store)).toBe(false);
    expect(isAttachmentPath(join(home, 'other.txt'), store)).toBe(false);
    expect(isAttachmentPath(join(home, 'attachments', 'v10', 'x'), store)).toBe(false);
    expect(isAttachmentPath(join(store, '..', 'v2', 'x'), store)).toBe(false);
    expect(isAttachmentPath(file('x'), null)).toBe(false);
  });

  it("is the canonical DSH_HOME's store, and none without a home", () => {
    const link = join(outside, 'dsh-home-link');
    symlinkSync(home, link);
    try {
      expect(defaultAttachmentRoot(link)).toBe(store);
    } finally {
      unlinkSync(link);
    }
    expect(defaultAttachmentRoot('  ')).toBeNull();
  });

  it('reads an attachment without a card; a deny, and anything else, still hold', async () => {
    vi.stubEnv('DSH_HOME', home);
    let wired: Setup;
    try {
      wired = setup();
    } finally {
      vi.unstubAllEnvs();
    }
    const policy = await loadPermissionPolicy(
      {
        readFile: async (path) => {
          throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
        },
      },
      { cwd: ws, agentDir: null, sources: { user: false, project: false, local: false } }
    );
    const asked: string[] = [];
    const gate = new PermissionGate({
      cwd: ws,
      gear: 'ask',
      mode: 'agent',
      policy,
      approve: async (request) => {
        asked.push(request.tool);
        return 'deny';
      },
    });
    wired.host.attachGate('c1-1', { dshSessionId: 'aiclient-root', gate });
    const run = (tool: string, args: Record<string, unknown>) =>
      wired.fake.prepare(call(tool, args, root()));
    const notes = file('files', 'ab', 'digest', 'notes.txt');

    expect((await run('read', { file_path: notes })).kind).toBe('allow');
    expect((await run('read_image', { file_path: file('objects', 'cd', 'cdef') })).kind).toBe(
      'allow'
    );
    expect(asked).toEqual([]);
    // Decision 097 rule 3: an explicit deny (here the bundled `*.env`) still refuses, silently.
    expect(
      await run('read', { file_path: file('files', 'ab', 'digest', 'secrets.env') })
    ).toMatchObject({ kind: 'deny', info: { code: 'tool_denied', reason: 'policy-deny' } });
    expect(asked).toEqual([]);
    // The rest of DSH_HOME, a write into the store and a shell reading it are asked as ever.
    await run('read', { file_path: join(home, 'other.txt') });
    await run('write', { file_path: notes, content: 'x' });
    await run('bash', { command: `cat ${notes}` });
    expect(asked).toEqual(['read', 'write', 'bash']);
  });
});

/**
 * Decision 134: the trusted roots (spill parent, attachment store) are
 * canonicalized by the twin of the resolver the targets go through, the
 * native one. On Windows the JavaScript `realpathSync` keeps an 8.3 `%TEMP%`
 * (`C:\Users\RUNNER~1\...`) while the targets come back long, so a spill
 * the model was told to read raised a card.
 */
describe('the trusted roots are canonical as the targets are (decision 134)', () => {
  /** A Windows 8.3 expansion, stood in for on any box. */
  const expand = (path: string) => path.replace(`${sep}RUNNER~1${sep}`, `${sep}runneradmin${sep}`);
  const shortTmp = join(sep, 'users', 'RUNNER~1', 'tmp');
  const longTmp = join(sep, 'users', 'runneradmin', 'tmp');

  it('[8dot3-spill] the spill parent is the expanded temp directory', () => {
    const root = spillRootOf(shortTmp, expand);
    expect(root).toBe(longTmp);
    expect(isSpillPath(join(longTmp, 'dsh-spill-1', 'grep.txt'), root)).toBe(true);
    // What the JavaScript resolver's root made of the same target.
    expect(isSpillPath(join(longTmp, 'dsh-spill-1', 'grep.txt'), shortTmp)).toBe(false);
  });

  it('[8dot3-attachments] the attachment store is under the expanded home', () => {
    const home = join(sep, 'users', 'RUNNER~1', 'dsh-home');
    expect(defaultAttachmentRoot(home, expand)).toBe(
      join(sep, 'users', 'runneradmin', 'dsh-home', 'attachments', 'v1')
    );
  });

  it('[native-twin] by default, a root resolves exactly as fs/promises realpath resolves it', async () => {
    const tmp = tmpdir();
    expect(spillRootOf(tmp)).toBe(await realpath(tmp));
    expect(defaultAttachmentRoot(ws)).toBe(join(await realpath(ws), 'attachments', 'v1'));
  });

  it.skipIf(process.platform !== 'win32' || !/~\d/.test(tmpdir()))(
    '[win32-8dot3] an 8.3 %TEMP% keeps its short name under the JavaScript resolver only',
    async () => {
      const tmp = tmpdir();
      expect(realpathSync(tmp)).toBe(tmp);
      expect(spillRootOf(tmp)).not.toBe(tmp);
      expect(spillRootOf(tmp)).toBe(await realpath(tmp));
    }
  );
});
