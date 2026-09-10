import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtensionUiRequest } from '../../agent-host/extensionUiBridge.ts';
import { reviewFromToolResult } from '../../shared/sessionFileChange.ts';
import { migratePermissionTier } from '../../shared/types/runtimePermission.ts';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import { standaloneHost } from '../host/config.ts';
import { resolveWorkerShell } from '../host/shell.ts';
import { modeSegment, permissionGearSegment } from '../plugins/permissions/prompt.ts';
import { composeSystemPrompt } from '../plugins/prompt/segments.ts';

let dir: string;
const runtimes: RuntimeHandle[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-tools-'));
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});
function faux() {
  const provider = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  provider.setResponses([fauxAssistantMessage('ready')]);
  return provider;
}
async function runtime(options: Partial<RuntimeBootstrapOptions> = {}) {
  const result = await createRuntime({
    providers: [faux().provider],
    env: {},
    host: standaloneHost({ PATH: process.env.PATH }),
    // The shell the native worker would pick here: /bin/bash on Unix, the
    // installed Git Bash on Windows, so the bash tool is exercised on both.
    tools: { cwd: dir, shellPath: resolveWorkerShell(process.env as Record<string, string>) },
    ...options,
  });
  runtimes.push(result);
  return result;
}
async function call(
  r: RuntimeHandle,
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
) {
  const tool = r.ctx.runtimeTools.list().find((tool) => tool.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool.execute(`test-${name}`, params, signal);
}
const content = (result: Awaited<ReturnType<typeof call>>) =>
  result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

describe('native tools', () => {
  it('can disable review recording without changing writes', async () => {
    const r = await runtime({
      permissions: { gear: 'auto' },
      tools: { cwd: dir, recordFileChanges: false },
    });
    const output = await call(r, 'write', { path: 'flag.txt', content: 'written' });
    expect(reviewFromToolResult(output)).toBeUndefined();
    expect(await readFile(join(dir, 'flag.txt'), 'utf8')).toBe('written');
  });
  it('records real Write overwrites and Edit contents under the file lock', async () => {
    const r = await runtime({ permissions: { gear: 'auto' } });
    const created = await call(r, 'write', { path: 'review.txt', content: 'pong\n' });
    expect(reviewFromToolResult(created)).toMatchObject({
      status: 'added',
      patch: '@@ -0,0 +1,1 @@\n+pong',
    });
    const overwritten = await call(r, 'write', { path: 'review.txt', content: 'pong\nabc\n' });
    expect(reviewFromToolResult(overwritten)).toMatchObject({
      status: 'modified',
      patch: '@@ -1,1 +1,2 @@\n pong\n+abc',
    });
    const edited = await call(r, 'edit', {
      path: 'review.txt',
      edits: [{ oldText: 'abc', newText: 'xyz' }],
    });
    expect(reviewFromToolResult(edited)?.patch).toContain('-abc\n+xyz');
    await expect(
      call(r, 'edit', { path: 'review.txt', edits: [{ oldText: 'absent', newText: 'oops' }] })
    ).rejects.toMatchObject({ code: 'edit_not_unique' });
    expect(await readFile(join(dir, 'review.txt'), 'utf8')).toBe('pong\nxyz\n');
    expect(reviewFromToolResult(created)?.patch).not.toContain('xyz');
  });
  it.each([
    ['ask', 'read', 'allow'],
    ['ask', 'write', 'ask'],
    ['ask', 'edit', 'ask'],
    ['ask', 'bash', 'ask'],
    ['accept-edits', 'read', 'allow'],
    ['accept-edits', 'write', 'allow'],
    ['accept-edits', 'edit', 'allow'],
    ['accept-edits', 'bash', 'allow'],
    ['auto', 'read', 'allow'],
    ['auto', 'write', 'allow'],
    ['auto', 'edit', 'allow'],
    ['auto', 'bash', 'allow'],
  ] as const)('evaluates agent / %s / %s as %s', async (gear, tool, expected) => {
    const r = await runtime({ permissions: { mode: 'agent', gear } });
    expect(
      r.permissions?.evaluate({
        tool,
        toolCallId: 'matrix',
        path: join(dir, 'a'),
        command: tool === 'bash' ? 'pwd' : undefined,
      })
    ).toBe(expected);
  });
  it.each([
    ['readonly', 'plan', 'ask'],
    ['pragmatic', 'agent', 'ask'],
    ['handsoff', 'agent', 'accept-edits'],
    ['fullopen', 'agent', 'auto'],
  ] as const)('migrates %s into %s / %s', async (tier, mode, gear) => {
    expect(migratePermissionTier(tier)).toEqual({ mode, gear });
    const r = await runtime({ permissions: { tier } });
    expect(r.permissions).toMatchObject({ mode, gear });
  });
  it.each([
    'ask',
    'accept-edits',
    'auto',
  ] as const)('crops write tools in plan / %s, including cached plugin handles', async (gear) => {
    const r = await runtime({ permissions: { gear } });
    let writes = 0;
    r.ctx.runtimeTools.register({
      name: 'plugin-write',
      label: 'Plugin write',
      description: 'Write fixture',
      parameters: Type.Object({}),
      execute: async () => {
        writes++;
        return { content: [], details: {} };
      },
    });
    const cached = r.ctx.runtimeTools
      .list()
      .filter((tool) => ['write', 'edit', 'plugin-write'].includes(tool.name));
    r.permissions?.configure({ mode: 'plan' });
    // `new_context` survives the crop on purpose: it changes no environment
    // state, and read-only exploration burns the window like anything else.
    expect(r.ctx.runtimeTools.list().map((tool) => tool.name)).toEqual([
      'read',
      'bash',
      'glob',
      'grep',
      'new_context',
    ]);
    for (const tool of cached)
      await expect(tool.execute('cached', {})).rejects.toMatchObject({
        code: 'tool_unavailable_in_mode',
      });
    expect(writes).toBe(0);
    r.permissions?.configure({ mode: 'agent' });
    expect(r.ctx.runtimeTools.list()).toHaveLength(8);
  });
  it('allows workspace bash in accept-edits but asks for external directories', async () => {
    let approvals = 0;
    const r = await runtime({
      permissions: {
        gear: 'accept-edits',
        approve: async () => {
          approvals++;
          return 'deny';
        },
      },
    });
    expect(content(await call(r, 'bash', { command: 'printf local' }))).toContain('local');
    expect(approvals).toBe(0);
    await expect(call(r, 'bash', { command: 'cd .. && pwd' })).rejects.toMatchObject({
      code: 'tool_denied',
    });
    expect(approvals).toBe(1);
    r.permissions?.configure({ gear: 'ask' });
    await expect(call(r, 'bash', { command: 'pwd' })).rejects.toMatchObject({
      code: 'tool_denied',
    });
    expect(approvals).toBe(2);
  });
  it('allows only inspection bash in plan mode regardless of gear', async () => {
    const r = await runtime({ permissions: { mode: 'plan', gear: 'auto' } });
    expect(content(await call(r, 'bash', { command: 'pwd' }))).toContain(dir);
    for (const command of [
      'touch changed',
      'echo hi > changed',
      'pwd & touch changed',
      'file -C',
      'rg --pre=touch hi',
      'git diff --output=changed',
    ]) {
      await expect(call(r, 'bash', { command })).rejects.toMatchObject({ code: 'tool_denied' });
    }
  });
  it('contributes D14 mode and gear to the fixed prompt slots', () => {
    const prompt = composeSystemPrompt([
      permissionGearSegment('accept-edits'),
      modeSegment('plan'),
    ]);
    expect(prompt.segments.map((segment) => segment.slot)).toEqual(['mode', 'permission-gear']);
    expect(prompt.text).toContain('Bash is for inspection only');
    expect(prompt.text).toContain('bash calls are allowed without ordinary approval');
  });
  it('registers the six file/shell/search schemas plus new_context, and rejects invalid arguments', async () => {
    const r = await runtime();
    expect(r.ctx.runtimeTools.list().map((tool) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'bash',
      'glob',
      'grep',
      // Contributed by the compaction service, not this plugin (P1-9 / P2-8).
      'new_context',
    ]);
    await expect(call(r, 'read', { path: 'a', limit: -1 })).rejects.toMatchObject({
      code: 'invalid_tool_arguments',
    });
    for (const tool of r.ctx.runtimeTools.list())
      expect(tool.parameters).toMatchObject({ type: 'object' });
  });
  it('writes and edits after authorization and does not partially apply a failed edit set', async () => {
    const r = await runtime({ permissions: { gear: 'accept-edits' } });
    await call(r, 'write', { path: 'sub/file', content: 'alpha beta' });
    await call(r, 'edit', { path: 'sub/file', edits: [{ oldText: 'alpha', newText: 'amber' }] });
    expect(content(await call(r, 'read', { path: 'sub/file' }))).toBe('amber beta');
    await expect(
      call(r, 'edit', {
        path: 'sub/file',
        edits: [
          { oldText: 'amber', newText: 'changed' },
          { oldText: 'missing', newText: 'x' },
        ],
      })
    ).rejects.toMatchObject({ code: 'edit_not_unique' });
    expect(await readFile(join(dir, 'sub/file'), 'utf8')).toBe('amber beta');
  });
  it('keeps multibyte read continuation offsets valid', async () => {
    await writeFile(join(dir, 'a'), 'abc中def\nsecond\nthird');
    const r = await runtime();
    const first = await call(r, 'read', { path: 'a', limit: 1 });
    expect(first.details).toMatchObject({ truncated: true, nextOffset: 2 });
    expect(content(await call(r, 'read', { path: 'a', offset: 2, limit: 1 }))).toContain('second');
  });
  it('requires approval for writes, denies secrets in auto, and crops plan mutation', async () => {
    const r = await runtime();
    await expect(call(r, 'write', { path: 'a', content: 'no' })).rejects.toMatchObject({
      code: 'tool_denied',
    });
    r.permissions?.configure({ gear: 'auto' });
    await expect(call(r, 'bash', { command: 'cat .env' })).rejects.toMatchObject({
      code: 'tool_denied',
    });
    await expect(call(r, 'write', { path: '.env', content: 'no' })).rejects.toMatchObject({
      code: 'tool_denied',
    });
    await call(r, 'write', { path: '.env.example', content: 'example' });
    r.permissions?.configure({ mode: 'plan' });
    expect(r.ctx.runtimeTools.list().some((tool) => tool.name === 'write')).toBe(false);
  });
  it('gates symlink escape before writing a new child', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'runtime-outside-'));
    try {
      await symlink(outside, join(dir, 'link'), 'dir');
      const r = await runtime({ permissions: { gear: 'accept-edits' } });
      await expect(call(r, 'write', { path: 'link/new', content: 'no' })).rejects.toMatchObject({
        code: 'tool_denied',
      });
      await expect(readFile(join(outside, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  it('searches with bounded literal matching and skips secret files', async () => {
    await writeFile(join(dir, 'a.ts'), 'hello\nHELLO');
    await writeFile(join(dir, '.env'), 'hello-secret');
    const r = await runtime();
    expect(content(await call(r, 'glob', { pattern: '**/*.ts' }))).toContain('a.ts');
    const found = content(await call(r, 'grep', { pattern: 'hello', caseInsensitive: true }));
    expect(found).toContain('a.ts:1:hello');
    expect(found).toContain('a.ts:2:HELLO');
    expect(found).not.toContain('secret');
  });
  it('runs an approved bash command through exec with cwd and timeout', async () => {
    const r = await runtime({ permissions: { approve: async () => 'allow-once' } });
    const output = content(await call(r, 'bash', { command: 'printf amber; pwd' }));
    expect(output).toContain(`amber${dir}`);
    expect(content(await call(r, 'bash', { command: 'sleep 5', timeoutMs: 50 }))).toContain(
      'timeout'
    );
  });
  it('supports exact session grants and clears them on settings change', async () => {
    let approvals = 0;
    const r = await runtime({
      permissions: {
        approve: async () => {
          approvals++;
          return 'allow-session';
        },
      },
    });
    await call(r, 'write', { path: 'a', content: '1' });
    await call(r, 'write', { path: 'a', content: '2' });
    expect(approvals).toBe(1);
    await call(r, 'write', { path: 'b', content: '3' });
    expect(approvals).toBe(2);
    r.permissions?.configure({ gear: 'ask' });
    await call(r, 'write', { path: 'a', content: '4' });
    expect(approvals).toBe(3);
  });
  it('denies on approval timeout even when an external approver never settles', async () => {
    const r = await runtime({
      permissions: { timeoutMs: 20, approve: () => new Promise(() => {}) },
    });
    await expect(call(r, 'write', { path: 'a', content: 'no' })).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });
  it('reuses Extension UI request/respond and cancellation without renderer changes', async () => {
    const requests: ExtensionUiRequest[] = [];
    const r = await runtime({
      approvalUi: {
        onRequest: (request) => {
          requests.push(request);
        },
      },
    });
    const writing = call(r, 'write', { path: 'a', content: 'yes' });
    await expect.poll(() => requests.length).toBe(1);
    const request = requests[0];
    expect(request.method).toBe('select');
    r.approval?.bridge.respond({
      runtimeId: request.runtimeId,
      uiRequestId: request.uiRequestId,
      ok: true,
      value: '允许一次',
    });
    await writing;
    expect(await readFile(join(dir, 'a'), 'utf8')).toBe('yes');
    const controller = new AbortController();
    const next = call(r, 'write', { path: 'b', content: 'no' }, controller.signal);
    await expect.poll(() => requests.length).toBe(2);
    controller.abort();
    await expect(next).rejects.toMatchObject({ code: 'tool_denied' });
    expect(r.approval?.bridge.pendingCount()).toBe(0);
  });
  it('enforces tool whitelist and path deny scopes before grants', async () => {
    const r = await runtime({
      permissions: {
        gear: 'auto',
        allowedTools: ['read', 'write'],
        scopes: [{ root: dir, tools: ['write'], action: 'deny' }],
      },
    });
    await expect(call(r, 'write', { path: 'a', content: 'no' })).rejects.toMatchObject({
      code: 'tool_denied',
    });
    await expect(call(r, 'bash', { command: 'pwd' })).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });
  it('executes a model tool call and continuation through the native registry', async () => {
    await writeFile(join(dir, 'a'), 'amber');
    const provider = faux();
    const toolMessage = fauxAssistantMessage('');
    toolMessage.content = [
      { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'a' } },
    ];
    toolMessage.stopReason = 'toolUse';
    const answer = fauxAssistantMessage('amber');
    provider.setResponses([toolMessage, answer]);
    const r = await runtime({ providers: [provider.provider] });
    const result = await r.run({ prompt: 'read a', systemPrompt: 'Use read.' });
    expect(result.success).toBe(true);
    expect(result.turns).toBe(2);
    expect(result.text).toBe('amber');
    expect(result.trace.steps.filter((step) => step.type === 'tool')).toHaveLength(2);
    const perTurn = result.trace.steps
      .filter((step) => step.type === 'llm')
      .map((step) => step.detail.usage as { input: number });
    expect(perTurn).toHaveLength(2);
    expect(result.usage?.input).toBe(perTurn[0].input + perTurn[1].input);
    expect(result.usage?.input).toBeGreaterThan(perTurn[1].input);
    const decision = result.trace.steps.find((step) => step.detail.event === 'permission_decision');
    expect(decision?.detail).toMatchObject({ mode: 'agent', gear: 'ask' });
    expect(result.trace.version_stamp).toMatchObject({ mode: 'agent', permission_gear: 'ask' });
  });
  it('preserves the baseline line 2101 pagination and reports truncation', async () => {
    await writeFile(
      join(dir, 'archive'),
      Array.from({ length: 2200 }, (_, i) =>
        i === 2100 ? 'TAIL_MARKER=AMBER' : `line ${i + 1}: ${'x'.repeat(80)}`
      ).join('\n')
    );
    const r = await runtime();
    const first = await call(r, 'read', { path: 'archive' });
    expect(first.details).toMatchObject({ truncated: true });
    expect(content(await call(r, 'read', { path: 'archive', offset: 2101, limit: 3 }))).toContain(
      'TAIL_MARKER=AMBER'
    );
  });
  it('applies deny scopes inside recursive grep instead of only checking the root', async () => {
    await writeFile(join(dir, 'private.txt'), 'hidden');
    const r = await runtime({
      permissions: {
        scopes: [{ root: join(dir, 'private.txt'), tools: ['grep'], action: 'deny' }],
      },
    });
    expect(content(await call(r, 'grep', { pattern: 'hidden' }))).not.toContain('hidden');
  });
});
