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

describe('ShellDetector', () => {
  beforeEach(() => {
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
    vi.restoreAllMocks();
  });

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
