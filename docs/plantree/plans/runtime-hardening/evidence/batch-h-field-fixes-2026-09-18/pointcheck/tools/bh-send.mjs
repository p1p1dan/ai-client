#!/usr/bin/env node
/**
 * bh-send.mjs — type a message into the composer and press send, the way a user does.
 *
 * Deliberately NOT `store.sendMessage(...)`: the point of a GUI point-check is that the
 * composer's own wiring (model pin, permission gear, attachment guards) is on the path.
 * React listens for input events dispatched after the NATIVE value setter, so setting
 * `textarea.value` directly would leave React's state at the old value and send nothing.
 *
 * Usage: node bh-send.mjs '<message text>'   (BH_PORT selects the CDP port, default 9222)
 */
import { connect } from './bh-cdp.mjs';

const text = process.argv[2];
if (!text) {
  console.error("usage: node bh-send.mjs '<message text>'");
  process.exit(2);
}

const cdp = await connect();
try {
  const typed = await cdp.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'no textarea';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value;
  })()`);
  console.log(`typed: ${typed}`);
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeout: 10000, label: 'send button enabled' }
  );
  const sent = await cdp.evaluate(`(() => {
    const b = document.querySelector('[aria-label="发送消息"]');
    if (!b) return 'no send button';
    b.click();
    return 'clicked';
  })()`);
  console.log(`send: ${sent}`);
} finally {
  cdp.close();
}
