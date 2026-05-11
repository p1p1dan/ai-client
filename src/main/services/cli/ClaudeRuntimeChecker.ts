import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeRuntimeStatus, VsCodeExtensionInfo } from '@shared/types';
import { classifyClaudeCliVersion, compareSemver } from './ClaudeVersion';
import { cliDetector } from './CliDetector';

export type { ClaudeRuntimeKind, ClaudeRuntimeStatus, VsCodeExtensionInfo } from '@shared/types';
export { LAST_NODE_CLAUDE_VERSION } from '@shared/types';
export { classifyClaudeCliVersion, compareSemver } from './ClaudeVersion';

// Delegate `claude --version` detection to the same CliDetector used by the
// post-registration onboarding check. CliDetector gives us: 60s timeout on
// Windows (vs 8s here, which routinely fired on cold cmd.exe + npm shim +
// antivirus chains), and an execInPty fallback that loads the user's login
// shell — picking up nvm / mise / volta / asdf installs that a bare
// `sh -c claude --version` cannot see. Sharing one detector also guarantees
// the runtime gate and the registered-state CLI check can never disagree.
async function runVersionCheck(): Promise<string | null> {
  try {
    const info = await cliDetector.detectOne('claude');
    if (info.installed && info.version) {
      return info.version;
    }
    return null;
  } catch {
    return null;
  }
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
        const version =
          typeof pkg.version === 'string' && pkg.version.length > 0
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

  getCached(): ClaudeRuntimeStatus | null {
    return this.cached;
  }
}

export const claudeRuntimeChecker = new ClaudeRuntimeChecker();
