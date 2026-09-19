import fs from 'node:fs';
import { connect, save, shot } from './lib.mjs';

const base = JSON.parse(fs.readFileSync('/tmp/t091-repro/data/00-baseline-prefs.json', 'utf8'));
const { cdp, evalAsync } = await connect();
try {
  const r = await evalAsync(
    `const settings = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     settings.useSettingsStore.getState().setChatAgentDefaults(${JSON.stringify(base.chatAgentDefaults)});
     const tier = ${JSON.stringify(base.defaultTier)};
     if (tier === null) localStorage.removeItem('aiclient:chat:default-tier');
     else localStorage.setItem('aiclient:chat:default-tier', tier);
     return { chatAgentDefaults: JSON.parse(JSON.stringify(settings.useSettingsStore.getState().chatAgentDefaults)),
              defaultTier: localStorage.getItem('aiclient:chat:default-tier') };`,
    { label: 'restore prefs' }
  );
  console.log('restored:', JSON.stringify(r), 'baseline was:', JSON.stringify(base));
  save('99-restored-prefs.json', { baseline: base, now: r });
  console.log('shot:', await shot(cdp, '99-final.png'));
} finally {
  cdp.close();
}
