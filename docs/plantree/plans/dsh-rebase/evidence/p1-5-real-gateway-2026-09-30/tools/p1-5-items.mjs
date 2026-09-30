#!/usr/bin/env node
/**
 * p1-5-items.mjs — the R2–R8 items of the P1-5 real-gateway run, 2026-09-30.
 *
 * Built on p1-5-gw.mjs (attach-only CDP driver, scrubbed output, request
 * ledger). Every model request goes through the app's own UI and is logged in
 * ../results/requests.jsonl before it is made; the ledger refuses request 61.
 *
 *   node p1-5-items.mjs turn <group> <label> <effort|-> <tag> [text]   new chat, pick, send, wait
 *   node p1-5-items.mjs again <sid> <tag> [text]                        another turn in a chat
 *   node p1-5-items.mjs events <sid>                                    recorded runtime events
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { gw } = await import(path.join(here, 'p1-5-gw.mjs'));
const { attach, makeEval, STORE, save, sleep } = gw;

/** Record runtime events per session: first delta times, terminal events (error text trimmed). */
const INSTALL_EVENTS = `(() => {
  if (window.__p15gwEventsV2) return 'already';
  window.__p15gwEventsV2 = true;
  window.__p15gwEv2 = [];
  window.__p15gwRoles = new Map();
  window.electronAPI.chat.onRuntimeEvent((event) => {
    const p = event.payload ?? {};
    const keep = { t: Date.now(), type: event.type, sessionId: event.sessionId };
    if (event.type === 'message.started') {
      window.__p15gwRoles.set(p.messageId, p.role);
      if (p.role !== 'assistant' && p.role !== 'error') return;
      keep.role = p.role;
    } else if (event.type === 'message.delta' || event.type === 'thinking.delta') {
      // First non-empty assistant delta per kind after the send click.
      if (event.type === 'message.delta' && window.__p15gwRoles.get(p.messageId) !== 'assistant') return;
      if (!String(p.text ?? p.delta ?? '').length) return;
      const list = window.__p15gwEv2;
      const seen = list.some((e) => e.sessionId === event.sessionId && e.type === event.type && e.t >= (window.__p15gwSentAt?.[event.sessionId] ?? 0));
      if (seen) return;
    } else if (/^session\\.(failed|completed|stopped)$/.test(event.type)) {
      keep.error = typeof p.error === 'string' ? p.error.slice(0, 400) : null;
      keep.errorCode = p.errorCode ?? null;
      keep.stopCause = p.stopCause ?? null;
    } else if (event.type === 'session.status') {
      keep.status = p.status ?? p.state ?? null;
    } else if (event.type === 'tool.started' || event.type === 'tool.completed') {
      keep.tool = p.toolName ?? p.name ?? null;
    } else if (event.type === 'host.error' || event.type === 'session.stderr') {
      keep.error = String(p.message ?? p.error ?? p.text ?? '').slice(0, 300);
    } else if (event.type === 'usage.updated') {
      keep.usage = { input: p.usage?.input ?? p.input ?? null, output: p.usage?.output ?? p.output ?? null };
    } else {
      return;
    }
    window.__p15gwEv2.push(keep);
    if (window.__p15gwEv2.length > 3000) window.__p15gwEv2.splice(0, 500);
  });
  return 'installed';
})()`;

const eventsFor = (cdp, sid, since = 0) =>
  cdp.evaluate(
    `(window.__p15gwEv2 ?? []).filter((e) => e.sessionId === ${JSON.stringify(sid)} && e.t >= ${Number(since)})`
  );

/**
 * One turn in the active chat: send, wait, read the outcome and the events.
 * `firstDeltaMs` is the first message/thinking delta the renderer received
 * after the send click (the UI-side first-token latency).
 */
async function runTurn(
  cdp,
  evalAsync,
  sid,
  text,
  { item, model, effort, allow = false, timeoutMs = 240_000, onTick = null } = {}
) {
  const n = gw.spendRequest({ item, model, effort, kind: 'chat turn' });
  await cdp.evaluate(
    `(() => { window.__p15gwSentAt = window.__p15gwSentAt ?? {}; window.__p15gwSentAt[${JSON.stringify(sid)}] = Date.now(); return true; })()`
  );
  await cdp.evaluate(gw.typeIntoComposer(text));
  await cdp.waitFor(gw.SEND_READY, { timeoutMs: 30_000, label: 'send ready' });
  const sentAt = Date.now();
  await cdp.evaluate(gw.CLICK_SEND);
  const wait = await gw.waitTurnTimed(cdp, evalAsync, sid, sentAt, { timeoutMs, allow, onTick });
  await sleep(500);
  const events = await eventsFor(cdp, sid, sentAt - 1000);
  const firstDelta = events.find((e) => e.type === 'message.delta');
  const firstThinking = events.find((e) => e.type === 'thinking.delta');
  const terminal = events.filter((e) => /^session\.(failed|completed|stopped)$/.test(e.type));
  const assistantStarted = events.find(
    (e) => e.type === 'message.started' && e.role === 'assistant'
  );
  const outcome = await gw.turnOutcome(evalAsync, sid);
  return {
    request: n,
    sid,
    model,
    effort,
    settled: wait.settled,
    neverBusy: wait.neverBusy ?? false,
    durationMs: wait.durationMs ?? null,
    firstDeltaMs: firstDelta ? firstDelta.t - sentAt : null,
    firstThinkingMs: firstThinking ? firstThinking.t - sentAt : null,
    assistantStartedMs: assistantStarted ? assistantStarted.t - sentAt : null,
    firstVisibleTextMs: wait.firstTextMs ?? null,
    statuses: wait.statuses,
    cards: wait.cards,
    terminal,
    hostErrors: events.filter((e) => e.type === 'host.error'),
    outcome,
  };
}

async function turnItem(group, label, effort, tag, text = '只回复 OK', allow = '0') {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await gw.learnEndpointHost(evalAsync);
  await cdp.evaluate(INSTALL_EVENTS);
  const sid = await gw.newChat(cdp, evalAsync);
  await sleep(800);
  const pick = await gw.pickModel(cdp, { label, group, effort: effort === '-' ? null : effort });
  if (!pick.picked) {
    cdp.close();
    save(tag, { error: 'model not picked', pick });
    return;
  }
  const stored = await evalAsync(
    `const m = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     const st = m.useSettingsStore.getState();
     return { defaults: st.chatAgentDefaults ?? null };`,
    { label: 'defaults' }
  );
  const out = await runTurn(cdp, evalAsync, sid, text, {
    item: tag,
    model: label,
    effort,
    allow: allow === '1',
  });
  out.pick = pick;
  out.defaults = stored.defaults;
  out.problems = cdp.problems.slice(0, 5);
  cdp.close();
  save(tag, out);
}

async function againItem(sid, tag, text = '只回复 OK', allow = '0') {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await gw.learnEndpointHost(evalAsync);
  await cdp.evaluate(INSTALL_EVENTS);
  const active = await gw.activeSid(evalAsync);
  if (active !== sid) throw new Error(`active chat is ${active}, not ${sid}`);
  const trigger = await cdp.evaluate(gw.MODEL_TRIGGER);
  const out = await runTurn(cdp, evalAsync, sid, text, {
    item: tag,
    model: trigger?.text,
    allow: allow === '1',
  });
  out.trigger = trigger;
  cdp.close();
  save(tag, out);
}

/** One line per saved result, for reading a batch at a glance. */
function summaryLine(r) {
  return JSON.stringify({
    tag: r.tag,
    req: r.request,
    model: r.model,
    effort: r.effort,
    picked: r.pick?.picked,
    trigger: r.pick?.trigger?.text ?? r.trigger?.text,
    settled: r.settled,
    durMs: r.durationMs,
    firstDeltaMs: r.firstDeltaMs,
    firstThinkingMs: r.firstThinkingMs,
    startedMs: r.assistantStartedMs,
    terminal: r.terminal?.map((e) => [e.type, e.errorCode, e.error?.slice(0, 200)]),
    text: r.outcome?.text?.slice(0, 80),
    status: r.outcome?.status,
    tools: r.outcome?.tools?.length ? r.outcome.tools : undefined,
    cards: r.cards?.length ? r.cards.map((c) => c.card.slice(0, 120)) : undefined,
    error: r.error,
  });
}

/** Several R2-style turns in a row: `group|label|effort|tag` per argument; stops on a whole-gateway failure. */
async function batchItem(...specs) {
  for (const spec of specs) {
    const [group, label, effort, tag, text, allow] = spec.split('|');
    try {
      await turnItemQuiet(group, label, effort, tag, text, allow);
    } catch (error) {
      console.log(
        JSON.stringify({ tag, error: gw.scrubText(String(error?.message ?? error)).slice(0, 300) })
      );
      break;
    }
  }
}

async function turnItemQuiet(group, label, effort, tag, text, allow) {
  const log = console.log;
  console.log = () => {};
  try {
    await turnItem(group, label, effort, tag, text || undefined, allow || '0');
  } finally {
    console.log = log;
  }
  const r = JSON.parse(
    (await import('node:fs')).readFileSync(path.join(gw.resultsDir, `${tag}.json`), 'utf8')
  );
  console.log(summaryLine({ tag, ...r }));
}

/**
 * R4: one chat per model; every effort row the menu offers (minus `skip`,
 * comma-separated labels) gets one turn, picked through the menu's own effort
 * group. `dry` = 1 only reads the rows.
 */
async function effortsItem(group, label, tag, skip = '', dry = '0') {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await gw.learnEndpointHost(evalAsync);
  await cdp.evaluate(INSTALL_EVENTS);
  const sid = await gw.newChat(cdp, evalAsync);
  await sleep(800);
  const pick = await gw.pickModel(cdp, { label, group });
  const rows = await gw.effortRows(cdp);
  const out = { sid, model: label, pick, rows, runs: [] };
  if (dry === '1' || !pick.picked) {
    cdp.close();
    save(tag, out);
    return;
  }
  const skipped = new Set(skip.split(',').filter(Boolean));
  for (const row of rows) {
    if (skipped.has(row.text)) continue;
    await gw.openRootMenu(cdp);
    const picked = await cdp.evaluate(gw.clickMenuItemExact(row.text, 'menuitemradio'));
    await sleep(600);
    await gw.closeMenus(cdp);
    const trigger = await cdp.evaluate(gw.MODEL_TRIGGER);
    const run = await runTurn(cdp, evalAsync, sid, `只回复 OK（档位：${row.text}）`, {
      item: tag,
      model: label,
      effort: row.text,
    });
    out.runs.push({ effort: row.text, picked, trigger: trigger?.text, ...run });
    console.error(
      `[r4] ${label} ${row.text}: ${run.terminal.map((e) => e.type).join(',')} ${run.durationMs}ms ${gw.scrubText(run.outcome.text).slice(0, 40)}`
    );
    // A whole-gateway failure stops the item rather than spending the rest.
    if (
      run.terminal.some((e) => e.type === 'session.failed') &&
      out.runs.filter((r) => r.terminal.some((e) => e.type === 'session.failed')).length >= 2
    )
      break;
  }
  cdp.close();
  save(tag, out);
}

/**
 * R5: one chat, three turns: model A (sets a code word), model B on another
 * protocol (asked for it), back to A (asked again). Every pick goes through
 * the composer menu of the same chat.
 */
async function switchItem(groupA, labelA, groupB, labelB, tag = 'r5-switch') {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await gw.learnEndpointHost(evalAsync);
  await cdp.evaluate(INSTALL_EVENTS);
  const sid = await gw.newChat(cdp, evalAsync);
  await sleep(800);
  const out = { sid, steps: [] };
  const steps = [
    [groupA, labelA, '请记住这个暗号：蓝色长颈鹿 42。只回复「记住了」。'],
    [groupB, labelB, '我刚才让你记住的暗号是什么？只回复暗号本身。'],
    [
      groupA,
      labelA,
      '把暗号再说一遍，并告诉我这是我们对话的第几轮提问（数字）。只回复「暗号 / 轮数」。',
    ],
  ];
  for (const [group, label, text] of steps) {
    const pick = await gw.pickModel(cdp, { label, group });
    const run = await runTurn(cdp, evalAsync, sid, text, { item: tag, model: label });
    out.steps.push({ model: label, pick: pick.picked, trigger: pick.trigger?.text, ...run });
    console.error(
      `[r5] ${label}: ${run.terminal.map((e) => e.type).join(',')} ${gw.scrubText(run.outcome.text).slice(0, 80)}`
    );
    if (!run.terminal.some((e) => e.type === 'session.completed')) break;
  }
  out.problems = cdp.problems.slice(0, 5);
  cdp.close();
  save(tag, out);
}

/** A solid-colour PNG drawn in the page and pasted into the composer (no file from disk). */
const PASTE_PNG = (color, size) => `
  const c = document.createElement('canvas');
  c.width = ${size}; c.height = ${size};
  const g = c.getContext('2d');
  g.fillStyle = ${JSON.stringify(color)}; g.fillRect(0, 0, ${size}, ${size});
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'r6-solid.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ta = document.querySelector('textarea');
  ta.focus();
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  ta.dispatchEvent(ev);
  return { bytes: blob.size, defaultPrevented: ev.defaultPrevented };`;

const CHIPS = `[...document.querySelectorAll('button[aria-label^="移除 "], button[aria-label^="Remove "]')].filter((b) => b.offsetParent !== null).map((b) => b.getAttribute('aria-label'))`;

/** R6: paste a solid red square into a chat on an image-capable model and ask for its colour. */
async function imageItem(group, label, tag, color = '#e02424') {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await gw.learnEndpointHost(evalAsync);
  await cdp.evaluate(INSTALL_EVENTS);
  const sid = await gw.newChat(cdp, evalAsync);
  await sleep(800);
  const pick = await gw.pickModel(cdp, { label, group });
  const paste = await evalAsync(PASTE_PNG(color, 64), { label: 'paste png' });
  let chips = [];
  for (let i = 0; i < 20 && !chips.length; i += 1) {
    await sleep(250);
    chips = await cdp.evaluate(CHIPS);
  }
  const notice = await cdp.evaluate(
    `(() => { const t = document.body.innerText; const m = /[^\\n]*(不支持图片|图片将被|image omitted|does not support images)[^\\n]*/.exec(t); return m ? m[0].slice(0, 160) : null; })()`
  );
  const run = await runTurn(cdp, evalAsync, sid, '这张图片是什么颜色？只回复颜色名称（中文）。', {
    item: tag,
    model: label,
  });
  const userBlocks = await evalAsync(
    `${STORE}
     const msgs = s.messages[${JSON.stringify(sid)}] ?? [];
     const u = msgs.find((m) => m.role === 'user');
     return (u?.blocks ?? []).map((b) => b.type).concat((u?.attachments ?? []).map((a) => 'attachment:' + (a.mimeType ?? a.kind ?? '?')));`,
    { label: 'user blocks' }
  );
  cdp.close();
  save(tag, { sid, model: label, color, pick, paste, chips, notice, userBlocks, ...run });
}

/** DSH host processes of this app: our worktree's host entry under the running Electron. */
function hostProcs() {
  const rows = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ');
      if (!cmd.includes(path.join(gw.repoRoot, 'src/dsh-host/host.ts'))) continue;
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      rows.push({ pid: Number(entry), ppid });
    } catch {
      // gone
    }
  }
  return rows;
}

/**
 * R8: a turn in flight, then logout through the account card (pill → 退出登录 →
 * confirm). Watches the turn's terminal event, the host process and the page
 * for 40 s. Does NOT sign in again (the user has to receive a code).
 */
async function logoutItem(group = 'Claude', label = 'Claude Sonnet 5.5', tag = 'r8-logout') {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await gw.learnEndpointHost(evalAsync);
  await cdp.evaluate(INSTALL_EVENTS);
  const sid = await gw.newChat(cdp, evalAsync);
  await sleep(800);
  const pick = await gw.pickModel(cdp, { label, group, effort: '默认' });
  const out = { sid, model: label, pick, hostsBefore: hostProcs() };
  const n = gw.spendRequest({
    item: tag,
    model: label,
    effort: '默认',
    kind: 'chat turn (logout mid-turn)',
  });
  out.request = n;
  await cdp.evaluate(
    `(() => { window.__p15gwSentAt = window.__p15gwSentAt ?? {}; window.__p15gwSentAt[${JSON.stringify(sid)}] = Date.now(); return true; })()`
  );
  await cdp.evaluate(
    gw.typeIntoComposer(
      '请写一篇约 800 字的中文短文，介绍中位数和平均数的区别，并各举两个生活中的例子。不要使用任何工具。'
    )
  );
  await cdp.waitFor(gw.SEND_READY, { timeoutMs: 30_000, label: 'send ready' });
  const sentAt = Date.now();
  await cdp.evaluate(gw.CLICK_SEND);
  // Wait until the answer is streaming (or at least running for 4 s).
  let st = null;
  while (Date.now() - sentAt < 90_000) {
    st = await evalAsync(
      `${STORE}
       const x = s.sessions.find((r) => r.id === ${JSON.stringify(sid)});
       const msgs = s.messages[${JSON.stringify(sid)}] ?? [];
       const a = [...msgs].reverse().find((m) => m.role === 'assistant');
       return { status: x?.status ?? null, textLen: (a?.blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('').length };`,
      { label: 'in flight' }
    );
    if (st.status === 'running' && (st.textLen > 40 || Date.now() - sentAt > 20_000)) break;
    await sleep(250);
  }
  out.beforeLogout = { dt: Date.now() - sentAt, ...st };
  // Account pill → profile card → 退出登录 → confirm.
  out.pill = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button[aria-label="用户资料"]')].find((n) => n.offsetParent !== null);
    if (!b) return false;
    if (b.getAttribute('aria-expanded') !== 'true') b.click();
    return true;
  })()`);
  await sleep(900);
  out.logoutButton = await cdp.evaluate(`(() => {
    // The profile card is itself a popover (role=dialog); the confirm dialog is the one titled 确认退出登录.
    const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && (n.innerText || '').trim() === '退出登录' && !/确认退出登录/.test(n.closest('[role="dialog"]')?.innerText || ''));
    if (!b) return 'no button';
    if (b.disabled) return 'disabled';
    b.click();
    return 'clicked';
  })()`);
  await sleep(900);
  out.confirmDialog = await cdp.evaluate(`(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].filter((n) => n.getAttribute('data-open') !== null && /确认退出登录/.test(n.innerText || '')).pop();
    return d ? (d.innerText || '').replace(/\\s+/g, ' ').slice(0, 400) : null;
  })()`);
  const logoutAt = Date.now();
  out.confirm = await cdp.evaluate(`(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].filter((n) => n.getAttribute('data-open') !== null && /确认退出登录/.test(n.innerText || '')).pop();
    if (!d) return 'no dialog';
    const b = [...d.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '退出登录');
    if (!b) return 'no button';
    b.click();
    return 'clicked';
  })()`);
  const trace = [];
  let hostGoneAt = null;
  let lastEvents = [];
  let pageGone = null;
  while (Date.now() - logoutAt < 40_000) {
    await sleep(300);
    const hosts = hostProcs();
    if (hostGoneAt === null && hosts.length === 0) hostGoneAt = Date.now() - logoutAt;
    try {
      const s1 = await evalAsync(
        `${STORE}
         const x = s.sessions.find((r) => r.id === ${JSON.stringify(sid)});
         return { status: x?.status ?? null, body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160) };`,
        { label: 'after logout', timeoutMs: 5000 }
      );
      if (trace.at(-1)?.status !== s1.status || trace.at(-1)?.body !== s1.body)
        trace.push({
          dt: Date.now() - logoutAt,
          status: s1.status,
          body: s1.body,
          hosts: hosts.length,
        });
      lastEvents = await eventsFor(cdp, sid, sentAt - 1000);
    } catch (error) {
      pageGone = {
        dt: Date.now() - logoutAt,
        error: String(error?.message ?? error).slice(0, 160),
      };
      break;
    }
  }
  out.logoutAtFromSend = logoutAt - sentAt;
  out.hostGoneAfterLogoutMs = hostGoneAt;
  out.hostsAfter = hostProcs();
  out.trace = trace;
  out.pageGone = pageGone;
  out.terminal = lastEvents.filter(
    (e) => /^session\.(failed|completed|stopped)$/.test(e.type) || e.type === 'host.error'
  );
  out.statusEvents = lastEvents
    .filter((e) => e.type === 'session.status')
    .map((e) => ({ dt: e.t - logoutAt, status: e.status }));
  try {
    out.finalBody = await cdp.evaluate(
      `document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400)`
    );
    out.finalHasAt = await cdp.evaluate(`document.body.innerText.includes('@')`);
    if (!out.finalHasAt) out.shot = await gw.shot(cdp, 'r8-after-logout');
  } catch (error) {
    out.finalBody = `unreadable: ${String(error?.message ?? error).slice(0, 120)}`;
  }
  out.problems = cdp.problems.slice(0, 8);
  cdp.close();
  save(tag, out);
}

async function eventsItem(sid) {
  const cdp = await attach();
  const out = await eventsFor(cdp, sid, 0);
  cdp.close();
  console.log(JSON.stringify(gw.scrub(out), null, 2));
}

const items = {
  turn: turnItem,
  again: againItem,
  events: eventsItem,
  batch: batchItem,
  efforts: effortsItem,
  switch: switchItem,
  image: imageItem,
  logout: logoutItem,
};

export const p15 = { INSTALL_EVENTS, eventsFor, runTurn };

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const name = process.argv[2];
  if (!items[name]) {
    console.error(`usage: p1-5-items.mjs ${Object.keys(items).join('|')}`);
    process.exit(2);
  }
  await items[name](...process.argv.slice(3));
  process.exit(0);
}
