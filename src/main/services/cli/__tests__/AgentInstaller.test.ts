import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const existsSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const detectOneMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: existsSyncMock,
    unlinkSync: unlinkSyncMock,
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
});
