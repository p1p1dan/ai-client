import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type PermissionActivityRecord,
  PermissionGate,
  type ToolPermissionRequest,
} from '../../../shared/permissions/gate.ts';
import type { PermissionGear, RuntimeMode } from '../../../shared/types/runtimePermission.ts';
import type { DshPreToolDecision } from '../dshTypes.ts';
import {
  type AttachableGate,
  type DshPermissionHost,
  denialDecision,
  isSpillPath,
  PERMISSION_HOST_SERVICE,
} from '../permissionHost.ts';
import { apply, inject, name } from '../plugin.ts';
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

  it('gives pwsh the bash policy surface and treats every command as unresolved', async () => {
    expect((await requestFor('pwsh', { command: 'Get-ChildItem' })).seen[0]).toMatchObject({
      tool: 'pwsh',
      policySurface: 'bash',
      command: 'Get-ChildItem',
      unresolvedPaths: true,
      exploration: false,
    });
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
    const plugin = (await requestFor('word_create', { path: 'r.docx' })).seen[0];
    expect(plugin).toMatchObject({ tool: 'word_create', policySurface: 'word_create', path: ws });
    expect(plugin?.unresolvedPaths).toBeUndefined();
    expect(plugin?.preview?.text).toContain('r.docx');
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
