#!/usr/bin/env node
/**
 * bh-cdp.mjs — the CDP driver the batch H (2026-09-18) GUI point-check ran on.
 *
 * It is `cdp-eval.mjs` (batch E tools) turned into a reusable connection plus the
 * two things every item in this point-check needed and that a one-shot evaluator
 * cannot give you: a persistent socket (so `window.__bh` survives between steps)
 * and a screenshot that waits for the renderer to actually be painting.
 *
 * Usage (CLI):
 *   node bh-cdp.mjs eval  '<expression>'                 # prints the value as JSON
 *   node bh-cdp.mjs shot  <out.png>                      # full-window screenshot
 *   node bh-cdp.mjs enter                                # login page -> main UI, dialogs dismissed
 *   node bh-cdp.mjs text                                 # document.body.innerText
 *
 * Env:
 *   BH_PORT   CDP port (default 9222)
 *
 * Discipline carried over from the batch E handbook, all of it learned the hard way:
 *   - Every injected snippet is a self-contained IIFE. `Runtime.evaluate` runs in the
 *     page's global scope, so a bare `const` leaks and the next call dies with
 *     "Identifier has already been declared".
 *   - Never `awaitPromise` a long promise: CDP answers "Promise was collected".
 *     Kick the promise off, park the result on `window.__bh`, poll for it.
 *   - Never `node.remove()` a popup. React's tree stops matching the DOM and the
 *     settings dialog silently renders nothing until the app is restarted.
 *   - A popup's open/closed state is `[data-open]` / `[data-closed]`, not whether
 *     the node is still mounted.
 */
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = Number(process.env.BH_PORT ?? 9222);

export async function connect(port = PORT, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  let lastErr;
  while (Date.now() < deadline && !target) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      target = targets.find(
        (t) => t.type === 'page' && /^https?:/.test(t.url ?? '') && t.webSocketDebuggerUrl
      );
    } catch (err) {
      lastErr = err;
    }
    if (!target) await delay(500);
  }
  if (!target) throw lastErr ?? new Error('no page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const send = (method, params = {}, callTimeout = 30000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), callTimeout);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const evaluate = async (expression, { awaitPromise = false } = {}) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `eval failed: ${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)}`
      );
    }
    return result.result?.value;
  };

  /** Poll an expression until it is truthy (or the deadline passes). */
  const waitFor = async (expression, { timeout = 30000, interval = 500, label } = {}) => {
    const until = Date.now() + timeout;
    let last;
    while (Date.now() < until) {
      last = await evaluate(expression);
      if (last) return last;
      await delay(interval);
    }
    throw new Error(`waitFor timed out${label ? ` (${label})` : ''}: ${expression}`);
  };

  /** Screenshot, after the renderer says it is visible and #root has content. */
  const screenshot = async (outPath) => {
    await waitFor(
      `(() => document.visibilityState === 'visible' && (document.querySelector('#root')?.childElementCount ?? 0) > 0)()`,
      { timeout: 60000, label: 'renderer painted' }
    );
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
    return outPath;
  };

  return { evaluate, waitFor, screenshot, send, close: () => ws.close() };
}

/** Login page -> main UI, with the migration / announcement dialogs dismissed. */
export async function enterApp(cdp) {
  const onLogin = await cdp.evaluate(
    `(() => document.body.innerText.includes('使用本机已有配置'))()`
  );
  if (onLogin) {
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('使用本机已有配置'));
      if (btn) btn.click();
      return !!btn;
    })()`);
  }
  await cdp.waitFor(`(() => !!document.querySelector('textarea'))()`, {
    timeout: 120000,
    label: 'composer textarea',
  });
  // The two dialogs are computed asynchronously and land AFTER the composer, so
  // they have to be polled away rather than clicked once.
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const left = await cdp.evaluate(`(() => {
      for (const label of ['以后再说', '知道了']) {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
        if (btn) { btn.click(); return 'clicked:' + label; }
      }
      return document.querySelectorAll('[role="dialog"]').length;
    })()`);
    if (left === 0) break;
    await delay(600);
  }
  return cdp.evaluate(`(() => document.querySelectorAll('[role="dialog"]').length)()`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  const cdp = await connect();
  try {
    if (cmd === 'eval') {
      const value = await cdp.evaluate(arg);
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    } else if (cmd === 'shot') {
      console.log(await cdp.screenshot(arg));
    } else if (cmd === 'enter') {
      console.log(`dialogs left: ${await enterApp(cdp)}`);
    } else if (cmd === 'text') {
      console.log(await cdp.evaluate('document.body.innerText'));
    } else {
      console.error('usage: bh-cdp.mjs eval|shot|enter|text [arg]');
      process.exitCode = 2;
    }
  } finally {
    cdp.close();
  }
}
