#!/usr/bin/env node
/**
 * pilab-r0-ui.mjs — real-Electron baseline driver for the PiLab session
 * experience R0 (#2). Runs against the dev app that
 * `p1-7d-gui.mjs launch` + `enter` + `provider` started (P17D_SCRATCH=/tmp/pilab-r0):
 * no model is called here, every scenario is a constructed, sanitized fixture.
 *
 * Injection path: the fixture module and the real `chatSessions` store are
 * imported through the dev server, a store session is created per scenario,
 * and events are folded with the exported `applyRuntimeEvents` inside
 * `setState` — the same call `initRuntime`'s flush makes for IPC batches.
 * What this does NOT exercise: Main, the DSH host, IPC delivery timing.
 *
 *   node pilab-r0-ui.mjs inject <F01..F08|FAIL> [cut]   reset + fold events[0:cut] (default all)
 *   node pilab-r0-ui.mjs measure [F0x] [text …]         DOM facts for the active timeline
 *   node pilab-r0-ui.mjs shot <name>                    privacy-checked screenshot → ../shots/
 *   node pilab-r0-ui.mjs perf <F07|F02> [batch]         F07 method: fold time, long tasks, frames
 *   node pilab-r0-ui.mjs append <F0x> <from>             fold events[from:] into the injected session
 *   node pilab-r0-ui.mjs toggle [n]                      click the n-th process group's <summary>
 *   node pilab-r0-ui.mjs fingerprint [sid]               #11: comparable transcript of a real session
 *   node pilab-r0-ui.mjs back                           re-select the real (gateway) session
 *
 * Cuts are event counts; named cuts per scenario are in CUTS below.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const { Cdp, sleep } = await import(path.join(repoRoot, 'scripts/h21-cdp.mjs'));
const SCRATCH = process.env.P17D_SCRATCH ?? '/tmp/pilab-r0';
const shotsDir = path.resolve(here, '../shots');
const resultsDir = path.resolve(here, '../results');
const FIXTURE = `/@fs${repoRoot}/src/shared/__tests__/fixtures/pilabExperience.ts`;

const userHome = os.userInfo().homedir;
const hostName = os.hostname();
const userName = os.userInfo().username;
function privacyHits(raw) {
  const text = String(raw).split(`${SCRATCH}/`).join('<scratch>/');
  return [
    text.includes('/home/') && '/home/',
    text.includes(userHome) && 'home dir',
    text.includes(hostName) && 'hostname',
    text.includes(`${userName}@`) && 'user@',
  ].filter(Boolean);
}
const scrub = (value) =>
  JSON.parse(
    JSON.stringify(value ?? null)
      .split(repoRoot)
      .join('<repo>')
      .split(userHome)
      .join('<HOME>')
      .split(hostName)
      .join('<host>')
  );

async function attach() {
  const cdp = await Cdp.attach(9222, 30_000);
  cdp.collectRendererProblems();
  return cdp;
}

let slot = 0;
function makeEval(cdp) {
  return async (body, timeoutMs = 60_000) => {
    const key = `__pilabR0_${Date.now()}_${slot++}`;
    await cdp.evaluate(`(() => {
      window.${key} = null;
      (async () => { ${body} })()
        .then((value) => { window.${key} = { done: true, value }; })
        .catch((error) => { window.${key} = { done: true, error: String(error?.stack ?? error) }; });
      return true;
    })()`);
    const out = await cdp.waitFor(`window.${key}?.done ? window.${key} : null`, { timeoutMs });
    await cdp.evaluate(`(() => { delete window.${key}; return true; })()`);
    if (out.error) throw new Error(out.error);
    return out.value;
  };
}

/** Every Page.captureScreenshot forces a frame (see p1-7d-gui.mjs `pumpFrames`). */
async function pumpFrames(cdp, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await cdp
      .send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 1,
        clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 },
      })
      .catch(() => undefined);
  }
}

const IMPORTS = `
  const fx = await import(/* @vite-ignore */ ${JSON.stringify(FIXTURE)});
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const store = chat.useChatSessionsStore;`;

/**
 * Builds the event list in the page. FAIL is F01's running prefix plus one
 * `session.failed` the driver constructs (no fixture carries a failure).
 */
const EVENTS_FOR = (id) => `
  const pick = (fid) => fx.pilabReplayScenarios.find((s) => s.id === fid).createEvents();
  let events;
  if (${JSON.stringify(id)} === 'FAIL') {
    const base = pick('F01').map((e) => ({ ...e, sessionId: 'pilab-replay-fail' }));
    const cut = base.findIndex((e) => e.type === 'message.completed');
    events = base.slice(0, cut);
    const last = events[events.length - 1];
    events.push({
      type: 'session.failed', sessionId: 'pilab-replay-fail', seq: last.seq + 1,
      timestamp: last.timestamp + 100,
      payload: { error: '脱敏演示：上游服务返回 503，回合已中止。' },
    });
  } else {
    events = pick(${JSON.stringify(id)});
  }`;

/** Named cuts (event counts) used by the baseline. */
const CUTS = {
  F01: { running: (ev) => ev.findIndex((e) => e.type === 'message.completed') },
  F02: { running: (ev) => Math.floor(ev.length / 2) },
  F03: { pending: (ev) => ev.findIndex((e) => e.type === 'permission.resolved') },
  F05: { stage: (ev) => ev.findIndex((e) => e.type === 'session.completed') + 1 },
};

async function inject(id, cutArg) {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  const cutFns = CUTS[id] ?? {};
  const cutSource = cutArg && cutFns[cutArg] ? cutFns[cutArg].toString() : null;
  const out = await evalAsync(`${IMPORTS}
    ${EVENTS_FOR(id)}
    const sid = events[0].sessionId;
    const cutArg = ${JSON.stringify(cutArg ?? null)};
    const cutFn = ${cutSource ?? 'null'};
    const cut = cutFn ? cutFn(events) : cutArg ? Number(cutArg) : events.length;
    const slice = events.slice(0, cut);
    // The fixtures carry no 'running' status (sendMessage/Main set it live), so a
    // session that starts with a fresh turn gets one driver-built seq-0 status.
    if (slice[0]?.type === 'message.started') {
      slice.unshift({ type: 'session.status', sessionId: sid, seq: 0, timestamp: slice[0].timestamp - 50, payload: { status: 'running' } });
    }
    store.setState((state) => {
      const real = state.sessions.find((s) => !s.id.startsWith('pilab-replay-')) ?? state.sessions[0];
      const fresh = {
        id: sid, projectId: real.projectId, workspaceId: real.workspaceId,
        title: ${JSON.stringify(id)} + ' · ' + (cutArg ?? 'full'), status: 'idle', agent: 'dsh',
        updatedAt: Date.now(),
      };
      const messages = { ...state.messages };
      delete messages[sid];
      const cursors = { ...(state.runtimeEventCursors ?? {}) };
      delete cursors[sid];
      return {
        sessions: [fresh, ...state.sessions.filter((s) => s.id !== sid)],
        messages,
        runtimeEventCursors: cursors,
        pendingPermissions: state.pendingPermissions.filter((p) => p.sessionId !== sid),
        pendingQuestions: state.pendingQuestions.filter((q) => q.sessionId !== sid),
        hostBoundSessionIds: [...new Set([...state.hostBoundSessionIds, sid])],
        activeSessionId: sid,
      };
    });
    const t0 = performance.now();
    store.setState((state) => ({ ...chat.applyRuntimeEvents(state, slice) }));
    const foldMs = performance.now() - t0;
    const s = store.getState();
    const session = s.sessions.find((x) => x.id === sid);
    return {
      sid, cut, total: events.length, lastType: slice[slice.length - 1]?.type, foldMs,
      status: session?.status, messages: (s.messages[sid] ?? []).length,
      pendingPermissions: s.pendingPermissions.filter((p) => p.sessionId === sid).length,
      pendingQuestions: s.pendingQuestions.filter((q) => q.sessionId === sid).length,
      active: s.activeSessionId,
    };`);
  await pumpFrames(cdp, 1200);
  out.problems = cdp.problems.slice(0, 10);
  cdp.close();
  console.log(JSON.stringify(scrub(out), null, 2));
}

/** Visible = rendered with a box and not inside a closed <details>. */
const MEASURE = (texts) => `(() => {
  // The chat pane: the nearest ancestor of the turns that also holds the
  // composer (and its docked cards), so the sidebar's rows are not counted.
  let main = document.querySelector('[data-turn-id]') ?? document.body;
  while (main.parentElement && !main.querySelector('textarea')) main = main.parentElement;
  const visible = (el) => {
    if (!el || !el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.tagName === 'DETAILS' && !p.open && !el.closest('summary')) return false;
    }
    return el.getClientRects().length > 0;
  };
  const findText = (t) => {
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) if (walker.currentNode.nodeValue.includes(t)) hits.push(walker.currentNode.parentElement);
    return { text: t, inDom: hits.length, visible: hits.filter(visible).length };
  };
  const details = [...main.querySelectorAll('details')];
  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    turns: main.querySelectorAll('[data-turn-id]').length,
    details: details.length,
    detailsOpen: details.filter((d) => d.open).length,
    summaries: details.map((d) => (d.querySelector('summary')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 80)),
    statusIcons: [...main.querySelectorAll('[data-status]')].map((e) => e.getAttribute('data-status')),
    toolCallIds: main.querySelectorAll('[data-tool-call-id]').length,
    questionPrompt: !!main.querySelector('[data-testid="question-prompt"]'),
    failureContinue: !!document.querySelector('[data-testid="failure-continue"]'),
    turnEnd: [...document.querySelectorAll('[data-testid="turn-end-notice"]')].map((e) => e.innerText.slice(0, 120)),
    subagentRows: document.querySelectorAll('[data-testid="subagent-row"]').length,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    texts: ${JSON.stringify(texts)}.map(findText),
    composer: !!document.querySelector('textarea'),
  };
})()`;

async function measure(texts) {
  const cdp = await attach();
  await pumpFrames(cdp, 600);
  const out = await cdp.evaluate(MEASURE(texts));
  cdp.close();
  console.log(JSON.stringify(scrub(out), null, 2));
}

async function shot(name) {
  const cdp = await attach();
  await pumpFrames(cdp, 800);
  const text = await cdp.evaluate(
    `[document.body.innerText, ...[...document.querySelectorAll('textarea, input')].map((n) => n.value || '')].join('\\n')`
  );
  const hits = privacyHits(text);
  if (hits.length) throw new Error(`privacy check refused the shot: ${hits.join(', ')}`);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(shotsDir, { recursive: true });
  const file = path.join(shotsDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  cdp.close();
  console.log(path.relative(repoRoot, file));
}

/**
 * F07 method: one store fold of the whole scenario (or `batch`-sized folds, as
 * initRuntime's 16 ms flush would), timing each fold plus the commit/paint
 * that follows, long tasks (PerformanceObserver 'longtask'), the frame rate
 * while frames are pumped, JS heap before/after, and DOM node count.
 */
async function perf(id, batchArg) {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  const batch = Number(batchArg ?? 0);
  const out = await evalAsync(
    `${IMPORTS}
    ${EVENTS_FOR(id)}
    const sid = events[0].sessionId + '-perf';
    events = events.map((e) => ({ ...e, sessionId: sid }));
    const longTasks = [];
    const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(Math.round(e.duration)); });
    po.observe({ type: 'longtask', buffered: false });
    const heap0 = performance.memory?.usedJSHeapSize ?? null;
    store.setState((state) => {
      const real = state.sessions.find((s) => !s.id.startsWith('pilab-replay-')) ?? state.sessions[0];
      const messages = { ...state.messages }; delete messages[sid];
      const cursors = { ...(state.runtimeEventCursors ?? {}) }; delete cursors[sid];
      return {
        sessions: [{ id: sid, projectId: real.projectId, workspaceId: real.workspaceId, title: ${JSON.stringify(id)} + ' · perf', status: 'idle', agent: 'dsh', updatedAt: Date.now() }, ...state.sessions.filter((s) => s.id !== sid)],
        messages, runtimeEventCursors: cursors,
        hostBoundSessionIds: [...new Set([...state.hostBoundSessionIds, sid])],
        activeSessionId: sid,
      };
    });
    await new Promise((r) => setTimeout(r, 300));
    const size = ${batch} > 0 ? ${batch} : events.length;
    const folds = [];
    const tAll = performance.now();
    for (let i = 0; i < events.length; i += size) {
      const chunk = events.slice(i, i + size);
      const t = performance.now();
      store.setState((state) => ({ ...chat.applyRuntimeEvents(state, chunk) }));
      folds.push(performance.now() - t);
      if (${batch} > 0) await new Promise((r) => setTimeout(r, 16));
    }
    const foldTotal = performance.now() - tAll;
    await new Promise((r) => setTimeout(r, 1500));
    po.disconnect();
    const sorted = [...folds].sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return {
      id: ${JSON.stringify(id)}, events: events.length, batchSize: size, folds: folds.length,
      foldTotalMs: Math.round(foldTotal), foldP50: +q(0.5).toFixed(2), foldP95: +q(0.95).toFixed(2), foldMax: +sorted[sorted.length - 1].toFixed(2),
      longTasks: { count: longTasks.length, max: Math.max(0, ...longTasks), total: longTasks.reduce((a, b) => a + b, 0) },
      heapMB: heap0 == null ? null : { before: +(heap0 / 1048576).toFixed(1), after: +((performance.memory.usedJSHeapSize) / 1048576).toFixed(1) },
      domNodes: document.getElementsByTagName('*').length,
      messages: (store.getState().messages[sid] ?? []).length,
    };`,
    180_000
  );
  // Frame rate with the injected session on screen, frames pumped by captures.
  const t0 = Date.now();
  let frames = 0;
  while (Date.now() - t0 < 2000) {
    await cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 1,
      clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 },
    });
    frames += 1;
  }
  out.capturePumpFps = +(frames / 2).toFixed(1);
  out.problems = cdp.problems.slice(0, 5);
  cdp.close();
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `perf-${id}-${batch || 'all'}.json`),
    `${JSON.stringify(scrub(out), null, 2)}\n`
  );
  console.log(JSON.stringify(scrub(out), null, 2));
}

/**
 * #11 real recovery: what the store holds for a real session (default: the
 * first non-fixture one), in a shape that compares across a host kill or an
 * app restart — roles, block kinds, text, tool call ids — plus what the
 * timeline shows (answer paragraphs on screen).
 */
async function fingerprint(sidArg) {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  const out = await evalAsync(`${IMPORTS}
    const s = store.getState();
    const sid = ${JSON.stringify(sidArg ?? null)} ?? s.sessions.find((x) => !x.id.startsWith('pilab-replay-'))?.id;
    const session = s.sessions.find((x) => x.id === sid);
    const msgs = s.messages[sid] ?? [];
    const rows = msgs.map((m) => ({
      role: m.role,
      blocks: (m.blocks ?? []).map((b) => b.type + (b.toolCallId ? ':' + b.toolCallId : '') + (typeof b.text === 'string' ? ':' + b.text.length : '')),
      text: (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
    }));
    const flat = JSON.stringify(rows);
    let h = 0;
    for (let i = 0; i < flat.length; i += 1) h = (h * 31 + flat.charCodeAt(i)) | 0;
    return {
      sid, status: session?.status, title: session?.title, hostBound: s.hostBoundSessionIds.includes(sid),
      active: s.activeSessionId === sid, messages: msgs.length, hash: h, rows,
      cursor: s.runtimeEventCursors?.[sid] ?? null,
    };`);
  cdp.close();
  console.log(JSON.stringify(scrub(out), null, 2));
}

/** Fold events[from:] into the session `inject` created, without resetting it. */
async function append(id, fromArg) {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  const cutFns = CUTS[id] ?? {};
  const fromSource = cutFns[fromArg] ? cutFns[fromArg].toString() : null;
  const out = await evalAsync(`${IMPORTS}
    ${EVENTS_FOR(id)}
    const fromFn = ${fromSource ?? 'null'};
    const from = fromFn ? fromFn(events) : Number(${JSON.stringify(fromArg ?? 0)});
    const rest = events.slice(from);
    store.setState((state) => ({ ...chat.applyRuntimeEvents(state, rest) }));
    const s = store.getState();
    const sid = events[0].sessionId;
    return { from, applied: rest.length, status: s.sessions.find((x) => x.id === sid)?.status };`);
  await pumpFrames(cdp, 1200);
  cdp.close();
  console.log(JSON.stringify(out));
}

/** Click the <summary> of the n-th process group (DOM click, as a mouse click would). */
async function toggle(index) {
  const cdp = await attach();
  const out = await cdp.evaluate(`(() => {
    let main = document.querySelector('[data-turn-id]') ?? document.body;
    while (main.parentElement && !main.querySelector('textarea')) main = main.parentElement;
    const d = [...main.querySelectorAll('details')][${Number(index ?? 0)}];
    if (!d) return null;
    d.querySelector('summary').click();
    return { before: !d.open };
  })()`);
  await pumpFrames(cdp, 600);
  cdp.close();
  console.log(JSON.stringify(out));
}

async function back() {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  const out = await evalAsync(`${IMPORTS}
    const real = store.getState().sessions.find((s) => !s.id.startsWith('pilab-replay-'));
    if (real) store.setState({ activeSessionId: real.id });
    return real?.id ?? null;`);
  cdp.close();
  console.log(JSON.stringify(out));
}

const [cmd, ...args] = process.argv.slice(2);
const steps = {
  inject: () => inject(args[0], args[1]),
  measure: () => measure(args),
  shot: () => shot(args[0]),
  perf: () => perf(args[0], args[1]),
  fingerprint: () => fingerprint(args[0]),
  append: () => append(args[0], args[1]),
  toggle: () => toggle(args[0]),
  back,
};
if (!steps[cmd]) {
  console.error('usage: inject|measure|shot|perf|back (see header)');
  process.exit(2);
}
await steps[cmd]();
await sleep(0);
process.exit(0);
