import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OnboardingPrerequisiteStatus } from '@shared/types';
import { killProcessTree } from '../../utils/processUtils';
import { clearPathCache } from '../terminal/PtyManager';

const GIT_INSTALLER_URL =
  'https://npmmirror.com/mirrors/git-for-windows/v2.43.0.windows.1/Git-2.43.0-64-bit.exe';
const POWERSHELL_EXECUTABLE = 'powershell.exe';

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface RunCommandOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

interface DetectedGitStatus {
  installed: boolean;
  version?: string;
  bashPath?: string;
}

interface DetectedNodeStatus {
  installed: boolean;
  version?: string;
  majorVersion?: number;
}

class InstallAbortedError extends Error {
  constructor() {
    super('Installation cancelled');
    this.name = 'InstallAbortedError';
  }
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseNodeMajorVersion(version?: string): number | undefined {
  if (!version) {
    return undefined;
  }

  const match = version.match(/v?(\d+)\./);
  if (!match) {
    return undefined;
  }

  return Number.parseInt(match[1], 10);
}

function getKnownGitBashPaths(): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  return [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    localAppData ? path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe') : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup failures.
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  const { env, signal } = options;

  if (signal?.aborted) {
    throw new InstallAbortedError();
  }

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener('abort', handleAbort);
    };

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = (result: CommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const handleAbort = () => {
      killProcessTree(child);
      rejectOnce(new InstallAbortedError());
    };

    signal?.addEventListener('abort', handleAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      rejectOnce(error instanceof Error ? error : new Error(String(error)));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolveOnce({ stdout, stderr });
        return;
      }

      const message =
        stderr.trim() || stdout.trim() || `${command} exited with code ${code ?? 'unknown'}`;
      rejectOnce(new Error(message));
    });
  });
}

async function runPowerShell(
  command: string,
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  return await runCommand(
    POWERSHELL_EXECUTABLE,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    options
  );
}

async function runCmd(command: string, options: RunCommandOptions = {}): Promise<CommandResult> {
  return await runCommand('cmd.exe', ['/d', '/s', '/c', command], options);
}

export class GitInstaller {
  private readonly abortController = new AbortController();

  cancel(): void {
    this.abortController.abort();
  }

  async checkPrerequisites(): Promise<OnboardingPrerequisiteStatus> {
    const [gitStatus, nodeStatus, wingetAvailable] = await Promise.all([
      this.detectGit(),
      this.detectNode(),
      this.checkWingetAvailable(),
    ]);

    return {
      gitInstalled: gitStatus.installed,
      gitVersion: gitStatus.version,
      nodeInstalled: nodeStatus.installed,
      nodeVersion: nodeStatus.version,
      wingetAvailable,
    };
  }

  async refreshPath(): Promise<void> {
    this.ensureNotCancelled();

    const { stdout } = await runPowerShell(
      [
        "$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
        "$user = [Environment]::GetEnvironmentVariable('Path', 'User')",
        "Write-Output ($machine + ';' + $user)",
      ].join('; '),
      { signal: this.abortController.signal }
    );

    const refreshedPath = stdout.trim();
    if (refreshedPath) {
      process.env.PATH = refreshedPath;
      clearPathCache();
    }
  }

  async installGit(onUpdate?: (message: string) => void): Promise<void> {
    this.ensureWindowsOnly('installGit');
    this.ensureNotCancelled();

    if (await this.checkWingetAvailable()) {
      onUpdate?.('Installing Git with winget...');
      try {
        await runCmd(
          'winget install Git.Git --accept-package-agreements --accept-source-agreements',
          { signal: this.abortController.signal }
        );
      } catch {
        onUpdate?.('winget failed, downloading Git installer...');
      }
    } else {
      onUpdate?.('winget unavailable, downloading Git installer...');
    }

    await this.refreshPath();
    let gitStatus = await this.detectGit();
    if (!gitStatus.installed || !gitStatus.bashPath) {
      const installerPath = path.join(os.tmpdir(), 'aiclient-onboarding-git-installer.exe');
      onUpdate?.('Downloading Git installer...');
      await runPowerShell(
        `Invoke-WebRequest -Uri ${quotePowerShell(GIT_INSTALLER_URL)} -OutFile ${quotePowerShell(installerPath)} -UseBasicParsing -ErrorAction Stop`,
        { signal: this.abortController.signal }
      );

      try {
        onUpdate?.('Running Git installer...');
        await runCommand(installerPath, ['/VERYSILENT', '/NORESTART'], {
          signal: this.abortController.signal,
        });
      } finally {
        safeUnlink(installerPath);
      }

      await this.refreshPath();
      gitStatus = await this.detectGit();
    }

    if (!gitStatus.installed || !gitStatus.bashPath) {
      throw new Error('Git installation finished, but bash.exe was not found.');
    }
  }

  private ensureNotCancelled(): void {
    if (this.abortController.signal.aborted) {
      throw new InstallAbortedError();
    }
  }

  /**
   * Every write-side entry point here drives `cmd.exe` / PowerShell / msiexec
   * (`runCmd` is `runCommand('cmd.exe', ['/d','/s','/c', ...])`). On any other
   * platform those spawns fail with a raw `spawn cmd.exe ENOENT`, which tells
   * the user nothing about what actually went wrong (packaging spec §4.3, R5).
   *
   * Deliberately NOT applied to the probe members (`checkPrerequisites`,
   * `refreshPath`, `detectGit`, `detectNode`, `checkWingetAvailable`):
   * `OnboardingService` calls `checkPrerequisites()` on every platform, so
   * gating those would take Linux/mac onboarding down entirely (改判 ⑥).
   */
  private ensureWindowsOnly(member: string): void {
    if (process.platform !== 'win32') {
      throw new Error(
        `GitInstaller.${member} is Windows-only — it drives the ` +
          `cmd.exe/PowerShell/msiexec toolchain, which is not available on ` +
          `${process.platform}. Install the CLI manually on this platform.`
      );
    }
  }

  private async checkWingetAvailable(): Promise<boolean> {
    try {
      await runCmd('winget --version', { signal: this.abortController.signal });
      return true;
    } catch {
      return false;
    }
  }

  private async detectGit(): Promise<DetectedGitStatus> {
    const bashPath = await this.findGitBashPath();

    try {
      const { stdout } = await runCommand('git', ['--version'], {
        signal: this.abortController.signal,
      });

      return {
        installed: true,
        version: stdout.trim(),
        bashPath,
      };
    } catch {
      return {
        installed: Boolean(bashPath),
        bashPath,
      };
    }
  }

  private async detectNode(): Promise<DetectedNodeStatus> {
    try {
      const { stdout } = await runCommand('node', ['--version'], {
        signal: this.abortController.signal,
      });
      const version = stdout.trim();
      const majorVersion = parseNodeMajorVersion(version);
      return {
        installed: typeof majorVersion === 'number' ? majorVersion >= 18 : false,
        version,
        majorVersion,
      };
    } catch {
      return {
        installed: false,
      };
    }
  }

  private async findGitBashPath(): Promise<string | undefined> {
    for (const candidate of getKnownGitBashPaths()) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    try {
      const { stdout } = await runCommand('where.exe', ['git'], {
        signal: this.abortController.signal,
      });
      const gitExecutable = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);

      if (!gitExecutable) {
        return undefined;
      }

      const gitRoot = path.resolve(path.dirname(gitExecutable), '..');
      const bashPath = path.join(gitRoot, 'bin', 'bash.exe');
      return fs.existsSync(bashPath) ? bashPath : undefined;
    } catch {
      return undefined;
    }
  }
}
