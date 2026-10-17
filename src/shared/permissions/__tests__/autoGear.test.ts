import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BashAnalysis } from '../bashWalker.ts';
import { PermissionGate, type ToolPermissionRequest } from '../gate.ts';
import { loadPermissionPolicy } from '../policy.ts';
import { analyzePwsh } from '../pwshAnalysis.ts';
import { checkShellPaths } from '../shellPaths.ts';
import { nodeFs } from './gateHarness.ts';

/**
 * claude-sdk-engine README ruling 27 (S-6 feedback 11c, GitHub issue #19,
 * dsh-rebase decision 191): full auto lets a workspace command run even when
 * part of it cannot be read, and stops to confirm only a dangerous command or
 * one that names a path outside the workspace. Every deny keeps its effect,
 * and bypass, ask and accept-edits are unchanged.
 *
 * Requests are built the way the DSH host builds them (`analyzePwsh` feeding
 * the request, as `authorizeTarget` does), on the POSIX spelling like
 * `pwshGate.test.ts`. The bash spelling of the same cases runs on the real
 * grammar in `src/dsh-host/permissions/__tests__/bashGate.test.ts`.
 */

const ROOT = path.resolve('/ws');
const ENV = { HOME: '/home/me', TEMP: '/tmp/me', FLAGS: '' };
let ids = 0;

function pwsh(command: string, workdir = ROOT): ToolPermissionRequest {
  const analysis = analyzePwsh(command, workdir, ENV, { platform: 'linux' });
  return {
    tool: 'pwsh',
    toolCallId: `call-${++ids}`,
    path: workdir,
    command,
    paths: analysis.paths,
    commands: analysis.commands,
    unresolvedPaths: analysis.unresolvedPaths,
    exploration: analysis.exploration,
    ...(analysis.ungrantable ? { ungrantable: true } : {}),
    ...(analysis.parameterPaths ? { parameterPaths: analysis.parameterPaths } : {}),
  };
}

function gate(
  gear: 'ask' | 'accept-edits' | 'auto' | 'bypass',
  answer: 'allow-once' | 'allow-session' = 'allow-once'
) {
  const asked: string[] = [];
  const instance = new PermissionGate({
    cwd: ROOT,
    gear,
    approve: async (request) => {
      asked.push(request.command ?? request.tool);
      return answer;
    },
  });
  return { gate: instance, asked };
}

describe('full auto runs a workspace command it cannot fully read', () => {
  it.each([
    'echo $HOME',
    'npm test $FLAGS',
    'npm test $UNSET_FLAGS',
    'Get-ChildItem | Where-Object { $_.Length -gt 1 }',
    'Get-Content $env:TEMP/build.log',
    'Write-Output $X > out.txt',
    'python build.py',
    'npm run build 2>$null',
    'Remove-Item notes.txt',
  ])('%s', async (command) => {
    const { gate: g, asked } = gate('auto');
    expect(g.evaluate(pwsh(command))).toBe('allow');
    await g.authorize(pwsh(command));
    expect(asked).toEqual([]);
  });
});

describe('full auto still asks', () => {
  it.each([
    'Remove-Item -Recurse -Force build',
    'rm build -r',
    'del build -Recurse',
    'git push --force',
    'git push -f origin main',
    'git reset --hard',
    'git clean -fdx',
    'npm test; Remove-Item -Recurse dist',
    // Even when the rest of the line cannot be read.
    'Remove-Item $dir -Recurse',
  ])('for the dangerous command %s', (command) => {
    expect(gate('auto').gate.evaluate(pwsh(command))).toBe('ask');
  });

  it.each([
    'Get-Content /etc/hosts',
    'Copy-Item a.txt ../elsewhere/a.txt',
    'Get-ChildItem ~/Downloads',
    'Set-Location /tmp; Get-ChildItem',
    'npm test > /tmp/out.txt',
  ])('for %s, which names a path outside the workspace', (command) => {
    expect(gate('auto').gate.evaluate(pwsh(command))).toBe('ask');
  });

  it('but not for a path it reaches only through the environment', () => {
    const request = pwsh('Get-ChildItem $HOME');
    expect(request.paths).toContain(path.posix.normalize('/home/me'));
    expect(request.parameterPaths).toEqual(['/home/me']);
    expect(gate('auto').gate.evaluate(request)).toBe('allow');
    // Spelled out as well, it is explicit again.
    expect(gate('auto').gate.evaluate(pwsh('Get-ChildItem $HOME /home/me'))).toBe('ask');
  });

  it('for a workdir outside the workspace', () => {
    expect(gate('auto').gate.evaluate(pwsh('npm test', path.resolve('/elsewhere')))).toBe('ask');
  });

  it('leaves an opaque program and a host ask asking as before', () => {
    const g = gate('auto').gate;
    expect(
      g.evaluate({
        tool: 'run_code',
        toolCallId: 'p',
        path: ROOT,
        policySurface: 'run_code',
        policyValue: 'run_code',
        unresolvedPaths: true,
      })
    ).toBe('ask');
    expect(
      g.evaluate({
        tool: 'pwsh',
        toolCallId: 'h',
        path: ROOT,
        unresolvedPaths: true,
        hostAsk: { sandbox: false },
      })
    ).toBe('ask');
  });

  it('lets a session grant the user gave cover the same command again, inside the workspace', async () => {
    const { gate: g, asked } = gate('auto', 'allow-session');
    await g.authorize(pwsh('git push --force'));
    await g.authorize(pwsh('git push --force'));
    expect(asked).toEqual(['git push --force']);
  });
});

describe('what full auto leaves alone', () => {
  it('still refuses what a deny rule refuses, and the bundled secrets', async () => {
    const policy = await loadPermissionPolicy(
      {
        readFile: async (file: string) => {
          if (file !== path.join('/agent', 'pi-permissions.jsonc'))
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return {
            bytes: new TextEncoder().encode(
              '{ "permission": { "bash": { "npm publish*": "deny" } } }'
            ),
          };
        },
      },
      { cwd: ROOT, agentDir: '/agent', sources: { user: true, project: false, local: false } }
    );
    const g = new PermissionGate({ cwd: ROOT, gear: 'auto', policy });
    expect(g.evaluate(pwsh('npm publish $TAG'))).toBe('deny');
    expect(g.evaluate(pwsh('Get-Content .env'))).toBe('deny');
    expect(
      new PermissionGate({
        cwd: ROOT,
        gear: 'auto',
        scopes: [{ root: path.join(ROOT, 'private'), tools: ['pwsh'], action: 'deny' }],
      }).evaluate(pwsh('Get-Content private/a.txt'))
    ).toBe('deny');
    expect(
      new PermissionGate({ cwd: ROOT, gear: 'auto', mode: 'plan' }).evaluate(pwsh('npm test $X'))
    ).toBe('deny');
    expect(
      new PermissionGate({ cwd: ROOT, gear: 'auto', allowedTools: ['read'] }).evaluate(pwsh('ls'))
    ).toBe('deny');
  });

  it('leaves bypass answering everything that is not denied', () => {
    const g = gate('bypass').gate;
    for (const command of ['Remove-Item -Recurse build', 'Get-Content /etc/hosts', 'npm test $X'])
      expect(g.evaluate(pwsh(command)), command).toBe('allow');
    expect(g.evaluate(pwsh('Get-Content .env'))).toBe('deny');
  });

  it('leaves ask and accept-edits asking about a command they cannot read', () => {
    expect(gate('accept-edits').gate.evaluate(pwsh('npm test $X'))).toBe('ask');
    expect(gate('accept-edits').gate.evaluate(pwsh('npm test'))).toBe('allow');
    expect(gate('ask').gate.evaluate(pwsh('npm test'))).toBe('ask');
  });
});

describe('which paths a pwsh command reaches only through the environment', () => {
  const read = (command: string) =>
    analyzePwsh(command, ROOT, ENV, { platform: 'linux' }).parameterPaths ?? [];

  it('names `$HOME`, `$env:NAME` and what a relative path reaches after `cd` to one', () => {
    expect(read('Get-ChildItem $HOME')).toEqual(['/home/me']);
    expect(read('Get-Content $env:TEMP/a.log')).toEqual(['/tmp/me/a.log']);
    expect(read('Set-Location $env:TEMP; Get-Content a.log')).toEqual(['/tmp/me', '/tmp/me/a.log']);
  });

  it('names nothing the command spells out, `~` included', () => {
    expect(read('Get-Content /etc/hosts')).toEqual([]);
    expect(read('Get-ChildItem ~/Downloads')).toEqual([]);
    expect(read('Set-Location /tmp; Get-Content a.log')).toEqual([]);
    expect(read('Get-Content a.txt')).toEqual([]);
  });
});

describe('the shell path check keeps parameter operands apart (decision 191)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'perm-auto-gear-')));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('carries them through wildcard expansion, and drops one the command also spells', async () => {
    await mkdir(join(dir, 'logs'));
    await writeFile(join(dir, 'logs', 'a.log'), '');
    await writeFile(join(dir, 'b.txt'), '');
    const analysis: BashAnalysis = {
      paths: [join(dir, 'logs', '*.log'), join(dir, 'b.txt')],
      commands: ['cat'],
      unresolvedPaths: false,
      exploration: true,
      parameterPaths: [join(dir, 'logs', '*.log')],
    };
    const checked = await checkShellPaths(analysis, { fs: nodeFs, cwd: dir });
    expect(checked.parameterPaths).toEqual([join(dir, 'logs'), join(dir, 'logs', 'a.log')].sort());
    expect(checked.paths).toContain(join(dir, 'b.txt'));

    // `cat $LOGS/*.log logs/a.log`: the expansion reaches a file the command
    // also names, which makes that one explicit.
    const both = await checkShellPaths(
      { ...analysis, paths: [join(dir, 'logs', '*.log'), join(dir, 'logs', 'a.log')] },
      { fs: nodeFs, cwd: dir }
    );
    expect(both.parameterPaths).toEqual([join(dir, 'logs')]);
    const spelled = await checkShellPaths(
      { ...analysis, parameterPaths: [] },
      { fs: nodeFs, cwd: dir }
    );
    expect(spelled).not.toHaveProperty('parameterPaths');
  });
});
