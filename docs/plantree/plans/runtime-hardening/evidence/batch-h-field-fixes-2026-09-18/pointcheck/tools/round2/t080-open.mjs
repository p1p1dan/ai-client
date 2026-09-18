#!/usr/bin/env node
/**
 * t080-open.mjs — try, in order, the ways of opening the composer permission menu,
 * reporting which one actually mounted the popup. Base UI opens menus on
 * pointerdown, so a bare Input.dispatchMouseEvent without pointerType, or an
 * element.click() (which dispatches no pointer events at all), can both miss.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-field-fixes-2026-09-18/pointcheck/tools/bh-cdp.mjs';

const cdp = await connect();
const count = () =>
  cdp.evaluate(`(() => document.querySelectorAll('[role="menuitemradio"]').length)()`);

const box = await cdp.evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => /执行\\s*·/.test(b.textContent || ''));
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), text: btn.textContent.trim(), disabled: btn.disabled };
})()`);
console.log('trigger:', JSON.stringify(box));
if (!box) process.exit(3);

const attempts = {
  async mouseWithPointerType() {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: box.x,
        y: box.y,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: type === 'mouseMoved' ? 0 : 1,
        pointerType: 'mouse',
      });
      await delay(80);
    }
  },
  async domClick() {
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /执行\\s*·/.test(b.textContent || ''));
      btn.click();
      return 'clicked';
    })()`);
  },
  async keyboard() {
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /执行\\s*·/.test(b.textContent || ''));
      btn.focus();
      return document.activeElement === btn;
    })()`);
    for (const type of ['keyDown', 'char', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: type === 'char' ? '\r' : undefined,
      });
      await delay(60);
    }
  },
  async syntheticPointer() {
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /执行\\s*·/.test(b.textContent || ''));
      const r = btn.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 };
      btn.dispatchEvent(new PointerEvent('pointerdown', opts));
      btn.dispatchEvent(new MouseEvent('mousedown', opts));
      btn.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
      btn.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
      btn.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
      return 'dispatched';
    })()`);
  },
};

for (const [name, fn] of Object.entries(attempts)) {
  if ((await count()) > 0) {
    console.log(`already open before ${name}`);
    break;
  }
  await fn();
  await delay(1000);
  const n = await count();
  console.log(`${name}: menuitemradio count = ${n}`);
  if (n > 0) break;
}
cdp.close();
