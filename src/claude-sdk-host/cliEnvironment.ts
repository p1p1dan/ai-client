/**
 * Route-B prototype: the environment the Claude Code CLI child runs with.
 *
 * The SDK's `env` option REPLACES the child's environment, so it is built from
 * an allowlist instead of a copy of `process.env`. Nothing credential-shaped
 * crosses: no `ANTHROPIC_*`, no `CLAUDE_*` (a developer machine running Claude
 * Code has dozens, an OAuth token among them), no cloud-provider switches. The
 * gateway address and key are injected by the host from its own launch
 * variables, and `CLAUDE_CONFIG_DIR` points at an app-private directory so the
 * CLI never reads the user's `~/.claude` (settings, login, history).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

/** Inherited names the CLI may see, compared upper-cased (Windows names are case-insensitive). */
const INHERITED = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'USER',
  'LOGNAME',
  'SHELL',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
]);

export interface CliEnvironmentInput {
  inherited: NodeJS.ProcessEnv;
  /** App-private `CLAUDE_CONFIG_DIR`. */
  configDir: string;
  /** Gateway root, as `ANTHROPIC_BASE_URL` (no `/v1`). */
  baseUrl: string;
  /** Sent as `x-api-key` (`ANTHROPIC_API_KEY`): the Agent SDK terms require API-key auth. */
  apiKey: string;
  /** `CLAUDE_AGENT_SDK_CLIENT_APP`, appended to the CLI's User-Agent. */
  clientApp: string;
  /** Windows: the Git Bash the CLI's `Bash` tool runs; without it the CLI falls back to PowerShell. */
  gitBashPath?: string;
}

export function buildCliEnvironment(input: CliEnvironmentInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.inherited)) {
    if (value !== undefined && INHERITED.has(name.toUpperCase())) env[name] = value;
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: input.configDir,
    ANTHROPIC_BASE_URL: input.baseUrl,
    ANTHROPIC_API_KEY: input.apiKey,
    // No telemetry, error reporting, auto-update or feedback calls; only the gateway is contacted.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: input.clientApp,
    ...(input.gitBashPath ? { CLAUDE_CODE_GIT_BASH_PATH: input.gitBashPath } : {}),
  };
}

/**
 * Find Git Bash on Windows. The CLI's own lookup misses an install outside the
 * default `C:\Program Files\Git` (measured: Git on `G:` gets the PowerShell
 * tool instead of `Bash`), so the host resolves it from PATH first.
 */
export function findGitBash(
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean = existsSync
): string | undefined {
  const explicit = env.AICLIENT_GIT_BASH_PATH?.trim();
  if (explicit && exists(explicit)) return explicit;
  const pathValue = Object.entries(env).find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? '';
  const roots: string[] = [];
  for (const dir of pathValue.split(path.win32.delimiter)) {
    if (!dir) continue;
    const normalized = path.win32.normalize(dir);
    if (
      !exists(path.win32.join(normalized, 'git.exe')) &&
      !exists(path.win32.join(normalized, 'bash.exe'))
    ) {
      continue;
    }
    // <root>\cmd, <root>\bin, <root>\mingw64\bin, <root>\usr\bin
    const parts = normalized.replace(/[\\/]+$/, '').split(/[\\/]/);
    const tail = parts.slice(-2).join('\\').toLowerCase();
    if (tail === 'mingw64\\bin' || tail === 'usr\\bin') roots.push(parts.slice(0, -2).join('\\'));
    else roots.push(parts.slice(0, -1).join('\\'));
  }
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]) {
    if (base) roots.push(path.win32.join(base, 'Git'));
  }
  if (env.LOCALAPPDATA) roots.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git'));
  for (const root of roots) {
    const candidate = path.win32.join(root, 'bin', 'bash.exe');
    if (exists(candidate)) return candidate;
  }
  return undefined;
}
