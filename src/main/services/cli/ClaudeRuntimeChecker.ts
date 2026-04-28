import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type ClaudeRuntimeStatus,
  LAST_NODE_CLAUDE_VERSION,
  type VsCodeExtensionInfo,
} from '@shared/types';
import { getEnvForCommand } from '../../utils/shell';
import { classifyClaudeCliVersion, compareSemver } from './ClaudeVersion';

export { LAST_NODE_CLAUDE_VERSION } from '@shared/types';
export type { ClaudeRuntimeKind, ClaudeRuntimeStatus, VsCodeExtensionInfo } from '@shared/types';
export { classifyClaudeCliVersion, compareSemver } from './ClaudeVersion';

const isWindows = process.platform === 'win32';

function runVersionCheck(timeoutMs = 8_000): Promise<string | null> {
  return new Promise((resolve) => {
    const command = isWindows ? 'cmd.exe' : 'sh';
    const args = isWindows ? ['/d', '/s', '/c', 'claude --version'] : ['-c', 'claude --version'];
    const child = spawn(command, args, {
      env: getEnvForCommand(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        finish(null);
        return;
      }
      const match = stdout.match(/(\d+\.\d+\.\d+)/);
      finish(match ? match[1] : null);
    });
  });
}

function getVsCodeExtensionRoots(): string[] {
  const home = os.homedir();
  // Real VSCode and the open-source builds (VSCodium, Cursor) all reuse the same layout.
  return [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.vscode-server', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.windsurf', 'extensions'),
  ].filter((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
}

function detectVsCodeClaudeExtension(): VsCodeExtensionInfo | undefined {
  const EXTENSION_PREFIX = 'anthropic.claude-code-';
  for (const root of getVsCodeExtensionRoots()) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    // Extension folder follows `<publisher>.<name>-<version>`. The official
    // publisher is `anthropic` and the extension id is `claude-code`. When
    // VSCode hasn't cleaned up older builds the directory contains multiple
    // entries — sort by parsed semver (descending) so we always pick the
    // highest version, matching VSCode's own load order.
    const candidates = entries
      .filter((name) => name.toLowerCase().startsWith(EXTENSION_PREFIX))
      .map((name) => ({
        dir: path.join(root, name),
        folderVersion: name.slice(EXTENSION_PREFIX.length),
      }))
      .sort((a, b) => compareSemver(b.folderVersion, a.folderVersion));

    for (const candidate of candidates) {
      const pkgJsonPath = path.join(candidate.dir, 'package.json');
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { version?: string };
        // Trust package.json over the directory name — VSCode does the same.
        const version = typeof pkg.version === 'string' && pkg.version.length > 0
          ? pkg.version
          : candidate.folderVersion;
        if (version) {
          return { path: candidate.dir, version };
        }
      } catch {
        // try the next candidate
      }
    }
  }
  return undefined;
}

export class ClaudeRuntimeChecker {
  private cached: ClaudeRuntimeStatus | null = null;

  async detect(force = false): Promise<ClaudeRuntimeStatus> {
    if (!force && this.cached) {
      return this.cached;
    }

    const cliVersion = await runVersionCheck();
    if (cliVersion) {
      const kind = classifyClaudeCliVersion(cliVersion);
      this.cached = { kind, cliVersion };
      return this.cached;
    }

    const extension = detectVsCodeClaudeExtension();
    if (extension) {
      this.cached = {
        kind: 'vscode-extension-only',
        vscodeExtension: extension,
      };
      return this.cached;
    }

    this.cached = { kind: 'not-installed' };
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }
}

export const claudeRuntimeChecker = new ClaudeRuntimeChecker();
