import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SHELL_WORKDIR_DENIAL,
  shellWorkdirTarget,
  type WorkdirProbe,
  workdirExistenceDenial,
  workdirSyntaxDenial,
} from '../shellWorkdir.ts';

/**
 * Decision 164 (GitHub issue #2) — a shell call's `workdir` is refused with
 * what is wrong with it, instead of reaching Node's `spawn <shell> ENOENT`.
 * Real temporary directories on this machine; an injected probe for the
 * Windows path algebra.
 */

let ws: string;

beforeAll(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'shell-workdir-')));
  mkdirSync(join(ws, 'sub'));
  writeFileSync(join(ws, 'file.txt'), 'x\n');
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

const linux = (tool: string, args: Record<string, unknown>, cwd = ws) =>
  workdirExistenceDenial(tool, { command: 'ls', ...args }, cwd, 'linux');

/** A Windows disk that records what was asked and holds `directories`. */
function windowsDisk(directories: string[]) {
  const asked: string[] = [];
  const probe: WorkdirProbe = {
    stat: async (path) => {
      asked.push(path);
      if (!directories.includes(path))
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return { isDirectory: () => true };
    },
    access: async () => {},
  };
  return { asked, probe };
}

describe('the existence check (after the gate)', () => {
  it('refuses a missing relative workdir, naming the target and the workspace', async () => {
    const decision = await linux('bash', { workdir: 'nope' });
    expect(decision).toEqual({
      kind: 'deny',
      reason: `working directory does not exist: ${ws}/nope (the session workspace is ${ws})`,
      info: { name: SHELL_WORKDIR_DENIAL, code: 'workdir_missing' },
    });
    expect(decision?.info?.name).not.toBe('PermissionDenial');
  });

  it('passes an existing directory, relative or absolute, and no workdir at all', async () => {
    expect(await linux('bash', { workdir: 'sub' })).toBeUndefined();
    expect(await linux('bash', { workdir: join(ws, 'sub') })).toBeUndefined();
    expect(await linux('pwsh', { workdir: 'sub' })).toBeUndefined();
    expect(await linux('bash', {})).toBeUndefined();
    expect(await linux('bash', { workdir: '' })).toBeUndefined();
  });

  it('refuses a file', async () => {
    expect(await linux('bash', { workdir: 'file.txt' })).toEqual({
      kind: 'deny',
      reason: `working directory is not a directory: ${ws}/file.txt`,
      info: { name: SHELL_WORKDIR_DENIAL, code: 'workdir_not_directory' },
    });
    // A path through the file: ENOTDIR, so it does not exist.
    expect((await linux('bash', { workdir: 'file.txt/x' }))?.info?.code).toBe('workdir_missing');
  });

  it('refuses a call without workdir when the session workspace is gone', async () => {
    const gone = realpathSync(mkdtempSync(join(tmpdir(), 'shell-workdir-gone-')));
    rmSync(gone, { recursive: true });
    expect(await linux('bash', {}, gone)).toEqual({
      kind: 'deny',
      reason: `the session workspace does not exist: ${gone}; it may have been moved or deleted`,
      info: { name: SHELL_WORKDIR_DENIAL, code: 'workdir_missing' },
    });
  });

  it('says that "~" is not expanded', async () => {
    const decision = await linux('bash', { workdir: '~/x' });
    expect(decision?.reason).toBe(
      `working directory does not exist: ${ws}/~/x (the session workspace is ${ws}); "~" is not expanded in workdir, give the full path`
    );
  });

  it('leaves tools other than the shells alone', async () => {
    expect(await linux('read', { workdir: 'nope' })).toBeUndefined();
    expect(await linux('run_code', { workdir: 'nope' })).toBeUndefined();
  });

  it('resolves a Windows workdir as each tool does', async () => {
    const disk = windowsDisk(['E:\\code\\proj\\sub', 'E:\\code\\other']);
    const run = (tool: string, workdir?: string) =>
      workdirExistenceDenial(
        tool,
        workdir === undefined ? {} : { workdir },
        'E:\\code\\proj',
        'win32',
        disk.probe
      );
    expect(await run('pwsh', 'sub')).toBeUndefined();
    expect(await run('pwsh', '..\\other')).toBeUndefined();
    expect(await run('bash', 'sub')).toBeUndefined();
    expect((await run('pwsh', 'E:\\missing'))?.info?.code).toBe('workdir_missing');
    expect(disk.asked).toEqual([
      'E:\\code\\proj\\sub',
      'E:\\code\\other',
      'E:\\code\\proj\\sub',
      'E:\\missing',
    ]);
    expect(shellWorkdirTarget('bash', '..\\other', 'E:\\code\\proj', 'win32')).toBe(
      'E:\\code\\proj\\..\\other'
    );
    expect(shellWorkdirTarget('pwsh', undefined, 'E:\\code\\proj', 'win32')).toBe('E:\\code\\proj');
  });

  it('lets other disk errors through to the tool', async () => {
    const probe: WorkdirProbe = {
      stat: async () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      },
      access: async () => {},
    };
    expect(
      await workdirExistenceDenial('pwsh', { workdir: 'x' }, 'E:\\code', 'win32', probe)
    ).toBeUndefined();
  });

  const unprivileged = process.platform !== 'win32' && process.getuid?.() !== 0;
  it.skipIf(!unprivileged)('refuses a directory that cannot be entered', async () => {
    const locked = join(ws, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      expect(await linux('bash', { workdir: 'locked' })).toEqual({
        kind: 'deny',
        reason: `working directory is not accessible: ${locked}`,
        info: { name: SHELL_WORKDIR_DENIAL, code: 'workdir_not_accessible' },
      });
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

describe('the syntax check (before the gate)', () => {
  const check = (workdir: string, tool = 'pwsh', platform: NodeJS.Platform = 'win32') =>
    workdirSyntaxDenial(tool, { command: 'git status', workdir }, 'E:\\code\\proj', platform);

  it('refuses a rooted Windows path with no drive', () => {
    expect(check('/Users/tester/work/monorepo')).toEqual({
      kind: 'deny',
      reason:
        'workdir "/Users/tester/work/monorepo" has no drive letter; on Windows give a full path such as E:\\code\\proj, or omit workdir to run in the session workspace',
      info: { name: SHELL_WORKDIR_DENIAL, code: 'workdir_no_drive' },
    });
    expect(check('\\work')?.info?.code).toBe('workdir_no_drive');
  });

  it('passes drive, UNC and relative paths, other platforms and other tools', () => {
    expect(check('E:\\code')).toBeUndefined();
    expect(check('\\\\server\\share')).toBeUndefined();
    expect(check('//server/share')).toBeUndefined();
    expect(check('sub')).toBeUndefined();
    expect(check('/Users/tester', 'bash', 'linux')).toBeUndefined();
    expect(check('/Users/tester', 'read')).toBeUndefined();
    expect(
      workdirSyntaxDenial('pwsh', { command: 'ls' }, 'E:\\code\\proj', 'win32')
    ).toBeUndefined();
  });
});
