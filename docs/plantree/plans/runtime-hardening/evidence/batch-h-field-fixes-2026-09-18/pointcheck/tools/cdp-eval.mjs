#!/usr/bin/env node
/**
 * Minimal CDP evaluator for the ai-client Electron dev app.
 *
 * Usage:
 *   node /tmp/t032/cdp-eval.mjs <port> '<javascript expression>' [--await] [--timeout=ms]
 *
 * Examples:
 *   node /tmp/t032/cdp-eval.mjs 9333 'document.title'
 *   node /tmp/t032/cdp-eval.mjs 9333 '(() => document.querySelectorAll("[role=dialog]").length)()'
 *   node /tmp/t032/cdp-eval.mjs 9333 'window.__probe' --await
 *
 * Notes (learned the hard way, see memory gui-cdp-pointcheck-recipe):
 *  - Runtime.evaluate runs in the PAGE GLOBAL scope: a bare `const x = ...` leaks
 *    and the NEXT call fails with "Identifier has already been declared".
 *    Always wrap injected code in a self-contained IIFE.
 *  - Do NOT --await a long-running promise: CDP returns "Promise was collected".
 *    Instead have the expression kick off `.then(r => { window.__x = r })` and
 *    poll `window.__x` with a second call.
 *  - Picks the first target with type === 'page' and an http(s) URL (the app
 *    window); DevTools/extension targets are skipped.
 */
import { setTimeout as delay } from 'node:timers/promises';

const [portArg, expression, ...rest] = process.argv.slice(2);
if (!portArg || expression === undefined) {
  console.error("usage: node cdp-eval.mjs <port> '<expression>' [--await] [--timeout=ms]");
  process.exit(2);
}
const port = Number(portArg);
const awaitPromise = rest.includes('--await');
const timeoutMs = Number(rest.find((a) => a.startsWith('--timeout='))?.split('=')[1] ?? 15000);

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

async function pickPageTarget() {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets();
      const page = targets.find(
        (t) => t.type === 'page' && /^https?:/.test(t.url ?? '') && t.webSocketDebuggerUrl
      );
      if (page) return page;
      lastErr = new Error(`no page target yet (${targets.length} targets)`);
    } catch (err) {
      lastErr = err;
    }
    await delay(500);
  }
  throw lastErr ?? new Error('no page target');
}

const target = await pickPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl); // Node >= 22 has a global WebSocket
let nextId = 1;
const pending = new Map();

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  const entry = pending.get(msg.id);
  if (entry) {
    pending.delete(msg.id);
    entry(msg);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const result = await send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise,
  userGesture: true,
});
ws.close();

if (result.exceptionDetails) {
  console.error(JSON.stringify(result.exceptionDetails, null, 2));
  process.exit(1);
}
const value = result.result?.value;
console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
