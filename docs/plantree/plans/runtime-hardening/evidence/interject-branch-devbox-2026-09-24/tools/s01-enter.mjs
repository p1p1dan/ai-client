/**
 * Step 1 — language zh, get past the welcome screen, clear the dialog stack,
 * pin the fake model + fullopen tier, and describe what the app shows.
 */
import {
  COMPOSER,
  connect,
  ENTER_MAIN_SURFACE,
  FAKE_MODEL,
  save,
  shot,
  sleep,
  stamp,
} from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
try {
  const lang = await evalAsync(
    `const settings = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     const before = settings.useSettingsStore.getState().language;
     settings.useSettingsStore.getState().setLanguage('zh');
     return { before, after: settings.useSettingsStore.getState().language };`,
    { label: 'language' }
  );
  console.log('language:', JSON.stringify(lang));
  await sleep(1500);
  const entered = await cdp.evaluate(ENTER_MAIN_SURFACE).catch(async (_e) => {
    // English copy fallback, in case the welcome page had rendered before the switch.
    return cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((n) => /use my own setup|使用本机已有配置/i.test(n.textContent || '') && !n.disabled);
      if (!b) return 'ERROR: ' + ${JSON.stringify('no entry')};
      b.click(); return (b.textContent || '').trim();
    })()`);
  });
  console.log(`[${stamp()}] entry:`, JSON.stringify(entered));
  await cdp.waitFor(`document.querySelector('textarea') !== null`, {
    timeoutMs: 240_000,
    label: 'composer mounted',
  });
  await sleep(2000);
  const clicked = [];
  for (let i = 0; i < 16; i += 1) {
    const open = await cdp.evaluate(
      `document.querySelectorAll('[role="dialog"],[role="alertdialog"]').length`
    );
    if (!open) break;
    const hit = await cdp.evaluate(`(() => {
      const labels = ['知道了','我知道了','Got it','以后再说','稍后再说','Later','关闭','Close','跳过','Skip','暂不','不用了'];
      const b = [...document.querySelectorAll('[role="dialog"] button,[role="alertdialog"] button')].find(
        (n) => labels.includes((n.innerText || '').trim()) && n.offsetParent !== null);
      if (!b) return { none: [...document.querySelectorAll('[role="dialog"] button')].map((n) => (n.innerText||'').trim()).slice(0, 12) };
      b.click();
      return (b.innerText || '').trim();
    })()`);
    clicked.push(hit);
    await sleep(900);
  }
  console.log('dialogs:', JSON.stringify(clicked));

  const baseline = await evalAsync(
    `const settings = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     const s = settings.useSettingsStore.getState();
     return { chatAgentDefaults: JSON.parse(JSON.stringify(s.chatAgentDefaults ?? {})),
              defaultTier: localStorage.getItem('aiclient:chat:default-tier'),
              sessionModels: localStorage.getItem('aiclient:chat:session-models') };`,
    { label: 'baseline' }
  );
  console.log('baseline prefs (isolated profile):', JSON.stringify(baseline));
  save('01-baseline-prefs.json', baseline);
  const pinned = await evalAsync(
    `const settings = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     const s = settings.useSettingsStore.getState();
     s.setChatAgentDefaults({ ...(s.chatAgentDefaults ?? {}), model: ${JSON.stringify(FAKE_MODEL)} });
     localStorage.setItem('aiclient:chat:default-tier', 'fullopen');
     return JSON.parse(JSON.stringify(settings.useSettingsStore.getState().chatAgentDefaults));`,
    { label: 'pin' }
  );
  console.log('pinned:', JSON.stringify(pinned));
  const view = await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     return { active: s.activeSessionId, sessions: s.sessions.length, runtimeReady: s.runtimeReady,
              projects: (s.projects ?? []).map((p) => ({ id: p.id, name: p.name, path: p.path })),
              workspaces: (s.workspaces ?? []).map((w) => ({ id: w.id, path: w.path, branch: w.branch, kind: w.kind, projectId: w.projectId })) };`,
    { label: 'view' }
  );
  console.log('store:', JSON.stringify(view, null, 1));
  console.log('composer:', JSON.stringify(await cdp.evaluate(COMPOSER)));
  save('01-store.json', view);
  console.log('shot:', await shot(cdp, '01-entered.png'));
} finally {
  cdp.close();
}
