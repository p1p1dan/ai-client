/**
 * C3 re-run with an OVERFLOWING transcript: pinned to the bottom of a long
 * conversation while a new turn streams, click the newest thought / tool row
 * header (TARGET=thought|tool) and watch whether the header stays in view.
 */
import {
  connect,
  driveTurn,
  gwMark,
  save,
  sendText,
  shot,
  sleep,
  stamp,
  TRANSCRIPT_VP,
  waitGw,
} from './ij-lib.mjs';

const TARGET = process.env.TARGET ?? 'thought';
const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp(), target: TARGET };
const ROWS = `(() => {
  const vp = ${TRANSCRIPT_VP};
  const vr = vp.getBoundingClientRect();
  const vis = (n) => n.offsetParent !== null;
  const trig = [...vp.querySelectorAll('button, [role="button"]')].filter(vis)
    .map((n) => ({ n, text: (n.innerText || '').trim().replace(/\\s+/g, ' ') }))
    .filter((x) => /^(思考中|已思考|思考)/.test(x.text) || /^(终端|运行中) echo think-tool/.test(x.text));
  return {
    t: new Date().toISOString(), scrollTop: Math.round(vp.scrollTop), scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight,
    atBottom: vp.scrollHeight - vp.clientHeight - vp.scrollTop < 4, vpTop: Math.round(vr.top), vpBottom: Math.round(vr.bottom),
    rows: trig.map((x, i) => { const r = x.n.getBoundingClientRect();
      return { i, text: x.text.slice(0, 40), expanded: x.n.getAttribute('aria-expanded'), top: Math.round(r.top), bottom: Math.round(r.bottom),
        inView: r.top >= vr.top && r.bottom <= vr.bottom, cx: Math.round(r.left + 20), cy: Math.round(r.top + r.height / 2) }; }),
  };
})()`;
try {
  const mark = gwMark();
  const s = await sendText(cdp, evalAsync, `⟦think⟧ C3 复测（${TARGET}）：长对话底部，流式中点开`);
  out.sid = s.sid;
  await waitGw((l) => l.event === 'request' && /think step1/.test(l.reply ?? ''), mark, 30000);
  await sleep(2500);
  out.before = await cdp.evaluate(ROWS);
  const re = TARGET === 'tool' ? /think-tool/ : /思考/;
  const cands = out.before.rows.filter((r) => re.test(r.text) && r.inView && r.expanded !== 'true');
  const pick = cands.at(-1);
  out.pick = pick ?? null;
  out.shotBefore = await shot(cdp, `17-c3-${TARGET}-before.png`);
  if (pick) {
    out.clickAt = stamp();
    // Rect read and click in ONE evaluate: the streamed text moves the header ~28px every 300ms,
    // so a CDP mouse click at a position read a moment earlier lands on the wrong row.
    out.click = await cdp.evaluate(`(() => {
      const vp = ${TRANSCRIPT_VP};
      const vr = vp.getBoundingClientRect();
      const vis = (n) => n.offsetParent !== null;
      const rows = [...vp.querySelectorAll('button, [role="button"]')].filter(vis)
        .filter((n) => { const t = (n.innerText || '').trim().replace(/\\s+/g, ' '); return /^(思考中|已思考|思考)/.test(t) || /^(终端|运行中) echo think-tool/.test(t); });
      const n = rows[${pick.i}];
      const r = n.getBoundingClientRect();
      const before = { scrollTop: Math.round(vp.scrollTop), top: Math.round(r.top), inView: r.top >= vr.top && r.bottom <= vr.bottom, text: (n.innerText || '').trim() };
      n.click();
      return before;
    })()`);
    out.samples = [];
    for (let i = 0; i < 30; i += 1) {
      const x = await cdp.evaluate(ROWS);
      const me = x.rows.find((r) => r.i === pick.i) ?? null;
      out.samples.push({
        t: x.t,
        scrollTop: x.scrollTop,
        scrollHeight: x.scrollHeight,
        atBottom: x.atBottom,
        target: me,
      });
      if (i === 3) out.shotAfter = await shot(cdp, `17-c3-${TARGET}-after-click.png`);
      await sleep(150);
    }
    out.shotLater = await shot(cdp, `17-c3-${TARGET}-4s-later.png`);
  }
  out.settle = await driveTurn(evalAsync, s.sid, { timeoutMs: 120000, busyGraceMs: 3000 });
  console.log(
    JSON.stringify(
      {
        before: {
          st: out.before.scrollTop,
          sh: out.before.scrollHeight,
          ch: out.before.clientHeight,
          bottom: out.before.atBottom,
        },
        pick: out.pick,
        samples: (out.samples ?? []).map(
          (x) =>
            `${x.t.slice(11, 23)} st=${x.scrollTop} sh=${x.scrollHeight} bottom=${x.atBottom} target=${x.target ? `${x.target.top}${x.target.inView ? '' : '(OUT)'} exp=${x.target.expanded}` : 'gone'}`
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
  save(`17-c3-${TARGET}.json`, out);
  cdp.close();
}
