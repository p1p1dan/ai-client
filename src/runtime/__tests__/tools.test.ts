import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtensionUiRequest } from '../../agent-host/extensionUiBridge.ts';
import { reviewFromToolResult } from '../../shared/sessionFileChange.ts';
import { migratePermissionTier } from '../../shared/types/runtimePermission.ts';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import type { RuntimeHostIoService, RuntimeReadOptions, RuntimeReadResult } from '../contracts.ts';
import { standaloneHost } from '../host/config.ts';
import { resolveWorkerShell } from '../host/shell.ts';
import { modeSegment, permissionGearSegment } from '../plugins/permissions/prompt.ts';
import { composeSystemPrompt } from '../plugins/prompt/segments.ts';
import { TOOL_OUTPUT_BYTES } from '../plugins/tools/index.ts';
import { readLines } from '../plugins/tools/read-lines.ts';

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
  it('skips a dangling symlink instead of failing the whole search (tools-01)', async () => {
    await writeFile(join(dir, 'real.ts'), 'hello world');
    // Points at a target that was never created: realpath on this entry throws
    // ENOENT, which used to abort glob/grep entirely instead of skipping it.
    await symlink(join(dir, 'does-not-exist'), join(dir, 'dangling.ts'), 'file');
    const r = await runtime();
    expect(content(await call(r, 'glob', { pattern: '**/*.ts' }))).toContain('real.ts');
    expect(content(await call(r, 'grep', { pattern: 'hello' }))).toContain('real.ts:1:hello world');
  });
  it('skips a directory it cannot read instead of failing the whole search (tools-01)', async () => {
    await writeFile(join(dir, 'ok.ts'), 'visible');
    const blocked = join(dir, 'blocked');
    await mkdir(blocked);
    await writeFile(join(blocked, 'secret.ts'), 'hidden');
    const r = await runtime();
    // Fake HostIo error: EACCES on one directory, real IO for everything else.
    // Avoids chmod on a real directory, which a root-run test suite would not
    // actually deny.
    const original = r.ctx.runtimeHostIo.readDirectory.bind(r.ctx.runtimeHostIo);
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    r.ctx.runtimeHostIo.readDirectory = (path: string) =>
      path === blocked
        ? { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(eacces) }) }
        : original(path);
    const found = content(await call(r, 'glob', { pattern: '**/*.ts' }));
    expect(found).toContain('ok.ts');
    expect(found).not.toContain('secret.ts');
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
      value: 'Allow once',
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
  it('caps a write tool permission preview before it reaches the trace (permissions-12)', async () => {
    // The approval card is meant to show the write verbatim (up to 8 MiB), so
    // `write` never truncates its own preview. The trace copy the agent loop's
    // activity listener writes must cap it independently.
    const provider = faux();
    const bigContent = `${'A'.repeat(5000)}TAIL_MARKER`;
    const toolMessage = fauxAssistantMessage('');
    toolMessage.content = [
      {
        type: 'toolCall',
        id: 'write-1',
        name: 'write',
        arguments: { path: 'big.txt', content: bigContent },
      },
    ];
    toolMessage.stopReason = 'toolUse';
    const answer = fauxAssistantMessage('done');
    provider.setResponses([toolMessage, answer]);
    const r = await runtime({ providers: [provider.provider], permissions: { gear: 'auto' } });
    const result = await r.run({ prompt: 'write a big file', systemPrompt: 'Use write.' });
    expect(result.success).toBe(true);
    // The tool itself still got — and wrote — the full, untruncated content.
    expect(await readFile(join(dir, 'big.txt'), 'utf8')).toBe(bigContent);
    const decision = result.trace.steps.find((step) => step.detail.event === 'permission_decision');
    const preview = (decision?.detail as { request?: { preview?: { text: string } } } | undefined)
      ?.request?.preview?.text;
    expect(preview).toBeDefined();
    expect((preview as string).length).toBeLessThanOrEqual(4001);
    expect(preview).not.toContain('TAIL_MARKER');
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
  it('keeps the read continuation line when the byte budget is full (tools-03/13)', async () => {
    await writeFile(
      join(dir, 'archive'),
      Array.from({ length: 2200 }, (_, i) => `line ${i + 1}: ${'x'.repeat(80)}`).join('\n')
    );
    const r = await runtime();
    const first = await call(r, 'read', { path: 'archive' });
    const text = content(first);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TOOL_OUTPUT_BYTES);
    // The body filled the window, so the old code cut this tail off entirely.
    expect(text).not.toContain('[output truncated]');
    const tail = text.match(/\n\[truncated; next line=(\d+)([^\]]*)\]$/);
    expect(tail).not.toBeNull();
    const next = Number((tail as RegExpMatchArray)[1]);
    expect(next).toBeGreaterThan(400);
    expect(first.details).toMatchObject({ truncated: true, nextOffset: next });
    // tools-13: nothing in this fixture is a long line — every row is 89 bytes.
    expect((tail as RegExpMatchArray)[2]).toContain('byte budget filled mid-line');
    expect(text).not.toContain('single line exceeds byte budget');
    expect(content(await call(r, 'read', { path: 'archive', offset: next, limit: 1 }))).toContain(
      `line ${next}: `
    );
  });
  it('keeps the bash exit tail when output fills the budget (tools-03)', async () => {
    await writeFile(join(dir, 'big.txt'), 'a'.repeat(60 * 1024));
    const r = await runtime({ permissions: { gear: 'auto' } });
    const output = await call(r, 'bash', { command: 'cat big.txt' });
    const text = content(output);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TOOL_OUTPUT_BYTES);
    expect(text).toContain('[output truncated]');
    expect(text.trimEnd().endsWith(']')).toBe(true);
    expect(text).toMatch(/\n\[exit=0; [a-z-]+; output truncated\]$/);
    expect(output.details).toMatchObject({ exitCode: 0, truncated: true });
  });
  it('advances past a line larger than the whole budget (tools-04)', async () => {
    await writeFile(join(dir, 'min.js'), `${'x'.repeat(60 * 1024)}\nsecond line\n`);
    const r = await runtime();
    const first = await call(r, 'read', { path: 'min.js' });
    // Pointing back at line 1 would hand out the same bytes forever.
    expect(first.details).toMatchObject({ truncated: true, longLine: true, nextOffset: 2 });
    expect(content(first)).toContain('line 1 alone exceeds the byte budget');
    expect(content(await call(r, 'read', { path: 'min.js', offset: 2 }))).toContain('second line');
  });
  it('says so instead of returning an empty text block (tools-02)', async () => {
    await writeFile(join(dir, 'empty.txt'), '');
    const r = await runtime();
    expect(content(await call(r, 'read', { path: 'empty.txt' }))).toBe('(empty file)');
    expect(content(await call(r, 'grep', { pattern: 'absent-needle' }))).toBe('No matches found.');
    expect(content(await call(r, 'glob', { pattern: '*.nope' }))).toBe('No files matched.');
  });
  it('puts only scalars in bash details and no second copy of read text (tools-06)', async () => {
    await writeFile(join(dir, 'a.txt'), 'amber\n');
    const r = await runtime({ permissions: { gear: 'auto' } });
    const shell = await call(r, 'bash', { command: 'printf hello' });
    expect(shell.details).toMatchObject({
      exitCode: 0,
      termination: 'exit',
      stdoutBytes: 5,
      stderrBytes: 0,
      truncated: false,
    });
    expect(shell.details).not.toHaveProperty('stdout');
    expect(shell.details).not.toHaveProperty('stderr');
    // A Uint8Array survives JSON as one key per byte; this is what guards it.
    expect(JSON.stringify(shell.details)).not.toContain('"0"');
    const read = await call(r, 'read', { path: 'a.txt' });
    expect(read.details).not.toHaveProperty('text');
    expect(read.details).toMatchObject({ bytes: 6, truncated: false });
  });
  it('matches a separator-free glob at any depth, including a file root (tools-08)', async () => {
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'a.ts'), 'needle here\n');
    const r = await runtime();
    expect(content(await call(r, 'glob', { pattern: '*.ts' }))).toContain(join('src', 'a.ts'));
    expect(content(await call(r, 'grep', { pattern: 'needle', include: '*.ts' }))).toContain(
      'a.ts:1:needle here'
    );
    // The search root itself is the file: relative() is empty, matching nothing.
    expect(content(await call(r, 'glob', { path: 'src/a.ts', pattern: '*.ts' }))).toContain('a.ts');
    expect(
      content(await call(r, 'grep', { path: 'src/a.ts', pattern: 'needle', include: '*.ts' }))
    ).toContain('a.ts:1:needle here');
  });
  it('checks for cancellation inside the grep line scan (tools-09)', async () => {
    // One file only: walk checks the signal per directory entry, so a second
    // file would abort the search without the scan ever looking.
    await writeFile(
      join(dir, 'only.txt'),
      Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n')
    );
    const r = await runtime();
    const controller = new AbortController();
    const signal = controller.signal;
    const throwIfAborted = signal.throwIfAborted.bind(signal);
    let scanning = false;
    const readFile = r.ctx.runtimeHostIo.readFile.bind(r.ctx.runtimeHostIo);
    r.ctx.runtimeHostIo.readFile = async (path, options) => {
      const data = await readFile(path, options);
      if (path.endsWith('only.txt')) scanning = true;
      return data;
    };
    // Stop pressed once the file's bytes are in hand: the next check that can
    // observe it is the one inside the line loop.
    Object.defineProperty(signal, 'throwIfAborted', {
      value: () => {
        if (scanning) controller.abort();
        throwIfAborted();
      },
    });
    await expect(call(r, 'grep', { pattern: 'l1' }, signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
  it('stops a backtracking regular expression on its time budget (tools-09)', async () => {
    // Each line costs tens of milliseconds to reject; unbounded, the scan runs
    // for the better part of a minute and nothing can interrupt it.
    await writeFile(
      join(dir, 'slow.txt'),
      Array.from({ length: 800 }, () => `${'a'.repeat(22)}!`).join('\n')
    );
    const r = await runtime();
    const started = Date.now();
    const output = await call(r, 'grep', { pattern: '^(a+)+$', regex: true });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(output.details).toMatchObject({ timedOut: true, truncated: true });
    expect(content(output)).toContain('too slow');
  }, 60_000);
  it('keeps the BOM an edit never asked to remove (tools-05)', async () => {
    await writeFile(join(dir, 'bom.ts'), '﻿const a = 1;\n');
    const r = await runtime({ permissions: { gear: 'auto' } });
    const edited = await call(r, 'edit', {
      path: 'bom.ts',
      edits: [{ oldText: 'const a = 1;', newText: 'const a = 2;' }],
    });
    const bytes = await readFile(join(dir, 'bom.ts'));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString('utf8')).toBe('﻿const a = 2;\n');
    // The review sees the same text the tool wrote, BOM included.
    expect(reviewFromToolResult(edited)?.patch).toContain('const a = 2;');
  });
  it('reports a non-UTF-8 file with a code instead of a platform TypeError (tools-12)', async () => {
    await writeFile(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x0a]));
    const r = await runtime({ permissions: { gear: 'auto' } });
    await expect(call(r, 'read', { path: 'logo.png' })).rejects.toMatchObject({
      code: 'io_not_utf8',
    });
    await expect(
      call(r, 'edit', { path: 'logo.png', edits: [{ oldText: 'a', newText: 'b' }] })
    ).rejects.toMatchObject({ code: 'io_not_utf8' });
  });
  it('drops the carriage return of a CRLF file before matching (tools-17)', async () => {
    await writeFile(join(dir, 'crlf.txt'), 'first TODO\r\nsecond line\r\n');
    const r = await runtime();
    const found = content(await call(r, 'grep', { pattern: 'TODO$', regex: true }));
    expect(found).toContain('crlf.txt:1:first TODO');
    expect(found).not.toContain('\r');
  });
  it('does not call a search truncated when it exactly fills the limit (tools-14)', async () => {
    for (const name of ['a.ts', 'b.ts', 'c.ts']) await writeFile(join(dir, name), 'needle here\n');
    const r = await runtime();
    const exact = await call(r, 'glob', { pattern: '*.ts', limit: 3 });
    expect(exact.details).toMatchObject({ truncated: false });
    expect(content(exact)).not.toContain('search truncated');
    const capped = await call(r, 'glob', { pattern: '*.ts', limit: 2 });
    expect(capped.details).toMatchObject({ truncated: true });
    expect(content(capped)).toContain('search truncated');
    const exactGrep = await call(r, 'grep', { pattern: 'needle', limit: 3 });
    expect(exactGrep.details).toMatchObject({ truncated: false });
    expect(content(exactGrep).split('\n')).toHaveLength(3);
    const cappedGrep = await call(r, 'grep', { pattern: 'needle', limit: 2 });
    expect(cappedGrep.details).toMatchObject({ truncated: true });
    expect(content(cappedGrep)).toContain('search truncated');
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

describe('read line scanning', () => {
  const LINE_BYTES = 200;
  const LINES = 5000;
  const BUDGET = TOOL_OUTPUT_BYTES - 128;
  const file = Buffer.from(`${'x'.repeat(LINE_BYTES - 1)}\n`.repeat(LINES));
  /** Counts the windows `readLines` asks for, and labels every answer `source`. */
  function countingIo(source: RuntimeReadResult['source']) {
    const windows: number[] = [];
    const io = {
      readFile: (_path: string, options: RuntimeReadOptions): Promise<RuntimeReadResult> => {
        windows.push(options.maxBytes);
        const offset = options.offset ?? 0;
        const slice = file.subarray(offset, offset + options.maxBytes + 1);
        return Promise.resolve({
          bytes: slice.subarray(0, options.maxBytes),
          truncated: slice.length > options.maxBytes,
          source,
        });
      },
    } as unknown as RuntimeHostIoService;
    return { io, windows };
  }
  it('widens the window for helper-backed reads only (tools-10)', async () => {
    const plain = countingIo('direct');
    const helper = countingIo('node-fallback');
    // Skipping to a late line is the case that scans: every chunk before the
    // first printed line is pure overhead, and on a TSD file each one restarts
    // the helper process and re-decrypts the file from byte 0.
    const expected = await readLines(plain.io, '/scan', 4500, 2000, BUDGET);
    const actual = await readLines(helper.io, '/scan', 4500, 2000, BUDGET);
    expect(actual).toEqual(expected);
    expect(expected.truncated).toBe(true);
    expect(new Set(plain.windows)).toEqual(new Set([32 * 1024]));
    expect(plain.windows.length).toBeGreaterThan(25);
    expect(helper.windows[0]).toBe(32 * 1024);
    expect(helper.windows.length).toBeLessThanOrEqual(6);
    expect(Math.max(...helper.windows)).toBeLessThanOrEqual(2 * 1024 * 1024);
    // Paging on with nextOffset is what the read tool tells the model to do, so
    // the second page must stay bounded too rather than rescan in 32 KiB steps.
    const next = countingIo('node-fallback');
    const page = await readLines(next.io, '/scan', actual.nextOffset, 2000, BUDGET);
    expect(page.text).not.toBe(actual.text);
    expect(next.windows.length).toBeLessThanOrEqual(6);
  });
});
