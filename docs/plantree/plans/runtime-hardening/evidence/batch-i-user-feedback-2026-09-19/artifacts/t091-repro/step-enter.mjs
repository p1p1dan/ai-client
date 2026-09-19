import {
  COMPOSER,
  connect,
  ENTER_MAIN_SURFACE,
  enterApp,
  INSTALL_SPY,
  SIDEBAR,
  STORE,
  save,
  shot,
  sleep,
} from './lib.mjs';

const { cdp, evalAsync } = await connect();
try {
  const entered = await enterApp(cdp, ENTER_MAIN_SURFACE);
  console.log('enterApp:', JSON.stringify(entered));

  // Keep closing whatever dialog layer is still up (migration / announcement).
  for (let i = 0; i < 12; i += 1) {
    const open = await cdp.evaluate(`document.querySelectorAll('[role="dialog"]').length`);
    if (!open) break;
    const hit = await cdp.evaluate(`(() => {
      const labels = ['知道了','我知道了','Got it','以后再说','稍后再说','Later','关闭','Close'];
      const b = [...document.querySelectorAll('button')].find(
        (n) => labels.includes((n.innerText || '').trim()) && n.offsetParent !== null
      );
      if (!b) return null;
      b.click();
      return (b.innerText || '').trim();
    })()`);
    console.log(`dialog pass ${i}: open=${open} clicked=${hit}`);
    await sleep(700);
  }

  console.log('spy:', await cdp.evaluate(INSTALL_SPY));

  // Baseline: record the preference values this probe is about to change, so
  // the closeout can put them back exactly.
  const before = await evalAsync(
    `const settings = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     return {
       chatAgentDefaults: JSON.parse(JSON.stringify(settings.useSettingsStore.getState().chatAgentDefaults ?? {})),
       defaultTier: localStorage.getItem('aiclient:chat:default-tier'),
       recentCollapsed: localStorage.getItem('aiclient:sidebar:recent-collapsed'),
       allSidebarKeys: Object.keys(localStorage).filter((k) => /sidebar|chat:/.test(k)),
     };`,
    { label: 'baseline prefs' }
  );
  console.log('baseline prefs:', JSON.stringify(before));
  save('00-baseline-prefs.json', before);

  // Pin the fake gateway for every new chat, and a tier that will not stop the
  // long turn on a permission card (the point-check needs `running`, not
  // `waiting_permission`).
  const pinned = await evalAsync(
    `const settings = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     settings.useSettingsStore.getState().setChatAgentDefaults({ model: 'probe-fake/fake-sonnet' });
     localStorage.setItem('aiclient:chat:default-tier', 'fullopen');
     return JSON.parse(JSON.stringify(settings.useSettingsStore.getState().chatAgentDefaults));`,
    { label: 'pin fake model' }
  );
  console.log('pinned:', JSON.stringify(pinned));

  save('00-store.json', await evalAsync(STORE, { label: 'store' }));
  save('00-sidebar.json', await cdp.evaluate(SIDEBAR));
  save('00-composer.json', await cdp.evaluate(COMPOSER));
  console.log('shot:', await shot(cdp, '00-entered.png'));
} finally {
  cdp.close();
}
