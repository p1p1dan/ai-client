/**
 * The Claude Code arm: `claude -p --output-format stream-json` in the run's
 * workspace, with a throwaway CLAUDE_CONFIG_DIR and HOME, the gateway in
 * ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY, every approval skipped
 * (`--dangerously-skip-permissions`) and the step budget as `--max-turns`.
 * The prompt goes in on stdin. A variant may add CLI arguments, environment
 * variables and files in the config directory (e.g. `settings.json`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseClaudeStream } from './claudeStream.ts';
import type { Gateway } from './gateway.ts';
import { killTree, spawnTracked } from './proc.ts';
import type { Redactor } from './redact.ts';
import type { Sandbox } from './sandbox.ts';
import type { ClientRun, LoadedVariant, RunStatus } from './types.ts';

export interface ClaudeCodeInput {
  claudeBin: string;
  gitBash?: string;
  box: Sandbox;
  base: Record<string, string>;
  gateway: Gateway;
  model: string;
  effort: string;
  prompt: string;
  timeMs: number;
  maxSteps: number;
  variant?: LoadedVariant;
  clientDir: string;
  redact: Redactor;
}

/** A Windows command-line argument for cmd.exe (`.cmd` shims need a shell). */
function quoteForCmd(arg: string): string {
  return /^[\w.:/\\=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

export async function runClaudeCode(input: ClaudeCodeInput): Promise<ClientRun> {
  const { box, variant, redact } = input;
  for (const [name, text] of Object.entries(variant?.resolvedFiles.config ?? {})) {
    const path = join(box.claudeConfig, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  const env: Record<string, string> = {
    ...input.base,
    CLAUDE_CONFIG_DIR: box.claudeConfig,
    ANTHROPIC_BASE_URL: input.gateway.baseUrl,
    ANTHROPIC_API_KEY: input.gateway.apiKey,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(input.gitBash ? { CLAUDE_CODE_GIT_BASH_PATH: input.gitBash } : {}),
    ...(variant?.env ?? {}),
  };
  const args = [
    '-p',
    '--model',
    input.model,
    '--effort',
    input.effort,
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--max-turns',
    String(input.maxSteps),
    ...(variant?.args ?? []),
  ];
  const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(input.claudeBin);
  const wallStart = performance.now();
  const startedAt = Date.now();
  const child = shim
    ? spawnTracked(quoteForCmd(input.claudeBin), args.map(quoteForCmd), {
        cwd: box.ws,
        env,
        shell: true,
        stdin: true,
      })
    : spawnTracked(input.claudeBin, args, { cwd: box.ws, env, stdin: true });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < 200_000) stderr += chunk;
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(input.prompt);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, input.timeMs);
  const exit = await new Promise<{
    code: number | null;
    signal: string | null;
    spawnError?: string;
  }>((done) => {
    child.once('error', (error) => done({ code: null, signal: null, spawnError: String(error) }));
    child.once('close', (code, signal) => done({ code, signal }));
  });
  clearTimeout(timer);
  const wallMs = Math.round(performance.now() - wallStart);
  mkdirSync(input.clientDir, { recursive: true });
  writeFileSync(join(input.clientDir, 'stream.jsonl'), redact(stdout));
  writeFileSync(join(input.clientDir, 'stderr.txt'), redact(stderr));
  const stream = parseClaudeStream(stdout, startedAt);
  const result = stream.result;
  let status: RunStatus = 'completed';
  let error: string | undefined;
  if (timedOut) {
    status = 'timeout';
  } else if (result?.subtype === 'error_max_turns') {
    status = 'step_budget';
  } else if (!result) {
    status = 'client_error';
    error =
      exit.spawnError ?? `no result line (exit ${exit.code ?? exit.signal}): ${stderr.slice(-500)}`;
  } else if (result.is_error === true) {
    status = 'client_error';
    error = `${String(result.subtype)}: ${String(result.result ?? '').slice(0, 500)}`;
  }
  const init = stream.init ?? {};
  return {
    status,
    ...(error ? { error: redact(error) } : {}),
    durationMs: typeof result?.duration_ms === 'number' ? result.duration_ms : wallMs,
    wallMs,
    answer: stream.answer,
    events: stream.events,
    offeredTools: stream.offeredTools,
    tokens: stream.tokens,
    tokensSource: stream.tokensSource,
    info: {
      version: init.claude_code_version,
      sessionId: init.session_id,
      model: init.model,
      permissionMode: init.permissionMode,
      apiKeySource: init.apiKeySource,
      // What a user configuration would add; a clean config dir has none of its own.
      mcpServers: Array.isArray(init.mcp_servers) ? init.mcp_servers.length : undefined,
      plugins: Array.isArray(init.plugins)
        ? init.plugins.map((plugin: { source?: unknown }) => String(plugin?.source))
        : undefined,
      resultSubtype: result?.subtype,
      isError: result?.is_error,
      numTurns: result?.num_turns,
      durationApiMs: result?.duration_api_ms,
      costUsd: result?.total_cost_usd,
      models: result?.modelUsage ? Object.keys(result.modelUsage as object) : [],
      exitCode: exit.code,
      signal: exit.signal,
      badLines: stream.badLines,
      args,
      envOverrides: Object.keys(variant?.env ?? {}),
    },
  };
}
