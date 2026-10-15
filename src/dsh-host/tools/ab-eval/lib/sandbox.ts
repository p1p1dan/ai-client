/**
 * One throwaway machine per run: a workspace, a home, a temp directory, and
 * each client's own state directory (DSH_HOME and the app's agent directory
 * for PiLab, CLAUDE_CONFIG_DIR for Claude Code). Both clients get the same
 * allowlisted environment, built from nothing: no variable of the developer's
 * shell reaches them beyond PATH, the OS basics and, for a real gateway,
 * the proxies. So no local account (PiLab's credential store, Claude Code's
 * login, git's credential manager) takes part.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

export interface Sandbox {
  root: string;
  ws: string;
  home: string;
  tmp: string;
  dshHome: string;
  agentDir: string;
  nativeCache: string;
  claudeConfig: string;
}

export function createSandbox(scratch: string, name: string): Sandbox {
  const root = join(scratch, name);
  const box: Sandbox = {
    root,
    ws: join(root, 'ws'),
    home: join(root, 'home'),
    tmp: join(root, 'tmp'),
    dshHome: join(root, 'dsh'),
    agentDir: join(root, 'agent'),
    nativeCache: join(root, 'native'),
    claudeConfig: join(root, 'cc'),
  };
  for (const dir of Object.values(box)) mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    mkdirSync(join(box.home, 'AppData', 'Roaming'), { recursive: true });
    mkdirSync(join(box.home, 'AppData', 'Local'), { recursive: true });
  }
  return box;
}

const WINDOWS_PASS = [
  'SystemRoot',
  'windir',
  'ComSpec',
  'PATHEXT',
  'SystemDrive',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'ProgramData',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'OS',
];
const PROXY_NAMES = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY'];

/** The environment both clients start from (each runner adds its own few names). */
export function baseEnv(box: Sandbox, options: { proxies: boolean }): Record<string, string> {
  const env: Record<string, string> = {};
  const pass = (name: string) => {
    const value = process.env[name];
    if (value !== undefined && value !== '') env[name] = value;
  };
  pass('PATH');
  pass('LANG');
  pass('LC_ALL');
  pass('TZ');
  if (options.proxies) {
    for (const name of PROXY_NAMES) {
      pass(name);
      if (process.platform !== 'win32') pass(name.toLowerCase());
    }
  }
  env.HOME = box.home;
  env.TMPDIR = box.tmp;
  env.TEMP = box.tmp;
  env.TMP = box.tmp;
  if (process.platform === 'win32') {
    for (const name of WINDOWS_PASS) pass(name);
    env.USERPROFILE = box.home;
    env.APPDATA = join(box.home, 'AppData', 'Roaming');
    env.LOCALAPPDATA = join(box.home, 'AppData', 'Local');
  } else {
    const user = os.userInfo().username;
    env.USER = user;
    env.LOGNAME = user;
    env.SHELL = '/bin/bash';
  }
  // git: no system config (credential helpers) and never a prompt.
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  return env;
}

/**
 * Package-manager caches for a case's setup commands, shared by every run of
 * every suite under the scratch root: each run has a fresh HOME, and without
 * these `npm ci` or `pnpm install` would download everything every time.
 * Registry credentials are not part of it (the real home's .npmrc is never read).
 */
export function packageCacheEnv(scratchRoot: string): Record<string, string> {
  const cache = join(scratchRoot, 'pkg-cache');
  return {
    npm_config_cache: join(cache, 'npm'),
    npm_config_store_dir: join(cache, 'pnpm-store'),
    YARN_CACHE_FOLDER: join(cache, 'yarn'),
    PIP_CACHE_DIR: join(cache, 'pip'),
  };
}

/** Instruction files either client would pick up from a directory or its ancestors. */
const INSTRUCTION_FILES = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'AGENTS.local.md',
  join('.claude', 'CLAUDE.md'),
  join('.claude', 'rules'),
];

/** Instruction files in `dir` or any ancestor: a workspace under one would not be clean. */
export function instructionFilesAbove(dir: string): string[] {
  const found: string[] = [];
  let current = resolve(dir);
  for (;;) {
    for (const name of INSTRUCTION_FILES) {
      const path = join(current, name);
      if (existsSync(path)) found.push(path);
    }
    const parent = dirname(current);
    if (parent === current) return found;
    current = parent;
  }
}

/** Git Bash for Claude Code on Windows: the flag, the variable, or next to git.exe on PATH. */
export function findGitBash(flag?: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  for (const candidate of [flag, process.env.CLAUDE_CODE_GIT_BASH_PATH]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!entry || !existsSync(join(entry, 'git.exe'))) continue;
    for (const candidate of [
      join(entry, '..', 'bin', 'bash.exe'),
      join(entry, '..', '..', 'bin', 'bash.exe'),
    ]) {
      if (existsSync(candidate)) return resolve(candidate);
    }
  }
  return undefined;
}

/** The Claude Code executable: the flag, AB_CLAUDE_BIN, CLAUDE_CODE_EXECPATH, or `claude` on PATH. */
export function findClaude(flag?: string): string | undefined {
  for (const candidate of [flag, process.env.AB_CLAUDE_BIN, process.env.CLAUDE_CODE_EXECPATH]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const extensions =
    process.platform === 'win32'
      ? ['.exe', ...(process.env.PATHEXT ?? '.CMD').toLowerCase().split(';')]
      : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const extension of [...new Set(extensions)]) {
      const path = join(dir, `claude${extension}`);
      try {
        if (statSync(path).isFile()) return path;
      } catch {
        // Not here.
      }
    }
  }
  return undefined;
}
