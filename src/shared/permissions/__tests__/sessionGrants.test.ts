import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTERNAL_CUSTOM_ENTRIES } from '../../legacyPiSession/legacy.ts';
import type { PermissionGate, ToolPermissionRequest } from '../gate.ts';
import {
  commandPrefix,
  commandPrefixes,
  decodeGrants,
  encodeGrants,
  PERMISSION_GRANTS_ENTRY,
  type PermissionGrant,
  restoredGrants,
} from '../grants.ts';
import { buildGate, type GateOptions, outcome } from './gateHarness.ts';

/**
 * Moved from src/runtime/__tests__/permissionGrants.test.ts (dsh-rebase P1-12
 * step 2): what "Allow for session" covers, and its edges. A file grant covers
 * the approved file and not its neighbours, a bash grant covers a command
 * prefix and nothing beyond it, neither buys a path outside the workspace for
 * bash, and both survive a reopen of the same conversation without leaking
 * into a new one.
 *
 * The runtime wrote the grant set to its transcript as a custom entry and read
 * it back with `restoredGrants`; here the gate's `persistGrants` hook appends
 * the same entry to a list that stands in for that transcript. The case that
 * needs the real shell analysis lives in
 * src/dsh-host/permissions/__tests__/bashGateTools.test.ts.
 */

let dir: string;
const live = new Set<PermissionGate>();
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'perm-session-grants-')));
});
afterEach(async () => {
  for (const gate of live) gate.dispose();
  live.clear();
  await rm(dir, { recursive: true, force: true });
});

/** The custom entries a session transcript held, in the order they were appended. */
type Transcript = Array<{ type: string; customType?: string; data?: unknown }>;

interface Gate {
  permissions: PermissionGate;
  /** Every request that actually reached a card, in order. */
  asked: ToolPermissionRequest[];
  /** What the next card is answered with; the tests move it between calls. */
  reply: { with: 'allow-once' | 'allow-session' | 'deny' };
}

/**
 * A real gate on `ask`, answered by a spy rather than by a person. With a
 * transcript it starts on the grants the transcript kept and appends every
 * change to it, as the runtime's session did.
 */
async function gate(options: GateOptions = {}, transcript?: Transcript): Promise<Gate> {
  const asked: ToolPermissionRequest[] = [];
  const reply: Gate['reply'] = { with: 'allow-session' };
  const built = await buildGate(
    dir,
    {
      gear: 'ask',
      ...options,
      ...(transcript ? { grants: restoredGrants(transcript) } : {}),
      approve: async (request) => {
        asked.push(request);
        return reply.with;
      },
    },
    transcript
      ? {
          persistGrants: (record) =>
            transcript.push({ type: 'custom', customType: PERMISSION_GRANTS_ENTRY, data: record }),
        }
      : {}
  );
  live.add(built.gate);
  return { permissions: built.gate, asked, reply };
}

/** One gated call, reported rather than thrown. */
const ask = (permissions: PermissionGate, request: ToolPermissionRequest) =>
  outcome(permissions.authorize(request));

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

    // The SAME file, edited twice in a row, raises no second card.
    expect(await ask(permissions, file('2', 'a/b.ts'))).toBe('allowed');
    expect(asked).toHaveLength(1);

    // ...and the edge that keeps it a grant on a FILE rather than on a folder.
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
    // The bundled path rules are decided before grants are consulted at all,
    // and `.env` is a `deny` rule, so it is refused rather than put on a card.
    const { permissions, asked } = await gate();
    expect(await ask(permissions, file('1', 'note.txt'))).toBe('allowed');
    expect(await ask(permissions, file('2', '.env'))).toBe('tool_denied');
    expect(asked.map((request) => request.toolCallId)).toEqual(['1']);
  });

  it('keeps asking about a path the bundled rules mark `ask`, grant or no grant', async () => {
    // `~/.pilab/*`: the grant matches exactly and the rule still wins, because
    // it is re-read on every call rather than inherited from the approval.
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

    // `npm` takes a subcommand, so the prefix is two words.
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

    // Half the line is covered, so the line is not.
    const chained = shell('2', 'npm test && rm -rf build', {
      commands: ['npm test', 'rm -rf build'],
      paths: [join(dir, 'build')],
    });
    reply.with = 'allow-once';
    expect(await ask(permissions, chained)).toBe('allowed');
    expect(asked).toHaveLength(2);

    // Allowing it for the session writes down BOTH prefixes.
    reply.with = 'allow-session';
    expect(await ask(permissions, { ...chained, toolCallId: '3' })).toBe('allowed');
    expect(asked).toHaveLength(3);
    expect(await ask(permissions, { ...chained, toolCallId: '4' })).toBe('allowed');
    expect(asked).toHaveLength(3);
  });

  it('still asks when a granted prefix reaches outside the workspace', async () => {
    const { permissions, asked } = await gate();
    expect(await ask(permissions, shell('1', 'npm test'))).toBe('allowed');

    // A prefix says what runs, never where it reaches.
    expect(
      await ask(
        permissions,
        shell('2', 'npm test', { paths: [join(dirname(dir), 'elsewhere.txt')] })
      )
    ).toBe('allowed');
    expect(asked.map((request) => request.toolCallId)).toEqual(['1', '2']);
  });

  it('covers a command whose operands the analysis could not read', async () => {
    const { permissions, asked } = await gate();
    expect(await ask(permissions, shell('1', 'npm test'))).toBe('allowed');
    expect(await ask(permissions, shell('2', 'npm test $FLAGS', { unresolvedPaths: true }))).toBe(
      'allowed'
    );
    expect(asked).toHaveLength(1);
  });

  it('remembers nothing for a command with no readable program name', async () => {
    // `$(which rm) -rf x` reduces to the operand list alone; a "prefix" taken
    // from it would be the word `-rf`.
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
  it('restores what was allowed, and starts a new conversation empty', async () => {
    const transcript: Transcript = [];
    const first = await gate({}, transcript);
    expect(await ask(first.permissions, file('1', 'a/b.ts'))).toBe('allowed');
    first.permissions.dispose();

    const resumed = await gate({}, transcript);
    // A restart is not a reason to re-ask a question already answered here.
    expect(await ask(resumed.permissions, file('2', 'a/b.ts'))).toBe('allowed');
    expect(resumed.asked).toHaveLength(0);
    resumed.permissions.dispose();

    // ...and a DIFFERENT conversation inherits nothing.
    const fresh = await gate({}, []);
    expect(await ask(fresh.permissions, file('3', 'a/b.ts'))).toBe('allowed');
    expect(fresh.asked).toHaveLength(1);
  });

  it('forgets them on disk too when the permission posture changes', async () => {
    const transcript: Transcript = [];
    const first = await gate({}, transcript);
    expect(await ask(first.permissions, file('1', 'a/b.ts'))).toBe('allowed');
    // `configure` is the posture change: it voids the grants in memory and
    // writes the empty set down, or the next open would hand them all back.
    first.permissions.configure({ mode: 'agent', gear: 'ask' });
    first.permissions.dispose();

    const resumed = await gate({}, transcript);
    expect(await ask(resumed.permissions, file('2', 'a/b.ts'))).toBe('allowed');
    expect(resumed.asked).toHaveLength(1);
  });
});

describe('the stored format', () => {
  it('stays off the wire, so a grant is not drawn as a system message', () => {
    // A bookkeeping record of what was approved is not a conversation row.
    expect(INTERNAL_CUSTOM_ENTRIES).toContain(PERMISSION_GRANTS_ENTRY);
  });

  const record = (data: unknown) => [{ type: 'custom', customType: PERMISSION_GRANTS_ENTRY, data }];

  it('round-trips what it wrote', () => {
    const grants: PermissionGrant[] = [
      { kind: 'path', tool: 'edit', path: '/repo/src/a.ts' },
      { kind: 'command', prefix: 'npm test', root: '/repo' },
    ];
    expect(restoredGrants(record(encodeGrants(grants)))).toEqual(grants);
  });

  it('treats a version it does not know as no grants at all', () => {
    expect(
      decodeGrants({ version: 99, grants: [{ kind: 'path', tool: 'edit', path: '/repo/a.ts' }] })
    ).toBeUndefined();
    expect(restoredGrants(record({ version: 99, grants: [] }))).toEqual([]);
    expect(restoredGrants(record('nonsense'))).toEqual([]);
  });

  it('drops the retired v1 records rather than reading them as file grants', () => {
    // A v1 `path` grant named a DIRECTORY and covered everything under it.
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
