#!/usr/bin/env node
/**
 * t080-widen.mjs — main criterion: widen the gear while the approval card is up,
 * then confirm the card is released, the write really runs and the turn ends.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-field-fixes-2026-09-18/pointcheck/tools/bh-cdp.mjs';

const target = process.argv[2] ?? '全自动';
const cdp = await connect();
try {
  const before = await cdp.evaluate(`(() => ({
    cardWaiting: document.body.innerText.includes('等待审批'),
    menuOpen: document.querySelectorAll('[role="menuitemradio"]').length,
  }))()`);
  console.log('before:', JSON.stringify(before));
  if (!before.menuOpen) {
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /执行\\s*·/.test(b.textContent || ''));
      btn.click(); return 'reopened';
    })()`);
    await delay(1200);
  }

  const picked = await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('[role="menuitemradio"]')]
      .find(e => (e.textContent || '').startsWith(${JSON.stringify(target)}));
    if (!el) return 'not found';
    el.click();
    return (el.textContent || '').slice(0, 20);
  })()`);
  console.log('picked:', picked);
  await delay(1200);

  const panel = await cdp.evaluate(`(() => {
    const menus = [...document.querySelectorAll('[role="menu"]')];
    return menus.map(m => (m.innerText || '').replace(/\\n+/g, ' | ').slice(0, 300));
  })()`);
  console.log('confirm panel:', JSON.stringify(panel));

  const applied = await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('[role="menu"] button')].find(b => (b.textContent||'').trim() === '应用');
    if (!btn) return 'no 应用 button';
    btn.click();
    return 'applied';
  })()`);
  console.log('apply:', applied);

  for (let i = 0; i < 20; i++) {
    await delay(1500);
    const s = await cdp.evaluate(`(() => {
      const t = document.body.innerText;
      const trig = [...document.querySelectorAll('button')].find(b => /执行\\s*·/.test(b.textContent || ''));
      return {
        cardWaiting: t.includes('等待审批'),
        turnFinished: t.includes('turn finished'),
        trigger: trig ? trig.textContent.trim() : null,
        triggerClass: trig ? trig.className : null,
      };
    })()`);
    console.log(`t+${((i + 1) * 1.5).toFixed(1)}s`, JSON.stringify(s));
    if (!s.cardWaiting && s.turnFinished) break;
  }
} finally {
  cdp.close();
}
