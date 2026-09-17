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
 *                    write-approval | archive-probe | ask-question
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
 *   curl -s http://127.0.0.1:18080/health
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';

const LOG_PATH = '/tmp/t032/fake-gateway.log';
const VALID_PLANS = ['text', 'long-turn', 'retry-503', 'retry-503-forever', 'write-approval', 'archive-probe', 'ask-question'];

function parseArgs(argv) {
  const args = {
    port: null,
    plan: null,
    sleep: 90,
    state: '/tmp/t032/fake-gateway.state.json',
    reset: false,
    modelId: 'fake-sonnet',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--plan') args.plan = argv[++i];
    else if (a === '--sleep') args.sleep = Number(argv[++i]);
    else if (a === '--state') args.state = argv[++i];
    else if (a === '--reset') args.reset = true;
    else if (a === '--model-id') args.modelId = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!args.port || Number.isNaN(args.port)) throw new Error('--port <n> is required');
  if (!args.plan) throw new Error('--plan <name> is required');
  if (!VALID_PLANS.includes(args.plan)) {
    throw new Error(`--plan must be one of: ${VALID_PLANS.join(', ')} (got "${args.plan}")`);
  }
  if (!Number.isFinite(args.sleep) || args.sleep <= 0) throw new Error('--sleep must be a positive number');
  if (!args.modelId) throw new Error('--model-id requires a value');
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
  return messages.some((m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool_result'));
}

function logRequest(entry) {
  ensureLogDir();
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

/** Decide what this request's response should look like, given the active plan. */
function decide(plan, seq, toolResultPresent, sleepSeconds) {
  switch (plan) {
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
              question: '\u8fd9\u6b21\u89c6\u89c9\u70b9\u9a8c\u5148\u91cf\u54ea\u4e00\u5f20\u5361\uff1f',
              options: [
                { label: '\u5148\u91cf\u6743\u9650\u5361', description: '\u5199\u6587\u4ef6\u5ba1\u6279\u90a3\u4e00\u5f20' },
                { label: '\u5148\u91cf\u95ee\u7b54\u5361', description: '\u5c31\u662f\u73b0\u5728\u8fd9\u4e00\u5f20' },
                { label: '\u4e24\u5f20\u4e00\u8d77\u91cf', description: '\u540c\u4e00\u56de\u5408\u5185\u5148\u540e\u89e6\u53d1' },
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
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } },
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
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name, input: {} } },
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
      res.end(JSON.stringify({ error: 'not found', hint: 'this fake gateway only serves POST (as /v1/messages) and GET /health' }));
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

      const decision = decide(args.plan, seq, toolResultPresent, args.sleep);

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
