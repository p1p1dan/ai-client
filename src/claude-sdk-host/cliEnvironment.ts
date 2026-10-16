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
import { CLAUDE_SDK_INHERITED_ENV } from '../shared/claudeSdkEngine.ts';

/** Inherited names the CLI may see, compared upper-cased (Windows names are case-insensitive). */
const INHERITED = new Set(CLAUDE_SDK_INHERITED_ENV);

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
  /**
   * A directory holding an `rg` the CLI should use instead of its built-in
   * one (PiLab already ships `@vscode/ripgrep`). The built-in one is the CLI
   * binary itself run with argv0 `rg`; `USE_BUILTIN_RIPGREP=0` makes the CLI
   * look `rg` up on PATH first, so this directory goes to the front of it.
   * In 2.1.300, when PATH has no `rg` the CLI silently falls back to the
   * built-in one.
   */
  ripgrepDir?: string;
}

/** `dir` in front of the PATH entry of `env`, whatever case its name has (Windows: `Path`). */
export function withPathPrefix(
  env: Record<string, string>,
  dir: string,
  delimiter: string = path.delimiter
): Record<string, string> {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...env, [key]: env[key] ? `${dir}${delimiter}${env[key]}` : dir };
}

export function buildCliEnvironment(input: CliEnvironmentInput): Record<string, string> {
  let env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.inherited)) {
    if (value !== undefined && INHERITED.has(name.toUpperCase())) env[name] = value;
  }
  if (input.ripgrepDir) env = withPathPrefix(env, input.ripgrepDir);
  return {
    ...env,
    ...(input.ripgrepDir ? { USE_BUILTIN_RIPGREP: '0' } : {}),
    CLAUDE_CONFIG_DIR: input.configDir,
    ANTHROPIC_BASE_URL: input.baseUrl,
    ANTHROPIC_API_KEY: input.apiKey,
    // No telemetry, error reporting, auto-update or feedback calls; only the gateway is contacted.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Said on its own as well: the shipped binary must never replace itself, or a
    // hash-based whitelist entry (encrypted machines) stops matching it.
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: input.clientApp,
    ...(input.gitBashPath ? { CLAUDE_CODE_GIT_BASH_PATH: input.gitBashPath } : {}),
  };
}

/**
 * Route B S-1 (decision 6): variables the opened repository's own
 * `.claude/settings*.json` `env` must not change. The CLI applies every
 * settings source's `env` to its own process, later sources winning per key,
 * and the SDK's `settings` option is the flag tier, above the project and
 * local tiers (measured on 2.1.300 against the fake gateway; `managedSettings.env`
 * does not pin). Each entry below was measured both ways: the repository's
 * value took effect without the pin, and the pin won with it.
 */
const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
/** `''` reads as unset for each of these (measured). */
const UNSET_VARIABLES = [
  // Sent as `Authorization: Bearer …` next to our key.
  'ANTHROPIC_AUTH_TOKEN',
  // Extra request headers of the repository's choosing.
  'ANTHROPIC_CUSTOM_HEADERS',
];
/**
 * Pinned to what PiLab itself was given (a private CA the gateway needs), or
 * `''`: never a trust anchor of the repository's choosing (TLS interception).
 * A file path, not a credential, so it may go on the CLI's command line.
 */
const INHERITED_PINS = ['NODE_EXTRA_CA_CERTS'];
/** Provider switches: each sends the conversation to its own endpoint instead of the gateway. */
const PROVIDER_SWITCHES = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_GATEWAY',
];

export interface PinnedSettingsEnvInput {
  /** The host's own environment: proxies are pinned to what PiLab itself was given. */
  inherited: NodeJS.ProcessEnv;
  /** Gateway root, as `ANTHROPIC_BASE_URL`. */
  baseUrl: string;
  gitBashPath?: string;
}

export interface PinnedSettingsEnv {
  /** The flag tier's `env`: `settings: { env }`. */
  env: Record<string, string>;
  /**
   * Proxy variables left unpinned because their value carries credentials
   * (`http://user:pass@proxy`): the SDK puts `settings` on the CLI's command
   * line, which other local processes can read. A repository can still
   * override these; the host logs their names.
   */
  credentialedProxies: string[];
}

/** First value of `name` in `env`, exact spelling first, then any case (Windows names are case-insensitive). */
function inheritedValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const upper = name.toUpperCase();
  return Object.entries(env).find(
    ([key, value]) => key.toUpperCase() === upper && value !== undefined
  )?.[1];
}

/** Whether a proxy URL carries a user name or password. */
export function hasUrlCredentials(value: string): boolean {
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    return url.username !== '' || url.password !== '';
  } catch {
    return value.includes('@');
  }
}

/**
 * The flag-tier `env` the host pins (decision 6). Never the key: the SDK
 * serializes `settings` onto the CLI's command line (measured), so only
 * non-secret values go here and the key stays in the child's environment.
 * Proxies keep PiLab's own value (lower-case spelling first, as the usual
 * tools read it), or `''`, which the CLI reads as unset (measured); both
 * spellings are pinned because Linux names are case-sensitive.
 */
export function buildPinnedSettingsEnv(input: PinnedSettingsEnvInput): PinnedSettingsEnv {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: input.baseUrl,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // '0' turns certificate checks off for the whole CLI; '1' is the default.
    NODE_TLS_REJECT_UNAUTHORIZED: '1',
    ...(input.gitBashPath ? { CLAUDE_CODE_GIT_BASH_PATH: input.gitBashPath } : {}),
  };
  for (const name of UNSET_VARIABLES) env[name] = '';
  for (const name of INHERITED_PINS) env[name] = inheritedValue(input.inherited, name) ?? '';
  for (const name of PROVIDER_SWITCHES) env[name] = '0';
  const credentialedProxies: string[] = [];
  for (const name of PROXY_VARIABLES) {
    const lower = name.toLowerCase();
    const value = inheritedValue(input.inherited, lower) ?? '';
    if (name !== 'NO_PROXY' && value && hasUrlCredentials(value)) {
      credentialedProxies.push(name);
      continue;
    }
    env[name] = value;
    env[lower] = value;
  }
  return { env, credentialedProxies };
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
