/**
 * P5-2-3 gate — SA10 (permission scope), SA11 (write ordering), SA13 (retry),
 * SA20 (BrowserPreview) and the two tool-capability gaps P5-2-0 named.
 *
 * The theme is that a delegate must take the SAME path as the parent —
 * same permission gate, same write lock, same retry budget shape — while
 * carrying its own identity and, when its definition says so, its own gear. A
 * bug in any of these is silent: the delegate keeps working, it just works
 * under rules nobody chose.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import type {
  PermissionActivityRecord,
  ToolPermissionRequest,
} from '../plugins/permissions/index.ts';
import type { PreviewRequest } from '../plugins/tools/browserPreview.ts';
import { MAX_BASH_TIMEOUT_SECONDS } from '../plugins/tools/index.ts';

describe('the two capability gaps P5-2-0 required closing', () => {
  let workspace: string;
  let runtime: RuntimeHandle | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'p523-'));
  });
  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  async function build(
    extra: Partial<Parameters<typeof createRuntime>[0]> = {}
  ): Promise<RuntimeHandle> {
    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm', name: 'm' }] });
    faux.setResponses([fauxAssistantMessage('ok')]);
    runtime = await createRuntime({
      env: {},
      providers: [faux.provider],
      tools: { cwd: workspace },
      permissions: { gear: 'auto' },
      ...extra,
    });
    return runtime;
  }

  async function callTool(handle: RuntimeHandle, name: string, args: unknown): Promise<string> {
    const tool = handle.ctx.runtimeTools.list().find((entry) => entry.name === name);
    if (!tool) throw new Error(`no ${name} tool registered`);
    const result = await tool.execute(`call-${name}-${Math.random()}`, args as never);
    return result.content.map((block) => ('text' in block ? block.text : '')).join('');
  }

  it('searches by regular expression when asked, and literally when not', async () => {
    // `explorer`'s prompt tells a delegate to reach for regex. Before P5-2-3
    // that instruction was a lie: grep was substring-only.
    await writeFile(join(workspace, 'a.txt'), 'axb\na.b\n', 'utf8');
    const handle = await build();

    const literal = await callTool(handle, 'grep', { pattern: 'a.b' });
    expect(literal).toContain('a.b');
    expect(literal).not.toContain('axb');

    const regex = await callTool(handle, 'grep', { pattern: 'a.b', regex: true });
    expect(regex).toContain('axb');
    expect(regex).toContain('a.b');
  });

  it('fails a bad regular expression instead of silently matching nothing', async () => {
    // "no hits" and "your pattern was invalid" are indistinguishable to a model
    // otherwise, and it will conclude the code is not there.
    await writeFile(join(workspace, 'a.txt'), 'hello\n', 'utf8');
    const handle = await build();
    await expect(callTool(handle, 'grep', { pattern: '(unclosed', regex: true })).rejects.toThrow(
      /invalid regular expression/
    );
  });

  it('honours caseInsensitive in both modes', async () => {
    await writeFile(join(workspace, 'a.txt'), 'HeLLo\n', 'utf8');
    const handle = await build();
    expect(await callTool(handle, 'grep', { pattern: 'hello', caseInsensitive: true })).toContain(
      'HeLLo'
    );
    expect(
      await callTool(handle, 'grep', { pattern: 'h.llo', regex: true, caseInsensitive: true })
    ).toContain('HeLLo');
  });

  it('lets a command ask for far longer than the old ten-minute ceiling', async () => {
    // `test-runner` and `fixer` run builds. The old cap was shorter than one.
    const handle = await build();
    const bash = handle.ctx.runtimeTools.list().find((tool) => tool.name === 'bash');
    const properties = (bash?.parameters as { properties?: Record<string, { maximum?: number }> })
      .properties;
    expect(properties?.timeoutSeconds?.maximum).toBe(MAX_BASH_TIMEOUT_SECONDS);
    expect(MAX_BASH_TIMEOUT_SECONDS).toBe(6 * 60 * 60);
  });

  it('still runs an unasked command, on the unchanged default', async () => {
    // Raising the ceiling must not mean every command may now hang for hours,
    // nor may adding the new parameter break a call that does not pass it.
    const handle = await build({ tools: { cwd: workspace, shellPath: '/bin/bash' } });
    const text = await callTool(handle, 'bash', { command: 'printf ok' });
    expect(text).toContain('ok');
    expect(text).toContain('exit=0');
  });

  it('runs a command that names its own longer timeout', async () => {
    const handle = await build({ tools: { cwd: workspace, shellPath: '/bin/bash' } });
    const text = await callTool(handle, 'bash', { command: 'printf slow', timeoutSeconds: 900 });
    expect(text).toContain('slow');
    expect(text).toContain('exit=0');
  });

  it('registers no browser_preview when the host has no preview surface', async () => {
    // SA20's honest half. An always-present tool that always answers "not
    // available here" trains the model to keep calling it.
    const handle = await build();
    expect(handle.ctx.runtimeTools.list().map((tool) => tool.name)).not.toContain(
      'browser_preview'
    );
  });

  it('hands a workspace page to the host preview surface', async () => {
    const opened: PreviewRequest[] = [];
    await writeFile(join(workspace, 'page.html'), '<h1>hi</h1>', 'utf8');
    const handle = await build({
      tools: {
        cwd: workspace,
        preview: async (request) => {
          opened.push(request);
        },
      },
    });
    const text = await callTool(handle, 'browser_preview', { path: 'page.html' });
    expect(opened).toHaveLength(1);
    expect(opened[0].path.endsWith('page.html')).toBe(true);
    // Background work must not steal the window from the user.
    expect(opened[0].focus).toBe(false);
    expect(text).toContain('reloads');
  });

  it('refuses to preview something that is not a page, naming why', async () => {
    await writeFile(join(workspace, 'notes.bin'), 'x', 'utf8');
    const handle = await build({
      tools: { cwd: workspace, preview: async () => {} },
    });
    await expect(callTool(handle, 'browser_preview', { path: 'notes.bin' })).rejects.toThrow(
      /cannot show \.bin/
    );
  });

  it('reports a host that has a preview surface but could not open the page', async () => {
    await writeFile(join(workspace, 'page.html'), '<h1>hi</h1>', 'utf8');
    const handle = await build({
      tools: {
        cwd: workspace,
        preview: async () => {
          throw new Error('preview window is closed');
        },
      },
    });
    await expect(callTool(handle, 'browser_preview', { path: 'page.html' })).rejects.toThrow(
      /preview window is closed/
    );
  });
});

describe('SA10 · a delegate resolves under its own scope, and says who it is', () => {
  let workspace: string;
  let runtime: RuntimeHandle | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'p523-perm-'));
  });
  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  async function build(gear: 'ask' | 'accept-edits' | 'auto') {
    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm', name: 'm' }] });
    faux.setResponses([fauxAssistantMessage('ok')]);
    const seen: ToolPermissionRequest[] = [];
    const activity: PermissionActivityRecord[] = [];
    runtime = await createRuntime({
      env: {},
      providers: [faux.provider],
      tools: { cwd: workspace },
      permissions: {
        gear,
        approve: async (request) => {
          seen.push(request);
          return 'allow-once';
        },
      },
    });
    runtime.ctx.runtimePermissions.onActivity((record) => activity.push(record));
    return { handle: runtime, seen, activity };
  }

  it('runs a delegate call under the definition gear without moving the session gear', async () => {
    const { handle, seen } = await build('ask');
    const permissions = handle.ctx.runtimePermissions;
    const write = handle.ctx.runtimeTools.list().find((tool) => tool.name === 'write');
    if (!write) throw new Error('no write tool');

    const release = permissions.scopeToolCall('delegate-call', {
      gear: 'accept-edits',
      delegation: { delegationId: 'd1', agentName: 'fixer' },
    });
    await write.execute('delegate-call', {
      path: 'made-by-fixer.txt',
      content: 'hello',
    } as never);
    release();

    // accept-edits let the delegate's write through with no card...
    expect(seen).toHaveLength(0);
    expect(await readFile(join(workspace, 'made-by-fixer.txt'), 'utf8')).toBe('hello');
    // ...and the SESSION is still on ask, so the parent's next write prompts.
    expect(permissions.gear).toBe('ask');
    await write.execute('parent-call', { path: 'made-by-parent.txt', content: 'x' } as never);
    expect(seen).toHaveLength(1);
    expect(seen[0].delegation).toBeUndefined();
  });

  it('puts the delegate on the approval card', async () => {
    const { handle, seen, activity } = await build('ask');
    const permissions = handle.ctx.runtimePermissions;
    const write = handle.ctx.runtimeTools.list().find((tool) => tool.name === 'write');
    if (!write) throw new Error('no write tool');

    const release = permissions.scopeToolCall('delegate-call', {
      delegation: { delegationId: 'd7', agentName: 'fixer' },
    });
    await write.execute('delegate-call', { path: 'x.txt', content: 'x' } as never);
    release();

    // "Allow this write?" is a different question depending on who is asking.
    expect(seen).toHaveLength(1);
    expect(seen[0].delegation).toEqual({ delegationId: 'd7', agentName: 'fixer' });
    const prompt = activity.find((record) => record.phase === 'prompt');
    expect(prompt?.request.delegation?.agentName).toBe('fixer');
  });

  it('records the gear the call actually resolved under, not the session default', async () => {
    const { handle, activity } = await build('ask');
    const permissions = handle.ctx.runtimePermissions;
    const write = handle.ctx.runtimeTools.list().find((tool) => tool.name === 'write');
    if (!write) throw new Error('no write tool');

    const release = permissions.scopeToolCall('delegate-call', {
      gear: 'auto',
      delegation: { delegationId: 'd2', agentName: 'explorer' },
    });
    await write.execute('delegate-call', { path: 'y.txt', content: 'y' } as never);
    release();

    const decision = activity.find((record) => record.phase === 'decision');
    // An audit line that named the session gear here would describe a decision
    // nobody made.
    expect(decision?.gear).toBe('auto');
    expect(permissions.gear).toBe('ask');
  });

  it('keeps two concurrent delegates on their own gears', async () => {
    const { handle, seen } = await build('ask');
    const permissions = handle.ctx.runtimePermissions;
    const write = handle.ctx.runtimeTools.list().find((tool) => tool.name === 'write');
    if (!write) throw new Error('no write tool');

    const autoRelease = permissions.scopeToolCall('call-auto', {
      gear: 'auto',
      delegation: { delegationId: 'a', agentName: 'fixer' },
    });
    const askRelease = permissions.scopeToolCall('call-ask', {
      gear: 'ask',
      delegation: { delegationId: 'b', agentName: 'code-reviewer' },
    });
    await Promise.all([
      write.execute('call-auto', { path: 'auto.txt', content: '1' } as never),
      write.execute('call-ask', { path: 'ask.txt', content: '2' } as never),
    ]);
    autoRelease();
    askRelease();

    // Exactly one card, and it belongs to the delegate that asked for `ask`.
    expect(seen).toHaveLength(1);
    expect(seen[0].delegation?.agentName).toBe('code-reviewer');
  });

  it('does not let an explicit auto scope cross a deny', async () => {
    const { handle } = await build('ask');
    const permissions = handle.ctx.runtimePermissions;
    const read = handle.ctx.runtimeTools.list().find((tool) => tool.name === 'read');
    if (!read) throw new Error('no read tool');
    const release = permissions.scopeToolCall('delegate-call', {
      gear: 'auto',
      delegation: { delegationId: 'd3', agentName: 'explorer' },
    });
    // A path the default policy denies outright. The gear is consulted AFTER
    // every deny, so `auto` cannot buy its way past one.
    await expect(
      read.execute('delegate-call', { path: join(workspace, '.git', 'config') } as never)
    ).rejects.toThrow();
    release();
  });

  it('releases the scope even when the call throws', async () => {
    const { handle } = await build('ask');
    const permissions = handle.ctx.runtimePermissions;
    const read = handle.ctx.runtimeTools.list().find((tool) => tool.name === 'read');
    if (!read) throw new Error('no read tool');
    const release = permissions.scopeToolCall('shared-id', { gear: 'auto' });
    await expect(read.execute('shared-id', { path: 'nope.txt' } as never)).rejects.toThrow();
    release();
    // A leaked scope would silently run a later parent call on `auto`.
    const decisionGear = permissions.evaluate({
      tool: 'write',
      toolCallId: 'shared-id',
      path: join(workspace, 'later.txt'),
    });
    expect(decisionGear).toBe('ask');
  });
});

describe('SA11 · parent and delegate share one write lock per path', () => {
  let workspace: string;
  let runtime: RuntimeHandle | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'p523-lock-'));
  });
  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  it('serialises two writes to the same path and leaves the last one whole', async () => {
    // The lock is shared by construction: a delegate gets the very tools the
    // parent uses, from the one registry, so both take the same `locked()`
    // path. This case is what would notice if that ever stopped being true.
    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm', name: 'm' }] });
    faux.setResponses([fauxAssistantMessage('ok')]);
    runtime = await createRuntime({
      env: {},
      providers: [faux.provider],
      tools: { cwd: workspace },
      permissions: { gear: 'auto' },
    });
    const write = runtime.ctx.runtimeTools.list().find((tool) => tool.name === 'write');
    if (!write) throw new Error('no write tool');
    const target = 'contended.txt';

    await Promise.all([
      write.execute('parent-call', { path: target, content: 'A'.repeat(2000) } as never),
      write.execute('delegate-call', { path: target, content: 'B'.repeat(2000) } as never),
    ]);

    const text = await readFile(join(workspace, target), 'utf8');
    // Interleaved writes would produce a mix; the lock means one of the two
    // wrote last and wrote all of it.
    expect(text === 'A'.repeat(2000) || text === 'B'.repeat(2000)).toBe(true);
  });
});
