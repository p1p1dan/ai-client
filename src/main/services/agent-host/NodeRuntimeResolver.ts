import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  NodeRuntimeInfo,
  NodeRuntimeResolveResult,
  NodeRuntimeSource,
} from '@shared/types/agentHost';

const execFileAsync = promisify(execFile);

/** Required major version for Agent Host (ARD D1). */
export const REQUIRED_NODE_MAJOR = 24;

export interface ResolveNodeRuntimeOptions {
  /** Explicit path override (settings / env). Highest priority after options.explicitPath. */
  explicitPath?: string;
  /** Extra candidate paths to probe. */
  extraCandidates?: string[];
  /** Override PATH search (tests). */
  pathEnv?: string;
  /** Override home directory (tests). */
  homeDir?: string;
  /** Override platform (tests). */
  platform?: NodeJS.Platform;
  /**
   * When false, skip process.env.NVM_HOME / AICLIENT_NODE24_PATH discovery
   * (useful for isolated unit tests). Default true.
   */
  useProcessEnv?: boolean;
}

interface Candidate {
  path: string;
  source: NodeRuntimeSource;
}

/**
 * Resolve a Node 24 binary suitable for spawning the Agent Host.
 * Preference: explicit → AICLIENT_NODE24_PATH → version managers → PATH.
 */
export async function resolveNode24Runtime(
  options: ResolveNodeRuntimeOptions = {}
): Promise<NodeRuntimeResolveResult> {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const pathEnv = options.pathEnv ?? process.env.PATH ?? process.env.Path ?? '';
  const useProcessEnv = options.useProcessEnv ?? true;
  const inspected: Array<{ path: string; reason: string }> = [];
  const candidates: Candidate[] = [];

  const pushUnique = (p: string | undefined, source: NodeRuntimeSource) => {
    if (!p) return;
    const normalized = path.normalize(p.trim());
    if (!normalized) return;
    if (candidates.some((c) => pathsEqual(c.path, normalized))) return;
    candidates.push({ path: normalized, source });
  };

  pushUnique(options.explicitPath, 'explicit');
  if (useProcessEnv) {
    pushUnique(process.env.AICLIENT_NODE24_PATH, 'env');
  }

  for (const p of options.extraCandidates ?? []) {
    pushUnique(p, 'explicit');
  }

  for (const p of collectNvmCandidates(home, platform, useProcessEnv)) {
    pushUnique(p, 'nvm');
  }
  for (const p of collectFnmCandidates(home, platform)) {
    pushUnique(p, 'fnm');
  }
  for (const p of collectVoltaCandidates(home, platform)) {
    pushUnique(p, 'volta');
  }
  for (const p of collectPathCandidates(pathEnv, platform)) {
    pushUnique(p, 'path');
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) {
      inspected.push({ path: candidate.path, reason: 'not-found' });
      continue;
    }

    const probed = await probeNodeBinary(candidate.path);
    if (!probed.ok) {
      inspected.push({ path: candidate.path, reason: probed.reason });
      continue;
    }

    if (probed.major !== REQUIRED_NODE_MAJOR) {
      inspected.push({
        path: candidate.path,
        reason: `major-${probed.major}-not-${REQUIRED_NODE_MAJOR}`,
      });
      continue;
    }

    const runtime: NodeRuntimeInfo = {
      execPath: probed.execPath,
      version: probed.version,
      major: probed.major,
      source: candidate.source,
    };
    inspected.push({ path: candidate.path, reason: 'ok' });
    return { ok: true, runtime, candidates: inspected };
  }

  return {
    ok: false,
    error: `No Node ${REQUIRED_NODE_MAJOR} runtime found. Set AICLIENT_NODE24_PATH or install Node ${REQUIRED_NODE_MAJOR}.`,
    candidates: inspected,
  };
}

function collectNvmCandidates(
  home: string,
  platform: NodeJS.Platform,
  useProcessEnv: boolean
): string[] {
  const roots = new Set<string>();
  if (useProcessEnv && process.env.NVM_HOME) roots.add(process.env.NVM_HOME);
  if (platform === 'win32') {
    roots.add(path.join(home, 'AppData', 'Local', 'nvm'));
    roots.add(path.join(home, 'AppData', 'Roaming', 'nvm'));
    // Only probe the machine-wide nvm4w root when using real process env.
    if (useProcessEnv) {
      roots.add('C:\\nvm4w');
    }
  } else {
    roots.add(path.join(home, '.nvm'));
  }

  const out: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    const versions = entries
      .filter((name) => /^v?24\./.test(name) || name === 'v24' || name === '24')
      .map((name) => ({ name, sort: normalizeVersionDir(name) }))
      .sort((a, b) => compareVersionTuple(b.sort, a.sort));

    for (const v of versions) {
      const dir = path.join(root, v.name);
      out.push(nodeBinaryInDir(dir, platform));
    }
  }
  return out;
}

function collectFnmCandidates(home: string, platform: NodeJS.Platform): string[] {
  const roots = [
    process.env.FNM_DIR,
    path.join(home, '.local', 'share', 'fnm'),
    path.join(home, 'AppData', 'Roaming', 'fnm'),
  ].filter(Boolean) as string[];

  const out: string[] = [];
  for (const root of roots) {
    const versionsDir = path.join(root, 'node-versions');
    if (!existsSync(versionsDir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(versionsDir);
    } catch {
      continue;
    }
    const versions = entries
      .filter((name) => name.startsWith('v24.') || name.startsWith('24.'))
      .map((name) => ({ name, sort: normalizeVersionDir(name) }))
      .sort((a, b) => compareVersionTuple(b.sort, a.sort));
    for (const v of versions) {
      const dir = path.join(versionsDir, v.name, 'installation');
      out.push(nodeBinaryInDir(dir, platform));
    }
  }
  return out;
}

function collectVoltaCandidates(home: string, platform: NodeJS.Platform): string[] {
  const tools = path.join(home, '.volta', 'tools', 'image', 'node');
  if (!existsSync(tools)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(tools);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith('24.') || name.startsWith('v24.'))
    .map((name) => ({ name, sort: normalizeVersionDir(name) }))
    .sort((a, b) => compareVersionTuple(b.sort, a.sort))
    .map((v) => nodeBinaryInDir(path.join(tools, v.name), platform));
}

function collectPathCandidates(pathEnv: string, platform: NodeJS.Platform): string[] {
  const sep = platform === 'win32' ? ';' : ':';
  const binary = platform === 'win32' ? 'node.exe' : 'node';
  return pathEnv
    .split(sep)
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => path.join(dir, binary));
}

function nodeBinaryInDir(dir: string, platform: NodeJS.Platform): string {
  return path.join(dir, platform === 'win32' ? 'node.exe' : 'node');
}

function normalizeVersionDir(name: string): number[] {
  const cleaned = name.replace(/^v/i, '');
  return cleaned.split('.').map((n) => Number.parseInt(n, 10) || 0);
}

function compareVersionTuple(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function pathsEqual(a: string, b: string): boolean {
  if (process.platform === 'win32') {
    return a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
  }
  return a === b;
}

async function probeNodeBinary(
  execPath: string
): Promise<
  { ok: true; execPath: string; version: string; major: number } | { ok: false; reason: string }
> {
  try {
    const { stdout } = await execFileAsync(execPath, ['--version'], {
      timeout: 8000,
      windowsHide: true,
    });
    const version = stdout.toString().trim();
    const match = /^v?(\d+)\./.exec(version);
    if (!match) {
      return { ok: false, reason: `unparseable-version:${version}` };
    }
    const major = Number.parseInt(match[1], 10);
    // Prefer the binary's own process.execPath when available (symlinks / shims).
    let resolvedPath = execPath;
    try {
      const { stdout: jsonOut } = await execFileAsync(
        execPath,
        ['-e', 'process.stdout.write(process.execPath)'],
        { timeout: 8000, windowsHide: true }
      );
      const reported = jsonOut.toString().trim();
      if (reported) resolvedPath = reported;
    } catch {
      // keep candidate path
    }
    return {
      ok: true,
      execPath: resolvedPath,
      version: version.startsWith('v') ? version : `v${version}`,
      major,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `probe-failed:${message}` };
  }
}
