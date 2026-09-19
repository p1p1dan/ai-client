/**
 * Closeout — put every preference this point-check changed back, and list the
 * conversations it created so the next agent can clean them up knowingly.
 *
 * The tier lives in the RENDERER's localStorage, not in settings.json, so it
 * can only be restored with the app running — which is why this is a probe and
 * not a file edit.
 */
import fs from 'node:fs';
import { connect, ENTER_MAIN_SURFACE, save, shot, sleep, stamp } from './lib.mjs';

const baseline = JSON.parse(fs.readFileSync(new URL('./data/00-baseline-prefs.json', import.meta.url), 'utf8'));
console.log('baseline to restore:', JSON.stringify(baseline));

const { cdp, evalAsync } = await connect();
try {
  console.log(`[${stamp()}] entry:`, JSON.stringify(await cdp.evaluate(ENTER_MAIN_SURFACE).catch((e) => `ERROR: ${e.message}`)));
  await cdp.waitFor(`document.querySelector('textarea') !== null`, { timeoutMs: 240_000, label: 'composer mounted' });
  await sleep(2000);
  for (let i = 0; i < 12; i += 1) {
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
  // Put the chat rail back where it was, so the next run sees the conversation list.
  console.log('rail -> 聊天:', await cdp.evaluate(`(() => {
    const b = document.querySelector('nav[aria-label="主导航"] button[aria-label="聊天"]');
    if (!b) return 'no button';
    if (b.getAttribute('aria-pressed') === 'true') return 'already';
    b.click();
    return 'clicked';
  })()`));
  await sleep(2500);

  const restored = await evalAsync(
    `const settings = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     const s = settings.useSettingsStore.getState();
     s.setChatAgentDefaults(${JSON.stringify(baseline.chatAgentDefaults)});
     s.setProviderIdleTimeoutMs(${JSON.stringify(baseline.providerIdleTimeoutMs)});
     const tier = ${JSON.stringify(baseline.defaultTier)};
     if (tier === null) localStorage.removeItem('aiclient:chat:default-tier');
     else localStorage.setItem('aiclient:chat:default-tier', tier);
     const now = settings.useSettingsStore.getState();
     return { chatAgentDefaults: JSON.parse(JSON.stringify(now.chatAgentDefaults)),
              providerIdleTimeoutMs: now.providerIdleTimeoutMs,
              defaultTier: localStorage.getItem('aiclient:chat:default-tier') };`,
    { label: 'restore prefs' }
  );
  console.log('restored ->', JSON.stringify(restored));
  await sleep(2500);

  const sessions = await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     return s.sessions
       .filter((x) => /^(T09|T10|New chat|Live Agent Host)/.test(x.title ?? ''))
       .map((x) => ({ id: x.id, title: x.title, status: x.status, updatedAt: x.updatedAt }));`,
    { label: 'created sessions' }
  );
  console.log(`conversations created / touched by this point-check: ${sessions.length}`);
  for (const s of sessions) console.log(`  ${s.id}  ${s.title}`);
  save('99-00-restored.json', { baseline, restored });
  save('99-01-sessions.json', sessions);
  console.log('shot:', await shot(cdp, '99-final.png'));
} finally {
  cdp.close();
}
