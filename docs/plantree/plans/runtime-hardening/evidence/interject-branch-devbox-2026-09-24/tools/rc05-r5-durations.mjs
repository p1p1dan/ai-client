/**
 * R5 (T128 re-check of N2) + R8 smoke A2 / C1 — before the restart.
 *
 * Three fresh conversations, each one ⟦long⟧ turn (bash `sleep 20`):
 *   ij    Ctrl+Enter 4s into the sleep (A2: the step finishes, the run stops at that boundary)
 *   stop  Stop 4s into the sleep
 *   norm  runs to LONG-DONE; the running row's clock is sampled every 500ms (C1)
 * The interjected turn is started at wall-clock second ~44 so the bash ends in
 * the NEXT minute: 「完成于 HH:MM」 then tells a bash-end completion from a
 * step-write completion even at minute resolution.
 *
 * Writes the case list to /tmp/ij/r5-cases.json for rc06 (after the restart).
 */
import fs from 'node:fs';
import {
  clickLabel,
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
  toolRowText,
  waitGw,
  waitStatus,
} from './ij-lib.mjs';
import { storeStamps, turnClock } from './rc-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp(), cases: {} };

async function waitForSecond(target) {
  for (let i = 0; i < 200; i += 1) {
    const s = new Date().getSeconds();
    if (s === target) return stamp();
    await sleep(250);
  }
  return stamp();
}
const newMarkers = (before) =>
  fs
    .readdirSync('/tmp/ij/markers')
    .filter((f) => !before.includes(f))
    .map((f) => ({ f, mtime: fs.statSync(`/tmp/ij/markers/${f}`).mtime.toISOString() }));

try {
  // ---------------- interjected (A2) ----------------
  {
    const r = { newSession: await newSession(cdp, evalAsync) };
    const markersBefore = fs.readdirSync('/tmp/ij/markers');
    r.alignedAt = await waitForSecond(43);
    const mark = gwMark();
    const s = await sendText(cdp, evalAsync, '⟦long⟧ R5-ij 插话回合：sleep 20 期间 Ctrl+Enter');
    r.sid = s.sid;
    r.sentAt = s.at;
    r.step1 = await waitGw(
      (l) => l.event === 'response_complete' && /long step1/.test(l.label),
      mark,
      60000
    );
    await sleep(4000);
    r.interject = await sendText(cdp, evalAsync, '⟦echo⟧ 插话-R5：这一步跑完就停', { ctrl: true });
    const ijReq = await waitGw(
      (l) => l.event === 'request' && /插话-R5/.test(l.lastText ?? ''),
      mark,
      60000
    );
    r.interjectRequest = ijReq && {
      t: ijReq.t,
      seq: ijReq.seq,
      lastToolResults: ijReq.lastToolResults,
      digest: ijReq.digest,
    };
    r.settle = await driveTurn(evalAsync, r.sid, { timeoutMs: 60000, busyGraceMs: 4000 });
    await sleep(2500);
    r.markers = newMarkers(markersBefore);
    r.gateway = gwLines(mark)
      .lines.filter((l) => l.event === 'request')
      .map((l) => `${l.t} #${l.seq} ${l.reply} | ${l.lastText ?? ''}`);
    r.step2Requested = gwLines(mark).lines.some((l) => /long step2/.test(l.reply ?? ''));
    r.stopCauses = (await evalAsync(messagesOf(r.sid)))
      .filter((m) => m.role === 'assistant')
      .map((m) => m.stopCause);
    r.live = await cdp.evaluate(turnClock('R5-ij 插话回合'));
    r.liveStamps = await evalAsync(storeStamps(r.sid));
    r.shot = await shot(cdp, 'r5-ij-live.png');
    out.cases.ij = r;
    console.log(
      'ij',
      JSON.stringify(
        {
          aligned: r.alignedAt,
          step1: r.step1?.t,
          interjectAt: r.interject.at,
          markers: r.markers,
          ijReq: r.interjectRequest?.t,
          step2: r.step2Requested,
          stopCauses: r.stopCauses,
          live: r.live,
        },
        null,
        1
      )
    );
  }
  // ---------------- Stop ----------------
  {
    const r = { newSession: await newSession(cdp, evalAsync) };
    const markersBefore = fs.readdirSync('/tmp/ij/markers');
    const mark = gwMark();
    const s = await sendText(cdp, evalAsync, '⟦long⟧ R5-stop：sleep 中途点 Stop');
    r.sid = s.sid;
    r.step1 = await waitGw(
      (l) => l.event === 'response_complete' && /long step1/.test(l.label),
      mark,
      60000
    );
    await sleep(4000);
    r.stopClick = await cdp.evaluate(clickLabel('停止当前回合'));
    r.idle = await waitStatus(evalAsync, r.sid, (st) => st.status === 'idle', 30000);
    await sleep(2500);
    r.markers = newMarkers(markersBefore);
    r.live = await cdp.evaluate(turnClock('R5-stop'));
    r.liveStamps = await evalAsync(storeStamps(r.sid));
    r.shot = await shot(cdp, 'r5-stop-live.png');
    out.cases.stop = r;
    console.log(
      'stop',
      JSON.stringify(
        { step1: r.step1?.t, stop: r.stopClick, idle: r.idle?.t, markers: r.markers, live: r.live },
        null,
        1
      )
    );
  }
  // ---------------- normal + C1 ----------------
  {
    const r = { newSession: await newSession(cdp, evalAsync) };
    const mark = gwMark();
    const s = await sendText(cdp, evalAsync, '⟦long⟧ R5-norm 正常回合 / C1 计时');
    r.sid = s.sid;
    r.step1 = await waitGw(
      (l) => l.event === 'response_complete' && /long step1/.test(l.label),
      mark,
      60000
    );
    const tStart = Date.parse(r.step1.t);
    const samples = [];
    for (let i = 0; i < 36; i += 1) {
      const wall = Date.now();
      const text = await cdp.evaluate(toolRowText('sleep 20'));
      samples.push({ wallIso: new Date(wall).toISOString(), sinceStep1Ms: wall - tStart, text });
      if (i === 10) r.c1Shot = await shot(cdp, 'r8-c1-running-clock.png');
      await sleep(Math.max(0, 500 - (Date.now() - wall)));
    }
    r.c1Samples = samples;
    r.settle = await driveTurn(evalAsync, r.sid, { timeoutMs: 90000, busyGraceMs: 3000 });
    await sleep(2500);
    r.live = await cdp.evaluate(turnClock('R5-norm'));
    r.liveStamps = await evalAsync(storeStamps(r.sid));
    r.shot = await shot(cdp, 'r5-norm-live.png');
    out.cases.norm = r;
    console.log(
      'norm',
      JSON.stringify(
        { live: r.live, c1: samples.map((x) => `${x.sinceStep1Ms} ${x.text}`) },
        null,
        1
      )
    );
  }
  fs.writeFileSync(
    '/tmp/ij/r5-cases.json',
    JSON.stringify(
      Object.fromEntries(
        Object.entries(out.cases).map(([k, v]) => [
          k,
          { sid: v.sid, live: v.live, liveStamps: v.liveStamps, markers: v.markers ?? null },
        ])
      ),
      null,
      2
    )
  );
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save('r5-before-restart.json', out);
  cdp.close();
}
