#!/usr/bin/env node
/**
 * t080-menu.mjs — open the composer permission trigger and dump the REAL DOM
 * state of every option in it, plus the footer note.
 *
 * Reads attributes rather than looking at a screenshot: the T080 sub-criterion is
 * literally "the two mode options are disabled", and a greyed-out look can come
 * from styling alone.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-field-fixes-2026-09-18/pointcheck/tools/bh-cdp.mjs';

const cdp = await connect();
const clickAt = async (box) => {
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
};

try {
  const already = await cdp.evaluate(
    `(() => document.querySelectorAll('[role="menu"],[role="menuitemradio"]').length)()`
  );
  if (!already) {
    const box = await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /执行\\s*·/.test(b.textContent || ''));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), text: btn.textContent.trim() };
    })()`);
    if (!box) throw new Error('permission trigger not found');
    console.log('trigger:', JSON.stringify(box));
    await clickAt(box);
    await delay(1200);
  }

  const dump = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"],[role="option"]')];
    const menus = [...document.querySelectorAll('[role="menu"]')];
    return {
      itemCount: items.length,
      items: items.map((el) => ({
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        role: el.getAttribute('role'),
        tag: el.tagName,
        ariaDisabled: el.getAttribute('aria-disabled'),
        disabledAttr: el.hasAttribute('disabled') ? el.getAttribute('disabled') : null,
        domDisabled: 'disabled' in el ? el.disabled : null,
        ariaChecked: el.getAttribute('aria-checked'),
        dataDisabled: el.getAttribute('data-disabled'),
        pointerEvents: getComputedStyle(el).pointerEvents,
        opacity: getComputedStyle(el).opacity,
      })),
      menuText: menus.map((m) => (m.innerText || '').replace(/\\n+/g, ' | ').slice(0, 600)),
    };
  })()`);
  console.log(JSON.stringify(dump, null, 2));
} finally {
  cdp.close();
}
