#!/usr/bin/env node

/**
 * fake-gateway-chain-selftest.mjs — checks the fake gateway's dsh-rebase decision 173
 * additions (GitHub issue #9) against the gateway alone: `--capture`, the
 * `metadata.user_id` log fields, thinking blocks on tool steps, and P1-CHAIN with its
 * simulated upstream cache (`cacheSim`).
 *
 *   node src/dsh-host/tools/fake-gateway-chain-selftest.mjs [--keep]
 *
 * Starts only fake-gateway.mjs (`--port 0`, plan dsh-p0-2, a scratch directory under
 * the OS temp dir) and sends crafted Anthropic Messages requests with fetch, built the
 * way pi-ai builds them: the latest user message carries the breakpoint, and string
 * content goes back to a plain string once it is no longer last. The system prompt is
 * multi-byte and large, so a body spans several TCP chunks. Runs one command locally:
 * step 2's printer (bash), to measure its output. Prints a PASS/FAIL table and exits 0
 * only when every check passes; the gateway is always stopped. The scratch directory is
 * removed on success unless `--keep`. Not wired into CI yet.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.join(here, 'fake-gateway.mjs');
const keep = process.argv.includes('--keep');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-chain-selftest-'));
const captureDir = path.join(root, 'capture');
const logPath = path.join(root, 'gw.jsonl');

const MODEL = 'fake-1';
const BETA = 'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';
const VERSION = '2023-06-01';
const CLIENT = 'fg-chain-selftest';
const AGENT = 'fg-chain-selftest/1';
const HOUR = { type: 'ephemeral', ttl: '1h' };
const SYSTEM = `You are the decision 173 self-test.\n${'缓存前缀探针：只追加，不改写。'.repeat(6000)}`;
const TOOLS = [
  {
    name: 'bash',
    description: 'Run a shell command',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command'],
    },
  },
];

// ---- checks ------------------------------------------------------------------------

const rows = [];
function check(name, ok, detail = '') {
  rows.push({ name, ok: Boolean(ok), detail });
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- the client side ---------------------------------------------------------------

/** Claude Code's JSON `metadata.user_id` naming `session`. */
function userIdJson(session) {
  return JSON.stringify({ device_id: 'd'.repeat(64), account_uuid: '', session_id: session });
}

function conversation(prompt, metadata) {
  return { history: [{ role: 'user', content: prompt }], metadata };
}

/** pi-ai's breakpoint on the latest user message (string content becomes a text block). */
function withBreakpoint(message) {
  if (typeof message.content === 'string') {
    return { ...message, content: [{ type: 'text', text: message.content, cache_control: HOUR }] };
  }
  const last = message.content.length - 1;
  return {
    ...message,
    content: message.content.map((block, i) =>
      i === last ? { ...block, cache_control: HOUR } : block
    ),
  };
}

function requestBody(conv) {
  const last = conv.history.length - 1;
  return JSON.stringify({
    model: MODEL,
    max_tokens: 32000,
    stream: true,
    system: [{ type: 'text', text: SYSTEM, cache_control: HOUR }],
    tools: TOOLS,
    messages: conv.history.map((message, i) => (i === last ? withBreakpoint(message) : message)),
    thinking: { type: 'adaptive', display: 'summarized' },
    ...(conv.metadata === undefined ? {} : { metadata: conv.metadata }),
  });
}

function parseSse(text) {
  return text
    .split('\n\n')
    .filter((frame) => frame.trim())
    .map((frame) => {
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      return data === undefined ? undefined : JSON.parse(data);
    });
}

/** The assistant message a stream builds (as pi-ai replays it), and what the checks read. */
function replyOf(frames) {
  const blocks = [];
  const reply = { thinkingDeltas: 0, signatureDeltas: 0 };
  for (const data of frames) {
    if (data?.type === 'message_start') reply.startUsage = data.message.usage;
    if (data?.type === 'message_delta') {
      reply.deltaUsage = data.usage;
      reply.stopReason = data.delta.stop_reason;
    }
    if (data?.type === 'content_block_start') {
      blocks[data.index] = { ...data.content_block, json: '' };
    }
    if (data?.type === 'content_block_delta') {
      const block = blocks[data.index];
      const delta = data.delta;
      if (delta.type === 'thinking_delta') {
        block.thinking += delta.thinking;
        reply.thinkingDeltas += 1;
      }
      if (delta.type === 'signature_delta') {
        block.signature = (block.signature ?? '') + delta.signature;
        reply.signatureDeltas += 1;
      }
      if (delta.type === 'text_delta') block.text += delta.text;
      if (delta.type === 'input_json_delta') block.json += delta.partial_json;
    }
  }
  reply.types = blocks.map((block) => block.type);
  reply.content = blocks.map((block) => {
    if (block.type === 'thinking') {
      return { type: 'thinking', thinking: block.thinking, signature: block.signature };
    }
    if (block.type === 'redacted_thinking') return { type: 'redacted_thinking', data: block.data };
    if (block.type === 'tool_use') {
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: JSON.parse(block.json || '{}'),
      };
    }
    return { type: 'text', text: block.text };
  });
  reply.tool = reply.content.find((block) => block.type === 'tool_use');
  reply.thought = reply.content.find((block) => /thinking$/.test(block.type));
  reply.usage = { ...reply.startUsage, ...reply.deltaUsage };
  return reply;
}

let posted = 0;
async function post(port, body) {
  posted += 1;
  const seq = posted;
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': VERSION,
      'anthropic-beta': BETA,
      'x-pilab-client': CLIENT,
      'user-agent': AGENT,
    },
    body,
  });
  // Written before the reply: the file is there once the response headers are.
  const capturedEarly = fs.existsSync(path.join(captureDir, `${seq}.json`));
  const text = await res.text();
  return { seq, body, status: res.status, capturedEarly, reply: replyOf(parseSse(text)) };
}

/** Send the conversation's next request and append the reply (and a tool result) to it. */
async function turnStep(port, conv, output) {
  const sent = await post(port, requestBody(conv));
  const { reply } = sent;
  conv.history.push({ role: 'assistant', content: reply.content });
  if (reply.tool) {
    conv.history.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: reply.tool.id,
          content: output ? output(reply.tool) : `ran: ${reply.tool.input.command}`,
          is_error: false,
        },
      ],
    });
  }
  return sent;
}

// ---- the expected numbers, computed apart from the gateway -------------------------

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => key !== 'cache_control')
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Characters of the prefix units: tools, system, each message (string content as a block). */
function promptChars(body) {
  const parsed = JSON.parse(body);
  const messages = parsed.messages.map((message) =>
    typeof message.content === 'string'
      ? { ...message, content: [{ type: 'text', text: message.content }] }
      : message
  );
  return [parsed.tools ?? [], parsed.system ?? [], ...messages].reduce(
    (sum, unit) => sum + canonical(unit).length,
    0
  );
}
const tokensA = (body) => Math.ceil(promptChars(body) / 4);
const tokensB = (body) => Math.ceil((promptChars(body) * 11) / 80);
/** What a request left cached, and its whole prompt. */
const cachedOf = (usage) => usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
const promptOf = (usage) => usage.input_tokens + cachedOf(usage);

function logLines() {
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ---- the scenarios -----------------------------------------------------------------

async function run(port) {
  // A, the specified conversation: single cache, user_id on requests 2-3 only.
  const sessionA = '7b0c2a52-5d1e-4c2b-9f3e-00000000000a';
  const a = conversation(
    'P1-CHAIN {"tag":"st-a","steps":3,"sleepStep":1,"cacheSim":"single"} 先跑三步。'
  );
  const a1 = await turnStep(port, a);
  a.metadata = { user_id: userIdJson(sessionA) };
  const a2 = await turnStep(port, a);
  const a3 = await turnStep(port, a);
  const sentA = [a1, a2, a3];

  // C: single cache, one user_id throughout; one step, then the closing text.
  const c = conversation('P1-CHAIN {"tag":"st-c","steps":1}', {
    user_id: userIdJson('7b0c2a52-5d1e-4c2b-9f3e-00000000000c'),
  });
  const c1 = await turnStep(port, c);
  const c2 = await turnStep(port, c);

  // B: two upstreams; the session's 4th request goes to backend B.
  const b = conversation('P1-CHAIN {"tag":"st-b","cacheSim":"split"}', {
    user_id: userIdJson('7b0c2a52-5d1e-4c2b-9f3e-00000000000b'),
  });
  const sentB = [];
  for (let i = 0; i < 5; i += 1) {
    sentB.push(
      await turnStep(port, b, i === 2 ? (tool) => bashOutput(tool.input.command) : undefined)
    );
  }

  // D: cacheSim off, no thinking, pwsh, a sleep on step 0.
  const d1 = await turnStep(
    port,
    conversation(
      'P1-CHAIN {"tag":"st-d","cacheSim":"off","think":false,"tool":"pwsh","sleepStep":0,"sleepSeconds":1}'
    )
  );

  // E: an existing tool script (P1-USAGE step 0) keeps its old frames; legacy user_id.
  const e1 = await turnStep(
    port,
    conversation('P1-USAGE', {
      user_id: 'user_abc123_account__session_6f9a1c3e-1111-4222-8333-444455556666',
      trace: 'x',
    })
  );
  // F: a user_id in neither form.
  const f1 = await turnStep(port, conversation('hello', { user_id: 'plain-user' }));

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((res) => res.json());

  // ---- capture --------------------------------------------------------------------
  const all = [...sentA, c1, c2, ...sentB, d1, e1, f1];
  check(
    'capture: on disk before the reply, for every POST',
    all.every((sent) => sent.capturedEarly),
    all
      .filter((sent) => !sent.capturedEarly)
      .map((sent) => sent.seq)
      .join(',')
  );
  const captures = all.map((sent) =>
    JSON.parse(fs.readFileSync(path.join(captureDir, `${sent.seq}.json`), 'utf8'))
  );
  check(
    'capture: raw body byte for byte (multi-byte, several chunks)',
    captures.every((record, i) => record.body === all[i].body),
    `system ${Buffer.byteLength(SYSTEM)} bytes`
  );
  check(
    'capture: seq, path, method and the four headers',
    captures.every(
      (record, i) =>
        record.seq === all[i].seq &&
        record.path === '/v1/messages' &&
        record.method === 'POST' &&
        same(record.headers, {
          'anthropic-beta': BETA,
          'anthropic-version': VERSION,
          'x-pilab-client': CLIENT,
          'user-agent': AGENT,
        })
    ),
    JSON.stringify(captures[0].headers)
  );
  check(
    'capture: health checks are not captured',
    fs.readdirSync(captureDir).length === posted && health.count === posted,
    `${fs.readdirSync(captureDir).length} files, ${posted} POSTs`
  );

  // ---- log fields -----------------------------------------------------------------
  const lines = logLines();
  const line = (sent) => lines.find((entry) => entry.seq === sent.seq) ?? {};
  check('log: one line per POST', lines.length === posted, `${lines.length} lines`);
  check(
    'log: no user_id -> userIdFormat/userIdSession/metadataKeys null',
    line(a1).userIdFormat === null &&
      line(a1).userIdSession === null &&
      line(a1).metadataKeys === null,
    JSON.stringify([line(a1).userIdFormat, line(a1).userIdSession, line(a1).metadataKeys])
  );
  check(
    'log: JSON user_id -> json + its session_id',
    [a2, a3].every(
      (sent) =>
        line(sent).userIdFormat === 'json' &&
        line(sent).userIdSession === sessionA &&
        same(line(sent).metadataKeys, ['user_id'])
    ),
    JSON.stringify([line(a2).userIdFormat, line(a2).userIdSession, line(a2).metadataKeys])
  );
  check(
    'log: legacy user_id -> legacy + session; other -> other',
    line(e1).userIdFormat === 'legacy' &&
      line(e1).userIdSession === '6f9a1c3e-1111-4222-8333-444455556666' &&
      same(line(e1).metadataKeys, ['trace', 'user_id']) &&
      line(f1).userIdFormat === 'other' &&
      line(f1).userIdSession === null,
    JSON.stringify([line(e1).userIdFormat, line(e1).userIdSession, line(f1).userIdFormat])
  );
  check(
    'log: bodyChars matches the body sent',
    line(a1).bodyChars === a1.body.length,
    `${line(a1).bodyChars} vs ${a1.body.length}`
  );

  // ---- P1-CHAIN replies -----------------------------------------------------------
  const [r1, r2, r3] = sentA.map((sent) => sent.reply);
  check(
    'P1-CHAIN step 0: summarized thinking signed sig-<seq>-0, then bash',
    same(r1.types, ['thinking', 'tool_use']) &&
      r1.thinkingDeltas > 0 &&
      r1.thought.thinking.length > 0 &&
      r1.thought.signature === `sig-${a1.seq}-0` &&
      r1.tool.name === 'bash' &&
      r1.tool.input.command === 'echo p1-chain-st-a-0' &&
      r1.stopReason === 'tool_use' &&
      line(a1).thinkingForm === 'summarized' &&
      line(a1).decision === 'P1-CHAIN:st-a r0 s0',
    `${r1.types} ${r1.thought?.signature} ${line(a1).decision}`
  );
  check(
    'P1-CHAIN step 1: empty thinking with a signature; sleepStep sleeps 3 s',
    same(r2.types, ['thinking', 'tool_use']) &&
      r2.thinkingDeltas === 0 &&
      r2.thought.thinking === '' &&
      r2.thought.signature === `sig-${a2.seq}-1` &&
      r2.tool.input.command === 'sleep 3; echo p1-chain-st-a-1' &&
      line(a2).thinkingForm === 'empty',
    `${r2.types} ${r2.thought?.signature} ${r2.tool?.input.command}`
  );
  const printed = bashOutput(r3.tool.input.command);
  check(
    'P1-CHAIN step 2: redacted_thinking, then a printer over 8,192 characters',
    same(r3.types, ['redacted_thinking', 'tool_use']) &&
      typeof r3.thought.data === 'string' &&
      r3.thought.data.length > 0 &&
      line(a3).thinkingForm === 'redacted' &&
      printed.length > 8192,
    `${r3.types} output ${printed.length} chars`
  );
  check(
    'P1-CHAIN after `steps` steps: text "P1-CHAIN done <tag>"',
    same(c2.reply.types, ['text']) &&
      c2.reply.content[0].text === 'P1-CHAIN done st-c' &&
      c2.reply.stopReason === 'end_turn',
    JSON.stringify(c2.reply.content[0])
  );
  const d = d1.reply;
  check(
    'P1-CHAIN think:false, pwsh, cacheSim off: no thinking, static usage',
    same(d.types, ['tool_use']) &&
      d.tool.name === 'pwsh' &&
      d.tool.input.command === "Start-Sleep -Seconds 1; Write-Output 'p1-chain-st-d-0'" &&
      same(d.startUsage, { input_tokens: 18, output_tokens: 0 }) &&
      same(d.deltaUsage, { output_tokens: 24 }) &&
      line(d1).cacheSim === undefined &&
      line(d1).thinkingForm === undefined,
    `${d.tool?.input.command} ${JSON.stringify(d.startUsage)}`
  );
  check(
    'existing tool script (P1-USAGE step 0): frames as before',
    same(e1.reply.types, ['tool_use']) &&
      same(e1.reply.startUsage, { input_tokens: 18, output_tokens: 0 }) &&
      same(e1.reply.deltaUsage, { output_tokens: 24 }) &&
      line(e1).thinkingForm === undefined &&
      line(e1).cacheSim === undefined,
    `${e1.reply.types} ${JSON.stringify(e1.reply.startUsage)}`
  );

  // ---- cacheSim: single -----------------------------------------------------------
  const u = (sent) => sent.reply.usage;
  check(
    'single: a cold request reads 0, writes prompt - 2 at the TTL asked (1h)',
    u(a1).cache_read_input_tokens === 0 &&
      u(a1).input_tokens === 2 &&
      promptOf(u(a1)) === tokensA(a1.body) &&
      u(a1).cache_creation_input_tokens === tokensA(a1.body) - 2 &&
      same(u(a1).cache_creation, {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: u(a1).cache_creation_input_tokens,
      }) &&
      same(u(a1), { ...a1.reply.startUsage, output_tokens: 24 }),
    JSON.stringify(u(a1))
  );
  check(
    'single: request 2 reads what request 1 cached (prompt 1 - 2)',
    u(c1).cache_read_input_tokens === 0 &&
      u(c2).cache_read_input_tokens === cachedOf(u(c1)) &&
      cachedOf(u(c1)) === tokensA(c1.body) - 2 &&
      promptOf(u(c2)) === tokensA(c2.body),
    `read ${u(c2).cache_read_input_tokens}, request 1 cached ${cachedOf(u(c1))}`
  );
  check(
    'single: user_id starts its own session (A2 cold), A3 reads A2',
    u(a2).cache_read_input_tokens === 0 &&
      u(a3).cache_read_input_tokens === cachedOf(u(a2)) &&
      line(a2).cacheSim?.request === 1 &&
      line(a3).cacheSim?.request === 2,
    `A2 read ${u(a2).cache_read_input_tokens}, A3 read ${u(a3).cache_read_input_tokens} of ${cachedOf(u(a2))}`
  );

  // ---- cacheSim: split ------------------------------------------------------------
  const [s1, s2, s3, s4, s5] = sentB;
  check(
    'split: requests 1-3 on backend A chain like single',
    [s1, s2, s3].every((sent) => line(sent).cacheSim?.backend === 'A') &&
      u(s1).cache_read_input_tokens === 0 &&
      u(s2).cache_read_input_tokens === cachedOf(u(s1)) &&
      u(s3).cache_read_input_tokens === cachedOf(u(s2)),
    [s1, s2, s3].map((sent) => u(sent).cache_read_input_tokens).join(' ')
  );
  check(
    'split: request 4 on backend B counts less for more content, cold, writes 5m',
    line(s4).cacheSim?.backend === 'B' &&
      promptOf(u(s4)) === tokensB(s4.body) &&
      promptOf(u(s4)) < promptOf(u(s3)) &&
      s4.body.length > s3.body.length &&
      u(s4).cache_read_input_tokens === 0 &&
      u(s4).cache_creation.ephemeral_5m_input_tokens === u(s4).cache_creation_input_tokens &&
      u(s4).cache_creation.ephemeral_1h_input_tokens === 0,
    `prompt ${promptOf(u(s3))} (A, request 3) -> ${promptOf(u(s4))} (B, request 4)`
  );
  check(
    'split: request 5 back on A reads what request 3 cached, not request 4',
    line(s5).cacheSim?.backend === 'A' &&
      u(s5).cache_read_input_tokens === cachedOf(u(s3)) &&
      u(s5).cache_read_input_tokens !== cachedOf(u(s4)) &&
      promptOf(u(s5)) === tokensA(s5.body),
    `read ${u(s5).cache_read_input_tokens}, request 3 cached ${cachedOf(u(s3))}`
  );
}

// ---- process plumbing ------------------------------------------------------------

function bashOutput(command) {
  return execFileSync('bash', ['-c', command], {
    encoding: 'utf8',
    maxBuffer: 1 << 24,
    timeout: 20_000,
  });
}

function listeningPort(child) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('fake gateway did not start')), 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake gateway exited (${code}) before listening`));
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exited;
  clearTimeout(timer);
}

async function main() {
  const gateway = spawn(
    process.execPath,
    [
      GATEWAY,
      '--port',
      '0',
      '--plan',
      'dsh-p0-2',
      '--reset',
      '--state',
      path.join(root, 'state.json'),
      '--capture',
      captureDir,
      '--log',
      logPath,
      '--model-id',
      MODEL,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  process.on('exit', () => gateway.kill('SIGKILL'));
  let stderr = '';
  gateway.stderr.setEncoding('utf8');
  gateway.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    await run(await listeningPort(gateway));
  } catch (error) {
    check('self-test ran to the end', false, String(error?.stack ?? error).split('\n')[0]);
  } finally {
    await stop(gateway);
  }

  const width = Math.max(...rows.map((row) => row.name.length));
  for (const row of rows) {
    console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name.padEnd(width)}  ${row.detail}`);
  }
  const passed = rows.filter((row) => row.ok).length;
  const allPassed = passed === rows.length && rows.length > 0;
  console.log(`\n${passed}/${rows.length} checks passed`);
  if (!allPassed && stderr.trim()) console.log(`gateway stderr:\n${stderr.trim()}`);
  if (allPassed && !keep) fs.rmSync(root, { recursive: true, force: true });
  else console.log(`scratch directory: ${root}`);
  process.exitCode = allPassed ? 0 : 1;
}

await main();
