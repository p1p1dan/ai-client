/**
 * Shared CDP driver for the H/21 point-check.
 *
 * A module rather than one big probe script, because this point-check is
 * exploratory: it opens the dev app once and then asks it a series of
 * questions, and re-launching Electron between questions is the single most
 * expensive thing that can be done on this 2-core / 3.3 GB host.
 *
 * The CDP mechanics are lifted from `run-t37c-gui-probe.mjs`; read its notes
 * for why `awaitPromise` is never used, why injected code is always a
 * self-contained IIFE, and why `no_proxy` has to be lowercase.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const evidenceDir = path.join(
  repoRoot,
  'docs/plantree/plans/runtime-evolution/evidence/external-agent-migration'
);
export const DEBUG_PORT = Number(process.env.AICLIENT_H21_PORT ?? 9222);
export const LOG_PATH = path.join(os.tmpdir(), 'aiclient-h21-dev.log');

/** The localStorage key the migration dialog uses for a permanent opt-out. */
export const FLAG = 'aiclient-agent-migration-prompted';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Cdp {
  #ws;
  #pending = new Map();
  #nextId = 1;
  #events = new Set();
  problems = [];

  static async attach(port = DEBUG_PORT, timeoutMs = 240_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'no attempt made';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await res.json();
        const page = targets.find((t) => t.type === 'page' && /^https?:\/\//.test(t.url ?? ''));
        if (page?.webSocketDebuggerUrl) {
          const client = new Cdp();
          await client.#connect(page.webSocketDebuggerUrl);
          await client.send('Page.enable');
          await client.send('Runtime.enable');
          return client;
        }
        lastError = `no http page target yet (${targets.length} targets)`;
      } catch (error) {
        lastError = String(error?.message ?? error);
      }
      await sleep(1000);
    }
    throw new Error(`CDP target never appeared on port ${port}: ${lastError}`);
  }

  #connect(url) {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(url);
      this.#ws.addEventListener('open', () => resolve());
      this.#ws.addEventListener('error', (event) =>
        reject(new Error(`CDP socket error: ${event.message ?? 'unknown'}`))
      );
      this.#ws.addEventListener('message', (event) => {
        const frame = JSON.parse(event.data);
        if (frame.method) {
          for (const handler of this.#events) handler(frame);
          return;
        }
        const waiter = this.#pending.get(frame.id);
        if (!waiter) return;
        this.#pending.delete(frame.id);
        if (frame.error) waiter.reject(new Error(`${frame.error.message} (${frame.error.code})`));
        else waiter.resolve(frame.result);
      });
    });
  }

  collectRendererProblems() {
    this.#events.add((frame) => {
      if (frame.method === 'Runtime.exceptionThrown') {
        const d = frame.params.exceptionDetails;
        this.problems.push({ kind: 'exception', text: d.exception?.description ?? d.text });
      } else if (frame.method === 'Runtime.consoleAPICalled' && frame.params.type === 'error') {
        this.problems.push({
          kind: 'console.error',
          text: frame.params.args
            .map((a) => a.description ?? a.value ?? a.type)
            .join(' ')
            .slice(0, 400),
        });
      }
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(`evaluate threw: ${d.exception?.description ?? d.text}`);
    }
    return result.result.value;
  }

  async waitFor(expression, { timeoutMs = 30_000, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(
        `(() => { try { return ${expression} } catch { return null } })()`
      );
      if (last) return last;
      await sleep(250);
    }
    throw new Error(
      `waitFor timed out after ${timeoutMs}ms: ${label} (last: ${JSON.stringify(last)})`
    );
  }

  async screenshot(name) {
    // Electron returns an all-background PNG while the window is still hidden.
    await this.waitFor(
      `document.visibilityState === 'visible' && (document.getElementById('root')?.innerText.length ?? 0) > 20`,
      { timeoutMs: 60_000, label: 'window painted' }
    );
    fs.mkdirSync(evidenceDir, { recursive: true });
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(evidenceDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return path.relative(repoRoot, file);
  }

  close() {
    try {
      this.#ws?.close();
    } catch {
      /* already gone */
    }
  }
}

export function startDevApp(openPath = repoRoot) {
  const logFd = fs.openSync(LOG_PATH, 'w');
  const child = spawn(
    'node',
    [
      path.join(repoRoot, 'scripts/dev.js'),
      `--open-path=${openPath}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
    ],
    {
      cwd: repoRoot,
      stdio: ['ignore', logFd, logFd],
      detached: true,
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY ?? ':0',
        no_proxy: [process.env.no_proxy, 'localhost,127.0.0.1,::1'].filter(Boolean).join(','),
      },
    }
  );
  child.unref();
  return child;
}

/** Kill only the instance this port belongs to, by real exe path, never `pkill -f`. */
export function stopDevApp() {
  spawnSync('pkill', ['-f', `remote-debugging-port=${DEBUG_PORT}`], { stdio: 'ignore' });
}

export function devLogTail(lines = 40) {
  try {
    return fs.readFileSync(LOG_PATH, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no dev log)';
  }
}

// --- page helpers: every one a self-contained IIFE ---------------------------

export const clickByText = (text) => `(() => {
  const nodes = [...document.querySelectorAll('button, [role="button"], a')];
  const hit = nodes.find((n) => (n.textContent ?? '').trim() === ${JSON.stringify(text)} && n.offsetParent !== null);
  if (!hit) throw new Error('no clickable element with text: ' + ${JSON.stringify(text)});
  hit.click();
  return true;
})()`;

/**
 * Get past the welcome screen, whichever entry this build actually offers.
 *
 * Every probe used to hardcode 「使用本机已有配置」. A-round testing disables that
 * button (`renderer/lib/aRoundTesting.ts`), and a disabled button swallows
 * `.click()` without throwing — so the probes did not fail at the click, they
 * failed 120s later at "composer mounted", pointing at the wrong thing entirely.
 *
 * Returns the label it clicked, or `null` when there is no welcome screen (the
 * app is already inside). Never clicks a disabled button.
 */
export const ENTER_MAIN_SURFACE = `(() => {
  if (document.querySelector('textarea')) return null;
  const buttons = [...document.querySelectorAll('button')].filter(
    (b) => !b.disabled && b.offsetParent !== null
  );
  // Signed-in managed entry first: it is the one A-round leaves open, and the
  // one the MODEL group's real-provider criteria are written against.
  const hit =
    buttons.find((b) => /^以 .+ 继续$/.test((b.textContent ?? '').trim())) ??
    buttons.find((b) => (b.textContent ?? '').trim() === '使用本机已有配置');
  if (!hit) {
    const seen = buttons.map((b) => (b.textContent ?? '').trim() + (b.disabled ? ' [disabled]' : ''));
    throw new Error('no usable welcome entry; buttons on screen: ' + JSON.stringify(seen));
  }
  const label = (hit.textContent ?? '').trim();
  hit.click();
  return label;
})()`;

export const hasText = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;

/** Everything about the open dialog a human would check, in one read. */
export const DIALOG_STATE = `(() => {
  const popup = document.querySelector('[role="dialog"], [data-slot="dialog-popup"]');
  if (!popup) return null;
  const boxes = [...popup.querySelectorAll('[role="checkbox"], input[type="checkbox"]')].map((b) => ({
    label: b.getAttribute('aria-label'),
    checked: b.getAttribute('aria-checked') ?? String(b.checked ?? ''),
  }));
  return {
    buttons: [...popup.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).filter(Boolean),
    boxes,
    body: popup.innerText,
  };
})()`;

export const toggleBox = (label) => `(() => {
  const popup = document.querySelector('[role="dialog"], [data-slot="dialog-popup"]') ?? document;
  const box = [...popup.querySelectorAll('[role="checkbox"], input[type="checkbox"]')]
    .find((n) => (n.getAttribute('aria-label') ?? '') === ${JSON.stringify(label)});
  if (!box) throw new Error('no checkbox labelled ' + ${JSON.stringify(label)});
  box.click();
  return box.getAttribute('aria-checked');
})()`;
