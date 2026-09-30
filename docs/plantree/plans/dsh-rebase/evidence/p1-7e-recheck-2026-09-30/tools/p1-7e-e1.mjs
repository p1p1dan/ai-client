#!/usr/bin/env node
/**
 * p1-7e-e1.mjs — re-check items for P1-7e group e1 (the sidebar; decisions
 * 137, 138). Helpers from p1-7e-items.mjs (`e7`).
 *
 *   P17D_SCRATCH=/tmp/aiclient-p17e node p1-7e-e1.mjs <item> [args]
 *
 *   escprobe <sid>            after Esc in the rename field: reopen the panel, then click elsewhere
 *   escdetail <title>         Esc in the rename field, with the keydown listeners traced
 *   sidebar <tag>             the sidebar as rows and sections, plus a shot
 *   waiting                   ask mode, P1-PERM-HOLD: the waiting dot, then Stop
 *   capacity <suffix> [n]     one turn in <suffix>'s chat, then n new chats with a turn each:
 *                             reclaim toasts, 「正在活动」, order, the work line when back
 *   limit                     the 8-row cap, 「查看更多（N）」, 「收起」, the selected row, search
 *   draftrename               rename an unsent chat, then send: the name stays
 *   suffix                    a long title ending in the 1.0.x branch suffix
 *   addws <path>              add a second repository through the 「添加仓库」 dialog
 *   header <folder>           click a folder header: fold only, the chat and 「新建」 target stay
 *   killorder                 SIGKILL the host (exact pid): the sidebar order before and after
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { lib } = await import(path.join(here, 'p1-7e-gui.mjs'));
const { e7 } = await import(path.join(here, 'p1-7e-items.mjs'));
const { attach, makeEval, sendText, waitTurn, sleep } = lib;
const {
  shot,
  save,
  newChat,
  setGear,
  pressKey,
  CLICK_STOP,
  openChat,
  SIDEBAR,
  renameViaMenu,
  rightClickRow,
  realClick,
  centerOf,
  RENAME_FOCUS,
  sessionInfo,
  allSessions,
  WORK_LINES,
  TOASTS_NOW,
  toastMark,
  toastsSince,
  activeSid,
} = e7;

const railButton = (label) =>
  centerOf(
    `[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.getBoundingClientRect().x < 44 && (b.getAttribute('aria-label') || b.getAttribute('title') || '') === ${JSON.stringify(label)})`
  );

const ASIDE_WIDTH = `(() => { const a = document.querySelector('aside'); return a ? Math.round(a.getBoundingClientRect().width) : null; })()`;

/** What is left after Esc in the rename field (issue found in this re-check). */
async function escprobe(sid) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = {
    asideWidth: await cdp.evaluate(ASIDE_WIDTH),
    focus: await cdp.evaluate(RENAME_FOCUS),
    title: (await sessionInfo(evalAsync, sid)).title,
  };
  const at = await cdp.evaluate(railButton('聊天'));
  out.rail = at;
  if (at) await realClick(cdp, at);
  await lib.pumpFrames(cdp, 1200);
  out.asideWidthAfterReopen = await cdp.evaluate(ASIDE_WIDTH);
  out.focusAfterReopen = await cdp.evaluate(RENAME_FOCUS);
  out.shotReopened = await shot(cdp, 'e1-rename-esc-panel-reopened-field-still-open', {
    bottom: false,
  });
  // A click on the timeline: the user leaving the field.
  const tl = await cdp.evaluate(
    centerOf(
      `[...document.querySelectorAll('[data-slot="scroll-area-viewport"]')].filter((v) => v.offsetParent !== null && !/仓库列表/.test(v.innerText || '')).sort((a, b) => b.clientWidth - a.clientWidth)[0]`
    )
  );
  out.timelineClick = tl;
  if (tl) await realClick(cdp, tl);
  await sleep(1200);
  out.focusAfterClickAway = await cdp.evaluate(RENAME_FOCUS);
  out.titleAfterClickAway = (await sessionInfo(evalAsync, sid)).title;
  out.shotAfter = await shot(cdp, 'e1-rename-esc-then-click-away', { bottom: false });
  cdp.close();
  save('e1-rename-esc-probe', out);
}

/** Esc in the rename field, with capture- and bubble-phase keydown listeners traced. */
async function escdetail(title) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = { title };
  const box = await rightClickRow(cdp, title, -1);
  out.box = box;
  const item = await cdp.evaluate(
    centerOf(
      `[...document.querySelectorAll('[role=menuitem]')].find((n) => n.offsetParent !== null && /^重命名/.test((n.innerText || '').trim()))`
    )
  );
  if (item) await realClick(cdp, item);
  await lib.pumpFrames(cdp, 600);
  out.focusBefore = await cdp.evaluate(RENAME_FOCUS);
  await cdp.evaluate(`(() => {
    window.__p17eKeys = [];
    const rec = (phase) => (e) => window.__p17eKeys.push({ phase, key: e.key, target: e.target?.tagName, defaultPrevented: e.defaultPrevented });
    window.addEventListener('keydown', rec('window-capture'), true);
    window.addEventListener('keydown', rec('window-bubble'), false);
    document.activeElement?.addEventListener('keydown', rec('field'), false);
    return true;
  })()`);
  await pressKey(cdp, 'Escape');
  await lib.pumpFrames(cdp, 800);
  out.keys = await cdp.evaluate('window.__p17eKeys');
  out.asideWidth = await cdp.evaluate(ASIDE_WIDTH);
  out.focusAfter = await cdp.evaluate(RENAME_FOCUS);
  out.shot = await shot(cdp, 'e1-rename-esc-collapses-panel', { bottom: false });
  out.active = await activeSid(evalAsync);
  cdp.close();
  save('e1-rename-esc-detail', out);
}

async function sidebar(tag = 'e1-sidebar') {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = {
    sidebar: await cdp.evaluate(SIDEBAR),
    sessions: await allSessions(evalAsync),
    active: await activeSid(evalAsync),
  };
  out.shot = await shot(cdp, tag, { bottom: false });
  cdp.close();
  save(tag, out);
}

/** Ask mode, P1-PERM-HOLD: the row's attention dot while the card waits, then Stop. */
async function waiting() {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1200);
  const out = { sid, gear: await setGear(cdp, '每次询问') };
  await sendText(cdp, 'P1-PERM-HOLD: hold at the gate.');
  for (let i = 0; i < 120; i += 1) {
    const st = await lib.turnStatus(evalAsync, sid);
    if (st.status === 'waiting_permission') break;
    await sleep(250);
  }
  await lib.pumpFrames(cdp, 600);
  out.rows = (await cdp.evaluate(SIDEBAR)).rows.filter((r) => r.active);
  out.shot = await shot(cdp, 'e1-waiting-approval-dot', { bottom: false });
  out.stop = await cdp.evaluate(CLICK_STOP);
  out.settled = (await waitTurn(evalAsync, sid, { neverBusyMs: 3000 })).status;
  await lib.pumpFrames(cdp, 600);
  out.rowsAfter = (await cdp.evaluate(SIDEBAR)).rows.filter((r) => r.active);
  cdp.close();
  save('e1-waiting-dot', out);
}

const reclaimToasts = async (cdp) =>
  (await cdp.evaluate(TOASTS_NOW)).filter(
    (t) => t.visibility !== 'hidden' && /转入后台/.test(t.text)
  );

/**
 * X: one turn, then `n` new chats with a turn each (the pool holds 6). Per step:
 * the reclaim toasts on screen, whether X is in 「正在活动」, X's place in its
 * folder. Then X is opened again: its 「已工作」 / 「完成于」 line.
 */
async function capacity(n = '6') {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, steps: [] };
  await sendText(cdp, 'P0-STREAM: E1-X 这一轮之后被挤出容量。');
  out.turn = (await waitTurn(evalAsync, sid)).status;
  await sleep(1000);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  out.workLive = await cdp.evaluate(WORK_LINES);
  out.shotLive = await shot(cdp, 'e2a-X1-1-work-line-live');
  const where = async () => {
    const sb = await cdp.evaluate(SIDEBAR);
    const title = (await sessionInfo(evalAsync, sid)).title;
    const folder = sb.rows.filter((r) => r.section.startsWith('folder:'));
    return {
      inActive: sb.rows.some((r) => r.section === 'active' && r.title === title),
      folderIndex: folder.findIndex((r) => r.title === title),
      folderTop: folder.slice(0, 3).map((r) => `${r.title.slice(0, 24)} | ${r.age}`),
      activeSection: sb.rows.filter((r) => r.section === 'active').map((r) => r.title.slice(0, 24)),
    };
  };
  out.before = await where();
  const tm = await toastMark(cdp);
  for (let i = 1; i <= Number(n); i += 1) {
    const f = await newChat(cdp, evalAsync);
    await sleep(1000);
    await sendText(cdp, `P0-STREAM: E1 filler ${i}（把前面的对话挤出容量）。`);
    const settled = (await waitTurn(evalAsync, f)).status;
    await sleep(600);
    out.steps.push({
      i,
      sid: f,
      settled,
      reclaimToasts: await reclaimToasts(cdp),
      ...(await where()),
    });
    if (i === Number(n))
      out.shotLastFiller = await shot(cdp, 'e1-capacity-after-fillers', { bottom: false });
  }
  out.toastsSeen = (await toastsSince(cdp, tm)).map((t) => `${t.title} | ${t.description}`);
  out.maxReclaimToastsAtOnce = Math.max(...out.steps.map((s) => s.reclaimToasts.length));
  await sleep(6000);
  await lib.pumpFrames(cdp, 600);
  out.reclaimToastsAfter6s = await reclaimToasts(cdp);
  out.info = await sessionInfo(evalAsync, sid);
  // X again.
  out.open = await openChat(cdp, evalAsync, sid);
  await sleep(2500);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(600);
  out.workAfter = await cdp.evaluate(WORK_LINES);
  out.infoAfter = await sessionInfo(evalAsync, sid);
  out.shotAfter = await shot(cdp, 'e2a-X1-2-work-line-after-reclaim');
  cdp.close();
  save('e1-capacity-e2a-X1', out);
}

const folderOf = async (cdp, name = 'workspace') =>
  (await cdp.evaluate(SIDEBAR)).sections.find((x) => x.label === name) ?? null;
const folderRows = async (cdp, name = 'workspace') =>
  (await cdp.evaluate(SIDEBAR)).rows.filter((r) => r.section === `folder:${name}`);
const clickFolderToggle = (name, prefix) => `(() => {
  const sec = [...document.querySelectorAll('aside section')].find((x) => (x.querySelector('span.font-semibold')?.innerText || '').trim() === ${JSON.stringify(name)});
  const b = sec && [...sec.querySelectorAll('button')].find((n) => n.offsetParent !== null && (n.innerText || '').replace(/\\s+/g, '').startsWith(${JSON.stringify(prefix)}));
  if (!b) return false;
  b.scrollIntoView({ block: 'center' });
  b.click();
  return (b.innerText || '').replace(/\\s+/g, '');
})()`;
const setSearch = (q) => `(() => {
  const i = document.querySelector('aside input[placeholder="搜索会话"]');
  if (!i) return false;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(i, ${JSON.stringify(q)});
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

/** The 8-row cap: 「查看更多（N）」, all rows and 「收起」, a selected row past 8, search. */
async function limit() {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = {};
  const sessions = await allSessions(evalAsync);
  out.storeCount = sessions.filter((x) => (x.workspaceId ?? '').endsWith('/workspace')).length;
  out.collapsed = await folderOf(cdp);
  out.collapsedRows = (await folderRows(cdp)).map((r) => r.title.slice(0, 30));
  out.shotCollapsed = await shot(cdp, 'e1-limit-1-eight-and-view-more', { bottom: false });
  out.clickMore = await cdp.evaluate(clickFolderToggle('workspace', '查看更多'));
  await lib.pumpFrames(cdp, 600);
  out.expanded = await folderOf(cdp);
  const all = await folderRows(cdp);
  out.expandedCount = all.length;
  // Select the 11th row, then fold the list back.
  const pickIndex = Math.min(10, all.length - 1);
  out.picked = all[pickIndex]?.title;
  out.pickClick = await cdp.evaluate(`(() => {
    const sec = [...document.querySelectorAll('aside section')].find((x) => (x.querySelector('span.font-semibold')?.innerText || '').trim() === 'workspace');
    const rows = [...sec.querySelectorAll('[role="button"][title]')];
    const r = rows[${pickIndex}];
    if (!r) return false;
    r.scrollIntoView({ block: 'center' });
    r.click();
    return r.getAttribute('title');
  })()`);
  await sleep(2500);
  out.activeAfterPick = await activeSid(evalAsync);
  out.clickLess = await cdp.evaluate(clickFolderToggle('workspace', '收起'));
  await lib.pumpFrames(cdp, 800);
  out.foldedWithSelected = await folderOf(cdp);
  out.foldedRows = (await folderRows(cdp)).map(
    (r) => `${r.active ? '*' : ' '} ${r.title.slice(0, 30)}`
  );
  await cdp.evaluate(
    `(() => { const s = [...document.querySelectorAll('aside section')].find((x) => (x.querySelector('span.font-semibold')?.innerText || '').trim() === 'workspace'); s?.scrollIntoView({ block: 'end' }); return !!s; })()`
  );
  await lib.pumpFrames(cdp, 400);
  out.shotFoldedSelected = await lib.shot(cdp, 'e1-limit-2-selected-row-kept-at-end');
  // Search lists every match.
  const q = 'P0-STREAM';
  out.searchShown = await cdp.evaluate(
    `!!document.querySelector('aside input[placeholder="搜索会话"]')`
  );
  if (!out.searchShown) {
    await cdp.evaluate(
      `(() => { const b = document.querySelector('aside button[aria-label="筛选会话"]'); if (b) b.click(); return !!b; })()`
    );
    await sleep(500);
  }
  out.searchSet = await cdp.evaluate(setSearch(q));
  await lib.pumpFrames(cdp, 800);
  out.searchMatchesInStore = sessions.filter(
    (x) => (x.workspaceId ?? '').endsWith('/workspace') && x.title.includes(q)
  ).length;
  out.searchFolder = await folderOf(cdp);
  out.searchRows = (await folderRows(cdp)).length;
  out.shotSearch = await shot(cdp, 'e1-limit-3-search-lists-all', { bottom: false });
  await cdp.evaluate(setSearch(''));
  await lib.pumpFrames(cdp, 500);
  out.afterSearchCleared = await folderOf(cdp);
  cdp.close();
  save('e1-limit', out);
}

/** An unsent chat renamed in the sidebar keeps its name through the first message. */
async function draftrename() {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1200);
  const out = { sid, before: await sessionInfo(evalAsync, sid) };
  out.rename = await renameViaMenu(cdp, '新建对话', 'E1 草稿里起的名字', { index: 0 });
  out.afterRename = await sessionInfo(evalAsync, sid);
  out.shotRenamed = await shot(cdp, 'e1-draft-rename-1-before-send', { bottom: false });
  await sendText(cdp, 'P0-STREAM: E1 首条消息不该覆盖名字。');
  out.turn = (await waitTurn(evalAsync, sid)).status;
  await sleep(1500);
  out.afterSend = await sessionInfo(evalAsync, sid);
  out.index = lib
    .readIndex()
    .rows.filter((r) => r.sessionId === sid)
    .map((r) => ({ title: r.title }));
  out.shotSent = await shot(cdp, 'e1-draft-rename-2-after-send', { bottom: false });
  cdp.close();
  save('e1-draft-rename', out);
}

/** A long title ending in the 1.0.x branch suffix: the suffix stays whole in the row. */
async function suffix(idSuffix) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const sid = idSuffix ? (await openChat(cdp, evalAsync, idSuffix)).id : await activeSid(evalAsync);
  const info = await sessionInfo(evalAsync, sid);
  const name = '这是一个很长很长的旧会话标题，用来看后缀会不会被截掉（1.0.x 分支）';
  const out = { sid, before: info.title };
  out.rename = await renameViaMenu(cdp, info.title, name, { index: -1 });
  out.after = await sessionInfo(evalAsync, sid);
  await lib.pumpFrames(cdp, 600);
  out.rows = (await cdp.evaluate(SIDEBAR)).rows.filter((r) => r.title === name);
  out.shot = await shot(cdp, 'e1-branch-suffix-not-truncated', { bottom: false });
  cdp.close();
  save('e1-branch-suffix', out);
}

/** A second repository through the 「添加仓库」 dialog (type the path, submit). */
async function addws(dir) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = { dir, activeBefore: await activeSid(evalAsync) };
  out.open = await cdp.evaluate(
    `(() => { const b = [...document.querySelectorAll('aside button')].find((n) => n.offsetParent !== null && (n.innerText || '').trim() === '添加仓库'); if (!b) return false; b.click(); return true; })()`
  );
  await sleep(1200);
  out.dialog = await cdp.evaluate(
    `(() => { const d = document.querySelector('[data-slot="dialog-popup"][data-open]'); return d ? (d.innerText || '').slice(0, 500) : null; })()`
  );
  const input = await cdp.evaluate(
    centerOf(
      `[...document.querySelectorAll('[data-slot="dialog-popup"][data-open] input')].find((n) => n.offsetParent !== null)`
    )
  );
  out.input = input;
  if (input) {
    await realClick(cdp, input);
    await sleep(300);
    await cdp.send('Input.insertText', { text: dir });
    await sleep(1500);
  }
  const DIALOG_STATE = `(() => { const d = document.querySelector('[data-slot="dialog-popup"][data-open]'); return d ? { text: (d.innerText || '').slice(0, 500), inputs: [...d.querySelectorAll('input')].map((i) => i.value), buttons: [...d.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim() + (b.type === 'submit' ? ' [submit]' : '') + (b.disabled ? ' [disabled]' : '')) } : null; })()`;
  out.dialogFilled = await cdp.evaluate(DIALOG_STATE);
  out.shotDialog = await lib.shot(cdp, 'e1-header-0-add-second-repository');
  out.submit = await cdp.evaluate(
    `(() => { const d = document.querySelector('[data-slot="dialog-popup"][data-open]'); const b = d && d.querySelector('button[type="submit"]'); if (!b || b.disabled) return false; b.click(); return (b.innerText || '').trim(); })()`
  );
  await sleep(2500);
  await lib.pumpFrames(cdp, 600);
  out.dialogAfter = await cdp.evaluate(DIALOG_STATE);
  out.sections = (await cdp.evaluate(SIDEBAR)).sections;
  out.activeAfter = await activeSid(evalAsync);
  cdp.close();
  save('e1-addws', out);
}

/** A folder header click folds / unfolds that folder only: the chat and the 「新建」 target stay. */
async function header(folder, chatSuffix) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = { folder };
  if (chatSuffix) out.open = await openChat(cdp, evalAsync, chatSuffix);
  const state = async () => {
    const sb = await cdp.evaluate(SIDEBAR);
    return {
      active: await activeSid(evalAsync),
      newTitle: sb.newTitle,
      folders: sb.sections
        .filter((x) => x.folderOpen !== null)
        .map((x) => `${x.label} open=${x.folderOpen} rows=${x.rows}`),
    };
  };
  const clickHeader = async (name) => {
    const at = await cdp.evaluate(
      centerOf(
        `[...document.querySelectorAll('aside section button')].find((b) => (b.querySelector(':scope > span.font-semibold')?.innerText || '').trim() === ${JSON.stringify(name)})`
      )
    );
    if (at) await realClick(cdp, at);
    await sleep(900);
    await lib.pumpFrames(cdp, 300);
    return at;
  };
  out.s0 = await state();
  out.click1 = await clickHeader(folder);
  out.s1 = await state();
  out.shot1 = await shot(cdp, `e1-header-1-${folder}-clicked`, { bottom: false });
  out.click2 = await clickHeader(folder);
  out.s2 = await state();
  out.shot2 = await shot(cdp, `e1-header-2-${folder}-clicked-again`, { bottom: false });
  cdp.close();
  save(`e1-header-${folder}`, out);
}

const items = {
  escprobe,
  escdetail,
  sidebar,
  waiting,
  capacity,
  limit,
  draftrename,
  suffix,
  addws,
  header,
};
export const e1 = { railButton, ASIDE_WIDTH };
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const name = process.argv[2];
  if (!items[name]) {
    console.error(`usage: p1-7e-e1.mjs ${Object.keys(items).join('|')}`);
    process.exit(2);
  }
  await items[name](...process.argv.slice(3));
  process.exit(0);
}
