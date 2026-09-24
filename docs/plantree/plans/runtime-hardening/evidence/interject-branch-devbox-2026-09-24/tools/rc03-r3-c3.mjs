/**
 * R3 (T128 re-check of C3) — opening a disclosure at the bottom of a streaming
 * turn must pause bottom-following: the clicked header stays put, the text
 * keeps growing below, and the 「滚动到底部」 button shows once more than
 * ~140px is hidden. Following resumes by the button or a wheel back to the
 * bottom. Regression: plain streaming follows; a new send follows; closing a
 * block at the bottom does not stop following.
 *
 * Phases (PHASES=p0,p1,p2,p3,p4,p5), all in ONE fresh conversation so the
 * transcript overflows from p1 on:
 *   p0  ⟦think⟧, no interaction — sample distance-from-bottom while streaming
 *   p1  ⟦think⟧, click the newest thought header → sample → click 「滚动到底部」 → sample
 *   p2  ⟦think⟧, click the `echo think-tool` row → sample → mouse-wheel to bottom → sample
 *   p3  ⟦toolend⟧ then ⟦think⟧, click the FINISHED toolend turn's process head → sample → button
 *   p4  ⟦think⟧, open the tool row, resume by button, then CLOSE it at the bottom → sample
 *   p5  scroll up (following off), send ⟦think⟧ → must jump to the bottom and follow
 */
import {
  clickLabel,
  connect,
  driveTurn,
  gwMark,
  newSession,
  save,
  sendText,
  shot,
  sleep,
  stamp,
  TRANSCRIPT_VP,
  waitGw,
} from './ij-lib.mjs';

const PHASES = new Set((process.env.PHASES ?? 'p0,p1,p2,p3,p4,p5').split(','));
const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp(), phases: {} };

const GEOM = `(() => {
  const vp = ${TRANSCRIPT_VP};
  const vr = vp.getBoundingClientRect();
  const tgt = document.querySelector('[data-rc-target="1"]');
  const r = tgt ? tgt.getBoundingClientRect() : null;
  const jump = [...document.querySelectorAll('button[aria-label="滚动到底部"]')].some((b) => b.offsetParent !== null);
  return { t: new Date().toISOString(), st: Math.round(vp.scrollTop), sh: vp.scrollHeight, ch: vp.clientHeight,
    hidden: Math.round(vp.scrollHeight - vp.clientHeight - vp.scrollTop), jump,
    tTop: r ? Math.round(r.top) : null, tIn: r ? r.top >= vr.top && r.bottom <= vr.bottom : null,
    tExp: tgt ? (tgt.getAttribute('aria-expanded') ?? (tgt.closest('details')?.open ? 'open' : 'closed')) : null,
    vpTop: Math.round(vr.top), vpBottom: Math.round(vr.bottom) };
})()`;

/** Find, mark and click in ONE evaluate (streamed text moves headers ~28px per 300ms). */
const markAndClick = (kind, needle) => `(() => {
  const vp = ${TRANSCRIPT_VP};
  const vr = vp.getBoundingClientRect();
  for (const n of document.querySelectorAll('[data-rc-target]')) n.removeAttribute('data-rc-target');
  const vis = (n) => n.offsetParent !== null;
  const txt = (n) => (n.innerText || '').trim().replace(/\\s+/g, ' ');
  let cands = [];
  if (${JSON.stringify(kind)} === 'thought') cands = [...vp.querySelectorAll('button, [role="button"]')].filter(vis).filter((n) => /^(思考中|已思考|思考)/.test(txt(n)) && n.getAttribute('aria-expanded') !== 'true');
  if (${JSON.stringify(kind)} === 'tool') cands = [...vp.querySelectorAll('button, [role="button"]')].filter(vis).filter((n) => /echo think-tool/.test(txt(n)) && txt(n).length < 120);
  if (${JSON.stringify(kind)} === 'head') {
    const sec = [...vp.querySelectorAll('section[data-turn-id]')].find((s) => txt(s).includes(${JSON.stringify(needle ?? '')}));
    cands = sec ? [...sec.querySelectorAll('details > summary')].filter(vis) : [];
  }
  const inView = cands.filter((n) => { const r = n.getBoundingClientRect(); return r.top >= vr.top && r.bottom <= vr.bottom; });
  const n = inView.at(-1);
  if (!n) return { ok: false, candidates: cands.map((c) => ({ text: txt(c).slice(0, 50), top: Math.round(c.getBoundingClientRect().top) })) };
  n.setAttribute('data-rc-target', '1');
  const r = n.getBoundingClientRect();
  const before = { st: Math.round(vp.scrollTop), sh: vp.scrollHeight, hidden: Math.round(vp.scrollHeight - vp.clientHeight - vp.scrollTop), top: Math.round(r.top), text: txt(n).slice(0, 60), expanded: n.getAttribute('aria-expanded') ?? (n.closest('details')?.open ? 'open' : 'closed') };
  n.click();
  return { ok: true, at: new Date().toISOString(), before };
})()`;

const CLICK_TARGET = `(() => { const n = document.querySelector('[data-rc-target="1"]'); if (!n) return { ok: false }; const r = n.getBoundingClientRect(); n.click(); return { ok: true, at: new Date().toISOString(), top: Math.round(r.top) }; })()`;

async function sample(n, everyMs) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push(await cdp.evaluate(GEOM));
    await sleep(everyMs);
  }
  return rows;
}
const brief = (rows) =>
  rows.map(
    (x) =>
      `${x.t.slice(17, 23)} st=${x.st} sh=${x.sh} hid=${x.hidden} jump=${x.jump ? 1 : 0} tgt=${x.tTop ?? '-'}${x.tIn === false ? '(OUT)' : ''} ${x.tExp ?? ''}`
  );

async function startThink(tag) {
  const mark = gwMark();
  const s = await sendText(cdp, evalAsync, `⟦think⟧ R3-${tag}：底部流式中点开折叠块`);
  await waitGw((l) => l.event === 'request' && /think step1/.test(l.reply ?? ''), mark, 40000);
  return s;
}
async function wheelToBottom() {
  const g = await cdp.evaluate(
    `(() => { const vp = ${TRANSCRIPT_VP}; const r = vp.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`
  );
  const steps = [];
  for (let i = 0; i < 30; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: g.x,
      y: g.y,
      deltaX: 0,
      deltaY: 240,
    });
    await sleep(80);
    const x = await cdp.evaluate(GEOM);
    steps.push(x.hidden);
    if (x.hidden <= 2) break;
  }
  return { at: stamp(), steps };
}
async function wheelUp(px) {
  const g = await cdp.evaluate(
    `(() => { const vp = ${TRANSCRIPT_VP}; const r = vp.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`
  );
  for (let moved = 0; moved < px; moved += 240) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: g.x,
      y: g.y,
      deltaX: 0,
      deltaY: -240,
    });
    await sleep(60);
  }
  return cdp.evaluate(GEOM);
}
const settle = (sid) => driveTurn(evalAsync, sid, { timeoutMs: 150000, busyGraceMs: 3000 });

let sid = null;
try {
  // NO_NEW=1 continues in the active conversation (to split the phases over two runs).
  if (!process.env.NO_NEW) out.newSession = await newSession(cdp, evalAsync);

  if (PHASES.has('p0')) {
    const p = {};
    const s = await startThink('p0 自动跟随基线');
    sid = s.sid;
    p.samples = await sample(40, 300);
    p.maxHidden = Math.max(...p.samples.map((x) => x.hidden));
    p.overflowed = p.samples.some((x) => x.sh > x.ch);
    p.shot = await shot(cdp, 'r3-p0-plain-follow.png');
    p.settle = await settle(sid);
    out.phases.p0 = p;
    console.log(
      'p0',
      JSON.stringify({
        maxHidden: p.maxHidden,
        overflowed: p.overflowed,
        first: brief(p.samples.slice(0, 3)),
        last: brief(p.samples.slice(-3)),
      })
    );
  }

  if (PHASES.has('p1')) {
    const p = {};
    const s = await startThink('p1 思考块');
    sid = s.sid;
    await sleep(2500);
    p.pre = await cdp.evaluate(GEOM);
    p.shotBefore = await shot(cdp, 'r3-p1-thought-before.png');
    p.click = await cdp.evaluate(markAndClick('thought'));
    p.samples = await sample(40, 150);
    p.shotAfter = await shot(cdp, 'r3-p1-thought-after-6s.png');
    p.jumpClick = await cdp.evaluate(clickLabel('滚动到底部'));
    p.afterJump = await sample(12, 250);
    p.shotAfterJump = await shot(cdp, 'r3-p1-after-jump-button.png');
    p.settle = await settle(sid);
    out.phases.p1 = p;
    console.log(
      'p1',
      JSON.stringify(
        {
          pre: p.pre,
          click: p.click,
          samples: brief(p.samples),
          jump: p.jumpClick,
          afterJump: brief(p.afterJump),
        },
        null,
        1
      )
    );
  }

  if (PHASES.has('p2')) {
    const p = {};
    const s = await startThink('p2 工具行');
    sid = s.sid;
    await sleep(2500);
    p.pre = await cdp.evaluate(GEOM);
    p.click = await cdp.evaluate(markAndClick('tool'));
    p.samples = await sample(30, 150);
    p.shotAfter = await shot(cdp, 'r3-p2-tool-after-click.png');
    p.wheel = await wheelToBottom();
    p.afterWheel = await sample(12, 250);
    p.shotAfterWheel = await shot(cdp, 'r3-p2-after-wheel.png');
    p.settle = await settle(sid);
    out.phases.p2 = p;
    console.log(
      'p2',
      JSON.stringify(
        {
          pre: p.pre,
          click: p.click,
          samples: brief(p.samples),
          wheel: p.wheel,
          afterWheel: brief(p.afterWheel),
        },
        null,
        1
      )
    );
  }

  if (PHASES.has('p3')) {
    const p = {};
    const mark = gwMark();
    const te = await sendText(cdp, evalAsync, '⟦toolend⟧ R3-p3 toolend：已结束回合的过程区');
    p.toolend = await settle(te.sid);
    await sleep(1500);
    const s = await startThink('p3 已结束回合的过程区头部');
    sid = s.sid;
    await sleep(1200);
    p.pre = await cdp.evaluate(GEOM);
    p.shotBefore = await shot(cdp, 'r3-p3-head-before.png');
    p.click = await cdp.evaluate(markAndClick('head', 'R3-p3 toolend'));
    p.samples = await sample(40, 150);
    p.shotAfter = await shot(cdp, 'r3-p3-head-after-6s.png');
    p.jumpClick = await cdp.evaluate(clickLabel('滚动到底部'));
    p.afterJump = await sample(12, 250);
    p.settle = await settle(sid);
    p.gw = mark;
    out.phases.p3 = p;
    console.log(
      'p3',
      JSON.stringify(
        {
          pre: p.pre,
          click: p.click,
          samples: brief(p.samples),
          jump: p.jumpClick,
          afterJump: brief(p.afterJump),
        },
        null,
        1
      )
    );
  }

  if (PHASES.has('p4')) {
    const p = {};
    const s = await startThink('p4 底部收起');
    sid = s.sid;
    await sleep(2500);
    p.open = await cdp.evaluate(markAndClick('tool'));
    await sleep(400);
    p.jumpClick = await cdp.evaluate(clickLabel('滚动到底部'));
    if (!p.jumpClick.ok) p.wheel = await wheelToBottom();
    p.followingBeforeClose = await sample(6, 250);
    p.shotBeforeClose = await shot(cdp, 'r3-p4-before-close.png');
    p.close = await cdp.evaluate(CLICK_TARGET);
    p.afterClose = await sample(20, 250);
    p.shotAfterClose = await shot(cdp, 'r3-p4-after-close.png');
    p.settle = await settle(sid);
    out.phases.p4 = p;
    console.log(
      'p4',
      JSON.stringify(
        {
          open: p.open,
          jump: p.jumpClick,
          wheel: p.wheel,
          beforeClose: brief(p.followingBeforeClose),
          close: p.close,
          afterClose: brief(p.afterClose),
        },
        null,
        1
      )
    );
  }

  if (PHASES.has('p5')) {
    const p = {};
    p.scrolledUp = await wheelUp(900);
    await sleep(500);
    p.beforeSend = await cdp.evaluate(GEOM);
    const s = await startThink('p5 发送后跟随');
    sid = s.sid;
    p.samples = await sample(30, 300);
    p.shot = await shot(cdp, 'r3-p5-follow-after-send.png');
    p.stop = await cdp.evaluate(clickLabel('停止当前回合'));
    p.settle = await settle(sid);
    out.phases.p5 = p;
    console.log(
      'p5',
      JSON.stringify(
        {
          scrolledUp: p.scrolledUp,
          beforeSend: p.beforeSend,
          samples: brief(p.samples),
          stop: p.stop,
        },
        null,
        1
      )
    );
  }
  out.sid = sid;
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save(`r3-c3${process.env.PHASES ? `-${process.env.PHASES.replace(/,/g, '-')}` : ''}.json`, out);
  cdp.close();
}
