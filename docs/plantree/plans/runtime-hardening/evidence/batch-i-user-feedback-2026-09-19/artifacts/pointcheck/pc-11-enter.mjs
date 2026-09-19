/**
 * Addendum step 0 — get inside the app and clear the dialog stack.
 *
 * Unlike `pc-00-enter.mjs` this does NOT pin a fake model or touch any
 * setting: none of the three checks in this addendum sends a model request,
 * so leaving preferences untouched means there is nothing to restore.
 */
import { connect, ENTER_MAIN_SURFACE, save, shot, sleep, stamp } from './lib.mjs';

const { cdp } = await connect();
try {
  const entered = await cdp.evaluate(ENTER_MAIN_SURFACE).catch((e) => `ERROR: ${e.message}`);
  console.log(`[${stamp()}] welcome entry clicked:`, JSON.stringify(entered));
  await cdp.waitFor(`document.querySelector('textarea') !== null`, {
    timeoutMs: 240_000,
    label: 'composer mounted',
  });
  await sleep(1500);

  // Three dialog layers, each computed later than the last; poll until none.
  for (let i = 0; i < 14; i += 1) {
    const open = await cdp.evaluate(`document.querySelectorAll('[role="dialog"]').length`);
    if (!open) break;
    const hit = await cdp.evaluate(`(() => {
      const labels = ['知道了','我知道了','Got it','以后再说','稍后再说','Later','关闭','Close'];
      const b = [...document.querySelectorAll('button')].find(
        (n) => labels.includes((n.innerText || '').trim()) && n.offsetParent !== null);
      if (!b) return null;
      b.click();
      return (b.innerText || '').trim();
    })()`);
    console.log(`dialog pass ${i}: open=${open} clicked=${hit}`);
    await sleep(800);
  }

  const rail = await cdp.evaluate(`(() => {
    const nav = document.querySelector('nav[aria-label="主导航"]');
    if (!nav) return { ok: false, why: 'no nav' };
    return {
      ok: true,
      buttons: [...nav.querySelectorAll('button[aria-label]')].map((b) => ({
        label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'),
      })),
    };
  })()`);
  console.log('rail:', JSON.stringify(rail));
  save('10-00-rail.json', rail);
  console.log('shot:', await shot(cdp, '10-entered.png'));
} finally {
  cdp.close();
}
