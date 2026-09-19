/**
 * Get inside the app after a restart. Deliberately does NOT re-record the
 * baseline preferences (`pc-00-enter.mjs` does that once, at the very start):
 * running the baseline capture a second time would overwrite the original
 * values with the ones this point-check itself set, and the closeout would then
 * "restore" to the wrong state.
 */
import { connect, ENTER_MAIN_SURFACE, shot, sleep, stamp } from './lib.mjs';

const { cdp, evalAsync } = await connect();
try {
  console.log(`[${stamp()}] entry:`, JSON.stringify(await cdp.evaluate(ENTER_MAIN_SURFACE).catch((e) => `ERROR: ${e.message}`)));
  await cdp.waitFor(`document.querySelector('textarea') !== null`, { timeoutMs: 240_000, label: 'composer mounted' });
  await sleep(2000);
  for (let i = 0; i < 14; i += 1) {
    const open = await cdp.evaluate(`document.querySelectorAll('[role="dialog"]').length`);
    if (!open) break;
    await cdp.evaluate(`(() => {
      const labels = ['知道了','我知道了','Got it','以后再说','稍后再说','Later','关闭','Close'];
      const b = [...document.querySelectorAll('button')].find(
        (n) => labels.includes((n.innerText || '').trim()) && n.offsetParent !== null);
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(800);
  }
  const s = await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const settings = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     const st = chat.useChatSessionsStore.getState();
     return { sessions: st.sessions.length, active: st.activeSessionId,
              hostBound: [...st.hostBoundSessionIds],
              model: JSON.parse(JSON.stringify(settings.useSettingsStore.getState().chatAgentDefaults ?? {})),
              idleTimeout: settings.useSettingsStore.getState().providerIdleTimeoutMs,
              tier: localStorage.getItem('aiclient:chat:default-tier') };`,
    { label: 'state' }
  );
  console.log('state:', JSON.stringify(s));
  console.log('shot:', await shot(cdp, `enter-${Date.now()}.png`));
} finally {
  cdp.close();
}
