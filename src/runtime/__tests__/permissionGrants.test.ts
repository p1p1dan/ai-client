/**
 * "Allow for session" used to grant almost nothing.
 *
 * The grant was the REQUEST, stringified: tool, path, command and the resolved
 * operand list, compared byte for byte. Nothing a model does twice produces that
 * same string twice — `edit src/a.ts` did not cover `src/b.ts`, `npm test` did
 * not cover `npm test -- --watch`, and a command with one unreadable operand
 * never matched anything at all. The user's report was "it keeps asking for
 * permission", and it was accurate: the button they pressed had almost no reach
 * and forgot everything at the next restart on top of that.
 *
 * What is pinned here is the new reach and, just as much, its edges: a file
 * grant covers the approved file and not its neighbours, a bash grant covers a
 * command prefix and nothing beyond it, neither buys a path outside the
 * workspace for bash, and both survive a reopen of the same conversation without
 * leaking into a new one.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import { standaloneHost } from '../host/config.ts';
import { resolveWorkerShell } from '../host/shell.ts';
import {
  commandPrefix,
  commandPrefixes,
  decodeGrants,
  encodeGrants,
  PERMISSION_GRANTS_ENTRY,
  restoredGrants,
} from '../plugins/permissions/grants.ts';
import type {
  RuntimePermissionsService,
  ToolPermissionRequest,
} from '../plugins/permissions/index.ts';
import { INTERNAL_CUSTOM_ENTRIES } from '../plugins/session/legacy.ts';

let dir: string;
const live = new Set<RuntimeHandle>();
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-grants-'));
});
afterEach(async () => {
  for (const handle of live) await handle.dispose().catch(() => {});
  live.clear();
  await rm(dir, { recursive: true, force: true });
});

interface Gate {
  permissions: RuntimePermissionsService;
  /** Every request that actually reached a card, in order. */
  asked: ToolPermissionRequest[];
  /** What the next card is answered with; the tests move it between calls. */
  reply: { with: 'allow-once' | 'allow-session' | 'deny' };
  handle: RuntimeHandle;
}

/** A real graph on `ask`, answered by a spy rather than by a person. */
async function gate(options: Partial<RuntimeBootstrapOptions> = {}): Promise<Gate> {
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  faux.setResponses([fauxAssistantMessage('ok')]);
  const asked: ToolPermissionRequest[] = [];
  const reply: Gate['reply'] = { with: 'allow-session' };
  const handle = await createRuntime({
    env: {},
    traceDir: null,
    providers: [faux.provider],
    tools: { cwd: dir },
    ...options,
    permissions: {
      gear: 'ask',
      ...options.permissions,
      approve: async (request) => {
        asked.push(request);
        return reply.with;
      },
    },
  });
  live.add(handle);
  return { permissions: handle.ctx.runtimePermissions, asked, reply, handle };
}

/** One gated call, reported rather than thrown. */
const ask = (permissions: RuntimePermissionsService, request: ToolPermissionRequest) =>
  permissions.authorize(request).then(
    () => 'allowed',
    (error: unknown) => (error as { code?: string }).code ?? 'failed'
  );

const file = (id: string, relative: string, tool = 'edit'): ToolPermissionRequest => ({
  tool,
  toolCallId: id,
  path: join(dir, relative),
});

/**
 * A bash request shaped the way the shell analysis shapes one: `commands` holds
 * one entry per command node, which is what the prefix rule reads.
 */
const shell = (
  id: string,
  command: string,
  extra: Partial<ToolPermissionRequest> = {}
): ToolPermissionRequest => ({
  tool: 'bash',
  toolCallId: id,
  path: dir,
  command,
  commands: [command],
  paths: [],
  ...extra,
});

describe('a file grant covers the file it was given for', () => {
  it('covers the same file again, and stops at the file it named', async () => {
    const { permissions, asked } = await gate();

    expect(await ask(permissions, file('1', 'a/b.ts'))).toBe('allowed');
    expect(asked).toHaveLength(1);

    // The half of the complaint that is genuinely a bug: the SAME file, edited
    // twice in a row, raised a second card because the grant was the whole
    // request stringified and the second call never matched it byte for byte.
    expect(await ask(permissions, file('2', 'a/b.ts'))).toBe('allowed');
    expect(asked).toHaveLength(1);

    // ...and the edge that keeps it a grant on a FILE rather than on a folder.
    // Neither of these was ever on a card, so each gets one — approving an edit
    // to one file says nothing about what else lives beside it.
    expect(await ask(permissions, file('3', 'a/c.ts'))).toBe('allowed');
    expect(await ask(permissions, file('4', 'a/sub/d.ts'))).toBe('allowed');
    expect(asked.map((request) => request.toolCallId)).toEqual(['1', '3', '4']);
  });

  it('is per tool: allowing an edit to a file does not allow writing it', async () => {
    const { permissions, asked } = await gate();
    expect(await ask(permissions, file('1', 'a/b.ts'))).toBe('allowed');
    expect(await ask(permissions, file('2', 'a/b.ts', 'write'))).toBe('allowed');
    expect(asked.map((request) => request.tool)).toEqual(['edit', 'write']);
  });

  it('refuses a secret file outright rather than asking about it', async () => {
    // What the bundled path rules say about a file is decided before grants are
    // consulted at all, so a session that has approvals in it is no closer to
    // `.env` than one that has none — and `.env` is a `deny` rule, so it is
    // refused rather than put on a card the user could say yes to.
    const { permissions, asked } = await gate();
    expect(await ask(permissions, file('1', 'note.txt'))).toBe('allowed');
    expect(await ask(permissions, file('2', '.env'))).toBe('tool_denied');
    expect(asked.map((request) => request.toolCallId)).toEqual(['1']);
  });

  it('keeps asking about a path the bundled rules mark `ask`, grant or no grant', async () => {
    // The other arm of the same idea, on a rule that asks instead of refusing:
    // `~/.pilab/*`. The same file is approved and then requested again, so the
    // grant matches exactly — and the rule still wins, because it is re-read on
    // every call rather than inherited from the approval.
    const { permissions, asked } = await gate();
    const pilab = (id: string): ToolPermissionRequest => ({
      tool: 'edit',
      toolCallId: id,
      path: join(homedir(), '.pilab', 'a.txt'),
    });
    expect(await ask(permissions, pilab('1'))).toBe('allowed');
    expect(await ask(permissions, pilab('2'))).toBe('allowed');
    expect(asked.map((request) => request.toolCallId)).toEqual(['1', '2']);
  });
});

describe('a bash grant covers a command prefix', () => {
  it('covers the same prefix with different arguments, and nothing else', async () => {
    const { permissions, asked } = await gate();
    expect(await ask(permissions, shell('1', 'npm test'))).toBe('allowed');
    expect(asked).toHaveLength(1);

    expect(await ask(permissions, shell('2', 'npm test -- --watch'))).toBe('allowed');
    expect(asked).toHaveLength(1);

    // `npm` takes a subcommand, so the prefix is two words: approving the test
    // run is not approving the build, and certainly not another program.
    expect(await ask(permissions, shell('3', 'npm run build'))).toBe('allowed');
    expect(await ask(permissions, shell('4', 'git status'))).toBe('allowed');
    expect(asked.map((request) => request.command)).toEqual([
      'npm test',
      'npm run build',
      'git status',
    ]);
  });

  it('needs every segment of a chained command to be granted', async () => {
    const { permissions, asked, reply } = await gate();
    expect(await ask(permissions, shell('1', 'npm test'))).toBe('allowed');

    // Half the line is covered, so the line is not: the second segment is a
    // command the user has never been shown.
    const chained = shell('2', 'npm test && rm -rf build', {
      commands: ['npm test', 'rm -rf build'],
      paths: [join(dir, 'build')],
    });
    reply.with = 'allow-once';
    expect(await ask(permissions, chained)).toBe('allowed');
    expect(asked).toHaveLength(2);

    // Allowing it for the session writes down BOTH prefixes, which is what
    // makes the same line pass unasked the second time.
    reply.with = 'allow-session';
    expect(await ask(permissions, { ...chained, toolCallId: '3' })).toBe('allowed');
    expect(asked).toHaveLength(3);
    expect(await ask(permissions, { ...chained, toolCallId: '4' })).toBe('allowed');
    expect(asked).toHaveLength(3);
  });

  it('still asks when a granted prefix reaches outside the workspace', async () => {
    const { permissions, asked } = await gate();
    expect(await ask(permissions, shell('1', 'npm test'))).toBe('allowed');

    // Same prefix, same workspace root — and an operand in somebody else's
    // directory. A prefix says what runs, never where it reaches.
    expect(
      await ask(
        permissions,
        shell('2', 'npm test', { paths: [join(dirname(dir), 'elsewhere.txt')] })
      )
    ).toBe('allowed');
    expect(asked.map((request) => request.toolCallId)).toEqual(['1', '2']);
  });

  it('covers a command whose operands the analysis could not read', async () => {
    // The case the user actually hit: a granted prefix with one unresolved word
    // used to fall straight through to the unresolved-operand stop and raise a
    // card every single time.
    const { permissions, asked } = await gate();
    expect(await ask(permissions, shell('1', 'npm test'))).toBe('allowed');
    expect(await ask(permissions, shell('2', 'npm test $FLAGS', { unresolvedPaths: true }))).toBe(
      'allowed'
    );
    expect(asked).toHaveLength(1);
  });

  it('remembers nothing for a command with no readable program name', async () => {
    // `$(which rm) -rf x` reduces to the operand list alone. A "prefix" taken
    // from it would be the word `-rf`, so the approval is allowed to stand for
    // itself and nothing more.
    const { permissions, asked } = await gate();
    const opaque = shell('1', '$(which rm) -rf build', {
      commands: ['-rf build'],
      unresolvedPaths: true,
      paths: [join(dir, 'build')],
    });
    expect(await ask(permissions, opaque)).toBe('allowed');
    expect(await ask(permissions, { ...opaque, toolCallId: '2' })).toBe('allowed');
    expect(asked).toHaveLength(2);
  });
});

describe('through the real shell analysis', () => {
  /** The bash tool as the agent calls it, so the AST walk produces `commands`. */
  const run = (handle: RuntimeHandle, command: string) => {
    const tool = handle.ctx.runtimeTools.list().find((entry) => entry.name === 'bash');
    if (!tool) throw new Error('bash tool missing');
    return tool.execute('shell', { command });
  };

  it('reads the segments the analysis already split, rather than re-lexing', async () => {
    const { handle, asked } = await gate({
      // A real shell, so the tool registers and the AST walk runs for real.
      host: standaloneHost({ PATH: process.env.PATH, HOME: homedir() }),
      tools: { cwd: dir, shellPath: resolveWorkerShell(process.env as Record<string, string>) },
    });
    await run(handle, 'echo one');
    expect(asked).toHaveLength(1);

    // Same program, different operand: one prefix, one grant, no second card.
    await run(handle, 'echo two');
    expect(asked).toHaveLength(1);

    // A chain the analysis splits into two command nodes. The first is covered
    // and the second is not, so the line asks — which is the behaviour that
    // makes `&&` safe to grant a prefix through at all.
    await run(handle, 'echo one && ls .');
    expect(asked).toHaveLength(2);
    expect(asked[1].commands).toEqual(expect.arrayContaining(['echo one', 'ls .']));
  });
});

describe('the prefix rule itself', () => {
  it.each([
    ['ls -la', 'ls'],
    ['npm test', 'npm test'],
    ['npm test -- --watch', 'npm test'],
    ['npm run build', 'npm run'],
    ['npm -v', 'npm'],
    ['git status --short', 'git status'],
    ['python3 tools/check.py', 'python3 tools/check.py'],
    ['/usr/bin/npm test', '/usr/bin/npm test'],
  ])('%s is remembered as %s', (command, prefix) => {
    expect(commandPrefix(command)).toBe(prefix);
  });

  it('has no prefix for a segment that starts with a flag or is empty', () => {
    expect(commandPrefix('-rf build')).toBeUndefined();
    expect(commandPrefix('   ')).toBeUndefined();
  });

  it('gives up on the whole command when any one segment has no prefix', () => {
    const request = shell('x', 'a | b', { commands: ['echo hi', '-rf build'] });
    expect(commandPrefixes(request)).toBeUndefined();
  });
});

describe('grants survive a reopen of the same conversation', () => {
  const sessionFile = () => join(dir, 'session.jsonl');

  it('restores what was allowed, and starts a new conversation empty', async () => {
    const first = await gate({
      session: { file: sessionFile(), cwd: dir, mode: 'create' },
    });
    expect(await ask(first.permissions, file('1', 'a/b.ts'))).toBe('allowed');
    await first.handle.session?.flush();
    live.delete(first.handle);
    await first.handle.dispose();

    const resumed = await gate({
      session: { file: sessionFile(), cwd: dir, mode: 'resume' },
    });
    // The point: a restart is not a reason to re-ask a question already
    // answered about this conversation.
    expect(await ask(resumed.permissions, file('2', 'a/b.ts'))).toBe('allowed');
    expect(resumed.asked).toHaveLength(0);
    live.delete(resumed.handle);
    await resumed.handle.dispose();

    // ...and a DIFFERENT conversation inherits nothing, which is the other half
    // of "for session" meaning the session.
    const fresh = await gate({
      session: { file: join(dir, 'other.jsonl'), cwd: dir, mode: 'create' },
    });
    expect(await ask(fresh.permissions, file('3', 'a/b.ts'))).toBe('allowed');
    expect(fresh.asked).toHaveLength(1);
  });

  it('forgets them on disk too when the permission posture changes', async () => {
    const first = await gate({
      session: { file: sessionFile(), cwd: dir, mode: 'create' },
    });
    expect(await ask(first.permissions, file('1', 'a/b.ts'))).toBe('allowed');
    // `configure` is the posture change — it already voided the in-memory
    // grants, and leaving them on disk would have handed every one of them back
    // at the next open.
    first.permissions.configure({ mode: 'agent', gear: 'ask' });
    await first.handle.session?.flush();
    live.delete(first.handle);
    await first.handle.dispose();

    const resumed = await gate({
      session: { file: sessionFile(), cwd: dir, mode: 'resume' },
    });
    expect(await ask(resumed.permissions, file('2', 'a/b.ts'))).toBe('allowed');
    expect(resumed.asked).toHaveLength(1);
  });
});

describe('the stored format', () => {
  it('stays off the wire, so a grant is not drawn as a system message', () => {
    // Every `custom.entry` the runtime publishes becomes a visible row in the
    // conversation. A bookkeeping record of what was approved has no business
    // being one — it would read as a block of raw JSON and open a turn.
    expect(INTERNAL_CUSTOM_ENTRIES).toContain(PERMISSION_GRANTS_ENTRY);
  });

  const record = (data: unknown) => [{ type: 'custom', customType: PERMISSION_GRANTS_ENTRY, data }];

  it('round-trips what it wrote', () => {
    const grants = [
      { kind: 'path' as const, tool: 'edit', path: '/repo/src/a.ts' },
      { kind: 'command' as const, prefix: 'npm test', root: '/repo' },
    ];
    expect(restoredGrants(record(encodeGrants(grants)))).toEqual(grants);
  });

  it('treats a version it does not know as no grants at all', () => {
    // Deliberately silent: a session written by a newer build must still open,
    // and the worst an ignored grant can do is ask once more.
    expect(
      decodeGrants({ version: 99, grants: [{ kind: 'path', tool: 'edit', path: '/repo/a.ts' }] })
    ).toBeUndefined();
    expect(restoredGrants(record({ version: 99, grants: [] }))).toEqual([]);
    expect(restoredGrants(record('nonsense'))).toEqual([]);
  });

  it('drops the retired v1 records rather than reading them as file grants', () => {
    // A v1 `path` grant named a DIRECTORY and covered everything under it. Its
    // field is even called `dir`, so a reader that only checked `kind` would
    // turn "this folder" into "the folder itself" — quietly, and in the
    // direction that keeps a stale approval alive.
    expect(
      decodeGrants({ version: 1, grants: [{ kind: 'path', tool: 'edit', dir: '/repo/src' }] })
    ).toBeUndefined();
  });

  it('keeps the last record, so an empty one really clears', () => {
    const entries = [
      ...record(encodeGrants([{ kind: 'command' as const, prefix: 'npm test', root: '/repo' }])),
      ...record(encodeGrants([])),
    ];
    expect(restoredGrants(entries)).toEqual([]);
  });

  it('drops a malformed member without losing the record around it', () => {
    const decoded = decodeGrants({
      version: 2,
      grants: [
        { kind: 'path', tool: 'edit' },
        { kind: 'command', prefix: 'ls', root: '/repo' },
      ],
    });
    expect(decoded).toEqual([{ kind: 'command', prefix: 'ls', root: '/repo' }]);
  });
});
