/** A7 — Ctrl+Enter while the parent is parked on a slow background delegate. */
import {
  connect,
  gwLines,
  gwMark,
  lanesOf,
  messagesOf,
  newSession,
  QUEUE_ROWS,
  save,
  sendText,
  sessionState,
  shot,
  sleep,
  stamp,
  TURNS,
  waitGw,
} from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp(), laneTrail: [], statusTrail: [] };
const track = async (sid, tag) => {
  const lanes = await evalAsync(lanesOf(sid));
  const st = await evalAsync(sessionState(sid));
  const key = JSON.stringify(lanes.map((l) => [l.status, l.rows]));
  if (out.laneTrail.at(-1)?.key !== key) out.laneTrail.push({ t: stamp(), tag, key, lanes });
  if (out.statusTrail.at(-1)?.status !== st.status)
    out.statusTrail.push({ t: st.t, tag, status: st.status });
};
try {
  out.newSession = await newSession(cdp, evalAsync);
  const mark = gwMark();
  const s = await sendText(cdp, evalAsync, '⟦sub⟧ A7 派慢子代理，然后插话');
  const sid = s.sid;
  out.sid = sid;
  out.childStarted = await waitGw((l) => l.event === 'request' && l.route === 'child', mark, 60000);
  out.parentWaiting = await waitGw(
    (l) => l.event === 'response_complete' && /sub: dispatched text/.test(l.label),
    mark,
    60000
  );
  for (let i = 0; i < 4; i += 1) {
    await track(sid, 'before-interject');
    await sleep(500);
  }
  out.shotBefore = await shot(cdp, '15-a7-before-interject.png');
  out.interject = await sendText(cdp, evalAsync, '⟦echo⟧ 插话-A7：子代理还在跑，先回我这句', {
    ctrl: true,
  });
  out.queueAfter = await cdp.evaluate(QUEUE_ROWS);
  const tIj = Date.parse(out.interject.at);
  let ijReq = null;
  while (Date.now() - tIj < 60000) {
    await track(sid, 'after-interject');
    ijReq = gwLines(mark).lines.find(
      (l) => l.event === 'request' && /插话-A7/.test(l.lastText ?? '')
    );
    if (ijReq) break;
    await sleep(300);
  }
  out.interjectRequest = ijReq && {
    t: ijReq.t,
    seq: ijReq.seq,
    route: ijReq.route,
    digest: ijReq.digest,
    latencyMs: Date.parse(ijReq.t) - tIj,
  };
  await sleep(2500);
  await track(sid, 'after-echo');
  out.shotAfterEcho = await shot(cdp, '15-a7-after-interject-echo.png');
  // Now wait for the child to finish and the report to reach the parent.
  let reportReq = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 120000) {
    await track(sid, 'waiting-report');
    reportReq = gwLines(mark).lines.find(
      (l) => l.event === 'request' && l.route === 'parent' && /CHILD-REPORT/.test(l.lastText ?? '')
    );
    if (reportReq) break;
    await sleep(1000);
  }
  out.reportRequest = reportReq && {
    t: reportReq.t,
    seq: reportReq.seq,
    lastText: reportReq.lastText,
    digest: reportReq.digest,
    reply: reportReq.reply,
  };
  for (let i = 0; i < 8; i += 1) {
    await track(sid, 'after-report');
    await sleep(700);
  }
  out.gateway = gwLines(mark).lines.map(
    (l) =>
      `${l.t} ${l.event} ${l.seq} ${l.route ?? ''} ${l.reply ?? l.label} | ${(l.lastText ?? '').slice(0, 80)}`
  );
  out.messages = await evalAsync(messagesOf(sid));
  out.turns = await cdp.evaluate(TURNS);
  out.shotEnd = await shot(cdp, '15-a7-end.png');
  console.log(
    JSON.stringify(
      {
        ...out,
        messages: out.messages.map(
          (m) =>
            `${m.role} ${m.stopCause ?? ''} ${m.blocks
              .map((b) => `${b.type}:${b.text ?? b.toolName ?? ''}`)
              .join(' | ')
              .slice(0, 160)}`
        ),
      },
      null,
      1
    )
  );
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save('15-a7.json', out);
  cdp.close();
}
