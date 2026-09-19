/**
 * T096, take 2 — the sticky fold header, measured on the RIGHT row.
 *
 * The first run measured a COLLAPSED thought: with two thoughts in the
 * transcript, "the first trigger that matches 思考" is turn 1's, and a folded
 * block has no body for its header to stick over, so the header scrolled away
 * exactly as it should and the numbers read like a failure.
 *
 * This probe therefore: picks a thought row by index, makes sure it is OPEN,
 * scrolls until the row's own body spans the viewport, and only then asks where
 * the header is. It also reads `top`/`z-index`/`background` off the computed
 * style, since "sticky but transparent" is the specific failure decision 028 is
 * written against.
 */
import { connect, save, shot, sleep } from './lib.mjs';

const { cdp } = await connect();
const VP = `(() => {
  const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
    .filter((v) => v.offsetParent !== null);
  let best = null, w = -1;
  for (const v of vps) { const x = v.getBoundingClientRect().width; if (x > w) { w = x; best = v; } }
  return best;
})()`;

/** Every thought trigger in document order, with enough to identify one. */
const TRIGGERS = `(() => {
  const vp = ${VP};
  if (!vp) return [];
  return [...vp.querySelectorAll('button')]
    .filter((b) => b.offsetParent !== null && /^(思考中|已思考|思考)/.test((b.innerText || '').trim()))
    .map((b, i) => ({ i, text: (b.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
                      ariaExpanded: b.getAttribute('aria-expanded'),
                      top: b.getBoundingClientRect().top }));
})()`;

const stateOf = (index) => `(() => {
  const vp = ${VP};
  const triggers = [...vp.querySelectorAll('button')]
    .filter((b) => b.offsetParent !== null && /^(思考中|已思考|思考)/.test((b.innerText || '').trim()));
  const t = triggers[${index}];
  if (!t) return { found: false, count: triggers.length };
  const cs = getComputedStyle(t);
  const r = t.getBoundingClientRect();
  const vr = vp.getBoundingClientRect();
  // The block's body: the collapsible panel that follows the trigger.
  const panel = t.parentElement?.querySelector('[data-slot="collapsible-panel"]')
    ?? t.nextElementSibling
    ?? t.parentElement?.nextElementSibling;
  const pr = panel ? panel.getBoundingClientRect() : null;
  return {
    found: true, count: triggers.length,
    text: (t.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
    ariaExpanded: t.getAttribute('aria-expanded'),
    position: cs.position, cssTop: cs.top, zIndex: cs.zIndex,
    background: cs.backgroundColor, height: r.height,
    triggerTop: r.top, triggerBottom: r.bottom,
    viewportTop: vr.top, viewportBottom: vr.bottom,
    offsetFromViewportTop: r.top - vr.top,
    panel: pr ? { top: pr.top, bottom: pr.bottom, height: pr.height,
                  tag: panel.tagName, slot: panel.getAttribute('data-slot') } : null,
    scrollTop: vp.scrollTop, scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight,
  };
})()`;

const clickTrigger = (index) => `(() => {
  const vp = ${VP};
  const triggers = [...vp.querySelectorAll('button')]
    .filter((b) => b.offsetParent !== null && /^(思考中|已思考|思考)/.test((b.innerText || '').trim()));
  const t = triggers[${index}];
  if (!t) return { ok: false };
  const before = { scrollTop: vp.scrollTop, triggerTop: t.getBoundingClientRect().top,
                   ariaExpanded: t.getAttribute('aria-expanded') };
  t.click();
  return { ok: true, before, at: new Date().toISOString() };
})()`;

const scrollTo = (top) => `(() => {
  const vp = ${VP};
  vp.scrollTop = ${top};
  return { scrollTop: vp.scrollTop, max: vp.scrollHeight - vp.clientHeight };
})()`;

try {
  console.log('opened work groups:', JSON.stringify(await cdp.evaluate(`(() => {
    const vp = ${VP};
    const opened = [];
    for (const s of [...vp.querySelectorAll('details > summary')].filter((n) => n.offsetParent !== null)) {
      if (!s.parentElement.open) { s.click(); opened.push((s.innerText || '').trim().replace(/\\s+/g, ' ')); }
    }
    return opened;
  })()`)));
  await sleep(1200);

  const triggers = await cdp.evaluate(TRIGGERS);
  console.log('thought triggers:', JSON.stringify(triggers));
  save('04b-00-triggers.json', triggers);
  const index = triggers.length - 1; // the newest thought
  if (index < 0) throw new Error('no thought triggers on screen');

  let st = await cdp.evaluate(stateOf(index));
  console.log(`target #${index}:`, JSON.stringify({ text: st.text, expanded: st.ariaExpanded, panel: st.panel }));
  if (st.ariaExpanded !== 'true') {
    console.log('expanding:', JSON.stringify(await cdp.evaluate(clickTrigger(index))));
    await sleep(1200);
    st = await cdp.evaluate(stateOf(index));
  }
  console.log('expanded state:', JSON.stringify({
    expanded: st.ariaExpanded, position: st.position, cssTop: st.cssTop, zIndex: st.zIndex,
    background: st.background, panelHeight: st.panel?.height, clientHeight: st.clientHeight,
  }));
  save('04b-01-expanded.json', st);
  const naturalScrollTop = st.scrollTop;
  const naturalOffset = st.offsetFromViewportTop;
  console.log(`natural: scrollTop=${naturalScrollTop} offsetFromVpTop=${Math.round(naturalOffset)}`);

  // Scroll so the block's BODY spans the viewport: put the panel's midpoint in
  // the middle of the visible area.
  const series = [];
  const steps = [0.15, 0.3, 0.5, 0.7];
  for (const frac of steps) {
    const target = Math.round(naturalScrollTop + (st.panel?.height ?? 1000) * frac);
    await cdp.evaluate(scrollTo(target));
    await sleep(700);
    const s = await cdp.evaluate(stateOf(index));
    series.push({ frac, requested: target, ...s });
    console.log(
      `  frac=${frac} scrollTop=${s.scrollTop} triggerTop=${Math.round(s.triggerTop)}` +
        ` vpTop=${Math.round(s.viewportTop)} offsetFromVpTop=${Math.round(s.offsetFromViewportTop)}` +
        ` pos=${s.position} cssTop=${s.cssTop} z=${s.zIndex} bg=${s.background} h=${Math.round(s.height)}`
    );
  }
  save('04b-02-scroll-series.json', series);
  console.log('shot (pinned):', await shot(cdp, '04b-a-sticky-pinned.png'));

  // Zoomed screenshot of just the header band, so "是否有正文透出" is visible.
  const band = series[series.length - 1];
  const clip = {
    x: 0, y: Math.max(0, Math.round(band.viewportTop)),
    width: 1244, height: Math.min(140, Math.round(band.viewportBottom - band.viewportTop)),
    scale: 2,
  };
  const png = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
  const fsmod = await import('node:fs');
  const file = `${(await import('node:path')).dirname(new URL(import.meta.url).pathname)}/shots/04b-b-sticky-band.png`;
  fsmod.writeFileSync(file, Buffer.from(png.data, 'base64'));
  console.log('shot (band, 2x):', file);

  // Collapse from the pinned position: the scroll must land back near the
  // block's own start, not leave the reader thousands of pixels down.
  const beforeCollapse = await cdp.evaluate(stateOf(index));
  const collapse = await cdp.evaluate(clickTrigger(index));
  console.log('collapse click:', JSON.stringify(collapse));
  await sleep(1500);
  const afterCollapse = await cdp.evaluate(stateOf(index));
  console.log(
    `collapse: scrollTop ${beforeCollapse.scrollTop} -> ${afterCollapse.scrollTop}` +
      ` (natural was ${naturalScrollTop});` +
      ` triggerTop ${Math.round(beforeCollapse.triggerTop)} -> ${Math.round(afterCollapse.triggerTop)}` +
      ` offsetFromVpTop ${Math.round(afterCollapse.offsetFromViewportTop)}` +
      ` expanded ${beforeCollapse.ariaExpanded} -> ${afterCollapse.ariaExpanded}`
  );
  save('04b-03-collapse.json', { naturalScrollTop, naturalOffset, beforeCollapse, collapse, afterCollapse });
  console.log('shot:', await shot(cdp, '04b-c-after-collapse.png'));
} finally {
  cdp.close();
}
