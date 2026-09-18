#!/usr/bin/env node
/**
 * t080-run.mjs — T080 sub-criterion re-check, in ONE window.
 *
 * The first attempt read the menu after the card had already auto-rejected, so
 * the menu was legitimately unlocked and the reading proved nothing. Here the
 * card's presence and the menu's DOM state are captured in the SAME evaluate,
 * so the snapshot cannot straddle the end of the turn.
 *
 * Steps: new chat -> send -> wait for approval card -> open menu -> dump.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-field-fixes-2026-09-18/pointcheck/tools/bh-cdp.mjs';

const cdp = await connect();
const MSG = '请写一个文件 probe-write.txt';

try {
  // Close anything already open.
  await cdp.evaluate(`(() => { document.body.click(); return 'closed'; })()`);
  await delay(400);

  // New chat.
  const fresh = await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '新建');
    if (!btn) return 'no 新建 button';
    btn.click();
    return 'clicked 新建';
  })()`);
  console.log('new chat:', fresh);
  await delay(2500);

  // Type + send, the way bh-send.mjs does (native setter so React sees it).
  const typed = await cdp.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'no textarea';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(MSG)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value;
  })()`);
  console.log('typed:', typed);
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeout: 15000, label: 'send enabled' }
  );
  await cdp.evaluate(
    `(() => { document.querySelector('[aria-label="发送消息"]').click(); return 'sent'; })()`
  );
  const sentAt = Date.now();
  console.log('sent at', new Date(sentAt).toISOString());

  // Wait for the approval card.
  await cdp.waitFor(`(() => document.body.innerText.includes('等待审批'))()`, {
    timeout: 90000,
    interval: 700,
    label: 'approval card',
  });
  console.log(`card up after ${((Date.now() - sentAt) / 1000).toFixed(1)}s`);

  // Open the menu. element.click() is the only opener that works here —
  // Input.dispatchMouseEvent (with or without pointerType) does not.
  const opened = await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /执行\\s*·/.test(b.textContent || ''));
    if (!btn) return 'no trigger';
    btn.click();
    return btn.textContent.trim();
  })()`);
  console.log('trigger clicked:', opened);
  await delay(1200);

  // ONE snapshot: card state + menu DOM + footer.
  const snap = await cdp.evaluate(`(() => {
    const body = document.body.innerText;
    const items = [...document.querySelectorAll('[role="menuitemradio"]')];
    const menus = [...document.querySelectorAll('[role="menu"]')];
    const footers = menus.flatMap(m => [...m.children]).filter(el => el.getAttribute('role') === null && !el.querySelector('[role="menuitemradio"]'));
    return {
      at: new Date().toISOString(),
      cardWaiting: body.includes('等待审批'),
      cardCountdown: (body.match(/若\\s*(\\d+)\\s*秒内未响应/) || [])[1] ?? null,
      turnFinished: body.includes('turn finished'),
      itemCount: items.length,
      items: items.map((el) => ({
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 34),
        ariaDisabled: el.getAttribute('aria-disabled'),
        dataDisabled: el.getAttribute('data-disabled'),
        ariaChecked: el.getAttribute('aria-checked'),
        tabIndex: el.getAttribute('tabindex'),
        pointerEvents: getComputedStyle(el).pointerEvents,
        opacity: getComputedStyle(el).opacity,
      })),
      footerText: footers.map(el => (el.innerText || '').trim()).filter(Boolean),
      menuTail: menus.map(m => (m.innerText || '').split('\\n').filter(Boolean).slice(-1)[0]),
    };
  })()`);
  console.log(JSON.stringify(snap, null, 2));
} finally {
  cdp.close();
}
