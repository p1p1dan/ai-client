#!/usr/bin/env node
/**
 * ij-gateway.mjs — fake Anthropic Messages SSE gateway for the 2026-09-24
 * interject / branch bar / timeline / loop-guard point-check.
 *
 * Derived from batch-e `fake-gateway.mjs` (same frame shapes, same
 * "POST anything = /v1/messages" contract), but ONE server serves every
 * scenario: the scenario is picked by a marker in the latest human message,
 * so switching scenario never needs a gateway restart and a single request log
 * covers the whole session.
 *
 * Parent vs child: a request whose `tools` include `Task` is the parent
 * (delegates never get the subagent tools); anything else is a child (or a
 * tool-less side request such as compaction).
 *
 * Parent markers (put them in the message you type):
 *   ⟦long⟧      text+bash `echo prep-ok` → text+bash `sleep S` (timeoutSeconds 90,
 *               drops a marker file) → bash `echo step-after-long` → text LONG-DONE
 *   ⟦toolend⟧   bash echo a → bash echo b → an EMPTY end_turn reply (turn ends on tools)
 *   ⟦sub⟧       Task(explorer, ⟦slowchild⟧) → text SUB-DISPATCHED → (report) SUB-REPORT-SEEN
 *   ⟦formA⟧     Task(explorer, ⟦fastchild⟧) → text FORMA-WAITING → (report) idle triple
 *               → idle triple again … → any user text afterwards (wrap-up) → FORMA-WRAPUP
 *   ⟦formB⟧     ONE paced reply: 40 mixed tool_use blocks (incl. write sentinel and
 *               bash touch) then --formb-triples × (TaskList {}, TaskStop {"delegationIds":[]},
 *               TaskWait {"delegationIds":[],"mode":"any","timeoutSeconds":3})
 *   ⟦formBshort⟧ same shape, 10 mixed + 12 triples, different sentinel paths (D3)
 *   ⟦think⟧     thinking + text + bash echo → thinking + slowly streamed long text
 *   ⟦echo⟧ / none   text "ECHO: …"; a delivered subagent report gets "REPORT-SEEN: …"
 * Child briefs:
 *   ⟦slowchild⟧ bash `sleep C` then text CHILD-REPORT-SLOW; ⟦fastchild⟧ text CHILD-REPORT-A
 *
 * Every request appends one JSON line to --log (default /tmp/ij/gw-requests.jsonl)
 * and its full body to /tmp/ij/bodies/<seq>.json; every response logs whether it
 * completed or the CLIENT hung up mid-stream (`event: "client_abort"`).
 *
 * Usage: node ij-gateway.mjs --port 18124 [--sleep 20] [--child-sleep 45]
 *          [--formb-triples 300] [--block-ms 250] [--log path]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

const args = {
  port: 18124,
  sleep: 20,
  childSleep: 45,
  formbTriples: 300,
  blockMs: 250,
  log: '/tmp/ij/gw-requests.jsonl',
  bodies: '/tmp/ij/bodies',
  model: 'fake-sonnet',
};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  const v = process.argv[i + 1];
  if (a === '--port') args.port = Number(v);
  else if (a === '--sleep') args.sleep = Number(v);
  else if (a === '--child-sleep') args.childSleep = Number(v);
  else if (a === '--formb-triples') args.formbTriples = Number(v);
  else if (a === '--block-ms') args.blockMs = Number(v);
  else if (a === '--log') args.log = v;
  else if (a === '--bodies') args.bodies = v;
  else throw new Error(`unknown arg ${a}`);
  i += 1;
}

fs.mkdirSync(path.dirname(args.log), { recursive: true });
fs.mkdirSync(args.bodies, { recursive: true });
let seq = 0;
const log = (entry) =>
  fs.appendFileSync(args.log, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);

// ---------- request analysis ----------

const PARENT_MARKERS = ['long', 'toolend', 'sub', 'formA', 'formBshort', 'formB', 'think', 'echo'];
const MARKER_RE = new RegExp(`⟦(${PARENT_MARKERS.join('|')})⟧`);

function blocksOf(msg) {
  if (!msg) return [];
  if (typeof msg.content === 'string') return [{ type: 'text', text: msg.content }];
  return Array.isArray(msg.content) ? msg.content : [];
}
const textOf = (msg) =>
  blocksOf(msg)
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
const toolResultsOf = (msg) => blocksOf(msg).filter((b) => b?.type === 'tool_result');
const toolUsesOf = (msg) => blocksOf(msg).filter((b) => b?.type === 'tool_use');
const resultText = (b) => {
  const c = b.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => x?.text ?? '').join(' ');
  return '';
};
const clip = (s, n) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function digestMessage(m) {
  const uses = toolUsesOf(m);
  const results = toolResultsOf(m);
  const text = textOf(m);
  const parts = [];
  if (text) parts.push(`text(${text.length})「${clip(text, 60)}」`);
  if (uses.length) {
    const hist = {};
    for (const u of uses) hist[u.name] = (hist[u.name] ?? 0) + 1;
    parts.push(`tool_use×${uses.length}${JSON.stringify(hist)}`);
  }
  if (results.length) parts.push(`tool_result×${results.length}`);
  const thinking = blocksOf(m).filter((b) => b?.type === 'thinking').length;
  if (thinking) parts.push(`thinking×${thinking}`);
  return `${m.role}:${parts.join(' ') || '(empty)'}`;
}

function analyse(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools.map((t) => t?.name).filter(Boolean) : [];
  const system =
    typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((s) => s?.text ?? '').join('\n')
        : '';
  const route = tools.includes('Task') ? 'parent' : 'child';
  let anchor = -1;
  let plan = 'echo';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'user') continue;
    const m = textOf(messages[i]).match(MARKER_RE);
    if (m) {
      anchor = i;
      plan = m[1];
      break;
    }
  }
  const after = anchor >= 0 ? messages.slice(anchor + 1) : messages;
  const last = messages[messages.length - 1];
  const lastIsToolResult = last?.role === 'user' && toolResultsOf(last).length > 0;
  const lastText = last?.role === 'user' ? textOf(last) : '';
  const toolResultsAfter = after.reduce((n, m) => n + toolResultsOf(m).length, 0);
  const toolUsesAfter = after.flatMap((m) => (m.role === 'assistant' ? toolUsesOf(m) : []));
  const triplesAfter = after.filter(
    (m) => m.role === 'assistant' && toolUsesOf(m).some((u) => u.name === 'TaskList')
  ).length;
  const allUserText = messages
    .filter((m) => m.role === 'user')
    .map(textOf)
    .join('\n');
  const assistantToolUses = messages.flatMap((m) => (m.role === 'assistant' ? toolUsesOf(m) : []));
  return {
    messages,
    tools,
    system,
    route,
    anchor,
    plan,
    after,
    last,
    lastIsToolResult,
    lastText,
    toolResultsAfter,
    toolUsesAfter,
    triplesAfter,
    allUserText,
    assistantToolUses,
    reportArrived: /CHILD-REPORT/.test(lastText),
    childMarker: /⟦slowchild⟧/.test(allUserText)
      ? 'slowchild'
      : /⟦fastchild⟧/.test(allUserText)
        ? 'fastchild'
        : null,
  };
}

// ---------- frames ----------

function msgStart() {
  return [
    0,
    'message_start',
    {
      type: 'message_start',
      message: {
        id: `msg_${crypto.randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: args.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 40, output_tokens: 0 },
      },
    },
  ];
}
function msgEnd(stopReason, gap = 0) {
  return [
    [
      gap,
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 30 },
      },
    ],
    [0, 'message_stop', { type: 'message_stop' }],
  ];
}
function splitN(s, n) {
  if (n <= 1 || s.length === 0) return [s];
  const size = Math.ceil(s.length / n);
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
function textBlock(index, text, { chunks = 1, gap = 0, first = 0 } = {}) {
  return [
    [
      first,
      'content_block_start',
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    ],
    ...splitN(text, chunks).map((t, i) => [
      i === 0 ? 0 : gap,
      'content_block_delta',
      { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } },
    ]),
    [0, 'content_block_stop', { type: 'content_block_stop', index }],
  ];
}
function thinkingBlock(index, text, { chunks = 1, gap = 0 } = {}) {
  return [
    [
      0,
      'content_block_start',
      { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
    ],
    ...splitN(text, chunks).map((t, i) => [
      i === 0 ? 0 : gap,
      'content_block_delta',
      { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: t } },
    ]),
    [
      0,
      'content_block_delta',
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: 'fake-signature' },
      },
    ],
    [0, 'content_block_stop', { type: 'content_block_stop', index }],
  ];
}
function toolBlock(index, name, input, { gap = 0 } = {}) {
  const json = JSON.stringify(input);
  const pieces = splitN(json, json.length > 40 ? 2 : 1);
  return [
    [
      gap,
      'content_block_start',
      {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
          name,
          input: {},
        },
      },
    ],
    ...pieces.map((p) => [
      0,
      'content_block_delta',
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: p } },
    ]),
    [0, 'content_block_stop', { type: 'content_block_stop', index }],
  ];
}

const textReply = (text) => [msgStart(), ...textBlock(0, text), ...msgEnd('end_turn')];
const toolReply = (lead, name, input) => {
  const frames = [msgStart()];
  let idx = 0;
  if (lead) frames.push(...textBlock(idx++, lead));
  frames.push(...toolBlock(idx, name, input));
  frames.push(...msgEnd('tool_use'));
  return frames;
};
const TRIPLE = [
  ['TaskList', {}],
  ['TaskStop', { delegationIds: [] }],
  ['TaskWait', { delegationIds: [], mode: 'any', timeoutSeconds: 3 }],
];
function tripleReply() {
  const frames = [msgStart()];
  TRIPLE.forEach(([name, input], i) => {
    frames.push(...toolBlock(i, name, input));
  });
  frames.push(...msgEnd('tool_use'));
  return frames;
}

/** The v1.0.2 field shape: mixed calls first, then the degenerate triple, in ONE reply. */
function degenerateReply({ mixed, triples, sentinel, touchPath, blockMs }) {
  const pool = [
    (_i) => ['read', { path: `README.md` }],
    (i) => ['glob', { pattern: `**/*${i}.txt` }],
    (i) => ['grep', { pattern: `needle-${i}`, path: '.' }],
    (i) => ['bash', { command: `echo mixed-${i}` }],
    (i) => ['read', { path: `shared.txt`, offset: 1, limit: i + 1 }],
    (i) => ['glob', { pattern: `src/**/*.m${i}` }],
  ];
  const calls = [];
  for (let i = 0; i < mixed; i += 1) calls.push(pool[i % pool.length](i));
  // The two calls that must never execute: a write and a bash touch.
  calls[Math.min(9, mixed - 1)] = [
    'write',
    { path: sentinel, content: 'loop guard failed: this reply executed\n' },
  ];
  calls[Math.min(19, mixed - 2)] = ['bash', { command: `touch ${touchPath}` }];
  for (let r = 0; r < triples; r += 1)
    for (const [name, input] of TRIPLE) calls.push([name, input]);
  const frames = [msgStart()];
  frames.push(...textBlock(0, '我来检查一下子代理的状态。'));
  calls.forEach(([name, input], i) => {
    frames.push(...toolBlock(i + 1, name, input, { gap: blockMs }));
  });
  frames.push(...msgEnd('tool_use', blockMs));
  return { frames, callCount: calls.length };
}

function thinkingText(lines, tag) {
  const out = [];
  for (let i = 1; i <= lines; i += 1)
    out.push(`${tag} 第 ${i} 步推理：确认这一段思考足够长，折叠后不占地方。`);
  return out.join('\n');
}
function longAnswer(lines) {
  const out = [];
  for (let i = 1; i <= lines; i += 1)
    out.push(`第 ${i} 行：流式正文仍在输出，用来检验点开思考块时页面不被卷走。`);
  return out.join('\n');
}

// ---------- decision ----------

function decide(a) {
  if (a.route === 'child') {
    if (a.childMarker === 'slowchild') {
      if (!a.lastIsToolResult)
        return {
          label: `child: bash sleep ${args.childSleep}`,
          frames: toolReply('先睡一会儿。', 'bash', {
            command: `sleep ${args.childSleep} && echo child-slept`,
            timeoutSeconds: 120,
          }),
        };
      return {
        label: 'child: CHILD-REPORT-SLOW',
        frames: textReply(`CHILD-REPORT-SLOW: 慢子代理完成，睡了 ${args.childSleep} 秒。`),
      };
    }
    if (a.childMarker === 'fastchild')
      return {
        label: 'child: CHILD-REPORT-A',
        frames: textReply('CHILD-REPORT-A: 快子代理完成，没有别的事了。'),
      };
    return { label: 'side request: SUMMARY', frames: textReply('SUMMARY: 这是假网关给的摘要。') };
  }

  switch (a.plan) {
    case 'long': {
      const n = a.toolResultsAfter;
      if (n === 0)
        return {
          label: 'long step0: bash prep',
          frames: toolReply('先做准备。', 'bash', { command: 'echo prep-ok', timeoutSeconds: 30 }),
        };
      if (n === 1) {
        const marker = `/tmp/ij/markers/long-${Date.now()}.txt`;
        return {
          label: `long step1: bash sleep ${args.sleep} (marker ${marker})`,
          frames: toolReply('开始长任务。', 'bash', {
            command: `sleep ${args.sleep}; echo slept > ${marker}; echo step-long-done`,
            timeoutSeconds: 90,
          }),
        };
      }
      if (n === 2)
        return {
          label: 'long step2: bash echo',
          frames: toolReply(null, 'bash', { command: 'echo step-after-long' }),
        };
      return { label: 'long done: text', frames: textReply('LONG-DONE: 长回合正常结束。') };
    }
    case 'toolend': {
      const n = a.toolResultsAfter;
      if (n === 0)
        return {
          label: 'toolend step0',
          frames: toolReply(null, 'bash', { command: 'echo toolend-a' }),
        };
      if (n === 1)
        return {
          label: 'toolend step1',
          frames: toolReply(null, 'bash', { command: 'echo toolend-b' }),
        };
      return { label: 'toolend: empty end_turn', frames: [msgStart(), ...msgEnd('end_turn')] };
    }
    case 'sub': {
      const dispatched = a.toolUsesAfter.some((u) => u.name === 'Task');
      if (!dispatched)
        return {
          label: 'sub: Task slowchild',
          frames: toolReply('派出一个慢子代理。', 'Task', {
            agent: 'explorer',
            task: '⟦slowchild⟧ 这是点验用的慢子代理：先 sleep，再回报。',
            description: '慢子代理点验',
          }),
        };
      if (a.reportArrived)
        return {
          label: 'sub: report seen',
          frames: textReply('SUB-REPORT-SEEN: 收到子代理报告。'),
        };
      if (a.lastIsToolResult)
        return {
          label: 'sub: dispatched text',
          frames: textReply('SUB-DISPATCHED: 子代理在后台跑，我等它的报告。'),
        };
      return { label: 'sub: other', frames: textReply('SUB-OTHER') };
    }
    case 'formA': {
      const dispatched = a.toolUsesAfter.some((u) => u.name === 'Task');
      if (!dispatched)
        return {
          label: 'formA: Task fastchild',
          frames: toolReply('派出一个快子代理。', 'Task', {
            agent: 'explorer',
            task: '⟦fastchild⟧ 这是点验用的快子代理：直接回报。',
            description: '快子代理点验',
          }),
        };
      const k = a.triplesAfter;
      if (a.reportArrived && k === 0)
        return { label: 'formA: idle triple #1 (after report)', frames: tripleReply() };
      if (a.lastIsToolResult && k === 0)
        return { label: 'formA: waiting text', frames: textReply('FORMA-WAITING: 等子代理报告。') };
      if (a.lastIsToolResult && k < 6)
        return { label: `formA: idle triple #${k + 1}`, frames: tripleReply() };
      if (a.lastIsToolResult) return { label: 'formA: gave up', frames: textReply('FORMA-GAVEUP') };
      return {
        label: 'formA: wrap-up text',
        frames: textReply('FORMA-WRAPUP: 子代理已完成、报告已交付，这是收尾总结。'),
      };
    }
    case 'formB':
    case 'formBshort': {
      if (a.toolUsesAfter.length === 0) {
        const short = a.plan === 'formBshort';
        const { frames, callCount } = degenerateReply({
          mixed: short ? 10 : 40,
          triples: short ? 12 : args.formbTriples,
          sentinel: short ? '/tmp/loopguard-d3-sentinel.txt' : '/tmp/loopguard-sentinel.txt',
          touchPath: short ? '/tmp/loopguard-d3-touched.txt' : '/tmp/loopguard-touched.txt',
          blockMs: args.blockMs,
        });
        return {
          label: `${a.plan}: degenerate reply, ${callCount} tool calls`,
          frames,
          degenerate: callCount,
        };
      }
      return {
        label: `${a.plan}: after tools`,
        frames: textReply(`${a.plan.toUpperCase()}-DONE: 工具都跑完了。`),
      };
    }
    case 'think': {
      if (a.toolResultsAfter === 0) {
        const frames = [msgStart()];
        frames.push(...thinkingBlock(0, thinkingText(40, '[一]'), { chunks: 20, gap: 100 }));
        frames.push(...textBlock(1, '先跑一个工具。'));
        frames.push(...toolBlock(2, 'bash', { command: 'echo think-tool' }));
        frames.push(...msgEnd('tool_use'));
        return { label: 'think step0: thinking + bash', frames };
      }
      const frames = [msgStart()];
      frames.push(...thinkingBlock(0, thinkingText(20, '[二]'), { chunks: 10, gap: 100 }));
      frames.push(...textBlock(1, longAnswer(150), { chunks: 150, gap: 300, first: 200 }));
      frames.push(...msgEnd('end_turn'));
      return { label: 'think step1: thinking + slow long text (~45s)', frames };
    }
    default: {
      if (a.reportArrived)
        return {
          label: 'echo: report seen',
          frames: textReply(`REPORT-SEEN: 收到报告 ${clip(a.lastText, 60)}`),
        };
      const human = a.anchor >= 0 ? textOf(a.messages[a.anchor]) : a.lastText;
      return { label: 'echo', frames: textReply(`ECHO: ${clip(human, 80)}`) };
    }
  }
}

// ---------- server ----------

function stream(res, frames, meta) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  let closedEarly = false;
  let sent = 0;
  let toolBlocksSent = 0;
  const started = Date.now();
  res.on('close', () => {
    if (sent < frames.length) {
      closedEarly = true;
      log({
        event: 'client_abort',
        seq: meta.seq,
        label: meta.label,
        framesSent: sent,
        framesTotal: frames.length,
        toolBlocksSent,
        afterMs: Date.now() - started,
      });
    }
  });
  const step = () => {
    if (closedEarly) return;
    if (sent >= frames.length) {
      res.end();
      log({
        event: 'response_complete',
        seq: meta.seq,
        label: meta.label,
        frames: frames.length,
        toolBlocksSent,
        ms: Date.now() - started,
      });
      return;
    }
    const [delay, event, data] = frames[sent];
    const fire = () => {
      if (closedEarly || res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      sent += 1;
      if (event === 'content_block_start' && data.content_block?.type === 'tool_use')
        toolBlocksSent += 1;
      step();
    };
    if (delay > 0) setTimeout(fire, delay);
    else setImmediate(fire);
  };
  step();
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, seq, pid: process.pid }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(404);
    res.end();
    return;
  }
  let raw = '';
  req.on('data', (c) => {
    raw += c;
  });
  req.on('end', () => {
    seq += 1;
    const mySeq = seq;
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = {};
    }
    fs.writeFileSync(path.join(args.bodies, `${String(mySeq).padStart(4, '0')}.json`), raw);
    const a = analyse(body);
    let decision;
    try {
      decision = decide(a);
    } catch (error) {
      decision = { label: `decide failed: ${error.message}`, frames: textReply('GATEWAY-ERROR') };
    }
    const lastResults = a.last?.role === 'user' ? toolResultsOf(a.last) : [];
    log({
      event: 'request',
      seq: mySeq,
      url: req.url,
      model: body.model ?? null,
      route: a.route,
      plan: a.plan,
      hasTools: a.tools.length > 0,
      toolCount: a.tools.length,
      tools: a.tools,
      systemHead: clip(a.system, 100),
      messageCount: a.messages.length,
      digest: a.messages.map(digestMessage),
      lastRole: a.last?.role ?? null,
      lastText: clip(a.lastText, 400),
      lastToolResults: lastResults.map((b) => ({
        isError: b.is_error === true,
        text: clip(resultText(b), 500),
      })),
      historyToolUseCount: a.assistantToolUses.length,
      historyTaskListCount: a.assistantToolUses.filter((u) => u.name === 'TaskList').length,
      userTextHas: {
        interject: /插话/.test(a.allUserText),
        childReport: /CHILD-REPORT/.test(a.allUserText),
        slashCompact: /(^|\n)\s*\/compact/.test(a.allUserText),
      },
      reply: decision.label,
    });
    stream(res, decision.frames, { seq: mySeq, label: decision.label });
  });
});

server.listen(args.port, '127.0.0.1', () => {
  console.log(`[ij-gateway] listening 127.0.0.1:${args.port} pid=${process.pid} log=${args.log}`);
  log({ event: 'gateway_start', pid: process.pid, port: args.port, args });
});
const bye = () => {
  log({ event: 'gateway_stop', seq });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
