#!/usr/bin/env node
/**
 * T37-c GUI point-check probe.
 *
 * Drives the real dev app over the Chrome DevTools Protocol and records what a
 * person would see: entry screen, multi-session, queue, history, legacy import
 * and the GUI/TUI switch. Every step writes a screenshot plus a line in a JSON
 * report so the run can be re-read later without repeating it by hand.
 *
 * Unlike the T37-b longevity probe this needs no code inside Electron, so it is
 * a plain .mjs driver rather than a bundled probe entry.
 *
 *   node scripts/run-t37c-gui-probe.mjs
 *   node scripts/run-t37c-gui-probe.mjs --only=entry,models
 *   node scripts/run-t37c-gui-probe.mjs --keep-open   # leave the app running
 *
 * Requires dev.env to point PI_CODING_AGENT_DIR at an agent dir holding real
 * provider credentials; the steps that send messages hit real model endpoints.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(
  repoRoot,
  'docs/plantree/plans/pi-backend-migration/evidence/t37c-screenshots'
);
const reportPath = path.join(evidenceDir, 'report.json');

const DEBUG_PORT = Number(process.env.AICLIENT_T37C_PORT ?? 9222);
const OPEN_PATH = process.env.AICLIENT_T37C_OPEN_PATH ?? repoRoot;
const STARTUP_TIMEOUT_MS = 180_000;

const args = process.argv.slice(2);
const keepOpen = args.includes('--keep-open');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').filter(Boolean)) : null;

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------

class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #events = new Set();
  /** Renderer console errors and uncaught exceptions, in arrival order. */
  problems = [];

  /**
   * A blank window is the failure mode this probe exists to catch, and a blank
   * window says nothing on its own. Keep the renderer's own errors so a failed
   * step can point at the cause instead of just a white screenshot.
   */
  collectRendererProblems() {
    this.#events.add((frame) => {
      if (frame.method === 'Runtime.exceptionThrown') {
        const details = frame.params.exceptionDetails;
        this.problems.push({
          kind: 'exception',
          text: details.exception?.description ?? details.text,
        });
      } else if (frame.method === 'Runtime.consoleAPICalled' && frame.params.type === 'error') {
        this.problems.push({
          kind: 'console.error',
          text: frame.params.args
            .map((a) => a.description ?? a.value ?? a.type)
            .join(' ')
            .slice(0, 500),
        });
      }
    });
  }

  static async attach(port, timeoutMs) {
    const target = await Cdp.#waitForPageTarget(port, timeoutMs);
    const client = new Cdp();
    await client.#connect(target.webSocketDebuggerUrl);
    return client;
  }

  static async #waitForPageTarget(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'no attempt made';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await res.json();
        // devtools:// and the Vite client both show up; the app is the http page.
        const page = targets.find((t) => t.type === 'page' && /^https?:\/\//.test(t.url ?? ''));
        if (page?.webSocketDebuggerUrl) return page;
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
      // Node 22+ ships WebSocket; no `ws` dependency needed.
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

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate a synchronous expression and return its value. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `evaluate threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`
      );
    }
    return result.result.value;
  }

  /**
   * Run async page code without ever awaiting a promise across the protocol.
   *
   * `awaitPromise: true` on anything slow comes back as "Promise was collected",
   * and the same happens when the promise body calls setState. So: fire the work,
   * park the settled result on `window`, then poll for it with plain evaluates.
   */
  async evalAsync(body, { timeoutMs = 30_000, label = 'async step' } = {}) {
    const slot = `__t37c_${Math.random().toString(36).slice(2, 10)}`;
    await this.evaluate(`
      window.${slot} = undefined;
      (async () => { ${body} })().then(
        (value) => { window.${slot} = { ok: true, value: value === undefined ? null : value }; },
        (error) => { window.${slot} = { ok: false, error: String(error?.message ?? error) }; }
      );
      'started';
    `);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const settled = await this.evaluate(`window.${slot} ?? null`);
      if (settled) {
        await this.evaluate(`delete window.${slot}; 'cleared'`);
        if (!settled.ok) throw new Error(`${label} failed in page: ${settled.error}`);
        return settled.value;
      }
      await sleep(250);
    }
    throw new Error(`${label} did not settle within ${timeoutMs}ms`);
  }

  /** Poll a boolean expression until it is true. */
  async waitFor(expression, { timeoutMs = 30_000, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    while (Date.now() < deadline) {
      lastValue = await this.evaluate(
        `(() => { try { return ${expression} } catch { return null } })()`
      );
      if (lastValue) return lastValue;
      await sleep(250);
    }
    throw new Error(
      `waitFor timed out after ${timeoutMs}ms: ${label} (last value: ${JSON.stringify(lastValue)})`
    );
  }

  async screenshot(name) {
    // Electron hands back an all-background PNG while the window is still
    // hidden, and on a slow host the shell only appears via MainWindow's 5s
    // show-fallback. Waiting here is what keeps the evidence from being a
    // directory of blank images.
    await this.waitFor(
      `document.visibilityState === 'visible' && (document.getElementById('root')?.innerText.length ?? 0) > 50`,
      { timeoutMs: 60_000, label: 'window painted' }
    );
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

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/**
 * The live store instances, reachable because Vite's `@` alias maps to
 * src/renderer. `/@fs/<abs path>` also resolves but hands back a SECOND module
 * instance whose writes never reach the UI, so it must not be used here.
 */
const STORES = `
  const [chat, actions, settings, repo] = await Promise.all([
    import(/* @vite-ignore */ '/stores/chatSessions.ts'),
    import(/* @vite-ignore */ '/stores/chatSessionActions.ts'),
    import(/* @vite-ignore */ '/stores/settings/index.ts'),
    import(/* @vite-ignore */ '/stores/repository.ts'),
  ]);
  const chatStore = chat.useChatSessionsStore;
`;

/**
 * Click the first visible element whose trimmed text matches.
 *
 * Emitted as a self-contained IIFE: `Runtime.evaluate` runs in the page's
 * GLOBAL scope, so a bare `const` helper survives the call and the next
 * evaluate dies with "Identifier has already been declared".
 */
const clickByText = (text) => `(() => {
  const nodes = [...document.querySelectorAll('button, [role="button"], a')];
  const hit = nodes.find((n) => (n.textContent ?? '').trim() === ${JSON.stringify(text)} && n.offsetParent !== null);
  if (!hit) throw new Error('no clickable element with text: ' + ${JSON.stringify(text)});
  hit.click();
  return true;
})()`;

/**
 * Type into the composer and press Send — the real path, not `store.sendMessage`.
 *
 * The store action carries no model selection (the composer owns it), so calling
 * it directly runs the turn on Pi's own default instead of the model the user
 * picked. That is how the first probe run silently produced an anthropic turn
 * against a stale dev credential while the UI said "GPT-5.6 Terra".
 */
const composeAndSend = (text) => `(() => {
  const ta = document.querySelector('textarea');
  if (!ta) throw new Error('composer textarea not found');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  // One slot, four labels: while a turn runs, Send becomes "Queue message".
  // Accepting both is what lets the queue step reuse this helper.
  const send =
    document.querySelector('[aria-label="Send message"]') ??
    document.querySelector('[aria-label="Queue message"]');
  if (!send) throw new Error('neither Send nor Queue button is present');
  send.click();
  return send.getAttribute('aria-label');
})()`;

/** Text of the last assistant message in a session, or '' when there is none. */
const LAST_ASSISTANT = `
  const lastAssistantText = (state, sessionId) => {
    const msgs = state.messages[sessionId] ?? [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role !== 'assistant') continue;
      return (msgs[i].blocks ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('')
        .trim();
    }
    return '';
  };
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Process table (Linux /proc)
//
// The crash steps have to reach outside the renderer: killing a worker is the
// point, and only the OS can say whether anything was left behind afterwards.
// ---------------------------------------------------------------------------

function readCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
  } catch {
    return null;
  }
}

function readPpid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm may contain spaces/parens, so parse after the closing paren.
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return null;
  }
}

function allPids() {
  return fs
    .readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The Electron browser process for THIS repo — never another checkout's. */
function findAppMainPid() {
  for (const pid of allPids()) {
    const cmd = readCmdline(pid);
    if (!cmd) continue;
    if (!cmd.includes(`${repoRoot}/node_modules/electron/dist/electron`)) continue;
    if (cmd.includes('--type=')) continue; // renderer/zygote/utility children
    return pid;
  }
  return null;
}

/**
 * Pi workers: utility processes of sub-type NodeService, direct children of
 * main. The network service is also a utility process, hence the sub-type.
 */
function findWorkerPids(mainPid) {
  return allPids().filter((pid) => {
    const cmd = readCmdline(pid);
    return (
      cmd?.includes('--utility-sub-type=node.mojom.NodeService') === true &&
      readPpid(pid) === mainPid
    );
  });
}

/** The Pi CLI running inside a TUI pty — spawned by node-pty from main. */
function findPiTuiPids(mainPid) {
  return allPids().filter((pid) => {
    if (readPpid(pid) !== mainPid) return false;
    try {
      return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'pi';
    } catch {
      return false;
    }
  });
}

async function waitForPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return true;
    await sleep(200);
  }
  throw new Error(`pid ${pid} was still alive ${timeoutMs}ms after SIGKILL`);
}

async function waitFor(read, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value != null) return value;
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Wait for a session's answer to be COMPLETE, not merely present.
 *
 * Reading as soon as the text is non-empty catches a streaming delta — the
 * first run this way compared "T37C" against "T37C-S1" and failed. A turn is
 * done when the session has left every running state and the text has stopped
 * growing between two polls.
 */
const SETTLED_REPLY = `
  const settledReply = async (store, sessionId, timeoutMs, expect) => {
    const running = new Set(['starting', 'running', 'waiting_permission', 'waiting_question', 'stopping']);
    const deadline = Date.now() + timeoutMs;
    let previous = null;
    while (Date.now() < deadline) {
      const state = store.getState();
      const session = state.sessions.find((s) => s.id === sessionId);
      const text = lastAssistantText(state, sessionId);
      // The expected-marker guard stops this reading the PREVIOUS turn's
      // answer, which is already settled the moment a new send starts.
      const arrived = expect ? text.includes(expect) : text.length > 0;
      if (arrived && !running.has(session?.status ?? 'idle') && text === previous) break;
      previous = text;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const state = store.getState();
    const session = state.sessions.find((s) => s.id === sessionId);
    return {
      sessionId,
      reply: lastAssistantText(state, sessionId),
      status: session?.status ?? null,
      runtimeIdentity: session?.runtimeIdentity ?? null,
    };
  };
`;

/**
 * Put the workspace back in GUI mode if a previous run left it in TUI.
 *
 * Presentation mode is persisted (T18), and the GUI/TUI toggle only renders
 * once a workspace path exists — so this cannot run at entry time, only after
 * the repository has been registered. In TUI mode there is no composer at all,
 * which is how a leftover mode silently broke every send-based step.
 */
async function ensureGuiMode(cdp) {
  const mode = await cdp.evaluate(
    `(() => {
      const tui = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'TUI');
      return tui?.getAttribute('aria-pressed') === 'true' ? 'tui' : 'gui';
    })()`
  );
  if (mode === 'tui') {
    await cdp.evaluate(clickByText('GUI'));
    await cdp.waitFor(`Boolean(document.querySelector('textarea'))`, {
      timeoutMs: 30_000,
      label: 'switched back to GUI',
    });
  }
  return mode;
}

const steps = [
  {
    name: 'entry',
    covers: 'startup entry screen → local credential route',
    async run(cdp) {
      await cdp.waitFor(
        `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Use my own setup')`,
        { timeoutMs: 90_000, label: 'welcome screen' }
      );
      const before = await cdp.screenshot('01-welcome');
      await cdp.evaluate(clickByText('Use my own setup'));
      await cdp.waitFor(
        `!document.body.textContent.includes('Just a really good one to code with ai.')`,
        {
          timeoutMs: 30_000,
          label: 'shell mounted',
        }
      );
      await sleep(2000);
      const after = await cdp.screenshot('02-shell');
      return { screenshots: [before, after] };
    },
  },
  {
    name: 'models',
    covers: 'real provider catalog reaches the renderer',
    async run(cdp) {
      // `source: 'local'` is the point of this step: it proves the catalog came
      // from the real agent dir rather than the built-in seed table.
      const catalog = await cdp.evalAsync(
        `
        const result = await window.electronAPI.chat.listPiModels({ force: true });
        return {
          source: result?.source ?? null,
          error: result?.error ?? null,
          models: (result?.models ?? []).map((m) => ({ id: m.id, tags: m.tags ?? [] })),
        };
      `,
        { label: 'chat.listPiModels', timeoutMs: 60_000 }
      );
      if (catalog.source === 'seed') {
        throw new Error('catalog fell back to the seed table — the real agent dir was not read');
      }
      return { catalog };
    },
  },
  {
    name: 'workspace',
    covers: 'repository registered from --open-path',
    async run(cdp) {
      // The tree bridge replaces the demo placeholder asynchronously; reading
      // too early returns the two path-less demo workspaces instead.
      await cdp.waitFor(
        `(() => {
          const el = document.querySelector('[title^="New session in "]');
          return Boolean(el);
        })()`,
        { timeoutMs: 60_000, label: 'repository registered' }
      );
      const state = await cdp.evalAsync(
        `${STORES}
        const s = chatStore.getState();
        return {
          workspaces: s.workspaces.map((w) => ({ id: w.id, name: w.name, path: w.path })),
          sessions: s.sessions.length,
          activeSessionId: s.activeSessionId,
        };
      `,
        { label: 'read workspaces' }
      );
      const real = state.workspaces.filter((w) => w.path);
      if (real.length === 0) throw new Error('no workspace carries a real path');
      const restoredMode = await ensureGuiMode(cdp);
      return { state, restoredMode, screenshots: [await cdp.screenshot('03-workspace')] };
    },
  },
  {
    name: 'multiSession',
    covers: 'three sessions, real turns, queue release on revisit, no cross-session bleed',
    async run(cdp) {
      const created = await cdp.evalAsync(
        `${STORES}
        const workspace = chatStore.getState().workspaces.find((w) => w.path);
        const ids = [];
        for (let i = 0; i < 3; i += 1) ids.push(actions.createChatSessionOnWorkspace(workspace.id));
        return ids;
      `,
        { label: 'create three sessions' }
      );
      if (created.some((id) => !id))
        throw new Error(`session creation returned ${JSON.stringify(created)}`);

      const marks = [];
      const clicks = [];
      for (const [index, sessionId] of created.entries()) {
        const mark = `T37C-S${index + 1}`;
        marks.push(mark);
        await cdp.evalAsync(
          `${STORES} chatStore.getState().selectSession(${JSON.stringify(sessionId)});`,
          {
            label: `select ${sessionId}`,
          }
        );
        // The composer must have caught up with the selection before typing,
        // otherwise the text lands in the previous session's draft. Waiting on
        // an EMPTY textarea would be wrong: a leftover draft from an earlier
        // run is legitimate state, and composeAndSend overwrites it anyway.
        await cdp.waitFor(`Boolean(document.querySelector('textarea'))`, {
          label: 'composer mounted',
        });
        await sleep(500);
        clicks.push({
          sessionId,
          button: await cdp.evaluate(composeAndSend(`Reply with exactly: ${mark}`)),
        });
        // Fire all three back to back without waiting: while the first turn is
        // still running the composer's send latch turns Send into "Queue
        // message" for every session, so sends 2 and 3 go through the QUEUE.
        // That is T-19's active-only release working as designed — the entry
        // sits in its own session's queue and fires when that session is next
        // the active one, which the collection loop below then walks.
        await sleep(1500);
      }

      // Visit each session in turn and wait for ITS answer. Two things are
      // being checked at once: a parked queue entry really does release when
      // its session becomes active, and each session ends up holding its own
      // answer and nobody else's — the multi-slot isolation claim from the
      // product side rather than from the process table.
      const replies = [];
      for (const sessionId of created) {
        await cdp.evalAsync(
          `${STORES} chatStore.getState().selectSession(${JSON.stringify(sessionId)});`,
          {
            label: `revisit ${sessionId}`,
          }
        );
        const row = await cdp.evalAsync(
          `${STORES}${LAST_ASSISTANT}${SETTLED_REPLY}
          return await settledReply(chatStore, ${JSON.stringify(sessionId)}, 150000);
        `,
          { timeoutMs: 170_000, label: `await reply for ${sessionId}` }
        );
        replies.push(row);
      }

      const problems = [];
      replies.forEach((row, index) => {
        const own = marks[index];
        if (!row.reply.includes(own))
          problems.push(`${row.sessionId} missing ${own} (got "${row.reply}")`);
        for (const other of marks.filter((m) => m !== own)) {
          if (row.reply.includes(other)) problems.push(`${row.sessionId} leaked ${other}`);
        }
        if (!row.runtimeIdentity) problems.push(`${row.sessionId} never bound a Pi session file`);
      });
      const shot = await cdp.screenshot('04-multi-session');
      if (problems.length) {
        throw new Error(`${problems.join('; ')} | clicks: ${JSON.stringify(clicks)}`);
      }
      return { sessions: replies, clicks, screenshots: [shot] };
    },
  },
  {
    name: 'queue',
    covers: 'queue three during a live turn, reorder, remove, then Stop',
    async run(cdp) {
      const sessionId = await cdp.evalAsync(
        `${STORES} return chatStore.getState().activeSessionId;`,
        {
          label: 'active session',
        }
      );
      // A prompt long enough that the queued sends land while it is still running.
      await cdp.evaluate(
        composeAndSend('Count slowly from 1 to 40, one number per line, no other text.')
      );
      await cdp.waitFor(
        `(() => {
          return Boolean(document.querySelector('[aria-label="Stop the running turn"]'));
        })()`,
        { timeoutMs: 60_000, label: 'turn is running' }
      );

      for (const text of ['queued one', 'queued two', 'queued three']) {
        await cdp.evaluate(composeAndSend(text));
        await sleep(400);
      }

      const queued = await cdp.evalAsync(
        `
        const q = await import(/* @vite-ignore */ '/stores/messageQueue.ts');
        const read = () =>
          (q.useMessageQueueStore.getState().state.bySession[${JSON.stringify(sessionId)}]?.entries ?? [])
            .map((e) => ({ id: e.id, text: e.text }));
        const before = read();
        if (before.length >= 2) {
          q.useMessageQueueStore.getState().moveEntry(${JSON.stringify(sessionId)}, before[0].id, 'down');
        }
        const afterMove = read();
        if (afterMove.length >= 1) {
          q.useMessageQueueStore.getState().removeEntry(${JSON.stringify(sessionId)}, afterMove[afterMove.length - 1].id);
        }
        return { before, afterMove, afterRemove: read() };
      `,
        { label: 'reorder and remove queue entries' }
      );

      const shot = await cdp.screenshot('05-queue');
      // Drain what is left before stopping. Stop ends the RUNNING turn, it does
      // not cancel the queue — leave entries behind and the release hook starts
      // the next one immediately, so "Stop unfroze the composer" would never be
      // observable even though Stop worked.
      const drained = await cdp.evalAsync(
        `
        const q = await import(/* @vite-ignore */ '/stores/messageQueue.ts');
        const store = q.useMessageQueueStore;
        const read = () =>
          (store.getState().state.bySession[${JSON.stringify(sessionId)}]?.entries ?? []).map((e) => e.id);
        for (const id of read()) store.getState().removeEntry(${JSON.stringify(sessionId)}, id);
        return read().length;
      `,
        { label: 'drain the queue' }
      );
      if (drained !== 0) throw new Error(`queue still holds ${drained} entries after draining`);

      await cdp.evalAsync(`${STORES} await chatStore.getState().stopActiveSession();`, {
        timeoutMs: 60_000,
        label: 'stop the turn',
      });
      const stopped = await cdp.waitFor(
        `(() => {
          return document.querySelector('[aria-label="Stop the running turn"]') === null;
        })()`,
        { timeoutMs: 60_000, label: 'composer unfroze after Stop' }
      );

      if (queued.before.length !== 3) {
        throw new Error(`expected 3 queued entries, saw ${queued.before.length}`);
      }
      if (queued.afterMove[0]?.id === queued.before[0]?.id)
        throw new Error('move down did not reorder');
      if (queued.afterRemove.length !== 2) {
        throw new Error(`expected 2 entries after remove, saw ${queued.afterRemove.length}`);
      }
      return { sessionId, queue: queued, drained, stopped: Boolean(stopped), screenshots: [shot] };
    },
  },
  {
    name: 'history',
    covers: 'switch away and back, transcript survives, pagination state present',
    async run(cdp) {
      const result = await cdp.evalAsync(
        `${STORES}${LAST_ASSISTANT}
        const state = chatStore.getState();
        const withReply = state.sessions.filter((s) => lastAssistantText(state, s.id).length > 0);
        if (withReply.length < 2) throw new Error('need two sessions with replies');
        const [first, second] = withReply;
        const before = lastAssistantText(state, first.id);
        chatStore.getState().selectSession(second.id);
        await new Promise((r) => setTimeout(r, 1200));
        chatStore.getState().selectSession(first.id);
        await new Promise((r) => setTimeout(r, 2500));
        const after = chatStore.getState();
        return {
          sessionId: first.id,
          before,
          after: lastAssistantText(after, first.id),
          historyError: after.historyErrors[first.id] ?? null,
          pagination: after.historyPagination?.[first.id] ?? null,
        };
      `,
        { timeoutMs: 60_000, label: 'switch sessions' }
      );
      if (result.after !== result.before) {
        throw new Error(
          `transcript changed across a session switch: "${result.before}" → "${result.after}"`
        );
      }
      if (result.historyError) throw new Error(`history error: ${result.historyError}`);
      return { ...result, screenshots: [await cdp.screenshot('06-history')] };
    },
  },
  {
    name: 'import',
    covers: 'scan Claude history, import one conversation, verify the report',
    async run(cdp) {
      const result = await cdp.evalAsync(
        `
        const projects = await window.electronAPI.legacyImport.listProjects();
        if (!projects.length) return { skipped: 'no legacy Claude projects on this machine' };
        const project = projects[0];
        const sessions = await window.electronAPI.legacyImport.listSessions(project.id);
        if (!sessions.length) return { skipped: 'project has no sessions' };
        const pick = sessions[0];
        const batch = await window.electronAPI.legacyImport.importBatch({
          sources: [{ sourceKind: 'claude-code', projectId: project.id, sourceSessionId: pick.id }],
        });
        return {
          projectCount: projects.length,
          sessionCount: sessions.length,
          picked: pick.id,
          results: batch.results.map((r) => ({
            status: r.status,
            error: r.error ?? null,
            sessionId: r.session?.sessionId ?? null,
            runtimeIdentity: r.session?.runtimeIdentity ?? null,
          })),
        };
      `,
        { timeoutMs: 120_000, label: 'legacy import' }
      );
      if (result.skipped) return { ...result, screenshots: [await cdp.screenshot('07-import')] };
      const status = result.results[0]?.status;
      if (status !== 'imported' && status !== 'already-imported') {
        throw new Error(`import returned ${status}: ${result.results[0]?.error ?? 'no detail'}`);
      }
      return { ...result, screenshots: [await cdp.screenshot('07-import')] };
    },
  },
  {
    name: 'tui',
    covers: "GUI→TUI hands over this chat's own JSONL, and back",
    async run(cdp) {
      const identity = await cdp.evalAsync(
        `${STORES}
        const s = chatStore.getState();
        return s.sessions.find((x) => x.id === s.activeSessionId)?.runtimeIdentity ?? null;
      `,
        { label: 'read runtime identity' }
      );
      await cdp.evaluate(clickByText('TUI'));
      await cdp.waitFor(`document.body.innerText.includes('Pi TUI')`, {
        timeoutMs: 30_000,
        label: 'TUI mode header',
      });
      await sleep(4000);
      const header = await cdp.evaluate(
        `(() => {
          const el = [...document.querySelectorAll('span')].find((s) => s.textContent.startsWith('Pi TUI'));
          return el ? el.textContent.trim() : null;
        })()`
      );
      const shot = await cdp.screenshot('08-tui');
      await cdp.evaluate(clickByText('GUI'));
      await cdp.waitFor(`Boolean(document.querySelector('textarea'))`, {
        timeoutMs: 30_000,
        label: 'back in GUI mode',
      });
      // D19: a chat with a bound runtime is CONTINUED, not replaced by a new one.
      const expected = identity ? 'Pi TUI continues this chat' : 'Pi TUI starts a new session';
      if (header !== expected) {
        throw new Error(
          `TUI header said "${header}", expected "${expected}" (runtimeIdentity=${identity})`
        );
      }
      return {
        runtimeIdentity: identity,
        header,
        screenshots: [shot, await cdp.screenshot('09-back-to-gui')],
      };
    },
  },
  {
    name: 'crashWorker',
    covers: 'kill a session worker: failure surfaces, next send self-heals',
    async run(cdp) {
      const mainPid = findAppMainPid();
      if (!mainPid) throw new Error('could not locate the Electron main process');

      // A fresh session, so the worker that appears next is unambiguously the
      // one serving it — nothing outside Electron can map an existing pid to a
      // session, and killing the wrong worker would prove nothing.
      const sessionId = await cdp.evalAsync(
        `${STORES}
        const workspace = chatStore.getState().workspaces.find((w) => w.path);
        const id = actions.createChatSessionOnWorkspace(workspace.id);
        chatStore.getState().selectSession(id);
        return id;
      `,
        { label: 'create the crash-test session' }
      );
      await cdp.waitFor(`Boolean(document.querySelector('textarea'))`, {
        label: 'composer mounted',
      });
      await sleep(500);

      const before = findWorkerPids(mainPid);
      // Kill MID-TURN, not while idle: the contract under test is that a turn
      // dying with its worker surfaces as a failure instead of a spinner that
      // never resolves.
      await cdp.evaluate(
        composeAndSend('Count slowly from 1 to 60, one number per line, no other text.')
      );
      const victim = await waitFor(
        () => findWorkerPids(mainPid).find((pid) => !before.includes(pid)) ?? null,
        90_000,
        "the new session's worker"
      );
      // Kill once the session is BOUND and RUNNING. Waiting for the Stop
      // button alone fires before createSession returns (mid-handshake);
      // waiting for streamed text overshoots, because a short answer completes
      // between two polls. Bound + running is the turn actually in flight.
      const identity = await cdp.evalAsync(
        `${STORES}
        const id = ${JSON.stringify(sessionId)};
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
          const session = chatStore.getState().sessions.find((x) => x.id === id);
          if (session?.runtimeIdentity && session.status === 'running') return session.runtimeIdentity;
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error('the turn never reached a bound running state');
      `,
        { timeoutMs: 100_000, label: 'await a bound running turn' }
      );
      // Wait for the JSONL to exist before killing. Pi hands Main the path
      // before it writes the file, and a worker killed inside that window
      // cannot be restarted at all — see the T37-c evidence note on
      // WORKER_SESSION_FILE_NOT_FOUND. That is a separate, reported defect;
      // this step is here to prove the ORDINARY crash path recovers.
      await waitFor(() => (fs.existsSync(identity) ? true : null), 60_000, `${identity} to exist`);
      process.kill(victim, 'SIGKILL');
      await waitForPidGone(victim, 15_000);

      // The GUI must not sit there pretending the turn is still alive.
      const afterCrash = await cdp.evalAsync(
        `${STORES}
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const s = chatStore.getState();
          const active = s.sessions.find((x) => x.id === s.activeSessionId);
          if (!active || active.status !== 'running') break;
          await new Promise((r) => setTimeout(r, 500));
        }
        const s = chatStore.getState();
        const active = s.sessions.find((x) => x.id === s.activeSessionId);
        return {
          status: active?.status ?? null,
          pendingPermissions: s.pendingPermissions.length,
          lastError: s.lastError,
        };
      `,
        { timeoutMs: 45_000, label: 'await post-crash settle' }
      );
      if (afterCrash.status === 'running')
        throw new Error('session still reports running after its worker was killed');
      if (afterCrash.pendingPermissions !== 0)
        throw new Error('Extension UI was not reset after the crash');

      // Same session, new turn. T30-c specifies "active turn single failure":
      // the send that races the asynchronous restart is refused ONCE with a
      // retryable error, so a single attempt is not the contract — recovering
      // within a couple of attempts is. Record how many it actually took.
      let healed = null;
      let attempts = 0;
      for (let i = 0; i < 3 && !healed?.reply.includes('T37C-AFTER-CRASH'); i += 1) {
        attempts += 1;
        // Send rather than Queue: the composer's send latch has to have let go,
        // otherwise this just parks another entry in the queue.
        await cdp.waitFor(`Boolean(document.querySelector('[aria-label="Send message"]'))`, {
          timeoutMs: 60_000,
          label: 'composer offers Send again after the crash',
        });
        await cdp.evaluate(composeAndSend('Reply with exactly: T37C-AFTER-CRASH'));
        healed = await cdp.evalAsync(
          `${STORES}${LAST_ASSISTANT}${SETTLED_REPLY}
          return await settledReply(chatStore, ${JSON.stringify(sessionId)}, 60000, 'T37C-AFTER-CRASH');
        `,
          { timeoutMs: 80_000, label: `await post-crash reply (attempt ${i + 1})` }
        );
      }
      const after = findWorkerPids(mainPid);
      const shot = await cdp.screenshot('10-crash-worker');
      if (!healed.reply.includes('T37C-AFTER-CRASH')) {
        throw new Error(`session did not recover; last reply was "${healed.reply}"`);
      }
      if (after.includes(victim)) throw new Error('the killed worker pid came back');
      return {
        sessionId,
        runtimeIdentity: identity,
        killedPid: victim,
        workersBefore: before,
        workersAfter: after,
        statusAfterCrash: afterCrash.status,
        errorAfterCrash: afterCrash.lastError,
        recovered: healed,
        recoveryAttempts: attempts,
        screenshots: [shot],
      };
    },
  },
  {
    name: 'crashTui',
    covers: 'kill the Pi CLI inside the TUI: the app falls back to GUI',
    async run(cdp) {
      const mainPid = findAppMainPid();
      await cdp.evaluate(clickByText('TUI'));
      const ptyPid = await waitFor(
        () => findPiTuiPids(mainPid)[0] ?? null,
        60_000,
        'Pi TUI process'
      );

      process.kill(ptyPid, 'SIGKILL');
      await waitForPidGone(ptyPid, 15_000);

      // T36-c: a dead CLI returns the pane to GUI rather than leaving a corpse.
      await cdp.waitFor(`Boolean(document.querySelector('textarea'))`, {
        timeoutMs: 60_000,
        label: 'fell back to GUI after the TUI died',
      });
      const notice = await cdp
        .waitFor(`document.body.innerText.includes('Pi TUI closed')`, {
          timeoutMs: 15_000,
          label: 'the "Pi TUI closed" notice',
        })
        .then(() => true)
        .catch(() => false);
      const shot = await cdp.screenshot('11-crash-tui');
      if (!notice) throw new Error('the TUI died without telling the user');
      return { killedPid: ptyPid, sawNotice: notice, screenshots: [shot] };
    },
  },
  {
    name: 'hardKillRestart',
    covers: 'SIGKILL the whole app: no orphans, sessions and history survive',
    async run(cdp, ctx) {
      const mainPid = findAppMainPid();
      const workers = findWorkerPids(mainPid);
      const ptys = findPiTuiPids(mainPid);
      const before = await cdp.evalAsync(
        `${STORES}${LAST_ASSISTANT}
        const s = chatStore.getState();
        const withReply = s.sessions.filter((x) => lastAssistantText(s, x.id).length > 0);
        const probe = withReply[0] ?? null;
        return {
          sessionCount: s.sessions.length,
          probeSessionId: probe?.id ?? null,
          probeReply: probe ? lastAssistantText(s, probe.id) : null,
          probeIdentity: probe?.runtimeIdentity ?? null,
        };
      `,
        { label: 'snapshot before the kill' }
      );
      if (!before.probeSessionId) throw new Error('no answered session to verify after restart');

      const restarted = await ctx.restart(mainPid);
      const orphans = [...workers, ...ptys].filter(pidExists);
      if (orphans.length)
        throw new Error(`orphan processes survived the kill: ${orphans.join(', ')}`);

      const after = await restarted.evalAsync(
        `${STORES}${LAST_ASSISTANT}
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          if (chatStore.getState().sessions.some((x) => x.id === ${JSON.stringify(before.probeSessionId)})) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        const s = chatStore.getState();
        const probe = s.sessions.find((x) => x.id === ${JSON.stringify(before.probeSessionId)}) ?? null;
        return {
          sessionCount: s.sessions.length,
          found: Boolean(probe),
          identity: probe?.runtimeIdentity ?? null,
          status: probe?.status ?? null,
        };
      `,
        { timeoutMs: 90_000, label: 'verify sessions after restart' }
      );
      if (!after.found)
        throw new Error(`session ${before.probeSessionId} did not survive the restart`);
      if (after.identity !== before.probeIdentity) {
        throw new Error(
          `resume handle changed across restart: ${before.probeIdentity} → ${after.identity}`
        );
      }
      if (after.status === 'running')
        throw new Error('a session came back claiming to still be running');
      return {
        killedPids: { main: mainPid, workers, ptys },
        before,
        after,
        screenshots: [await restarted.screenshot('12-after-restart')],
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function startDevApp() {
  // A log FILE, not a pipe: with --keep-open this process exits while the app
  // keeps running, and a closed pipe would take electron-vite down with it.
  // Kept out of the evidence directory on purpose — it is build noise plus the
  // dev credential's base URL, neither of which belongs in a committed record.
  const logPath = path.join(os.tmpdir(), 'aiclient-t37c-dev.log');
  const logFd = fs.openSync(logPath, 'w');
  const child = spawn(
    'node',
    [
      path.join(repoRoot, 'scripts/dev.js'),
      `--open-path=${OPEN_PATH}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
    ],
    {
      cwd: repoRoot,
      stdio: ['ignore', logFd, logFd],
      detached: true,
      env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':0' },
    }
  );
  return { child, logPath };
}

function readDevLogTail(logPath, lines = 40) {
  try {
    return fs.readFileSync(logPath, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no dev log)';
  }
}

function stopDevApp(child) {
  // dev.js runs in its own process group; kill the group so electron-vite,
  // Electron and the worker children all go with it.
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  // Belt and braces: only ever kill the instance this script started.
  spawnSync('pkill', ['-f', `remote-debugging-port=${DEBUG_PORT}`], { stdio: 'ignore' });
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });

  const report = {
    startedAt: new Date().toISOString(),
    host: { platform: process.platform, node: process.version },
    openPath: OPEN_PATH,
    agentDir: process.env.PI_CODING_AGENT_DIR ?? '(from dev.env)',
    steps: [],
  };

  let app = startDevApp();
  let cdp;
  let failed = false;

  const attach = async () => {
    const client = await Cdp.attach(DEBUG_PORT, STARTUP_TIMEOUT_MS);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    client.collectRendererProblems();
    return client;
  };

  /**
   * SIGKILL the app and bring it back up, returning a client for the new
   * window. Used only by the hard-kill step; every later step keeps working
   * because `cdp` is rebound to the new client.
   */
  const restart = async (mainPid) => {
    const carriedProblems = cdp?.problems ?? [];
    cdp?.close();
    try {
      process.kill(mainPid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await waitForPidGone(mainPid, 20_000);
    // dev.js and electron-vite survive the browser process; take the group out
    // too so the relaunch is a genuine cold start.
    stopDevApp(app.child);
    await sleep(3000);
    app = startDevApp();
    cdp = await attach();
    cdp.problems.push(...carriedProblems);
    await cdp.waitFor(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Use my own setup')`,
      { timeoutMs: 120_000, label: 'welcome screen after restart' }
    );
    await cdp.evaluate(clickByText('Use my own setup'));
    await cdp.waitFor(`Boolean(document.querySelector('[title^="New session in "]'))`, {
      timeoutMs: 90_000,
      label: 'repository re-registered after restart',
    });
    await ensureGuiMode(cdp);
    await cdp.waitFor(`Boolean(document.querySelector('textarea'))`, {
      timeoutMs: 60_000,
      label: 'shell after restart',
    });
    return cdp;
  };

  try {
    cdp = await attach();

    for (const step of steps) {
      if (only && !only.has(step.name)) continue;
      const started = Date.now();
      process.stdout.write(`[t37c] ${step.name} … `);
      try {
        const detail = await step.run(cdp, { restart });
        report.steps.push({
          name: step.name,
          covers: step.covers,
          status: 'pass',
          ms: Date.now() - started,
          ...detail,
        });
        console.log(`pass (${Date.now() - started}ms)`);
      } catch (error) {
        failed = true;
        const shot = await cdp.screenshot(`fail-${step.name}`).catch(() => null);
        report.steps.push({
          name: step.name,
          covers: step.covers,
          status: 'fail',
          ms: Date.now() - started,
          error: String(error?.message ?? error),
          ...(shot ? { screenshots: [shot] } : {}),
        });
        console.log(`FAIL — ${error?.message ?? error}`);
        break;
      }
    }
  } catch (error) {
    failed = true;
    report.fatal = String(error?.message ?? error);
    console.error(`[t37c] fatal: ${error?.message ?? error}`);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.rendererProblems = cdp?.problems ?? [];
    if (failed) report.devLogTail = readDevLogTail(app.logPath);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    cdp?.close();
    if (keepOpen) {
      console.log(`[t37c] --keep-open: app left running on port ${DEBUG_PORT}`);
      app.child.unref();
    } else {
      stopDevApp(app.child);
    }
  }

  console.log(`[t37c] report: ${path.relative(repoRoot, reportPath)}`);
  process.exit(failed ? 1 : 0);
}

await main();
