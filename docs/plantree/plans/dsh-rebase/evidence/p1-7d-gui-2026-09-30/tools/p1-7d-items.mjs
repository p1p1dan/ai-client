#!/usr/bin/env node
/**
 * p1-7d-items.mjs — timed drivers for the P1-7d checklist items that need a
 * precise moment or several reads in a row. Uses the building blocks of
 * p1-7d-gui.mjs (same scratch, same CDP port, same privacy-checked shots).
 *
 *   node p1-7d-items.mjs <item> [args]
 *
 * Every item prints a JSON result and writes it to ../results/<item>.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { lib } = await import(path.join(here, 'p1-7d-gui.mjs'));
const { attach, makeEval, sendText, waitTurn, STORE, sleep, log, scrub } = lib;

/** Screenshot with the transcript scrolled to its end first (unless bottom: false). */
async function shot(cdp, name, { bottom = true } = {}) {
  if (bottom) {
    await cdp.evaluate(lib.SCROLL_BOTTOM);
    await sleep(400);
  }
  return lib.shot(cdp, name);
}

const NEW_CHAT = `(() => {
  const b = [...document.querySelectorAll('button')].filter((n) => (n.innerText || n.getAttribute('aria-label') || '').trim() === '新建对话' && n.offsetParent !== null);
  if (!b.length) return false;
  b[b.length - 1].click();
  return true;
})()`;

async function newChat(cdp, evalAsync) {
  const before = await activeSid(evalAsync);
  await cdp.evaluate(NEW_CHAT);
  for (let i = 0; i < 30; i += 1) {
    await sleep(300);
    const now = await activeSid(evalAsync);
    if (now && now !== before) return now;
  }
  throw new Error('new chat did not become active');
}

const resultsDir = path.join(lib.outDir, 'results');
function save(name, value) {
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${name}.json`),
    `${JSON.stringify(scrub(value), null, 2)}\n`
  );
  console.log(JSON.stringify(scrub(value), null, 2));
}

const CHIP = `(() => {
  const b = document.querySelector('button[aria-label="上下文占用"]');
  return b ? { text: (b.innerText || '').trim(), visible: b.offsetParent !== null, open: b.hasAttribute('data-popup-open') } : null;
})()`;
const CHIP_DETAILS = `(() => {
  const d = [...document.querySelectorAll('[data-context-details]')].find((n) => n.offsetParent !== null);
  return d ? d.innerText : null;
})()`;
const CLICK_CHIP = `(() => {
  const b = document.querySelector('button[aria-label="上下文占用"]');
  if (!b) return false;
  b.click();
  return true;
})()`;
const CLICK_STOP = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')].find((n) => n.getAttribute('aria-label') === '停止当前回合' && n.offsetParent !== null);
  if (!b) return false;
  b.click();
  return true;
})()`;
const COMPOSER = `(() => {
  const ta = document.querySelector('textarea');
  const round = [...document.querySelectorAll('button[aria-label]')].filter((b) => b.offsetParent !== null)
    .map((b) => b.getAttribute('aria-label'))
    .filter((l) => ['发送消息', '停止当前回合', '重试上一条消息', '加入队列', '立刻发送 — 打断当前回复'].includes(l));
  return { value: ta?.value ?? null, placeholder: ta?.getAttribute('placeholder') ?? null, disabled: ta?.disabled ?? null, round };
})()`;

const activeSid = (evalAsync) =>
  evalAsync(`${STORE} return s.activeSessionId;`, { label: 'active sid' });

const lastAssistantText = (evalAsync, sid) =>
  evalAsync(
    `${STORE}
     const msgs = s.messages[${JSON.stringify(sid)}] ?? [];
     const last = [...msgs].reverse().find((m) => m.role === 'assistant');
     return (last?.blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');`,
    { label: 'assistant text' }
  );

async function a9() {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const sid = await activeSid(evalAsync);
  const out = { sid, chipBefore: await cdp.evaluate(CHIP) };

  // 1. P1-USAGE: a tool step and an answer, both billed with cache reads/writes.
  await sendText(cdp, 'P1-USAGE: one tool step, then an answer.');
  out.usageTurn = await waitTurn(evalAsync, sid);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.chipAfterUsage = await cdp.evaluate(CHIP);
  out.shotChip = await shot(cdp, 'A9-usage-chip');
  await cdp.evaluate(CLICK_CHIP);
  await sleep(900);
  out.detailsAfterUsage = await cdp.evaluate(CHIP_DETAILS);
  out.shotPopover = await shot(cdp, 'A9-usage-popover');
  await cdp.evaluate(CLICK_CHIP);
  await sleep(600);

  // 2. Another turn: the chip must not be cleared while it runs.
  const samples = [];
  await sendText(cdp, 'P0-STREAM: 再发一句（看用量环在运行中是否被清零）。');
  for (let i = 0; i < 16; i += 1) {
    samples.push({
      t: Date.now(),
      chip: await cdp.evaluate(CHIP),
      composer: await cdp.evaluate(COMPOSER),
    });
    if (i === 4) out.shotRunning = await shot(cdp, 'A9-usage-chip-running');
    await sleep(250);
  }
  out.runningSamples = samples;
  out.secondTurn = await waitTurn(evalAsync, sid);
  out.chipAfterSecond = await cdp.evaluate(CHIP);

  // 3. Stop mid-stream: the request has no reported usage.
  await sendText(cdp, 'P0-STREAM: 这一轮会在流式中途被停止（看「本次消耗未知」）。');
  let stopped = false;
  for (let i = 0; i < 60 && !stopped; i += 1) {
    await sleep(100);
    const text = await lastAssistantText(evalAsync, sid);
    if (text.length > 10) stopped = await cdp.evaluate(CLICK_STOP);
  }
  out.stopClicked = stopped;
  out.stopTurn = await waitTurn(evalAsync, sid);
  await sleep(1000);
  out.chipAfterStop = await cdp.evaluate(CHIP);
  await cdp.evaluate(CLICK_CHIP);
  await sleep(900);
  out.detailsAfterStop = await cdp.evaluate(CHIP_DETAILS);
  out.shotStopped = await shot(cdp, 'A9-usage-stopped-unknown');
  await cdp.evaluate(CLICK_CHIP);
  await sleep(400);
  out.problems = cdp.problems.slice(0, 20);
  cdp.close();
  save('A9', out);
}

const FAILURE = `(() => {
  const wraps = [...document.querySelectorAll('[data-testid="failure-continue"]')].filter((n) => n.offsetParent !== null);
  if (!wraps.length) return null;
  const w = wraps[wraps.length - 1];
  const b = w.querySelector('button');
  let card = w;
  for (let i = 0; i < 8 && card.parentElement; i += 1) {
    card = card.parentElement;
    if ((card.innerText || '').length > 40) break;
  }
  return { count: wraps.length, disabled: b?.disabled ?? null, title: b?.getAttribute('title'), wrapTitle: w.getAttribute('title'),
           card: (card.innerText || '').slice(0, 800) };
})()`;
const CLICK_CONTINUE = `(() => {
  const wraps = [...document.querySelectorAll('[data-testid="failure-continue"]')].filter((n) => n.offsetParent !== null);
  const b = wraps[wraps.length - 1]?.querySelector('button');
  if (!b) return { ok: false, reason: 'none' };
  if (b.disabled) return { ok: false, reason: 'disabled' };
  b.click();
  return { ok: true };
})()`;

const roles = (evalAsync, sid) =>
  evalAsync(
    `${STORE}
     return (s.messages[${JSON.stringify(sid)}] ?? []).map((m) => m.role + ':' + (m.blocks ?? []).map((b) => b.type + (b.type === 'text' ? '(' + String(b.text ?? '').slice(0, 50) + ')' : '')).join(','));`,
    { label: 'roles' }
  );

const toastsSince = (cdp, mark) =>
  cdp.evaluate(`(window.__p17dToasts ?? []).slice(${Number(mark)})`);
const toastMark = (cdp) => cdp.evaluate('(window.__p17dToasts ?? []).length');

async function a5() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, rolesBefore: await roles(evalAsync, sid) };
  const tm = await toastMark(cdp);
  const sentAt = await sendText(cdp, 'P1-FAILONCE: this request fails once.');
  const trace = [];
  let shotFailed = null;
  let shotRetrying = null;
  const deadline = Date.now() + 60_000;
  let idleReads = 0;
  let seenBusy = false;
  while (Date.now() < deadline) {
    const st = await lib.turnStatus(evalAsync, sid);
    const card = await cdp.evaluate(FAILURE);
    const row = {
      status: st.status,
      card: card ? { disabled: card.disabled, wrapTitle: card.wrapTitle } : null,
    };
    const prev = trace.at(-1);
    if (!prev || JSON.stringify({ status: prev.status, card: prev.card }) !== JSON.stringify(row))
      trace.push({ t: Date.now(), ...row });
    if (!shotRetrying && Date.now() - sentAt > 6000 && !card) {
      out.retryingText = (await cdp.evaluate(`document.body.innerText`)).slice(-600);
      shotRetrying = await shot(cdp, 'A5-retrying');
    }
    if (card && !shotFailed && card.disabled) {
      shotFailed = await shot(cdp, 'A5-failed-card-busy');
    }
    if (['starting', 'running', 'stopping'].includes(st.status)) {
      seenBusy = true;
      idleReads = 0;
    } else if (seenBusy || card) {
      idleReads += 1;
      if (idleReads >= 3 && card) break;
    }
    await sleep(120);
  }
  out.trace = trace;
  out.shotRetrying = shotRetrying;
  out.failure = await cdp.evaluate(FAILURE);
  out.shotFailedBusy = shotFailed;
  out.shotFailed = await shot(cdp, 'A5-failed-card');
  out.rolesAtFailure = await roles(evalAsync, sid);
  // Continue.
  out.continue1 = await cdp.evaluate(CLICK_CONTINUE);
  out.turn1 = await waitTurn(evalAsync, sid);
  await sleep(800);
  out.rolesAfterContinue = await roles(evalAsync, sid);
  out.failureAfterContinue = await cdp.evaluate(FAILURE);
  out.answer = await lastAssistantText(evalAsync, sid);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(600);
  out.shotContinued = await shot(cdp, 'A5-continued');
  // Second Continue, if a button is still offered anywhere.
  const tm2 = await toastMark(cdp);
  out.continue2 = await cdp.evaluate(CLICK_CONTINUE);
  await sleep(2500);
  out.toastsAfterSecond = await toastsSince(cdp, tm2);
  out.rolesAfterSecond = await roles(evalAsync, sid);
  out.shotSecond = await shot(cdp, 'A5-second-continue');
  out.toasts = await toastsSince(cdp, tm);
  out.events = (
    await cdp.evaluate(
      '(window.__p17dEvents ?? []).filter((e) => e.type !== "message.delta" && e.type !== "thinking.delta").slice(-40)'
    )
  ).map((e) => ({ type: e.type, payload: String(e.payload ?? '').slice(0, 200) }));
  cdp.close();
  save('A5', out);
}

const TRANSCRIPT = `(() => {
  const viewports = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')].filter((v) => v.offsetParent !== null);
  let best = null;
  for (const v of viewports) if (!best || (v.innerText || '').length > (best.innerText || '').length) best = v;
  return (best ?? document.body).innerText.slice(-4000);
})()`;

/** Click a sidebar row by exact title (first visible match), the way a user opens a chat. */
const clickRow = (title) => `(() => {
  const rows = [...document.querySelectorAll('[role="button"][title]')]
    .filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(title)});
  if (!rows.length) return { ok: false, matches: 0 };
  rows[0].click();
  return { ok: true, matches: rows.length };
})()`;

async function sessionTitle(evalAsync, sid) {
  return evalAsync(
    `${STORE} return s.sessions.find((x) => x.id === ${JSON.stringify(sid)})?.title ?? null;`,
    {
      label: 'title',
    }
  );
}

/** A5, second half: a turn that fails for good (P1-FAIL) in its own chat. */
async function a5fail() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  await sendText(cdp, 'P1-FAIL: this request fails upstream.');
  const out = { sid };
  out.turn = await waitTurn(evalAsync, sid, { timeoutMs: 120_000 });
  await sleep(800);
  out.failure = await cdp.evaluate(FAILURE);
  out.transcript = await cdp.evaluate(TRANSCRIPT);
  out.title = await sessionTitle(evalAsync, sid);
  out.shot = await shot(cdp, 'A5-fail-live');
  cdp.close();
  save('A5-fail', out);
}

/** Permission gear through the composer's own menu (full auto asks to confirm inside the menu). */
async function setGear(cdp, label) {
  const current = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => /^(执行|规划) · /.test((n.innerText || '').trim()) && n.offsetParent !== null);
    return b ? b.innerText.trim() : null;
  })()`);
  if (current?.endsWith(label)) return current;
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => /^(执行|规划) · /.test((n.innerText || '').trim()) && n.offsetParent !== null);
    b.click();
    return true;
  })()`);
  await sleep(700);
  await cdp.evaluate(`(() => {
    const m = [...document.querySelectorAll('[role="menuitemradio"]')].find((n) => n.offsetParent !== null && (n.innerText || '').startsWith(${JSON.stringify(label)}));
    if (!m) return false;
    m.click();
    return true;
  })()`);
  await sleep(700);
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '应用' && n.offsetParent !== null);
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(900);
  await cdp.evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  );
  return cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => /^(执行|规划) · /.test((n.innerText || '').trim()) && n.offsetParent !== null);
    return b ? b.innerText.trim() : null;
  })()`);
}

async function pressKey(cdp, key, { ctrl = false, shift = false } = {}) {
  const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38 };
  const base = {
    key,
    code: key,
    windowsVirtualKeyCode: codes[key] ?? 0,
    nativeVirtualKeyCode: codes[key] ?? 0,
    modifiers: (ctrl ? 2 : 0) | (shift ? 8 : 0),
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

const PENDING_BUBBLE = `(() => {
  const spans = [...document.querySelectorAll('span')].filter((n) => n.offsetParent !== null && (n.innerText || '').trim() === '待送达');
  if (!spans.length) return null;
  const span = spans[spans.length - 1];
  const article = span.closest('article');
  const bubble = article ? [...article.querySelectorAll('div')].find((d) => /border-dashed/.test(d.className)) : null;
  return { title: span.getAttribute('title'), clock: !!span.parentElement?.querySelector('svg'),
           articleClass: (article?.className || '').slice(0, 300), dashed: !!bubble || /border-dashed/.test(article?.className || ''),
           text: (article?.innerText || '').slice(0, 200) };
})()`;

const bashCalls = (evalAsync, sid) =>
  evalAsync(
    `${STORE}
     const msgs = s.messages[${JSON.stringify(sid)}] ?? [];
     const blocks = msgs.flatMap((m) => m.blocks ?? []);
     return blocks.filter((b) => b.type === 'tool_call').map((c) => ({ cmd: String(c.toolInput?.command ?? '').slice(0, 60),
       settled: blocks.some((r) => r.type === 'tool_result' && r.toolCallId === c.toolCallId) }));`,
    { label: 'bash calls' }
  );

async function a6() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  await sendText(cdp, 'P1-STEER: two tool steps.');
  let running = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const calls = await bashCalls(evalAsync, sid);
    if (calls.length && !calls[0].settled) {
      running = calls;
      break;
    }
    await sleep(60);
  }
  out.runningCalls = running;
  out.placeholderWhileRunning = (await cdp.evaluate(COMPOSER)).placeholder;
  await cdp.evaluate(lib.typeIntoComposer('STEER-NOTE-A also report the step count.'));
  const steerAt = Date.now();
  await pressKey(cdp, 'Enter', { ctrl: true });
  const trace = [];
  let shotPending = null;
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const bubble = await cdp.evaluate(PENDING_BUBBLE);
    const st = await lib.turnStatus(evalAsync, sid);
    const row = {
      bubble: bubble ? { title: bubble.title, dashed: bubble.dashed, clock: bubble.clock } : null,
      status: st.status,
    };
    const prev = trace.at(-1);
    if (
      !prev ||
      JSON.stringify({ bubble: prev.bubble, status: prev.status }) !== JSON.stringify(row)
    ) {
      trace.push({ dt: Date.now() - steerAt, ...row, calls: await bashCalls(evalAsync, sid) });
    }
    if (bubble && !shotPending) {
      out.pendingBubble = bubble;
      out.composerAfterSteer = await cdp.evaluate(COMPOSER);
      shotPending = await shot(cdp, 'A6-awaiting-delivery');
    }
    if (!['starting', 'running', 'stopping'].includes(st.status) && trace.length > 1) break;
    await sleep(80);
  }
  out.trace = trace;
  out.shotPending = shotPending;
  out.turn = await waitTurn(evalAsync, sid, { neverBusyMs: 3000 });
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.roles = await roles(evalAsync, sid);
  out.answer = await lastAssistantText(evalAsync, sid);
  out.shotFinal = await shot(cdp, 'A6-steer-final');
  // After the turn: Ctrl+Enter is a plain send.
  await cdp.evaluate(
    lib.typeIntoComposer('P0-STREAM: 回合结束后按 Ctrl+Enter，应当等于普通发送。')
  );
  await pressKey(cdp, 'Enter', { ctrl: true });
  out.idleCtrlEnterTurn = await waitTurn(evalAsync, sid);
  await sleep(800);
  out.rolesAfterIdleCtrlEnter = await roles(evalAsync, sid);
  out.shotIdle = await shot(cdp, 'A6-ctrl-enter-idle');
  out.gatewaySteer = lib
    .gatewayLog()
    .slice(-8)
    .map((r) => ({
      seq: r.seq,
      status: r.status,
      summary: String(r.contentSummary ?? '').slice(0, 160),
    }));
  cdp.close();
  save('A6', out);
}

const QA_CARD = `(() => {
  const skip = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '跳过' && b.offsetParent !== null);
  if (!skip) return null;
  let card = skip;
  for (let i = 0; i < 10 && card.parentElement; i += 1) {
    card = card.parentElement;
    if (card.querySelector('[role="radiogroup"], [role="group"]')) break;
  }
  return {
    text: (card.innerText || '').slice(0, 1200),
    tabs: [...card.querySelectorAll('[role="tab"]')].map((t) => ({ text: (t.innerText || '').trim(), selected: t.getAttribute('aria-selected') })),
    options: [...card.querySelectorAll('[role="radio"], [role="checkbox"]')].filter((o) => o.offsetParent !== null)
      .map((o) => ({ role: o.getAttribute('role'), checked: o.getAttribute('aria-checked'), text: (o.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 80) })),
    buttons: [...card.querySelectorAll('button')].filter((b) => !['radio', 'checkbox', 'tab'].includes(b.getAttribute('role')))
      .map((b) => ((b.innerText || '').trim().replace(/\\s+/g, ' ') + (b.disabled ? ' [disabled]' : ''))),
  };
})()`;

const clickOption = (prefix) => `(() => {
  const o = [...document.querySelectorAll('[role="radio"], [role="checkbox"]')]
    .find((n) => n.offsetParent !== null && (n.innerText || '').trim().replace(/^[A-Z]\\s+/, '').startsWith(${JSON.stringify(prefix)}));
  if (!o) return false;
  if (o.getAttribute('aria-checked') !== 'true') o.click();
  return o.getAttribute('aria-checked') === 'true' ? 'checked' : 'clicked';
})()`;

const clickTab = (index) => `(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')].filter((n) => n.offsetParent !== null);
  if (!tabs[${index}]) return false;
  tabs[${index}].click();
  return true;
})()`;

const clickButtonText = (text) => `(() => {
  const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && !n.disabled &&
    ((n.innerText || '').trim() === ${JSON.stringify(text)} || (n.innerText || '').trim().startsWith(${JSON.stringify(`${text}\n`)})));
  if (!b) return false;
  b.click();
  return true;
})()`;

async function waitFor(cdp, expr, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await cdp.evaluate(expr);
    if (v) return v;
    await sleep(150);
  }
  return null;
}

const pendingQuestions = (evalAsync) =>
  evalAsync(`${STORE} return JSON.parse(JSON.stringify(s.pendingQuestions ?? []));`, {
    label: 'pendingQuestions',
  });

async function a11(mode) {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const resume = mode === 'resume';
  const sid = resume ? await activeSid(evalAsync) : await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, resumed: resume };

  // Round 1: answer.
  if (!resume) await sendText(cdp, 'P1-QUESTION: ask me before you start.');
  out.card1 = await waitFor(cdp, QA_CARD);
  await cdp.evaluate(clickTab(0));
  await sleep(400);
  out.status1 = await lib.turnStatus(evalAsync, sid);
  if (!resume) out.shotDocked = await shot(cdp, 'A11-card-docked');
  out.pick = [];
  out.pick.push(await cdp.evaluate(clickOption('Bridge (Recommended)')));
  await sleep(400);
  out.pick.push(await cdp.evaluate(clickTab(1)));
  await sleep(400);
  out.pick.push(await cdp.evaluate(clickOption('tsc')));
  out.pick.push(await cdp.evaluate(clickOption('smoke, then record')));
  out.pick.push(await cdp.evaluate(clickOption('其他')));
  await sleep(400);
  out.pick.push(
    await cdp.evaluate(`(() => {
      const input = [...document.querySelectorAll('input')].find((n) => n.offsetParent !== null && n.getAttribute('aria-label') === 'Your answer')
        ?? [...document.querySelectorAll('input')].find((n) => n.offsetParent !== null && /Type your answer|输入/.test(n.getAttribute('placeholder') || ''));
      if (!input) return 'no other input';
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'A11-OTHER, typed note');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { aria: input.getAttribute('aria-label'), placeholder: input.getAttribute('placeholder') };
    })()`)
  );
  await sleep(500);
  out.cardFilled = await cdp.evaluate(QA_CARD);
  out.shotFilled = await shot(cdp, 'A11-card-filled');
  out.submit = await cdp.evaluate(clickButtonText('继续'));
  out.turn1 = await waitTurn(evalAsync, sid, { neverBusyMs: 3000 });
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.answer1 = await lastAssistantText(evalAsync, sid);
  out.transcript1 = await cdp.evaluate(TRANSCRIPT);
  out.shotAnswered = await shot(cdp, 'A11-answered-frozen');

  // Round 2: skip.
  await sendText(cdp, 'P1-QUESTION: ask me again, I will skip.');
  out.card2 = await waitFor(cdp, QA_CARD);
  out.skip = await cdp.evaluate(clickButtonText('跳过'));
  out.turn2 = await waitTurn(evalAsync, sid, { neverBusyMs: 3000 });
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.answer2 = await lastAssistantText(evalAsync, sid);
  out.transcript2 = await cdp.evaluate(TRANSCRIPT);
  out.shotSkipped = await shot(cdp, 'A11-skipped');

  // Round 3: Stop while the card is up.
  await sendText(cdp, 'P1-QUESTION: ask once more, then I press Stop.');
  out.card3 = await waitFor(cdp, QA_CARD);
  out.pendingBeforeStop = await pendingQuestions(evalAsync);
  out.stop = await cdp.evaluate(CLICK_STOP);
  out.turn3 = await waitTurn(evalAsync, sid, { neverBusyMs: 3000 });
  await sleep(1000);
  out.cardAfterStop = await cdp.evaluate(QA_CARD);
  out.pendingAfterStop = await pendingQuestions(evalAsync);
  out.transcript3 = await cdp.evaluate(TRANSCRIPT);
  out.shotStopped = await shot(cdp, 'A11-stop-card-gone');
  cdp.close();
  save('A11', out);
}

const MENU_ITEMS = `[...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option],[role=menuitemcheckbox]')]
  .filter((n) => n.offsetParent !== null)
  .map((n) => ({ role: n.getAttribute('role'), checked: n.getAttribute('aria-checked'), text: (n.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 100) }))`;
const clickMenuItem = (prefix) => `(() => {
  const m = [...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option],[role=menuitemcheckbox]')]
    .find((n) => n.offsetParent !== null && (n.innerText || '').replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(prefix)}));
  if (!m) return false;
  m.click();
  return true;
})()`;
const MODEL_TRIGGER = `(() => {
  const ta = document.querySelector('textarea');
  let box = ta;
  for (let i = 0; i < 6 && box?.parentElement; i += 1) box = box.parentElement;
  const b = [...(box ?? document).querySelectorAll('button')].find((n) => n.offsetParent !== null && /^(Automatic|自动|fake-|P1-7d)/.test((n.innerText || '').trim()));
  return b ? { text: (b.innerText || '').trim(), aria: b.getAttribute('aria-label'), title: b.getAttribute('title') } : null;
})()`;

async function pickModel(cdp, modelId) {
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
  await cdp.evaluate(clickMenuItem('其他模型'));
  await sleep(700);
  const items = await cdp.evaluate(MENU_ITEMS);
  const picked = await cdp.evaluate(clickMenuItem(modelId));
  await sleep(900);
  await pressKey(cdp, 'Escape');
  await sleep(400);
  return { opened, items, picked, trigger: await cdp.evaluate(MODEL_TRIGGER) };
}

const DRAFT_CHIPS = `[...document.querySelectorAll('button[aria-label^="Remove "]')].filter((b) => b.offsetParent !== null).map((b) => b.getAttribute('aria-label'))`;

const pastePng = (width, height, name) => `
  const c = document.createElement('canvas');
  c.width = ${width}; c.height = ${height};
  const g = c.getContext('2d');
  g.fillStyle = '#2c7be5'; g.fillRect(0, 0, ${width}, ${height});
  if (${height} > 10) { g.fillStyle = '#ffffff'; g.fillText('A7', 8, 20); }
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], ${JSON.stringify(name)}, { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ta = document.querySelector('textarea');
  ta.focus();
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  const dispatched = ta.dispatchEvent(ev);
  return { bytes: blob.size, dispatched, defaultPrevented: ev.defaultPrevented };`;

const userAttachments = (evalAsync, sid) =>
  evalAsync(
    `${STORE}
     return (s.messages[${JSON.stringify(sid)}] ?? []).filter((m) => m.role === 'user').map((m) => ({
       text: (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '').slice(0, 80)).join(''),
       attachments: JSON.parse(JSON.stringify(m.attachments ?? (m.blocks ?? []).filter((b) => b.type !== 'text').map((b) => ({ type: b.type, name: b.name ?? b.fileName ?? null })) ?? [])),
     }));`,
    { label: 'user attachments' }
  );

async function a7() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid };
  out.model = await pickModel(cdp, 'fake-vision');
  // 1. A small PNG, pasted.
  out.paste1 = await evalAsync(pastePng(64, 48, 'a7-small.png'), { label: 'paste small' });
  await sleep(1200);
  out.drafts1 = await cdp.evaluate(DRAFT_CHIPS);
  await cdp.evaluate(lib.typeIntoComposer('P1-IMAGE: what do you see?'));
  await sleep(300);
  out.shotDraft = await shot(cdp, 'A7-image-draft');
  await cdp.waitFor(lib.SEND_READY, { timeoutMs: 20_000, label: 'send ready (image)' });
  await cdp.evaluate(lib.CLICK_SEND);
  out.turn1 = await waitTurn(evalAsync, sid);
  await sleep(800);
  out.answer1 = await lastAssistantText(evalAsync, sid);
  out.userMessages1 = await userAttachments(evalAsync, sid);
  out.shotSent = await shot(cdp, 'A7-image-sent');
  // 2. An 8193 x 1 PNG: the engine refuses it.
  const tm = await toastMark(cdp);
  out.paste2 = await evalAsync(pastePng(8193, 1, 'a7-too-wide.png'), { label: 'paste wide' });
  await sleep(1200);
  out.drafts2 = await cdp.evaluate(DRAFT_CHIPS);
  out.alerts2 = await cdp.evaluate(
    `[...document.querySelectorAll('[role="alert"]')].filter((n) => n.offsetParent !== null).map((n) => (n.innerText || '').slice(0, 200))`
  );
  out.shotPrecheck = await shot(cdp, 'A7-wide-image-precheck');
  const text2 = 'P1-IMAGE: this one is 8193 px wide.';
  await cdp.evaluate(lib.typeIntoComposer(text2));
  await sleep(300);
  let sent2 = null;
  try {
    await cdp.waitFor(lib.SEND_READY, { timeoutMs: 20_000, label: 'send ready (wide)' });
    await cdp.evaluate(lib.CLICK_SEND);
    sent2 = Date.now();
  } catch (error) {
    sent2 = `not sent: ${error.message}`;
  }
  out.sent2 = sent2;
  const trace = [];
  for (let i = 0; i < 40; i += 1) {
    const row = {
      composer: await cdp.evaluate(COMPOSER),
      drafts: await cdp.evaluate(DRAFT_CHIPS),
      status: (await lib.turnStatus(evalAsync, sid)).status,
    };
    const prev = trace.at(-1);
    if (!prev || JSON.stringify({ ...prev, dt: 0 }) !== JSON.stringify({ ...row, dt: 0 }))
      trace.push({ dt: i * 250, ...row });
    await sleep(250);
  }
  out.trace2 = trace;
  out.toasts2 = await toastsSince(cdp, tm);
  out.bodyNotice = await cdp.evaluate(`(() => {
    const t = document.body.innerText;
    const i = t.indexOf('引擎拒收');
    return i >= 0 ? t.slice(Math.max(0, i - 40), i + 300) : null;
  })()`);
  out.userMessages2 = await userAttachments(evalAsync, sid);
  out.shotRefused = await shot(cdp, 'A7-wide-image-refused');
  cdp.close();
  save('A7', out);
}

/**
 * A7, engine refusal: the renderer only reads the PNG header (8000 px cap), DSH
 * decodes the whole image with sharp. A truncated PNG passes the first and is
 * refused by the second (`INVALID_IMAGE`), which is the refusal path the
 * 8193 x 1 case was meant to reach.
 */
async function a7b() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await activeSid(evalAsync);
  const out = { sid, trigger: await cdp.evaluate(MODEL_TRIGGER) };
  const tm = await toastMark(cdp);
  out.paste = await evalAsync(
    `const c = document.createElement('canvas');
     c.width = 64; c.height = 48;
     const g = c.getContext('2d');
     for (let i = 0; i < 64; i += 1) { g.fillStyle = 'hsl(' + (i * 5) + ',70%,50%)'; g.fillRect(i, 0, 1, 48); }
     const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
     const bytes = new Uint8Array(await blob.arrayBuffer());
     const cut = bytes.slice(0, Math.floor(bytes.length * 0.6));
     const file = new File([cut], 'a7-truncated.png', { type: 'image/png' });
     const dt = new DataTransfer();
     dt.items.add(file);
     const ta = document.querySelector('textarea');
     ta.focus();
     ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
     return { full: bytes.length, cut: cut.length };`,
    { label: 'paste truncated' }
  );
  await sleep(1200);
  out.drafts = await cdp.evaluate(DRAFT_CHIPS);
  const text = 'P1-IMAGE: a truncated PNG (the engine should refuse it).';
  await cdp.evaluate(lib.typeIntoComposer(text));
  await sleep(300);
  out.shotDraft = await shot(cdp, 'A7-truncated-draft');
  const gw = lib.gatewayLog().length;
  await cdp.waitFor(lib.SEND_READY, { timeoutMs: 20_000, label: 'send ready (truncated)' });
  await cdp.evaluate(lib.CLICK_SEND);
  const trace = [];
  for (let i = 0; i < 24; i += 1) {
    const row = {
      composer: await cdp.evaluate(COMPOSER),
      drafts: await cdp.evaluate(DRAFT_CHIPS),
      alerts: await cdp.evaluate(
        `[...document.querySelectorAll('[role="alert"]')].filter((n) => n.offsetParent !== null).map((n) => (n.innerText || '').slice(0, 240))`
      ),
    };
    const prev = trace.at(-1);
    const key = JSON.stringify(row);
    if (!prev || prev.key !== key) trace.push({ dt: i * 250, key, ...row });
    await sleep(250);
  }
  out.trace = trace.map(({ key, ...rest }) => rest);
  out.toasts = await toastsSince(cdp, tm);
  out.userMessages = await userAttachments(evalAsync, sid);
  out.gatewayRequests = lib.gatewayLog().length - gw;
  out.lastError = (await lib.turnStatus(evalAsync, sid)).lastError;
  out.shotRefused = await shot(cdp, 'A7-engine-refused');
  cdp.close();
  save('A7-engine-refusal', out);
}

const toolRows = (evalAsync, sid) =>
  evalAsync(
    `${STORE}
     const msgs = s.messages[${JSON.stringify(sid)}] ?? [];
     const blocks = msgs.flatMap((m) => m.blocks ?? []);
     return blocks.filter((b) => ['tool_call', 'tool_result', 'permission_request'].includes(b.type)).map((b) => ({
       type: b.type, toolName: b.toolName ?? null, ok: b.toolOk ?? null,
       input: b.toolInput === undefined ? undefined : JSON.stringify(b.toolInput).slice(0, 200),
       output: b.toolOutput === undefined ? undefined : JSON.stringify(b.toolOutput).slice(0, 200) }));`,
    { label: 'tool rows' }
  );

async function a8() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '每次询问') };
  out.paste = await evalAsync(
    `const file = new File(['Meeting notes\\nFILE-MARKER-NOTES: ship the P1-7d point-check.\\n'], 'notes.txt', { type: 'text/plain' });
     const dt = new DataTransfer();
     dt.items.add(file);
     const ta = document.querySelector('textarea');
     ta.focus();
     const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
     ta.dispatchEvent(ev);
     return { defaultPrevented: ev.defaultPrevented };`,
    { label: 'paste notes.txt' }
  );
  await sleep(1200);
  out.drafts = await cdp.evaluate(DRAFT_CHIPS);
  await cdp.evaluate(lib.typeIntoComposer('P1-FILEREAD: read the attached notes.'));
  await sleep(300);
  out.shotDraft = await shot(cdp, 'A8-file-draft');
  await cdp.waitFor(lib.SEND_READY, { timeoutMs: 20_000, label: 'send ready (file)' });
  await cdp.evaluate(lib.CLICK_SEND);
  const statuses = [];
  const deadline = Date.now() + 60_000;
  let seenBusy = false;
  let idle = 0;
  let permissionShot = null;
  while (Date.now() < deadline) {
    const st = await lib.turnStatus(evalAsync, sid);
    if (statuses.at(-1) !== st.status) statuses.push(st.status);
    if (st.status === 'waiting_permission' && !permissionShot)
      permissionShot = await shot(cdp, 'A8-unexpected-permission');
    if (['starting', 'running', 'stopping', 'waiting_permission'].includes(st.status)) {
      seenBusy = true;
      idle = 0;
    } else if (seenBusy) {
      idle += 1;
      if (idle >= 3) break;
    }
    await sleep(300);
  }
  out.statuses = statuses;
  out.permissionShot = permissionShot;
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.answer = await lastAssistantText(evalAsync, sid);
  out.userMessages = await userAttachments(evalAsync, sid);
  out.tools = await toolRows(evalAsync, sid);
  out.transcript = await cdp.evaluate(TRANSCRIPT);
  out.shotDone = await shot(cdp, 'A8-file-read');
  cdp.close();
  save('A8', out);
}

const hostPids = () =>
  lib
    .procList()
    .filter(lib.isOurHost)
    .map((r) => r.pid);

function killOneHost() {
  const pids = hostPids();
  if (pids.length !== 1)
    throw new Error(`expected exactly one host, found ${JSON.stringify(pids)}`);
  const pid = pids[0];
  if (!(pid > 1)) throw new Error('refusing pid <= 1');
  process.kill(pid, 'SIGKILL');
  return pid;
}

async function a2() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  const prompt = 'P0-SLEEPTOOL {"token":"a2","seconds":30} run a long command.';
  await sendText(cdp, prompt);
  let running = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const calls = await bashCalls(evalAsync, sid);
    if (calls.length && !calls[0].settled) {
      running = calls;
      break;
    }
    await sleep(100);
  }
  out.running = running;
  await sleep(2500);
  out.shotRunning = await shot(cdp, 'A2-command-running');
  out.hostsBefore = hostPids();
  const killAt = Date.now();
  out.killed = killOneHost();
  const timeline = [];
  let lastKey = '';
  while (Date.now() - killAt < 25_000) {
    const st = await lib.turnStatus(evalAsync, sid);
    const card = await cdp.evaluate(FAILURE);
    const row = {
      status: st.status,
      hosts: hostPids(),
      card: card ? card.card.split('\n')[0] : null,
      calls: await bashCalls(evalAsync, sid),
    };
    const key = JSON.stringify(row);
    if (key !== lastKey) {
      timeline.push({ dt: Date.now() - killAt, ...row });
      lastKey = key;
    }
    await sleep(300);
  }
  out.timeline = timeline;
  out.failure = await cdp.evaluate(FAILURE);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.transcript = await cdp.evaluate(TRANSCRIPT);
  out.promptOccurrences = (await cdp.evaluate(`document.body.innerText`)).split(prompt).length - 1;
  out.rowText = await cdp.evaluate(`(() => {
    const hits = [...document.querySelectorAll('*')].filter((n) => n.children.length < 6 && n.offsetParent !== null && /sleep-tool a2 started/.test(n.innerText || '') && (n.innerText || '').length < 400);
    const row = hits[hits.length - 1];
    if (!row) return null;
    const red = [...row.querySelectorAll('*')].some((c) => /destructive|text-red|error/.test(c.className?.baseVal ?? c.className ?? ''));
    return { text: row.innerText, cls: String(row.className?.baseVal ?? row.className ?? '').slice(0, 200), redDescendant: red };
  })()`);
  out.notice = await cdp.evaluate(
    `(() => { const t = document.body.innerText; const i = t.indexOf('引擎意外停止'); return i >= 0 ? t.slice(Math.max(0, i - 200), i + 80) : null; })()`
  );
  out.composer = await cdp.evaluate(COMPOSER);
  out.roles = await roles(evalAsync, sid);
  out.tools = await toolRows(evalAsync, sid);
  out.shotAfter = await shot(cdp, 'A2-after-host-kill');
  // The chat still takes a turn.
  await sendText(cdp, 'P0-STREAM: 宿主被杀并自动重启之后再发一轮。');
  out.nextTurn = await waitTurn(evalAsync, sid);
  await sleep(800);
  out.nextAnswer = await lastAssistantText(evalAsync, sid);
  out.hostsAfter = hostPids();
  out.promptOccurrencesAfter =
    (await cdp.evaluate(`document.body.innerText`)).split(prompt).length - 1;
  out.shotNext = await shot(cdp, 'A2-next-turn');
  out.orphanSleep = lib
    .procList()
    .filter((r) => /sleep 30/.test(r.cmd) && r.cmd.length < 200)
    .map((r) => ({ pid: r.pid, ppid: r.ppid, cmd: r.cmd }));
  cdp.close();
  save('A2', out);
}

const PANELS = `(() => {
  const vis = (n) => n && n.offsetParent !== null;
  const goal = document.querySelector('[data-testid="goal-bar"]');
  const todo = document.querySelector('[data-testid="todo-card"]');
  const rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) }; };
  return {
    goal: vis(goal) ? { state: goal.getAttribute('data-state'), text: (goal.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
      buttons: [...goal.querySelectorAll('button')].map((b) => ((b.innerText || b.getAttribute('aria-label') || '').trim() + (b.disabled ? ' [disabled]' : ''))),
      hint: [...goal.querySelectorAll('[title]')].map((n) => n.getAttribute('title')).filter(Boolean), rect: rect(goal) } : null,
    todo: vis(todo) ? { text: (todo.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400), rect: rect(todo) } : null,
    composerTop: rect(document.querySelector('textarea')),
  };
})()`;

/** Round heads and notice rows in the transcript: short gray lines, the way the timeline paints them. */
const ROUND_HEADS = `(() => {
  const t = document.body.innerText;
  const lines = t.split('\\n').map((l) => l.trim()).filter(Boolean);
  return lines.filter((l) => /^目标 · 第|后台任务已结束|自动继续|Background job|background job|目标已/.test(l)).slice(0, 40);
})()`;

async function watchGoal(
  cdp,
  evalAsync,
  sid,
  { prefix, until, timeoutMs = 120_000, shotStates = true }
) {
  const trace = [];
  const shots = {};
  const started = Date.now();
  let lastKey = '';
  while (Date.now() - started < timeoutMs) {
    const panels = await cdp.evaluate(PANELS);
    const st = await lib.turnStatus(evalAsync, sid);
    const row = {
      status: st.status,
      goal: panels.goal ? `${panels.goal.state} | ${panels.goal.text}` : null,
      todo: panels.todo?.text ?? null,
    };
    const key = JSON.stringify(row);
    if (key !== lastKey) {
      trace.push({ dt: Date.now() - started, ...row });
      lastKey = key;
    }
    const state = panels.goal?.state;
    if (shotStates && state && !shots[state]) {
      shots[state] = await shot(cdp, `${prefix}-goal-${state}`);
    }
    if (until && (await until(panels, st))) break;
    await sleep(250);
  }
  return { trace, shots };
}

async function b1() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  await sendText(cdp, 'P0-GOAL-COMPLETE: write progress.txt in the workspace, then verify it.');
  let todoShot = null;
  const watched = await watchGoal(cdp, evalAsync, sid, {
    prefix: 'B1',
    until: async (p, st) => {
      if (p.todo && !todoShot) todoShot = await shot(cdp, 'B6-todo-card');
      return (
        p.goal?.state === 'complete' && !['starting', 'running', 'stopping'].includes(st.status)
      );
    },
  });
  out.trace = watched.trace;
  out.shots = watched.shots;
  out.todoShot = todoShot;
  await sleep(1500);
  out.panels = await cdp.evaluate(PANELS);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.roundHeads = await cdp.evaluate(ROUND_HEADS);
  out.transcript = await cdp.evaluate(TRANSCRIPT);
  out.shotComplete = await shot(cdp, 'B1-goal-complete-final');
  // Expand the todo card (B6): one row per item.
  out.todoExpand = await cdp.evaluate(`(() => {
    const todo = document.querySelector('[data-testid="todo-card"]');
    if (!todo) return null;
    const b = [...todo.querySelectorAll('button')].find((n) => ['展开', 'Expand'].includes(n.getAttribute('aria-label')));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(700);
  out.todoExpanded = await cdp.evaluate(
    `(() => { const t = document.querySelector('[data-testid="todo-card"]'); return t ? t.innerText : null; })()`
  );
  out.shotTodoExpanded = await shot(cdp, 'B6-todo-expanded', { bottom: false });
  cdp.close();
  save('B1', out);
}

const goalButton = (label) => `(() => {
  const goal = document.querySelector('[data-testid="goal-bar"]');
  if (!goal) return 'no goal bar';
  const b = [...goal.querySelectorAll('button')].find((n) => n.getAttribute('aria-label') === ${JSON.stringify(label)} || (n.innerText || '').trim() === ${JSON.stringify(label)});
  if (!b) return 'no button ' + ${JSON.stringify(label)};
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`;
const DIALOG = `(() => {
  const d = [...document.querySelectorAll('[data-slot="alert-dialog-popup"], [data-slot="dialog-popup"]')].filter((n) => n.getAttribute('data-open') !== null).pop();
  if (!d) return null;
  return { role: d.getAttribute('role'), text: (d.innerText || '').slice(0, 600),
    buttons: [...d.querySelectorAll('button')].map((b) => ((b.innerText || b.getAttribute('aria-label') || '').trim() + (b.disabled ? ' [disabled]' : ''))) };
})()`;
const dialogButton = (label) => `(() => {
  const d = [...document.querySelectorAll('[data-slot="alert-dialog-popup"], [data-slot="dialog-popup"]')].filter((n) => n.getAttribute('data-open') !== null).pop();
  if (!d) return 'no dialog';
  const b = [...d.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === ${JSON.stringify(label)});
  if (!b) return 'no button';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`;

async function b5(tag = 'B5') {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await activeSid(evalAsync);
  const out = { sid, before: await cdp.evaluate(PANELS) };
  const tm = await toastMark(cdp);
  // Expand: full text and the created / updated / rounds line.
  out.expand = await cdp.evaluate(goalButton('展开'));
  await sleep(700);
  out.expanded = await cdp.evaluate(
    `(() => { const g = document.querySelector('[data-testid="goal-bar"]'); return g ? g.innerText : null; })()`
  );
  out.shotExpanded = await shot(cdp, `${tag}-goal-expanded`, { bottom: false });
  // Menu.
  out.menuOpen = await cdp.evaluate(goalButton('目标菜单'));
  await sleep(700);
  out.menuItems = await cdp.evaluate(MENU_ITEMS);
  out.shotMenu = await shot(cdp, `${tag}-goal-menu`, { bottom: false });
  out.copy = await cdp.evaluate(clickMenuItem('复制目标文本'));
  await sleep(1200);
  out.toastsAfterCopy = await toastsSince(cdp, tm);
  // Edit.
  await cdp.evaluate(goalButton('目标菜单'));
  await sleep(700);
  out.edit = await cdp.evaluate(clickMenuItem('编辑目标'));
  await sleep(900);
  out.editDialog = await cdp.evaluate(DIALOG);
  out.editTyped = await cdp.evaluate(`(() => {
    const ta = [...document.querySelectorAll('[data-slot="dialog-popup"][data-open] textarea')].find((n) => n.offsetParent !== null);
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ta.value + ' (edited in the ${tag} point-check)');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value;
  })()`);
  await sleep(400);
  out.shotEdit = await shot(cdp, `${tag}-goal-edit-dialog`, { bottom: false });
  const tm2 = await toastMark(cdp);
  out.save = await cdp.evaluate(dialogButton('保存'));
  await sleep(2500);
  out.toastsAfterEdit = await toastsSince(cdp, tm2);
  out.dialogAfterSave = await cdp.evaluate(DIALOG);
  out.afterEdit = await cdp.evaluate(PANELS);
  out.shotEditResult = await shot(cdp, `${tag}-goal-edit-result`, { bottom: false });
  if (out.dialogAfterSave) {
    await cdp.evaluate(dialogButton('取消'));
    await sleep(700);
  }
  // Clear, with its confirmation.
  await cdp.evaluate(goalButton('目标菜单'));
  await sleep(700);
  out.clear = await cdp.evaluate(clickMenuItem('清除目标'));
  await sleep(900);
  out.clearDialog = await cdp.evaluate(DIALOG);
  out.shotClear = await shot(cdp, `${tag}-goal-clear-confirm`, { bottom: false });
  const tm3 = await toastMark(cdp);
  out.clearConfirm = await cdp.evaluate(dialogButton('清除'));
  await sleep(2500);
  out.toastsAfterClear = await toastsSince(cdp, tm3);
  out.afterClear = await cdp.evaluate(PANELS);
  out.transcriptTail = (await cdp.evaluate(TRANSCRIPT)).slice(-800);
  out.shotCleared = await shot(cdp, `${tag}-goal-cleared`);
  cdp.close();
  save(tag, out);
}

const isBusy = (st) =>
  ['starting', 'running', 'stopping', 'waiting_permission', 'waiting_question'].includes(st.status);

async function b2() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  await sendText(cdp, '/goal P0-GOAL-PAUSE: run a slow check, then finish.');
  // Wait for round 1's slow command.
  const w1 = await watchGoal(cdp, evalAsync, sid, {
    prefix: 'B2',
    timeoutMs: 60_000,
    until: async (p) => {
      if (p.goal?.state !== 'running') return false;
      const calls = await bashCalls(evalAsync, sid);
      return calls.some((c) => /sleep 8/.test(c.cmd) && !c.settled);
    },
  });
  out.untilRunning = w1.trace;
  await sleep(1500);
  out.runningPanels = await cdp.evaluate(PANELS);
  out.shotRunning = await shot(cdp, 'B2-goal-running-slow-check');
  const tm = await toastMark(cdp);
  out.pause = await cdp.evaluate(goalButton('暂停'));
  const w2 = await watchGoal(cdp, evalAsync, sid, {
    prefix: 'B2',
    timeoutMs: 30_000,
    until: async (p, st) => p.goal?.state === 'paused' && !isBusy(st),
  });
  out.untilPaused = w2.trace;
  await sleep(1500);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(700);
  out.pausedPanels = await cdp.evaluate(PANELS);
  out.pausedCalls = await bashCalls(evalAsync, sid);
  out.pausedTranscript = (await cdp.evaluate(TRANSCRIPT)).slice(-1500);
  out.shotPaused = await shot(cdp, 'B2-goal-paused');
  out.resume = await cdp.evaluate(goalButton('继续'));
  const w3 = await watchGoal(cdp, evalAsync, sid, {
    prefix: 'B2',
    timeoutMs: 60_000,
    until: async (p, st) => p.goal?.state === 'complete' && !isBusy(st),
  });
  out.untilComplete = w3.trace;
  await sleep(1000);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(700);
  out.roundHeads = await cdp.evaluate(ROUND_HEADS);
  out.finalPanels = await cdp.evaluate(PANELS);
  out.toasts = await toastsSince(cdp, tm);
  out.transcript = (await cdp.evaluate(TRANSCRIPT)).slice(-2500);
  out.shotResumed = await shot(cdp, 'B2-goal-resumed-complete');
  cdp.close();
  save('B2', out);
}

async function b3() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = {};
  // Blocked.
  {
    const sid = await newChat(cdp, evalAsync);
    await sleep(1500);
    out.blocked = { sid, gear: await setGear(cdp, '全自动') };
    await sendText(cdp, 'P0-GOAL-BLOCKED: load /nonexistent/p0-config.json and apply it.');
    const w = await watchGoal(cdp, evalAsync, sid, {
      prefix: 'B3',
      timeoutMs: 90_000,
      until: async (p, st) => p.goal?.state === 'blocked' && !isBusy(st),
    });
    out.blocked.trace = w.trace;
    await sleep(2000);
    out.blocked.panels = await cdp.evaluate(PANELS);
    out.blocked.roundHeads = await cdp.evaluate(ROUND_HEADS);
    out.blocked.shot = await shot(cdp, 'B3-goal-blocked');
    // 「继续」 on a blocked goal: what DSH does with it.
    const tm = await toastMark(cdp);
    out.blocked.resume = await cdp.evaluate(goalButton('继续'));
    const w2 = await watchGoal(cdp, evalAsync, sid, {
      prefix: 'B3-resume',
      timeoutMs: 45_000,
      shotStates: false,
      until: async (p, st) =>
        Date.now() && !isBusy(st) && p.goal?.state === 'blocked' && w2started(),
    });
    out.blocked.afterResume = w2.trace;
    await sleep(1500);
    out.blocked.toastsAfterResume = await toastsSince(cdp, tm);
    out.blocked.panelsAfterResume = await cdp.evaluate(PANELS);
    out.blocked.roundHeadsAfterResume = await cdp.evaluate(ROUND_HEADS);
    out.blocked.shotAfterResume = await shot(cdp, 'B3-goal-blocked-after-resume');
  }
  // Round limit.
  {
    const sid = await newChat(cdp, evalAsync);
    await sleep(1500);
    out.roundLimit = { sid, gear: await setGear(cdp, '全自动') };
    await sendText(cdp, 'P0-GOAL-ROUNDLIMIT: keep polishing without ever finishing.');
    const w = await watchGoal(cdp, evalAsync, sid, {
      prefix: 'B3',
      timeoutMs: 90_000,
      until: async (p, st) => p.goal?.state === 'roundLimit' && !isBusy(st),
    });
    out.roundLimit.trace = w.trace;
    await sleep(2000);
    out.roundLimit.panels = await cdp.evaluate(PANELS);
    out.roundLimit.roundHeads = await cdp.evaluate(ROUND_HEADS);
    out.roundLimit.shot = await shot(cdp, 'B3-goal-round-limit');
    // Hover target: the wrapper span carries the hint of the disabled 「继续」.
    out.roundLimit.hint = await cdp.evaluate(`(() => {
      const goal = document.querySelector('[data-testid="goal-bar"]');
      const b = goal && [...goal.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '继续');
      return b ? { disabled: b.disabled, wrapperTitle: b.parentElement?.getAttribute('title') ?? null } : null;
    })()`);
    // A real hover over the wrapper, so the tooltip (if any) shows in the shot.
    const box = await cdp.evaluate(`(() => {
      const goal = document.querySelector('[data-testid="goal-bar"]');
      const b = goal && [...goal.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '继续');
      if (!b) return null;
      const r = b.parentElement.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (box) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await sleep(1500);
      out.roundLimit.shotHover = await shot(cdp, 'B3-goal-round-limit-hover', { bottom: false });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    }
  }
  cdp.close();
  save('B3', out);
}

let w2start = 0;
function w2started() {
  if (!w2start) w2start = Date.now();
  return Date.now() - w2start > 6000;
}

async function reloadWindow(cdp) {
  await cdp.evaluate('(() => { window.__p17dBeforeReload = true; return true; })()');
  const base = {
    key: 'r',
    code: 'KeyR',
    windowsVirtualKeyCode: 82,
    nativeVirtualKeyCode: 82,
    modifiers: 2,
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  let via = 'ctrl+r';
  await sleep(4000);
  const stillThere = await cdp.evaluate('window.__p17dBeforeReload === true').catch(() => false);
  if (stillThere) {
    via = 'Page.reload (Ctrl+R did not reload)';
    await cdp.send('Page.reload', {});
  }
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const ok = await cdp
      .evaluate(`!!document.querySelector('textarea') && window.__p17dBeforeReload !== true`)
      .catch(() => false);
    if (ok) break;
    await sleep(500);
  }
  await sleep(2500);
  // Dialogs that come back after a reload (start page, notices).
  const dismissed = await cdp.evaluate(`(() => {
    const labels = ['以后再说', '知道了', '我知道了', '关闭', '跳过', '稍后'];
    const hit = [...document.querySelectorAll('[role="dialog"] button')].find((b) => labels.includes((b.innerText || '').trim()) && b.offsetParent !== null);
    if (hit) hit.click();
    return hit ? hit.innerText.trim() : null;
  })()`);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  return { via, dismissed };
}

async function b4() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  await sendText(
    cdp,
    '/goal P0-SLEEPTOOL {"token":"b4","seconds":45} keep one long command running each round.'
  );
  const w1 = await watchGoal(cdp, evalAsync, sid, {
    prefix: 'B4',
    timeoutMs: 60_000,
    shotStates: false,
    until: async (p) => {
      if (!['running', 'waiting'].includes(p.goal?.state)) return false;
      const calls = await bashCalls(evalAsync, sid);
      return calls.some((c) => /sleep 45/.test(c.cmd) && !c.settled);
    },
  });
  out.untilRunning = w1.trace;
  await sleep(1500);
  out.beforeReload = await cdp.evaluate(PANELS);
  out.shotBefore = await shot(cdp, 'B4-goal-before-reload');
  out.reload = await reloadWindow(cdp);
  const evalAfter = makeEval(cdp, 'p17dr');
  out.activeAfterReload = await activeSid(evalAfter);
  // Rehydration: poll until the bar is back (or 30 s).
  const rehydrate = [];
  const r0 = Date.now();
  while (Date.now() - r0 < 30_000) {
    const p = await cdp.evaluate(PANELS);
    rehydrate.push({
      dt: Date.now() - r0,
      goal: p.goal ? `${p.goal.state} | ${p.goal.text}` : null,
      todo: p.todo?.text ?? null,
    });
    if (p.goal) break;
    await sleep(500);
  }
  out.rehydrate = rehydrate.filter(
    (row, i) =>
      i === 0 ||
      JSON.stringify({ ...row, dt: 0 }) !== JSON.stringify({ ...rehydrate[i - 1], dt: 0 })
  );
  out.afterReload = await cdp.evaluate(PANELS);
  out.callsAfterReload = await bashCalls(evalAfter, sid);
  out.shotAfterReload = await shot(cdp, 'B4-goal-after-reload');
  // Kill the host while the round's command runs.
  out.hostsBefore = hostPids();
  const killAt = Date.now();
  out.killed = killOneHost();
  const trace = [];
  let lastKey = '';
  const shots = {};
  while (Date.now() - killAt < 25_000) {
    const p = await cdp.evaluate(PANELS);
    const st = await lib.turnStatus(evalAfter, sid);
    const row = {
      status: st.status,
      hosts: hostPids(),
      goal: p.goal ? `${p.goal.state} | ${p.goal.text}` : null,
      buttons: p.goal?.buttons ?? null,
    };
    const key = JSON.stringify(row);
    if (key !== lastKey) {
      trace.push({ dt: Date.now() - killAt, ...row });
      lastKey = key;
    }
    const state = p.goal?.state;
    if (state && !shots[state]) shots[state] = await shot(cdp, `B4-after-kill-${state}`);
    await sleep(150);
  }
  out.afterKill = trace;
  out.afterKillShots = shots;
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(700);
  out.finalPanels = await cdp.evaluate(PANELS);
  out.transcriptTail = (await cdp.evaluate(TRANSCRIPT)).slice(-1500);
  out.shotFinal = await shot(cdp, 'B4-after-kill-final');
  cdp.close();
  save('B4', out);
}

async function openBySuffix(cdp, evalAsync, suffix) {
  return evalAsync(
    `${STORE}
     const target = s.sessions.find((x) => x.id.endsWith(${JSON.stringify(suffix)}));
     if (!target) return { error: 'no session' };
     const rows = [...document.querySelectorAll('[role="button"][title]')].filter((n) => n.offsetParent !== null && n.getAttribute('title') === target.title);
     if (!rows.length) return { error: 'no row', title: target.title };
     rows[0].click();
     for (let i = 0; i < 30; i += 1) {
       await new Promise((r) => setTimeout(r, 300));
       if (chat.useChatSessionsStore.getState().activeSessionId === target.id) break;
     }
     return { id: target.id, active: chat.useChatSessionsStore.getState().activeSessionId };`,
    { label: 'open by suffix' }
  );
}

/** B4 again with the goal's chat on screen: resume, reload, reopen, then kill the host. */
async function b4b(suffix) {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const opened = await openBySuffix(cdp, evalAsync, suffix);
  const sid = opened.id;
  await sleep(2000);
  const out = { opened, before: await cdp.evaluate(PANELS) };
  out.resume = await cdp.evaluate(goalButton('继续'));
  const w1 = await watchGoal(cdp, evalAsync, sid, {
    prefix: 'B4b',
    timeoutMs: 60_000,
    shotStates: false,
    until: async (p) => {
      if (!['running', 'waiting'].includes(p.goal?.state)) return false;
      const calls = await bashCalls(evalAsync, sid);
      return calls.length > 0 && !calls[calls.length - 1].settled;
    },
  });
  out.untilRunning = w1.trace;
  await sleep(1500);
  out.beforeReload = await cdp.evaluate(PANELS);
  out.shotBefore = await shot(cdp, 'B4-goal-before-reload');
  out.reload = await reloadWindow(cdp);
  const evalAfter = makeEval(cdp, 'p17dr');
  out.activeAfterReload = await activeSid(evalAfter);
  out.reopened = await openBySuffix(cdp, evalAfter, suffix);
  const rehydrate = [];
  const r0 = Date.now();
  while (Date.now() - r0 < 20_000) {
    const p = await cdp.evaluate(PANELS);
    const row = { goal: p.goal ? `${p.goal.state} | ${p.goal.text}` : null };
    if (!rehydrate.length || JSON.stringify(rehydrate.at(-1).row) !== JSON.stringify(row))
      rehydrate.push({ dt: Date.now() - r0, row });
    if (p.goal && Date.now() - r0 > 3000) break;
    await sleep(300);
  }
  out.rehydrate = rehydrate;
  out.afterReload = await cdp.evaluate(PANELS);
  out.callsAfterReload = await bashCalls(evalAfter, sid);
  out.shotAfterReload = await shot(cdp, 'B4-goal-after-reload');
  out.hostsBefore = hostPids();
  const killAt = Date.now();
  out.killed = killOneHost();
  const trace = [];
  let lastKey = '';
  const shots = {};
  while (Date.now() - killAt < 20_000) {
    const p = await cdp.evaluate(PANELS);
    const st = await lib.turnStatus(evalAfter, sid);
    const row = {
      status: st.status,
      hosts: hostPids().length,
      goal: p.goal ? `${p.goal.state} | ${p.goal.text.slice(0, 60)}` : null,
      buttons: p.goal?.buttons?.slice(1) ?? null,
    };
    const key = JSON.stringify(row);
    if (key !== lastKey) {
      trace.push({ dt: Date.now() - killAt, ...row });
      lastKey = key;
      const tag = `${p.goal?.state ?? 'none'}-${(p.goal?.buttons ?? []).some((b) => b.startsWith('继续')) ? 'resume' : 'nobutton'}`;
      if (!shots[tag]) shots[tag] = await shot(cdp, `B4-after-kill-${tag}`);
    }
    await sleep(100);
  }
  out.afterKill = trace;
  out.afterKillShots = shots;
  out.finalPanels = await cdp.evaluate(PANELS);
  cdp.close();
  save('B4b', out);
}

async function b7() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  await sendText(cdp, 'P1-JOBNOTICE: start a background job, then wait for its notice.');
  out.turn1 = await waitTurn(evalAsync, sid);
  // The wake-up turn nobody sent.
  const statuses = [];
  const t0 = Date.now();
  let seenBusy = false;
  let idle = 0;
  while (Date.now() - t0 < 60_000) {
    const st = await lib.turnStatus(evalAsync, sid);
    if (statuses.at(-1)?.status !== st.status)
      statuses.push({ dt: Date.now() - t0, status: st.status });
    if (isBusy(st)) {
      seenBusy = true;
      idle = 0;
    } else if (seenBusy) {
      idle += 1;
      if (idle >= 4) break;
    }
    await sleep(300);
  }
  out.wakeStatuses = statuses;
  await sleep(1000);
  out.roles = await roles(evalAsync, sid);
  out.shotCollapsed = await shot(cdp, 'B7-wake-turn');
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.transcript = (await cdp.evaluate(TRANSCRIPT)).slice(-2500);
  out.wakeRows = await cdp.evaluate(`(() => {
    const hits = [...document.querySelectorAll('*')].filter((n) => n.offsetParent !== null && n.children.length <= 4 &&
      /后台任务已结束|自动继续|background job|Background job/.test(n.innerText || '') && (n.innerText || '').length < 500);
    const leaf = hits.filter((n) => !hits.some((m) => m !== n && n.contains(m)));
    return leaf.map((n) => ({ tag: n.tagName, text: (n.innerText || '').slice(0, 300), title: n.getAttribute('title') ?? n.closest('[title]')?.getAttribute('title') ?? null,
      cls: String(n.className?.baseVal ?? n.className ?? '').slice(0, 160), svg: !!n.parentElement?.querySelector('svg') }));
  })()`);
  out.userBubbles = await cdp.evaluate(
    `[...document.querySelectorAll('article')].filter((a) => a.offsetParent !== null).map((a) => (a.innerText || '').slice(0, 120))`
  );
  out.shotExpanded = await shot(cdp, 'B7-wake-turn-expanded');
  // Hover the notice row so its tooltip (title) is exercised.
  const box = await cdp.evaluate(`(() => {
    const n = [...document.querySelectorAll('[title]')].find((x) => x.offsetParent !== null && /background job|Background job|后台任务/.test(x.getAttribute('title') || ''));
    if (!n) return null;
    n.scrollIntoView({ block: 'center' });
    const r = n.getBoundingClientRect();
    return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2, title: n.getAttribute('title') };
  })()`);
  out.noticeHover = box;
  if (box) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(1200);
    out.shotHover = await shot(cdp, 'B7-notice-hover', { bottom: false });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  }
  cdp.close();
  save('B7', out);
}

/** B7, notice row: the job's completion lands while another turn runs, so it is not a turn head. */
async function b7b() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  const sentAt = await sendText(
    cdp,
    'P1-JOBNOTICE: start a background job, then wait for its notice.'
  );
  // As soon as the first answer is in and the chat is idle, start a longer turn.
  while (Date.now() - sentAt < 20_000) {
    const text = await lastAssistantText(evalAsync, sid);
    const st = await lib.turnStatus(evalAsync, sid);
    if (/Started a background job/.test(text) && !isBusy(st)) break;
    await sleep(100);
  }
  out.secondSentAfterMs =
    (await sendText(cdp, 'P0-SLEEPTOOL {"token":"b7","seconds":8} keep busy while the job ends.')) -
    sentAt;
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < 60_000) {
    const st = await lib.turnStatus(evalAsync, sid);
    quiet = isBusy(st) ? 0 : quiet + 1;
    if (quiet >= 12) break;
    await sleep(500);
  }
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.roles = await roles(evalAsync, sid);
  out.notices = await evalAsync(
    `${STORE}
     return (s.messages[${JSON.stringify(sid)}] ?? []).filter((m) => m.noticeKind || m.origin).map((m) => ({ role: m.role, noticeKind: m.noticeKind ?? null, origin: m.origin ?? null,
       text: (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '').slice(0, 160)).join('') }));`,
    { label: 'notices' }
  );
  out.noticeDom = await cdp.evaluate(`(() => {
    const hits = [...document.querySelectorAll('[title]')].filter((n) => n.offsetParent !== null && /job-notice-done/.test(n.getAttribute('title') || ''));
    return hits.map((n) => ({ text: (n.innerText || '').slice(0, 200), title: n.getAttribute('title'), icon: !!n.parentElement?.querySelector('svg'),
      cls: String(n.className?.baseVal ?? n.className ?? '').slice(0, 120), row: (n.parentElement?.innerText || '').slice(0, 200) }));
  })()`);
  out.transcript = (await cdp.evaluate(TRANSCRIPT)).slice(-2000);
  out.shot = await shot(cdp, 'B7-notice-row');
  const box = await cdp.evaluate(`(() => {
    const hits = [...document.querySelectorAll('[title]')].filter((n) => n.offsetParent !== null && /job-notice-done/.test(n.getAttribute('title') || ''));
    const n = hits[hits.length - 1];
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: r.x + Math.min(60, r.width / 2), y: r.y + r.height / 2 };
  })()`);
  if (box) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(1200);
    out.shotHover = await shot(cdp, 'B7-notice-row-hover', { bottom: false });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  }
  cdp.close();
  save('B7-notice-row', out);
}

const SLASH_MENU = `(() => {
  const opts = [...document.querySelectorAll('[role="option"], [role="listbox"] li, [cmdk-item], [data-slash-item]')].filter((n) => n.offsetParent !== null);
  if (opts.length) return { via: 'role', items: opts.map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120)) };
  const lb = [...document.querySelectorAll('[role="listbox"], [role="menu"], [data-slot="popover-popup"]')].filter((n) => n.offsetParent !== null);
  return { via: 'container', items: lb.map((n) => (n.innerText || '').slice(0, 3000)) };
})()`;

async function typeReal(cdp, text) {
  await cdp.evaluate(lib.typeIntoComposer(''));
  await cdp.evaluate(`(() => { document.querySelector('textarea').focus(); return true; })()`);
  await cdp.send('Input.insertText', { text });
}

async function a10() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid };
  await sendText(cdp, 'P0-STREAM: 先有一轮对话，再试斜杠命令。');
  out.turn0 = await waitTurn(evalAsync, sid);
  await sleep(800);
  // 1. The menu.
  await typeReal(cdp, '/');
  await sleep(1200);
  out.menu = await cdp.evaluate(SLASH_MENU);
  out.shotMenu = await shot(cdp, 'A10-slash-menu');
  // Scroll the list to its end for a second picture, if it scrolls.
  out.menuScrolled = await cdp.evaluate(`(() => {
    const lb = [...document.querySelectorAll('[role="listbox"]')].find((n) => n.offsetParent !== null);
    if (!lb) return null;
    const sc = [lb, ...lb.querySelectorAll('*')].find((n) => n.scrollHeight > n.clientHeight + 4);
    if (!sc) return 'no scroll';
    sc.scrollTop = sc.scrollHeight;
    return { scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight };
  })()`);
  await sleep(500);
  if (out.menuScrolled && out.menuScrolled !== 'no scroll')
    out.shotMenuEnd = await shot(cdp, 'A10-slash-menu-end', { bottom: false });
  await pressKey(cdp, 'Escape');
  await sleep(400);
  // 2. /compact with instructions.
  const tm = await toastMark(cdp);
  await typeReal(cdp, '/compact keep the API decisions');
  await sleep(600);
  out.menuWithArgs = await cdp.evaluate(SLASH_MENU);
  await pressKey(cdp, 'Enter');
  await sleep(2500);
  out.compactArgs = {
    composer: await cdp.evaluate(COMPOSER),
    toasts: await toastsSince(cdp, tm),
    alerts: await cdp.evaluate(
      `[...document.querySelectorAll('[role="alert"]')].filter((n) => n.offsetParent !== null).map((n) => (n.innerText || '').slice(0, 200))`
    ),
  };
  out.shotCompactArgs = await shot(cdp, 'A10-compact-with-args');
  // 3. /compact alone.
  const tm2 = await toastMark(cdp);
  await typeReal(cdp, '/compact');
  await sleep(600);
  out.menuCompact = await cdp.evaluate(SLASH_MENU);
  await pressKey(cdp, 'Enter');
  await sleep(600);
  // A highlighted menu entry may take the first Enter; a second one sends.
  const still = await cdp.evaluate(COMPOSER);
  if (still.value && still.value.trim().startsWith('/compact')) {
    out.secondEnter = true;
    await pressKey(cdp, 'Enter');
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    const st = await lib.turnStatus(evalAsync, sid);
    if (!isBusy(st) && Date.now() - t0 > 4000) break;
    await sleep(500);
  }
  await sleep(1500);
  out.compactAlone = {
    composer: await cdp.evaluate(COMPOSER),
    toasts: await toastsSince(cdp, tm2),
    roles: await roles(evalAsync, sid),
    transcript: (await cdp.evaluate(TRANSCRIPT)).slice(-1200),
  };
  out.shotCompact = await shot(cdp, 'A10-compact-done');
  // 4. /goal alone: a command answer, no model turn.
  const gw = lib.gatewayLog().length;
  await typeReal(cdp, '/goal');
  await sleep(600);
  await pressKey(cdp, 'Enter');
  await sleep(600);
  const still2 = await cdp.evaluate(COMPOSER);
  if (still2.value && still2.value.trim().startsWith('/goal')) {
    out.secondEnterGoal = true;
    await pressKey(cdp, 'Enter');
  }
  await sleep(4000);
  out.goalAlone = {
    composer: await cdp.evaluate(COMPOSER),
    roles: await roles(evalAsync, sid),
    gatewayRequests: lib.gatewayLog().length - gw,
    transcript: (await cdp.evaluate(TRANSCRIPT)).slice(-800),
    commandRows: await cdp.evaluate(
      `(() => [...document.querySelectorAll('svg.lucide-square-slash, svg[class*="square-slash"]')].filter((n) => n.offsetParent !== null).map((n) => (n.parentElement?.parentElement?.innerText || '').slice(0, 200)))()`
    ),
  };
  out.shotGoal = await shot(cdp, 'A10-goal-command');
  cdp.close();
  save('A10', out);
}

const OPEN_TREE = `(() => {
  const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || n.getAttribute('aria-label') || '').trim() === '会话分支' && n.offsetParent !== null);
  if (!b) return 'no button';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`;
const TREE_NODES = `(() => {
  const d = [...document.querySelectorAll('[data-slot="dialog-popup"]')].filter((n) => n.getAttribute('data-open') !== null).pop();
  if (!d) return null;
  const rows = [...d.querySelectorAll('button[aria-label="回退到这里"]')].map((b) => b.parentElement);
  return {
    header: (d.innerText || '').split('\\n').slice(0, 3).join(' | '),
    nodes: rows.map((r, i) => {
      const rewind = r.querySelector('button[aria-label="回退到这里"]');
      const fork = r.querySelector('button[aria-label="从这里分叉"]');
      return { i, text: (r.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120), depthPad: r.style.paddingLeft,
        selected: /bg-selection/.test(r.className), rewindDisabled: rewind?.disabled ?? null, forkDisabled: fork?.disabled ?? null, forkTitle: fork?.getAttribute('title') };
    }),
  };
})()`;
const treeClick = (index, label) => `(() => {
  const d = [...document.querySelectorAll('[data-slot="dialog-popup"]')].filter((n) => n.getAttribute('data-open') !== null).pop();
  const rows = [...d.querySelectorAll('button[aria-label="回退到这里"]')].map((b) => b.parentElement);
  const b = rows[${index}]?.querySelector('button[aria-label=${JSON.stringify(label)}]');
  if (!b) return 'no button';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`;
const CLOSE_TREE = `(() => {
  const d = [...document.querySelectorAll('[data-slot="dialog-popup"]')].filter((n) => n.getAttribute('data-open') !== null).pop();
  const b = d && [...d.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '关闭');
  if (b) b.click();
  return !!b;
})()`;
const userTexts = (evalAsync, sid) =>
  evalAsync(
    `${STORE}
     return (s.messages[${JSON.stringify(sid)}] ?? []).map((m) => m.role + ': ' + (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '').slice(0, 60)).join(''));`,
    { label: 'texts' }
  );

async function openTree(cdp) {
  const r = await cdp.evaluate(OPEN_TREE);
  let nodes = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(300);
    nodes = await cdp.evaluate(TREE_NODES);
    if (nodes && nodes.nodes.length) break;
  }
  return { open: r, ...nodes };
}

async function a3() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid };
  await sendText(cdp, 'P0-STREAM: A3-FIRST 第一轮。');
  out.t1 = (await waitTurn(evalAsync, sid)).status;
  await sleep(600);
  await sendText(cdp, 'P0-STREAM: A3-SECOND 第二轮。');
  out.t2 = (await waitTurn(evalAsync, sid)).status;
  await sleep(800);
  out.textsBefore = await userTexts(evalAsync, sid);
  out.tree1 = await openTree(cdp);
  out.shotTree = await shot(cdp, 'A3-tree-dialog', { bottom: false });
  // Rewind to the second prompt.
  const idx = out.tree1.nodes.findIndex((n) => /A3-SECOND/.test(n.text) && /user/.test(n.text));
  out.rewindIndex = idx;
  out.rewindClick = await cdp.evaluate(treeClick(idx, '回退到这里'));
  await sleep(900);
  out.confirm = await cdp.evaluate(DIALOG);
  out.shotConfirm = await shot(cdp, 'A3-rewind-confirm', { bottom: false });
  out.confirmClick = await cdp.evaluate(dialogButton('回退'));
  await sleep(3500);
  out.treeAfterRewind = await cdp.evaluate(TREE_NODES);
  await cdp.evaluate(CLOSE_TREE);
  await sleep(1500);
  out.textsAfterRewind = await userTexts(evalAsync, sid);
  out.composerAfterRewind = await cdp.evaluate(COMPOSER);
  out.transcriptAfterRewind = (await cdp.evaluate(TRANSCRIPT)).slice(-1500);
  out.shotAfterRewind = await shot(cdp, 'A3-after-rewind');
  // One more turn: only the kept content is visible to the model.
  await sendText(cdp, 'P0-RECALL {"markers":["A3-FIRST","A3-SECOND"]} 回退之后模型还看得到哪些？');
  out.t3 = (await waitTurn(evalAsync, sid)).status;
  await sleep(800);
  out.recall = await lastAssistantText(evalAsync, sid);
  out.textsAfterRecall = await userTexts(evalAsync, sid);
  out.shotRecall = await shot(cdp, 'A3-recall-after-rewind');
  // Back to a node on the old branch.
  out.tree2 = await openTree(cdp);
  const old = out.tree2.nodes.findIndex(
    (n) =>
      /A3-SECOND/.test(n.text) === false &&
      /assistant/.test(n.text) &&
      !n.selected &&
      n.rewindDisabled === false &&
      /DSH 引擎/.test(n.text)
  );
  // Prefer the assistant answer that followed the old second prompt: the last non-active assistant node.
  const candidates = out.tree2.nodes.filter(
    (n) => /assistant/.test(n.text) && !n.selected && n.rewindDisabled === false
  );
  out.oldCandidates = candidates.map((n) => n.i);
  const target = candidates.length ? candidates[candidates.length - 1].i : old;
  out.oldIndex = target;
  out.shotTree2 = await shot(cdp, 'A3-tree-dialog-after-recall', { bottom: false });
  out.switchClick = await cdp.evaluate(treeClick(target, '回退到这里'));
  await sleep(900);
  out.confirm2 = await cdp.evaluate(DIALOG);
  out.confirmClick2 = await cdp.evaluate(dialogButton('回退'));
  await sleep(3500);
  out.treeAfterSwitch = await cdp.evaluate(TREE_NODES);
  await cdp.evaluate(CLOSE_TREE);
  await sleep(1500);
  out.textsAfterSwitch = await userTexts(evalAsync, sid);
  out.composerAfterSwitch = await cdp.evaluate(COMPOSER);
  out.transcriptAfterSwitch = (await cdp.evaluate(TRANSCRIPT)).slice(-1500);
  out.shotAfterSwitch = await shot(cdp, 'A3-after-switch-old-branch');
  cdp.close();
  save('A3', out);
}

async function a4() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await activeSid(evalAsync);
  const out = {
    sid,
    title: await sessionTitle(evalAsync, sid),
    textsBefore: await userTexts(evalAsync, sid),
  };
  const sessionsBefore = await evalAsync(`${STORE} return s.sessions.map((x) => x.id);`, {
    label: 'ids',
  });
  out.tree = await openTree(cdp);
  const idx = out.tree.nodes.findIndex((n) => /assistant/.test(n.text));
  out.forkIndex = idx;
  out.forkClick = await cdp.evaluate(treeClick(idx, '从这里分叉'));
  await sleep(5000);
  out.dialogAfterFork = await cdp.evaluate(TREE_NODES);
  const after = await evalAsync(
    `${STORE}
     return { active: s.activeSessionId, sessions: s.sessions.map((x) => ({ id: x.id, title: x.title, status: x.status })) };`,
    { label: 'after fork' }
  );
  const fresh = after.sessions.filter((x) => !sessionsBefore.includes(x.id));
  out.newSessions = fresh;
  out.activeAfterFork = after.active;
  out.sidebarRows = await cdp.evaluate(
    `[...document.querySelectorAll('[role="button"][title]')].filter((n) => n.offsetParent !== null).map((n) => n.getAttribute('title')).filter((t) => /fork|分叉/.test(t))`
  );
  out.shotSidebar = await shot(cdp, 'A4-fork-created');
  const fork = fresh[0];
  if (fork) {
    if (after.active !== fork.id)
      out.openedFork = await openBySuffix(cdp, evalAsync, fork.id.slice(-20));
    await sleep(2500);
    out.forkTexts = await userTexts(evalAsync, fork.id);
    out.forkTranscript = (await cdp.evaluate(TRANSCRIPT)).slice(-1200);
    out.shotFork = await shot(cdp, 'A4-fork-opened');
    // The fork takes a turn and sees only what came before the fork point.
    await sendText(cdp, 'P0-RECALL {"markers":["A3-FIRST","A3-SECOND"]} 分叉里模型看得到哪些？');
    out.forkTurn = (await waitTurn(evalAsync, fork.id)).status;
    await sleep(800);
    out.forkRecall = await lastAssistantText(evalAsync, fork.id);
    out.shotForkRecall = await shot(cdp, 'A4-fork-recall');
  }
  out.openedOriginal = await openBySuffix(cdp, evalAsync, sid.slice(-20));
  await sleep(2500);
  out.originalTexts = await userTexts(evalAsync, sid);
  out.shotOriginal = await shot(cdp, 'A4-original-unchanged');
  cdp.close();
  save('A4', out);
}

/** Open each chat (by id suffix), expand its work groups and keep the timeline text: A1's before / after. */
async function timelines(tag, ...suffixes) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const body = fs.readFileSync(path.join(here, 'timeline.body.txt'), 'utf8');
  const out = {};
  for (const suffix of suffixes) {
    await cdp.evaluate(`(() => { window.__p17dOpen = ${JSON.stringify(suffix)}; return true; })()`);
    out[suffix] = await evalAsync(body, { label: `timeline ${suffix}`, timeoutMs: 60_000 });
  }
  cdp.close();
  save(`timelines-${tag}`, out);
}

/** Host processes whose open descriptors name this chat's DSH directory. */
function hostsHolding(sessionId) {
  const needle = `aiclient-${sessionId}`;
  const out = [];
  for (const row of lib.procList().filter(lib.isOurHost)) {
    let hits = 0;
    try {
      for (const fd of fs.readdirSync(`/proc/${row.pid}/fd`)) {
        try {
          if (fs.readlinkSync(`/proc/${row.pid}/fd/${fd}`).includes(needle)) hits += 1;
        } catch {
          // closed meanwhile
        }
      }
    } catch {
      // gone
    }
    out.push({ pid: row.pid, fdHits: hits });
  }
  return out;
}

const hostStatus = (evalAsync) =>
  evalAsync('return await window.electronAPI.chat.getHostStatus();', { label: 'host status' });

/**
 * A12 then A1 after a full restart: hover, then click (read-only preview) a
 * chat that was not opened in this run; check slots, descriptors and the log.
 */
async function preview(tag, suffix, beforeFile) {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const target = await evalAsync(
    `${STORE} const x = s.sessions.find((y) => y.id.endsWith(${JSON.stringify(suffix)})); return x ? { id: x.id, title: x.title, status: x.status } : null;`,
    { label: 'target' }
  );
  const out = { target, activeAtStart: await activeSid(evalAsync) };
  const gw0 = lib.gatewayLog().length;
  out.hostBefore = await hostStatus(evalAsync);
  out.hostsBefore = hostsHolding(target.id);
  out.filesBefore = lib.sessionFiles(target.id);
  out.messagesBefore = await evalAsync(
    `${STORE} return (s.messages[${JSON.stringify(target.id)}] ?? []).length;`,
    { label: 'msgs' }
  );
  // Hover the row.
  const box = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('[role="button"][title]')].find((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(target.title)});
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (box) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(3000);
    out.shotHover = await shot(cdp, `${tag}-hover`, { bottom: false });
  }
  out.hostAfterHover = await hostStatus(evalAsync);
  out.filesAfterHover = lib.sessionFiles(target.id);
  // Click: the read-only preview.
  await cdp.evaluate(clickRow(target.title));
  for (let i = 0; i < 30; i += 1) {
    await sleep(300);
    if ((await activeSid(evalAsync)) === target.id) break;
  }
  await sleep(5000);
  out.hostAfterClick = await hostStatus(evalAsync);
  out.hostsAfterClick = hostsHolding(target.id);
  out.filesAfterClick = lib.sessionFiles(target.id);
  out.messagesAfterClick = await evalAsync(
    `${STORE} return (s.messages[${JSON.stringify(target.id)}] ?? []).length;`,
    { label: 'msgs' }
  );
  out.statusAfterClick = (await lib.turnStatus(evalAsync, target.id)).status;
  out.gatewayRequests = lib.gatewayLog().length - gw0;
  out.composer = await cdp.evaluate(COMPOSER);
  out.events = await cdp.evaluate(
    `(window.__p17dEvents ?? []).filter((e) => e.sessionId === ${JSON.stringify(target.id)}).map((e) => e.type)`
  );
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.timeline = await evalAsync(
    `const viewports = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')].filter((v) => v.offsetParent !== null && !/仓库列表/.test(v.innerText || ''));
     let best = null;
     for (const v of viewports) if (!best || (v.innerText || '').length > (best.innerText || '').length) best = v;
     return (best?.innerText ?? '').replace(/\\n{2,}/g, '\\n').slice(0, 4000);`,
    { label: 'timeline' }
  );
  if (beforeFile) {
    const before = JSON.parse(fs.readFileSync(path.join(resultsDir, beforeFile), 'utf8'));
    const prior = before[suffix]?.timeline ?? null;
    out.sameAsBeforeQuit =
      prior === null
        ? null
        : prior.replace(/\s+/g, ' ').trim() === out.timeline.replace(/\s+/g, ' ').trim();
    out.beforeQuitTimeline = prior;
  }
  out.shotPreview = await shot(cdp, `${tag}-preview`);
  cdp.close();
  save(tag, out);
}

const items = {
  a9,
  a5,
  a5fail,
  a6,
  a11,
  a7,
  a7b,
  a8,
  a2,
  b1,
  b5,
  b2,
  b3,
  b4,
  b4b,
  b7,
  b7b,
  a10,
  a3,
  a4,
  timelines,
  preview,
};
const name = process.argv[2];
if (!items[name]) {
  console.error(`usage: p1-7d-items.mjs ${Object.keys(items).join('|')}`);
  process.exit(2);
}
await items[name](...process.argv.slice(3));
process.exit(0);
