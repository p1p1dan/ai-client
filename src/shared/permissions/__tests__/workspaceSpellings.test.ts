import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermissionGate, type ToolPermissionRequest } from '../gate.ts';
import { loadPermissionPolicy } from '../policy.ts';
import { analyzePwsh } from '../pwshAnalysis.ts';
import { canonicalSpelling, workspaceSpellings } from '../workspace.ts';

/**
 * dsh-rebase decision 134 — the workspace by every spelling of it.
 *
 * Windows CI (run 36602434283) asked for every read, grep and glob inside the
 * workspace: `%TEMP%` there is `C:\Users\RUNNER~1\...`, the targets were
 * canonicalized by the native realpath (8.3 names expanded to `runneradmin`)
 * and the gate's cwd by the JavaScript one (8.3 names kept). Reproduced here
 * on POSIX spellings, with an injected resolver standing in for the 8.3
 * expansion: SHORT is the workspace as the session was opened, CANON the same
 * directory as the native resolver spells it. Requests are built the way the
 * DSH host builds them: the target canonical, a shell operand by both its
 * written and its canonical spelling.
 */

const SHORT = path.resolve('/users/RUNNER~1/tmp/ws');
const CANON = path.resolve('/users/runneradmin/tmp/ws');
/** The 8.3 expansion, as `realpathSync.native` / `fs/promises` realpath do it on Windows. */
const expand = (p: string) =>
  p.replace(path.resolve('/users/RUNNER~1'), path.resolve('/users/runneradmin'));
let ids = 0;

function read(file: string): ToolPermissionRequest {
  return { tool: 'read', toolCallId: `call-${++ids}`, path: expand(path.resolve(SHORT, file)) };
}

/** A pwsh call in SHORT, its operands checked by both spellings (`checkShellPaths`). */
function pwsh(command: string): ToolPermissionRequest {
  const analysis = analyzePwsh(command, SHORT, { HOME: '/home/me' }, { platform: 'linux' });
  const paths = [...new Set(analysis.paths.flatMap((p) => [p, expand(p)]))].sort();
  return {
    tool: 'pwsh',
    toolCallId: `call-${++ids}`,
    path: CANON,
    command,
    paths,
    commands: analysis.commands,
    unresolvedPaths: analysis.unresolvedPaths,
    exploration: analysis.exploration,
  };
}

function gate(options: {
  cwd: string;
  cwdAliases?: string[];
  gear?: 'ask' | 'accept-edits';
  answer?: 'allow-once' | 'allow-session';
}) {
  const asked: string[] = [];
  const instance = new PermissionGate({
    cwd: options.cwd,
    ...(options.cwdAliases ? { cwdAliases: options.cwdAliases } : {}),
    gear: options.gear ?? 'ask',
    approve: async (request) => {
      asked.push(request.command ?? `${request.tool} ${request.path}`);
      return options.answer ?? 'allow-once';
    },
  });
  return { gate: instance, asked };
}

describe('workspaceSpellings (decision 134)', () => {
  it('is the canonical spelling, with the opened one as an alias when they differ', () => {
    expect(workspaceSpellings(SHORT, expand)).toEqual({ cwd: CANON, cwdAliases: [SHORT] });
    expect(workspaceSpellings(CANON, expand)).toEqual({ cwd: CANON, cwdAliases: [] });
  });

  it('falls back to the lexical spelling, without an alias, when nothing resolves', () => {
    const missing = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(canonicalSpelling(`${SHORT}/./sub/..`, missing)).toBe(SHORT);
    expect(workspaceSpellings(SHORT, missing)).toEqual({ cwd: SHORT, cwdAliases: [] });
  });
});

describe('the gate judges the workspace by every spelling (decision 134)', () => {
  it('[8dot3-read] a read inside asks when the cwd kept the short name, and not on the canonical one', async () => {
    const before = gate({ cwd: SHORT });
    await before.gate.authorize(read('notes.txt'));
    expect(before.asked).toEqual([`read ${path.join(CANON, 'notes.txt')}`]);

    const after = gate(workspaceSpellings(SHORT, expand));
    await after.gate.authorize(read('notes.txt'));
    await after.gate.authorize(read('sub/deep.txt'));
    expect(after.asked).toEqual([]);
  });

  it('[8dot3-shell] accept-edits runs a workspace pwsh call written against the opened spelling', async () => {
    const command = `Get-Content ${path.join(SHORT, 'notes.txt')}; Set-Content out.txt x`;
    // Canonical cwd alone: the written spelling of each operand is "outside".
    const canonicalOnly = gate({ cwd: CANON, gear: 'accept-edits' });
    await canonicalOnly.gate.authorize(pwsh(command));
    expect(canonicalOnly.asked).toEqual([command]);

    const both = gate({ ...workspaceSpellings(SHORT, expand), gear: 'accept-edits' });
    await both.gate.authorize(pwsh(command));
    expect(both.asked).toEqual([]);
  });

  it('[8dot3-escape] still asks when either spelling of an operand leaves the workspace', async () => {
    const { gate: g, asked } = gate({ ...workspaceSpellings(SHORT, expand), gear: 'accept-edits' });
    // A link inside the workspace pointing out: written inside, canonical outside.
    const linkOut: ToolPermissionRequest = {
      ...pwsh('Get-Content link/secret'),
      paths: [path.join(SHORT, 'link', 'secret'), path.resolve('/etc/secret')],
    };
    await g.authorize(linkOut);
    await g.authorize(pwsh(`Get-Content ${path.resolve('/elsewhere/x.txt')}`));
    await g.authorize(read('../../outside.txt'));
    expect(asked).toEqual([
      'Get-Content link/secret',
      `Get-Content ${path.resolve('/elsewhere/x.txt')}`,
      `read ${path.resolve('/users/runneradmin/outside.txt')}`,
    ]);
  });

  it('[8dot3-grant] a session grant for a workspace command covers it again, as in any workspace', async () => {
    const { gate: g, asked } = gate({
      ...workspaceSpellings(SHORT, expand),
      answer: 'allow-session',
    });
    await g.authorize(pwsh('Remove-Item a.txt'));
    await g.authorize(pwsh(`Remove-Item ${path.join(SHORT, 'b.txt')}`));
    await g.authorize(pwsh(`Remove-Item ${path.resolve('/etc/passwd')}`));
    expect(asked).toEqual(['Remove-Item a.txt', `Remove-Item ${path.resolve('/etc/passwd')}`]);
  });

  it('[8dot3-external] external_directory rules apply only outside every spelling', async () => {
    const policy = await loadPermissionPolicy(
      {
        readFile: async (file: string) => {
          if (file !== path.join('/agent', 'pi-permissions.jsonc'))
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return {
            bytes: new TextEncoder().encode(
              '{ "permission": { "external_directory": { "*": "deny" } } }'
            ),
          };
        },
      },
      { cwd: CANON, agentDir: '/agent', sources: { user: true, project: false, local: false } }
    );
    const g = new PermissionGate({
      ...workspaceSpellings(SHORT, expand),
      gear: 'accept-edits',
      policy,
    });
    expect(g.evaluate(pwsh(`Get-Content ${path.join(SHORT, 'notes.txt')}`))).toBe('allow');
    expect(g.evaluate(read('notes.txt'))).toBe('allow');
    expect(g.evaluate(pwsh(`Get-Content ${path.resolve('/elsewhere/x.txt')}`))).toBe('deny');
  });
});
