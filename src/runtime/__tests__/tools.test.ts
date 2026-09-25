import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewFromToolResult } from '../../shared/sessionFileChange.ts';
import { migratePermissionTier } from '../../shared/types/runtimePermission.ts';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import type { RuntimeHostIoService, RuntimeReadOptions, RuntimeReadResult } from '../contracts.ts';
import { standaloneHost } from '../host/config.ts';
import type { ExecPlugin } from '../host/exec.ts';
import { resolveWorkerShell } from '../host/shell.ts';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TURN_STORED_BYTES,
} from '../plugins/agent-loop/attachments.ts';
import { modeSegment, permissionGearSegment } from '../plugins/permissions/prompt.ts';
import { composeSystemPrompt } from '../plugins/prompt/segments.ts';
import { TOOL_OUTPUT_BYTES } from '../plugins/tools/index.ts';
import { stoppedToolOutcome } from '../plugins/tools/outcome.ts';
import { readLines } from '../plugins/tools/read-lines.ts';
import { neverAsked } from './fixtures/approval.ts';

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
    permissions: { approve: neverAsked, ...options.permissions },
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
    ['bypass', 'read', 'allow'],
    ['bypass', 'write', 'allow'],
    ['bypass', 'edit', 'allow'],
    ['bypass', 'bash', 'allow'],
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
    // The gear that answers every prompt still cannot add a tool plan mode
    // took away: the crop happens before any gear is consulted.
    'bypass',
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
  // T039 — the Windows behaviours, exercised on Linux. Each one is a property
  // of the tool layer that only BITES on Windows, so the trigger is faked (a
  // host with no shell, a CRLF fixture, an explicit console code page) rather
  // than the platform.
  it('does not advertise bash on a host that has no shell (windows-04)', async () => {
    // What a Windows box without Git for Windows looks like: `resolveWorkerShell`
    // finds no bash.exe, so `shellPath` is absent.
    const headless = await runtime({ tools: { cwd: dir } });
    expect(headless.ctx.runtimeTools.list().map((tool) => tool.name)).not.toContain('bash');
    const equipped = await runtime();
    expect(equipped.ctx.runtimeTools.list().map((tool) => tool.name)).toContain('bash');
  });
  it('edits a CRLF file without flattening its line endings (windows-05)', async () => {
    const r = await runtime({ permissions: { gear: 'accept-edits' } });
    const original = 'const timeout = 30;\r\nconst retries = 2;\r\nexport default timeout;\r\n';
    await writeFile(join(dir, 'app.ts'), original);
    // What a model sends back after quoting two lines: plain newlines.
    await call(r, 'edit', {
      path: 'app.ts',
      edits: [
        {
          oldText: 'const timeout = 30;\nconst retries = 2;',
          newText: 'const timeout = 60;\nconst retries = 3;',
        },
      ],
    });
    expect(await readFile(join(dir, 'app.ts'), 'utf8')).toBe(
      'const timeout = 60;\r\nconst retries = 3;\r\nexport default timeout;\r\n'
    );
    // A miss that is NOT about line endings still fails, and says the file is
    // CRLF so the model stops blaming its own quoting.
    await expect(
      call(r, 'edit', {
        path: 'app.ts',
        edits: [{ oldText: 'const absent = 1;\nconst other = 2;', newText: 'x' }],
      })
    ).rejects.toThrow(/CRLF/);
  });
  it('decodes command output with the console code page, not always UTF-8 (windows-09)', async () => {
    process.env.AICLIENT_CONSOLE_CODEPAGE = '936';
    try {
      const r = await runtime({ permissions: { gear: 'auto' } });
      // The bytes a cp936 native command writes for 张三. Decoded as UTF-8 they
      // are four replacement characters, which is what the model used to read.
      const output = content(await call(r, 'bash', { command: "printf '\\xd5\\xc5\\xc8\\xfd'" }));
      expect(output).toContain('张三');
      expect(output).not.toContain('\ufffd');
      // Git Bash writes UTF-8 whatever the console page says, and still does.
      expect(content(await call(r, 'bash', { command: "printf '\u5f20\u4e09'" }))).toContain(
        '张三'
      );
    } finally {
      delete process.env.AICLIENT_CONSOLE_CODEPAGE;
    }
  });
  it('keeps multibyte read continuation offsets valid', async () => {
    await writeFile(join(dir, 'a'), 'abc中def\nsecond\nthird');
    const r = await runtime();
    const first = await call(r, 'read', { path: 'a', limit: 1 });
    expect(first.details).toMatchObject({ truncated: true, nextOffset: 2 });
    expect(content(await call(r, 'read', { path: 'a', offset: 2, limit: 1 }))).toContain('second');
  });
  it('requires approval for writes, denies secrets in auto, and crops plan mutation', async () => {
    // An approver that always refuses: the claim is that the write REACHES the
    // gate, and a refusal is the visible half of that.
    const r = await runtime({ permissions: { approve: async () => 'deny' } });
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
      // `accept-edits` waves through writes inside the workspace, so a write
      // that lands outside it through a symlink has to be the one thing that
      // still asks — and this approver refuses it.
      const r = await runtime({
        permissions: { gear: 'accept-edits', approve: async () => 'deny' },
      });
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
  it('T146 — bash publishes execStartedAt via onUpdate, after approval and before exec runs', async () => {
    const order: string[] = [];
    const r = await runtime({
      permissions: {
        approve: async () => {
          order.push('approved');
          return 'allow-once';
        },
      },
    });
    const tool = r.ctx.runtimeTools.list().find((candidate) => candidate.name === 'bash');
    if (!tool) throw new Error('missing bash');
    const before = Date.now();
    const updates: unknown[] = [];
    const result = await tool.execute(
      'test-bash',
      { command: 'printf amber' },
      undefined,
      (partial) => {
        order.push('update');
        updates.push(partial);
      }
    );
    expect(content(result)).toContain('amber');
    // Exactly one update, strictly after the approval and before the caller
    // sees the settled result — the display's honest exec-start origin.
    expect(order).toEqual(['approved', 'update']);
    expect(updates).toHaveLength(1);
    const [update] = updates as [{ content: unknown[]; details: { execStartedAt: number } }];
    expect(update.content).toEqual([]);
    expect(update.details.execStartedAt).toBeGreaterThanOrEqual(before);
    expect(update.details.execStartedAt).toBeLessThanOrEqual(Date.now());
  });
  it('grants the approved file itself, and clears it on settings change', async () => {
    // This used to assert the EXACT CALL: approving `a` re-asked for `a` again
    // with different content, because the grant was the whole request
    // stringified. The grant is the FILE now — the same file for the same tool
    // stops asking, and the file beside it does not come along for the ride.
    let approvals = 0;
    const r = await runtime({
      permissions: {
        approve: async () => {
          approvals++;
          return 'allow-session';
        },
      },
    });
    await call(r, 'write', { path: 'nested/a', content: '1' });
    await call(r, 'write', { path: 'nested/a', content: '2' });
    expect(approvals).toBe(1);
    // ...and stops there: neither the sibling nor the subdirectory was on a card.
    await call(r, 'write', { path: 'nested/b', content: '3' });
    expect(approvals).toBe(2);
    await call(r, 'write', { path: 'nested/deep/c', content: '4' });
    expect(approvals).toBe(3);
    r.permissions?.configure({ gear: 'ask' });
    await call(r, 'write', { path: 'nested/a', content: '5' });
    expect(approvals).toBe(4);
  });
  it('denies on approval timeout even when an external approver never settles', async () => {
    const r = await runtime({
      permissions: { timeoutMs: 20, approve: () => new Promise(() => {}) },
    });
    await expect(call(r, 'write', { path: 'a', content: 'no' })).rejects.toMatchObject({
      code: 'tool_denied',
    });
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
    // Rewritten for the image branch: `read` now accepts a real PNG, so this
    // fixture is what it always was, a file whose PNG signature is broken.
    // Magic bytes decide, so the name does not make it an image, and the
    // refusal names what read does accept.
    await writeFile(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x0a]));
    const r = await runtime({ permissions: { gear: 'auto' } });
    const refused = await call(r, 'read', { path: 'logo.png' }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(refused).toMatchObject({ code: 'io_not_utf8' });
    expect((refused as Error).message).toContain('PNG, JPEG, GIF or WebP');
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
  // POSIX only: Windows has no mode that makes a file unreadable to its owner,
  // and running as root would read it anyway.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'skips a file it cannot read instead of failing the whole search (tsd-02)',
    async () => {
      await writeFile(join(dir, 'visible.txt'), 'needle here\n');
      const locked = join(dir, 'locked.txt');
      await writeFile(locked, 'needle here\n');
      await chmod(locked, 0o000);
      const r = await runtime();
      const output = await call(r, 'grep', { pattern: 'needle' });
      expect(content(output)).toContain('visible.txt');
      expect(content(output)).not.toContain('locked.txt');
      expect(output.details).toMatchObject({ skipped: 1 });
    }
  );
  it('skips a TSD container but searches a note that merely starts with the magic (tsd-02/tsd-07)', async () => {
    await writeFile(join(dir, 'visible.txt'), 'needle here\n');
    const sealed = Buffer.alloc(4096, 0x2a);
    Buffer.from('%TSD-Header-###%').copy(sealed, 0);
    await writeFile(join(dir, 'sealed.bin'), sealed);
    await writeFile(join(dir, 'note.md'), '%TSD-Header-###%\nneedle in a plain note\n');
    const r = await runtime();
    const output = await call(r, 'grep', { pattern: 'needle' });
    // One file the carrier cannot decrypt is one skipped file, not a failed
    // search; the note is plaintext that happens to open with those 16 bytes.
    expect(content(output)).toContain('visible.txt');
    expect(content(output)).toContain('note.md');
    expect(content(output)).not.toContain('sealed.bin');
    expect(output.details).toMatchObject({ skipped: 1 });
    await expect(call(r, 'read', { path: 'sealed.bin' })).rejects.toMatchObject({
      code: 'io_tsd_unavailable',
    });
    expect(content(await call(r, 'read', { path: 'note.md' }))).toContain('needle in a plain note');
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

/**
 * T130 — a bash command Stop cut short used to settle as a success: the exec
 * resolves `termination: 'aborted'` (it does not throw), and pi records every
 * non-throwing result `isError: false`. The tool now says so in
 * `details.stopped`; `stoppedToolOutcome` is the hook that turns it into the
 * error flag (wired and reverse-checked in `agentLoop.test.ts`).
 *
 * Real child processes throughout (engineering appendix B1): the command
 * writes a marker once its output is out, and the test aborts only after it
 * sees that marker.
 */
describe('T130 · a bash command Stop cut short', () => {
  const STARTED = 'printf a; : > started; sleep 5';
  async function waitForMarker(): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await access(join(dir, 'started'));
        return;
      } catch {
        if (Date.now() > deadline) throw new Error('the command never started');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  it('[BASH-STOP-1] flags an aborted command as stopped and keeps its partial output', async () => {
    const r = await runtime({ permissions: { gear: 'auto' } });
    const controller = new AbortController();
    const running = call(r, 'bash', { command: STARTED }, controller.signal);
    await waitForMarker();
    controller.abort();
    const result = await running;
    expect(result.details).toMatchObject({ termination: 'aborted', stopped: true });
    // Text and status tail unchanged: the model still sees what the command
    // printed before it was stopped.
    const text = content(result);
    expect(text.startsWith('a')).toBe(true);
    expect(text).toContain('; aborted]');
  });

  it('[BASH-STOP-1] flags a command the runtime tore down (disposed) as stopped too', async () => {
    const r = await runtime({ permissions: { gear: 'auto' } });
    const running = call(r, 'bash', { command: STARTED });
    await waitForMarker();
    await (r.ctx.runtimeExec as ExecPlugin).shutdown();
    const result = await running;
    expect(result.details).toMatchObject({ termination: 'disposed', stopped: true });
    expect(content(result).startsWith('a')).toBe(true);
  });

  it('[BASH-STOP-2] leaves a command that exited or timed out unflagged', async () => {
    const r = await runtime({ permissions: { gear: 'auto' } });
    // A non-zero exit is still the command's own outcome, not a stop.
    const exited = await call(r, 'bash', { command: 'printf done; exit 3' });
    expect(exited.details).toMatchObject({ termination: 'exit', exitCode: 3 });
    expect(exited.details).not.toHaveProperty('stopped');
    const timedOut = await call(r, 'bash', { command: 'sleep 5', timeoutMs: 50 });
    expect(timedOut.details).toMatchObject({ termination: 'timeout' });
    expect(timedOut.details).not.toHaveProperty('stopped');
    for (const result of [exited, timedOut])
      expect(stoppedToolOutcome({ result, isError: false })).toBeUndefined();
  });

  it('[BASH-STOP-2] the outcome hook flips only a literal `details.stopped: true`', () => {
    const result = (details: unknown) => ({ content: [], details });
    expect(stoppedToolOutcome({ result: result({ stopped: true }), isError: false })).toEqual({
      isError: true,
    });
    // TaskStop reports the delegations it stopped under the same key, and
    // that call succeeded.
    expect(
      stoppedToolOutcome({
        result: result({ stopped: [{ delegationId: 'd1', status: 'stopped' }], delivered: [] }),
        isError: false,
      })
    ).toBeUndefined();
    expect(
      stoppedToolOutcome({ result: result({ stopped: 'yes' }), isError: false })
    ).toBeUndefined();
    expect(stoppedToolOutcome({ result: result(undefined), isError: false })).toBeUndefined();
    // Already an error: nothing to override.
    expect(
      stoppedToolOutcome({ result: result({ stopped: true }), isError: true })
    ).toBeUndefined();
  });
});

/**
 * T1 — `read` returns PNG / JPEG / GIF / WebP files as images.
 *
 * Policy: what the user can paste, the agent can read. One image is capped at
 * the pasted-attachment limit and checked against `stat` before the body is
 * read; the images one run reads share the per-message attachment budget.
 */
describe('read images (T1)', () => {
  /** Real, decodable 1x1 images, the smallest well-known encodings. */
  const PIXELS = {
    png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    jpg: '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
    gif: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    webp: 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
  } as const;
  /** A PNG signature and IHDR chunk, zero-padded to `size` bytes. */
  function paddedPng(size: number): Buffer {
    const bytes = Buffer.alloc(size);
    Buffer.from(PIXELS.png, 'base64').copy(bytes, 0, 0, 33);
    return bytes;
  }
  /** Every HostIo read of `path`, by window size. */
  function spyReads(r: RuntimeHandle, path: string): number[] {
    const windows: number[] = [];
    const io = r.ctx.runtimeHostIo;
    const readFile = io.readFile.bind(io);
    io.readFile = async (target, options) => {
      if (target === path) windows.push(options.maxBytes);
      return readFile(target, options);
    };
    return windows;
  }
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error as Error & { code?: string }
    );

  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
  ] as const)('returns a 1x1 .%s as a %s image block', async (ext, mimeType) => {
    const bytes = Buffer.from(PIXELS[ext], 'base64');
    await writeFile(join(dir, `pixel.${ext}`), bytes);
    const r = await runtime();
    // offset/limit mean lines; an image ignores them rather than failing.
    const output = await call(r, 'read', { path: `pixel.${ext}`, offset: 3, limit: 1 });
    expect(output.content).toEqual([
      { type: 'text', text: `Read image file [${mimeType}] ${bytes.length} B 1x1` },
      { type: 'image', data: bytes.toString('base64'), mimeType },
    ]);
    expect(output.details).toEqual({
      path: join(dir, `pixel.${ext}`),
      bytes: bytes.length,
      mimeType,
      image: true,
    });
  });
  it('recognises a PNG with no extension by its bytes, after the text read fails', async () => {
    const bytes = Buffer.from(PIXELS.png, 'base64');
    await writeFile(join(dir, 'pixel'), bytes);
    const r = await runtime();
    const windows = spyReads(r, join(dir, 'pixel'));
    const output = await call(r, 'read', { path: 'pixel' });
    expect(output.content[1]).toEqual({
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: 'image/png',
    });
    // Text first (it is not UTF-8), then a bounded header sniff, then the body.
    expect(windows).toHaveLength(3);
    expect(windows[1]).toBeLessThanOrEqual(4096);
  });
  it('reads a .png holding text as text, and a text read pays for no extra IO', async () => {
    await writeFile(join(dir, 'notes.png'), 'not a picture\n');
    await writeFile(join(dir, 'notes.txt'), 'plain notes\n');
    const r = await runtime();
    const named = await call(r, 'read', { path: 'notes.png' });
    expect(content(named)).toBe('not a picture\n');
    expect(named.content.every((block) => block.type === 'text')).toBe(true);
    expect(named.details).not.toHaveProperty('image');
    const windows = spyReads(r, join(dir, 'notes.txt'));
    expect(content(await call(r, 'read', { path: 'notes.txt' }))).toBe('plain notes\n');
    expect(windows).toHaveLength(1);
  });
  it('refuses a non-image binary and names what read supports', async () => {
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80, 0x0a]));
    const r = await runtime();
    const error = await refusal(call(r, 'read', { path: 'blob.bin' }));
    expect(error).toMatchObject({ code: 'io_not_utf8' });
    expect(error?.message).toContain('UTF-8 text nor a PNG, JPEG, GIF or WebP image');
  });
  it('refuses an image over the per-image cap from stat, without reading the body', async () => {
    const size = ATTACHMENT_MAX_BYTES + 1;
    // Sparse past the header: the size is real, the disk cost is not.
    for (const name of ['big.png', 'big']) {
      await writeFile(join(dir, name), paddedPng(64));
      await truncate(join(dir, name), size);
    }
    const r = await runtime();
    for (const name of ['big.png', 'big']) {
      const windows = spyReads(r, join(dir, name));
      const error = await refusal(call(r, 'read', { path: name }));
      expect(error).toMatchObject({ code: 'io_limit' });
      expect(error?.message).toContain(`${size} bytes`);
      expect(error?.message).toContain(`${ATTACHMENT_MAX_BYTES} bytes`);
      // A header sniff (and, with no extension, the first text chunk) only.
      expect(windows.length).toBeGreaterThan(0);
      expect(Math.max(...windows)).toBeLessThanOrEqual(32 * 1024);
    }
  });
  it('refuses an image wider than a pasted image may be', async () => {
    // The provider rejects a side over 8000 px, and a tool result stays in
    // every later request, so it would fail the rest of the session.
    const wide = paddedPng(64);
    wide.writeUInt32BE(8001, 16);
    await writeFile(join(dir, 'wide.png'), wide);
    const r = await runtime();
    const error = await refusal(call(r, 'read', { path: 'wide.png' }));
    expect(error).toMatchObject({ code: 'io_limit' });
    expect(error?.message).toContain('8001x1');
  });
  it('stops a run from reading more images than one message may attach', async () => {
    // 3 MiB raw is exactly 4 MiB of base64, so two fill the 8 MiB budget.
    const raw = 3 * 1024 * 1024;
    expect(2 * 4 * (raw / 3)).toBe(ATTACHMENT_TURN_STORED_BYTES);
    for (const name of ['a.png', 'b.png', 'c.png'])
      await writeFile(join(dir, name), paddedPng(raw));
    const r = await runtime();
    expect(content(await call(r, 'read', { path: 'a.png' }))).toContain('Read image file');
    expect(content(await call(r, 'read', { path: 'b.png' }))).toContain('Read image file');
    const windows = spyReads(r, join(dir, 'c.png'));
    const error = await refusal(call(r, 'read', { path: 'c.png' }));
    expect(error).toMatchObject({ code: 'io_limit' });
    expect(error?.message).toContain('per-run image budget');
    expect(Math.max(...windows)).toBeLessThanOrEqual(4096);
    // Text is not image budget: the run can still read source files.
    await writeFile(join(dir, 'still.txt'), 'readable\n');
    expect(content(await call(r, 'read', { path: 'still.txt' }))).toBe('readable\n');
    // The next run starts a fresh budget; the agent loop is what begins one.
    await r.run({ prompt: 'next message', systemPrompt: 'probe' });
    expect(content(await call(r, 'read', { path: 'c.png' }))).toContain('Read image file');
  });
});

/**
 * tools-20 — the traversal itself, after the per-entry `realpath` came out.
 *
 * A Windows field run spent 50 s in one `glob` over a C++ workspace, because
 * every directory entry was resolved through the filesystem to answer a
 * question the walk had already settled: the root is canonical and a symlink
 * dirent is skipped rather than followed, so nothing below it can be anything
 * else. These cases pin what that removal must NOT change.
 */
describe('search traversal', () => {
  it('still refuses to follow a symlinked directory (tools-20)', async () => {
    await mkdir(join(dir, 'real'));
    await writeFile(join(dir, 'real', 'x.ts'), 'needle here\n');
    // Inside the root, so a containsPath check alone would wave it through: the
    // reason to skip it is that its contents are reachable under their own name
    // and would otherwise be reported (and grepped) twice.
    await symlink(join(dir, 'real'), join(dir, 'link'), 'dir');
    const r = await runtime();
    const found = content(await call(r, 'glob', { pattern: '**/*.ts' })).split('\n');
    expect(found).toEqual([join(dir, 'real', 'x.ts')]);
    expect(content(await call(r, 'grep', { pattern: 'needle' })).split('\n')).toHaveLength(1);
  });
  it('terminates on a symlink cycle back to an ancestor (tools-20)', async () => {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'x.ts'), 'needle here\n');
    await symlink(dir, join(dir, 'sub', 'loop'), 'dir');
    const r = await runtime();
    const output = await call(r, 'glob', { pattern: '**/*.ts' });
    expect(content(output).split('\n')).toEqual([join(dir, 'sub', 'x.ts')]);
    expect(output.details).toMatchObject({ truncated: false });
  });
  it('skips a directory that resolves outside the search root (tools-20)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'runtime-outside-'));
    try {
      await writeFile(join(outside, 'secret.ts'), 'needle here\n');
      await writeFile(join(dir, 'inside.ts'), 'needle here\n');
      const r = await runtime();
      // A host whose readDirectory reports a child that realpath then resolves
      // elsewhere — a junction on Windows, a bind mount on Linux. The walk now
      // checks that once per directory instead of once per entry, so this is
      // the case that proves the check survived.
      const original = r.ctx.runtimeHostIo.readDirectory.bind(r.ctx.runtimeHostIo);
      r.ctx.runtimeHostIo.readDirectory = (path: string) =>
        path === dir
          ? (async function* () {
              yield { name: 'inside.ts', kind: 'file' as const };
              yield { name: 'elsewhere', kind: 'directory' as const };
            })()
          : original(path);
      const realpath = r.ctx.runtimeHostIo.realpath.bind(r.ctx.runtimeHostIo);
      r.ctx.runtimeHostIo.realpath = (path: string) =>
        path === join(dir, 'elsewhere') ? Promise.resolve(outside) : realpath(path);
      const found = content(await call(r, 'glob', { pattern: '**/*.ts' }));
      expect(found).toContain('inside.ts');
      expect(found).not.toContain('secret.ts');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  it('stops at the entry budget even when nothing matches (tools-20)', async () => {
    await writeFile(join(dir, 'a.ts'), 'needle here\n');
    const r = await runtime();
    // 20 001 synthetic entries, so the cap is reached without writing that many
    // files. They are reported as symlinks: the walk counts an entry before it
    // decides what to do with it, which is exactly the counter under test, and
    // the cheap kind keeps the case off the permission gate 20 000 times.
    r.ctx.runtimeHostIo.readDirectory = () =>
      (async function* () {
        for (let i = 0; i < 20_001; i++) yield { name: `e${i}.ts`, kind: 'symlink' as const };
      })();
    const output = await call(r, 'glob', { pattern: '**/*.ts' });
    expect(output.details).toMatchObject({ truncated: true, visited: 20_001 });
    expect(content(output)).toContain('search truncated');
  });
});

describe('search gitignore', () => {
  async function tree() {
    await writeFile(join(dir, '.gitignore'), '# comment\nbuild/\n*.o\n!keep.o\n/dist\n');
    await writeFile(join(dir, 'main.cpp'), 'needle here\n');
    await writeFile(join(dir, 'stale.o'), 'needle here\n');
    await writeFile(join(dir, 'keep.o'), 'needle here\n');
    await mkdir(join(dir, 'build', 'deep'), { recursive: true });
    await writeFile(join(dir, 'build', 'deep', 'gen.cpp'), 'needle here\n');
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'dist', 'bundle.cpp'), 'needle here\n');
    await mkdir(join(dir, 'src', 'dist'), { recursive: true });
    // `/dist` is anchored to the file's own directory, so this one stays.
    await writeFile(join(dir, 'src', 'dist', 'kept.cpp'), 'needle here\n');
  }
  it('skips ignored directories and files by default', async () => {
    await tree();
    const r = await runtime();
    const output = await call(r, 'glob', { pattern: '**/*', limit: 1000 });
    const found = content(output);
    expect(found).toContain('main.cpp');
    expect(found).toContain(join('src', 'dist', 'kept.cpp'));
    // The negation wins because it comes after the rule that hid it.
    expect(found).toContain('keep.o');
    expect(found).not.toContain('gen.cpp');
    expect(found).not.toContain('bundle.cpp');
    expect(found).not.toContain('stale.o');
    // An ignored directory is one entry skipped, not one per file inside it.
    expect(output.details).toMatchObject({ ignored: 3 });
    const grepped = content(await call(r, 'grep', { pattern: 'needle' }));
    expect(grepped).toContain('main.cpp');
    expect(grepped).not.toContain('gen.cpp');
  });
  it('walks everything again when respectGitignore is false', async () => {
    await tree();
    const r = await runtime();
    const found = content(
      await call(r, 'glob', { pattern: '**/*', limit: 1000, respectGitignore: false })
    );
    expect(found).toContain('gen.cpp');
    expect(found).toContain('bundle.cpp');
    expect(found).toContain('stale.o');
    const grepped = content(await call(r, 'grep', { pattern: 'needle', respectGitignore: false }));
    expect(grepped).toContain('gen.cpp');
  });
  it('says why an empty search may be empty, and only then', async () => {
    await tree();
    const r = await runtime();
    // "No files matched" and "everything that matched is in an ignored build
    // directory" are the same three words otherwise, and the second one is what
    // sends the model to the shell.
    const empty = content(await call(r, 'glob', { pattern: 'gen.cpp' }));
    expect(empty).toContain('respectGitignore:false');
    const hit = content(await call(r, 'glob', { pattern: '**/*.cpp' }));
    expect(hit).toContain('main.cpp');
    expect(hit).not.toContain('respectGitignore:false');
  });
  it('applies a nested .gitignore only below its own directory', async () => {
    await mkdir(join(dir, 'a'));
    await mkdir(join(dir, 'b'));
    await writeFile(join(dir, 'a', '.gitignore'), 'notes.txt\n');
    await writeFile(join(dir, 'a', 'notes.txt'), 'needle here\n');
    await writeFile(join(dir, 'b', 'notes.txt'), 'needle here\n');
    const r = await runtime();
    const found = content(await call(r, 'glob', { pattern: '**/notes.txt' }));
    expect(found).toContain(join('b', 'notes.txt'));
    expect(found).not.toContain(join('a', 'notes.txt'));
  });
  it('searches the whole tree when the .gitignore cannot be read', async () => {
    await writeFile(join(dir, '.gitignore'), 'hidden.txt\n');
    await writeFile(join(dir, 'hidden.txt'), 'needle here\n');
    const r = await runtime();
    const original = r.ctx.runtimeHostIo.readFile.bind(r.ctx.runtimeHostIo);
    r.ctx.runtimeHostIo.readFile = (path: string, options: RuntimeReadOptions) =>
      path === join(dir, '.gitignore')
        ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }))
        : original(path, options);
    // Fail open: a search that cannot read the rules shows more files, never
    // fewer, and never fails outright.
    expect(content(await call(r, 'glob', { pattern: '**/hidden.txt' }))).toContain('hidden.txt');
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
  it('keeps fallback windows capped past 2 MiB (tsd-05)', async () => {
    // The existing case above uses a 1 MB sample, which never reaches the cap.
    // Past it the scan is linear in blocks of 2 MiB, not geometric, and that is
    // the regime a real encrypted log lands in.
    const CAP = 2 * 1024 * 1024;
    const big = Buffer.from(`${'y'.repeat(LINE_BYTES - 1)}\n`.repeat(44_000));
    const sized = (source: RuntimeReadResult['source']) => {
      const windows: number[] = [];
      const io = {
        readFile: (_path: string, options: RuntimeReadOptions): Promise<RuntimeReadResult> => {
          windows.push(options.maxBytes);
          const offset = options.offset ?? 0;
          const slice = big.subarray(offset, offset + options.maxBytes + 1);
          return Promise.resolve({
            bytes: slice.subarray(0, options.maxBytes),
            truncated: slice.length > options.maxBytes,
            source,
          });
        },
      } as unknown as RuntimeHostIoService;
      return { io, windows };
    };
    const plain = sized('direct');
    const helper = sized('node-fallback');
    const expected = await readLines(plain.io, '/scan', 43_000, 200, BUDGET);
    const actual = await readLines(helper.io, '/scan', 43_000, 200, BUDGET);
    expect(actual).toEqual(expected);
    expect(Math.max(...helper.windows)).toBe(CAP);
    const capped = helper.windows.slice(helper.windows.indexOf(CAP));
    expect(new Set(capped)).toEqual(new Set([CAP]));
    expect(helper.windows.length).toBeLessThanOrEqual(Math.ceil(big.length / CAP) + 6);
  });
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
