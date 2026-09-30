#!/usr/bin/env node
/**
 * p1-7e-e2.mjs — re-check items for P1-7e groups e2a / e2b (decisions 139,
 * 140), plus the e1 rename-after-a-dialog check and the e4 tree-dialog labels
 * that ride on the same chats. Helpers from p1-7e-items.mjs (`e7`).
 *
 *   P17D_SCRATCH=/tmp/aiclient-p17e node p1-7e-e2.mjs <item> [args]
 *
 *   rewind               two turns, text typed, rewind to the 2nd prompt; rename after the dialog; fork
 *   empty                one turn, rewind to the 1st prompt (the empty state)
 *   drafts <A> <B>       text + attachment typed in A, switch to B and back
 *   fail                 P1-FAIL: retry banner class words, the failure card, the sidebar badge
 *   gate                 P1-GATE: the stream-gate card, no retry banner
 *   compact              one turn, then /compact: the summary row at once, the work line
 *   think                P1-THINK, then a new chat and back: 「思考 N 秒」
 *   stop                 P0-SLEEPTOOL, Stop while it runs: the row body keeps the output
 *   fs                   P0-FS (spill line), P1-PERM-SEARCH (glob), P1-FILEREAD (attachment row)
 *   reopen <suffix> <tag>  open a chat, expand, read the work lines and turn-end notes, shoot
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { lib } = await import(path.join(here, 'p1-7e-gui.mjs'));
const { e7 } = await import(path.join(here, 'p1-7e-items.mjs'));
const { attach, makeEval, sendText, waitTurn, STORE, sleep } = lib;
const {
  shot,
  save,
  newChat,
  setGear,
  pressKey,
  waitFor,
  CLICK_STOP,
  TRANSCRIPT,
  COMPOSER,
  openChat,
  SIDEBAR,
  renameViaMenu,
  turnAllowing,
  TOOL_ROWS_DOM,
  clickToolRow,
  ROW_BOX,
  LIVE_OUTPUT,
  CONTRAST,
  PASTE_NOTES,
  WORK_LINES,
  TREE_NODES,
  treeClick,
  CLOSE_TREE,
  DIALOG,
  dialogButton,
  openTree,
  userTexts,
  sessionInfo,
  bashCalls,
  toastMark,
  toastsSince,
  roles,
} = e7;

const setComposer = (text) => lib.typeIntoComposer(text);

// ---- e2a: rewind hands the prompt back; the new fork shows its seed ---------------------

async function rewind() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid };
  await sendText(cdp, 'P0-STREAM: E2A-FIRST 第一轮。');
  out.t1 = (await waitTurn(evalAsync, sid)).status;
  await sleep(600);
  await sendText(cdp, 'P0-STREAM: E2A-SECOND 第二轮。');
  out.t2 = (await waitTurn(evalAsync, sid)).status;
  await sleep(800);
  // The user has already started typing something else.
  await cdp.evaluate(setComposer('先打的字 E2A-TYPED'));
  await sleep(300);
  out.composerBefore = await cdp.evaluate(COMPOSER);
  out.tree = await openTree(cdp);
  out.shotTree = await shot(cdp, 'e4-tree-dialog-labels', { bottom: false });
  const idx = out.tree.nodes.findIndex((n) => /E2A-SECOND/.test(n.text) && /用户/.test(n.text));
  out.rewindIndex = idx;
  out.rewindClick = await cdp.evaluate(treeClick(idx, '回退到这里'));
  await sleep(900);
  out.confirm = await cdp.evaluate(DIALOG);
  out.confirmClick = await cdp.evaluate(dialogButton('回退'));
  await sleep(3500);
  await cdp.evaluate(CLOSE_TREE);
  await sleep(1500);
  out.textsAfter = await userTexts(evalAsync, sid);
  out.composerAfter = await cdp.evaluate(COMPOSER);
  out.handedBack = /先打的字 E2A-TYPED\s*\n\s*\n.*E2A-SECOND/s.test(out.composerAfter?.value ?? '');
  out.shotAfter = await shot(cdp, 'e2a-A3-rewind-prompt-back');
  // e1 (issue 26): rename right after a dialog was open, Enter commits.
  const info = await sessionInfo(evalAsync, sid);
  out.titleBefore = info.title;
  out.renameEnter = await renameViaMenu(cdp, info.title, 'E1 改名-回车生效');
  out.titleAfterEnter = (await sessionInfo(evalAsync, sid)).title;
  out.sidebarAfterEnter = (await cdp.evaluate(SIDEBAR)).rows.filter((r) =>
    r.title.includes('E1 改名')
  );
  out.shotRenamed = await shot(cdp, 'e1-rename-after-dialog-enter', { bottom: false });
  // … and Esc cancels.
  out.renameEsc = await renameViaMenu(cdp, out.titleAfterEnter, 'E1 这个名字不该留下', {
    finish: 'escape',
  });
  out.titleAfterEsc = (await sessionInfo(evalAsync, sid)).title;
  out.shotEsc = await shot(cdp, 'e1-rename-esc-cancels', { bottom: false });
  // e2a (issue 2): fork from the first answer; the fork shows what came before at once.
  // Park the composer's text first so it is not what the fork shows.
  const ids0 = await evalAsync(`${STORE} return s.sessions.map((x) => x.id);`, { label: 'ids' });
  out.tree2 = await openTree(cdp);
  const fi = out.tree2.nodes.findIndex((n) => /助手/.test(n.text));
  out.forkIndex = fi;
  const t0 = Date.now();
  out.forkClick = await cdp.evaluate(treeClick(fi, '从这里分叉'));
  let forkId = null;
  const samples = [];
  while (Date.now() - t0 < 12_000) {
    const st = await evalAsync(
      `${STORE} return { active: s.activeSessionId, ids: s.sessions.map((x) => x.id) };`,
      { label: 'fork?' }
    );
    const fresh = st.ids.filter((x) => !ids0.includes(x));
    if (fresh.length) forkId = fresh[0];
    if (forkId) {
      const tl = await cdp.evaluate(TRANSCRIPT);
      samples.push({
        dt: Date.now() - t0,
        active: st.active === forkId,
        hasFirst: tl.includes('E2A-FIRST'),
        hasSecond: tl.includes('E2A-SECOND'),
        englishEmpty: tl.includes('No messages yet'),
        chineseEmpty: tl.includes('还没有消息'),
      });
      if (st.active === forkId && tl.includes('E2A-FIRST') && samples.length > 3) break;
    }
    await sleep(250);
  }
  out.forkId = forkId;
  out.forkSamples = samples;
  await sleep(500);
  const dlg = await cdp.evaluate(TREE_NODES);
  if (dlg) await cdp.evaluate(CLOSE_TREE);
  await sleep(1200);
  out.forkTranscript = (await cdp.evaluate(TRANSCRIPT)).slice(-1500);
  out.forkComposer = await cdp.evaluate(COMPOSER);
  out.shotFork = await shot(cdp, 'e2a-A4-fork-opened');
  cdp.close();
  save('e2a-rewind-fork', out);
}

/** e4 空态: rewind a one-turn chat to its only prompt; the timeline is empty. */
async function empty() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid };
  await sendText(cdp, 'P0-STREAM: E4-EMPTY 只有一轮。');
  out.t1 = (await waitTurn(evalAsync, sid)).status;
  await sleep(800);
  out.tree = await openTree(cdp);
  const idx = out.tree.nodes.findIndex((n) => /E4-EMPTY/.test(n.text) && /用户/.test(n.text));
  out.rewindClick = await cdp.evaluate(treeClick(idx, '回退到这里'));
  await sleep(900);
  out.confirmClick = await cdp.evaluate(dialogButton('回退'));
  await sleep(3500);
  await cdp.evaluate(CLOSE_TREE);
  await sleep(1500);
  out.transcript = await cdp.evaluate(TRANSCRIPT);
  out.composer = await cdp.evaluate(COMPOSER);
  out.emptyZh = await cdp.evaluate(
    `document.body.innerText.includes('还没有消息，发一条消息开始对话。')`
  );
  out.emptyEn = await cdp.evaluate(`document.body.innerText.includes('No messages yet')`);
  out.shot = await shot(cdp, 'e4-empty-state', { bottom: false });
  // Clear the handed-back prompt so this chat does not carry a draft.
  await cdp.evaluate(setComposer(''));
  cdp.close();
  save('e4-empty-state', out);
}

// ---- e2a: drafts per chat ------------------------------------------------------------------

async function drafts(suffixA, suffixB) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = { a: await openChat(cdp, evalAsync, suffixA) };
  await cdp.evaluate(setComposer('E2A-DRAFT 只属于 A 的草稿'));
  out.paste = await evalAsync(PASTE_NOTES, { label: 'paste notes' });
  await sleep(1500);
  out.composerA = await cdp.evaluate(COMPOSER);
  out.shotA = await shot(cdp, 'e2a-drafts-1-typed-in-A', { bottom: false });
  out.b = await openChat(cdp, evalAsync, suffixB);
  await sleep(800);
  out.composerB = await cdp.evaluate(COMPOSER);
  out.shotB = await shot(cdp, 'e2a-drafts-2-B-is-empty', { bottom: false });
  out.back = await openChat(cdp, evalAsync, suffixA);
  await sleep(800);
  out.composerA2 = await cdp.evaluate(COMPOSER);
  out.shotA2 = await shot(cdp, 'e2a-drafts-3-back-in-A', { bottom: false });
  // Leave A clean.
  await cdp.evaluate(
    `(() => { const b = [...document.querySelectorAll('button[aria-label^="移除 "]')].find((n) => n.offsetParent !== null); if (b) b.click(); return !!b; })()`
  );
  await cdp.evaluate(setComposer(''));
  await sleep(500);
  out.composerCleared = await cdp.evaluate(COMPOSER);
  cdp.close();
  save('e2a-drafts', out);
}

// ---- e2b + e4: failure (P1-FAIL), gate (P1-GATE) -------------------------------------------

const FAILURE_CARD = `(() => {
  const c = [...document.querySelectorAll('[role="alert"]')].filter((n) => n.offsetParent !== null).pop();
  if (!c) return null;
  return { text: (c.innerText || '').replace(/\\n+/g, ' | ').slice(0, 1200),
           buttons: [...c.querySelectorAll('button')].map((b) => (b.innerText || '').trim()) };
})()`;
const RETRY_BANNER = `(() => { const t = document.body.innerText; const i = t.indexOf('网络重试中'); return i >= 0 ? t.slice(i, i + 80).replace(/\\n/g, ' ') : null; })()`;

async function failLike(prompt, tag, timeoutMs = 150_000) {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid };
  const gw = lib.gatewayLog().length;
  const sentAt = await sendText(cdp, prompt);
  const trace = [];
  let last = '';
  let retryShot = null;
  while (Date.now() - sentAt < timeoutMs) {
    const st = await lib.turnStatus(evalAsync, sid);
    const card = await cdp.evaluate(FAILURE_CARD);
    const retry = await cdp.evaluate(RETRY_BANNER);
    const row = { status: st.status, card: card?.text?.slice(0, 80) ?? null, retry };
    const key = JSON.stringify(row);
    if (key !== last) {
      trace.push({ dt: Date.now() - sentAt, ...row });
      last = key;
    }
    if (retry && !retryShot) retryShot = await shot(cdp, `${tag}-retry-banner`);
    if (card && !['starting', 'running', 'stopping'].includes(st.status)) break;
    await sleep(300);
  }
  await sleep(1500);
  out.trace = trace;
  out.retryShot = retryShot;
  out.retryTexts = [...new Set(trace.map((x) => x.retry).filter(Boolean))];
  out.card = await cdp.evaluate(FAILURE_CARD);
  out.gatewayRequests = lib
    .gatewayLog()
    .slice(gw)
    .map((l) => ({ status: l.status, scenario: l.decision?.scenario ?? l.scenario ?? null }));
  out.shotCard = await shot(cdp, `${tag}-card`);
  out.sidebar = (await cdp.evaluate(SIDEBAR)).rows.filter((r) => r.active);
  cdp.close();
  return out;
}

async function fail() {
  save('e2b-fail-live', await failLike('P1-FAIL: this request fails upstream.', 'e4-e2b-fail'));
}

async function gate() {
  save('e2b-gate', await failLike('P1-GATE: the company gateway refuses the stream.', 'e2b-gate'));
}

// ---- e2b + e4: /compact ----------------------------------------------------------------------

async function compact() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid };
  await sendText(cdp, 'P0-STREAM: E2B-COMPACT 先有一轮，再压缩。');
  out.t1 = (await waitTurn(evalAsync, sid)).status;
  await sleep(1200);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  out.workBefore = await cdp.evaluate(WORK_LINES);
  const tm = await toastMark(cdp);
  await cdp.evaluate(setComposer(''));
  await cdp.evaluate(`(() => { document.querySelector('textarea').focus(); return true; })()`);
  await cdp.send('Input.insertText', { text: '/compact' });
  await sleep(600);
  await pressKey(cdp, 'Enter');
  await sleep(500);
  const still = await cdp.evaluate(COMPOSER);
  if (still.value?.trim().startsWith('/compact')) {
    out.secondEnter = true;
    await pressKey(cdp, 'Enter');
  }
  const t0 = Date.now();
  const samples = [];
  while (Date.now() - t0 < 30_000) {
    const tl = await cdp.evaluate(TRANSCRIPT);
    const st = await lib.turnStatus(evalAsync, sid);
    const summaryZh = tl.includes('上下文摘要');
    samples.push({
      dt: Date.now() - t0,
      status: st.status,
      summaryZh,
      summaryEn: tl.includes('Context summary'),
    });
    if (summaryZh && samples.length > 2 && !e7.BUSY.includes(st.status)) break;
    await sleep(250);
  }
  out.samples = samples.filter(
    (s, i) =>
      i === 0 || JSON.stringify({ ...s, dt: 0 }) !== JSON.stringify({ ...samples[i - 1], dt: 0 })
  );
  out.summaryAfterMs = samples.find((s) => s.summaryZh)?.dt ?? null;
  await sleep(800);
  out.toasts = await toastsSince(cdp, tm);
  out.transcript = (await cdp.evaluate(TRANSCRIPT)).slice(-1200);
  out.roles = await roles(evalAsync, sid);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(400);
  out.workAfter = await cdp.evaluate(WORK_LINES);
  out.summaryRow = await cdp.evaluate(`(() => {
    const n = [...document.querySelectorAll('*')].filter((x) => x.offsetParent !== null && x.children.length === 0 && (x.innerText || '').trim() === '上下文摘要').pop();
    if (!n) return null;
    n.scrollIntoView({ block: 'center' });
    let box = n; for (let i = 0; i < 4 && box.parentElement; i += 1) box = box.parentElement;
    const r = box.getBoundingClientRect();
    const ta = document.querySelector('textarea').getBoundingClientRect();
    return { text: (box.innerText || '').slice(0, 300), bottom: Math.round(r.bottom), composerTop: Math.round(ta.top) };
  })()`);
  out.shot = await shot(cdp, 'e2b-e4-compact-summary-live');
  cdp.close();
  save('e2b-compact-live', out);
}

// ---- e2b: 「思考 N 秒」 survives leaving the chat ----------------------------------------------

async function think() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid };
  await sendText(cdp, 'P1-THINK: think first, then answer.');
  out.t1 = (await waitTurn(evalAsync, sid)).status;
  await sleep(1200);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(500);
  out.before = await cdp.evaluate(WORK_LINES);
  out.shotBefore = await shot(cdp, 'e2b-think-1-live');
  // Away to a new chat (the start screen unmounts the timeline), then back.
  out.away = await newChat(cdp, evalAsync);
  await sleep(1500);
  out.back = await openChat(cdp, evalAsync, sid);
  await sleep(1500);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(500);
  out.after = await cdp.evaluate(WORK_LINES);
  out.shotAfter = await shot(cdp, 'e2b-think-2-after-new-and-back');
  cdp.close();
  save('e2b-think', out);
}

// ---- e2b: Stop keeps the output; e1: the spinner in 「正在活动」 --------------------------------

async function stop() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  await sendText(cdp, 'P0-SLEEPTOOL {"token":"e2b","seconds":40} run a long command.');
  await waitFor(
    cdp,
    `(() => [...document.querySelectorAll('[class*="group/row"]')].some((n) => n.offsetParent !== null && /sleep/.test(n.innerText || '')))()`,
    30_000,
    100
  );
  await sleep(600);
  out.rowClick = await cdp.evaluate(clickToolRow('sleep'));
  const live = [];
  for (let i = 0; i < 5; i += 1) {
    await sleep(1200);
    live.push(await cdp.evaluate(LIVE_OUTPUT));
  }
  out.live = live;
  // e1: while it runs, the chat is in 「正在活动」 with a spinner.
  out.sidebarRunning = (await cdp.evaluate(SIDEBAR)).rows.filter((r) => r.active || r.marker);
  out.shotRunning = await shot(cdp, 'e1-active-now-spinner-and-e2b-live-output');
  out.stopClicked = await cdp.evaluate(CLICK_STOP);
  out.stopTurn = await waitTurn(evalAsync, sid, { neverBusyMs: 3000 });
  await sleep(1000);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(600);
  out.rowsAfter = (await cdp.evaluate(TOOL_ROWS_DOM)).map((r) => r.text);
  const opened = await cdp.evaluate(ROW_BOX('sleep'));
  if (!opened || !/sleep-tool/.test(opened.head)) await cdp.evaluate(clickToolRow('sleep'));
  await sleep(700);
  out.body = await cdp.evaluate(ROW_BOX('sleep'));
  out.keptOutput = /sleep-tool e2b started/.test(out.body?.head ?? '');
  out.englishAbort = /tool call aborted/.test(out.body?.head ?? '');
  await sleep(400);
  out.shotStopped = await lib.shot(cdp, 'e2b-stop-keeps-output');
  out.sidebarAfter = (await cdp.evaluate(SIDEBAR)).rows.filter((r) => r.active);
  cdp.close();
  save('e2b-stop', out);
}

// ---- e2b (spill), e3 (glob, attachment row) -------------------------------------------------

async function fsItem() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  await sendText(
    cdp,
    'P0-FS {"dir":".","marker":"E2BMARK","token":"e2b","tag":"e2b","shell":"bash"} walk the file tools.'
  );
  out.turnFs = await turnAllowing(cdp, evalAsync, sid, { timeoutMs: 180_000 });
  await sendText(cdp, 'P1-PERM-SEARCH: glob and grep the workspace.');
  out.turnSearch = await turnAllowing(cdp, evalAsync, sid);
  out.paste = await evalAsync(PASTE_NOTES, { label: 'paste notes.txt' });
  await sleep(1200);
  await cdp.evaluate(lib.typeIntoComposer('P1-FILEREAD: read the attached notes.'));
  await cdp.waitFor(lib.SEND_READY, { timeoutMs: 20_000, label: 'send ready (file)' });
  await cdp.evaluate(lib.CLICK_SEND);
  out.turnFile = await turnAllowing(cdp, evalAsync, sid);
  await fsRead(cdp, evalAsync, sid, out);
  cdp.close();
  save('e2b-e3-fs', out);
}

/** The reading half of `fs`, on the active chat (also an item of its own: `fsread`). */
async function fsRead(cdp, evalAsync, sid, out) {
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(900);
  out.rows = (await cdp.evaluate(TOOL_ROWS_DOM)).map(
    (r) => `${r.icon} | ${r.iconClass} | ${r.text}`
  );
  out.calls = await bashCalls(evalAsync, sid);
  // e2b: the spill row opens at a line start, with the omitted note on top.
  out.openSpill = await cdp.evaluate(clickToolRow('spill-l'));
  await sleep(900);
  out.spillBody = await cdp.evaluate(ROW_BOX('spill-l'));
  out.spillFirstLines = await cdp.evaluate(`(() => {
    const r = [...document.querySelectorAll('[class*="group/row"]')].filter((n) => n.offsetParent !== null && (n.innerText || '').includes('spill-l')).pop();
    let box = r; for (let i = 0; i < 4 && box.parentElement; i += 1) { box = box.parentElement; if ((box.innerText || '').length > (r.innerText || '').length + 10) break; }
    const pres = [...box.querySelectorAll('pre, code, p')].filter((n) => n.offsetParent !== null);
    return pres.slice(0, 6).map((n) => (n.innerText || '').split('\\n').slice(0, 3).join(' ⏎ ').slice(0, 200));
  })()`);
  await sleep(400);
  out.shotSpill = await lib.shot(cdp, 'e2b-large-output-head');
  // e3: glob pattern verbatim; the attachment read row.
  out.globRows = out.rows.filter((r) => /\*\*\/\*|\*\.txt|搜索/.test(r));
  out.attachmentRows = out.rows.filter((r) => /附件|notes\.txt/.test(r));
  await cdp.evaluate(
    `(() => { const r = [...document.querySelectorAll('[class*="group/row"]')].filter((n) => n.offsetParent !== null && /\\*\\*\\/\\*/.test(n.innerText || '')).pop(); if (r) r.scrollIntoView({ block: 'center' }); return !!r; })()`
  );
  await sleep(500);
  out.shotGlob = await lib.shot(cdp, 'e3-glob-and-attachment-rows');
  out.contrastLight = await cdp.evaluate(CONTRAST);
  out.transcript = (await cdp.evaluate(TRANSCRIPT)).slice(-1500);
  return out;
}

async function fsReadItem(tag = 'e2b-e3-fs-read') {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const sid = await e7.activeSid(evalAsync);
  const out = { sid };
  await fsRead(cdp, evalAsync, sid, out);
  cdp.close();
  save(tag, out);
}

// ---- reopen: a chat's turn-end notes and work lines --------------------------------------------

async function reopen(suffix, tag) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = { open: await openChat(cdp, evalAsync, suffix) };
  await sleep(2500);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.work = await cdp.evaluate(WORK_LINES);
  out.transcript = (await cdp.evaluate(TRANSCRIPT)).slice(-2000);
  out.notes = await cdp.evaluate(
    `[...document.querySelectorAll('[role="alert"], [role="status"]')].filter((n) => n.offsetParent !== null).map((n) => ({ role: n.getAttribute('role'), text: (n.innerText || '').replace(/\\n+/g, ' | ').slice(0, 500), cls: String(n.className).split(' ').filter((c) => /destructive|border|bg-/.test(c)).join(' ') }))`
  );
  out.englishFallback = out.transcript.includes('Response interrupted');
  out.completedAt = /完成于/.test(out.transcript);
  out.roles = await roles(evalAsync, out.open.id ?? suffix);
  out.shot = await shot(cdp, tag);
  cdp.close();
  save(tag, out);
}

// ---- e2a (issue 25) + e4 (retry wording): legacy chats moved to the engine ----------------

const LEGACY_CORPUS = 'src/shared/__tests__/fixtures/legacy-pi/v4-basic.jsonl';
const LEGACY_ROWS = [
  { key: 'L1', title: '旧会话甲：文件一直在被写', use: 'source_busy (retryable): 重试' },
  { key: 'L2', title: '旧会话乙：文件已删除', use: 'source_missing (not retryable)' },
];
const legacyStateFile = () => path.join(lib.SCRATCH, 'legacy-rows.json');
const profileDir = () => {
  const pilab = path.join(lib.dirs.home, '.pilab');
  const names = fs.readdirSync(pilab).filter((n) => fs.statSync(path.join(pilab, n)).isDirectory());
  return path.join(pilab, names.find((n) => n.endsWith('-dev')) ?? names[0]);
};

function appIsDown() {
  const c = lib.classify();
  return c.devRoot.length === 0 && c.electronMain.length === 0;
}

/**
 * Two 1.0.x rows (batch 3's corpus and layout, with the `piLeaf` a 1.0.x turn
 * leaves), written while the app is down. Files go where 1.0.x kept them.
 */
function injectLegacy() {
  if (!appIsDown()) throw new Error('the app is still running; quit it first');
  const index = lib.readIndex();
  if (!index.file) throw new Error('no session-index.json yet');
  if (fs.existsSync(legacyStateFile())) throw new Error('already injected');
  const source = fs.readFileSync(path.join(e7.repoRoot, LEGACY_CORPUS), 'utf8').split('\n');
  const cwdKey = `--${lib.dirs.workspace.slice(1).replace(/\//g, '-')}--`;
  const dir = path.join(profileDir(), 'pi-agent', 'sessions', cwdKey);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(index.file, `${index.file}.before-legacy-inject`);
  const now = Date.now();
  const rows = [];
  const made = [];
  LEGACY_ROWS.forEach((spec, i) => {
    const lines = [...source];
    const header = JSON.parse(lines[0]);
    const fileId = e7.crypto.randomUUID();
    lines[0] = JSON.stringify({ ...header, id: fileId, cwd: lib.dirs.workspace });
    const file = path.join(dir, `2026-09-27T12-58-24-571Z_${fileId}.jsonl`);
    fs.writeFileSync(file, lines.join('\n'));
    const entries = lines.filter(Boolean).map((l) => JSON.parse(l));
    const piLeaf = {
      activeEntryId: entries.filter((e) => e.kind === 'entry' && e.type === 'message').at(-1).id,
      fileTailEntryId: entries.at(-1).id,
    };
    const sessionId = `session-${now - 86_400_000 - i * 60_000}-lg${spec.key.toLowerCase()}`;
    rows.push({
      sessionId,
      runtimeIdentity: file,
      piLeaf,
      agent: 'pi',
      workspacePath: lib.dirs.workspace,
      title: spec.title,
      updatedAt: now - 3_600_000 - i * 60_000,
      archived: false,
    });
    made.push({
      ...spec,
      sessionId,
      file: path.relative(lib.SCRATCH, file),
      bytes: fs.statSync(file).size,
    });
  });
  fs.writeFileSync(index.file, JSON.stringify([...index.rows, ...rows]));
  fs.writeFileSync(legacyStateFile(), JSON.stringify({ corpus: LEGACY_CORPUS, made }, null, 2));
  save('e2a-legacy-inject', { corpus: LEGACY_CORPUS, made, indexRowsBefore: index.rows.length });
}

function startOneToucher(file, ms, offset) {
  const code = `
    const fs = require('node:fs');
    const f = ${JSON.stringify(file)};
    const until = Date.now() + ${ms};
    let n = 0;
    const base = fs.statSync(f).mtimeMs;
    const tick = () => {
      if (Date.now() > until) { process.stdout.write(String(n)); return; }
      n += 1;
      const t = new Date(base + n * 7 + ${offset});
      try { fs.utimesSync(f, t, t); } catch {}
      setImmediate(tick);
    };
    tick();`;
  const child = e7.spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  let touches = '';
  child.stdout.on('data', (d) => {
    touches += d;
  });
  return { child, touches: () => touches };
}

/** Three writers that keep changing the file's mtime; each exits by itself after `ms`. */
function startToucher(file, ms, processes = 3) {
  const writers = Array.from({ length: processes }, (_, i) => startOneToucher(file, ms, i));
  return {
    pids: writers.map((w) => w.child.pid),
    touches: () => writers.reduce((n, w) => n + Number(w.touches() || 0), 0),
    done: () =>
      Promise.all(
        writers.map(
          (w) => new Promise((r) => (w.child.exitCode !== null ? r() : w.child.on('exit', r)))
        )
      ),
  };
}

/** The migration notice / failure card: where it sits against the composer, and whether it is in view. */
const MIGRATION_VIEW = `(() => {
  const ta = document.querySelector('textarea');
  const composerTop = ta ? Math.round((ta.closest('[data-toast-avoid]') ?? ta).getBoundingClientRect().top) : null;
  const notice = [...document.querySelectorAll('[role="status"], [role="alert"]')].filter((n) => n.offsetParent !== null && /迁移/.test(n.innerText || '')).map((n) => {
    const r = n.getBoundingClientRect();
    return { role: n.getAttribute('role'), text: (n.innerText || '').replace(/\\n+/g, ' | ').slice(0, 700),
      buttons: [...n.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim()),
      top: Math.round(r.top), bottom: Math.round(r.bottom), inView: r.bottom > 70 && r.top < (composerTop ?? innerHeight), gapToComposer: composerTop === null ? null : composerTop - Math.round(r.bottom) };
  });
  return { composerTop, notice, composer: ta ? { value: ta.value, placeholder: ta.getAttribute('placeholder') } : null };
})()`;

async function openLegacy(cdp, evalAsync, key) {
  const made = JSON.parse(fs.readFileSync(legacyStateFile(), 'utf8')).made.find(
    (m) => m.key === key
  );
  const opened = await openChat(cdp, evalAsync, made.sessionId);
  await sleep(1500);
  await cdp.evaluate(lib.SCROLL_BOTTOM);
  await lib.pumpFrames(cdp, 600);
  return { made, opened, preview: (await cdp.evaluate(TRANSCRIPT)).slice(-300) };
}

async function sendAndWatch(cdp, text, tag, ms) {
  await cdp.evaluate(lib.typeIntoComposer(text));
  await cdp.waitFor(lib.SEND_READY, { timeoutMs: 30_000, label: 'send ready' });
  const t0 = Date.now();
  await cdp.evaluate(lib.CLICK_SEND);
  const trace = [];
  let migratingShot = null;
  while (Date.now() - t0 < ms) {
    const v = await cdp.evaluate(MIGRATION_VIEW);
    const key = JSON.stringify(v.notice.map((n) => [n.text.slice(0, 40), n.top]));
    if (trace.at(-1)?.key !== key) trace.push({ dt: Date.now() - t0, key, v });
    const migrating = v.notice.some((n) => n.text.includes('正在把这个对话迁移'));
    if (migrating && !migratingShot) migratingShot = await e7.fastShot(cdp, `${tag}-migrating`);
    if (v.notice.some((n) => n.text.includes('没能迁移'))) break;
    await sleep(60);
  }
  return { t0, migratingShot, trace: trace.map(({ dt, v }) => ({ dt, ...v })) };
}

async function migrate(which = 'busy') {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const key = which === 'busy' ? 'L1' : 'L2';
  const tag = `e2a-e4-migration-${which}`;
  const out = await openLegacy(cdp, evalAsync, key);
  const file = path.join(lib.SCRATCH, out.made.file);
  let toucher = null;
  if (which === 'busy') {
    toucher = startToucher(file, 14_000);
    out.toucherPids = toucher.pids;
    await sleep(300);
  } else {
    fs.rmSync(file);
    out.deleted = !fs.existsSync(file);
  }
  out.send = await sendAndWatch(cdp, `E2A ${which}: 旧会话继续。`, tag, 20_000);
  await sleep(800);
  out.card = await cdp.evaluate(MIGRATION_VIEW);
  out.shotCard = await lib.shot(cdp, `${tag}-failure-card-no-scroll`);
  if (toucher) {
    await toucher.done();
    out.touches = toucher.touches();
    out.retry = await cdp.evaluate(`(() => {
      const n = [...document.querySelectorAll('[role="alert"], [role="status"]')].filter((x) => x.offsetParent !== null && (x.innerText || '').includes('没能迁移'))[0];
      const b = n && [...n.querySelectorAll('button')].find((x) => /^(重试|Retry|retry)$/.test((x.innerText || '').trim()));
      if (!b) return 'no retry';
      b.click();
      return (b.innerText || '').trim();
    })()`);
    const t0 = Date.now();
    const trace = [];
    while (Date.now() - t0 < 15_000) {
      const v = await cdp.evaluate(MIGRATION_VIEW);
      const k = JSON.stringify(v.notice.map((n) => n.text.slice(0, 40)));
      if (trace.at(-1)?.k !== k) trace.push({ dt: Date.now() - t0, k, v });
      await sleep(150);
    }
    out.retryTrace = trace.map(({ dt, v }) => ({ dt, ...v }));
    out.shotAfterRetry = await lib.shot(cdp, `${tag}-after-retry`);
  }
  out.row = await sessionInfo(evalAsync, out.made.sessionId);
  cdp.close();
  save(tag, out);
}

const items = {
  'inject-legacy': injectLegacy,
  migrate,
  rewind,
  empty,
  drafts,
  fail,
  gate,
  compact,
  think,
  stop,
  fs: fsItem,
  fsread: fsReadItem,
  reopen,
};
export const e2 = { FAILURE_CARD, RETRY_BANNER, failLike };
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const name = process.argv[2];
  if (!items[name]) {
    console.error(`usage: p1-7e-e2.mjs ${Object.keys(items).join('|')}`);
    process.exit(2);
  }
  await items[name](...process.argv.slice(3));
  process.exit(0);
}
