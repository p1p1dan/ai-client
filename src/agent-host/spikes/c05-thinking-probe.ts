/**
 * C-05 spike: does the CCH gateway support Agent SDK `thinking: { type: 'enabled' }`?
 *
 * claudeRuntime.ts:194 currently hardcodes `thinking: { type: 'disabled' }` with the
 * comment "Avoid CCH 'invalid thinking block' 400s". This spike re-probes that against
 * the live shared test gateway (spikes/testCredentials.ts) with the SDK's query()
 * called directly (no host protocol child process), mirroring the option set
 * claudeRuntime.ts passes to query() except for the `thinking` field under test.
 *
 * Scenarios:
 *   A: thinking enabled, single turn, default model — 400 or clean? thinking content on wire?
 *   B: thinking enabled, multi-turn (turn2 resumes turn1's session_id) — does history replay
 *      of a signed thinking block from turn1 break turn2?
 *   C: control — thinking disabled, single turn — confirm baseline still works.
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/c05-thinking-probe.ts
 *
 * Optional:
 *   AICLIENT_C05_TIMEOUT_MS=90000
 *   AICLIENT_C05_WORKDIR=<path>
 *   AICLIENT_C05_BUDGET_TOKENS=4096
 *   AICLIENT_SMOKE_USE_LOCAL_SETTINGS=1   # keep ~/.claude/settings.json creds instead of shared test gw
 */

import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { CLAUDE_AGENT_SDK_PIN_VERSION, COMETIX_PIN } from '../pin.ts';
import { TEST_AUTH_TOKEN, TEST_BASE_URL, testCredentialEnv } from './testCredentials.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(hostRoot, '..', '..');
const require = createRequire(import.meta.url);

const CWD = process.env.AICLIENT_C05_WORKDIR ?? repoRoot;
const TIMEOUT_MS = Number(process.env.AICLIENT_C05_TIMEOUT_MS ?? 90000);
const BUDGET_TOKENS = Number(process.env.AICLIENT_C05_BUDGET_TOKENS ?? 4096);

const REASONING_PROMPT = 'Think step by step: what is 17 * 23 + 891 / 27? Show your reasoning.';
const FOLLOWUP_PROMPT =
  'Now take the result from your previous answer and multiply it by 2. Show your reasoning.';

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
      // try next
    }
  }
  throw new Error(`Cometix cli.js not found under ${root}`);
}

type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<unknown> & { close?: () => void };

async function loadQueryFn(): Promise<QueryFn> {
  const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
    query?: QueryFn;
    default?: { query?: QueryFn };
  };
  const fn = sdk.query ?? sdk.default?.query;
  if (!fn) throw new Error('claude-agent-sdk has no query() export');
  return fn;
}

function extractTextParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      chunks.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; text?: unknown };
    if ((p.type === 'text' || p.type === undefined) && typeof p.text === 'string') {
      chunks.push(p.text);
    }
  }
  return chunks.join('');
}

function extractThinkingParts(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; thinking?: unknown; text?: unknown; signature?: unknown };
    if (p.type === 'thinking') {
      if (typeof p.thinking === 'string') chunks.push(p.thinking);
      else if (typeof p.text === 'string') chunks.push(p.text);
    }
  }
  return chunks.join('');
}

interface TurnResult {
  ok: boolean;
  threw: boolean;
  errorMessage?: string;
  eventCount: number;
  eventTypeSeq: string[];
  streamEventDeltaTypes: string[];
  sawThinkingBlockInAssistantContent: boolean;
  sawThinkingDeltaStreamEvent: boolean;
  thinkingTextLen: number;
  thinkingPreview: string;
  assistantTextLen: number;
  assistantPreview: string;
  apiRetryErrors: Array<{ error: string; error_status: number | null }>;
  resultErrors: string[];
  isErrorResult: boolean;
  apiErrorStatus?: number | null;
  sessionId?: string;
  model?: string;
  msTotal: number;
}

function newTurnResult(): TurnResult {
  return {
    ok: false,
    threw: false,
    eventCount: 0,
    eventTypeSeq: [],
    streamEventDeltaTypes: [],
    sawThinkingBlockInAssistantContent: false,
    sawThinkingDeltaStreamEvent: false,
    thinkingTextLen: 0,
    thinkingPreview: '',
    assistantTextLen: 0,
    assistantPreview: '',
    apiRetryErrors: [],
    resultErrors: [],
    isErrorResult: false,
    msTotal: 0,
  };
}

async function runTurn(opts: {
  queryFn: QueryFn;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string;
  thinking: Record<string, unknown>;
  resumeSessionId?: string;
}): Promise<TurnResult> {
  const started = performance.now();
  const result = newTurnResult();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  // Auto-allow any tool call so the reasoning-only prompt never hangs on an
  // interactive permission prompt (no UI in this spike).
  const canUseTool = async (
    _toolName: string,
    input: Record<string, unknown>
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }> => ({
    behavior: 'allow',
    updatedInput: input,
  });

  let stream: (AsyncIterable<unknown> & { close?: () => void }) | null = null;
  try {
    stream = opts.queryFn({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        pathToClaudeCodeExecutable: opts.cliPath,
        executable: process.execPath,
        tools: { type: 'preset', preset: 'claude_code' },
        settingSources: [],
        thinking: opts.thinking,
        permissionMode: 'default',
        canUseTool,
        env: opts.env,
        abortController: abort,
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
      },
    });

    for await (const event of stream) {
      if (abort.signal.aborted) break;
      result.eventCount += 1;
      const e = event as {
        type?: string;
        subtype?: string;
        session_id?: string;
        model?: string;
        message?: { content?: unknown };
        event?: { type?: string; delta?: { type?: string; thinking?: string; text?: string } };
        error?: string;
        error_status?: number | null;
        is_error?: boolean;
        api_error_status?: number | null;
        errors?: string[];
      };
      const type = String(e.type ?? typeof event);
      const tag = e.subtype ? `${type}/${e.subtype}` : type;
      if (result.eventTypeSeq.length < 60) result.eventTypeSeq.push(tag);
      if (e.session_id) result.sessionId = e.session_id;

      if (type === 'system' && e.subtype === 'init' && e.model) result.model = e.model;

      if (type === 'system' && e.subtype === 'api_retry') {
        result.apiRetryErrors.push({
          error: String(e.error ?? ''),
          error_status: e.error_status ?? null,
        });
      }

      if (type === 'assistant') {
        const content = e.message?.content;
        const thinking = extractThinkingParts(content);
        const text = extractTextParts(content);
        if (thinking) {
          result.sawThinkingBlockInAssistantContent = true;
          result.thinkingTextLen += thinking.length;
          if (!result.thinkingPreview) result.thinkingPreview = thinking.slice(0, 200);
        }
        if (text) {
          result.assistantTextLen += text.length;
          if (result.assistantPreview.length < 300) {
            result.assistantPreview = (result.assistantPreview + text).slice(0, 300);
          }
        }
      }

      if (type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta) {
        const deltaType = String(e.event.delta.type ?? '');
        if (
          result.streamEventDeltaTypes.length < 20 &&
          !result.streamEventDeltaTypes.includes(deltaType)
        ) {
          result.streamEventDeltaTypes.push(deltaType);
        }
        if (deltaType === 'thinking_delta' || deltaType === 'thinking') {
          result.sawThinkingDeltaStreamEvent = true;
          const t = e.event.delta.thinking ?? e.event.delta.text ?? '';
          result.thinkingTextLen += t.length;
          if (!result.thinkingPreview) result.thinkingPreview = t.slice(0, 200);
        }
      }

      if (type === 'result') {
        result.isErrorResult = Boolean(e.is_error);
        result.apiErrorStatus = e.api_error_status ?? null;
        if (Array.isArray(e.errors)) result.resultErrors = e.errors;
      }
    }
    result.ok =
      !result.isErrorResult &&
      result.eventCount > 0 &&
      (result.assistantTextLen > 0 || result.thinkingTextLen > 0);
  } catch (err) {
    result.threw = true;
    result.errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    result.msTotal = Math.round(performance.now() - started);
    try {
      stream?.close?.();
    } catch {
      // ignore
    }
  }
  return result;
}

function summarize(label: string, r: TurnResult): Record<string, unknown> {
  return {
    label,
    ok: r.ok,
    threw: r.threw,
    errorMessage: r.errorMessage,
    isErrorResult: r.isErrorResult,
    apiErrorStatus: r.apiErrorStatus,
    resultErrors: r.resultErrors,
    apiRetryErrors: r.apiRetryErrors,
    eventCount: r.eventCount,
    eventTypeSeq: r.eventTypeSeq,
    streamEventDeltaTypes: r.streamEventDeltaTypes,
    sawThinkingBlockInAssistantContent: r.sawThinkingBlockInAssistantContent,
    sawThinkingDeltaStreamEvent: r.sawThinkingDeltaStreamEvent,
    thinkingTextLen: r.thinkingTextLen,
    thinkingPreview: r.thinkingPreview,
    assistantTextLen: r.assistantTextLen,
    assistantPreview: r.assistantPreview,
    sessionId: r.sessionId,
    model: r.model,
    msTotal: r.msTotal,
  };
}

async function main(): Promise<void> {
  const cliPath = await resolveCometixCli();
  const queryFn = await loadQueryFn();
  // settingSources: [] (below, matching claudeRuntime.ts) disables settings.json
  // loading inside the CLI, so credentials must be literal env vars — not just
  // CLAUDE_CONFIG_DIR pointing at a settings.json (see c03-question-probe.ts).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...testCredentialEnv(CWD),
    ANTHROPIC_AUTH_TOKEN: TEST_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: TEST_BASE_URL,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'aiclient-c05-thinking-probe/0.0.1',
  };

  console.error(`[c05] node=${process.version}`);
  console.error(`[c05] cometix=${COMETIX_PIN.version} sdk=${CLAUDE_AGENT_SDK_PIN_VERSION}`);
  console.error(`[c05] cliPath=${cliPath}`);
  console.error(`[c05] cwd=${CWD}`);
  console.error(
    `[c05] baseUrl=${TEST_BASE_URL} usingLocalSettings=${process.env.AICLIENT_SMOKE_USE_LOCAL_SETTINGS === '1'}`
  );
  console.error(`[c05] timeoutMs=${TIMEOUT_MS} budgetTokens=${BUDGET_TOKENS}`);

  const thinkingEnabled = { type: 'enabled', budgetTokens: BUDGET_TOKENS };
  const thinkingDisabled = { type: 'disabled' };

  // Scenario A: thinking enabled, single turn, default model.
  console.error('[c05] scenario A: thinking enabled, single turn…');
  const a = await runTurn({
    queryFn,
    cliPath,
    env,
    cwd: CWD,
    prompt: REASONING_PROMPT,
    thinking: thinkingEnabled,
  });
  console.error(
    `[c05] A done ok=${a.ok} threw=${a.threw} isErrorResult=${a.isErrorResult} ms=${a.msTotal}`
  );

  // Scenario B: thinking enabled, multi-turn — turn1 same as A's shape (fresh call),
  // turn2 resumes turn1's session_id to see whether replaying a signed thinking
  // block from turn1's history breaks turn2.
  console.error('[c05] scenario B: thinking enabled, turn1…');
  const b1 = await runTurn({
    queryFn,
    cliPath,
    env,
    cwd: CWD,
    prompt: REASONING_PROMPT,
    thinking: thinkingEnabled,
  });
  console.error(
    `[c05] B turn1 done ok=${b1.ok} threw=${b1.threw} sessionId=${b1.sessionId ?? '?'} ms=${b1.msTotal}`
  );
  let b2: TurnResult;
  if (!b1.sessionId) {
    b2 = newTurnResult();
    b2.errorMessage = 'turn1 did not yield a session_id — cannot resume for turn2';
  } else {
    console.error('[c05] scenario B: thinking enabled, turn2 (resume)…');
    b2 = await runTurn({
      queryFn,
      cliPath,
      env,
      cwd: CWD,
      prompt: FOLLOWUP_PROMPT,
      thinking: thinkingEnabled,
      resumeSessionId: b1.sessionId,
    });
    console.error(
      `[c05] B turn2 done ok=${b2.ok} threw=${b2.threw} isErrorResult=${b2.isErrorResult} ms=${b2.msTotal}`
    );
  }

  // Scenario C: control — thinking disabled, single turn (current production config).
  console.error('[c05] scenario C: thinking disabled (control), single turn…');
  const c = await runTurn({
    queryFn,
    cliPath,
    env,
    cwd: CWD,
    prompt: REASONING_PROMPT,
    thinking: thinkingDisabled,
  });
  console.error(
    `[c05] C done ok=${c.ok} threw=${c.threw} isErrorResult=${c.isErrorResult} ms=${c.msTotal}`
  );

  const out = {
    baseUrl: TEST_BASE_URL,
    cometixVersion: COMETIX_PIN.version,
    sdkVersion: CLAUDE_AGENT_SDK_PIN_VERSION,
    budgetTokens: BUDGET_TOKENS,
    scenarios: {
      A_enabled_singleTurn: summarize('A_enabled_singleTurn', a),
      B_enabled_turn1: summarize('B_enabled_turn1', b1),
      B_enabled_turn2_resume: summarize('B_enabled_turn2_resume', b2),
      C_disabled_control: summarize('C_disabled_control', c),
    },
  };
  console.log(JSON.stringify(out, null, 2));

  const anyThrewOrErrored = [a, b1, b2, c].some((r) => r.threw || r.isErrorResult);
  process.exitCode = anyThrewOrErrored ? 2 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
