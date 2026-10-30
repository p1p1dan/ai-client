#!/usr/bin/env node
/**
 * scroll-r1.mjs — R1 real-renderer checks for FR-11 / AC-18, 19, 20.
 *
 *   node scroll-r1.mjs follow     AC-18: bottom follow while streaming; wheel /
 *                                 PageUp / scrollbar-style scroll-up is not pulled
 *                                 back; returning to the bottom resumes following
 *   node scroll-r1.mjs anchor     AC-19: a reading anchor's screen position while
 *                                 content above/below it grows, completes or toggles
 *   node scroll-r1.mjs small      AC-18: ArrowUp once / 30 px / 60 px scrollbar-style moves
 *   node scroll-r1.mjs isolate    AC-20: scroll and expand state across A/B switch
 *
 * Same injection path as pilab-r0-ui.mjs (fixture → real store via
 * applyRuntimeEvents); F02 is streamed in chunks to imitate a long turn.
 * Prints JSON; writes results/scroll-<mode>.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const { Cdp, sleep } = await import(path.join(repoRoot, 'scripts/h21-cdp.mjs'));
const FIXTURE = `/@fs${repoRoot}/src/shared/__tests__/fixtures/pilabExperience.ts`;

const cdp = await Cdp.attach(9222, 30_000);
cdp.collectRendererProblems();
const pump = async (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await cdp
      .send('Page.captureScreenshot', { format: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })
      .catch(() => undefined);
  }
};
let slot = 0;
async function page(body, timeoutMs = 30_000) {
  const key = `__r1_${Date.now()}_${slot++}`;
  await cdp.evaluate(`(() => { window.${key} = null; (async () => { ${body} })()
    .then((value) => { window.${key} = { done: true, value }; })
    .catch((error) => { window.${key} = { done: true, error: String(error?.stack ?? error) }; }); return true; })()`);
  const out = await cdp.waitFor(`window.${key}?.done ? window.${key} : null`, { timeoutMs });
  await cdp.evaluate(`(() => { delete window.${key}; return true; })()`);
  if (out.error) throw new Error(out.error);
  return out.value;
}

/** Page-side helpers: a store session per (fixture, suffix), chunked event folding, scroller metrics. */
await page(`
  const fx = await import(/* @vite-ignore */ ${JSON.stringify(FIXTURE)});
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const store = chat.useChatSessionsStore;
  const sessions = {};
  window.__r1 = {
    // prefixTurns: that many finished F01 turns (ids renamed) before the scenario, so the page stays taller than the viewport.
    open(fid, suffix, prefixTurns = 0) {
      const sid = 'pilab-replay-r1-' + fid.toLowerCase() + '-' + suffix;
      const pick = (id) => fx.pilabReplayScenarios.find((s) => s.id === id).createEvents();
      const raw = [];
      for (let k = 0; k < prefixTurns; k += 1) {
        for (const e of pick('F01')) {
          raw.push(JSON.parse(JSON.stringify(e).replaceAll('"msg-', '"p' + k + 'msg-').replaceAll('"call-', '"p' + k + 'call-')
            .replaceAll('"thought-', '"p' + k + 'thought-').replaceAll('"answer-', '"p' + k + 'answer-')));
        }
      }
      const base = pick(fid);
      const events = [];
      const status = { type: 'session.status', payload: { status: 'running' } };
      for (const e of [...raw, status, ...base]) events.push({ ...e, sessionId: sid, seq: events.length, timestamp: 1800000000000 + events.length * 100 });
      sessions[sid] = { events, next: 0 };
      store.setState((state) => {
        const real = state.sessions.find((s) => !s.id.startsWith('pilab-replay-')) ?? state.sessions[0];
        const messages = { ...state.messages }; delete messages[sid];
        const cursors = { ...(state.runtimeEventCursors ?? {}) }; delete cursors[sid];
        return {
          sessions: [{ id: sid, projectId: real.projectId, workspaceId: real.workspaceId, title: 'R1 ' + fid + ' ' + suffix, status: 'idle', agent: 'dsh', updatedAt: Date.now() },
            ...state.sessions.filter((s) => s.id !== sid)],
          messages, runtimeEventCursors: cursors,
          hostBoundSessionIds: [...new Set([...state.hostBoundSessionIds, sid])],
          activeSessionId: sid,
        };
      });
      return { sid, total: events.length };
    },
    feed(sid, count) {
      const s = sessions[sid];
      const chunk = s.events.slice(s.next, s.next + count);
      s.next += chunk.length;
      store.setState((state) => ({ ...chat.applyRuntimeEvents(state, chunk) }));
      return { fed: chunk.length, next: s.next, total: s.events.length };
    },
    select(sid) { store.setState({ activeSessionId: sid }); return sid; },
    scroller() {
      let el = document.querySelector('[data-turn-id]');
      while (el && el !== document.body) {
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) return el;
        el = el.parentElement;
      }
      return null;
    },
    metrics() {
      const sc = window.__r1.scroller();
      if (!sc) return { scroller: false };
      const jump = [...document.querySelectorAll('button')].find((b) => /最新|底部|latest|bottom/i.test((b.getAttribute('aria-label') ?? '') + (b.title ?? '') + b.innerText) && b.offsetParent !== null);
      return { scroller: true, top: Math.round(sc.scrollTop), height: sc.scrollHeight, client: sc.clientHeight,
        fromBottom: Math.round(sc.scrollHeight - sc.clientHeight - sc.scrollTop), jumpButton: jump ? (jump.getAttribute('aria-label') || jump.title || jump.innerText).trim().slice(0, 40) : null };
    },
    rect(text) {
      const sc = window.__r1.scroller();
      const walker = document.createTreeWalker(sc ?? document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) if (walker.currentNode.nodeValue.includes(text)) {
        const r = walker.currentNode.parentElement.getBoundingClientRect();
        return { top: Math.round(r.top), visible: r.bottom > 0 && r.top < innerHeight };
      }
      return null;
    },
  };
  return true;
`);

const metrics = () => cdp.evaluate('window.__r1.metrics()');
const feed = async (sid, n) => {
  const r = await cdp.evaluate(`window.__r1.feed(${JSON.stringify(sid)}, ${n})`);
  await pump(500);
  return r;
};
async function centerOfScroller() {
  return cdp.evaluate(`(() => { const r = window.__r1.scroller().getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
}
async function wheel(deltaY) {
  const { x, y } = await centerOfScroller();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  await pump(500);
}
async function key(keyName, code, vk) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: keyName, code, windowsVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk });
  await pump(500);
}

const mode = process.argv[2] ?? 'follow';
const out = { mode, steps: [] };
const step = async (label, extra = {}) => {
  const m = await metrics();
  out.steps.push({ label, ...m, ...extra });
  return m;
};

if (mode === 'follow') {
  for (const input of ['wheel', 'pageup', 'scrollbar']) {
    const { sid } = await cdp.evaluate(`window.__r1.open('F02', '${input}')`);
    await pump(800);
    await feed(sid, 120);
    for (let i = 0; i < 3; i += 1) await feed(sid, 15);
    const following = await step(`${input}: streaming, no user input`);
    if (input === 'wheel') await wheel(-300);
    if (input === 'pageup') {
      // Focus the reading area (not the composer) the way a click on it would.
      const { x, y } = await centerOfScroller();
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x + 300, y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 300, y, button: 'left', clickCount: 1 });
      await key('PageUp', 'PageUp', 33);
    }
    if (input === 'scrollbar') {
      // A scrollbar drag reaches the page as a bare scroll event, like this.
      await cdp.evaluate('(() => { const sc = window.__r1.scroller(); sc.scrollTop = sc.scrollTop - 300; return true; })()');
      await pump(500);
    }
    const after = await step(`${input}: user scrolled up`);
    for (let i = 0; i < 3; i += 1) await feed(sid, 15);
    const held = await step(`${input}: more streaming after scroll-up`);
    out.steps[out.steps.length - 1].pulledBack = held.fromBottom < 8 && after.fromBottom >= 8;
    out.steps[out.steps.length - 1].topDrift = held.top - after.top;
    // Back to the latest: the jump button when there is one, else End.
    const clicked = await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => /最新|底部|latest|bottom/i.test((b.getAttribute('aria-label') ?? '') + (b.title ?? '') + b.innerText) && b.offsetParent !== null); b?.click(); return !!b; })()`);
    if (!clicked) await wheel(100000);
    await pump(800);
    await step(`${input}: back to latest (${clicked ? 'jump button' : 'wheel to end'})`);
    for (let i = 0; i < 3; i += 1) await feed(sid, 15);
    await step(`${input}: streaming after return`);
    void following;
  }
}

// AC-18 small moves: one ArrowUp, a 30px scrollbar-style move — both under the 40px "at bottom" band.
if (mode === 'small') {
  for (const input of ['arrowup', 'drag30', 'drag60']) {
    const { sid } = await cdp.evaluate(`window.__r1.open('F02', 'small-${input}')`);
    await pump(800);
    await feed(sid, 150);
    if (input === 'arrowup') {
      const { x, y } = await centerOfScroller();
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x + 300, y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 300, y, button: 'left', clickCount: 1 });
      out.focus = await cdp.evaluate(`(() => { const a = document.activeElement; return a ? a.tagName + '.' + String(a.className).slice(0, 40) : null; })()`);
      // Keyboard scrolling goes to the focused scroller; a click on text leaves focus on <body>,
      // so give the viewport focus the way Tab or a click on it would.
      await cdp.evaluate(`(() => { const sc = window.__r1.scroller(); if (!sc.hasAttribute('tabindex')) sc.setAttribute('tabindex', '-1'); sc.focus({ preventScroll: true }); return document.activeElement === sc; })()`);
      await key('ArrowUp', 'ArrowUp', 38);
    } else {
      const px = input === 'drag30' ? 30 : 60;
      await cdp.evaluate(`(() => { const sc = window.__r1.scroller(); sc.scrollTop -= ${px}; return true; })()`);
      await pump(400);
    }
    const after = await step(`${input}: user moved up`);
    await feed(sid, 15);
    const held = await step(`${input}: after more streaming`);
    out.steps[out.steps.length - 1].pulledBack = held.fromBottom < 2 && after.fromBottom >= 2;
  }
}

if (mode === 'anchor') {
  const { sid, total } = await cdp.evaluate(`window.__r1.open('F02', 'anchor', 4)`);
  await pump(800);
  // 4 finished F01 turns + the first ~200 F02 events (running, groups open).
  await feed(sid, total - 70);
  await cdp.evaluate(`(() => { const sc = window.__r1.scroller(); const w = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) if (w.currentNode.nodeValue.includes('阶段正文 2')) { const el = w.currentNode.parentElement; sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 120; break; }
    return true; })()`);
  await pump(800);
  const a0 = await cdp.evaluate(`window.__r1.rect('阶段正文 2')`);
  await step('anchor set (reading 阶段正文 2)', { anchor: a0 });
  await feed(sid, 30);
  const a1 = await cdp.evaluate(`window.__r1.rect('阶段正文 2')`);
  await step('content grew below', { anchor: a1, delta: a1 && a0 ? a1.top - a0.top : null });
  // Click the summary of the last process group that is on screen above the anchor; the clicked control is the anchor here.
  const summary = `(() => { const sc = window.__r1.scroller(); const vt = sc.getBoundingClientRect().top;
    const vb = sc.getBoundingClientRect().bottom;
    const d = [...sc.querySelectorAll('details')].find((x) => { const t = x.querySelector('summary').getBoundingClientRect().top; return t > vt && t < vb - 40; });
    if (!d) return null; window.__r1Summary = d.querySelector('summary'); return Math.round(window.__r1Summary.getBoundingClientRect().top); })()`;
  const s0 = await cdp.evaluate(summary);
  await cdp.evaluate(`(() => { window.__r1Summary?.click(); return true; })()`);
  await pump(800);
  const s1 = await cdp.evaluate(`window.__r1Summary ? Math.round(window.__r1Summary.getBoundingClientRect().top) : null`);
  await step('visible group above toggled', { summaryTop: [s0, s1], delta: s0 != null && s1 != null ? s1 - s0 : null });
  // Re-read the answer as the anchor, then let the turn finish (open groups above it settle/collapse).
  await cdp.evaluate(`(() => { window.__r1Summary?.click(); return true; })()`); // restore the toggled group
  await pump(600);
  const openBefore = await cdp.evaluate(`[...window.__r1.scroller().querySelectorAll('details')].map((d) => (d.open ? 1 : 0)).join('')`);
  const b0 = await cdp.evaluate(`window.__r1.rect('阶段正文 2')`);
  await feed(sid, 1000);
  await pump(1000);
  const b1 = await cdp.evaluate(`window.__r1.rect('阶段正文 2')`);
  const openAfter = await cdp.evaluate(`[...window.__r1.scroller().querySelectorAll('details')].map((d) => (d.open ? 1 : 0)).join('')`);
  await step('turn completed (open groups settle)', { anchor: [b0, b1], delta: b0 && b1 ? b1.top - b0.top : null, openBefore, openAfter });
}

if (mode === 'isolate') {
  const A = (await cdp.evaluate(`window.__r1.open('F02', 'iso-a', 4)`)).sid;
  await pump(600);
  await feed(A, 1000);
  await pump(600);
  // In A: expand the 2nd group and scroll to the middle.
  await cdp.evaluate(`(() => { const d = [...(window.__r1.scroller() ?? document).querySelectorAll('details')][1]; d?.querySelector('summary').click(); return true; })()`);
  await pump(500);
  await cdp.evaluate(`(() => { const sc = window.__r1.scroller(); sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) / 2); return true; })()`);
  await pump(600);
  const openA = `[...(window.__r1.scroller() ?? document).querySelectorAll('details')].map((d) => d.open ? 1 : 0).join('')`;
  await step('A: expanded group 2, scrolled to middle', { open: await cdp.evaluate(openA) });
  const B = (await cdp.evaluate(`window.__r1.open('F01', 'iso-b')`)).sid;
  await pump(600);
  await feed(B, 1000);
  await pump(800);
  await step('B: opened', { open: await cdp.evaluate(openA) });
  // Back to A through the sidebar row, like a user.
  const clicked = await cdp.evaluate(`(() => { const row = [...document.querySelectorAll('div,button,a')].find((e) => (e.innerText || '').trim() === 'R1 F02 iso-a' && e.getBoundingClientRect().x < 272); row?.click(); return !!row; })()`);
  await pump(1200);
  await step('A: back via sidebar', { clicked, open: await cdp.evaluate(openA) });
  await cdp.evaluate(`window.__r1.select(${JSON.stringify(B)})`);
  await pump(1000);
  await step('B: again', { open: await cdp.evaluate(openA) });
}

out.problems = cdp.problems.slice(0, 6).map((p) => p.text.split(repoRoot).join('<repo>').slice(0, 200));
fs.mkdirSync(path.resolve(here, '../results'), { recursive: true });
fs.writeFileSync(path.resolve(here, `../results/scroll-${mode}.json`), `${JSON.stringify(out, null, 2)}\n`);
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.resolve(here, `../shots/r1-scroll-${mode}.png`), Buffer.from(data, 'base64'));
cdp.close();
console.log(JSON.stringify(out, null, 2));
await sleep(0);
process.exit(0);
