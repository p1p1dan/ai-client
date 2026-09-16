import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.fn();
const spawnSyncMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  exec: execMock,
  spawnSync: spawnSyncMock,
}));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
}));

/**
 * `ShellDetector.ts:7` freezes `process.platform` into a module-scope
 * `const isWindows` at import time, so these Windows-behaviour tests never
 * simulated Windows — they relied on the HOST being Windows, and went red on
 * every other platform. That is the worst shape a test can have: it asserts
 * nothing on the machine running it while looking like coverage.
 *
 * The import is already dynamic and already behind `vi.resetModules()`, so
 * stubbing the platform in `beforeEach` lands before the module evaluates its
 * const and the suite now exercises the real Windows branches everywhere. No
 * production change is needed for this — the seam was already there.
 */
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value });
}

/**
 * Load a fresh copy of the module on a chosen platform. `isWindows` is frozen
 * into a module-scope const at import time, so the platform has to be stubbed
 * before the import, not before the call.
 */
async function loadDetector(platform: NodeJS.Platform) {
  setPlatform(platform);
  vi.resetModules();
  const module = await import('../ShellDetector');
  module.shellDetector.clearCache();
  return module;
}

// File-scope, so the platform stub and the module mocks are reset for the
// Unix-side suites below as well.
beforeEach(() => {
  setPlatform('win32');
  vi.resetModules();
  execMock.mockReset();
  spawnSyncMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
  execMock.mockImplementation((_command, _options, callback) => {
    callback?.(new Error('wsl unavailable'), '', '');
    return {} as never;
  });
});

afterEach(() => {
  // Restore the original descriptor, not just the value: `platform` is an
  // accessor on the real `process`, and leaving a data property behind would
  // outlive this file if the pool ever stops isolating per file.
  if (ORIGINAL_PLATFORM) {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM);
  }
  vi.restoreAllMocks();
});

describe('ShellDetector', () => {
  it('does not report PowerShell 7 as available when pwsh.exe is missing', async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      const target = args?.[0];
      if (command === 'where' && target === 'pwsh.exe') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (command === 'where' && target === 'powershell.exe') {
        return {
          status: 0,
          stdout: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n',
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    });

    const { shellDetector } = await import('../ShellDetector');
    shellDetector.clearCache();

    const shells = await shellDetector.detectShells();
    const pwsh = shells.find((shell) => shell.id === 'powershell7');
    const powershell = shells.find((shell) => shell.id === 'powershell');

    expect(pwsh?.available).toBe(false);
    expect(powershell?.available).toBe(true);
  });

  it('falls back to powershell when shell config requests missing powershell7', async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      const target = args?.[0];
      if (command === 'where' && target === 'pwsh.exe') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (command === 'where' && target === 'powershell.exe') {
        return {
          status: 0,
          stdout: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n',
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    });

    const { shellDetector } = await import('../ShellDetector');
    shellDetector.clearCache();

    const resolved = shellDetector.resolveShellForCommand({
      shellType: 'powershell7',
    });

    expect(resolved).toEqual({
      shell: 'powershell.exe',
      execArgs: ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command'],
    });
  });
});

/**
 * terminal-08 — `inferExecArgs` matched the shell's file name against every
 * definition's paths with `includes`, in an array that puts the Windows shells
 * first. `'pwsh.exe'.includes('sh')` is true, so a Unix `/bin/sh` came back with
 * PowerShell 7's switches and every command run through it failed — which is
 * what made tmux detection report "not installed" on machines whose `$SHELL`
 * is /bin/sh.
 */
describe('ShellDetector — exec args come from the shell you actually have', () => {
  const ORIGINAL_SHELL = process.env.SHELL;

  afterEach(() => {
    if (ORIGINAL_SHELL === undefined) delete process.env.SHELL;
    else process.env.SHELL = ORIGINAL_SHELL;
  });

  it("gives /bin/sh the Bourne switch, not PowerShell's", async () => {
    const { shellDetector } = await loadDetector('linux');

    expect(
      shellDetector.resolveShellForCommand({ shellType: 'custom', customShellPath: '/bin/sh' })
    ).toEqual({ shell: '/bin/sh', execArgs: ['-c'] });
  });

  it('still recognises a Unix shell whose name merely contains another one', async () => {
    const { shellDetector } = await loadDetector('linux');

    expect(
      shellDetector.resolveShellForCommand({ shellType: 'custom', customShellPath: '/bin/zsh' })
    ).toEqual({ shell: '/bin/zsh', execArgs: ['-i', '-l', '-c'] });
  });

  it('does not hand the system shell PowerShell switches either', async () => {
    process.env.SHELL = '/bin/sh';
    existsSyncMock.mockImplementation((path: string) => path === '/bin/sh');
    const { shellDetector } = await loadDetector('linux');

    expect(shellDetector.resolveShellForCommand({ shellType: 'system' })).toEqual({
      shell: '/bin/sh',
      execArgs: ['-c'],
    });
  });

  it('treats an empty custom path as "not chosen yet" rather than as /bin/sh', async () => {
    process.env.SHELL = '/bin/bash';
    existsSyncMock.mockImplementation((path: string) => path === '/bin/bash');
    const { shellDetector } = await loadDetector('linux');

    expect(
      shellDetector.resolveShellForCommand({ shellType: 'custom', customShellPath: '' })
    ).toEqual({ shell: '/bin/bash', execArgs: ['-i', '-l', '-c'] });
  });

  it('keeps matching Windows shells by name on Windows', async () => {
    const { shellDetector } = await loadDetector('win32');

    expect(
      shellDetector.resolveShellForCommand({
        shellType: 'custom',
        customShellPath: 'C:\\Windows\\System32\\cmd.exe',
      })
    ).toEqual({ shell: 'C:\\Windows\\System32\\cmd.exe', execArgs: ['/c'] });
  });
});

/**
 * terminal-09 — `getDefaultShell()` claimed pwsh.exe unconditionally, while the
 * product's own default setting is PowerShell 5.x because PowerShell 7 is a
 * separate install. On a machine without it, that named a shell that is not
 * there.
 */
describe('ShellDetector — the Windows default shell is one that exists', () => {
  it('falls back to powershell.exe when PowerShell 7 is not installed', async () => {
    spawnSyncMock.mockImplementation(() => ({ status: 1, stdout: '', stderr: '' }));
    const { shellDetector } = await loadDetector('win32');

    expect(shellDetector.getDefaultShell()).toBe('powershell.exe');
  });

  it('prefers pwsh.exe when it is on PATH', async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) =>
      command === 'where' && args?.[0] === 'pwsh.exe'
        ? { status: 0, stdout: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n', stderr: '' }
        : { status: 1, stdout: '', stderr: '' }
    );
    const { shellDetector } = await loadDetector('win32');

    expect(shellDetector.getDefaultShell()).toBe('pwsh.exe');
  });
});
