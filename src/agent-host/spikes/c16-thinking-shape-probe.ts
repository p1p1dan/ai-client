/**
 * #8 spike: which `thinking` shape does the pinned Agent SDK + gateway actually
 * accept, and which one yields *visible* thinking text?
 *
 * Two suspicions about claudeRuntime.ts:393
 * (`thinking: { type: 'enabled', budgetTokens: 4096 }`):
 *   1. `{type:'enabled', budgetTokens}` is deprecated on Opus 4.6/Sonnet 4.6 and
 *      documented as removed on Opus 4.8/4.7, Sonnet 5 and Fable 5 — suspected
 *      cause of the C-14 "400 thinking 格式无效" transient.
 *   2. `thinking.display` unset defaults to `omitted` on those models, so
 *      thinking blocks stream with an EMPTY text field — T-04's "no thinking
 *      card" with a code chain that is otherwise correct.
 *
 * RESULT (2026-07-27, CCH gateway, model claude-opus-4-8[1m]):
 *   Suspicion 2 CONFIRMED — B (adaptive, display unset) returned 1 thinking
 *   block with thinkingTextLen 0; C (adaptive + summarized) returned 408 chars.
 *   The summarized runs also emitted 8–9 system/thinking_tokens events that the
 *   bare-adaptive run never produced.
 *   Suspicion 1 REFUTED on this gateway — A (the old fixed-budget shape) still
 *   returned ok=true with no 400 and no api_retry. So `budgetTokens` was NOT the
 *   cause of the C-14 transient; that root cause remains open. The shape is
 *   still migrated off because it is documented-removed upstream, i.e. a latent
 *   400 the moment the gateway stops tolerating it — not because it fails today.
 *
 * SDK 0.3.218 type ground truth (sdk.d.ts):
 *   ThinkingConfig = ThinkingAdaptive | ThinkingEnabled | ThinkingDisabled
 *   ThinkingAdaptive = { type: 'adaptive'; display?: 'summarized' | 'omitted' }
 *   Options.effort?: EffortLevel   <-- TOP-LEVEL option, NOT output_config.effort
 * The last line corrects the C-10 ledger row, which assumed `output_config.effort`.
 *
 * Scenarios (all against the shared CCH test gateway, reasoning-heavy prompt):
 *   A enabled_budgetTokens   control — the current production shape
 *   B adaptive_default       adaptive, display unset  → expect clean, text EMPTY
 *   C adaptive_summarized    adaptive + summarized    → expect clean, text NON-EMPTY  <-- the fix
 *   D adaptive_sum_effort    C + top-level effort     → prove effort is accepted
 *   E disabled_control       thinking off             → baseline sanity
 *
 * Verdict line (machine-checkable, printed last as JSON):
 *   fixShapeWorks   = C clean AND C thinking text non-empty
 *   displayIsTheBug = B clean AND B thinking text empty  (isolates defect 2)
 *   effortAccepted  = D clean
 *   oldShapeRejected = whether A actually fails here (false as of 2026-07-27)
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/c16-thinking-shape-probe.ts
 *
 * Optional:
 *   AICLIENT_C16_TIMEOUT_MS=120000
 *   AICLIENT_C16_WORKDIR=<path>
 *   AICLIENT_C16_MODEL=<model id>          # force a model instead of gateway default
 *   AICLIENT_C16_EFFORT=high               # effort level for scenario D
 *   AICLIENT_SMOKE_USE_LOCAL_SETTINGS=1    # keep ~/.claude/settings.json creds
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

const CWD = process.env.AICLIENT_C16_WORKDIR ?? repoRoot;
const TIMEOUT_MS = Number(process.env.AICLIENT_C16_TIMEOUT_MS ?? 120_000);
const FORCED_MODEL = process.env.AICLIENT_C16_MODEL ?? '';
const EFFORT = process.env.AICLIENT_C16_EFFORT ?? 'high';

/** Reasoning-heavy so an adaptive model actually chooses to think. */
const REASONING_PROMPT =
  'Reason carefully before answering, then give the final number only on the last line. ' +
  'A freight train leaves at 06:40 travelling 82 km/h. A second train leaves the same ' +
  'station at 07:15 travelling 118 km/h on the same track. At what clock time does the ' +
  'second train catch the first, and how far from the station is that? Do not use any tools.';

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

/**
 * Count thinking BLOCKS separately from thinking TEXT. The whole point of
 * defect 2 is that blocks arrive while text is empty, so conflating the two
 * hides it.
 */
function extractThinking(content: unknown): { blocks: number; text: string } {
  if (!Array.isArray(content)) return { blocks: 0, text: '' };
  let blocks = 0;
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; thinking?: unknown; text?: unknown };
    if (p.type !== 'thinking') continue;
    blocks += 1;
    if (typeof p.thinking === 'string') chunks.push(p.thinking);
    else if (typeof p.text === 'string') chunks.push(p.text);
  }
  return { blocks, text: chunks.join('') };
}

interface TurnResult {
  ok: boolean;
  threw: boolean;
  errorMessage?: string;
  optionsSent: Record<string, unknown>;
  eventCount: number;
  eventTypeSeq: string[];
  streamEventDeltaTypes: string[];
  thinkingBlockCount: number;
  sawThinkingDeltaStreamEvent: boolean;
  thinkingTextLen: number;
  thinkingPreview: string;
  assistantTextLen: number;
  assistantPreview: string;
  apiRetryErrors: Array<{ error: string; error_status: number | null }>;
  resultErrors: string[];
  isErrorResult: boolean;
  apiErrorStatus?: number | null;
  /** True when any surfaced error text looks like the thinking-format 400. */
  sawThinkingFormat400: boolean;
  sessionId?: string;
  model?: string;
  msTotal: number;
}

function newTurnResult(): TurnResult {
  return {
    ok: false,
    threw: false,
    optionsSent: {},
    eventCount: 0,
    eventTypeSeq: [],
    streamEventDeltaTypes: [],
    thinkingBlockCount: 0,
    sawThinkingDeltaStreamEvent: false,
    thinkingTextLen: 0,
    thinkingPreview: '',
    assistantTextLen: 0,
    assistantPreview: '',
    apiRetryErrors: [],
    resultErrors: [],
    isErrorResult: false,
    sawThinkingFormat400: false,
    msTotal: 0,
  };
}

/** Heuristic: does this error blob look like the thinking-shape rejection? */
function looksLikeThinkingFormat400(blob: string): boolean {
  const s = blob.toLowerCase();
  if (!s) return false;
  const mentionsThinking = s.includes('thinking') || s.includes('budget_tokens');
  const mentions400 =
    s.includes('400') || s.includes('invalid_request') || s.includes('invalid request');
  return mentionsThinking && mentions400;
}

async function runTurn(opts: {
  queryFn: QueryFn;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string;
  /** Omitted entirely when undefined — that is itself a meaningful shape. */
  thinking?: Record<string, unknown>;
  effort?: string;
}): Promise<TurnResult> {
  const started = performance.now();
  const result = newTurnResult();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  const canUseTool = async (
    _toolName: string,
    input: Record<string, unknown>
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }> => ({
    behavior: 'allow',
    updatedInput: input,
  });

  // Mirror claudeRuntime.ts's option set exactly except the fields under test,
  // so a result here transfers to production.
  const options: Record<string, unknown> = {
    cwd: opts.cwd,
    pathToClaudeCodeExecutable: opts.cliPath,
    executable: process.execPath,
    tools: { type: 'preset', preset: 'claude_code' },
    settingSources: [],
    permissionMode: 'default',
    canUseTool,
    env: opts.env,
    abortController: abort,
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(FORCED_MODEL ? { model: FORCED_MODEL } : {}),
  };
  result.optionsSent = {
    thinking: opts.thinking ?? '<omitted>',
    effort: opts.effort ?? '<omitted>',
    model: FORCED_MODEL || '<gateway default>',
  };

  let stream: (AsyncIterable<unknown> & { close?: () => void }) | null = null;
  try {
    stream = opts.queryFn({ prompt: opts.prompt, options });

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
        result?: unknown;
      };
      const type = String(e.type ?? typeof event);
      const tag = e.subtype ? `${type}/${e.subtype}` : type;
      if (result.eventTypeSeq.length < 60) result.eventTypeSeq.push(tag);
      if (e.session_id) result.sessionId = e.session_id;
      if (type === 'system' && e.subtype === 'init' && e.model) result.model = e.model;

      if (type === 'system' && e.subtype === 'api_retry') {
        const entry = { error: String(e.error ?? ''), error_status: e.error_status ?? null };
        result.apiRetryErrors.push(entry);
        if (looksLikeThinkingFormat400(`${entry.error} ${entry.error_status ?? ''}`)) {
          result.sawThinkingFormat400 = true;
        }
      }

      if (type === 'assistant') {
        const content = e.message?.content;
        const { blocks, text } = extractThinking(content);
        result.thinkingBlockCount += blocks;
        if (text) {
          result.thinkingTextLen += text.length;
          if (!result.thinkingPreview) result.thinkingPreview = text.slice(0, 240);
        }
        const assistantText = extractTextParts(content);
        if (assistantText) {
          result.assistantTextLen += assistantText.length;
          if (result.assistantPreview.length < 300) {
            result.assistantPreview = (result.assistantPreview + assistantText).slice(0, 300);
          }
        }
      }

      if (type === 'stream_event' && e.event?.type === 'content_block_start') {
        // A thinking block can open on the stream even when the buffered
        // assistant message carries empty text — count it as a block sighting.
        const startType = String(
          (e.event as { content_block?: { type?: string } }).content_block?.type ?? ''
        );
        if (startType === 'thinking' && result.thinkingBlockCount === 0) {
          result.thinkingBlockCount += 1;
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
          if (!result.thinkingPreview) result.thinkingPreview = t.slice(0, 240);
        }
      }

      if (type === 'result') {
        result.isErrorResult = Boolean(e.is_error);
        result.apiErrorStatus = e.api_error_status ?? null;
        if (Array.isArray(e.errors)) result.resultErrors = e.errors;
        const blob = `${JSON.stringify(e.errors ?? [])} ${String(e.result ?? '')} ${
          e.api_error_status ?? ''
        }`;
        if (looksLikeThinkingFormat400(blob)) result.sawThinkingFormat400 = true;
      }
    }
    // `ok` = the turn produced a real answer with no error terminal.
    result.ok = !result.isErrorResult && result.eventCount > 0 && result.assistantTextLen > 0;
  } catch (err) {
    result.threw = true;
    result.errorMessage = err instanceof Error ? err.message : String(err);
    if (looksLikeThinkingFormat400(result.errorMessage)) result.sawThinkingFormat400 = true;
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
    optionsSent: r.optionsSent,
    ok: r.ok,
    threw: r.threw,
    errorMessage: r.errorMessage,
    isErrorResult: r.isErrorResult,
    apiErrorStatus: r.apiErrorStatus,
    sawThinkingFormat400: r.sawThinkingFormat400,
    resultErrors: r.resultErrors,
    apiRetryErrors: r.apiRetryErrors,
    eventCount: r.eventCount,
    eventTypeSeq: r.eventTypeSeq,
    streamEventDeltaTypes: r.streamEventDeltaTypes,
    thinkingBlockCount: r.thinkingBlockCount,
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
  // settingSources: [] disables settings.json inside the CLI, so credentials
  // must be literal env vars (see c03-question-probe.ts).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...testCredentialEnv(CWD),
    ANTHROPIC_AUTH_TOKEN: TEST_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: TEST_BASE_URL,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'aiclient-c16-thinking-shape-probe/0.0.1',
  };

  console.error(`[c16] node=${process.version}`);
  console.error(`[c16] cometix=${COMETIX_PIN.version} sdk=${CLAUDE_AGENT_SDK_PIN_VERSION}`);
  console.error(`[c16] cliPath=${cliPath}`);
  console.error(`[c16] cwd=${CWD}`);
  console.error(
    `[c16] baseUrl=${TEST_BASE_URL} usingLocalSettings=${process.env.AICLIENT_SMOKE_USE_LOCAL_SETTINGS === '1'}`
  );
  console.error(
    `[c16] timeoutMs=${TIMEOUT_MS} model=${FORCED_MODEL || '<default>'} effort=${EFFORT}`
  );

  const base = { queryFn, cliPath, env, cwd: CWD, prompt: REASONING_PROMPT };

  // A: control — the current production shape. Expect the 400 root cause.
  console.error('[c16] A: thinking {type:enabled, budgetTokens:4096} (current prod shape)…');
  const a = await runTurn({ ...base, thinking: { type: 'enabled', budgetTokens: 4096 } });
  console.error(
    `[c16] A ok=${a.ok} threw=${a.threw} isErrorResult=${a.isErrorResult} thinking400=${a.sawThinkingFormat400} ms=${a.msTotal}`
  );

  // B: adaptive, display unset — expect clean but EMPTY thinking text.
  console.error('[c16] B: thinking {type:adaptive} (display unset)…');
  const b = await runTurn({ ...base, thinking: { type: 'adaptive' } });
  console.error(
    `[c16] B ok=${b.ok} blocks=${b.thinkingBlockCount} textLen=${b.thinkingTextLen} ms=${b.msTotal}`
  );

  // C: the proposed fix — adaptive + summarized.
  console.error('[c16] C: thinking {type:adaptive, display:summarized} (proposed fix)…');
  const c = await runTurn({ ...base, thinking: { type: 'adaptive', display: 'summarized' } });
  console.error(
    `[c16] C ok=${c.ok} blocks=${c.thinkingBlockCount} textLen=${c.thinkingTextLen} ms=${c.msTotal}`
  );

  // D: fix + top-level effort — proves the T-20 protocol base is viable.
  console.error(`[c16] D: fix + top-level effort='${EFFORT}'…`);
  const d = await runTurn({
    ...base,
    thinking: { type: 'adaptive', display: 'summarized' },
    effort: EFFORT,
  });
  console.error(
    `[c16] D ok=${d.ok} blocks=${d.thinkingBlockCount} textLen=${d.thinkingTextLen} ms=${d.msTotal}`
  );

  // E: baseline sanity — thinking explicitly off.
  console.error('[c16] E: thinking {type:disabled} (baseline)…');
  const e = await runTurn({ ...base, thinking: { type: 'disabled' } });
  console.error(`[c16] E ok=${e.ok} textLen=${e.assistantTextLen} ms=${e.msTotal}`);

  const verdict = {
    /** The fix works: clean turn AND visible thinking text. */
    fixShapeWorks: c.ok && c.thinkingTextLen > 0,
    /** Isolates defect 2: adaptive is fine, `display` alone was hiding the text. */
    displayIsTheBug: b.ok && b.thinkingBlockCount > 0 && b.thinkingTextLen === 0,
    /** Top-level effort accepted (T-20 protocol base). */
    effortAccepted: d.ok,
    /** Defect 1 reproduced on this gateway/model pair. */
    oldShapeRejected: !a.ok || a.sawThinkingFormat400,
    baselineHealthy: e.ok,
  };

  const out = {
    probe: 'c16-thinking-shape',
    baseUrl: TEST_BASE_URL,
    cometixVersion: COMETIX_PIN.version,
    sdkVersion: CLAUDE_AGENT_SDK_PIN_VERSION,
    modelRequested: FORCED_MODEL || '<gateway default>',
    modelReported: c.model ?? b.model ?? a.model ?? null,
    effortTested: EFFORT,
    verdict,
    scenarios: {
      A_enabled_budgetTokens: summarize('A_enabled_budgetTokens', a),
      B_adaptive_default: summarize('B_adaptive_default', b),
      C_adaptive_summarized: summarize('C_adaptive_summarized', c),
      D_adaptive_summarized_effort: summarize('D_adaptive_summarized_effort', d),
      E_disabled_control: summarize('E_disabled_control', e),
    },
  };
  console.log(JSON.stringify(out, null, 2));

  // Exit 0 only when the fix is empirically justified: C must work and D must
  // accept effort. A's rejection is informative but gateway-dependent, so it
  // does not gate — the report records it either way.
  process.exitCode = verdict.fixShapeWorks && verdict.effortAccepted ? 0 : 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
