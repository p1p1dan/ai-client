#!/usr/bin/env node
/**
 * p1-7d-items-fghi.mjs — batch 3 of the P1-7d GUI point-check: checklist
 * sections F (legacy chats moved to the current engine, the 1.0.x fork),
 * G (the plugins page and plugin tool rows), H (the one-time legacy-asset
 * notice and the Extensions page) and I (the approval card's reason line and
 * grants, bash only).
 *
 * Same scratch, CDP port and privacy-checked shots as p1-7d-gui.mjs (whose
 * `lib` this uses) and batch 2's helpers (`cde`); batch 1 and 2 drivers are
 * untouched.
 *
 *   P17D_SCRATCH=/tmp/aiclient-p17d3 node p1-7d-items-fghi.mjs <item> [args]
 *
 *   g1 | g2 | g2b [tag] | g3 | g3reopen <suffix> [tag]            section G
 *   i1 | i2 | i3                                                   section I
 *   inject-legacy | inject-extra | diverge [key…]                  F set-up, app stopped
 *   f1 | f2tree | f2compact | f3busy [key tag] | f3missing [key tag]   F, before `diverge`
 *   f4 | f5text | f5image | f5manual [key tag] | f5check [tag]     F, after `diverge`
 *   rename <suffix> <name> [tag]                                   sidebar rename (focus probe)
 *   h-seed <with-assets|clean>                                     H set-up, after `setup`, app stopped
 *   h-state <tag> | h-notice <tag> <button|esc|backdrop|none> [ms] H1 / H2 at a fresh start
 *   h3 [tag] | h3redetect [tag] | h3caps [tag]                     section H
 *   snap <shot> [<result>]                                         privacy-checked shot of what is open
 *
 * F uses five 1.0.x rows (L1–L5, `inject-legacy`, no `piLeaf`) and two more
 * (L6, L7, `inject-extra`, with the `piLeaf` a 1.0.x turn leaves); `diverge`
 * appends one 1.0.x exchange to a migrated chat's kept legacy file (instead of
 * reinstalling 1.0.x). H scratches: /tmp/aiclient-p17d3h1 (leftovers seeded),
 * /tmp/aiclient-p17d3h2 (clean, launched with P17D_NO_OPEN_PATH=1).
 *
 * Every item prints a JSON result and writes it to ../results/<ID>.json.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { lib } = await import(path.join(here, 'p1-7d-gui.mjs'));
const { cde } = await import(path.join(here, 'p1-7d-items-cde.mjs'));
const { attach, makeEval, sendText, STORE, sleep } = lib;
const { shot, save, newChat, setGear, pressKey } = cde;

// ---- shared helpers -------------------------------------------------------------------

const BUSY = ['starting', 'running', 'stopping', 'waiting_permission', 'waiting_question'];

/** Open dialogs (Base UI keeps closed ones in the DOM with data-closed). */
const OPEN_DIALOGS = `[...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter((d) => d.getAttribute('data-open') !== null).map((d) => ({ role: d.getAttribute('role'), text: (d.innerText || '').slice(0, 2500), buttons: [...d.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim()) }))`;

/** The approval cards on screen: the text of each card around a 「直接允许」 / 「本会话内允许」 button. */
const CARDS = `(() => {
  const out = [];
  const seen = new Set();
  for (const b of document.querySelectorAll('button')) {
    const t = (b.innerText || '').trim();
    if (b.offsetParent === null || !['直接允许', '本会话内允许', '拒绝'].includes(t)) continue;
    let card = b;
    for (let i = 0; i < 10 && card.parentElement; i += 1) {
      card = card.parentElement;
      if (/rounded/.test(card.className) && /border/.test(card.className) && (card.innerText || '').length > 60) break;
    }
    if (seen.has(card)) continue;
    seen.add(card);
    const r = card.getBoundingClientRect();
    out.push({
      text: (card.innerText || '').replace(/\\n+/g, ' | ').slice(0, 1200),
      lines: (card.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean).slice(0, 40),
      buttons: [...card.querySelectorAll('button')].filter((n) => n.offsetParent !== null).map((n) => (n.innerText || n.getAttribute('aria-label') || '').trim()),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  return out;
})()`;

const clickCardButton = (label) => `(() => {
  const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && !n.disabled && (n.innerText || '').trim() === ${JSON.stringify(label)});
  if (!b) return false;
  b.click();
  return true;
})()`;

const TURN_HEADS = `[...document.querySelectorAll('summary, [data-testid="turn-head"], [data-testid="auto-turn-head"]')].filter((n) => n.offsetParent !== null).map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160))`;

const COMPOSER = `(() => {
  const ta = document.querySelector('textarea');
  return ta ? { value: ta.value, placeholder: ta.getAttribute('placeholder'), disabled: ta.disabled } : null;
})()`;

async function status(evalAsync, sid) {
  return lib.turnStatus(evalAsync, sid);
}

/** Wait for a turn: busy first, then three idle reads; answers nothing on the way. */
async function waitSettled(evalAsync, sid, { timeoutMs = 120_000 } = {}) {
  return lib.waitTurn(evalAsync, sid, { timeoutMs });
}

async function waitForStatus(evalAsync, sid, wanted, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let st = null;
  while (Date.now() < deadline) {
    st = await status(evalAsync, sid);
    if (wanted.includes(st.status)) return st;
    await sleep(250);
  }
  return { ...st, timedOut: true };
}

const sessionRow = (evalAsync, sid) =>
  evalAsync(
    `${STORE}
     const x = s.sessions.find((r) => r.id === ${JSON.stringify(sid)});
     return x ? { id: x.id, title: x.title, status: x.status, agent: x.agent ?? null, forkTitlePending: x.forkTitlePending ?? null, legacyDiverged: x.legacyDiverged ?? null } : null;`,
    { label: 'session row' }
  );

const allRows = (evalAsync) =>
  evalAsync(
    `${STORE}
     return s.sessions.map((x) => ({ id: x.id, title: x.title, status: x.status, agent: x.agent ?? null, forkTitlePending: x.forkTitlePending ?? null, legacyDiverged: x.legacyDiverged ?? null, messages: (s.messages[x.id] ?? []).length }));`,
    { label: 'all rows' }
  );

/** Sidebar rows by title: the row's text, title attribute and any badge on it. */
const SIDEBAR_ROWS = (needle) => `(() => {
  const rows = [...document.querySelectorAll('[role="button"][title]')].filter((n) => n.offsetParent !== null && (n.getAttribute('title') || '').includes(${JSON.stringify(needle)}));
  return rows.map((n) => {
    const r = n.getBoundingClientRect();
    return {
      title: n.getAttribute('title'),
      text: (n.innerText || '').replace(/\\s+/g, ' ').trim(),
      selected: n.getAttribute('aria-current') ?? n.getAttribute('data-active') ?? null,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      badges: [...n.querySelectorAll('[data-slot="badge"]')].map((b) => ({ text: (b.innerText || '').trim(), title: b.getAttribute('title'), aria: b.getAttribute('aria-label'), cls: b.className.split(' ').filter((c) => /warning|variant|bg-|text-/.test(c)).join(' '), color: getComputedStyle(b).color, bg: getComputedStyle(b).backgroundColor })),
    };
  });
})()`;

const clickSidebarRow = (title, index = 0) => `(() => {
  const rows = [...document.querySelectorAll('[role="button"][title]')].filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(title)});
  const row = rows[${index}];
  if (!row) return { ok: false, matches: rows.length };
  row.click();
  return { ok: true, matches: rows.length };
})()`;

/** Settings through the app's own intent store (what `/settings` and the gear button use). */
async function openSettings(cdp, evalAsync, category) {
  await evalAsync(
    `const m = await import(/* @vite-ignore */ '/stores/settingsIntent.ts');
     m.useSettingsIntentStore.getState().requestSettings(${JSON.stringify(category)});
     return true;`,
    { label: 'open settings' }
  );
  await sleep(1500);
  await lib.pumpFrames(cdp, 600);
}

/** The settings view's category buttons and whether one is current. */
const SETTINGS_NAV = `[...document.querySelectorAll('button[aria-current], nav button')].filter((b) => b.offsetParent !== null).map((b) => ((b.innerText || '').trim() + (b.getAttribute('aria-current') ? ' *' : ''))).filter(Boolean).slice(0, 30)`;

/** A settings section block by its heading text: its text, headings and badges. */
const SECTION = (heading, mustInclude = null) => `(() => {
  const h = [...document.querySelectorAll('h2, h3, h4')].find((n) => n.offsetParent !== null && (n.innerText || '').trim() === ${JSON.stringify(heading)});
  if (!h) return null;
  const must = ${JSON.stringify(mustInclude)};
  let box = h;
  for (let i = 0; i < 8 && box.parentElement; i += 1) {
    box = box.parentElement;
    if (must ? (box.innerText || '').includes(must) : (box.innerText || '').length > (h.innerText || '').length + 40) break;
  }
  const r = box.getBoundingClientRect();
  return {
    text: box.innerText,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    badges: [...box.querySelectorAll('[data-slot="badge"]')].map((b) => ({ text: (b.innerText || '').trim(), variant: b.getAttribute('data-variant') ?? b.className.split(' ').filter((c) => /warning|info|success|outline|secondary|error/.test(c)).join(' ') })),
    switches: [...box.querySelectorAll('[role="switch"]')].map((sw) => ({ checked: sw.getAttribute('aria-checked') ?? sw.getAttribute('data-checked'), disabled: sw.hasAttribute('data-disabled') || sw.getAttribute('aria-disabled') === 'true' })),
  };
})()`;

/** Headings of the settings content pane, in order. */
const SETTINGS_HEADINGS = `[...document.querySelectorAll('h1, h2, h3, h4')].filter((n) => n.offsetParent !== null).map((n) => (n.innerText || '').trim()).filter(Boolean)`;

const scrollIntoView = (text) => `(() => {
  const h = [...document.querySelectorAll('h1, h2, h3, h4')].find((n) => n.offsetParent !== null && (n.innerText || '').trim() === ${JSON.stringify(text)});
  if (!h) return false;
  h.scrollIntoView({ block: 'start' });
  return true;
})()`;

async function closeSettings(cdp) {
  await pressKey(cdp, 'Escape');
  await sleep(600);
  const still = await cdp.evaluate(
    `!!document.querySelector('[data-slot="dialog-popup"][data-open]')`
  );
  if (still) {
    await cdp.evaluate(`(() => {
      const d = document.querySelector('[data-slot="dialog-popup"][data-open]');
      const b = d && [...d.querySelectorAll('button')].find((n) => (n.getAttribute('aria-label') || n.innerText || '').trim() === '关闭' || (n.getAttribute('aria-label') || '') === 'Close');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(600);
  }
}

// ---- G: the plugins page ------------------------------------------------------------------

async function pluginsState(evalAsync) {
  return evalAsync(`return await window.electronAPI.dshPlugins.list();`, {
    label: 'plugins list',
  });
}

async function g1() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = { state: await pluginsState(evalAsync) };
  await openSettings(cdp, evalAsync, 'extensions');
  out.nav = await cdp.evaluate(SETTINGS_NAV);
  out.headings = await cdp.evaluate(SETTINGS_HEADINGS);
  await cdp.evaluate(scrollIntoView('插件'));
  await sleep(500);
  out.section = await cdp.evaluate(SECTION('插件', 'dsh-office-tools'));
  const text = out.section?.text ?? '';
  out.piWords = (text.match(/\bpi\b|\bPi\b|\bPI\b|pi-/g) ?? []).length;
  out.shot = await shot(cdp, 'G1-plugins-page', { bottom: false });
  cdp.close();
  save('G1', out);
}

async function g2() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = { hostsBefore: cde.hostPids() };
  await openSettings(cdp, evalAsync, 'extensions');
  await cdp.evaluate(scrollIntoView('插件'));
  await sleep(400);
  out.before = await cdp.evaluate(SECTION('插件', 'dsh-office-tools'));
  // Click the switch and sample the section every ~30 ms while the save runs.
  const t0 = Date.now();
  out.click = await cdp.evaluate(`(() => {
    const h = [...document.querySelectorAll('h2, h3, h4')].find((n) => (n.innerText || '').trim() === '插件');
    let box = h; for (let i = 0; i < 6 && box.parentElement; i += 1) box = box.parentElement;
    const sw = box.querySelector('[role="switch"]');
    if (!sw) return 'no switch';
    sw.click();
    return 'clicked';
  })()`);
  out.samples = [];
  for (let i = 0; i < 40; i += 1) {
    const sec = await cdp.evaluate(SECTION('插件', 'dsh-office-tools'));
    out.samples.push({
      dt: Date.now() - t0,
      switches: sec?.switches,
      badges: sec?.badges?.map((b) => b.text),
    });
    if (i > 5 && sec?.switches?.every((s) => !s.disabled)) break;
    await sleep(30);
  }
  out.after = await cdp.evaluate(SECTION('插件', 'dsh-office-tools'));
  out.shotPending = await shot(cdp, 'G2-switch-on-pending', { bottom: false });
  out.stateAfterToggle = await pluginsState(evalAsync);
  // The engine restarts on its own once idle: watch the host pid change.
  const deadline = Date.now() + 60_000;
  let hosts = cde.hostPids();
  while (Date.now() < deadline) {
    hosts = cde.hostPids();
    if (hosts.length === 1 && !out.hostsBefore.includes(hosts[0])) break;
    await lib.pumpFrames(cdp, 500);
  }
  out.hostsAfter = hosts;
  out.restartSeenAfterMs = Date.now() - t0;
  // Wait for the new host to report, then read the page without re-entering it.
  for (let i = 0; i < 30; i += 1) {
    const st = await pluginsState(evalAsync);
    if (st.plugins?.[0]?.host?.state === 'loaded') {
      out.stateLoaded = st;
      break;
    }
    await sleep(500);
  }
  await lib.pumpFrames(cdp, 800);
  out.pageStillOpen = await cdp.evaluate(SECTION('插件', 'dsh-office-tools'));
  out.shotStillOpen = await shot(cdp, 'G2-after-restart-same-page', { bottom: false });
  // Leave and come back to the page.
  await closeSettings(cdp);
  await openSettings(cdp, evalAsync, 'extensions');
  await cdp.evaluate(scrollIntoView('插件'));
  await sleep(600);
  out.reentered = await cdp.evaluate(SECTION('插件', 'dsh-office-tools'));
  out.shotReentered = await shot(cdp, 'G2-after-restart-reentered', { bottom: false });
  await closeSettings(cdp);
  cdp.close();
  save('G2', out);
}

/** G2, second look: the page once the engine has started again (it starts on demand). */
async function g2b(tag = 'G2-loaded') {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = { hosts: cde.hostPids(), state: await pluginsState(evalAsync) };
  await openSettings(cdp, evalAsync, 'extensions');
  await cdp.evaluate(scrollIntoView('插件'));
  await sleep(600);
  out.section = await cdp.evaluate(SECTION('插件', 'dsh-office-tools'));
  out.shot = await shot(cdp, tag, { bottom: false });
  await closeSettings(cdp);
  cdp.close();
  save(tag, out);
}

/** Tool rows of the active transcript whose text mentions `needle`. */
const ROWS_WITH = (needle) => `(() => {
  const all = [...document.querySelectorAll('*')].filter((n) => n.offsetParent !== null && n.children.length > 0 && n.children.length < 12 && (n.innerText || '').includes(${JSON.stringify(needle)}) && (n.innerText || '').length < 220);
  const rows = all.filter((n) => ![...n.children].some((c) => (c.innerText || '').includes(${JSON.stringify(needle)}) && (c.innerText || '').length === (n.innerText || '').length));
  return rows.slice(0, 6).map((n) => {
    const titleEl = [...n.querySelectorAll('span, div')].find((c) => (c.innerText || '').trim().startsWith(${JSON.stringify(needle)}.split(' ')[0]) && c.children.length === 0);
    const cs = titleEl ? getComputedStyle(titleEl) : null;
    return {
      text: (n.innerText || '').replace(/\\s+/g, ' ').trim(),
      svg: n.querySelector('svg')?.getAttribute('class')?.split(' ').filter((c) => c.startsWith('lucide')).join(' ') ?? null,
      title: titleEl ? { text: titleEl.innerText, cls: titleEl.className, whiteSpace: cs.whiteSpace, overflow: cs.overflow, textOverflow: cs.textOverflow, fontFamily: cs.fontFamily.slice(0, 40) } : null,
    };
  });
})()`;

async function g3() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1200);
  const out = { sid, gear: await setGear(cdp, '每次询问') };
  const t0 = await sendText(cdp, 'P0-OFFICE: create a report, then read it back.');
  out.cards = [];
  let seenBusy = false;
  let idle = 0;
  const heads = [];
  while (Date.now() - t0 < 150_000) {
    const st = await status(evalAsync, sid);
    if (BUSY.includes(st.status)) {
      seenBusy = true;
      idle = 0;
      const h = await cdp.evaluate(TURN_HEADS);
      if (heads.at(-1)?.join('|') !== h.join('|')) heads.push(h);
    } else if (seenBusy && ++idle >= 3) break;
    if (st.status === 'waiting_permission') {
      const cards = await cdp.evaluate(CARDS);
      out.cards.push({ dt: Date.now() - t0, cards });
      if (out.cards.length === 1) {
        out.headsAtCard = await cdp.evaluate(TURN_HEADS);
        out.rowsAtCard = await cdp.evaluate(ROWS_WITH('Create'));
        out.shotCard = await shot(cdp, 'G3-word-create-card');
      }
      await cdp.evaluate(clickCardButton('直接允许'));
      await sleep(600);
    }
    await sleep(300);
  }
  out.heads = heads;
  out.final = await status(evalAsync, sid);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(500);
  out.rowsCreate = await cdp.evaluate(ROWS_WITH('Create p0-report.docx'));
  out.rowsRead = await cdp.evaluate(ROWS_WITH('Read p0-report.docx'));
  out.transcript = await cdp.evaluate(cde.TRANSCRIPT);
  out.permissionRequests = await evalAsync(
    `${STORE}
     const blocks = (s.messages[${JSON.stringify(sid)}] ?? []).flatMap((m) => m.blocks ?? []);
     return blocks.filter((b) => b.type === 'tool_call').map((b) => ({ name: b.toolName, presentation: b.toolPresentation ?? null }));`,
    { label: 'tool calls' }
  );
  out.shotRows = await shot(cdp, 'G3-office-rows');
  // A narrow window, to see the plugin title truncate on one line.
  cdp.close();
  save('G3', out);
}

async function g3reopen(suffix, tag = 'G3-reopen') {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = { opened: await cde.openBySuffix(cdp, evalAsync, suffix) };
  await sleep(1500);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(500);
  out.rowsCreate = await cdp.evaluate(ROWS_WITH('Create p0-report.docx'));
  out.rowsRead = await cdp.evaluate(ROWS_WITH('Read p0-report.docx'));
  out.transcript = await cdp.evaluate(cde.TRANSCRIPT);
  out.shot = await shot(cdp, `${tag}-rows`);
  cdp.close();
  save(tag, out);
}

// ---- I: approval card reason line, grants, Stop while held ----------------------------------

async function turnWithCards(cdp, evalAsync, sid, t0, onCard, { timeoutMs = 150_000 } = {}) {
  const log = [];
  let seenBusy = false;
  let idle = 0;
  let n = 0;
  while (Date.now() - t0 < timeoutMs) {
    const st = await status(evalAsync, sid);
    if (BUSY.includes(st.status)) {
      seenBusy = true;
      idle = 0;
    } else if (seenBusy && ++idle >= 3) return { settled: true, log };
    if (st.status === 'waiting_permission') {
      const cards = await cdp.evaluate(CARDS);
      if (cards.length) {
        n += 1;
        const action = await onCard(n, cards);
        log.push({ dt: Date.now() - t0, n, cards, action });
        await sleep(900);
        continue;
      }
    }
    await sleep(300);
  }
  return { settled: false, log };
}

async function i1() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1200);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  const t0 = await sendText(cdp, 'P1-S18 {"case":"auto","shell":"bash"}');
  out.turn = await turnWithCards(cdp, evalAsync, sid, t0, async (n) => {
    if (n === 1) {
      out.shotCard = await shot(cdp, 'I1-reason-line-card');
      out.cardDom = await cdp.evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && (n.innerText || '').trim() === '直接允许');
        let card = b; for (let i = 0; i < 10 && card.parentElement; i += 1) { card = card.parentElement; if ((card.innerText || '').includes('项目') || (card.innerText || '').length > 200) break; }
        const lines = [...card.querySelectorAll('p, div, span')].filter((n) => n.children.length === 0 && (n.innerText || '').trim()).map((n) => ({ text: (n.innerText || '').trim().slice(0, 140), color: getComputedStyle(n).color, y: Math.round(n.getBoundingClientRect().y) }));
        return lines;
      })()`);
    }
    await cdp.evaluate(clickCardButton('直接允许'));
    return 'allow';
  });
  out.final = await status(evalAsync, sid);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(400);
  out.reasonLineStill = await cdp.evaluate(
    `document.body.innerText.includes('无法静态判断会碰哪些文件')`
  );
  out.transcript = await cdp.evaluate(cde.TRANSCRIPT);
  out.calls = await cde.bashCalls(evalAsync, sid);
  out.shotAfter = await shot(cdp, 'I1-after-settle');
  cdp.close();
  save('I1', out);
}

async function i2() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1200);
  const out = { sid, gear: await setGear(cdp, '每次询问') };
  const t0 = await sendText(cdp, 'P1-PERM-GRANTS: echo three times.');
  out.turn = await turnWithCards(cdp, evalAsync, sid, t0, async (n) => {
    if (n === 1) {
      out.shotFirst = await shot(cdp, 'I2-first-card-grant-hint');
      await cdp.evaluate(clickCardButton('本会话内允许'));
      return 'session';
    }
    out.shotSecond = await shot(cdp, `I2-card-${n}`);
    await cdp.evaluate(clickCardButton('直接允许'));
    return 'allow';
  });
  out.final = await status(evalAsync, sid);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(400);
  out.calls = await cde.bashCalls(evalAsync, sid);
  out.transcript = await cdp.evaluate(cde.TRANSCRIPT);
  out.activity = await cdp.evaluate(
    `[...document.querySelectorAll('*')].filter((n) => n.offsetParent !== null && n.children.length === 0 && /已允许|本会话/.test(n.innerText || '')).map((n) => (n.innerText || '').trim().slice(0, 100))`
  );
  out.shotAfter = await shot(cdp, 'I2-after-settle');
  cdp.close();
  save('I2', out);
}

async function i3() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1200);
  const out = { sid, gear: await setGear(cdp, '每次询问') };
  const t0 = await sendText(cdp, 'P1-PERM-HOLD: hold at the gate.');
  out.waiting = await waitForStatus(evalAsync, sid, ['waiting_permission'], 60_000);
  await sleep(800);
  out.cardsBefore = await cdp.evaluate(CARDS);
  out.shotHeld = await shot(cdp, 'I3-card-held');
  const stopAt = Date.now();
  out.stop = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button[aria-label]')].find((n) => n.getAttribute('aria-label') === '停止当前回合' && n.offsetParent !== null);
    if (!b) return false; b.click(); return true;
  })()`);
  const samples = [];
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    samples.push({
      dt: Date.now() - stopAt,
      status: (await status(evalAsync, sid)).status,
      cards: (await cdp.evaluate(CARDS)).length,
    });
  }
  out.samples = samples;
  out.settled = await waitSettled(evalAsync, sid, { timeoutMs: 30_000 });
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(500);
  out.transcript = await cdp.evaluate(cde.TRANSCRIPT);
  out.calls = await cde.bashCalls(evalAsync, sid);
  out.shotAfter = await shot(cdp, 'I3-after-stop');
  out.sentAt = t0;
  cdp.close();
  save('I3', out);
}

// ---- F: legacy chats -----------------------------------------------------------------------

const repoRoot = path.resolve(here, '../../../../../../..');
const LEGACY_CORPUS = 'src/shared/__tests__/fixtures/legacy-pi/v4-basic.jsonl';
/** The five 1.0.x chats this batch injects; the key names what each is for. */
const LEGACY_ROWS = [
  { key: 'L1', title: '旧会话甲：整理笔记', use: 'F1 (send), then F4 / F5 text' },
  { key: 'L2', title: '旧会话乙：看图', use: 'F2 (会话分支), then F5 image only' },
  { key: 'L3', title: '旧会话丙：写摘要', use: 'F2 (/compact), then F5 manual rename' },
  { key: 'L4', title: '旧会话丁：文件被占用', use: 'F3 source_busy (retryable)' },
  { key: 'L5', title: '旧会话戊：文件已删除', use: 'F3 source_missing (not retryable)' },
];
const legacyStateFile = () => path.join(lib.SCRATCH, 'legacy-rows.json');
const readLegacyState = () => JSON.parse(fs.readFileSync(legacyStateFile(), 'utf8'));
const agentDirOf = () => path.join(lib.dirs.home, '.pilab', 'jyw-ai-client-dev', 'pi-agent');

function appIsDown() {
  const c = lib.classify();
  return c.devRoot.length === 0 && c.electronMain.length === 0;
}

/**
 * Five `pi` rows naming real-format v4 files (the P1-9g corpus `v4-basic.jsonl`,
 * synthetic data), written while the app is down — the state a user who ran
 * 1.0.x leaves behind. Files go where 1.0.x kept them, under the agent
 * directory's `sessions/`; the header's id and cwd are rewritten per copy.
 */
function injectLegacy() {
  if (!appIsDown()) throw new Error('the app is still running; quit it first');
  const index = lib.readIndex();
  if (!index.file) throw new Error('no session-index.json yet');
  if (fs.existsSync(legacyStateFile())) throw new Error('already injected');
  const source = fs.readFileSync(path.join(repoRoot, LEGACY_CORPUS), 'utf8').split('\n');
  const dir = path.join(agentDirOf(), 'sessions', '--tmp-aiclient-p17d3-workspace--');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(index.file, `${index.file}.before-legacy-inject`);
  const now = Date.now();
  const rows = [];
  const made = [];
  LEGACY_ROWS.forEach((spec, i) => {
    const lines = [...source];
    const header = JSON.parse(lines[0]);
    const fileId = crypto.randomUUID();
    lines[0] = JSON.stringify({ ...header, id: fileId, cwd: lib.dirs.workspace });
    const file = path.join(dir, `2026-09-27T12-58-24-571Z_${fileId}.jsonl`);
    fs.writeFileSync(file, lines.join('\n'));
    const sessionId = `session-${now - 86_400_000 - i * 60_000}-lg${spec.key.toLowerCase()}`;
    const row = {
      sessionId,
      runtimeIdentity: file,
      agent: 'pi',
      workspacePath: lib.dirs.workspace,
      title: spec.title,
      updatedAt: now - 3_600_000 - i * 60_000,
      archived: false,
    };
    rows.push(row);
    made.push({ ...spec, sessionId, file, bytes: fs.statSync(file).size });
  });
  fs.writeFileSync(index.file, JSON.stringify([...index.rows, ...rows]));
  fs.writeFileSync(legacyStateFile(), JSON.stringify({ corpus: LEGACY_CORPUS, made }, null, 2));
  save('F-inject', { corpus: LEGACY_CORPUS, made, indexRowsBefore: index.rows.length });
}

/**
 * Two more 1.0.x chats for F3, added after the first run: this time each row
 * carries the `piLeaf` checkpoint 1.0.x commits once a turn has ended
 * (`src/main/ipc/chat.ts` `isUnwrittenPiSession`: a row without one whose file
 * is gone reads as "never written" and is repaired, not migrated — which is
 * what the first run's L5 hit). L6: a writer that never settles; L7: the file
 * deleted before the send.
 */
function injectExtra() {
  if (!appIsDown()) throw new Error('the app is still running; quit it first');
  const index = lib.readIndex();
  const state = readLegacyState();
  if (state.made.some((m) => m.key === 'L6')) throw new Error('already injected');
  const source = fs.readFileSync(path.join(repoRoot, LEGACY_CORPUS), 'utf8').split('\n');
  const dir = path.join(agentDirOf(), 'sessions', '--tmp-aiclient-p17d3-workspace--');
  fs.copyFileSync(index.file, `${index.file}.before-legacy-extra`);
  const now = Date.now();
  const specs = [
    { key: 'L6', title: '旧会话己：一直在被写', use: 'F3 source_busy, with piLeaf' },
    { key: 'L7', title: '旧会话庚：文件被删', use: 'F3 source_missing, with piLeaf' },
  ];
  const rows = [];
  specs.forEach((spec, i) => {
    const lines = [...source];
    const header = JSON.parse(lines[0]);
    const fileId = crypto.randomUUID();
    lines[0] = JSON.stringify({ ...header, id: fileId, cwd: lib.dirs.workspace });
    const file = path.join(dir, `2026-09-27T13-10-00-000Z_${fileId}.jsonl`);
    fs.writeFileSync(file, lines.join('\n'));
    const entries = lines.filter(Boolean).map((l) => JSON.parse(l));
    const piLeaf = {
      activeEntryId: entries.filter((e) => e.kind === 'entry' && e.type === 'message').at(-1).id,
      fileTailEntryId: entries.at(-1).id,
    };
    const sessionId = `session-${now - 86_400_000 - (i + 5) * 60_000}-lg${spec.key.toLowerCase()}`;
    rows.push({
      sessionId,
      runtimeIdentity: file,
      piLeaf,
      agent: 'pi',
      workspacePath: lib.dirs.workspace,
      title: spec.title,
      updatedAt: now - 3_600_000 - (i + 5) * 60_000,
      archived: false,
    });
    state.made.push({ ...spec, sessionId, file, bytes: fs.statSync(file).size, piLeaf });
  });
  fs.writeFileSync(index.file, JSON.stringify([...index.rows, ...rows]));
  fs.writeFileSync(legacyStateFile(), JSON.stringify(state, null, 2));
  save('F-inject-extra', { made: state.made.slice(-2) });
}

/**
 * F4 / F5 without reinstalling 1.0.x: while the app is down, append one more
 * exchange to the kept legacy file of each chat migrated in the first run, the
 * way 1.0.x continuing it after a rollback would. `listForDisplay` then lists
 * the kept `<id>_pi` row with `migrationDiverged` (size and mtime no longer
 * match `migratedFrom`); nothing is written into the index here.
 */
function diverge(...keys) {
  if (!appIsDown()) throw new Error('the app is still running; quit it first');
  const state = readLegacyState();
  const index = lib.readIndex();
  const out = [];
  for (const key of keys.length ? keys : ['L1', 'L2', 'L3']) {
    const made = state.made.find((m) => m.key === key);
    const migrated = index.rows.find(
      (r) => r.migratedFrom?.legacySessionId === `${made.sessionId}_pi`
    );
    const kept = index.rows.find((r) => r.sessionId === `${made.sessionId}_pi`);
    if (!migrated || !kept) {
      out.push({ key, skipped: 'not migrated in the first run' });
      continue;
    }
    const lines = fs.readFileSync(made.file, 'utf8').split('\n').filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l));
    const maxSeq = Math.max(...entries.map((e) => e.seq ?? 0));
    const lastMessage = entries.filter((e) => e.kind === 'entry' && e.type === 'message').at(-1);
    const lastAssistant = entries
      .filter((e) => e.kind === 'entry' && e.type === 'message' && e.message.role === 'assistant')
      .at(-1);
    const t = Date.now();
    const userId = crypto.randomUUID();
    const tag = `F5-CONTINUED-IN-1X-${key}`;
    const user = {
      kind: 'entry',
      lane: 'main',
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `在 1.0.x 里又问了一句：${tag} 还在吗？` }],
        timestamp: t,
      },
      id: userId,
      seq: maxSeq + 1,
      parentId: lastMessage.id,
      timestamp: t,
    };
    const assistant = {
      ...lastAssistant,
      message: {
        ...lastAssistant.message,
        content: [{ type: 'text', text: `1.0.x 的回答：${tag} 还在。` }],
        timestamp: t + 1,
      },
      id: crypto.randomUUID(),
      seq: maxSeq + 2,
      parentId: userId,
      timestamp: t + 1,
    };
    const before = fs.statSync(made.file);
    fs.appendFileSync(made.file, `\n${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`);
    const after = fs.statSync(made.file);
    out.push({
      key,
      keptRow: kept.sessionId,
      migratedRow: migrated.sessionId,
      tag,
      migratedFrom: {
        bytes: migrated.migratedFrom.sourceBytes,
        mtimeMs: migrated.migratedFrom.sourceMtimeMs,
      },
      before: { size: before.size, mtimeMs: Math.round(before.mtimeMs) },
      after: { size: after.size, mtimeMs: Math.round(after.mtimeMs) },
    });
  }
  save(keys.length ? `F4-diverge-${keys.join('')}` : 'F4-diverge', {
    how: 'appended one 1.0.x exchange per kept legacy file, app stopped',
    out,
  });
}

/** A screenshot taken right away: the privacy check, then one capture (no frame pumping). */
async function fastShot(cdp, name) {
  const text = await cdp.evaluate(lib.PAGE_PRIVACY_TEXT);
  const hits = lib.privacyHits(text);
  if (hits.length) throw new Error(`privacy check failed (${hits.join(', ')}); ${name} not saved`);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(lib.outDir, 'shots', `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  lib.log(`fast shot shots/${name}.png`);
  return `shots/${name}.png`;
}

const MIGRATION_VIEW = `(() => {
  const notice = [...document.querySelectorAll('[role="status"], [role="alert"]')].filter((n) => n.offsetParent !== null && (n.innerText || '').trim().length > 4).map((n) => { const r = n.getBoundingClientRect(); return { role: n.getAttribute('role'), text: (n.innerText || '').replace(/\\n+/g, ' | ').slice(0, 600), spinner: !!n.querySelector('[data-slot="spinner"], svg.animate-spin, .animate-spin'), buttons: [...n.querySelectorAll('button')].map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim()), top: Math.round(r.top), bottom: Math.round(r.bottom), inView: r.bottom > 40 && r.top < innerHeight }; });
  const ta = document.querySelector('textarea');
  return { notice, composer: ta ? { value: ta.value, placeholder: ta.getAttribute('placeholder'), disabled: ta.disabled } : null };
})()`;

async function openLegacy(cdp, evalAsync, key) {
  const made = readLegacyState().made.find((m) => m.key === key);
  const click = await cdp.evaluate(clickSidebarRow(made.title));
  await sleep(2500);
  await lib.pumpFrames(cdp, 600);
  return {
    made,
    click,
    active: await cde.activeSid(evalAsync),
    row: await sessionRow(evalAsync, made.sessionId),
  };
}

/** Send, then watch the move as closely as the page lets us (~40 ms a read). */
async function sendAndWatchMigration(
  cdp,
  _evalAsync,
  text,
  shotName,
  { ms = 20_000, scrollShotName = null } = {}
) {
  await cdp.evaluate(lib.typeIntoComposer(text));
  await cdp.waitFor(lib.SEND_READY, { timeoutMs: 30_000, label: 'send ready' });
  const t0 = Date.now();
  await cdp.evaluate(lib.CLICK_SEND);
  const trace = [];
  let shotFile = null;
  while (Date.now() - t0 < ms) {
    const v = await cdp.evaluate(MIGRATION_VIEW);
    const key = JSON.stringify(v);
    if (trace.at(-1)?.key !== key) trace.push({ dt: Date.now() - t0, key, v });
    const migrating = v.notice.some((n) => n.text.includes('正在把这个对话迁移到当前引擎'));
    if (migrating && !shotFile && shotName) {
      shotFile = await fastShot(cdp, shotName);
      if (scrollShotName) {
        // Where the notice is: scroll it into view, as a user scrolling up would.
        await cdp.evaluate(
          `(() => { const n = [...document.querySelectorAll('[role="status"]')].find((x) => (x.innerText || '').includes('正在把这个对话迁移')); n?.scrollIntoView({ block: 'center' }); return !!n; })()`
        );
        await sleep(150);
        trace.push({ dt: Date.now() - t0, key: 'scrolled', v: await cdp.evaluate(MIGRATION_VIEW) });
        await fastShot(cdp, scrollShotName);
      }
    }
    const failed = v.notice.some((n) => n.text.includes('没能迁移'));
    if (failed) break;
    if (!migrating && trace.length > 1 && trace.some((x) => x.key.includes('正在把这个对话迁移')))
      break;
    await sleep(40);
  }
  return { t0, shot: shotFile, trace: trace.map(({ dt, v }) => ({ dt, ...v })) };
}

async function f1() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = await openLegacy(cdp, evalAsync, 'L1');
  const sid = out.made.sessionId;
  out.preview = {
    view: await cdp.evaluate(MIGRATION_VIEW),
    transcript: await cdp.evaluate(cde.TRANSCRIPT),
  };
  out.shotPreview = await shot(cdp, 'F1-legacy-placeholder');
  out.send = await sendAndWatchMigration(
    cdp,
    evalAsync,
    'P0-RECALL {"markers":["alpha and beta","A single red pixel","Wrote out/summary.md"]} 旧对话里说过什么？',
    'F1-migrating'
  );
  out.turn = await waitSettled(evalAsync, null, { timeoutMs: 90_000 });
  out.activeAfter = await cde.activeSid(evalAsync);
  out.rowAfter = await sessionRow(evalAsync, out.activeAfter);
  out.rows = await allRows(evalAsync);
  out.transcript = await cdp.evaluate(cde.TRANSCRIPT);
  out.shotAfter = await shot(cdp, 'F1-after-migration');
  out.index = lib
    .readIndex()
    .rows.filter((r) => r.sessionId.startsWith(sid))
    .map((r) => ({
      sessionId: r.sessionId,
      agent: r.agent,
      title: r.title,
      migratedTo: r.migratedTo ?? null,
      migratedFrom: r.migratedFrom
        ? { legacySessionId: r.migratedFrom.legacySessionId, converter: r.migratedFrom.converter }
        : null,
    }));
  cdp.close();
  save('F1', out);
}

async function f2tree() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = await openLegacy(cdp, evalAsync, 'L2');
  out.preview = await cdp.evaluate(MIGRATION_VIEW);
  const t0 = Date.now();
  out.click = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || n.getAttribute('aria-label') || '').trim() === '会话分支' && n.offsetParent !== null);
    if (!b) return 'no button'; if (b.disabled) return 'disabled'; b.click(); return 'clicked';
  })()`);
  const trace = [];
  let shotMigrating = null;
  while (Date.now() - t0 < 20_000) {
    const v = {
      ...(await cdp.evaluate(MIGRATION_VIEW)),
      dialogs: (await cdp.evaluate(OPEN_DIALOGS)).map((d) => d.text.slice(0, 300)),
    };
    const key = JSON.stringify(v);
    if (trace.at(-1)?.key !== key) trace.push({ dt: Date.now() - t0, key, v });
    if (!shotMigrating && v.notice.some((n) => n.text.includes('正在把这个对话迁移')))
      shotMigrating = await fastShot(cdp, 'F2-tree-migrating');
    if (v.dialogs.length && v.dialogs[0].includes('回退')) break;
    if (v.notice.some((n) => n.text.includes('没能迁移'))) break;
    await sleep(40);
  }
  out.trace = trace.map(({ dt, v }) => ({ dt, ...v }));
  out.shotMigrating = shotMigrating;
  await sleep(800);
  out.dialog = await cdp.evaluate(OPEN_DIALOGS);
  out.shotDialog = await shot(cdp, 'F2-tree-dialog-after-migration', { bottom: false });
  out.toasts = await cdp.evaluate('window.__p17dToasts ?? []');
  await pressKey(cdp, 'Escape');
  await sleep(600);
  out.rowAfter = await sessionRow(evalAsync, out.made.sessionId);
  out.errors = await evalAsync(
    `${STORE} return { lastError: s.lastError ?? null, historyError: s.historyErrors?.[${JSON.stringify(out.made.sessionId)}] ?? null };`,
    { label: 'errors' }
  );
  cdp.close();
  save('F2-tree', out);
}

async function f2compact() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = await openLegacy(cdp, evalAsync, 'L3');
  out.preview = await cdp.evaluate(MIGRATION_VIEW);
  await cdp.evaluate(lib.typeIntoComposer(''));
  await cdp.evaluate(`(() => { document.querySelector('textarea').focus(); return true; })()`);
  await cdp.send('Input.insertText', { text: '/compact' });
  await sleep(700);
  const t0 = Date.now();
  await pressKey(cdp, 'Enter');
  await sleep(500);
  const afterFirst = await cdp.evaluate(COMPOSER);
  if (afterFirst?.value?.trim().startsWith('/compact')) await pressKey(cdp, 'Enter');
  const trace = [];
  let shotMigrating = null;
  while (Date.now() - t0 < 40_000) {
    const v = await cdp.evaluate(MIGRATION_VIEW);
    const st = await status(evalAsync, null);
    const key = JSON.stringify([v, st.status]);
    if (trace.at(-1)?.key !== key) trace.push({ dt: Date.now() - t0, key, v, status: st.status });
    if (!shotMigrating && v.notice.some((n) => n.text.includes('正在把这个对话迁移')))
      shotMigrating = await fastShot(cdp, 'F2-compact-migrating');
    if (trace.length > 2 && !BUSY.includes(st.status) && Date.now() - t0 > 8000) break;
    await sleep(60);
  }
  out.trace = trace.map(({ dt, v, status: s2 }) => ({ dt, status: s2, ...v }));
  out.shotMigrating = shotMigrating;
  out.toasts = await cdp.evaluate('window.__p17dToasts ?? []');
  out.rowAfter = await sessionRow(evalAsync, out.made.sessionId);
  out.transcript = await cdp.evaluate(cde.TRANSCRIPT);
  out.errors = await evalAsync(
    `${STORE} return { lastError: s.lastError ?? null, historyError: s.historyErrors?.[${JSON.stringify(out.made.sessionId)}] ?? null };`,
    { label: 'errors' }
  );
  out.gateway = lib
    .gatewayLog()
    .slice(-3)
    .map((l) => ({
      status: l.status,
      label: l.label ?? l.decision?.label ?? null,
      scenario: l.decision?.scenario ?? null,
    }));
  out.shotAfter = await shot(cdp, 'F2-compact-after');
  cdp.close();
  save('F2-compact', out);
}

/** Keep changing the file's mtime (1 ms steps) for `ms`: a writer that never settles. */
function startToucher(file, ms, processes = 3) {
  // Several writers: on this 2-core box one busy writer gets descheduled long
  // enough for a whole stat-read-stat to fit in the gap (the first run: attempt
  // 1 was source_busy, attempt 2 went through).
  const writers = Array.from({ length: processes }, (_, i) => startOneToucher(file, ms, i));
  return {
    children: writers.map((w) => w.child),
    touches: () => writers.reduce((n, w) => n + Number(w.touches() || 0), 0),
    done: () =>
      Promise.all(
        writers.map(
          (w) => new Promise((r) => (w.child.exitCode !== null ? r() : w.child.on('exit', r)))
        )
      ),
  };
}

function startOneToucher(file, ms, offset) {
  const code = `
    const fs = require('node:fs');
    const f = ${JSON.stringify(file)};
    const until = Date.now() + ${ms};
    const OFFSET = ${offset};
    let n = 0;
    const base = fs.statSync(f).mtimeMs;
    const tick = () => {
      if (Date.now() > until) { process.stdout.write(String(n)); return; }
      n += 1;
      const t = new Date(base + n * 7 + OFFSET);
      try { fs.utimesSync(f, t, t); } catch {}
      setImmediate(tick);
    };
    tick();`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  let touches = '';
  child.stdout.on('data', (d) => {
    touches += d;
  });
  return { child, touches: () => touches };
}

const FAILURE_CARD = `(() => {
  const n = [...document.querySelectorAll('[role="alert"], [role="status"]')].filter((x) => x.offsetParent !== null && (x.innerText || '').includes('没能迁移'))[0];
  if (!n) return null;
  const details = n.querySelector('details');
  return {
    text: (n.innerText || '').replace(/\\n+/g, ' | '),
    lines: (n.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean),
    buttons: [...n.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim()),
    details: details ? { open: details.open, summary: (details.querySelector('summary')?.innerText || '').trim() } : null,
  };
})()`;

const CLICK_FAILURE_DETAIL = `(() => {
  const n = [...document.querySelectorAll('[role="alert"], [role="status"]')].filter((x) => x.offsetParent !== null && (x.innerText || '').includes('没能迁移'))[0];
  if (!n) return 'no card';
  const d = n.querySelector('details');
  if (d) { d.querySelector('summary')?.click(); return 'details'; }
  const b = [...n.querySelectorAll('button')].find((x) => /详情/.test(x.innerText || x.getAttribute('aria-label') || ''));
  if (b) { b.click(); return 'button'; }
  return 'none';
})()`;

async function f3busy(key = 'L4', tag = 'F3-busy') {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = await openLegacy(cdp, evalAsync, key);
  const toucher = startToucher(out.made.file, 12_000);
  await sleep(300);
  out.send = await sendAndWatchMigration(
    cdp,
    evalAsync,
    'F3 可重试：文件一直在被写。',
    `${tag}-migrating`,
    { ms: 20_000, scrollShotName: `${tag}-migrating-notice-scrolled-up` }
  );
  await sleep(800);
  out.card = await cdp.evaluate(FAILURE_CARD);
  out.composer = await cdp.evaluate(COMPOSER);
  out.shotCard = await shot(cdp, `${tag}-failure-card`, { bottom: false });
  out.detailClick = await cdp.evaluate(CLICK_FAILURE_DETAIL);
  await sleep(500);
  out.cardDetail = await cdp.evaluate(FAILURE_CARD);
  out.shotDetail = await shot(cdp, `${tag}-failure-detail`, { bottom: false });
  // Let the writer finish, then Retry.
  await toucher.done();
  out.touches = toucher.touches();
  const retry = await cdp.evaluate(`(() => {
    const n = [...document.querySelectorAll('[role="alert"], [role="status"]')].filter((x) => x.offsetParent !== null && (x.innerText || '').includes('没能迁移'))[0];
    const b = n && [...n.querySelectorAll('button')].find((x) => /Retry|重试/.test((x.innerText || '').trim()));
    if (!b) return 'no retry';
    b.click();
    return (b.innerText || '').trim();
  })()`);
  out.retry = retry;
  const t0 = Date.now();
  const trace = [];
  while (Date.now() - t0 < 15_000) {
    const v = await cdp.evaluate(MIGRATION_VIEW);
    const key = JSON.stringify(v);
    if (trace.at(-1)?.key !== key) trace.push({ dt: Date.now() - t0, key, v });
    await sleep(100);
  }
  out.retryTrace = trace.map(({ dt, v }) => ({ dt, ...v }));
  out.rowAfterRetry = await sessionRow(evalAsync, out.made.sessionId);
  out.composerAfterRetry = await cdp.evaluate(COMPOSER);
  out.shotAfterRetry = await shot(cdp, `${tag}-after-retry`, { bottom: false });
  cdp.close();
  save(tag, out);
}

async function f3missing(key = 'L5', tag = 'F3-missing') {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = await openLegacy(cdp, evalAsync, key);
  out.previewTranscript = await cdp.evaluate(cde.TRANSCRIPT);
  // The file goes after the preview was read: what a user who cleaned up the pi folder sees.
  fs.rmSync(out.made.file);
  out.deleted = !fs.existsSync(out.made.file);
  out.send = await sendAndWatchMigration(cdp, evalAsync, 'F3 不可重试：文件已经删掉了。', null, {
    ms: 15_000,
  });
  await sleep(800);
  out.card = await cdp.evaluate(FAILURE_CARD);
  out.composer = await cdp.evaluate(COMPOSER);
  out.shotCard = await shot(cdp, `${tag}-failure-card`, { bottom: false });
  out.detailClick = await cdp.evaluate(CLICK_FAILURE_DETAIL);
  await sleep(500);
  out.cardDetail = await cdp.evaluate(FAILURE_CARD);
  out.shotDetail = await shot(cdp, `${tag}-failure-detail`, { bottom: false });
  out.rowAfter = await sessionRow(evalAsync, out.made.sessionId);
  out.toasts = await cdp.evaluate('window.__p17dToasts ?? []');
  cdp.close();
  save(tag, out);
}

// ---- F4 / F5: the 1.0.x fork ------------------------------------------------------------

async function f4() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = { rows: await allRows(evalAsync) };
  out.listed = await evalAsync(
    `return (await window.electronAPI.chat.listSessions()).filter((r) => r.agent === 'pi').map((r) => ({ sessionId: r.sessionId, title: r.title, migrationDiverged: r.migrationDiverged ?? null }));`,
    { label: 'list sessions' }
  ).catch((e) => String(e));
  out.sidebar = {};
  for (const m of readLegacyState().made.slice(0, 3))
    out.sidebar[m.key] = await cdp.evaluate(SIDEBAR_ROWS(m.title));
  // Hover the first badge (native title tooltips are not in page captures; the DOM is the evidence).
  const box = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('[data-slot="badge"]')].find((n) => n.offsetParent !== null && (n.innerText || '').trim() === '1.0.x');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (box) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await sleep(1200);
  out.hovered = box;
  out.sidebarAfterScroll = {};
  for (const m of readLegacyState().made.slice(0, 3))
    out.sidebarAfterScroll[m.key] = (await cdp.evaluate(SIDEBAR_ROWS(m.title))).map((r) => ({
      text: r.text,
      y: r.rect.y,
    }));
  out.shot = await shot(cdp, 'F4-sidebar-1.0.x-badge', { bottom: false });
  cdp.close();
  save('F4', out);
}

/** The kept legacy row of `key` that now reads diverged: its title and the click that opens it. */
async function openDiverged(cdp, evalAsync, key) {
  const made = readLegacyState().made.find((m) => m.key === key);
  const keptId = `${made.sessionId}_pi`;
  const rows = await cdp.evaluate(SIDEBAR_ROWS(made.title));
  // Two rows share the title: the migrated chat and the diverged legacy copy (badge 1.0.x).
  const index = rows.findIndex((r) => r.badges.some((b) => b.text === '1.0.x'));
  const click = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="button"][title]')].filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(made.title)} && [...n.querySelectorAll('[data-slot="badge"]')].some((b) => (b.innerText || '').trim() === '1.0.x'));
    if (!rows.length) return { ok: false };
    rows[0].click();
    return { ok: true, matches: rows.length };
  })()`);
  await sleep(2500);
  await lib.pumpFrames(cdp, 600);
  return {
    made,
    keptId,
    sidebarBefore: rows,
    badgeRowIndex: index,
    click,
    active: await cde.activeSid(evalAsync),
    row: await sessionRow(evalAsync, keptId),
  };
}

/** Sample the sidebar title of `sid` and of the original chat every ~50 ms while a send settles. */
async function watchTitles(_cdp, evalAsync, sid, originalId, ms) {
  const t0 = Date.now();
  const trace = [];
  let interimShot = null;
  while (Date.now() - t0 < ms) {
    const rows = await evalAsync(
      `${STORE}
       const a = s.sessions.find((x) => x.id === ${JSON.stringify(sid)});
       const o = s.sessions.find((x) => x.id === ${JSON.stringify(originalId)});
       return { fork: a ? { title: a.title, agent: a.agent ?? null, pending: a.forkTitlePending ?? null, status: a.status } : null, original: o ? o.title : null };`,
      { label: 'titles' }
    );
    const key = JSON.stringify(rows);
    if (trace.at(-1)?.key !== key) {
      trace.push({ dt: Date.now() - t0, key, rows });
      if (!interimShot && rows.fork?.title?.includes('1.0.x 分支')) interimShot = true;
    }
    await sleep(50);
  }
  return { trace: trace.map(({ dt, rows }) => ({ dt, ...rows })), interimSeen: !!interimShot };
}

async function f5text() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = await openDiverged(cdp, evalAsync, 'L1');
  out.preview = {
    view: await cdp.evaluate(MIGRATION_VIEW),
    transcript: await cdp.evaluate(cde.TRANSCRIPT),
  };
  const originalId = out.made.sessionId;
  const text =
    '继续整理 1.0.x 里的笔记。P0-RECALL {"markers":["alpha and beta","F5-CONTINUED-IN-1X-L1"]}';
  await cdp.evaluate(lib.typeIntoComposer(text));
  await cdp.waitFor(lib.SEND_READY, { timeoutMs: 30_000, label: 'send ready' });
  await cdp.evaluate(lib.CLICK_SEND);
  // Sidebar at the moment the interim title shows.
  const t0 = Date.now();
  let interim = null;
  while (Date.now() - t0 < 15_000) {
    const side = await cdp.evaluate(SIDEBAR_ROWS('1.0.x 分支'));
    if (side.length) {
      interim = { dt: Date.now() - t0, side };
      out.shotInterim = await fastShot(cdp, 'F5-interim-title');
      break;
    }
    await sleep(30);
  }
  out.interim = interim;
  out.titles = await watchTitles(cdp, evalAsync, out.keptId, originalId, 12_000);
  out.turn = await waitSettled(evalAsync, null, { timeoutMs: 60_000 });
  out.rowAfter = await sessionRow(evalAsync, out.keptId);
  out.original = await sessionRow(evalAsync, originalId);
  out.transcript = await cdp.evaluate(cde.TRANSCRIPT);
  out.sidebarAfter = await cdp.evaluate(SIDEBAR_ROWS('旧会话甲'));
  out.sidebarRenamed = await cdp.evaluate(SIDEBAR_ROWS('继续整理'));
  out.shotAfter = await shot(cdp, 'F5-renamed-by-first-message');
  cdp.close();
  save('F5-text', out);
}

async function pickVisionModel(cdp) {
  const opened = await cdp.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    let box = ta;
    for (let i = 0; i < 6 && box?.parentElement; i += 1) box = box.parentElement;
    const b = [...(box ?? document).querySelectorAll('button')].find((n) => n.offsetParent !== null && /^(Automatic|自动|fake-|P1-7d)/.test((n.innerText || '').trim()));
    if (!b) return null;
    b.click();
    return (b.innerText || '').trim();
  })()`);
  await sleep(700);
  const clickItem = (prefix) => `(() => {
    const m = [...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option],[role=menuitemcheckbox]')].find((n) => n.offsetParent !== null && (n.innerText || '').trim().startsWith(${JSON.stringify(prefix)}));
    if (!m) return false; m.click(); return true;
  })()`;
  await cdp.evaluate(clickItem('其他模型'));
  await sleep(700);
  const picked = await cdp.evaluate(clickItem('fake-vision'));
  await sleep(900);
  await pressKey(cdp, 'Escape');
  await sleep(400);
  return { opened, picked };
}

const PASTE_PNG = `
  const c = document.createElement('canvas');
  c.width = 64; c.height = 48;
  const g = c.getContext('2d');
  g.fillStyle = '#2c7be5'; g.fillRect(0, 0, 64, 48);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'f5-only-image.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ta = document.querySelector('textarea');
  ta.focus();
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  ta.dispatchEvent(ev);
  return { bytes: blob.size, defaultPrevented: ev.defaultPrevented };`;

async function f5image() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = await openDiverged(cdp, evalAsync, 'L2');
  out.model = await pickVisionModel(cdp);
  await cdp.evaluate(lib.typeIntoComposer(''));
  out.paste = await evalAsync(PASTE_PNG, { label: 'paste' });
  await sleep(1200);
  await cdp.waitFor(lib.SEND_READY, { timeoutMs: 30_000, label: 'send ready' });
  await cdp.evaluate(lib.CLICK_SEND);
  out.titles = await watchTitles(cdp, evalAsync, out.keptId, out.made.sessionId, 12_000);
  out.turn = await waitSettled(evalAsync, null, { timeoutMs: 60_000 });
  await sleep(1500);
  out.rowAfter = await sessionRow(evalAsync, out.keptId);
  out.original = await sessionRow(evalAsync, out.made.sessionId);
  out.transcript = await cdp.evaluate(cde.TRANSCRIPT);
  out.index = lib
    .readIndex()
    .rows.filter((r) => r.sessionId === out.keptId)
    .map((r) => ({ title: r.title, forkTitlePending: r.forkTitlePending ?? null }));
  out.shotAfter = await shot(cdp, 'F5-image-only-keeps-suffix');
  cdp.close();
  save('F5-image', out);
}

async function f5manual(key = 'L3', tag = 'F5-manual') {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = await openDiverged(cdp, evalAsync, key);
  // Move it without a message (会话分支, decision 123 rule 9), then rename, then send.
  out.tree = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || n.getAttribute('aria-label') || '').trim() === '会话分支' && n.offsetParent !== null);
    if (!b) return 'no button'; if (b.disabled) return 'disabled'; b.click(); return 'clicked';
  })()`);
  out.titlesAfterMove = await watchTitles(cdp, evalAsync, out.keptId, out.made.sessionId, 6000);
  await pressKey(cdp, 'Escape');
  await sleep(600);
  out.shotInterim = await shot(cdp, `${tag}-interim-before-rename`, { bottom: false });
  out.rename = await renameInSidebar(cdp, evalAsync, out.keptId, '我自己起的名字');
  if (out.rename.input !== 'rename field focused') {
    // The sidebar field loses focus to the composer (see F5-rename-focus): do
    // what its commit does, the same call with the same follow-up refresh
    // (`LeftNav` rename → `renameSessionIndexEntry(id, title, refresh)`).
    out.renameVia =
      'renameSessionIndexEntry + refreshSessionIndexNow (the sidebar field commit path)';
    out.renameStore = await evalAsync(
      `const m = await import(/* @vite-ignore */ '/components/chat/sessionIndex/useSessionIndex.ts');
       const ok = await m.renameSessionIndexEntry(${JSON.stringify(out.keptId)}, '我自己起的名字', async () => { await m.refreshSessionIndexNow(); });
       return ok;`,
      { label: 'rename via store' }
    );
  }
  await sleep(1000);
  out.rowAfterRename = await sessionRow(evalAsync, out.keptId);
  out.shotAfterRename = await shot(cdp, `${tag}-renamed-by-hand`, { bottom: false });
  await sendText(cdp, '这条消息不应该改掉手动起的名字。');
  out.turn = await waitSettled(evalAsync, null, { timeoutMs: 60_000 });
  await sleep(1500);
  out.rowAfter = await sessionRow(evalAsync, out.keptId);
  out.original = await sessionRow(evalAsync, out.made.sessionId);
  out.index = lib
    .readIndex()
    .rows.filter((r) => r.sessionId === out.keptId)
    .map((r) => ({ title: r.title, forkTitlePending: r.forkTitlePending ?? null }));
  out.shotAfter = await shot(cdp, `${tag}-rename-wins`);
  cdp.close();
  save(tag, out);
}

/** Rename through the sidebar row's own menu (right click → 重命名), the way a user does it. */
async function renameInSidebar(cdp, evalAsync, sid, name) {
  const title = (await sessionRow(evalAsync, sid))?.title;
  const box = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="button"][title]')].filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(title)});
    const row = rows.at(-1);
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    const r = row.getBoundingClientRect();
    return { x: Math.round(r.x + 60), y: Math.round(r.y + r.height / 2), rows: rows.length };
  })()`);
  if (!box) return { error: 'no row', title };
  await lib.pumpFrames(cdp, 300);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'right',
    buttons: 2,
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'right',
    buttons: 0,
    clickCount: 1,
  });
  await sleep(700);
  const MENU = `[...document.querySelectorAll('[role=menuitem]')].filter((n) => n.offsetParent !== null).map((n) => (n.innerText || '').trim())`;
  let menu = await cdp.evaluate(MENU);
  let via = 'right click';
  if (!menu.length) {
    via = 'contextmenu event';
    await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('[role="button"][title]')].filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(title)}).at(-1);
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${box.x}, clientY: ${box.y}, button: 2 }));
      return true;
    })()`);
    await sleep(700);
    menu = await cdp.evaluate(MENU);
  }
  // A real pointer click on the item (Base UI menus act on pointer events).
  const item = await cdp.evaluate(`(() => {
    const m = [...document.querySelectorAll('[role=menuitem]')].find((n) => n.offsetParent !== null && /^重命名/.test((n.innerText || '').trim()));
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  const clicked = !!item;
  if (item) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: item.x, y: item.y });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: item.x,
      y: item.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: item.x,
      y: item.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }
  // Where focus goes after the menu closes, and whether the row's rename field is there.
  const FOCUS = `(() => {
    const a = document.activeElement;
    const fields = [...document.querySelectorAll('input')].filter((n) => n.offsetParent !== null && n.getBoundingClientRect().x < 330 && n.getBoundingClientRect().y > 130);
    return { active: a ? a.tagName + (a.tagName === 'INPUT' ? ':' + a.value.slice(0, 40) : a.tagName === 'TEXTAREA' ? ':composer' : '') : null,
             fields: fields.map((n) => ({ value: n.value.slice(0, 40), focused: n === a })) };
  })()`;
  const focusTrace = [];
  for (let i = 0; i < 10; i += 1) {
    await lib.pumpFrames(cdp, 120);
    focusTrace.push(await cdp.evaluate(FOCUS));
  }
  const last = focusTrace.at(-1);
  const field = last.fields.find((f) => f.value === title);
  let input = null;
  if (field && !field.focused) {
    // The field is there without focus: click into it, as a user would.
    const at = await cdp.evaluate(
      `(() => { const n = [...document.querySelectorAll('input')].find((x) => x.offsetParent !== null && x.value === ${JSON.stringify(title)}); const r = n.getBoundingClientRect(); return { x: Math.round(r.x + 20), y: Math.round(r.y + r.height / 2) }; })()`
    );
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: at.x,
      y: at.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: at.x,
      y: at.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await sleep(300);
    focusTrace.push({ clickedIntoField: true, ...(await cdp.evaluate(FOCUS)) });
  }
  const now = await cdp.evaluate(FOCUS);
  if (now.fields.some((f) => f.focused && f.value === title)) {
    input = 'rename field focused';
    await cdp.evaluate(
      `(() => { const el = document.activeElement; el.select?.(); return true; })()`
    );
    await cdp.send('Input.insertText', { text: name });
    await pressKey(cdp, 'Enter');
  } else {
    // Never type into whatever else has focus (the composer would send it).
    input = 'no focused rename field; nothing typed';
  }
  await sleep(800);
  return { title, box, via, menu, clicked, focusTrace, input };
}

/** Rename one chat through its sidebar menu (probe of the helper, and of the field's focus). */
async function renameItem(suffix, name, tag = 'F5-rename-probe') {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const sid = (await allRows(evalAsync)).find((r) => r.id.endsWith(suffix))?.id;
  const out = { sid, rename: await renameInSidebar(cdp, evalAsync, sid, name) };
  out.rowAfter = await sessionRow(evalAsync, sid);
  cdp.close();
  save(tag, out);
}

async function f5check(tag = 'F5-after-restart') {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = { rows: await allRows(evalAsync) };
  out.index = lib
    .readIndex()
    .rows.map((r) => ({
      sessionId: r.sessionId,
      agent: r.agent,
      title: r.title,
      forkTitlePending: r.forkTitlePending ?? null,
      migratedTo: r.migratedTo ?? null,
      legacy: r.migratedFrom?.legacySessionId ?? null,
    }))
    .filter((r) => r.sessionId.includes('-lg'));
  out.shot = await shot(cdp, tag, { bottom: false });
  cdp.close();
  save(tag, out);
}

// ---- H: the one-time legacy-asset notice and the Extensions page ----------------------------

const settingsFile = () => path.join(lib.dirs.home, '.pilab', 'jyw-ai-client-dev', 'settings.json');
const NOTICE_TITLE = '以下内容在新版中不再生效';

function readSeenKey() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return {
      dshLegacyAssetNoticeSeen: data.dshLegacyAssetNoticeSeen ?? null,
      enablePiSubagents: data.enablePiSubagents ?? null,
    };
  } catch (error) {
    return { error: String(error.message ?? error) };
  }
}

/**
 * The 1.0.x leftovers checklist H1 names, in the scratch HOME and workspace
 * only (run after `p1-7d-gui.mjs setup`, before the first launch):
 * `~/.pilab/AGENTS.md`, `~/.agents/subagents/x.md`, `.pi/prompts/*.md`,
 * `.pi/mcp.json`, skills DSH will not load (a bad name in the agent directory,
 * one under the workspace's `.pi/skills`), and delegation switched off.
 * `clean` writes nothing (H2).
 */
function hSeed(kind = 'with-assets') {
  if (!appIsDown()) throw new Error('the app is running');
  const home = lib.dirs.home;
  const ws = lib.dirs.workspace;
  const written = [];
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    written.push(file);
  };
  if (kind === 'with-assets') {
    put(
      path.join(home, '.pilab', 'AGENTS.md'),
      '# My rules\n\nAlways answer in short sentences.\n'
    );
    put(
      path.join(home, '.agents', 'subagents', 'x.md'),
      '---\nname: x-reviewer\ndescription: Reviews a diff.\n---\nReview the diff you are given.\n'
    );
    put(
      path.join(ws, '.pi', 'prompts', 'review.md'),
      '---\ndescription: Review the change\n---\nReview $@\n'
    );
    put(path.join(ws, '.pi', 'prompts', 'ship.md'), 'Ship it: $@\n');
    put(
      path.join(ws, '.pi', 'mcp.json'),
      `${JSON.stringify({ mcpServers: { 'demo-files': { command: 'node', args: ['server.js'] }, 'demo-web': { url: 'http://127.0.0.1:9/mcp' } } }, null, 2)}\n`
    );
    put(
      path.join(home, '.pilab', 'jyw-ai-client-dev', 'pi-agent', 'skills', 'Bad_Skill', 'SKILL.md'),
      '---\nname: Bad_Skill\ndescription: A skill whose name DSH refuses.\n---\nDo the thing.\n'
    );
    put(
      path.join(ws, '.pi', 'skills', 'legacy-skill', 'SKILL.md'),
      '---\nname: legacy-skill\ndescription: A project skill in a folder DSH does not scan.\n---\nDo the other thing.\n'
    );
    put(settingsFile(), `${JSON.stringify({ enablePiSubagents: false }, null, 2)}\n`);
  }
  save(`H-seed-${path.basename(lib.SCRATCH)}`, { kind, written });
}

/** What the notice would say, whether it was seen, and what dialogs are open. */
async function hState(tag) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = {
    inspect: await evalAsync(
      `return await window.electronAPI.legacyAssets.inspect({ cwd: ${JSON.stringify(lib.dirs.workspace)} });`,
      { label: 'inspect' }
    ),
    settingsFile: readSeenKey(),
    dialogs: await cdp.evaluate(OPEN_DIALOGS),
  };
  cdp.close();
  save(tag, out);
}

/**
 * H1 / H2: enter the app WITHOUT the batch-1 `enter` step (it dismisses any
 * dialog with 「知道了」, which would close this notice unseen). Other startup
 * dialogs are closed; the legacy notice is shot, then closed the requested
 * way — `button` (「知道了」), `esc`, `backdrop` — or left alone (`none`, for
 * "does it show at all"). Records the seen key before and after.
 */
async function hNotice(tag, close = 'button', waitMs = '45000') {
  const cdp = await attach(600_000);
  const evalAsync = makeEval(cdp);
  await cdp.waitFor(
    `document.visibilityState === 'visible' && (document.getElementById('root')?.innerText.length ?? 0) > 20`,
    { timeoutMs: 120_000, label: 'painted' }
  );
  const out = { tag, close, seenBefore: readSeenKey() };
  out.language = await evalAsync(
    `const m = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     if (m.useSettingsStore.getState().language !== 'zh') m.useSettingsStore.getState().setLanguage('zh');
     return m.useSettingsStore.getState().language;`,
    { label: 'zh' }
  );
  await sleep(1500);
  const { ENTER_MAIN_SURFACE } = await import(path.join(repoRoot, 'scripts/h21-cdp.mjs'));
  out.entered = await cdp.evaluate(ENTER_MAIN_SURFACE).catch((e) => `ERROR: ${e.message}`);
  const t0 = Date.now();
  out.otherDialogs = [];
  let notice = null;
  while (Date.now() - t0 < Number(waitMs)) {
    await lib.pumpFrames(cdp, 300);
    const dialogs = await cdp.evaluate(OPEN_DIALOGS);
    notice = dialogs.find((d) => d.text.includes(NOTICE_TITLE)) ?? null;
    if (notice) break;
    const other = dialogs.find((d) => !d.text.startsWith('设置')) ?? null;
    if (other) {
      // Some other startup dialog (announcements…): close it by its own button.
      const hit = await cdp.evaluate(`(() => {
        const labels = ['以后再说', '知道了', '我知道了', '关闭', '跳过', '稍后'];
        // Every open dialog but the notice (Settings can be open under an announcement).
        for (const d of [...document.querySelectorAll('[role="dialog"][data-open], [role="alertdialog"][data-open]')].reverse()) {
          if ((d.innerText || '').includes(${JSON.stringify(NOTICE_TITLE)}) || (d.innerText || '').startsWith('设置')) continue;
          const b = [...d.querySelectorAll('button')].find((n) => labels.includes((n.innerText || n.getAttribute('aria-label') || '').trim()) && n.offsetParent !== null);
          if (b) { b.click(); return (b.innerText || b.getAttribute('aria-label')).trim(); }
        }
        return null;
      })()`);
      // Title line only: the announcement body is the service's own text (names people).
      if (hit)
        out.otherDialogs.push({
          dt: Date.now() - t0,
          title: other.text.split('\n')[0],
          closedWith: hit,
        });
    }
    await sleep(400);
  }
  out.noticeAfterMs = notice ? Date.now() - t0 : null;
  out.notice = notice;
  if (notice) {
    await sleep(600);
    out.shot = await shot(cdp, `${tag}-notice`, { bottom: false });
    out.noticeDom = await cdp.evaluate(`(() => {
      const d = [...document.querySelectorAll('[role="dialog"][data-open]')].find((x) => (x.innerText || '').includes(${JSON.stringify(NOTICE_TITLE)}));
      const r = d.getBoundingClientRect();
      return { rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, headings: [...d.querySelectorAll('h2, h3, h4')].map((h) => h.innerText.trim()), scroll: [...d.querySelectorAll('*')].filter((n) => n.scrollHeight > n.clientHeight + 4 && getComputedStyle(n).overflowY !== 'visible').map((n) => ({ sh: n.scrollHeight, ch: n.clientHeight })) };
    })()`);
    if (close === 'button') {
      out.closed = await cdp.evaluate(`(() => {
        const d = [...document.querySelectorAll('[role="dialog"][data-open]')].find((x) => (x.innerText || '').includes(${JSON.stringify(NOTICE_TITLE)}));
        const b = [...d.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '知道了');
        if (!b) return 'no 知道了';
        b.click();
        return '知道了';
      })()`);
    } else if (close === 'esc') {
      await pressKey(cdp, 'Escape');
      out.closed = 'Escape';
    } else if (close === 'backdrop') {
      // A real click on the dimmed area outside the popup.
      const r = out.noticeDom.rect;
      const x = Math.max(8, Math.round(r.x / 2));
      const y = Math.round(r.y + r.h / 2);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      out.closed = `backdrop click at (${x}, ${y})`;
    }
    if (close !== 'none') {
      await sleep(1500);
      await lib.pumpFrames(cdp, 400);
      out.stillOpen = (await cdp.evaluate(OPEN_DIALOGS)).some((d) => d.text.includes(NOTICE_TITLE));
    }
  }
  await sleep(500);
  out.seenAfter = readSeenKey();
  out.inspect = await evalAsync(
    `return await window.electronAPI.legacyAssets.inspect({ cwd: ${JSON.stringify(lib.dirs.workspace)} });`,
    { label: 'inspect' }
  ).catch((e) => String(e));
  if (!notice) out.shotNoNotice = await shot(cdp, `${tag}-no-notice`, { bottom: false });
  await cdp.evaluate(lib.INSTALL_RECORDERS).catch(() => undefined);
  cdp.close();
  save(tag, out);
}

/** H3: Settings → Extensions — its sections, and the 「旧版遗留内容」 block. */
async function h3(tag = 'H3') {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = {};
  await openSettings(cdp, evalAsync, 'extensions');
  out.nav = await cdp.evaluate(SETTINGS_NAV);
  out.headings = await cdp.evaluate(SETTINGS_HEADINGS);
  out.pageText = await cdp.evaluate(`(() => {
    const d = document.querySelector('[data-slot="dialog-popup"][data-open]') ?? document.body;
    return d.innerText;
  })()`);
  out.forbidden = [
    '子代理',
    'Pi 扩展',
    'pi 扩展',
    '扩展包',
    '提示词模板目录',
    '模板目录',
    '委派',
    '智能体功能',
  ].filter((w) => out.pageText.includes(w));
  out.shotTop = await shot(cdp, `${tag}-extensions-top`, { bottom: false });
  await cdp.evaluate(scrollIntoView('旧版遗留内容'));
  await sleep(500);
  out.legacy = await cdp.evaluate(SECTION('旧版遗留内容', '打开'));
  out.shotLegacy = await shot(cdp, `${tag}-extensions-legacy`, { bottom: false });
  await closeSettings(cdp);
  cdp.close();
  save(tag, out);
}

/** H3: take one leftover away with the page closed, then come back: it must be gone. */
async function h3redetect(tag = 'H3-redetect') {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = {};
  await openSettings(cdp, evalAsync, 'extensions');
  await cdp.evaluate(scrollIntoView('旧版遗留内容'));
  await sleep(500);
  out.before = await cdp.evaluate(SECTION('旧版遗留内容', '打开'));
  await closeSettings(cdp);
  const gone = path.join(lib.dirs.home, '.agents', 'subagents', 'x.md');
  fs.rmSync(gone);
  out.removed = '~/.agents/subagents/x.md (scratch HOME)';
  await openSettings(cdp, evalAsync, 'extensions');
  await cdp.evaluate(scrollIntoView('旧版遗留内容'));
  await sleep(800);
  out.after = await cdp.evaluate(SECTION('旧版遗留内容', '打开'));
  out.subagentsBefore = (out.before?.text ?? '').includes('x-reviewer');
  out.subagentsAfter = (out.after?.text ?? '').includes('x-reviewer');
  out.shot = await shot(cdp, `${tag}-after-removal`, { bottom: false });
  await closeSettings(cdp);
  cdp.close();
  save(tag, out);
}

/** H3: the capability popover of the left rail (「能力」). */
async function h3caps(tag = 'H3-caps') {
  const cdp = await attach(30_000);
  const out = {};
  out.click = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && ((n.getAttribute('aria-label') || '').trim() === '能力' || (n.getAttribute('title') || '').startsWith('能力')));
    if (!b) return null;
    b.click();
    return b.getAttribute('aria-label') || b.getAttribute('title');
  })()`);
  await sleep(1200);
  await lib.pumpFrames(cdp, 400);
  out.popup = await cdp.evaluate(`(() => {
    const p = [...document.querySelectorAll('[data-slot="popover-popup"], [role="dialog"][data-open], [data-open][data-side]')].filter((n) => n.offsetParent !== null);
    return p.map((n) => ({ slot: n.getAttribute('data-slot'), text: (n.innerText || '').slice(0, 1500) }));
  })()`);
  out.shot = await shot(cdp, `${tag}-popover`, { bottom: false });
  await pressKey(cdp, 'Escape');
  cdp.close();
  save(tag, out);
}

// ---- snap: a privacy-checked shot of whatever is on screen, and its text ---------------------

async function snap(name, resultName) {
  const cdp = await attach(30_000);
  const out = {
    dialogs: await cdp.evaluate(OPEN_DIALOGS),
    composer: await cdp.evaluate(COMPOSER),
  };
  out.shot = await shot(cdp, name, { bottom: false });
  cdp.close();
  if (resultName) save(resultName, out);
  else console.log(JSON.stringify(lib.scrub(out), null, 2));
}

// ---- dispatch ------------------------------------------------------------------------------

const items = {
  g1,
  g2,
  g2b,
  g3,
  g3reopen,
  i1,
  i2,
  i3,
  'inject-legacy': injectLegacy,
  'inject-extra': injectExtra,
  diverge,
  f1,
  f2tree,
  f2compact,
  f3busy,
  f3missing,
  f4,
  f5text,
  f5image,
  f5manual,
  f5check,
  rename: renameItem,
  'h-seed': hSeed,
  'h-state': hState,
  'h-notice': hNotice,
  h3,
  h3redetect,
  h3caps,
  snap,
};
export const fghi = { CARDS, OPEN_DIALOGS, COMPOSER, SIDEBAR_ROWS, clickSidebarRow, allRows };
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const name = process.argv[2];
  if (!items[name]) {
    console.error(`usage: p1-7d-items-fghi.mjs ${Object.keys(items).join('|')}`);
    process.exit(2);
  }
  await items[name](...process.argv.slice(3));
  process.exit(0);
}
