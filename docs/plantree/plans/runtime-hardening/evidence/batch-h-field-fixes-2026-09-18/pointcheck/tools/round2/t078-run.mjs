#!/usr/bin/env node
/**
 * t078-run.mjs — T078 / Q022: with the gear on `bypass`, does a destructive bash
 * command run with no approval card?
 *
 * Every path the command touches is under /tmp/bh-rm-sandbox, created by the
 * point-check and holding nothing else. `a.txt` is never named by the command and
 * is the control.
 *
 * Step 1 sends a harmless first message purely so a session exists — `bypass` is
 * not offered on the start screen. Step 2 flips the gear (through its confirmation
 * panel). Step 3 sends the message that draws the `rm`, and polls at 500 ms for the
 * whole turn so an approval card could not appear and vanish unseen.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-field-fixes-2026-09-18/pointcheck/tools/bh-cdp.mjs';

const cdp = await connect();
const send = async (text) => {
  const typed = await cdp.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'no textarea';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value;
  })()`);
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeout: 15000, label: 'send enabled' }
  );
  await cdp.evaluate(
    `(() => { document.querySelector('[aria-label="发送消息"]').click(); return 'sent'; })()`
  );
  return typed;
};

try {
  await cdp.evaluate(`(() => { document.body.click(); return 'closed'; })()`);
  await delay(400);
  console.log(
    'new chat:',
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '新建');
      if (!btn) return 'no 新建';
      btn.click(); return 'clicked';
    })()`)
  );
  await delay(2500);

  console.log('step1 typed:', await send('先打个招呼'));
  await cdp.waitFor(`(() => document.body.innerText.includes('ready'))()`, {
    timeout: 60000,
    interval: 700,
    label: 'first reply',
  });
  console.log('step1 replied');
  await delay(2000);

  // Flip the gear to bypass.
  await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /执行\\s*·/.test(b.textContent || ''));
    btn.click(); return 'opened';
  })()`);
  await delay(1000);
  const before = await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('[role="menuitemradio"]')].find(e => (e.textContent||'').startsWith('完全放行'));
    return el ? { text: (el.textContent||'').slice(0,12), ariaDisabled: el.getAttribute('aria-disabled'), dataDisabled: el.getAttribute('data-disabled') } : 'not found';
  })()`);
  console.log('bypass option:', JSON.stringify(before));
  await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('[role="menuitemradio"]')].find(e => (e.textContent||'').startsWith('完全放行'));
    el.click(); return 'picked';
  })()`);
  await delay(1000);
  console.log(
    'confirm panel:',
    await cdp.evaluate(
      `(() => [...document.querySelectorAll('[role="menu"]')].map(m => (m.innerText||'').replace(/\\n+/g,' | ').slice(0,260)))()`
    )
  );
  await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('[role="menu"] button')].find(b => (b.textContent||'').trim() === '应用');
    btn.click(); return 'applied';
  })()`);
  await delay(2000);
  console.log(
    'trigger now:',
    await cdp.evaluate(
      `(() => { const b=[...document.querySelectorAll('button')].find(b => /执行\\s*·/.test(b.textContent || '')); return { text: b.textContent.trim(), destructive: /destructive/.test(b.className) }; })()`
    )
  );

  // Step 3 — the rm turn, watched at 500 ms.
  console.log('step3 typed:', await send('请删掉 /tmp/bh-rm-sandbox 下的 sub 目录和 b.txt'));
  const t0 = Date.now();
  let sawCard = false;
  let finished = false;
  const samples = [];
  while (Date.now() - t0 < 70000) {
    const s = await cdp.evaluate(`(() => {
      const t = document.body.innerText;
      return { card: t.includes('等待审批') || t.includes('权限') && t.includes('直接允许'), finished: t.includes('turn finished'), rm: t.includes('rm -rf') };
    })()`);
    if (s.card) sawCard = true;
    samples.push(
      `${((Date.now() - t0) / 1000).toFixed(1)}s card=${s.card} rm=${s.rm} fin=${s.finished}`
    );
    if (s.finished) {
      finished = true;
      break;
    }
    await delay(500);
  }
  console.log('samples:', samples.length, 'sawApprovalCard =', sawCard, 'finished =', finished);
  console.log(samples.slice(0, 6).join('\n'));
  console.log('...');
  console.log(samples.slice(-4).join('\n'));

  const tail = await cdp.evaluate(`(() => document.body.innerText.slice(-1400))()`);
  console.log('----- transcript tail -----');
  console.log(tail);
} finally {
  cdp.close();
}
