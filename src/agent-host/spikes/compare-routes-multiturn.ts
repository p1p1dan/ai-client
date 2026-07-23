/**
 * Fair Phase-0 re-compare: stream-json vs Agent SDK, multi-turn resume.
 *
 * Turn 1: ask model to remember a secret token.
 * Turn 2: resume same session and ask what the token was.
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/compare-routes-multiturn.ts
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const SECRET = 'ORANGE-42';
const TURN1 = `For this coding session, my project codename is ${SECRET}. Please acknowledge the project codename in one short sentence. Do not use tools.`;
const TURN2 = `What is my project codename for this coding session? Reply with the codename only. Do not use tools.`;
const TIMEOUT_MS = Number(process.env.AICLIENT_COMPARE_TIMEOUT_MS ?? 120000);
const CWD = process.env.AICLIENT_SPIKE_WORKDIR ?? path.resolve(hostRoot, '..', '..');

/** Claude Code reads ~/.claude/settings.json env; also inject into child for reliability. */
async function loadClaudeSettingsEnv(): Promise<{
  env: NodeJS.ProcessEnv;
  diagnostics: {
    settingsPath: string;
    hasAuthToken: boolean;
    hasApiKey: boolean;
    hasBaseUrl: boolean;
    baseHost: string | null;
    model: string | null;
  };
}> {
  const settingsPath = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'),
    'settings.json'
  );
  const diagnostics = {
    settingsPath,
    hasAuthToken: false,
    hasApiKey: false,
    hasBaseUrl: false,
    baseHost: null as string | null,
    model: null as string | null,
  };
  const env: NodeJS.ProcessEnv = { ...process.env };

  try {
    const raw = await readFile(settingsPath, 'utf8');
    const json = JSON.parse(raw) as {
      model?: string;
      env?: Record<string, unknown>;
    };
    diagnostics.model = typeof json.model === 'string' ? json.model : null;
    const settingsEnv = json.env ?? {};
    for (const [key, value] of Object.entries(settingsEnv)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
    // Prefer AUTH_TOKEN over empty/stale API_KEY (matches AiClient onboarding behavior).
    if (env.ANTHROPIC_AUTH_TOKEN) {
      delete env.ANTHROPIC_API_KEY;
    }
    diagnostics.hasAuthToken = Boolean(env.ANTHROPIC_AUTH_TOKEN);
    diagnostics.hasApiKey = Boolean(env.ANTHROPIC_API_KEY);
    diagnostics.hasBaseUrl = Boolean(env.ANTHROPIC_BASE_URL);
    if (typeof env.ANTHROPIC_BASE_URL === 'string') {
      try {
        diagnostics.baseHost = new URL(env.ANTHROPIC_BASE_URL).host;
      } catch {
        diagnostics.baseHost = 'invalid-url';
      }
    }
  } catch (err) {
    throw new Error(
      `Failed to load Claude settings at ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return { env, diagnostics };
}

let childEnv: NodeJS.ProcessEnv = process.env;

interface TurnMetrics {
  ok: boolean;
  sessionId?: string;
  eventCount: number;
  types: string[];
  subtypes: string[];
  assistantText: string;
  msToFirstAssistant: number | null;
  msTotal: number;
  exitCode: number | null;
  apiRetries: number;
  lastApiError?: string;
  apiKeySource?: string;
  model?: string;
  error?: string;
  recalledSecret?: boolean;
}

interface RouteReport {
  route: 'stream-json' | 'agent-sdk';
  turn1: TurnMetrics;
  turn2: TurnMetrics;
  continuityOk: boolean;
}

async function resolveCometixCli(): Promise<string> {
  const pkgJson = require.resolve('@cometix/claude-code/package.json');
  const root = path.dirname(pkgJson);
  for (const c of [
    path.join(root, 'cli.js'),
    path.join(root, 'cli.mjs'),
    path.join(root, 'bin', 'cli.js'),
  ]) {
    try {
      await access(c);
      return c;
    } catch {
      // next
    }
  }
  throw new Error(`Cometix cli.js not found under ${root}`);
}

function extractText(event: unknown): string {
  const e = event as {
    type?: string;
    message?: { content?: unknown; role?: string };
    content?: unknown;
    result?: unknown;
    text?: string;
  };
  const chunks: string[] = [];
  const pull = (content: unknown) => {
    if (typeof content === 'string') {
      chunks.push(content);
      return;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') chunks.push(part);
        else if (part && typeof part === 'object' && 'text' in part) {
          const t = (part as { text?: unknown }).text;
          if (typeof t === 'string') chunks.push(t);
        }
      }
    }
  };
  if (e.message) pull(e.message.content);
  pull(e.content);
  if (typeof e.text === 'string') chunks.push(e.text);
  if (typeof e.result === 'string') chunks.push(e.result);
  return chunks.join('');
}

function extractSessionId(event: unknown): string | undefined {
  const e = event as { session_id?: string; sessionId?: string; message?: { session_id?: string } };
  return e.session_id || e.sessionId || e.message?.session_id;
}

function isAssistantish(event: unknown, text: string): boolean {
  const type = String((event as { type?: string }).type ?? '');
  if (text.trim().length === 0) return false;
  return (
    type === 'assistant' ||
    type.includes('assistant') ||
    type === 'result' ||
    type === 'stream_event' ||
    type === 'content_block_delta' ||
    type === 'message'
  );
}

async function runStreamJsonTurn(opts: {
  cliPath: string;
  prompt: string;
  resumeSessionId?: string;
}): Promise<TurnMetrics> {
  const args = [
    opts.cliPath,
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];
  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }

  const started = performance.now();
  const child = spawn(process.execPath, args, {
    cwd: CWD,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });

  const metrics: TurnMetrics = {
    ok: false,
    eventCount: 0,
    types: [],
    subtypes: [],
    assistantText: '',
    msToFirstAssistant: null,
    msTotal: 0,
    exitCode: null,
    apiRetries: 0,
  };

  let stderr = '';
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }, TIMEOUT_MS);

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed) as unknown;
      metrics.eventCount += 1;
      const typed = event as {
        type?: string;
        subtype?: string;
        apiKeySource?: string;
        model?: string;
        error?: string;
        error_status?: number;
      };
      const type = String(typed.type ?? 'unknown');
      if (metrics.types.length < 20) metrics.types.push(type);
      if (typed.subtype && metrics.subtypes.length < 20) {
        metrics.subtypes.push(String(typed.subtype));
      }
      if (typed.subtype === 'init') {
        if (typed.apiKeySource) metrics.apiKeySource = typed.apiKeySource;
        if (typed.model) metrics.model = typed.model;
      }
      if (typed.subtype === 'api_retry') {
        metrics.apiRetries += 1;
        metrics.lastApiError = `${String(typed.error_status ?? '')}:${String(typed.error ?? '')}`;
      }
      const sid = extractSessionId(event);
      if (sid) metrics.sessionId = sid;
      const text = extractText(event);
      if (text) metrics.assistantText += text;
      if (metrics.msToFirstAssistant == null && isAssistantish(event, text)) {
        metrics.msToFirstAssistant = Math.round(performance.now() - started);
      }
    } catch {
      // ignore non-json
    }
  });
  child.stderr.on('data', (c) => {
    stderr += c.toString();
  });

  metrics.exitCode = await new Promise<number | null>((resolve) => {
    child.on('exit', (c) => resolve(c));
  });
  clearTimeout(timer);
  metrics.msTotal = Math.round(performance.now() - started);
  metrics.recalledSecret = metrics.assistantText.includes(SECRET);
  metrics.ok = metrics.eventCount > 0 && metrics.assistantText.trim().length > 0;
  if (!metrics.ok) {
    metrics.error = stderr.trim().slice(0, 400) || `no assistant text (exit=${String(metrics.exitCode)})`;
  }
  return metrics;
}

async function runSdkTurn(opts: {
  cliPath: string;
  prompt: string;
  resumeSessionId?: string;
}): Promise<TurnMetrics> {
  const started = performance.now();
  const metrics: TurnMetrics = {
    ok: false,
    eventCount: 0,
    types: [],
    subtypes: [],
    assistantText: '',
    msToFirstAssistant: null,
    msTotal: 0,
    exitCode: null,
    apiRetries: 0,
  };

  const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
    query: (params: {
      prompt: string;
      options?: Record<string, unknown>;
    }) => AsyncIterable<unknown>;
  };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  try {
    const stream = sdk.query({
      prompt: opts.prompt,
      options: {
        cwd: CWD,
        pathToClaudeCodeExecutable: opts.cliPath,
        executable: process.execPath,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        env: childEnv,
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
        abortController: abort,
      },
    });

    for await (const event of stream) {
      if (abort.signal.aborted) break;
      metrics.eventCount += 1;
      const typed = event as {
        type?: string;
        subtype?: string;
        apiKeySource?: string;
        model?: string;
        error?: string;
        error_status?: number;
      };
      const type = String(typed.type ?? typeof event);
      if (metrics.types.length < 20) metrics.types.push(type);
      if (typed.subtype && metrics.subtypes.length < 20) {
        metrics.subtypes.push(String(typed.subtype));
      }
      if (typed.subtype === 'init') {
        if (typed.apiKeySource) metrics.apiKeySource = typed.apiKeySource;
        if (typed.model) metrics.model = typed.model;
      }
      if (typed.subtype === 'api_retry') {
        metrics.apiRetries += 1;
        metrics.lastApiError = `${String(typed.error_status ?? '')}:${String(typed.error ?? '')}`;
      }
      const sid = extractSessionId(event);
      if (sid) metrics.sessionId = sid;
      const text = extractText(event);
      if (text) metrics.assistantText += text;
      if (metrics.msToFirstAssistant == null && isAssistantish(event, text)) {
        metrics.msToFirstAssistant = Math.round(performance.now() - started);
      }
    }
    metrics.ok = metrics.eventCount > 0 && metrics.assistantText.trim().length > 0;
    if (!metrics.ok) {
      metrics.error = abort.signal.aborted
        ? `timed out after ${TIMEOUT_MS}ms`
        : 'no assistant text';
    }
  } catch (err) {
    metrics.error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    metrics.msTotal = Math.round(performance.now() - started);
    metrics.recalledSecret = metrics.assistantText.includes(SECRET);
  }
  return metrics;
}

async function runRoute(
  route: 'stream-json' | 'agent-sdk',
  cliPath: string
): Promise<RouteReport> {
  const turn1 =
    route === 'stream-json'
      ? await runStreamJsonTurn({ cliPath, prompt: TURN1 })
      : await runSdkTurn({ cliPath, prompt: TURN1 });

  const resumeId = turn1.sessionId;
  let turn2: TurnMetrics;
  if (!resumeId) {
    turn2 = {
      ok: false,
      eventCount: 0,
      types: [],
      subtypes: [],
      assistantText: '',
      msToFirstAssistant: null,
      msTotal: 0,
      exitCode: null,
      apiRetries: 0,
      error: 'turn1 did not yield sessionId — cannot resume',
    };
  } else if (route === 'stream-json') {
    turn2 = await runStreamJsonTurn({ cliPath, prompt: TURN2, resumeSessionId: resumeId });
  } else {
    turn2 = await runSdkTurn({ cliPath, prompt: TURN2, resumeSessionId: resumeId });
  }

  return {
    route,
    turn1,
    turn2,
    continuityOk: Boolean(turn2.recalledSecret),
  };
}

function summarize(report: RouteReport): Record<string, unknown> {
  const trim = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 160);
  return {
    route: report.route,
    continuityOk: report.continuityOk,
    turn1: {
      ok: report.turn1.ok,
      sessionId: report.turn1.sessionId,
      msToFirstAssistant: report.turn1.msToFirstAssistant,
      msTotal: report.turn1.msTotal,
      eventCount: report.turn1.eventCount,
      apiRetries: report.turn1.apiRetries,
      lastApiError: report.turn1.lastApiError,
      apiKeySource: report.turn1.apiKeySource,
      model: report.turn1.model,
      types: report.turn1.types,
      subtypes: report.turn1.subtypes,
      text: trim(report.turn1.assistantText),
      error: report.turn1.error,
    },
    turn2: {
      ok: report.turn2.ok,
      recalledSecret: report.turn2.recalledSecret,
      msToFirstAssistant: report.turn2.msToFirstAssistant,
      msTotal: report.turn2.msTotal,
      eventCount: report.turn2.eventCount,
      apiRetries: report.turn2.apiRetries,
      lastApiError: report.turn2.lastApiError,
      apiKeySource: report.turn2.apiKeySource,
      model: report.turn2.model,
      types: report.turn2.types,
      subtypes: report.turn2.subtypes,
      text: trim(report.turn2.assistantText),
      error: report.turn2.error,
    },
  };
}

async function main(): Promise<void> {
  const cliPath = await resolveCometixCli();
  const loaded = await loadClaudeSettingsEnv();
  childEnv = loaded.env;

  console.error(`[compare] node=${process.version}`);
  console.error(`[compare] execPath=${process.execPath}`);
  console.error(`[compare] cli=${cliPath}`);
  console.error(`[compare] cwd=${CWD}`);
  console.error(`[compare] timeoutMs=${TIMEOUT_MS}`);
  console.error(`[compare] secret=${SECRET}`);
  console.error(`[compare] settings=${loaded.diagnostics.settingsPath}`);
  console.error(
    `[compare] creds hasAuthToken=${loaded.diagnostics.hasAuthToken} hasApiKey=${loaded.diagnostics.hasApiKey} baseHost=${loaded.diagnostics.baseHost} model=${loaded.diagnostics.model}`
  );

  // Warm order: stream-json first, then SDK (document order). Optionally reverse via env.
  const order =
    process.env.AICLIENT_COMPARE_ORDER === 'sdk-first'
      ? (['agent-sdk', 'stream-json'] as const)
      : (['stream-json', 'agent-sdk'] as const);

  const reports: RouteReport[] = [];
  for (const route of order) {
    console.error(`[compare] running ${route}…`);
    const report = await runRoute(route, cliPath);
    reports.push(report);
    console.error(
      `[compare] ${route} continuity=${report.continuityOk} t1=${report.turn1.msTotal}ms t2=${report.turn2.msTotal}ms apiKeySource=${report.turn1.apiKeySource ?? '?'} retries=${report.turn1.apiRetries}`
    );
  }

  const out = {
    secret: SECRET,
    timeoutMs: TIMEOUT_MS,
    order: [...order],
    settingsDiagnostics: loaded.diagnostics,
    routes: reports.map(summarize),
  };
  console.log(JSON.stringify(out, null, 2));

  const bothContinuity = reports.every((r) => r.continuityOk);
  process.exitCode = bothContinuity ? 0 : 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
