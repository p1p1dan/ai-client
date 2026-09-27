import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '../../types/runtimeEvents.ts';
import { analyzeBash, type BashSyntaxNode } from '../bashWalker.ts';
import { createPermissionPrompt } from '../cardEmitter.ts';
import { PermissionError } from '../errors.ts';
import {
  denialSource,
  isShellTool,
  type PermissionActivityRecord,
  PermissionDenial,
  PermissionGate,
  type PermissionTimers,
  type ToolPermissionRequest,
} from '../gate.ts';
import type { PersistedGrants } from '../grants.ts';
import { loadPermissionPolicy } from '../policy.ts';
import { authorizeTarget, checkShellPaths, type PermissionFileSystem } from '../shellPaths.ts';

/**
 * dsh-rebase P1-6a — the seams a host plugs into the shared permission library.
 *
 * The rules themselves are pinned by the 1.0.x runtime's suites, which run on
 * this library through the runtime's thin wrappers. What is new is only the
 * injection: errors, grant storage, the clock, the filesystem, the parser, and
 * the second shell a DSH host brings (`pwsh`). Each is exercised here with no
 * runtime, no Cordis and no tree-sitter at all.
 */

const ROOT = path.resolve('/ws');
const inside = (name: string) => path.join(ROOT, name);
const write = (id: string, file = 'a.txt'): ToolPermissionRequest => ({
  tool: 'write',
  toolCallId: id,
  path: inside(file),
});

/** Stands in for a host's own error type, e.g. the runtime's `RuntimeHostError`. */
class HostError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

describe('isShellTool', () => {
  it('knows both shells and nothing else', () => {
    expect(['bash', 'pwsh'].map(isShellTool)).toEqual([true, true]);
    expect(['sh', 'read', 'write', 'mcp__x__bash'].map(isShellTool)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('gives pwsh the shell rules: plan-mode exploration, prefix grants, the exec card', async () => {
    const plan = new PermissionGate({ cwd: ROOT, mode: 'plan', gear: 'auto' });
    const pwsh = { tool: 'pwsh', toolCallId: 'p', path: ROOT, command: 'Get-ChildItem' };
    expect(plan.evaluate({ ...pwsh, exploration: true })).toBe('allow');
    expect(plan.evaluate({ ...pwsh, exploration: false })).toBe('deny');

    const asked: string[] = [];
    const gate = new PermissionGate({
      cwd: ROOT,
      approve: async (request) => {
        asked.push(request.toolCallId);
        return 'allow-session';
      },
    });
    await gate.authorize({ ...pwsh, toolCallId: '1', command: 'npm test', commands: ['npm test'] });
    await gate.authorize({ ...pwsh, toolCallId: '2', command: 'npm test -- -w', commands: [] });
    expect(asked).toEqual(['1']);

    const events: RuntimeEventDraft[] = [];
    const prompt = createPermissionPrompt({
      sessionId: 's',
      cwd: ROOT,
      emit: (e) => events.push(e),
    });
    const stop = new AbortController();
    const pending = prompt.approve(pwsh, stop.signal);
    expect(events[0]?.payload).toMatchObject({ kind: 'exec', action: 'run_command' });
    stop.abort();
    await pending;
  });
});

describe('PermissionGate hooks', () => {
  it('throws the host error type and still reports why', async () => {
    const records: PermissionActivityRecord[] = [];
    const gate = new PermissionGate(
      { cwd: ROOT, approve: async () => 'deny' },
      { createDenial: (source, message) => new HostError(`denied:${source}`, message) }
    );
    gate.onActivity((record) => records.push(record));
    const error = await gate.authorize(write('w')).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HostError);
    expect(error).toMatchObject({ code: 'denied:user-denied', message: 'permission denied' });
    expect(denialSource(error)).toBe('user-denied');
    expect(records.at(-1)).toMatchObject({ decision: 'deny', source: 'user-denied' });
  });

  it('defaults to a PermissionDenial carrying tool_denied and the source', async () => {
    const gate = new PermissionGate({ cwd: ROOT });
    const error = await gate.authorize(write('w')).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PermissionDenial);
    expect(error).toBeInstanceOf(PermissionError);
    expect(error).toMatchObject({ code: 'tool_denied', source: 'error' });
    expect(denialSource(new Error('not a gate refusal'))).toBeUndefined();
  });

  it('hands every grant change to persistGrants, clearing included', async () => {
    const written: PersistedGrants[] = [];
    const gate = new PermissionGate(
      { cwd: ROOT, approve: async () => 'allow-session' },
      { persistGrants: (record) => written.push(record) }
    );
    await gate.authorize(write('w'));
    gate.configure({ gear: 'ask' });
    expect(written).toEqual([
      { version: 2, grants: [{ kind: 'path', tool: 'write', path: inside('a.txt') }] },
      { version: 2, grants: [] },
    ]);
  });

  it('runs the deadline on the injected clock', async () => {
    const pending: Array<() => void> = [];
    const timers: PermissionTimers = {
      setTimeout: (callback) => pending.push(callback),
      clearTimeout: () => {},
    };
    const gate = new PermissionGate(
      { cwd: ROOT, approve: () => new Promise(() => {}), timeoutMs: 5 },
      { timers }
    );
    const outcome = gate.authorize(write('w')).catch((thrown: unknown) => denialSource(thrown));
    await new Promise((resolve) => setImmediate(resolve));
    expect(pending).toHaveLength(1);
    pending[0]();
    expect(await outcome).toBe('timed-out');
  });

  it('cancels a parked request on dispose', async () => {
    const gate = new PermissionGate({ cwd: ROOT, approve: () => new Promise(() => {}) });
    const outcome = gate.authorize(write('w')).catch((thrown: unknown) => denialSource(thrown));
    await new Promise((resolve) => setImmediate(resolve));
    gate.dispose();
    expect(await outcome).toBe('cancelled');
  });
});

describe('injected filesystem', () => {
  const missing = (file: string) => Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' });
  function fakeFs(entries: Record<string, string[]>, links: Record<string, string> = {}) {
    const exists = new Set([ROOT, ...Object.keys(entries)]);
    for (const [dir, names] of Object.entries(entries))
      for (const name of names) exists.add(path.join(dir, name));
    return {
      links,
      realpath: async (file: string) => {
        if (links[file]) return links[file];
        if (exists.has(file)) return file;
        throw missing(file);
      },
      async *readDirectory(dir: string) {
        for (const name of entries[dir] ?? []) yield { name };
      },
    } satisfies PermissionFileSystem & { links: Record<string, string> };
  }

  it('expands a wildcard through it and refuses a denied entry with the host error', async () => {
    const fs = fakeFs({ [ROOT]: ['notes.txt', 'app.env'] });
    const createError = (code: string, message: string) => new HostError(code, message);
    await expect(
      checkShellPaths(
        { paths: [inside('*.txt')], commands: [], unresolvedPaths: false, exploration: true },
        { fs, cwd: ROOT, createError }
      )
    ).resolves.toMatchObject({ paths: [ROOT, inside('notes.txt')] });
    await expect(
      checkShellPaths(
        { paths: [inside('*')], commands: [], unresolvedPaths: false, exploration: true },
        { fs, cwd: ROOT, createError }
      )
    ).rejects.toMatchObject({ code: 'tool_denied' });
  });

  it('re-resolves the target after approval and refuses a moved one', async () => {
    const fs = fakeFs({ [ROOT]: ['link'] });
    const approve = async (request: ToolPermissionRequest) => {
      expect(request).toMatchObject({ tool: 'read', path: inside('link') });
      fs.links[inside('link')] = path.resolve('/elsewhere');
    };
    await expect(
      authorizeTarget(
        { fs, cwd: ROOT, authorize: approve },
        { tool: 'read', toolCallId: 'r', input: 'link' }
      )
    ).rejects.toMatchObject({ code: 'path_changed' });
  });

  it('reads only the enabled policy layers, through the injected reader', async () => {
    const agentDir = path.resolve('/agent');
    const reads: string[] = [];
    const io = {
      readFile: async (file: string) => {
        reads.push(file);
        if (file !== path.join(agentDir, 'pi-permissions.jsonc')) throw missing(file);
        return { bytes: new TextEncoder().encode('{ // c\n "permission": { "bash": "deny" } }') };
      },
    };
    const policy = await loadPermissionPolicy(io, {
      cwd: ROOT,
      agentDir,
      sources: { user: true, project: false, local: false },
    });
    expect(policy.sources).toEqual([path.join(agentDir, 'pi-permissions.jsonc')]);
    expect(reads.every((file) => file.startsWith(agentDir))).toBe(true);
    await expect(
      loadPermissionPolicy(
        { readFile: async () => ({ bytes: new TextEncoder().encode('{ nope') }) },
        { cwd: ROOT, agentDir, sources: { user: true, project: false, local: false } }
      )
    ).rejects.toMatchObject({ code: 'permission_policy_invalid' });
  });
});

describe('injected bash parser', () => {
  function syntax(
    type: string,
    text: string,
    named: BashSyntaxNode[] = [],
    fields: Record<string, BashSyntaxNode[]> = {}
  ): BashSyntaxNode {
    return {
      type,
      text,
      hasError: false,
      namedChildren: named,
      childForFieldName: (name) => fields[name]?.[0] ?? null,
      childrenForFieldName: (name) => fields[name] ?? [],
    };
  }

  it('walks a structurally typed tree without web-tree-sitter', () => {
    const name = syntax('command_name', 'cat', [syntax('word', 'cat')]);
    const argument = syntax('word', 'notes.txt');
    const command = syntax('command', 'cat notes.txt', [name, argument], {
      name: [name],
      argument: [argument],
    });
    let deleted = 0;
    const parser = {
      parse: () => ({
        rootNode: syntax('program', 'cat notes.txt', [command]),
        delete: () => deleted++,
      }),
    };
    expect(analyzeBash(parser, 'cat notes.txt', ROOT, {})).toMatchObject({
      commands: ['cat notes.txt'],
      paths: [inside('notes.txt')],
      unresolvedPaths: false,
    });
    expect(deleted).toBe(1);
  });

  it('reports an unparseable command through the injected error', () => {
    const parser = { parse: () => null };
    let thrown: unknown;
    try {
      analyzeBash(parser, 'cat "', ROOT, {}, (code, message) => new HostError(code, message));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HostError);
    expect(thrown).toMatchObject({ code: 'invalid_tool_arguments' });
  });
});
