import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const existsSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const readdirSyncMock = vi.fn();
const detectOneMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: existsSyncMock,
    unlinkSync: unlinkSyncMock,
    readdirSync: readdirSyncMock,
  },
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => 'C:\\fake\\app'),
  },
}));

vi.mock('../../../utils/processUtils', () => ({
  killProcessTree: vi.fn(),
}));

vi.mock('../../terminal/PtyManager', () => ({
  clearPathCache: vi.fn(),
}));

vi.mock('../CliDetector', () => ({
  cliDetector: {
    detectOne: detectOneMock,
  },
}));

function createSpawnProcess({
  stdout = '',
  stderr = '',
  exitCode = 0,
}: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };

  child.pid = 1234;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  queueMicrotask(() => {
    if (stdout) {
      child.stdout.emit('data', Buffer.from(stdout));
    }
    if (stderr) {
      child.stderr.emit('data', Buffer.from(stderr));
    }
    child.emit('close', exitCode);
  });

  return child;
}

describe('AgentInstaller', () => {
  afterEach(() => {
    spawnMock.mockReset();
    existsSyncMock.mockReset();
    unlinkSyncMock.mockReset();
    readdirSyncMock.mockReset();
    detectOneMock.mockReset();
  });

  it('detects prerequisite versions and winget availability', async () => {
    existsSyncMock.mockImplementation((filePath: string) =>
      filePath.includes('Program Files\\Git\\bin\\bash.exe')
    );

    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === '--version') {
        return createSpawnProcess({ stdout: 'git version 2.43.0.windows.1\n' });
      }

      if (command === 'node' && args[0] === '--version') {
        return createSpawnProcess({ stdout: 'v20.10.0\n' });
      }

      if (command === 'cmd.exe' && args.join(' ') === '/d /s /c winget --version') {
        return createSpawnProcess({ stdout: 'v1.7.10582\n' });
      }

      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });

    const { AgentInstaller } = await import('../AgentInstaller');
    const installer = new AgentInstaller();

    await expect(installer.checkPrerequisites()).resolves.toEqual({
      gitInstalled: true,
      gitVersion: 'git version 2.43.0.windows.1',
      nodeInstalled: true,
      nodeVersion: 'v20.10.0',
      wingetAvailable: true,
    });
  });

  it('returns cancelled when installAll is aborted before work starts', async () => {
    const { AgentInstaller } = await import('../AgentInstaller');
    const installer = new AgentInstaller();
    installer.cancel();

    await expect(installer.installAll(['claude'], vi.fn())).resolves.toEqual({
      success: false,
      cancelled: true,
      errors: ['Installation cancelled.'],
    });
  });

  it('retries npm install once after ECONNRESET and then succeeds', async () => {
    let npmAttempts = 0;

    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (
        command === 'cmd.exe' &&
        args.join(' ').includes('npm install -g @anthropic-ai/claude-code')
      ) {
        npmAttempts += 1;
        return createSpawnProcess(
          npmAttempts === 1
            ? {
                stderr: 'npm error code ECONNRESET\nnpm error network read ECONNRESET\n',
                exitCode: 1,
              }
            : { stdout: 'added 1 package in 3s\n' }
        );
      }

      if (command === 'powershell.exe') {
        return createSpawnProcess({
          stdout: 'C:\\Windows\\System32;C:\\Users\\ga\\AppData\\Roaming\\npm\n',
        });
      }

      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });

    detectOneMock.mockResolvedValue({
      id: 'claude',
      name: 'Claude',
      command: 'claude',
      installed: true,
      version: '1.0.72',
      isBuiltin: true,
      environment: 'native',
    });

    const { AgentInstaller } = await import('../AgentInstaller');
    const installer = new AgentInstaller();

    await expect(installer.installAgent('claude')).resolves.toBeUndefined();
    expect(npmAttempts).toBe(2);
  });

  it('falls back to offline tgz when vflow remote registry install fails', async () => {
    let remoteAttempts = 0;
    let tgzInstallCalled = false;

    existsSyncMock.mockImplementation((p: string) => p.includes('vflow-pkg'));
    readdirSyncMock.mockReturnValue(['p1p1dan-vflow-0.5.1.tgz']);

    spawnMock.mockImplementation((command: string, args: string[]) => {
      const joined = args.join(' ');
      if (command === 'cmd.exe' && joined.includes('npm install -g @p1p1dan/vflow')) {
        remoteAttempts += 1;
        return createSpawnProcess({
          stderr: 'npm error 503 backend unavailable',
          exitCode: 1,
        });
      }
      if (
        command === 'cmd.exe' &&
        joined.includes('npm install -g') &&
        joined.includes('p1p1dan-vflow-0.5.1.tgz')
      ) {
        tgzInstallCalled = true;
        return createSpawnProcess({ stdout: 'added 1 package in 1s\n' });
      }
      if (command === 'powershell.exe') {
        return createSpawnProcess({
          stdout: 'C:\\Windows\\System32;C:\\Users\\test\\AppData\\Roaming\\npm\n',
        });
      }
      throw new Error(`Unexpected spawn: ${command} ${joined}`);
    });

    detectOneMock.mockResolvedValue({
      id: 'vflow',
      name: 'vflow',
      command: 'vflow',
      installed: true,
      version: '0.5.1',
      isBuiltin: true,
      environment: 'native',
    });

    const { AgentInstaller } = await import('../AgentInstaller');
    const installer = new AgentInstaller();

    await expect(installer.installAgent('vflow')).resolves.toBeUndefined();
    expect(remoteAttempts).toBe(1);
    expect(tgzInstallCalled).toBe(true);
  });

  it('rethrows the remote error when vflow offline tgz is missing', async () => {
    existsSyncMock.mockReturnValue(false);
    readdirSyncMock.mockReturnValue([]);

    spawnMock.mockImplementation((command: string, args: string[]) => {
      const joined = args.join(' ');
      if (command === 'cmd.exe' && joined.includes('npm install -g @p1p1dan/vflow')) {
        return createSpawnProcess({
          stderr: 'npm error 503 backend unavailable',
          exitCode: 1,
        });
      }
      throw new Error(`Unexpected spawn: ${command} ${joined}`);
    });

    const { AgentInstaller } = await import('../AgentInstaller');
    const installer = new AgentInstaller();

    await expect(installer.installAgent('vflow')).rejects.toThrow(/503 backend unavailable/);
  });

  it('throws when both vflow remote and offline tgz installs fail', async () => {
    existsSyncMock.mockImplementation((p: string) => p.includes('vflow-pkg'));
    readdirSyncMock.mockReturnValue(['p1p1dan-vflow-0.5.1.tgz']);

    spawnMock.mockImplementation((command: string, args: string[]) => {
      const joined = args.join(' ');
      if (command === 'cmd.exe' && joined.includes('npm install -g @p1p1dan/vflow')) {
        return createSpawnProcess({
          stderr: 'remote-failure',
          exitCode: 1,
        });
      }
      if (
        command === 'cmd.exe' &&
        joined.includes('npm install -g') &&
        joined.includes('p1p1dan-vflow-0.5.1.tgz')
      ) {
        return createSpawnProcess({
          stderr: 'EACCES: permission denied',
          exitCode: 1,
        });
      }
      throw new Error(`Unexpected spawn: ${command} ${joined}`);
    });

    const { AgentInstaller } = await import('../AgentInstaller');
    const installer = new AgentInstaller();

    await expect(installer.installAgent('vflow')).rejects.toThrow(/EACCES/);
  });

  it('quotes the tgz path so paths containing spaces install correctly', async () => {
    // Simulate a packaged install under "C:\Program Files\AiClient" where the
    // resources path contains a space. The fallback command must wrap the path
    // in double quotes, otherwise cmd.exe splits it on the space and npm sees a
    // missing argument.
    const electron = await import('electron');
    const originalGetAppPath = electron.app.getAppPath;
    // @ts-expect-error overriding mocked getter for this case
    electron.app.getAppPath = vi.fn(() => 'C:\\Program Files\\AiClient');

    existsSyncMock.mockImplementation((p: string) => p.includes('vflow-pkg'));
    readdirSyncMock.mockReturnValue(['p1p1dan-vflow-0.5.1.tgz']);

    let tgzCommand = '';
    spawnMock.mockImplementation((command: string, args: string[]) => {
      const joined = args.join(' ');
      if (command === 'cmd.exe' && joined.includes('npm install -g @p1p1dan/vflow')) {
        return createSpawnProcess({ stderr: 'remote-down', exitCode: 1 });
      }
      if (
        command === 'cmd.exe' &&
        joined.includes('npm install -g') &&
        joined.includes('p1p1dan-vflow-0.5.1.tgz')
      ) {
        tgzCommand = joined;
        return createSpawnProcess({ stdout: 'added 1 package\n' });
      }
      if (command === 'powershell.exe') {
        return createSpawnProcess({ stdout: 'C:\\Windows\\System32\n' });
      }
      throw new Error(`Unexpected spawn: ${command} ${joined}`);
    });

    detectOneMock.mockResolvedValue({
      id: 'vflow',
      name: 'vflow',
      command: 'vflow',
      installed: true,
      version: '0.5.1',
      isBuiltin: true,
      environment: 'native',
    });

    const { AgentInstaller } = await import('../AgentInstaller');
    const installer = new AgentInstaller();

    try {
      await expect(installer.installAgent('vflow')).resolves.toBeUndefined();
      // The full quoted path must appear verbatim in the command string,
      // including the embedded space. If quoting is dropped, the path is split.
      expect(tgzCommand).toContain('"C:\\Program Files\\AiClient\\resources\\vflow-pkg\\p1p1dan-vflow-0.5.1.tgz"');
    } finally {
      // @ts-expect-error restore mock for later tests
      electron.app.getAppPath = originalGetAppPath;
    }
  });
});
