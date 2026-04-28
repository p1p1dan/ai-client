import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type InstallAgentId,
  type InstallProgress,
  type InstallResult,
  LAST_NODE_CLAUDE_VERSION,
  type OnboardingPrerequisiteStatus,
} from '@shared/types';
import { killProcessTree } from '../../utils/processUtils';
import { clearPathCache } from '../terminal/PtyManager';
import { cliDetector } from './CliDetector';
import { disableClaudeAutoUpdates } from './ClaudeRuntimeConfig';

const GIT_INSTALLER_URL =
  'https://npmmirror.com/mirrors/git-for-windows/v2.43.0.windows.1/Git-2.43.0-64-bit.exe';
const NODE_INSTALLER_URL = 'https://npmmirror.com/mirrors/node/v20.10.0/node-v20.10.0-x64.msi';
const NPM_REGISTRY = 'https://registry.npmmirror.com';
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

function isInstallAbortedError(error: unknown): error is InstallAbortedError {
  return error instanceof InstallAbortedError;
}

function isTransientNpmNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toUpperCase();
  return (
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('EAI_AGAIN') ||
    message.includes('ENOTFOUND')
  );
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

export class AgentInstaller {
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

    await this.setGitBashEnv(gitStatus.bashPath);
  }

  async installNode(onUpdate?: (message: string) => void): Promise<void> {
    this.ensureNotCancelled();

    if (await this.checkWingetAvailable()) {
      onUpdate?.('Installing Node.js LTS with winget...');
      try {
        await runCmd(
          'winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements',
          { signal: this.abortController.signal }
        );
      } catch {
        onUpdate?.('winget failed, downloading Node.js installer...');
      }
    } else {
      onUpdate?.('winget unavailable, downloading Node.js installer...');
    }

    await this.refreshPath();
    let nodeStatus = await this.detectNode();
    if (!nodeStatus.installed) {
      const installerPath = path.join(os.tmpdir(), 'aiclient-onboarding-node-installer.msi');
      const installerLogPath = path.join(os.tmpdir(), 'aiclient-onboarding-node-installer.log');
      onUpdate?.('Downloading Node.js installer...');
      await runPowerShell(
        `Invoke-WebRequest -Uri ${quotePowerShell(NODE_INSTALLER_URL)} -OutFile ${quotePowerShell(installerPath)} -UseBasicParsing -ErrorAction Stop`,
        { signal: this.abortController.signal }
      );

      try {
        onUpdate?.('Running Node.js installer (please approve the UAC prompt)...');
        // Per-machine MSI installs require admin; running msiexec unelevated with
        // /quiet fails silently with exit code 1603. Start-Process -Verb RunAs
        // triggers UAC so msiexec gets the elevated token. Drop ADDLOCAL=ALL —
        // the default feature set already includes Node+npm, and forcing every
        // optional feature can itself surface as 1603 on some Windows hosts.
        const psCommand = [
          `$installerPath = ${quotePowerShell(installerPath)}`,
          `$logPath = ${quotePowerShell(installerLogPath)}`,
          `$msiArgs = @('/i', $installerPath, '/qn', '/norestart', '/l*v', $logPath)`,
          `try { $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -Verb RunAs -Wait -PassThru -ErrorAction Stop } catch { throw "Elevation denied or failed: $($_.Exception.Message)" }`,
          `if ($proc.ExitCode -ne 0) { throw "msiexec exited with code $($proc.ExitCode). Log: $logPath" }`,
        ].join('; ');
        await runPowerShell(psCommand, { signal: this.abortController.signal });
      } finally {
        safeUnlink(installerPath);
      }

      await this.refreshPath();
      nodeStatus = await this.detectNode();
    }

    if (!nodeStatus.installed) {
      throw new Error('Node.js installation finished, but Node.js 18+ was not detected.');
    }
  }

  async installAgent(agentId: InstallAgentId): Promise<void> {
    this.ensureNotCancelled();

    // Claude Code 2.1.113+ ships as a Bun binary, which is not in the TEC
    // OCular Agent whitelist on locked-down corp Windows machines (file reads
    // come back as raw TSD-encrypted bytes). Pin to the last Node release so
    // the runtime stays inside the whitelist.
    const packageName =
      agentId === 'claude'
        ? `@anthropic-ai/claude-code@${LAST_NODE_CLAUDE_VERSION}`
        : '@openai/codex';
    let lastError: unknown;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await runCmd(`npm install -g ${packageName} --registry=${NPM_REGISTRY}`, {
          signal: this.abortController.signal,
        });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (!isTransientNpmNetworkError(error) || attempt === 2) {
          throw error;
        }
      }
    }

    await this.refreshPath();

    const detected = await cliDetector.detectOne(agentId);
    if (!detected.installed) {
      throw new Error(
        `${agentId} installation finished, but the CLI command is still unavailable.`
      );
    }

    if (lastError) {
      // Surface a transient retry that ultimately succeeded as an error so
      // callers can decide whether to log/report it. We do this BEFORE any
      // post-install side effects (e.g. disabling Claude auto-updates) to
      // avoid mutating local config when we're about to throw.
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    if (agentId === 'claude') {
      // Claude's built-in updater silently pulls the latest Bun build on the
      // next launch; turn it off so we don't fall back outside the whitelist.
      try {
        disableClaudeAutoUpdates();
      } catch (error) {
        console.warn('[AgentInstaller] Failed to disable Claude autoUpdates:', error);
      }
    }
  }

  /**
   * Uninstall a previously-installed Claude Code build (any version), then
   * reinstall the pinned Node-compatible version. Used by the renderer's
   * "downgrade from Bun" action so the resulting install state is clean.
   */
  async downgradeClaudeToNodeVersion(
    onProgress?: (message: string) => void
  ): Promise<void> {
    this.ensureNotCancelled();

    onProgress?.('Removing existing Claude Code build...');
    try {
      await runCmd('npm uninstall -g @anthropic-ai/claude-code', {
        signal: this.abortController.signal,
      });
    } catch (error) {
      // Uninstall may legitimately fail if the package isn't installed via
      // the same npm prefix; we still try to install over the top below.
      console.warn('[AgentInstaller] uninstall failed (continuing):', error);
    }

    await this.refreshPath();
    onProgress?.(`Installing Claude Code ${LAST_NODE_CLAUDE_VERSION}...`);
    await this.installAgent('claude');
  }

  async installAll(
    agents: InstallAgentId[],
    onProgress: (progress: InstallProgress) => void
  ): Promise<InstallResult> {
    const selectedAgents = new Set<InstallAgentId>(agents);
    let currentStep: InstallProgress['step'] | null = null;

    const emit = (progress: InstallProgress) => {
      currentStep = progress.step;
      onProgress(progress);
    };

    try {
      const initialPrerequisites = await this.checkPrerequisites();

      if (initialPrerequisites.gitInstalled) {
        emit({
          step: 'git',
          status: 'done',
          message: initialPrerequisites.gitVersion || 'Git already installed.',
        });
      } else {
        emit({ step: 'git', status: 'installing', message: 'Preparing Git installation...' });
        await this.installGit((message) => emit({ step: 'git', status: 'installing', message }));
        const gitStatus = await this.detectGit();
        emit({
          step: 'git',
          status: 'done',
          message: gitStatus.version || 'Git installed.',
        });
      }

      const nodeStatusBeforeInstall = await this.detectNode();
      if (nodeStatusBeforeInstall.installed) {
        emit({
          step: 'node',
          status: 'done',
          message: nodeStatusBeforeInstall.version || 'Node.js already installed.',
        });
      } else {
        emit({
          step: 'node',
          status: 'installing',
          message: 'Preparing Node.js installation...',
        });
        await this.installNode((message) => emit({ step: 'node', status: 'installing', message }));
        const nodeStatus = await this.detectNode();
        emit({
          step: 'node',
          status: 'done',
          message: nodeStatus.version || 'Node.js installed.',
        });
      }

      for (const agentId of ['claude', 'codex'] as const) {
        if (!selectedAgents.has(agentId)) {
          emit({
            step: agentId,
            status: 'skipped',
            message: `${agentId === 'claude' ? 'Claude Code' : 'Codex'} already installed.`,
          });
          continue;
        }

        const detected = await cliDetector.detectOne(agentId);
        const label = agentId === 'claude' ? 'Claude Code' : 'Codex';

        if (detected.installed) {
          emit({
            step: agentId,
            status: 'done',
            message: detected.version || `${label} already installed.`,
          });
          continue;
        }

        emit({
          step: agentId,
          status: 'installing',
          message: `Installing ${label}...`,
        });
        await this.installAgent(agentId);
        const verified = await cliDetector.detectOne(agentId);
        emit({
          step: agentId,
          status: 'done',
          message: verified.version || `${label} installed.`,
        });
      }

      return { success: true, errors: [] };
    } catch (error) {
      if (isInstallAbortedError(error)) {
        return {
          success: false,
          cancelled: true,
          errors: ['Installation cancelled.'],
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      if (currentStep) {
        emit({
          step: currentStep,
          status: 'error',
          message,
        });
      }
      return {
        success: false,
        errors: [message],
      };
    }
  }

  private ensureNotCancelled(): void {
    if (this.abortController.signal.aborted) {
      throw new InstallAbortedError();
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

  private async setGitBashEnv(bashPath: string): Promise<void> {
    this.ensureNotCancelled();

    await runPowerShell(
      [
        `[Environment]::SetEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', ${quotePowerShell(bashPath)}, 'User')`,
        `$env:CLAUDE_CODE_GIT_BASH_PATH = ${quotePowerShell(bashPath)}`,
      ].join('; '),
      { signal: this.abortController.signal }
    );

    process.env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
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
