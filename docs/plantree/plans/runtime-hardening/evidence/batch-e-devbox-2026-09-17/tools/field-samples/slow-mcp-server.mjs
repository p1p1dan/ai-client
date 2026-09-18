#!/usr/bin/env node

// A deliberately slow stdio MCP server, for the T033 field-day item
// "reload's 60s budget holds end-to-end against a real MCP handshake"
// (checklist-e real-model table, row 2).
//
// It speaks the newline-delimited JSON-RPC that MCP's stdio transport uses and
// answers `initialize` only after a delay (default 20s, inside the 15-30s band
// the checklist asks for). Everything after the handshake is instant, so the
// only thing under test is the handshake budget.
//
// Runs on plain Node 24 on Windows, macOS and Linux. No dependencies, no shell
// syntax, no network. stdout carries protocol frames only; all logging goes to
// stderr, which the app forwards to the worker log.
//
// Usage (as an MCP server entry, see README.md section 5):
//   node slow-mcp-server.mjs
//   node slow-mcp-server.mjs --delay-ms 28000
//   SLOW_MCP_DELAY_MS=28000 node slow-mcp-server.mjs
//
// Smoke test by hand (type the line, press Enter, watch the clock):
//   node slow-mcp-server.mjs --delay-ms 3000
//   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}

import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';

function resolveDelayMs() {
  const flagIndex = process.argv.indexOf('--delay-ms');
  const raw =
    flagIndex >= 0 && process.argv[flagIndex + 1]
      ? process.argv[flagIndex + 1]
      : process.env.SLOW_MCP_DELAY_MS;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 20_000;
}

const DELAY_MS = resolveDelayMs();

function log(message) {
  process.stderr.write(`[slow-mcp] ${message}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TOOLS = [
  {
    name: 'slow_echo',
    description: 'Returns whatever text it is given. Used to prove the server is reachable.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'text to echo back' } },
      required: ['text'],
    },
  },
];

async function handle(message) {
  const { id, method, params } = message;
  // Notifications carry no id and must never be answered.
  if (id === undefined || id === null) {
    log(`notification ${method}`);
    return;
  }

  switch (method) {
    case 'initialize': {
      log(`initialize received; sleeping ${DELAY_MS} ms before answering`);
      const startedAt = Date.now();
      await sleep(DELAY_MS);
      log(`initialize answered after ${Date.now() - startedAt} ms`);
      reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'slow-mcp-server', version: '1.0.0' },
      });
      return;
    }
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const text = params?.arguments?.text;
      reply(id, {
        content: [{ type: 'text', text: typeof text === 'string' ? text : '(no text argument)' }],
        isError: false,
      });
      return;
    }
    case 'resources/list':
      reply(id, { resources: [] });
      return;
    case 'prompts/list':
      reply(id, { prompts: [] });
      return;
    default:
      replyError(id, -32601, `method not found: ${method}`);
  }
}

log(`started, pid ${process.pid}, handshake delay ${DELAY_MS} ms`);

// Frames still being answered. stdin closing must not cut a slow initialize
// short: when the server is driven by a pipe (`echo ... | node slow-mcp-server`)
// stdin ends immediately, and exiting right there would look like a hang.
const pending = new Set();

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    log(`ignored a line that is not JSON (${trimmed.length} chars)`);
    return;
  }
  // Each frame is handled independently; a slow initialize must not block a
  // later ping from being parsed, which is exactly what the client may try.
  const task = handle(message)
    .catch((error) => {
      log(`handler failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => pending.delete(task));
  pending.add(task);
});
input.on('close', () => {
  log(`stdin closed, draining ${pending.size} in-flight frame(s)`);
  Promise.allSettled([...pending]).then(() => {
    log('exiting');
    process.exit(0);
  });
});
