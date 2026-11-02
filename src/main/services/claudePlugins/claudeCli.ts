/**
 * docs/plantree/plans/claude-plugins §4: runs the CLI bundled with the Claude
 * Agent SDK host for one management command (`claude plugin …`, `claude mcp …`)
 * against the user layer Claude chats read (`CLAUDE_CONFIG_DIR`, ruling 19).
 *
 * The environment is the host's allowlist (no credentials, no `ANTHROPIC_*` or
 * `CLAUDE_*` from Main), the product proxy laid over it the way the host does
 * for its CLI (decision 196 rule 7: cloning a GitHub marketplace must take the
 * same road as the chat), and the switches that keep the shipped binary from
 * updating itself or calling home. stdin is closed, so a command that would ask
 * a question fails instead of hanging.
 */

import { spawn } from 'node:child_process';
import { CLAUDE_SDK_INHERITED_ENV } from '@shared/claudeSdkEngine';
import { childProxyOverlay, type HostProxySetting } from '@shared/hostProxy';

const INHERITED = new Set(CLAUDE_SDK_INHERITED_ENV);

/** Cloning a marketplace waits 120 s in the CLI itself (measured, 2.1.300); a little more here. */
export const CLAUDE_CLI_TIMEOUT_MS = 150_000;
/** `plugin list --available` of the official marketplace is about 100 KB. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface ClaudeCliOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ClaudeCliRun = (
  args: readonly string[],
  options?: { cwd?: string; timeoutMs?: number }
) => Promise<ClaudeCliOutput>;

export interface ClaudeCliEnvironmentInput {
  inherited: NodeJS.ProcessEnv;
  configDir: string;
  proxy: HostProxySetting | null | undefined;
  /** Windows: the Git Bash the host hands its CLI too (`AICLIENT_GIT_BASH_PATH`). */
  gitBashPath?: string;
}

export function buildClaudeCliEnvironment(
  input: ClaudeCliEnvironmentInput
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.inherited)) {
    if (value !== undefined && INHERITED.has(name.toUpperCase())) env[name] = value;
  }
  return {
    ...env,
    ...childProxyOverlay(env, input.proxy ?? null),
    CLAUDE_CONFIG_DIR: input.configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    ...(input.gitBashPath ? { CLAUDE_CODE_GIT_BASH_PATH: input.gitBashPath } : {}),
  };
}

export function createClaudeCliRun(deps: {
  cliPath: () => string | undefined;
  env: () => Record<string, string>;
  /** Where a command runs without a repository: the config dir, never the app's cwd. */
  defaultCwd: () => string;
}): ClaudeCliRun {
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      const cli = deps.cliPath();
      if (!cli) {
        reject(new Error('This build has no Claude CLI'));
        return;
      }
      const child = spawn(cli, [...args], {
        cwd: options.cwd ?? deps.defaultCwd(),
        env: deps.env(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let timedOut = false;
      const take = (into: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) {
          child.kill();
          return;
        }
        into.push(chunk);
      };
      child.stdout.on('data', take(out));
      child.stderr.on('data', take(err));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs ?? CLAUDE_CLI_TIMEOUT_MS);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          timedOut,
        });
      });
    });
}

/** The whole of stdout as JSON (the `list` commands). */
export function parseCliJson(output: ClaudeCliOutput): unknown {
  if (output.timedOut) throw new Error('The Claude CLI did not answer in time');
  try {
    return JSON.parse(output.stdout);
  } catch {
    throw new Error(cliFailureText(output));
  }
}

/**
 * The `--json` result line of an action (`install`, `marketplace add`, …): the
 * last line of stdout that parses as an object with an `outcome`.
 */
export function parseCliOutcome(output: ClaudeCliOutput): { ok: boolean; message: string } {
  if (output.timedOut) return { ok: false, message: 'The Claude CLI did not answer in time' };
  const lines = output.stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line) as {
        outcome?: unknown;
        message?: unknown;
        error?: unknown;
        alreadyInGoalState?: unknown;
      };
      if (typeof parsed.outcome !== 'string') continue;
      // "Already disabled" and the like: the state asked for is the state there is.
      if (parsed.alreadyInGoalState === true) return { ok: true, message: '' };
      const message =
        typeof parsed.message === 'string'
          ? parsed.message
          : typeof parsed.error === 'string'
            ? parsed.error
            : '';
      // A success message carries the CLI's progress lines; its last line says it all.
      const last =
        message
          .split(/\r?\n/)
          .filter((part) => part.trim())
          .pop() ?? '';
      return parsed.outcome === 'ok' && output.code === 0
        ? { ok: true, message: last }
        : { ok: false, message: message || cliFailureText(output) };
    } catch {
      // Not the result line.
    }
  }
  return { ok: output.code === 0, message: output.code === 0 ? '' : cliFailureText(output) };
}

/** A plain-text command (`mcp add-json`, `mcp remove`). */
export function parseCliPlain(output: ClaudeCliOutput): { ok: boolean; message: string } {
  if (output.timedOut) return { ok: false, message: 'The Claude CLI did not answer in time' };
  return output.code === 0
    ? { ok: true, message: output.stdout.trim() }
    : { ok: false, message: cliFailureText(output) };
}

/** What the CLI said when it failed: its last stderr lines, else stdout's. */
export function cliFailureText(output: ClaudeCliOutput): string {
  const text = (output.stderr.trim() || output.stdout.trim())
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-4)
    .join('\n');
  return text || `The Claude CLI exited with code ${output.code}`;
}
