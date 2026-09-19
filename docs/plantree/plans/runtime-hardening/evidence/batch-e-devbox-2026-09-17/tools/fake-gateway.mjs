#!/usr/bin/env node

/**
 * fake-gateway.mjs — local fake Anthropic-Messages-style AI gateway for GUI point-checks.
 *
 * Mimics just enough of the Anthropic Messages streaming API (`api: anthropic-messages`
 * in ai-client's UserProvider config) to drive manual/CDP point-checks against a fake
 * custom AI service, without needing real credentials or a real model.
 *
 * SSE frame shapes are copied from scripts/run-f4-retry-probe.mjs:42-129 (successBody() /
 * startGateway() / the 503 error envelope), extended here with a tool_use frame sequence.
 *
 * Usage:
 *   node fake-gateway.mjs --port <port> --plan <plan> [--sleep <seconds>] [--state <path>] [--reset] [--model-id <id>]
 *
 * Options:
 *   --port <n>       Required. TCP port to listen on (127.0.0.1 only).
 *   --plan <name>    Required. One of: text | long-turn | retry-503 | retry-503-forever |
 *                    write-approval | archive-probe | ask-question | slow-write |
 *                    long-thinking | slow-fail
 *   --sleep <n>      Seconds used in the long-turn plan's `sleep <n> && echo done` bash
 *                    command, and in the archive-probe plan's 1st-request bash command.
 *                    Default: 90 (long-turn) — archive-probe callers should pass their own
 *                    value; see below.
 *   --state <path>   JSON file used to persist the request counter across restarts.
 *                    Default: /tmp/t032/fake-gateway.state.json
 *   --reset          Zero the request counter before starting (ignores any existing state file).
 *   --model-id <id>  Optional. Echoed back verbatim as `message.model` in every
 *                    `message_start` frame, regardless of what the caller's request body
 *                    sent as `model`. Lets a point-check log line up the fake gateway's
 *                    replies with a specific model name. Default: fake-sonnet.
 *   --chunks <n>     Only for the paced plans (slow-write / long-thinking). How many delta
 *                    frames the long field is cut into. Defaults: 40 (slow-write), 200
 *                    (long-thinking).
 *   --chunk-ms <n>   Only for the paced plans. Milliseconds between two delta frames.
 *                    Defaults: 300 (slow-write), 200 (long-thinking).
 *   --hold <n>       Only for slow-fail. Seconds to hold the connection open after the 200
 *                    response headers with zero body bytes. Default: 120.
 *   --write-path <p> Only for slow-write. The `path` argument of the streamed write call,
 *                    relative to the session cwd. Default: demo/out.html.
 *   --write-lines <n> Only for slow-write. How many lines the streamed file body spans.
 *                    Default: 60.
 *
 * Endpoints:
 *   POST *          Treated as POST /v1/messages regardless of actual path (path is ignored).
 *                   Body is expected to be an Anthropic Messages request:
 *                   { model, messages: [{ role, content }], ... }
 *   GET  /health    Returns { ok: true, plan, count } as JSON — count is the number of
 *                   POST requests served so far (persisted via --state).
 *
 * Plans:
 *   text               Always replies with a plain text block "fake gateway ok"
 *                       (stop_reason: end_turn).
 *   long-turn          1st request replies a tool_use block: name="bash",
 *                       input={"command":"sleep <N> && echo done"}. Any request whose body
 *                       contains a tool_result content block replies plain text
 *                       "turn finished" (stop_reason: end_turn).
 *   write-approval     1st request replies a tool_use block: name="write",
 *                       input={"path":"probe-write.txt","content":"hello from fake gateway"}
 *                       (path is relative to whatever cwd the caller resolves it against).
 *                       Any request with a tool_result replies plain text "turn finished".
 *   ask-question       (added by batch E1 for checklist item 25 / F7c) 1st request replies a
 *                       tool_use block: name="ask" with the exact input shape the runtime's
 *                       ask tool declares (src/runtime/plugins/tools/ask.ts ASK_PARAMETERS:
 *                       { questions: [{ question, header?, options: [{label, description?}] }] },
 *                       2-4 options per question). Any request with a tool_result replies
 *                       plain text "turn finished".
 *   retry-503          1st and 2nd requests reply HTTP 503 with an Anthropic-style error
 *                       envelope ({type:'error', error:{type:'overloaded_error', message}});
 *                       3rd+ requests succeed with plain text "fake gateway ok".
 *   retry-503-forever  Every request replies HTTP 503, with the error message containing the
 *                       literal marker FAKE_GATEWAY_OVERLOADED_MARKER so a log grep can tell
 *                       "gateway responded 503" apart from "no gateway reached".
 *   slow-write         (added by batch I point-check for T101) PACED plan — the frames go out
 *                       one at a time with real wall-clock gaps instead of in a single
 *                       `res.end()`, because T101 is about what the timeline shows WHILE a
 *                       tool call's arguments are still arriving.
 *                       1st request: a short text block ("下面开始编写文件：") is streamed and
 *                       closed, then a `tool_use` block (name="write") is opened and its
 *                       `{"path":…,"content":…}` JSON is dictated over --chunks
 *                       `input_json_delta` frames spaced --chunk-ms apart, then
 *                       `content_block_stop` + `message_delta` (stop_reason: tool_use).
 *                       `path` lands inside the FIRST chunk on purpose: the projector reads
 *                       pi's partial-JSON parse of the block, so a row can name its file
 *                       before a byte of the body exists.
 *                       Any request with a tool_result replies plain text "写入完成".
 *   long-thinking      (added by batch I point-check for T096 / T098) PACED plan.
 *                       1st request: a `thinking` block dictated over --chunks
 *                       `thinking_delta` frames spaced --chunk-ms apart (default 200 × 200ms
 *                       ≈ 40 s), with many newlines so the block overflows the viewport,
 *                       then a `signature_delta`, `content_block_stop`, and finally a short
 *                       text block + `message_delta` (stop_reason: end_turn).
 *                       Every later request repeats the same turn, so a second send in the
 *                       same session streams a second thought.
 *   slow-fail          (added by batch I point-check for T093) Writes the 200 response
 *                       headers immediately and then sends ZERO body bytes for --hold
 *                       seconds (default 120) before closing. This is the shape decision 029
 *                       exists for: the connection is accepted, so a headers timeout never
 *                       fires, and only the idle/body timeout can cut it.
 *   archive-probe      Driven purely by request sequence number (not by whether the request
 *                       body contains a tool_result — that's still recorded in the log, just
 *                       not used to pick the response), so the turn sequence is deterministic
 *                       even if a caller's harness doesn't round-trip tool_result blocks:
 *                         1st request: tool_use name="bash",
 *                           input={"command":"sleep <N> && echo slept"} (N via --sleep,
 *                           default 45).
 *                         2nd request: tool_use name="write",
 *                           input={"path":"archive-probe.txt","content":"written after archive"}
 *                           (relative path, written under the caller's session cwd).
 *                         3rd request: tool_use name="read",
 *                           input={"path":"archive-probe.txt"}.
 *                         4th request: tool_use name="bash",
 *                           input={"command":"pwd && ls -la"}.
 *                         5th+ requests: plain text "archive probe finished"
 *                           (stop_reason: end_turn).
 *
 * Every request (health checks excluded) appends one JSON line to /tmp/t032/fake-gateway.log
 * with: ISO timestamp, sequence number, HTTP status returned, the role of the last message in
 * the request body, a <=200 char snippet of that message's content, and whether the body
 * contained a tool_result content block.
 *
 * Examples:
 *   node fake-gateway.mjs --port 18080 --plan text
 *   node fake-gateway.mjs --port 18080 --plan long-turn --sleep 30
 *   node fake-gateway.mjs --port 18080 --plan retry-503 --reset
 *   node fake-gateway.mjs --port 18080 --plan retry-503-forever
 *   node fake-gateway.mjs --port 18080 --plan write-approval
 *   node fake-gateway.mjs --port 18080 --plan archive-probe --sleep 45
 *   node fake-gateway.mjs --port 18080 --plan text --model-id claude-sonnet-5
 *   node fake-gateway.mjs --port 18080 --plan slow-write --chunks 40 --chunk-ms 300
 *   node fake-gateway.mjs --port 18080 --plan long-thinking --chunks 200 --chunk-ms 200
 *   node fake-gateway.mjs --port 18080 --plan slow-fail --hold 120
 *   curl -s http://127.0.0.1:18080/health
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

const LOG_PATH = '/tmp/t032/fake-gateway.log';
const VALID_PLANS = [
  'text',
  'long-turn',
  'retry-503',
  'retry-503-forever',
  'write-approval',
  'archive-probe',
  'ask-question',
  'slow-write',
  'long-thinking',
  'slow-fail',
];

/** Per-plan pacing defaults, applied only when the caller did not say. */
const PACING_DEFAULTS = {
  'slow-write': { chunks: 40, chunkMs: 300 },
  'long-thinking': { chunks: 200, chunkMs: 200 },
};

function parseArgs(argv) {
  const args = {
    port: null,
    plan: null,
    sleep: 90,
    state: '/tmp/t032/fake-gateway.state.json',
    reset: false,
    modelId: 'fake-sonnet',
    chunks: null,
    chunkMs: null,
    hold: 120,
    writePath: 'demo/out.html',
    writeLines: 60,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--plan') args.plan = argv[++i];
    else if (a === '--sleep') args.sleep = Number(argv[++i]);
    else if (a === '--state') args.state = argv[++i];
    else if (a === '--reset') args.reset = true;
    else if (a === '--model-id') args.modelId = argv[++i];
    else if (a === '--chunks') args.chunks = Number(argv[++i]);
    else if (a === '--chunk-ms') args.chunkMs = Number(argv[++i]);
    else if (a === '--hold') args.hold = Number(argv[++i]);
    else if (a === '--write-path') args.writePath = argv[++i];
    else if (a === '--write-lines') args.writeLines = Number(argv[++i]);
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!args.port || Number.isNaN(args.port)) throw new Error('--port <n> is required');
  if (!args.plan) throw new Error('--plan <name> is required');
  if (!VALID_PLANS.includes(args.plan)) {
    throw new Error(`--plan must be one of: ${VALID_PLANS.join(', ')} (got "${args.plan}")`);
  }
  if (!Number.isFinite(args.sleep) || args.sleep <= 0)
    throw new Error('--sleep must be a positive number');
  if (!args.modelId) throw new Error('--model-id requires a value');
  const pacing = PACING_DEFAULTS[args.plan] ?? { chunks: 40, chunkMs: 300 };
  if (args.chunks === null) args.chunks = pacing.chunks;
  if (args.chunkMs === null) args.chunkMs = pacing.chunkMs;
  if (!Number.isInteger(args.chunks) || args.chunks <= 0)
    throw new Error('--chunks must be a positive integer');
  if (!Number.isFinite(args.chunkMs) || args.chunkMs < 0)
    throw new Error('--chunk-ms must be a non-negative number');
  if (!Number.isFinite(args.hold) || args.hold <= 0)
    throw new Error('--hold must be a positive number');
  if (!Number.isInteger(args.writeLines) || args.writeLines <= 0)
    throw new Error('--write-lines must be a positive integer');
  if (!args.writePath) throw new Error('--write-path requires a value');
  return args;
}

function loadState(statePath, reset) {
  if (!reset) {
    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.count === 'number') return { count: parsed.count };
    } catch {
      // missing/corrupt state file -> start fresh
    }
  }
  return { count: 0 };
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function ensureLogDir() {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
}

function summarizeMessage(msg) {
  if (!msg) return '';
  let text = '';
  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    text = msg.content
      .map((block) => {
        if (!block || typeof block !== 'object') return String(block);
        if (block.type === 'text') return block.text ?? '';
        if (block.type === 'tool_use') return `[tool_use:${block.name}]`;
        if (block.type === 'tool_result') {
          const c = block.content;
          if (typeof c === 'string') return `[tool_result:${c}]`;
          if (Array.isArray(c)) return `[tool_result:${c.map((x) => x?.text ?? '').join(' ')}]`;
          return '[tool_result]';
        }
        return JSON.stringify(block);
      })
      .join(' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function hasToolResult(messages) {
  return messages.some(
    (m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool_result')
  );
}

function logRequest(entry) {
  ensureLogDir();
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

/** Decide what this request's response should look like, given the active plan. */
function decide(plan, seq, toolResultPresent, sleepSeconds, opts = {}) {
  switch (plan) {
    case 'slow-write':
      if (toolResultPresent) return { kind: 'text', status: 200, text: '写入完成' };
      return { kind: 'paced', status: 200, flavour: 'slow-write' };
    case 'long-thinking':
      return { kind: 'paced', status: 200, flavour: 'long-thinking' };
    case 'slow-fail':
      return { kind: 'hang', status: 200, holdMs: Math.round((opts.hold ?? 120) * 1000) };
    case 'text':
      return { kind: 'text', status: 200, text: 'fake gateway ok' };
    case 'long-turn':
      if (toolResultPresent) return { kind: 'text', status: 200, text: 'turn finished' };
      return {
        kind: 'tool_use',
        status: 200,
        name: 'bash',
        input: { command: `sleep ${sleepSeconds} && echo done` },
      };
    case 'write-approval':
      if (toolResultPresent) return { kind: 'text', status: 200, text: 'turn finished' };
      return {
        kind: 'tool_use',
        status: 200,
        name: 'write',
        input: { path: 'probe-write.txt', content: 'hello from fake gateway' },
      };
    case 'ask-question':
      if (toolResultPresent) return { kind: 'text', status: 200, text: 'turn finished' };
      return {
        kind: 'tool_use',
        status: 200,
        name: 'ask',
        input: {
          questions: [
            {
              header: '\u70b9\u9a8c\u987a\u5e8f',
              question:
                '\u8fd9\u6b21\u89c6\u89c9\u70b9\u9a8c\u5148\u91cf\u54ea\u4e00\u5f20\u5361\uff1f',
              options: [
                {
                  label: '\u5148\u91cf\u6743\u9650\u5361',
                  description: '\u5199\u6587\u4ef6\u5ba1\u6279\u90a3\u4e00\u5f20',
                },
                {
                  label: '\u5148\u91cf\u95ee\u7b54\u5361',
                  description: '\u5c31\u662f\u73b0\u5728\u8fd9\u4e00\u5f20',
                },
                {
                  label: '\u4e24\u5f20\u4e00\u8d77\u91cf',
                  description: '\u540c\u4e00\u56de\u5408\u5185\u5148\u540e\u89e6\u53d1',
                },
              ],
            },
          ],
        },
      };
    case 'retry-503':
      if (seq <= 2) return { kind: 'error', status: 503, message: `fake overloaded #${seq}` };
      return { kind: 'text', status: 200, text: 'fake gateway ok' };
    case 'retry-503-forever':
      return {
        kind: 'error',
        status: 503,
        message: `FAKE_GATEWAY_OVERLOADED_MARKER fake overloaded #${seq}`,
      };
    case 'archive-probe':
      // Driven by request sequence number only — deliberately ignores toolResultPresent
      // so the turn sequence stays deterministic even if a caller's harness doesn't
      // round-trip tool_result blocks correctly.
      if (seq === 1) {
        return {
          kind: 'tool_use',
          status: 200,
          name: 'bash',
          input: { command: `sleep ${sleepSeconds} && echo slept` },
        };
      }
      if (seq === 2) {
        return {
          kind: 'tool_use',
          status: 200,
          name: 'write',
          input: { path: 'archive-probe.txt', content: 'written after archive' },
        };
      }
      if (seq === 3) {
        return {
          kind: 'tool_use',
          status: 200,
          name: 'read',
          input: { path: 'archive-probe.txt' },
        };
      }
      if (seq === 4) {
        return {
          kind: 'tool_use',
          status: 200,
          name: 'bash',
          input: { command: 'pwd && ls -la' },
        };
      }
      return { kind: 'text', status: 200, text: 'archive probe finished' };
    default:
      throw new Error(`Unknown plan: ${plan}`);
  }
}

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeSSE(res, frames) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.end(frames.map(([event, data]) => sseFrame(event, data)).join(''));
}

function sendTextTurn(res, model, text) {
  const frames = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_${crypto.randomUUID()}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 9 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  writeSSE(res, frames);
}

/** Split a JSON string into a handful of partial_json chunks so the delta sequence is realistic. */
function chunkString(s, chunkCount) {
  if (s.length === 0) return [''];
  const size = Math.max(1, Math.ceil(s.length / chunkCount));
  const chunks = [];
  for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
  return chunks;
}

function sendToolUseTurn(res, model, { name, input }) {
  const toolId = `toolu_${crypto.randomUUID()}`;
  const inputJson = JSON.stringify(input);
  const chunks = chunkString(inputJson, 3);
  const frames = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_${crypto.randomUUID()}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 18, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: toolId, name, input: {} },
      },
    ],
    ...chunks.map((partial_json) => [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } },
    ]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 24 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  writeSSE(res, frames);
}

// --- paced plans (batch I point-check) --------------------------------------
//
// Everything above writes one `res.end()` with the whole turn in it, which is
// enough when a point-check only cares about the settled result. T101 / T096 /
// T098 are about the SHAPE OF THE WAIT, so the three plans below hand back a
// list of `[delayMs, event, data]` triples that `sendPaced` walks with real
// timers. `delayMs` is the gap BEFORE that frame.

/** The `message_start` frame every turn opens with. */
function messageStartFrame(model, inputTokens = 24) {
  return [
    0,
    'message_start',
    {
      type: 'message_start',
      message: {
        id: `msg_${crypto.randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    },
  ];
}

/** Cut a string into exactly `count` pieces (the last one absorbs the remainder). */
function splitInto(text, count) {
  if (count <= 1) return [text];
  const size = Math.ceil(text.length / count);
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  // A short string can yield fewer pieces than asked; that is fine and honest.
  return out.length > 0 ? out : [''];
}

/**
 * A multi-line file body big enough that "已收到 N 行" visibly climbs.
 *
 * Deliberately plain HTML: the point-check wants a `write` whose diff preview
 * is readable in a screenshot, not a torture test for the differ.
 */
function buildWriteBody(lines) {
  const rows = [
    '<!doctype html>',
    '<html lang="zh">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <title>T101 slow write</title>',
    '  </head>',
    '  <body>',
  ];
  for (let i = 1; rows.length < lines - 2; i += 1) {
    rows.push(`    <p data-row="${i}">第 ${i} 行：工具行应当在参数还没流完时就出现。</p>`);
  }
  rows.push('  </body>');
  rows.push('</html>');
  return `${rows.join('\n')}\n`;
}

/**
 * T101 — a text block, then a `write` call whose arguments are dictated slowly.
 *
 * The preamble reproduces the field report's screenshot ("下面开始编写文件：" and
 * then nothing for minutes), so the point-check is looking at the same moment
 * the user was.
 */
function buildSlowWriteFrames(model, { chunks, chunkMs, writePath, writeLines }) {
  const toolId = `toolu_${crypto.randomUUID()}`;
  const inputJson = JSON.stringify({ path: writePath, content: buildWriteBody(writeLines) });
  const pieces = splitInto(inputJson, chunks);
  return [
    messageStartFrame(model),
    [
      0,
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      200,
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '下面开始编写文件：' },
      },
    ],
    [200, 'content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      300,
      'content_block_start',
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: toolId, name: 'write', input: {} },
      },
    ],
    ...pieces.map((partial_json, i) => [
      i === 0 ? 0 : chunkMs,
      'content_block_delta',
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } },
    ]),
    [chunkMs, 'content_block_stop', { type: 'content_block_stop', index: 1 }],
    [
      0,
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 1200 },
      },
    ],
    [0, 'message_stop', { type: 'message_stop' }],
  ];
}

/** A long, many-lined thought so the block overflows the transcript viewport. */
function buildThinkingText(chunks) {
  const out = [];
  for (let i = 1; i <= chunks; i += 1) {
    out.push(`第 ${i} 步推理：先确认这一段思考正文足够长，好让折叠头有机会吸顶。\n`);
  }
  return out.join('');
}

/** T096 / T098 — one `thinking` block dictated slowly, then a short answer. */
function buildLongThinkingFrames(model, { chunks, chunkMs }) {
  const thinkingText = buildThinkingText(chunks);
  const pieces = splitInto(thinkingText, chunks);
  return [
    messageStartFrame(model),
    [
      0,
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    ],
    ...pieces.map((thinking, i) => [
      i === 0 ? 0 : chunkMs,
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
    ]),
    [
      chunkMs,
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'fake-signature' },
      },
    ],
    [0, 'content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      200,
      'content_block_start',
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    ],
    [
      200,
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: '想完了：折叠头该吸顶，收起后该回到这一块的自然位置。' },
      },
    ],
    [0, 'content_block_stop', { type: 'content_block_stop', index: 1 }],
    [
      0,
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 900 },
      },
    ],
    [0, 'message_stop', { type: 'message_stop' }],
  ];
}

/**
 * Walk a paced frame list with real timers, and stop the moment the client
 * hangs up — a Stop button or an idle timeout closes the socket, and a server
 * that kept firing timers into a dead response would keep the process alive
 * long after the point-check moved on.
 */
function sendPaced(res, frames) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  let aborted = false;
  res.on('close', () => {
    aborted = true;
  });
  let index = 0;
  const step = () => {
    if (aborted) return;
    if (index >= frames.length) {
      res.end();
      return;
    }
    const [delayMs, event, data] = frames[index++];
    setTimeout(() => {
      if (aborted) return;
      res.write(sseFrame(event, data));
      step();
    }, delayMs);
  };
  step();
}

/**
 * T093 — accept the request, answer with 200 headers, then say nothing.
 *
 * No body bytes at all, so a headers timeout can never fire and only the idle
 * (body) timeout decision 029 adds can end this.
 */
function sendHang(res, holdMs) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const timer = setTimeout(() => res.end(), holdMs);
  res.on('close', () => clearTimeout(timer));
}

function sendError(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message } }));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = loadState(args.state, args.reset);
  saveState(args.state, state); // materialize the state file even on first run / --reset

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url?.startsWith('/health?'))) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, plan: args.plan, count: state.count }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'not found',
          hint: 'this fake gateway only serves POST (as /v1/messages) and GET /health',
        })
      );
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      state.count += 1;
      const seq = state.count;

      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        parsed = {};
      }
      // Echo back --model-id regardless of what the request body sent as `model`, so a
      // point-check log can line up the fake gateway's replies with a specific model name.
      const model = args.modelId;
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const lastMessage = messages[messages.length - 1];
      const toolResultPresent = hasToolResult(messages);
      const summary = summarizeMessage(lastMessage);

      const decision = decide(args.plan, seq, toolResultPresent, args.sleep, { hold: args.hold });

      logRequest({
        seq,
        status: decision.status,
        role: lastMessage?.role ?? null,
        contentSummary: summary,
        hasToolResult: toolResultPresent,
        plan: args.plan,
      });
      saveState(args.state, state);

      if (decision.kind === 'error') {
        sendError(res, decision.status, decision.message);
      } else if (decision.kind === 'text') {
        sendTextTurn(res, model, decision.text);
      } else if (decision.kind === 'tool_use') {
        sendToolUseTurn(res, model, { name: decision.name, input: decision.input });
      } else if (decision.kind === 'hang') {
        sendHang(res, decision.holdMs);
      } else if (decision.kind === 'paced') {
        const frames =
          decision.flavour === 'slow-write'
            ? buildSlowWriteFrames(model, {
                chunks: args.chunks,
                chunkMs: args.chunkMs,
                writePath: args.writePath,
                writeLines: args.writeLines,
              })
            : buildLongThinkingFrames(model, { chunks: args.chunks, chunkMs: args.chunkMs });
        sendPaced(res, frames);
      }
    });
  });

  server.listen(args.port, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[fake-gateway] listening on http://127.0.0.1:${args.port} plan=${args.plan} sleep=${args.sleep} state=${args.state} model=${args.modelId} pid=${process.pid}`
    );
  });

  const shutdown = () => {
    saveState(args.state, state);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
