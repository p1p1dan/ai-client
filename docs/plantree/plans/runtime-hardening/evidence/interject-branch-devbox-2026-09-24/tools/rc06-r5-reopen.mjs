/**
 * R5 (T128 re-check of N2) — after a restart, reopen the three rc05
 * conversations from the sidebar and read the same clock facts:
 * 「已工作 N 秒」 and 「完成于 HH:MM」 must match what they showed live, and the
 * interjected turn must end at the bash's end (the marker file's mtime), not at
 * the write of the call that started it.
 */
import fs from 'node:fs';
import { enterApp } from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck/tools/pc-lib.mjs';
import { connect, ENTER_MAIN_SURFACE, save, shot, sleep, stamp } from './ij-lib.mjs';
import { openFromSidebar, storeStamps, turnClock } from './rc-lib.mjs';

const { cdp, evalAsync } = await connect();
const cases = JSON.parse(fs.readFileSync('/tmp/ij/r5-cases.json', 'utf8'));
const NEEDLE = { ij: 'R5-ij 插话回合', stop: 'R5-stop', norm: 'R5-norm' };
const out = { startedAt: stamp(), cases: {} };
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
try {
  const hasComposer = await cdp.evaluate(`document.querySelector('textarea') !== null`);
  out.enter = hasComposer ? 'already on main surface' : await enterApp(cdp, ENTER_MAIN_SURFACE);
  await sleep(1500);
  for (const [k, c] of Object.entries(cases)) {
    const r = { sid: c.sid, before: c.live };
    r.switch = await openFromSidebar(cdp, evalAsync, c.sid, sleep);
    let clock = null;
    for (let i = 0; i < 20; i += 1) {
      clock = await cdp.evaluate(turnClock(NEEDLE[k]));
      if (clock?.worked) break;
      await sleep(600);
    }
    await sleep(800);
    r.after = await cdp.evaluate(turnClock(NEEDLE[k]));
    r.afterStamps = await evalAsync(storeStamps(c.sid));
    r.beforeStamps = c.liveStamps;
    r.markers = c.markers;
    const lastAsst = [...r.afterStamps]
      .reverse()
      .find((m) => m.role === 'assistant' && (k !== 'ij' || m.stopCause === 'interjected'));
    r.replayedEnd = lastAsst
      ? {
          timestamp: lastAsst.iso,
          settledAt: lastAsst.settledIso,
          hhmmTimestamp: lastAsst.timestamp ? hhmm(lastAsst.timestamp) : null,
          hhmmSettled: lastAsst.settledAt ? hhmm(lastAsst.settledAt) : null,
        }
      : null;
    r.markerHhmm = c.markers?.[0] ? hhmm(Date.parse(c.markers[0].mtime)) : null;
    r.same = {
      worked: r.after?.worked === c.live?.worked,
      completed: r.after?.completed === c.live?.completed,
    };
    r.shot = await shot(cdp, `r5-${k}-after-restart.png`);
    out.cases[k] = r;
    console.log(
      k,
      JSON.stringify(
        {
          clicked: r.switch.clicked,
          before: { worked: c.live?.worked, completed: c.live?.completed },
          after: { worked: r.after?.worked, completed: r.after?.completed },
          same: r.same,
          replayedEnd: r.replayedEnd,
          marker: c.markers?.[0] ?? null,
          markerHhmm: r.markerHhmm,
        },
        null,
        1
      )
    );
  }
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save('r5-after-restart.json', out);
  cdp.close();
}
