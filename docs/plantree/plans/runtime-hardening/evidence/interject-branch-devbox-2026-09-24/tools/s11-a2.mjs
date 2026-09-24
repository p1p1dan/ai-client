/**
 * A1 / A2 / A3 (+ A8 for the interjected turn) — Ctrl+Enter during a running
 * bash `sleep 20`: the step must finish, the run must stop at that boundary,
 * and the interjection must go out as the next message.
 */
import fs from 'node:fs';
import {
  COMPOSER,
  connect,
  driveTurn,
  gwLines,
  gwMark,
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
  toggleTurnGroup,
  toolRowText,
  waitGw,
} from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp() };
try {
  out.newSession = await newSession(cdp, evalAsync);
  const mark = gwMark();
  const first = await sendText(cdp, evalAsync, '⟦long⟧ A2 长回合：准备 → sleep 20 → 再一步 → 回答');
  out.firstSend = first;
  const sid = first.sid;
  const step1 = await waitGw(
    (l) => l.event === 'response_complete' && /long step1/.test(l.label),
    mark,
    60000
  );
  out.step1Response = step1;
  await sleep(3000);
  out.statusWhileBash = await evalAsync(sessionState(sid));
  out.a1Composer = await cdp.evaluate(COMPOSER);
  out.bashRowWhileRunning = await cdp.evaluate(toolRowText('sleep 20'));
  out.a1Shot = await shot(cdp, '11-a1-running-placeholder.png');

  const ijText = '⟦echo⟧ 插话-A2：这一步跑完就停，先回我这句';
  out.interject = await sendText(cdp, evalAsync, ijText, { ctrl: true });
  await sleep(300);
  out.a3Queue = await cdp.evaluate(QUEUE_ROWS);
  out.a3Composer = await cdp.evaluate(COMPOSER);
  out.a3Shot = await shot(cdp, '11-a3-queue-marker.png');

  // Poll while the bash finishes: status trail + bash row.
  const trail = [];
  const t0 = Date.now();
  let ijReq = null;
  while (Date.now() - t0 < 60000) {
    const st = await evalAsync(sessionState(sid));
    if (trail.at(-1)?.status !== st.status) trail.push({ t: st.t, status: st.status });
    ijReq = gwLines(mark).lines.find(
      (l) => l.event === 'request' && /插话-A2/.test(l.lastText ?? '')
    );
    if (ijReq) break;
    await sleep(400);
  }
  out.statusTrail = trail;
  out.interjectRequest = ijReq;
  const settle = await driveTurn(evalAsync, sid, { timeoutMs: 60000, busyGraceMs: 5000 });
  out.settle = settle;
  await sleep(2000);
  const gw = gwLines(mark).lines;
  out.gateway = gw.map((l) => ({
    t: l.t,
    event: l.event,
    seq: l.seq,
    reply: l.reply ?? l.label,
    lastText: l.lastText,
    digest: l.digest,
    lastToolResults: l.lastToolResults,
  }));
  out.step2Requested = gw.some((l) => /long step2/.test(l.reply ?? ''));
  out.messages = await evalAsync(messagesOf(sid));
  out.markerFiles = fs
    .readdirSync('/tmp/ij/markers')
    .map((f) => ({ f, mtime: fs.statSync(`/tmp/ij/markers/${f}`).mtime.toISOString() }));
  out.turns = await cdp.evaluate(TURNS);
  out.a8Shot = await shot(cdp, '11-a8-interjected-turn-default.png');
  out.a8Toggle = await cdp.evaluate(toggleTurnGroup('A2 长回合'));
  await sleep(800);
  out.turnsAfterToggle = await cdp.evaluate(TURNS);
  out.a8ShotCollapsed = await shot(cdp, '11-a8-interjected-turn-after-click.png');
  out.sid = sid;
  console.log(
    JSON.stringify(
      {
        ...out,
        messages: undefined,
        gateway: out.gateway.map(
          (g) => `${g.t} ${g.event} ${g.seq} ${g.reply} | ${g.lastText ?? ''}`
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
  save('11-a2.json', out);
  cdp.close();
}
