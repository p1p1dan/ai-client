/** Step 0 — get inside the app, clear the dialog stack, pin the fake model. */
import { COMPOSER, connect, ENTER_MAIN_SURFACE, save, shot, SIDEBAR, sleep, stamp, STORE } from './lib.mjs';

const { cdp, evalAsync } = await connect();
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

  const before = await evalAsync(
    `const settings = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     const s = settings.useSettingsStore.getState();
     return {
       chatAgentDefaults: JSON.parse(JSON.stringify(s.chatAgentDefaults ?? {})),
       providerIdleTimeoutMs: s.providerIdleTimeoutMs,
       defaultTier: localStorage.getItem('aiclient:chat:default-tier'),
     };`,
    { label: 'baseline prefs' }
  );
  console.log('baseline prefs:', JSON.stringify(before));
  save('00-baseline-prefs.json', before);

  const pinned = await evalAsync(
    `const settings = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     settings.useSettingsStore.getState().setChatAgentDefaults({ model: 'probe-fake/fake-sonnet' });
     localStorage.setItem('aiclient:chat:default-tier', 'fullopen');
     return JSON.parse(JSON.stringify(settings.useSettingsStore.getState().chatAgentDefaults));`,
    { label: 'pin fake model' }
  );
  console.log('pinned:', JSON.stringify(pinned));

  const store = await evalAsync(STORE, { label: 'store' });
  console.log(
    `active=${store.activeSessionId} sessions=${store.sessionCount} hostBound=${JSON.stringify(store.hostBoundSessionIds)}`
  );
  save('00-store.json', store);
  save('00-sidebar.json', await cdp.evaluate(SIDEBAR));
  save('00-composer.json', await cdp.evaluate(COMPOSER));
  console.log('shot:', await shot(cdp, '00-entered.png'));
} finally {
  cdp.close();
}
