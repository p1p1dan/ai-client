/**
 * T098 (a streaming thought can be folded) + T096 (its fold header sticks to
 * the top while you read, and collapsing puts you back where the block starts).
 *
 * Two turns on one session, because the two claims need opposite treatment:
 *   turn 1 is never touched  → decision 021: an untouched thought auto-folds
 *                              once the turn settles
 *   turn 2 is driven         → chevron, fold, unfold, scroll, sticky, re-fold
 */
import {
  CLICK_NEW,
  CLICK_SEND,
  CLICK_THOUGHT_TRIGGER,
  connect,
  save,
  scrollTranscript,
  sessionStatus,
  shot,
  sleep,
  stamp,
  THOUGHT_STATE,
  typeInto,
} from './lib.mjs';

const { cdp, evalAsync } = await connect();

async function sendAndWaitStreaming(sid, text) {
  console.log('typed:', await cdp.evaluate(typeInto(text)));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 20_000, label: 'send enabled' }
  );
  console.log(`[${stamp()}] send:`, JSON.stringify(await cdp.evaluate(CLICK_SEND)));
  // Wait until a thought row is actually on screen.
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    const s = await cdp.evaluate(THOUGHT_STATE);
    if (s.found) return s;
  }
  throw new Error('thought row never appeared');
}

/**
 * A settled turn folds its whole process into ONE work group whose `<details>`
 * starts closed, so the thought row is not in the layout at all until that
 * group is opened. Reading the fold state without doing this reports "no
 * thought row" for a turn that has one.
 */
const EXPAND_WORK_GROUPS = `(() => {
  const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
    .filter((v) => v.offsetParent !== null);
  let vp = null, w = -1;
  for (const v of vps) { const x = v.getBoundingClientRect().width; if (x > w) { w = x; vp = v; } }
  if (!vp) return { opened: [] };
  const opened = [];
  for (const s of [...vp.querySelectorAll('details > summary')].filter((n) => n.offsetParent !== null)) {
    if (!s.parentElement.open) { s.click(); opened.push((s.innerText || '').trim().replace(/\\s+/g, ' ')); }
  }
  return { opened };
})()`;

async function waitSettled(sid, maxMs = 120_000) {
  const deadline = Date.now() + maxMs;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(2500);
    last = await evalAsync(sessionStatus(sid), { label: 'poll' });
    if (last.status === 'idle') return last;
  }
  return last;
}

try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__pci_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );
  await cdp.evaluate(CLICK_NEW);
  await sleep(2000);
  const sid = await evalAsync(`return window.__pci_store.getState().activeSessionId;`, {
    label: 'sid',
  });
  console.log(`[${stamp()}] session ${sid}`);

  // ---- turn 1: never touched -----------------------------------------------
  const first = await sendAndWaitStreaming(sid, 'T098-1：请先长时间思考（点验用，不点它）');
  console.log('turn1 streaming thought:', JSON.stringify({
    triggerText: first.triggerText, tag: first.triggerTag, chevron: first.hasChevron,
    ariaExpanded: first.ariaExpanded, dataState: first.dataState, paragraphs: first.body.paragraphs,
  }));
  save('04-00-turn1-streaming.json', first);
  console.log('shot:', await shot(cdp, '04-a-turn1-streaming.png'));

  const settled1 = await waitSettled(sid);
  console.log('turn1 settled:', JSON.stringify(settled1));
  await sleep(2000);
  const collapsedView = await cdp.evaluate(THOUGHT_STATE);
  console.log('turn1 with work group still folded, thought row found =', collapsedView.found);
  console.log('work groups opened:', JSON.stringify(await cdp.evaluate(EXPAND_WORK_GROUPS)));
  await sleep(1200);
  const afterSettle = await cdp.evaluate(THOUGHT_STATE);
  console.log('turn1 after settle:', JSON.stringify({
    found: afterSettle.found, triggerText: afterSettle.triggerText,
    ariaExpanded: afterSettle.ariaExpanded, dataState: afterSettle.dataState,
    paragraphs: afterSettle.body ? afterSettle.body.paragraphs : null,
    chars: afterSettle.body ? afterSettle.body.chars : null,
  }));
  save('04-01-turn1-settled.json', afterSettle);
  console.log('shot:', await shot(cdp, '04-b-turn1-settled.png'));

  // ---- turn 2: driven -------------------------------------------------------
  const second = await sendAndWaitStreaming(sid, 'T098-2：再思考一次（这一次要点开、滚动、收起）');
  await sleep(4000); // let the body grow past the viewport
  const s0 = await cdp.evaluate(THOUGHT_STATE);
  console.log('turn2 streaming:', JSON.stringify({
    trigger: s0.triggerText, chevron: s0.hasChevron, tag: s0.triggerTag,
    ariaExpanded: s0.ariaExpanded, dataState: s0.dataState,
    paragraphs: s0.body.paragraphs, chars: s0.body.chars,
  }));
  save('04-02-turn2-streaming.json', s0);

  // fold it
  const fold = await cdp.evaluate(CLICK_THOUGHT_TRIGGER);
  console.log('fold click:', JSON.stringify(fold));
  await sleep(1200);
  const folded = await cdp.evaluate(THOUGHT_STATE);
  console.log('after fold:', JSON.stringify({
    trigger: folded.triggerText, ariaExpanded: folded.ariaExpanded, dataState: folded.dataState,
    paragraphs: folded.body.paragraphs, chars: folded.body.chars,
  }));
  save('04-03-turn2-folded.json', folded);
  console.log('shot:', await shot(cdp, '04-c-turn2-folded.png'));

  // unfold it again
  console.log('unfold click:', JSON.stringify(await cdp.evaluate(CLICK_THOUGHT_TRIGGER)));
  await sleep(1500);
  const unfolded = await cdp.evaluate(THOUGHT_STATE);
  console.log('after unfold:', JSON.stringify({
    trigger: unfolded.triggerText, ariaExpanded: unfolded.ariaExpanded,
    paragraphs: unfolded.body.paragraphs, chars: unfolded.body.chars,
  }));
  save('04-04-turn2-unfolded.json', unfolded);
  console.log('shot:', await shot(cdp, '04-d-turn2-unfolded.png'));

  // ---- T096: scroll into the middle of the thought and watch the header -----
  const scrollSeries = [];
  const naturalTop = unfolded.triggerTop - unfolded.viewportTop;
  console.log(`natural offset of trigger from viewport top: ${naturalTop}px  scrollTop=${unfolded.scrollTop}`);
  for (let i = 0; i < 6; i += 1) {
    const moved = await cdp.evaluate(scrollTranscript(220));
    await sleep(700);
    const st = await cdp.evaluate(THOUGHT_STATE);
    scrollSeries.push({ moved, offsetFromViewportTop: st.offsetFromViewportTop,
      triggerTop: st.triggerTop, viewportTop: st.viewportTop, scrollTop: st.scrollTop,
      position: st.triggerPosition, background: st.triggerBackground, sticky: st.stickyAncestor });
    console.log(
      `  scroll#${i} scrollTop=${st.scrollTop} triggerTop=${Math.round(st.triggerTop)}` +
        ` offsetFromVpTop=${Math.round(st.offsetFromViewportTop)} pos=${st.triggerPosition}` +
        ` bg=${st.triggerBackground} stickyAncestor=${JSON.stringify(st.stickyAncestor)}`
    );
  }
  save('04-05-scroll-series.json', scrollSeries);
  console.log('shot (pinned):', await shot(cdp, '04-e-sticky-pinned.png'));

  const beforeRefold = await cdp.evaluate(THOUGHT_STATE);
  const refold = await cdp.evaluate(CLICK_THOUGHT_TRIGGER);
  console.log('re-fold click:', JSON.stringify(refold));
  await sleep(1500);
  const afterRefold = await cdp.evaluate(THOUGHT_STATE);
  console.log(
    `re-fold: scrollTop ${beforeRefold.scrollTop} -> ${afterRefold.scrollTop}` +
      ` triggerTop ${Math.round(beforeRefold.triggerTop)} -> ${Math.round(afterRefold.triggerTop)}` +
      ` offsetFromVpTop ${Math.round(afterRefold.offsetFromViewportTop)}` +
      ` paragraphs ${beforeRefold.body.paragraphs} -> ${afterRefold.body.paragraphs}`
  );
  save('04-06-refold.json', { beforeRefold, refold, afterRefold });
  console.log('shot:', await shot(cdp, '04-f-after-refold.png'));

  const settled2 = await waitSettled(sid);
  console.log('turn2 settled:', JSON.stringify(settled2));
  await sleep(2000);
  console.log('work groups opened:', JSON.stringify(await cdp.evaluate(EXPAND_WORK_GROUPS)));
  await sleep(1200);
  const final = await cdp.evaluate(THOUGHT_STATE);
  save('04-07-turn2-settled.json', final);
  console.log('turn2 after settle:', JSON.stringify({
    found: final.found, trigger: final.triggerText, ariaExpanded: final.ariaExpanded,
    paragraphs: final.body ? final.body.paragraphs : null,
    chars: final.body ? final.body.chars : null,
  }));
  console.log('shot:', await shot(cdp, '04-g-turn2-settled.png'));
  console.log('SID', sid);
} finally {
  cdp.close();
}
