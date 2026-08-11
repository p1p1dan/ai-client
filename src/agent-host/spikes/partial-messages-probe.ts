/**
 * §4 spike (triage 2026-08-11): does the pinned Cometix CLI + Agent SDK honour
 * `includePartialMessages` on the CCH gateway, and what exactly arrives?
 *
 * The streaming construction batch hinges on three shapes nobody has measured
 * on this gateway (triage §4 「动工前置 spike」):
 *
 *   1. HONOURED — do `stream_event` (SDKPartialAssistantMessage) records show up
 *      at all once the option is sent? The Host has never sent it (the only
 *      mention in the repo is eventNormalizer.ts's comment saying it does not).
 *   2. 雷 A (text dedupe) — do WHOLE `assistant` messages still arrive ON TOP of
 *      the partials (additive), and where exactly do they land relative to
 *      `content_block_stop` / `message_stop`? If additive, the normalizer emits
 *      the same text twice unless it dedupes; the interleaving decides whether
 *      dedupe can key on ids or must fall back to prefix comparison.
 *   3. 雷 B (tool stub shadowing) — under partials, does `content_block_start`
 *      carry a tool_use block with an EMPTY `{}` input stub, with the real input
 *      arriving as `input_json_delta.partial_json` fragments (and again whole in
 *      the buffered message)? That is what would make the dead
 *      eventNormalizer.ts:892 branch fire `tool.started` with an empty input and
 *      let `seenTools` first-writer-wins (`:444`) shadow the real one forever.
 *
 * Plus two volume/telemetry questions the status-line work depends on:
 *   4. Does `message_delta` carry cumulative `usage.output_tokens` through CCH
 *      (the source for the official `↓ N tokens` counter)?
 *   5. Do `system/thinking_tokens` events arrive, and how often? (c16 saw 8–9
 *      per turn with `display:'summarized'`; this re-measures both scenarios.)
 *
 * Scenarios (one turn each — the prompt forces exactly one tool call plus a
 * short text answer, so both mines are exercised in a single cheap turn):
 *   A control    production options verbatim (NO includePartialMessages)
 *   B partial    same + includePartialMessages: true
 *
 * Verdict line (machine-checkable, printed last as JSON):
 *   partialsHonored              B has stream_events, A has none
 *   wholeMessageAdditive         B still delivers whole `assistant` messages
 *   wholeEventsAreBlockScoped    one whole event per CONTENT BLOCK, not per message
 *   wholeDirectlyBeforeBlockStop each whole event sits immediately before its
 *                                own content_block_stop
 *   partialTextMatchesWhole      deltas reconstruct the whole text byte-for-byte
 *   toolInputStubbed             content_block_start tool_use input is `{}` and
 *                                the real input arrives via partial_json
 *   messageDeltaUsage            message_delta carries numeric output_tokens
 *   thinkingTokens*              system/thinking_tokens count per arm
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/partial-messages-probe.ts
 *
 * Optional:
 *   AICLIENT_PARTIAL_TIMEOUT_MS=180000
 *   AICLIENT_PARTIAL_WORKDIR=<path>
 *   AICLIENT_PARTIAL_MODEL=<model id>        # default: the model c16/t34 proved
 *   AICLIENT_PARTIAL_FALLBACK_MODEL=<id>     # retried once when a scenario errors
 *   AICLIENT_PARTIAL_DUMP_DIR=<dir>          # raw per-scenario JSONL dumps
 *   AICLIENT_PARTIAL_SCENARIOS=A,B           # subset to run (default both)
 *   AICLIENT_SMOKE_USE_LOCAL_SETTINGS=1
 *
 * Model note: the gateway default path returns a deterministic 400 for
 * `thinking:{type:'adaptive',display:'summarized'}` (open-q #5), so the probe
 * pins the model c16/t34 ran clean on and falls back once on error instead of
 * bailing.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { CLAUDE_AGENT_SDK_PIN_VERSION, COMETIX_PIN } from '../pin.ts';
import { TEST_AUTH_TOKEN, TEST_BASE_URL, testCredentialEnv } from './testCredentials.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(hostRoot, '..', '..');
const require = createRequire(import.meta.url);

const CWD = process.env.AICLIENT_PARTIAL_WORKDIR ?? repoRoot;
const TIMEOUT_MS = Number(process.env.AICLIENT_PARTIAL_TIMEOUT_MS ?? 180_000);
const MODEL = process.env.AICLIENT_PARTIAL_MODEL ?? 'claude-opus-4-8';
const FALLBACK_MODEL = process.env.AICLIENT_PARTIAL_FALLBACK_MODEL ?? 'claude-opus-4-8[1m]';
const DUMP_DIR = process.env.AICLIENT_PARTIAL_DUMP_DIR ?? path.join(tmpdir(), 'partial-probe');
const SCENARIOS = (process.env.AICLIENT_PARTIAL_SCENARIOS ?? 'A,B')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/** Trace caps — a partial turn is hundreds of events; keep the JSON readable. */
const RAW_TRACE_MAX = 1200;

/**
 * One tool call + one short text answer. The echo payload is deliberately long
 * enough that a single `partial_json` fragment cannot carry it, which is what
 * makes the 雷 B question answerable; `echo` is on the CLI's safe-command
 * allowlist so the turn does not depend on the permission bridge.
 */
const DEFAULT_PROMPT =
  'Do exactly two things, in this order. (1) Call the Bash tool exactly once with this command: ' +
  'echo "partial-probe alpha bravo charlie delta echo foxtrot golf hotel india juliett". ' +
  '(2) Then answer in one short sentence what that command printed. ' +
  'Use no other tools and keep the final answer under 25 words.';

const PROBE_PROMPT = process.env.AICLIENT_PARTIAL_PROMPT ?? DEFAULT_PROMPT;

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

/** One content block as reconstructed from the partial stream. */
interface StreamBlock {
  index: number;
  type: string;
  id?: string;
  name?: string;
  /** Raw `input` on the content_block_start stub — the 雷 B question. */
  startInput?: unknown;
  startInputIsEmptyObject: boolean;
  /** Concatenated text_delta / thinking_delta payload. */
  text: string;
  textFragments: number;
  /** Concatenated input_json_delta.partial_json payload. */
  partialJson: string;
  partialJsonFragments: number;
  startSeq: number;
  startMs: number;
  stopSeq?: number;
}

/** One `message_start … message_stop` envelope seen on the partial stream. */
interface StreamMessage {
  startSeq: number;
  messageId?: string;
  model?: string;
  blocks: StreamBlock[];
  deltas: Array<{ seq: number; stopReason?: string | null; usage?: Record<string, unknown> }>;
  stopSeq?: number;
}

/**
 * One buffered whole `assistant` SDK message. NOTE: the SDK splits a single API
 * message into ONE `assistant` event per content block (same `message.id`), in
 * both arms — `blockTypes` is what makes that visible.
 */
interface WholeAssistant {
  seq: number;
  tMs: number;
  messageId?: string;
  blockTypes: string[];
  text: string;
  thinkingLen: number;
  toolUses: Array<{ id?: string; name?: string; input: unknown }>;
}

interface TurnResult {
  label: string;
  model: string;
  includePartialMessages: boolean;
  ok: boolean;
  threw: boolean;
  errorMessage?: string;
  isErrorResult: boolean;
  apiErrorStatus?: number | null;
  resultErrors: string[];
  apiRetryErrors: Array<{ error: string; error_status: number | string | null }>;
  stderrLines: string[];
  eventCount: number;
  byTag: Record<string, number>;
  /** Fine-grained ordered trace, consecutive identical tags collapsed as `xN`. */
  collapsedTrace: string[];
  /** Arrival time of every event, ms since queryFn() returned. */
  timeline: Array<{ seq: number; tMs: number; tag: string }>;
  streamEventCount: number;
  contentBlockDeltaCount: number;
  streamMessages: StreamMessage[];
  wholeAssistants: WholeAssistant[];
  thinkingTokens: Array<{ seq: number; estimated: number; delta: number }>;
  resultUsage?: Record<string, unknown>;
  outputTokens?: number;
  msTotal: number;
  dumpFile?: string;
}

function newTurnResult(label: string, model: string, partial: boolean): TurnResult {
  return {
    label,
    model,
    includePartialMessages: partial,
    ok: false,
    threw: false,
    isErrorResult: false,
    resultErrors: [],
    apiRetryErrors: [],
    stderrLines: [],
    eventCount: 0,
    byTag: {},
    collapsedTrace: [],
    timeline: [],
    streamEventCount: 0,
    contentBlockDeltaCount: 0,
    streamMessages: [],
    wholeAssistants: [],
    thinkingTokens: [],
    msTotal: 0,
  };
}

function extractTextParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; text?: unknown };
    if (p.type === 'text' && typeof p.text === 'string') chunks.push(p.text);
  }
  return chunks.join('');
}

function extractThinkingLen(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let len = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; thinking?: unknown };
    if (p.type === 'thinking' && typeof p.thinking === 'string') len += p.thinking.length;
  }
  return len;
}

function extractBlockTypes(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p): p is { type?: string } => Boolean(p) && typeof p === 'object')
    .map((p) => String(p.type ?? '?'));
}

function extractToolUses(content: unknown): Array<{ id?: string; name?: string; input: unknown }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id?: string; name?: string; input: unknown }> = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; id?: string; name?: string; input?: unknown };
    if (p.type === 'tool_use') out.push({ id: p.id, name: p.name, input: p.input });
  }
  return out;
}

function isEmptyObject(v: unknown): boolean {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v!).length === 0;
}

/** `['a','a','b']` → `['a x2','b']` so a 300-token trace stays legible. */
function collapseRuns(tags: string[]): string[] {
  const out: string[] = [];
  let last: string | null = null;
  let run = 0;
  const flush = () => {
    if (last === null) return;
    out.push(run > 1 ? `${last} x${run}` : last);
  };
  for (const tag of tags) {
    if (tag === last) {
      run += 1;
      continue;
    }
    flush();
    last = tag;
    run = 1;
  }
  flush();
  return out;
}

async function runTurn(opts: {
  queryFn: QueryFn;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  label: string;
  model: string;
  includePartialMessages: boolean;
}): Promise<TurnResult> {
  const started = performance.now();
  const r = newTurnResult(opts.label, opts.model, opts.includePartialMessages);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const rawLines: string[] = [];
  const rawTrace: string[] = [];

  const canUseTool = async (
    _toolName: string,
    input: Record<string, unknown>
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }> => ({
    behavior: 'allow',
    updatedInput: input,
  });

  // Mirror claudeRuntime.ts's production option set exactly except the field
  // under test, so a result here transfers to production.
  const options: Record<string, unknown> = {
    cwd: CWD,
    pathToClaudeCodeExecutable: opts.cliPath,
    executable: process.execPath,
    tools: { type: 'preset', preset: 'claude_code' },
    settingSources: [],
    thinking: { type: 'adaptive', display: 'summarized' },
    permissionMode: 'default',
    canUseTool,
    env: opts.env,
    abortController: abort,
    stderr: (line: string) => {
      if (r.stderrLines.length < 20) r.stderrLines.push(line.slice(0, 300));
    },
    ...(opts.includePartialMessages ? { includePartialMessages: true } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  };

  let current: StreamMessage | null = null;

  let stream: (AsyncIterable<unknown> & { close?: () => void }) | null = null;
  try {
    stream = opts.queryFn({ prompt: PROBE_PROMPT, options });
    for await (const event of stream) {
      if (abort.signal.aborted) break;
      r.eventCount += 1;
      const seq = r.eventCount;
      const tMs = Math.round(performance.now() - started);
      if (rawLines.length < RAW_TRACE_MAX) rawLines.push(JSON.stringify(event));
      const e = event as {
        type?: string;
        subtype?: string;
        estimated_tokens?: number;
        estimated_tokens_delta?: number;
        message?: { id?: string; content?: unknown; model?: string; usage?: unknown };
        event?: Record<string, unknown>;
        error?: string;
        error_status?: number | string | null;
        is_error?: boolean;
        api_error_status?: number | null;
        errors?: string[];
        usage?: Record<string, unknown>;
      };
      const type = String(e.type ?? typeof event);
      let tag = e.subtype ? `${type}/${e.subtype}` : type;

      if (type === 'system' && e.subtype === 'thinking_tokens') {
        r.thinkingTokens.push({
          seq,
          estimated: Number(e.estimated_tokens ?? 0),
          delta: Number(e.estimated_tokens_delta ?? 0),
        });
      }

      if (type === 'system' && e.subtype === 'api_retry') {
        r.apiRetryErrors.push({
          error: String(e.error ?? ''),
          error_status: e.error_status ?? null,
        });
      }

      if (type === 'stream_event' && e.event) {
        r.streamEventCount += 1;
        const ev = e.event as {
          type?: string;
          index?: number;
          message?: { id?: string; model?: string };
          content_block?: { type?: string; id?: string; name?: string; input?: unknown };
          delta?: {
            type?: string;
            text?: string;
            thinking?: string;
            partial_json?: string;
            stop_reason?: string | null;
          };
          usage?: Record<string, unknown>;
        };
        const evType = String(ev.type ?? '');
        switch (evType) {
          case 'message_start': {
            current = {
              startSeq: seq,
              messageId: ev.message?.id,
              model: ev.message?.model,
              blocks: [],
              deltas: [],
            };
            r.streamMessages.push(current);
            tag = 'stream_event/message_start';
            break;
          }
          case 'content_block_start': {
            const block = ev.content_block ?? {};
            const entry: StreamBlock = {
              index: Number(ev.index ?? -1),
              type: String(block.type ?? ''),
              id: block.id,
              name: block.name,
              startInput: block.input,
              startInputIsEmptyObject: isEmptyObject(block.input),
              text: '',
              textFragments: 0,
              partialJson: '',
              partialJsonFragments: 0,
              startSeq: seq,
              startMs: tMs,
            };
            current?.blocks.push(entry);
            tag = `stream_event/content_block_start[${entry.index}:${entry.type}${
              entry.name ? `:${entry.name}` : ''
            }]`;
            break;
          }
          case 'content_block_delta': {
            r.contentBlockDeltaCount += 1;
            const idx = Number(ev.index ?? -1);
            const block = current?.blocks.find((b) => b.index === idx);
            const deltaType = String(ev.delta?.type ?? '');
            if (block) {
              if (deltaType === 'text_delta' || deltaType === 'thinking_delta') {
                block.text += ev.delta?.text ?? ev.delta?.thinking ?? '';
                block.textFragments += 1;
              } else if (deltaType === 'input_json_delta') {
                block.partialJson += ev.delta?.partial_json ?? '';
                block.partialJsonFragments += 1;
              }
            }
            tag = `stream_event/content_block_delta[${idx}:${deltaType}]`;
            break;
          }
          case 'content_block_stop': {
            const idx = Number(ev.index ?? -1);
            const block = current?.blocks.find((b) => b.index === idx);
            if (block) block.stopSeq = seq;
            tag = `stream_event/content_block_stop[${idx}]`;
            break;
          }
          case 'message_delta': {
            current?.deltas.push({
              seq,
              stopReason: ev.delta?.stop_reason ?? null,
              usage: ev.usage,
            });
            const outTokens = ev.usage?.output_tokens;
            tag = `stream_event/message_delta{output_tokens=${
              typeof outTokens === 'number' ? outTokens : 'absent'
            }}`;
            break;
          }
          case 'message_stop': {
            if (current) current.stopSeq = seq;
            tag = 'stream_event/message_stop';
            break;
          }
          default:
            tag = `stream_event/${evType}`;
        }
      }

      if (type === 'assistant') {
        const content = e.message?.content;
        const toolUses = extractToolUses(content);
        const text = extractTextParts(content);
        const thinkingLen = extractThinkingLen(content);
        r.wholeAssistants.push({
          seq,
          tMs,
          messageId: e.message?.id,
          blockTypes: extractBlockTypes(content),
          text,
          thinkingLen,
          toolUses,
        });
        const parts: string[] = [];
        if (text) parts.push(`text:${text.length}`);
        if (thinkingLen) parts.push(`thinking:${thinkingLen}`);
        for (const t of toolUses) parts.push(`tool_use:${t.name ?? '?'}`);
        tag = `assistant{${parts.join(',') || 'empty'}}`;
      }

      if (type === 'result') {
        r.isErrorResult = Boolean(e.is_error);
        r.apiErrorStatus = e.api_error_status ?? null;
        if (Array.isArray(e.errors)) r.resultErrors = e.errors;
        if (e.usage) {
          r.resultUsage = e.usage;
          const out = e.usage.output_tokens;
          if (typeof out === 'number') r.outputTokens = out;
        }
      }

      r.byTag[tag] = (r.byTag[tag] ?? 0) + 1;
      if (rawTrace.length < RAW_TRACE_MAX) rawTrace.push(tag);
      if (r.timeline.length < RAW_TRACE_MAX) r.timeline.push({ seq, tMs, tag });
    }
    const answered = r.wholeAssistants.some((m) => m.text.length > 0);
    r.ok = !r.isErrorResult && !r.threw && answered;
  } catch (err) {
    r.threw = true;
    r.errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    r.msTotal = Math.round(performance.now() - started);
    try {
      stream?.close?.();
    } catch {
      // ignore
    }
  }

  r.collapsedTrace = collapseRuns(rawTrace);
  try {
    await mkdir(DUMP_DIR, { recursive: true });
    const file = path.join(DUMP_DIR, `${opts.label}.jsonl`);
    await writeFile(file, `${rawLines.join('\n')}\n`);
    await writeFile(
      path.join(DUMP_DIR, `${opts.label}.timeline.jsonl`),
      `${r.timeline.map((t) => JSON.stringify(t)).join('\n')}\n`
    );
    r.dumpFile = file;
  } catch (err) {
    console.error(`[partial] dump write failed for ${opts.label}:`, err);
  }
  return r;
}

/**
 * Busiest one-second window in the turn — the number that decides whether the
 * per-event IPC hop needs Host-side coalescing (triage §4 open item).
 */
function peakEventsPerSecond(timeline: Array<{ tMs: number }>): number {
  let peak = 0;
  let head = 0;
  for (let i = 0; i < timeline.length; i += 1) {
    while (timeline[head].tMs <= timeline[i].tMs - 1000) head += 1;
    peak = Math.max(peak, i - head + 1);
  }
  return peak;
}

/**
 * Fold one API message's two views together: the partial stream envelope and
 * the whole `assistant` events that share its `message.id`.
 *
 * Both views are per-BLOCK, not per-message — one `assistant` event carries one
 * content block — so the comparison has to aggregate the whole side by id
 * before it means anything, and a tool's real input has to be looked up across
 * every whole event of the turn (the event carrying the text block does not
 * carry the tool_use block).
 */
function analyzeMessages(r: TurnResult): Array<Record<string, unknown>> {
  const groups = new Map<string, WholeAssistant[]>();
  for (const w of r.wholeAssistants) {
    const key = w.messageId ?? `anon-${w.seq}`;
    const list = groups.get(key) ?? [];
    list.push(w);
    groups.set(key, list);
  }
  const allWholeTools = r.wholeAssistants.flatMap((w) => w.toolUses);
  const blockStopSeqs = r.streamMessages.flatMap((m) =>
    m.blocks.map((b) => b.stopSeq).filter((s): s is number => typeof s === 'number')
  );

  const out: Array<Record<string, unknown>> = [];
  for (const [messageId, wholes] of groups) {
    const streamMsg = r.streamMessages.find((m) => m.messageId === messageId);
    const textBlocks = streamMsg?.blocks.filter((b) => b.type === 'text') ?? [];
    const partialText = textBlocks.map((b) => b.text).join('');
    const wholeText = wholes.map((w) => w.text).join('');
    const tools = (streamMsg?.blocks.filter((b) => b.type === 'tool_use') ?? []).map((b) => {
      const wholeTool = allWholeTools.find((t) => t.id && t.id === b.id);
      let parsed: unknown;
      let parseOk = false;
      try {
        parsed = b.partialJson ? JSON.parse(b.partialJson) : undefined;
        parseOk = true;
      } catch {
        parseOk = false;
      }
      return {
        id: b.id,
        name: b.name,
        /** 雷 B pivot ①: what `content_block_start` offers as `input`. */
        startInput: b.startInput,
        startInputIsEmptyObject: b.startInputIsEmptyObject,
        partialJsonFragments: b.partialJsonFragments,
        partialJsonLen: b.partialJson.length,
        partialJsonParseOk: parseOk,
        /** 雷 B pivot ②: the real input, on the buffered message. */
        wholeInput: wholeTool?.input,
        wholeInputSeen: Boolean(wholeTool),
        partialJsonEqualsWholeInput:
          parseOk &&
          Boolean(wholeTool) &&
          JSON.stringify(parsed) === JSON.stringify(wholeTool?.input),
        toolBlockStartSeq: b.startSeq,
        toolBlockStopSeq: b.stopSeq ?? null,
        /**
         * How much earlier the empty-stub `content_block_start` fires than the
         * buffered message that carries the real input — i.e. exactly what a
         * stub-driven `tool.started` would buy in perceived latency.
         */
        stubToWholeMs: (() => {
          const owner = r.wholeAssistants.find((w) => w.toolUses.some((t) => t.id === b.id));
          return owner ? owner.tMs - b.startMs : null;
        })(),
      };
    });
    out.push({
      messageId,
      /** 雷 A pivot: the same content delivered twice, and in which order. */
      wholeEvents: wholes.map((w) => ({
        seq: w.seq,
        blockTypes: w.blockTypes,
        textLen: w.text.length,
        thinkingLen: w.thinkingLen,
        toolIds: w.toolUses.map((t) => t.id),
      })),
      wholeTextLen: wholeText.length,
      partialTextLen: partialText.length,
      partialTextFragments: textBlocks.reduce((n, b) => n + b.textFragments, 0),
      textIdentical: partialText === wholeText,
      /** Every whole event carries exactly one block → per-block delivery. */
      wholeEventsAreBlockScoped: wholes.every((w) => w.blockTypes.length === 1),
      /** Whole event lands in the gap between last delta and content_block_stop. */
      wholeToNextBlockStopGap: wholes.map((w) => {
        const next = blockStopSeqs.filter((s) => s > w.seq).sort((a, b) => a - b)[0];
        return next === undefined ? null : next - w.seq;
      }),
      blocks:
        streamMsg?.blocks.map((b) => ({
          index: b.index,
          type: b.type,
          startSeq: b.startSeq,
          stopSeq: b.stopSeq ?? null,
          textLen: b.text.length,
          textFragments: b.textFragments,
          partialJsonFragments: b.partialJsonFragments,
        })) ?? [],
      messageDeltaCount: streamMsg?.deltas.length ?? 0,
      messageDeltaSeqs: streamMsg?.deltas.map((d) => d.seq) ?? [],
      messageDeltaOutputTokens: streamMsg?.deltas.map((d) => d.usage?.output_tokens) ?? [],
      messageStopSeq: streamMsg?.stopSeq ?? null,
      tools,
    });
  }
  return out;
}

function summarize(r: TurnResult): Record<string, unknown> {
  const cumulativeOutputTokens = r.streamMessages.flatMap((m) =>
    m.deltas.map((d) => d.usage?.output_tokens).filter((v) => typeof v === 'number')
  );
  return {
    label: r.label,
    model: r.model,
    includePartialMessages: r.includePartialMessages,
    ok: r.ok,
    threw: r.threw,
    errorMessage: r.errorMessage,
    isErrorResult: r.isErrorResult,
    apiErrorStatus: r.apiErrorStatus,
    resultErrors: r.resultErrors,
    apiRetryErrors: r.apiRetryErrors,
    stderrLines: r.stderrLines,
    msTotal: r.msTotal,
    eventCount: r.eventCount,
    streamEventCount: r.streamEventCount,
    contentBlockDeltaCount: r.contentBlockDeltaCount,
    wholeAssistantCount: r.wholeAssistants.length,
    thinkingTokensCount: r.thinkingTokens.length,
    thinkingTokensSamples: r.thinkingTokens.slice(0, 12),
    messageDeltaUsageOutputTokens: cumulativeOutputTokens,
    messageDeltaUsageSample: r.streamMessages.flatMap((m) => m.deltas.map((d) => d.usage))[0],
    resultUsage: r.resultUsage,
    outputTokens: r.outputTokens,
    eventsPer1kOutputTokens:
      r.outputTokens && r.outputTokens > 0
        ? Math.round((r.eventCount / r.outputTokens) * 1000)
        : null,
    peakEventsPerSecond: r.timeline.length > 0 ? peakEventsPerSecond(r.timeline) : 0,
    avgEventsPerSecond:
      r.msTotal > 0 ? Math.round((r.eventCount / r.msTotal) * 1000 * 10) / 10 : null,
    byTag: r.byTag,
    collapsedTrace: r.collapsedTrace,
    messages: analyzeMessages(r),
    dumpFile: r.dumpFile,
  };
}

async function runScenario(base: {
  queryFn: QueryFn;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  label: string;
  includePartialMessages: boolean;
}): Promise<{ primary: TurnResult; fallback?: TurnResult }> {
  const primary = await runTurn({ ...base, model: MODEL });
  console.error(
    `[partial] ${base.label} ok=${primary.ok} events=${primary.eventCount} stream=${primary.streamEventCount} ms=${primary.msTotal}`
  );
  if (primary.ok || !FALLBACK_MODEL || FALLBACK_MODEL === MODEL) return { primary };
  // Gateway quirk (open-q #5): a model can hard-400 on the thinking config —
  // record the failure verbatim and retry once on the fallback model.
  console.error(
    `[partial] ${base.label} failed on ${MODEL} — retrying on fallback ${FALLBACK_MODEL}`
  );
  const fallback = await runTurn({
    ...base,
    label: `${base.label}-fallback`,
    model: FALLBACK_MODEL,
  });
  console.error(
    `[partial] ${base.label}-fallback ok=${fallback.ok} events=${fallback.eventCount} stream=${fallback.streamEventCount}`
  );
  return { primary, fallback };
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
    CLAUDE_AGENT_SDK_CLIENT_APP: 'aiclient-partial-messages-probe/0.0.1',
  };

  console.error(`[partial] node=${process.version}`);
  console.error(`[partial] cometix=${COMETIX_PIN.version} sdk=${CLAUDE_AGENT_SDK_PIN_VERSION}`);
  console.error(`[partial] cliPath=${cliPath}`);
  console.error(`[partial] cwd=${CWD} dumpDir=${DUMP_DIR}`);
  console.error(`[partial] baseUrl=${TEST_BASE_URL} model=${MODEL} fallback=${FALLBACK_MODEL}`);
  console.error(`[partial] scenarios=${SCENARIOS.join(',')} timeoutMs=${TIMEOUT_MS}`);

  const base = { queryFn, cliPath, env };
  const runs: Record<string, Record<string, unknown>> = {};
  let control: TurnResult | undefined;
  let partial: TurnResult | undefined;

  if (SCENARIOS.includes('A')) {
    console.error('[partial] A: control — production options, no includePartialMessages…');
    const a = await runScenario({ ...base, label: 'A-control', includePartialMessages: false });
    control = a.fallback?.ok ? a.fallback : a.primary;
    runs.A_control = summarize(a.primary);
    if (a.fallback) runs.A_control_fallback = summarize(a.fallback);
  }
  if (SCENARIOS.includes('B')) {
    console.error('[partial] B: treatment — includePartialMessages: true…');
    const b = await runScenario({ ...base, label: 'B-partial', includePartialMessages: true });
    partial = b.fallback?.ok ? b.fallback : b.primary;
    runs.B_partial = summarize(b.primary);
    if (b.fallback) runs.B_partial_fallback = summarize(b.fallback);
  }

  const partialMessages = partial ? analyzeMessages(partial) : [];
  const toolViews = partialMessages.flatMap(
    (p) => (p.tools as Array<Record<string, unknown>>) ?? []
  );
  const verdict = {
    /** Q1: the option is honoured — partials arrive only in the treatment arm. */
    partialsHonored: Boolean(
      partial?.ok &&
        partial.streamEventCount > 0 &&
        (control ? control.streamEventCount === 0 : true)
    ),
    /** Q2 (雷 A): whole assistant messages still arrive, carrying the same text. */
    wholeMessageAdditive: Boolean(
      partial?.ok && partial.wholeAssistants.some((m) => m.text.length > 0)
    ),
    /** Q2b: one whole `assistant` event per content block, not one per message. */
    wholeEventsAreBlockScoped: partialMessages.every((p) => p.wholeEventsAreBlockScoped === true),
    /** Q2c: each whole event lands DIRECTLY before its block's content_block_stop. */
    wholeDirectlyBeforeBlockStop: partialMessages.every((p) =>
      (p.wholeToNextBlockStopGap as Array<number | null>).every((gap) => gap === 1)
    ),
    /** Q2d: the partial deltas reconstruct the whole text byte-for-byte. */
    partialTextMatchesWhole: partialMessages
      .filter((p) => (p.wholeTextLen as number) > 0)
      .every((p) => p.textIdentical === true),
    /** Q3 (雷 B): empty `{}` stub on start + real input via partial_json. */
    toolInputStubbed: toolViews.length > 0 && toolViews.every((t) => t.startInputIsEmptyObject),
    toolInputArrivesAsPartialJson:
      toolViews.length > 0 &&
      toolViews.every(
        (t) => (t.partialJsonFragments as number) > 0 && t.partialJsonEqualsWholeInput === true
      ),
    /** Q4: output_tokens on message_delta — and how many deltas per message. */
    messageDeltaUsage: Boolean(
      partial?.streamMessages.some((m) =>
        m.deltas.some((d) => typeof d.usage?.output_tokens === 'number')
      )
    ),
    messageDeltaCountPerMessage: partialMessages.map((p) => p.messageDeltaCount),
    /** Q5: thinking_tokens frequency per arm. */
    thinkingTokensControl: control?.thinkingTokens.length ?? null,
    thinkingTokensPartial: partial?.thinkingTokens.length ?? null,
    thinkingBlocksControl: control?.wholeAssistants.filter((w) => w.thinkingLen > 0).length ?? null,
    thinkingBlocksPartial: partial?.wholeAssistants.filter((w) => w.thinkingLen > 0).length ?? null,
  };

  const out = {
    probe: 'partial-messages',
    baseUrl: TEST_BASE_URL,
    cometixVersion: COMETIX_PIN.version,
    sdkVersion: CLAUDE_AGENT_SDK_PIN_VERSION,
    modelRequested: MODEL,
    fallbackModel: FALLBACK_MODEL,
    dumpDir: DUMP_DIR,
    verdict,
    volume: {
      controlEvents: control?.eventCount ?? null,
      partialEvents: partial?.eventCount ?? null,
      controlOutputTokens: control?.outputTokens ?? null,
      partialOutputTokens: partial?.outputTokens ?? null,
      partialContentBlockDeltas: partial?.contentBlockDeltaCount ?? null,
      partialThinkingDeltaFragments: partial
        ? partial.streamMessages
            .flatMap((m) => m.blocks)
            .filter((b) => b.type === 'thinking')
            .reduce((n, b) => n + b.textFragments, 0)
        : null,
      partialEventsPer1kOutputTokens:
        partial?.outputTokens && partial.outputTokens > 0
          ? Math.round((partial.eventCount / partial.outputTokens) * 1000)
          : null,
      partialPeakEventsPerSecond: partial ? peakEventsPerSecond(partial.timeline) : null,
      controlPeakEventsPerSecond: control ? peakEventsPerSecond(control.timeline) : null,
    },
    runs,
  };
  console.log(JSON.stringify(out, null, 2));

  // Exit 0 only when both arms produced a usable answer — the verdicts above
  // are findings, not pass/fail gates.
  process.exitCode = (control ? control.ok : true) && (partial ? partial.ok : true) ? 0 : 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
