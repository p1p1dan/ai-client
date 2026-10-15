/**
 * The version stamp every suite run carries (docs/agent-project-engineering.md
 * §15): which harness commit (and whether it was dirty), which DSH packages,
 * which Claude Code, which catalog, which fake gateway. Paths are left out:
 * a report must not carry a user name.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { sdkVersions } from './pilabSdk.ts';
import { git, runCommand } from './proc.ts';

export interface VersionStamp {
  harness: { commit: string; branch: string; dirty: boolean; dirtyDiffSha256?: string };
  appVersion: string;
  node: string;
  platform: string;
  osRelease: string;
  dsh: Record<string, string>;
  catalog: { version?: unknown; updatedAt?: unknown };
  fakeGatewaySha256: string;
  claudeCode?: string;
  /** The Claude Agent SDK of the pilab-sdk arm and the CLI it bundles. */
  claudeSdk?: { sdk?: string; cli?: string };
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function sha256File(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  } catch {
    return 'missing';
  }
}

export async function versionStamp(options: {
  repoRoot: string;
  claudeBin?: string;
  env: Record<string, string>;
  cwd: string;
}): Promise<VersionStamp> {
  const { repoRoot } = options;
  const safeGit = (args: string[]) => {
    try {
      return git(repoRoot, args).trim();
    } catch {
      return '';
    }
  };
  const status = safeGit(['status', '--porcelain']);
  const diff = status ? safeGit(['diff', 'HEAD']) : '';
  const dsh: Record<string, string> = {};
  for (const name of ['dsh-base', 'dsh-app-boot', 'dsh-agent-loop', 'dsh-llm-pi-ai']) {
    const pkg = readJson(
      join(repoRoot, 'src', 'dsh-host', 'node_modules', '@deepseek-ai', name, 'package.json')
    );
    if (pkg) dsh[name] = String(pkg.version);
  }
  const claudeSdk = sdkVersions(repoRoot);
  const catalog = readJson(join(repoRoot, 'resources', 'model-catalog', 'snapshot.json'));
  let claudeCode: string | undefined;
  if (options.claudeBin) {
    const run = await runCommand(options.claudeBin, ['--version'], {
      cwd: options.cwd,
      env: options.env,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(options.claudeBin),
      timeoutMs: 30_000,
    });
    claudeCode = run.stdout.trim() || `unknown (exit ${run.code})`;
  }
  return {
    harness: {
      commit: safeGit(['rev-parse', 'HEAD']),
      branch: safeGit(['rev-parse', '--abbrev-ref', 'HEAD']),
      dirty: status !== '',
      ...(diff
        ? { dirtyDiffSha256: createHash('sha256').update(diff).digest('hex').slice(0, 16) }
        : {}),
    },
    appVersion: String(readJson(join(repoRoot, 'package.json'))?.version ?? ''),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    osRelease: os.release(),
    dsh,
    catalog: { version: catalog?.version, updatedAt: catalog?.updatedAt },
    fakeGatewaySha256: sha256File(join(repoRoot, 'src', 'dsh-host', 'tools', 'fake-gateway.mjs')),
    ...(claudeCode ? { claudeCode } : {}),
    ...(Object.keys(claudeSdk).length > 0 ? { claudeSdk } : {}),
  };
}
