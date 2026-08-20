import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/**
 * Every write-side entry point is Windows-gated (packaging spec §4.3, R5), so a
 * test exercising one has to say which platform it is on. This whole file drives
 * the Windows toolchain (`cmd.exe`, `powershell.exe`), which was always its
 * implicit assumption — the gate just makes it explicit.
 */
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}
const REAL_PLATFORM = process.platform;

describe('AgentInstaller', () => {
  beforeEach(() => {
    setPlatform('win32');
  });

  afterEach(() => {
    setPlatform(REAL_PLATFORM);
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

/**
 * Packaging spec §7.2 B6 / B7 (R5, 改判 ⑥) — the write-side entry points are
 * Windows-only; the probe members must stay callable everywhere.
 */
describe('AgentInstaller platform gate (B6, B7)', () => {
  afterEach(() => {
    setPlatform(REAL_PLATFORM);
    spawnMock.mockReset();
    existsSyncMock.mockReset();
    detectOneMock.mockReset();
  });

  for (const platform of ['linux', 'darwin'] as const) {
    describe(`on ${platform}`, () => {
      beforeEach(() => {
        setPlatform(platform);
      });

      it('installGit throws and names the platform requirement', async () => {
        const { AgentInstaller } = await import('../AgentInstaller');
        await expect(new AgentInstaller().installGit()).rejects.toThrow(/Windows-only/);
      });

      it('installNode throws', async () => {
        const { AgentInstaller } = await import('../AgentInstaller');
        await expect(new AgentInstaller().installNode()).rejects.toThrow(/Windows-only/);
      });

      it('installAgent throws', async () => {
        const { AgentInstaller } = await import('../AgentInstaller');
        await expect(new AgentInstaller().installAgent('claude')).rejects.toThrow(/Windows-only/);
      });

      it('downgradeClaudeToNodeVersion throws', async () => {
        const { AgentInstaller } = await import('../AgentInstaller');
        await expect(new AgentInstaller().downgradeClaudeToNodeVersion()).rejects.toThrow(
          /Windows-only/
        );
      });

      it('installAll does NOT throw — it returns the InstallResult contract', async () => {
        // M15 arm: the orchestrator's gate must stay inside the try. Throwing
        // out of installAll would reach the renderer as an unclassified IPC
        // error instead of {success:false, errors:[...]}.
        const { AgentInstaller } = await import('../AgentInstaller');
        const result = await new AgentInstaller().installAll(['claude'], vi.fn());

        expect(result.success).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatch(/Windows-only/);
        expect(result.cancelled).toBeUndefined();
      });

      it('B7 negative control: checkPrerequisites stays callable', async () => {
        // OnboardingService calls this on every platform (改判 ⑥). Gating it
        // would take Linux/mac onboarding down entirely.
        spawnMock.mockImplementation(() => createSpawnProcess({ exitCode: 1 }));
        existsSyncMock.mockReturnValue(false);

        const { AgentInstaller } = await import('../AgentInstaller');
        const status = await new AgentInstaller().checkPrerequisites();

        expect(status.gitInstalled).toBe(false);
        expect(status.nodeInstalled).toBe(false);
      });
    });
  }

  it('does not gate the write entry points on win32', async () => {
    setPlatform('win32');
    const { AgentInstaller } = await import('../AgentInstaller');
    const installer = new AgentInstaller();
    installer.cancel();
    // Reaches the cancellation check rather than the platform gate.
    await expect(installer.installGit()).rejects.toThrow(/cancelled/i);
  });
});
