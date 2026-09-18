#!/usr/bin/env node
/**
 * click.mjs — real CDP mouse click at the centre of the first element matching a
 * text/selector probe. Used when React's handler ignores a synthetic .click().
 *
 * Usage: node click.mjs '<js expression returning an Element>'
 */
import { connect } from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-field-fixes-2026-09-18/pointcheck/tools/bh-cdp.mjs';

const expr = process.argv[2];
if (!expr) {
  console.error("usage: node click.mjs '<expression returning an Element>'");
  process.exit(2);
}
const cdp = await connect();
try {
  const box = await cdp.evaluate(`(() => {
    const el = (${expr});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (el.textContent||'').trim().slice(0,60) };
  })()`);
  if (!box) {
    console.log('no element');
    process.exit(3);
  }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  }
  console.log(`clicked (${box.x},${box.y}) "${box.text}"`);
} finally {
  cdp.close();
}
