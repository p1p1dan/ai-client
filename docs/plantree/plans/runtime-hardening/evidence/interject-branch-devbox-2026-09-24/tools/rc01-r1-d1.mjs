/**
 * R1 (T128 re-check of D1) — form B is cut; the Chinese failure card must show
 * (title + reason + 继续), the composer's raw red box must stay down, status is
 * `failed`, the sidebar row is marked, 「会话分支」 is clickable. Then:
 *   R1b  a plain send clears the card and its request carries no degenerate reply;
 *   R1c  a second cut, then the card's 继续 — record what it re-sends.
 */
import fs from 'node:fs';
import {
  connect,
  driveTurn,
  gwLines,
  gwMark,
  messagesOf,
  newSession,
  save,
  sendText,
  shot,
  sleep,
  stamp,
  waitGw,
  waitStatus,
} from './ij-lib.mjs';
import {
  CLICK_CARD_CONTINUE,
  failureDom,
  failureStore,
  TOOL_ROWS_WITH_OUTCOME,
} from './rc-lib.mjs';

const SENTINEL = '/tmp/loopguard-sentinel.txt';
const TOUCHED = '/tmp/loopguard-touched.txt';
const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp() };

async function cutFormB(text, tag) {
  const r = {};
  for (const f of [SENTINEL, TOUCHED]) if (fs.existsSync(f)) fs.unlinkSync(f);
  const mark = gwMark();
  const s = await sendText(cdp, evalAsync, text);
  r.sid = s.sid;
  r.sentAt = s.at;
  const req = await waitGw(
    (l) => l.event === 'request' && /formB: degenerate reply/.test(l.reply ?? ''),
    mark,
    30000
  );
  r.degenerateRequest = req && { t: req.t, seq: req.seq };
  r.streamEnd = await waitGw(
    (l) => (l.event === 'client_abort' || l.event === 'response_complete') && l.seq === req.seq,
    mark,
    120000
  );
  r.settled = await waitStatus(
    evalAsync,
    s.sid,
    (st) => st.status !== 'running' && st.status !== 'starting' && st.status !== 'stopping',
    30000
  );
  await sleep(1500);
  r.store = await evalAsync(failureStore(s.sid));
  r.dom = await cdp.evaluate(failureDom(r.store.title));
  r.shot = await shot(cdp, `r1-${tag}-failure-surface.png`);
  r.rows = await cdp.evaluate(TOOL_ROWS_WITH_OUTCOME(null));
  r.sentinelExists = fs.existsSync(SENTINEL);
  r.touchedExists = fs.existsSync(TOUCHED);
  r.mark = mark;
  r.reqSeq = req.seq;
  return r;
}

try {
  out.newSession = await newSession(cdp, evalAsync);
  // ---------- R1a: first cut ----------
  const a = await cutFormB('⟦formB⟧ R1 形态B：等它被掐断，看失败卡', 'a');
  out.a = a;
  const sid = a.sid;
  out.sid = sid;
  // Status stability: the card must still be there a few seconds later (the old bug: idle overwrote failed).
  await sleep(4000);
  out.a.storeLater = await evalAsync(failureStore(sid));
  out.a.domLater = await cdp.evaluate(failureDom(a.store.title));
  out.a.requestsAfterCut = gwLines(a.mark).lines.filter(
    (l) => l.event === 'request' && l.seq > a.reqSeq
  ).length;
  // Session tree button: click it, a dialog must open.
  out.a.treeClick = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && (x.getAttribute('title') || '') === '会话分支');
    if (!b) return { ok: false, why: 'no button' };
    if (b.disabled) return { ok: false, why: 'disabled' };
    b.click();
    return { ok: true };
  })()`);
  await sleep(2500);
  out.a.treeDialog = await cdp.evaluate(`(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].filter((n) => n.offsetParent !== null);
    return d.map((n) => (n.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 300));
  })()`);
  out.a.treeShot = await shot(cdp, 'r1-a-session-tree-dialog.png');
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await sleep(1200);
  out.a.dialogsAfterEsc = await cdp.evaluate(`document.querySelectorAll('[role="dialog"]').length`);
  out.a.storeAfterTree = await evalAsync(failureStore(sid));
  console.log(
    'R1a',
    JSON.stringify(
      {
        streamEnd: a.streamEnd,
        settled: a.settled?.status,
        store: a.store,
        dom: a.dom,
        later: { status: out.a.storeLater.status, cards: out.a.domLater.cards.map((c) => c.title) },
        requestsAfterCut: out.a.requestsAfterCut,
        tree: out.a.treeClick,
        dialog: out.a.treeDialog,
        rows: a.rows && {
          n: a.rows.outcomeRows,
          hist: a.rows.hist,
          red: a.rows.redTextNodes,
          spin: a.rows.spinners,
        },
        sentinel: a.sentinelExists,
        touched: a.touchedExists,
      },
      null,
      1
    )
  );

  // ---------- R1b: plain send straight after the failure ----------
  const markB = gwMark();
  const trail = [];
  const b = await sendText(cdp, evalAsync, '⟦echo⟧ R1b 失败后直接发一条普通消息');
  out.b = { sentAt: b.at, sid: b.sid };
  const t0 = Date.now();
  let sawReq = null;
  while (Date.now() - t0 < 30000) {
    const st = await evalAsync(failureStore(sid));
    const dom = await cdp.evaluate(failureDom(st.title));
    const key = `${st.status}|${dom.cards.length}|${dom.composerBoxes.length}`;
    if (trail.at(-1)?.key !== key)
      trail.push({
        key,
        t: st.t,
        status: st.status,
        cards: dom.cards.map((c) => c.title),
        composerBoxes: dom.composerBoxes,
      });
    sawReq =
      sawReq ??
      gwLines(markB).lines.find((l) => l.event === 'request' && /R1b/.test(l.lastText ?? ''));
    if (sawReq && st.status === 'idle' && Date.now() - t0 > 3000) break;
    await sleep(250);
  }
  out.b.trail = trail;
  out.b.request = sawReq && {
    t: sawReq.t,
    seq: sawReq.seq,
    digest: sawReq.digest,
    messageCount: sawReq.messageCount,
    historyToolUseCount: sawReq.historyToolUseCount,
    historyTaskListCount: sawReq.historyTaskListCount,
    reply: sawReq.reply,
  };
  await sleep(1500);
  out.b.store = await evalAsync(failureStore(sid));
  out.b.dom = await cdp.evaluate(failureDom(out.b.store.title));
  out.b.lastMessages = (await evalAsync(messagesOf(sid))).slice(-2);
  out.b.shot = await shot(cdp, 'r1-b-after-plain-send.png');
  console.log(
    'R1b',
    JSON.stringify(
      {
        trail,
        request: out.b.request,
        store: out.b.store.status,
        cards: out.b.dom.cards.map((c) => c.title),
        last: out.b.lastMessages.map(
          (m) => `${m.role}: ${m.text ?? m.blocks.map((x) => x.text).join('')}`
        ),
      },
      null,
      1
    )
  );

  // ---------- R1c: cut again, then the card's 继续 ----------
  const c = await cutFormB('⟦formB⟧ R1c 再掐断一次，然后点「继续」', 'c');
  out.c = c;
  console.log(
    'R1c cut',
    JSON.stringify({
      streamEnd: c.streamEnd?.event,
      store: c.store.status,
      cards: c.dom.cards.map((x) => ({ title: x.title, buttons: x.buttons })),
    })
  );
  const markC = gwMark();
  const usersBefore = (await evalAsync(messagesOf(sid))).filter((m) => m.role === 'user').length;
  out.c.continueClick = await cdp.evaluate(CLICK_CARD_CONTINUE);
  const req = await waitGw((l) => l.event === 'request', markC, 20000);
  out.c.continueRequest = req && {
    t: req.t,
    seq: req.seq,
    lastText: req.lastText,
    digest: req.digest,
    reply: req.reply,
    historyToolUseCount: req.historyToolUseCount,
  };
  await sleep(1500);
  out.c.domAfterContinue = await cdp.evaluate(failureDom(c.store.title));
  out.c.shotAfterContinue = await shot(cdp, 'r1-c-after-continue.png');
  // The resend is the same ⟦formB⟧ prompt, so the fake model degenerates again: wait for that run to settle.
  if (req && /degenerate/.test(req.reply ?? '')) {
    out.c.secondStreamEnd = await waitGw(
      (l) => (l.event === 'client_abort' || l.event === 'response_complete') && l.seq === req.seq,
      markC,
      120000
    );
    out.c.secondSettled = await waitStatus(
      evalAsync,
      sid,
      (st) => st.status !== 'running' && st.status !== 'starting' && st.status !== 'stopping',
      30000
    );
    await sleep(1500);
  } else {
    out.c.drive = await driveTurn(evalAsync, sid, { timeoutMs: 60000, busyGraceMs: 3000 });
  }
  const msgs = await evalAsync(messagesOf(sid));
  out.c.userMessagesAfter = msgs
    .filter((m) => m.role === 'user')
    .map((m) => m.blocks.map((x) => x.text ?? '').join(''));
  out.c.userCountBefore = usersBefore;
  out.c.storeEnd = await evalAsync(failureStore(sid));
  out.c.domEnd = await cdp.evaluate(failureDom(out.c.storeEnd.title));
  out.c.shotEnd = await shot(cdp, 'r1-c-end.png');
  console.log(
    'R1c continue',
    JSON.stringify(
      {
        click: out.c.continueClick,
        request: out.c.continueRequest,
        secondEnd: out.c.secondStreamEnd?.event,
        users: out.c.userMessagesAfter,
        storeEnd: out.c.storeEnd.status,
        cardsEnd: out.c.domEnd.cards.map((x) => x.title),
      },
      null,
      1
    )
  );
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save('r1-d1.json', out);
  cdp.close();
}
