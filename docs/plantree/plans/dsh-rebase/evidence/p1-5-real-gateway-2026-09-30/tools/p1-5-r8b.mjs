#!/usr/bin/env node
/**
 * p1-5-r8b.mjs — R8 follow-up (2026-09-30): logout while a turn is in flight.
 *
 * Built on p1-5-gw.mjs / p1-5-items.mjs (attach-only CDP, scrubbed output,
 * request ledger). Run with P15_RESULTS_DIR pointing outside the repo and
 * P15_REQUEST_BUDGET=3.
 *
 *   node p1-5-r8b.mjs rehearse                 open / close the account card, no request
 *   node p1-5-r8b.mjs run [group] [label] [effort] [holdMs] [tag]
 *
 * `run`: new chat, pick the model and effort, type, open the account card,
 * send, wait for `running`, hold `holdMs`, then 退出登录 → confirm. If the turn
 * is already over when the confirm dialog is up, it cancels instead (no
 * logout). Then it watches the turn, the host process, the page and the
 * credential vault for 40 s. It never signs in again.
 *
 * The vault is only stat'ed and its top-level shape read (key names, the
 * `enc` enum, entry counts) — never a value.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { gw } = await import(path.join(here, 'p1-5-gw.mjs'));
const { p15 } = await import(path.join(here, 'p1-5-items.mjs'));
const { attach, makeEval, STORE, save, sleep } = gw;

const APP_HOME = '/tmp/aiclient-real-gw/home';
const VAULT = path.join(APP_HOME, '.pilab/jyw-ai-client-dev/credentials/vault.json');
const APP_LOG = path.join(APP_HOME, '.config/jyw-ai-client-dev/logs/aiclient-2026-09-30.log');
const DEV_LOG = '/tmp/aiclient-real-gw/dev.log';

/** Existence, size, mode, mtime and the top-level shape — never a value. */
function vaultShape() {
  if (!fs.existsSync(VAULT)) return { exists: false };
  const st = fs.statSync(VAULT);
  const out = {
    exists: true,
    size: st.size,
    mode: (st.mode & 0o777).toString(8),
    mtime: st.mtime.toISOString(),
  };
  try {
    const doc = JSON.parse(fs.readFileSync(VAULT, 'utf8'));
    out.keys = Object.keys(doc).map((k) => (/^[A-Za-z_]{1,32}$/.test(k) ? k : '(other)'));
    out.enc = typeof doc.enc === 'string' && /^[a-z-]{1,20}$/.test(doc.enc) ? doc.enc : '(n/a)';
    out.shape = Object.fromEntries(
      Object.entries(doc)
        .filter(([k]) => /^[A-Za-z_]{1,32}$/.test(k) && k !== 'enc')
        .map(([k, v]) => [
          k,
          Array.isArray(v)
            ? `array(${v.length})`
            : v && typeof v === 'object'
              ? `object(${Object.keys(v).length})`
              : typeof v === 'string'
                ? v.length
                  ? 'string(non-empty)'
                  : 'string(empty)'
                : typeof v,
        ])
    );
  } catch {
    out.parse = 'failed';
  }
  return out;
}

const lineCount = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').length : 0;

/** New log lines since `from`, scrubbed, workspace-tree noise dropped. */
function newLogLines(file, from) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .slice(Math.max(0, from - 1))
    .filter((l) => /^\[/.test(l) && !/workspace-tree|worktree/.test(l))
    .map((l) => gw.scrubText(l).slice(0, 300));
}

/** Every runtime event, payload trimmed to a few whitelisted fields; deltas counted only. */
const INSTALL_ALL_EVENTS = `(() => {
  if (window.__p15r8b) return 'already';
  window.__p15r8b = [];
  window.__p15r8bDeltas = {};
  window.electronAPI.chat.onRuntimeEvent((event) => {
    const p = event.payload ?? {};
    if (event.type === 'message.delta' || event.type === 'thinking.delta') {
      const k = event.sessionId + ' ' + event.type;
      const d = window.__p15r8bDeltas[k] ?? { n: 0, first: Date.now() };
      d.n += 1; d.last = Date.now();
      window.__p15r8bDeltas[k] = d;
      return;
    }
    const keep = { t: Date.now(), type: event.type, sessionId: event.sessionId };
    for (const key of ['status', 'disconnectReason', 'stopCause', 'errorCode', 'role', 'toolName', 'retry', 'reason', 'kind', 'code']) {
      if (p[key] !== undefined && (typeof p[key] !== 'object' || p[key] === null)) keep[key] = p[key];
    }
    if (typeof p.error === 'string') keep.error = p.error.slice(0, 300);
    else if (p.error && typeof p.error === 'object') keep.error = String(p.error.message ?? '').slice(0, 300);
    if (typeof p.message === 'string') keep.message = p.message.slice(0, 200);
    window.__p15r8b.push(keep);
    if (window.__p15r8b.length > 2000) window.__p15r8b.splice(0, 500);
  });
  return 'installed';
})()`;

const DISMISS_ANNOUNCEMENT = `(() => {
  const d = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find((n) => n.getAttribute('data-open') !== null && /公告/.test(n.innerText || ''));
  if (!d) return 'none';
  const b = [...d.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '知道了');
  if (!b) return 'no button';
  b.click();
  return 'dismissed';
})()`;

const OPEN_CARD = `(() => {
  const b = [...document.querySelectorAll('button[aria-label="用户资料"]')].find((n) => n.offsetParent !== null);
  if (!b) return 'no pill';
  if (b.getAttribute('aria-expanded') !== 'true') b.click();
  return 'opened';
})()`;

/**
 * The card's own 退出登录 (the card is a popover with role=dialog; the confirm is titled 确认退出登录).
 * A closed card stays mounted with `data-closed`, so only an open one counts.
 */
const CARD_LOGOUT_BUTTON = `[...document.querySelectorAll('button')].find((n) => { const d = n.closest('[role="dialog"]'); return n.offsetParent !== null && (n.innerText || '').trim() === '退出登录' && !!d && d.hasAttribute('data-open') && !/确认退出登录/.test(d.innerText || ''); })`;
const CARD_READY = `(() => { const b = ${CARD_LOGOUT_BUTTON}; return b ? (b.disabled ? 'disabled' : 'ready') : null; })()`;
const CLICK_CARD_LOGOUT = `(() => { const b = ${CARD_LOGOUT_BUTTON}; if (!b) return 'no button'; if (b.disabled) return 'disabled'; b.click(); return 'clicked'; })()`;

const CONFIRM_DIALOG = `[...document.querySelectorAll('[role="dialog"]')].filter((n) => n.getAttribute('data-open') !== null && /确认退出登录/.test(n.innerText || '')).pop()`;
const CONFIRM_TEXT = `(() => { const d = ${CONFIRM_DIALOG}; return d ? (d.innerText || '').replace(/\\s+/g, ' ').slice(0, 500) : null; })()`;
const clickConfirm = (label) => `(() => {
  const d = ${CONFIRM_DIALOG};
  if (!d) return 'no dialog';
  const b = [...d.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === ${JSON.stringify(label)});
  if (!b) return 'no button';
  b.click();
  return 'clicked';
})()`;

async function waitExpr(cdp, expr, timeoutMs, stepMs = 100) {
  const until = Date.now() + timeoutMs;
  let v = null;
  while (Date.now() < until) {
    v = await cdp.evaluate(expr);
    if (v) return v;
    await sleep(stepMs);
  }
  return v;
}

/** The session row and its last turn as the store holds them. */
const sessionView = (sid) => `${STORE}
  const x = s.sessions.find((r) => r.id === ${JSON.stringify(sid)});
  const msgs = s.messages[${JSON.stringify(sid)}] ?? [];
  const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
  const turn = msgs.slice(Math.max(0, lastUser));
  const row = x ? Object.fromEntries(Object.entries(x).filter(([k, v]) => v === null || typeof v !== 'object').filter(([k]) => !/title|cwd|path|preview/i.test(k))) : null;
  return {
    session: row,
    hostBound: (s.hostBoundSessionIds ?? []).includes(${JSON.stringify(sid)}),
    lastError: s.lastError ? String(s.lastError).slice(0, 300) : null,
    turn: turn.map((m) => ({
      role: m.role,
      stopCause: m.stopCause ?? null,
      failure: m.failure ? JSON.stringify(m.failure).slice(0, 300) : null,
      blocks: (m.blocks ?? []).map((b) => ({
        type: b.type,
        len: String(b.text ?? '').length,
        text: ['error', 'failure', 'notice'].includes(b.type) || m.role === 'error' ? String(b.text ?? '').slice(0, 300) : undefined,
        notice: b.notice ? JSON.stringify(b.notice).slice(0, 200) : undefined,
        toolName: b.toolName, status: b.status, isError: b.isError,
      })),
    })),
  };`;

async function rehearse() {
  const cdp = await attach();
  const out = {};
  out.announcement = await cdp.evaluate(DISMISS_ANNOUNCEMENT);
  await sleep(600);
  out.open = await cdp.evaluate(OPEN_CARD);
  out.card = await waitExpr(cdp, CARD_READY, 3000);
  out.cardButtons = await cdp.evaluate(`(() => {
    const b = ${CARD_LOGOUT_BUTTON};
    const card = b?.closest('[role="dialog"]');
    return card ? [...card.querySelectorAll('button')].map((n) => ((n.innerText || '').trim() || n.getAttribute('aria-label') || '').slice(0, 30)) : null;
  })()`);
  await gw.pressEscape(cdp);
  await sleep(500);
  out.cardAfterEscape = await cdp.evaluate(CARD_READY);
  out.vault = vaultShape();
  out.hosts = p15.hostProcs();
  cdp.close();
  console.log(JSON.stringify(gw.scrub(out), null, 2));
}

async function run(
  group = 'GPT',
  label = 'GPT 6.1 Sol',
  effort = '高',
  holdMs = '1000',
  tag = 'r8b-logout-inflight',
  text = '请用三句话说明中位数和平均数的区别。不要使用任何工具。'
) {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await gw.learnEndpointHost(evalAsync);
  await cdp.evaluate(INSTALL_ALL_EVENTS);
  const out = { model: label, effort, holdMs: Number(holdMs) };
  out.announcement = await cdp.evaluate(DISMISS_ANNOUNCEMENT);
  await sleep(600);
  const sid = await gw.newChat(cdp, evalAsync);
  out.sid = sid;
  await sleep(800);
  out.pick = await gw.pickModel(cdp, { label, group, effort });
  if (!out.pick.picked || !out.pick.effortPicked) {
    cdp.close();
    save(tag, { ...out, error: 'model or effort not picked (no request made)' });
    return;
  }
  out.vaultBefore = vaultShape();
  out.hostsBefore = p15.hostProcs();
  const appLogFrom = lineCount(APP_LOG);
  const devLogFrom = lineCount(DEV_LOG);

  await cdp.evaluate(gw.typeIntoComposer(text));
  await cdp.waitFor(gw.SEND_READY, { timeoutMs: 30_000, label: 'send ready' });
  out.cardOpen = await cdp.evaluate(OPEN_CARD);
  out.cardBeforeSend = await waitExpr(cdp, CARD_READY, 3000);
  if (out.cardBeforeSend !== 'ready') {
    cdp.close();
    save(tag, { ...out, error: 'account card not ready (no request made)' });
    return;
  }

  out.request = gw.spendRequest({
    item: tag,
    model: label,
    effort,
    kind: 'chat turn (logout in flight)',
  });
  const sentAt = Date.now();
  await cdp.evaluate(gw.CLICK_SEND);
  out.cardAfterSend = await cdp.evaluate(CARD_READY);

  // Wait for the turn to be running.
  const statuses = [];
  let runningAt = null;
  while (Date.now() - sentAt < 90_000) {
    const st = await evalAsync(
      `${STORE} return s.sessions.find((r) => r.id === ${JSON.stringify(sid)})?.status ?? null;`,
      { label: 'status' }
    );
    if (statuses.at(-1)?.status !== st) statuses.push({ dt: Date.now() - sentAt, status: st });
    if (st === 'running') {
      runningAt = Date.now();
      break;
    }
    if (statuses.length > 1 && !gw.BUSY.includes(st)) break;
    await sleep(100);
  }
  out.statusesBeforeLogout = statuses;
  if (runningAt === null) {
    out.error = 'turn never reached running; no logout';
    out.view = await evalAsync(sessionView(sid), { label: 'view' });
    cdp.close();
    save(tag, out);
    return;
  }
  out.runningAtMs = runningAt - sentAt;
  while (Date.now() - runningAt < Number(holdMs)) await sleep(50);

  // 退出登录 in the card (re-open the card if sending closed it) → confirm dialog.
  if ((await cdp.evaluate(CARD_READY)) !== 'ready') {
    out.cardReopened = await cdp.evaluate(OPEN_CARD);
    await waitExpr(cdp, CARD_READY, 3000);
  }
  out.cardLogout = await cdp.evaluate(CLICK_CARD_LOGOUT);
  out.cardLogoutAtMs = Date.now() - sentAt;
  out.confirmDialog = await waitExpr(cdp, CONFIRM_TEXT, 3000, 50);
  out.preConfirm = await evalAsync(sessionView(sid), { label: 'pre-confirm view' });
  out.transcriptBeforeConfirm = String(await cdp.evaluate(gw.TRANSCRIPT)).slice(-600);
  out.deltasBeforeConfirm = await cdp.evaluate(`JSON.parse(JSON.stringify(window.__p15r8bDeltas))`);
  const preStatus = out.preConfirm.session?.status;
  if (!gw.BUSY.includes(preStatus)) {
    out.confirm = await cdp.evaluate(clickConfirm('取消'));
    out.error = `turn already ${preStatus} before confirm; cancelled, no logout`;
    cdp.close();
    save(tag, out);
    return;
  }
  const logoutAt = Date.now();
  out.confirm = await cdp.evaluate(clickConfirm('退出登录'));
  out.logoutAtFromSend = logoutAt - sentAt;

  // Watch for 40 s.
  const trace = [];
  let hostGoneAt = null;
  let pageGone = null;
  while (Date.now() - logoutAt < 40_000) {
    await sleep(Date.now() - logoutAt < 3000 ? 100 : 300);
    const hosts = p15.hostProcs();
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
    } catch (error) {
      pageGone = {
        dt: Date.now() - logoutAt,
        error: String(error?.message ?? error).slice(0, 160),
      };
      break;
    }
  }
  out.hostGoneAfterLogoutMs = hostGoneAt;
  out.hostsAfter = p15.hostProcs();
  out.trace = trace;
  out.pageGone = pageGone;
  const events = await cdp.evaluate(
    `(window.__p15r8b ?? []).filter((e) => e.t >= ${sentAt - 1000})`
  );
  out.events = events.map((e) => ({ ...e, dtFromLogout: e.t - logoutAt, t: undefined }));
  out.deltas = await cdp.evaluate(`JSON.parse(JSON.stringify(window.__p15r8bDeltas))`);
  out.after = await evalAsync(sessionView(sid), { label: 'after view' });
  out.vaultAfter = vaultShape();
  out.finalBody = await cdp.evaluate(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400)`);
  out.finalHasAt = await cdp.evaluate(`document.body.innerText.includes('@')`);
  if (!out.finalHasAt) out.shot = await gw.shot(cdp, 'r8b-after-logout');
  out.problems = cdp.problems.slice(0, 8);
  cdp.close();
  await sleep(1000);
  out.appLog = newLogLines(APP_LOG, appLogFrom);
  out.devLog = newLogLines(DEV_LOG, devLogFrom).slice(-60);
  try {
    out.dshLogTypes = execFileSync('node', [path.join(here, 'effort-log.mjs'), '--types', sid], {
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    out.dshLogTypes = `failed: ${String(error?.message ?? error).slice(0, 160)}`;
  }
  save(tag, out);
}

const steps = { rehearse, run };
const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: p1-5-r8b.mjs ${Object.keys(steps).join('|')}`);
  process.exit(2);
}
await steps[name](...process.argv.slice(3));
process.exit(0);
