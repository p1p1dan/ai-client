/**
 * C2 — thinking rows start collapsed. C3 — pinned to the bottom of a streaming
 * turn, opening a thought / a tool row must not scroll the clicked header away.
 */
import {
  connect,
  driveTurn,
  gwMark,
  mouseClickAt,
  newSession,
  save,
  sendText,
  shot,
  sleep,
  stamp,
  TRANSCRIPT_VP,
  waitGw,
} from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp() };

const ROWS = `(() => {
  const vp = ${TRANSCRIPT_VP};
  if (!vp) return null;
  const vr = vp.getBoundingClientRect();
  const vis = (n) => n.offsetParent !== null;
  const trig = [...vp.querySelectorAll('button, [role="button"]')].filter(vis)
    .map((n) => ({ n, text: (n.innerText || '').trim().replace(/\\s+/g, ' ') }))
    .filter((x) => /^(思考中|已思考|思考)/.test(x.text) || /^终端 echo think-tool/.test(x.text));
  return {
    t: new Date().toISOString(),
    scrollTop: Math.round(vp.scrollTop), scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight,
    atBottom: vp.scrollHeight - vp.clientHeight - vp.scrollTop < 4,
    vpTop: Math.round(vr.top), vpBottom: Math.round(vr.bottom),
    rows: trig.map((x, i) => {
      const r = x.n.getBoundingClientRect();
      return { i, text: x.text.slice(0, 50), expanded: x.n.getAttribute('aria-expanded'), dataPanelOpen: x.n.hasAttribute('data-panel-open'),
        top: Math.round(r.top), bottom: Math.round(r.bottom), inView: r.top >= vr.top && r.bottom <= vr.bottom, cx: Math.round(r.left + 20), cy: Math.round(r.top + r.height / 2) };
    }),
  };
})()`;

try {
  out.newSession = await newSession(cdp, evalAsync);
  const mark = gwMark();
  const s = await sendText(cdp, evalAsync, '⟦think⟧ C2/C3：思考默认折叠；流式中点开不被卷走');
  const sid = s.sid;
  out.sid = sid;
  // C2 while the first thought streams.
  await waitGw((l) => l.event === 'request' && /think step0/.test(l.reply ?? ''), mark, 30000);
  await sleep(1000);
  out.c2DuringThinking = await cdp.evaluate(ROWS);
  out.c2ShotStreaming = await shot(cdp, '16-c2-thinking-streaming.png');
  // step1 = thinking + ~45s of streamed text.
  const step1 = await waitGw(
    (l) => l.event === 'request' && /think step1/.test(l.reply ?? ''),
    mark,
    30000
  );
  out.step1At = step1?.t;
  await sleep(4500);
  out.c2BeforeClick = await cdp.evaluate(ROWS);
  out.c3ShotBefore = await shot(cdp, '16-c3-before-click-thought.png');
  const pickThought = out.c2BeforeClick.rows.find(
    (r) => /思考/.test(r.text) && r.inView && r.expanded !== 'true'
  );
  out.c3ThoughtTarget = pickThought ?? null;
  const samples = async (tag, n = 30, gap = 150) => {
    const arr = [];
    for (let i = 0; i < n; i += 1) {
      arr.push({ tag, ...(await cdp.evaluate(ROWS)) });
      await sleep(gap);
    }
    return arr;
  };
  if (pickThought) {
    out.c3ThoughtClickAt = stamp();
    await mouseClickAt(cdp, pickThought.cx, pickThought.cy);
    out.c3ThoughtSamples = await samples('after-thought-click');
    out.c3ShotAfterThought = await shot(cdp, '16-c3-after-click-thought.png');
  }
  // Back to the live edge, then the tool row.
  await cdp.evaluate(
    `(() => { const vp = ${TRANSCRIPT_VP}; vp.scrollTop = vp.scrollHeight; return vp.scrollTop; })()`
  );
  await sleep(1500);
  out.beforeToolClick = await cdp.evaluate(ROWS);
  const pickTool = out.beforeToolClick.rows.find(
    (r) => /think-tool/.test(r.text) && r.inView && r.expanded !== 'true'
  );
  out.c3ToolTarget = pickTool ?? null;
  if (pickTool) {
    out.c3ToolClickAt = stamp();
    await mouseClickAt(cdp, pickTool.cx, pickTool.cy);
    out.c3ToolSamples = await samples('after-tool-click');
    out.c3ShotAfterTool = await shot(cdp, '16-c3-after-click-tool.png');
  }
  out.settle = await driveTurn(evalAsync, sid, { timeoutMs: 120000, busyGraceMs: 3000 });
  await sleep(2000);
  out.afterSettle = await cdp.evaluate(ROWS);
  out.shotSettled = await shot(cdp, '16-c2-settled.png');
  const brief = (arr) =>
    (arr ?? []).map((x) => {
      const _r =
        x.rows.find((q) =>
          q.text.startsWith(((out.c3ThoughtTarget ?? out.c3ToolTarget)?.text ?? '').slice(0, 6))
        ) ?? {};
      return `${x.t.slice(11, 23)} st=${x.scrollTop} sh=${x.scrollHeight} bottom=${x.atBottom} rows=${x.rows.map((q) => `${q.text.slice(0, 12)}@${q.top}${q.inView ? '' : '!'}/${q.expanded}`).join(',')}`;
    });
  console.log(
    JSON.stringify(
      {
        c2DuringThinking: out.c2DuringThinking,
        c2BeforeClick: out.c2BeforeClick,
        thoughtTarget: out.c3ThoughtTarget,
        thought: brief(out.c3ThoughtSamples),
        toolTarget: out.c3ToolTarget,
        tool: brief(out.c3ToolSamples),
        afterSettle: out.afterSettle,
      },
      null,
      1
    )
  );
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save('16-c2-c3.json', out);
  cdp.close();
}
