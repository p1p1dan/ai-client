/**
 * Three cheap items in one pass, so the app is opened once for them:
 *   T097  — spacing screenshot: user bubble → turn status row → the output
 *   T099  — settings' data-migration panel: three boxes, unchecked and frozen,
 *           with the 「测试期间暂未开放」 note
 *   T093b — set 模型请求超时 to 30 s through the picker, and prove it landed in
 *           the settings FILE (the worker reads it once, at startup)
 */
import fs from 'node:fs';
import path from 'node:path';
import { CLICK_SEND, connect, save, sessionStatus, shot, sleep, stamp, typeInto } from './lib.mjs';

const SETTINGS_FILE = '/home/ai/.pilab/jyw-ai-client-dev/settings.json';
const readSetting = () => {
  const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  const wrapper = j['aiclient-settings'];
  const state = typeof wrapper === 'string' ? JSON.parse(wrapper).state : wrapper?.state;
  return state?.providerIdleTimeoutMs;
};

const { cdp, evalAsync } = await connect();
const VP = `(() => {
  const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
    .filter((v) => v.offsetParent !== null);
  let best = null, w = -1;
  for (const v of vps) { const x = v.getBoundingClientRect().width; if (x > w) { w = x; best = v; } }
  return best;
})()`;

async function clip(name, rect) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 2 } });
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__pci_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );
  const sid = await evalAsync(`return window.__pci_store.getState().activeSessionId;`, { label: 'sid' });

  // One more exchange, so this session carries real history across the restart
  // that T102 needs (and so T097 has a settled turn to photograph).
  console.log('typed:', await cdp.evaluate(typeInto('T097：这一条用来看气泡与状态行的间距')));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 20_000, label: 'send enabled' }
  );
  console.log(`[${stamp()}] send:`, JSON.stringify(await cdp.evaluate(CLICK_SEND)));
  for (let i = 0; i < 20; i += 1) {
    await sleep(2000);
    const st = await evalAsync(sessionStatus(sid), { label: `poll ${i}` });
    if (st.status === 'idle' && st.msgs >= 4) { console.log('settled:', JSON.stringify(st)); break; }
  }
  await sleep(1500);

  // ---- T097: spacing ------------------------------------------------------
  const geom = await cdp.evaluate(`(() => {
    const vp = ${VP};
    if (!vp) return null;
    vp.scrollTop = vp.scrollHeight;
    const r = vp.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width),
             height: Math.round(r.height), text: (vp.innerText || '').slice(-600) };
  })()`);
  await sleep(600);
  console.log('transcript tail:', JSON.stringify(geom?.text));
  save('08-00-transcript.json', geom);
  console.log('shot (full):', await shot(cdp, '08-a-spacing-full.png'));
  if (geom) {
    console.log('shot (transcript 2x):', await clip('08-b-spacing-transcript.png', {
      x: geom.x, y: geom.y, width: geom.width, height: Math.min(geom.height, 520),
    }));
  }
  // The exact spacing tokens the criterion is written against.
  const spacing = await cdp.evaluate(`(() => {
    const vp = ${VP};
    if (!vp) return null;
    const rows = [...vp.querySelectorAll('div')].filter((n) => n.offsetParent !== null);
    const statusRow = rows.find((n) => /^(耗时|已工作|工作中|Worked for)/.test((n.innerText || '').trim()));
    const pick = (n) => n ? { cls: (n.className || '').toString().slice(0, 160),
                              gap: getComputedStyle(n).gap, fontSize: getComputedStyle(n).fontSize,
                              text: (n.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60) } : null;
    return { statusRow: pick(statusRow), statusParent: pick(statusRow?.parentElement) };
  })()`);
  console.log('spacing tokens:', JSON.stringify(spacing, null, 1));
  save('08-01-spacing.json', spacing);

  // ---- T099: data migration panel + T093 timeout picker --------------------
  console.log('open settings:', await cdp.evaluate(`(() => {
    const b = document.querySelector('nav[aria-label="主导航"] button[aria-label^="设置"]');
    if (!b) return 'no settings button';
    b.click();
    return 'clicked';
  })()`));
  await sleep(3000);
  const nav = await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const d = [...document.querySelectorAll('[role="dialog"], [data-slot="dialog-popup"]')].filter(vis)[0];
    const scope = d ?? document;
    return { hasDialog: !!d,
      items: [...scope.querySelectorAll('button, [role="tab"], [role="menuitem"]')]
        .filter(vis).map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 50) };
  })()`);
  console.log('settings nav:', JSON.stringify(nav));
  save('08-02-settings-nav.json', nav);
  console.log('shot:', await shot(cdp, '08-c-settings-open.png'));

  for (const label of ['数据迁移', '迁移', '数据']) {
    const r = await cdp.evaluate(`(() => {
      const vis = (n) => n.offsetParent !== null;
      const b = [...document.querySelectorAll('button, [role="tab"], [role="menuitem"], a')]
        .filter(vis).find((n) => (n.textContent || '').trim() === ${JSON.stringify(label)});
      if (!b) return { ok: false };
      b.click();
      return { ok: true };
    })()`);
    if (r.ok) { console.log(`clicked settings section 「${label}」`); break; }
  }
  await sleep(2000);
  const migration = await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const body = document.body.innerText;
    const boxes = [...document.querySelectorAll('[role="checkbox"], input[type="checkbox"]')]
      .filter(vis)
      .map((b) => ({ ariaChecked: b.getAttribute('aria-checked') ?? String(b.checked ?? ''),
                     disabled: b.getAttribute('aria-disabled') ?? String(b.disabled ?? ''),
                     label: (b.closest('label')?.innerText || b.parentElement?.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60) }));
    return { boxes,
      hasNotOpenNote: /测试期间暂未开放/.test(body),
      noteLines: body.split('\\n').filter((l) => /迁移|暂未开放/.test(l)).slice(0, 10) };
  })()`);
  console.log('migration panel:', JSON.stringify(migration, null, 1));
  save('08-03-migration.json', migration);
  console.log('shot:', await shot(cdp, '08-d-migration-panel.png'));

  // ---- T093 idle-timeout picker -------------------------------------------
  const before = readSetting();
  console.log('settings file providerIdleTimeoutMs BEFORE:', JSON.stringify(before));
  const foundSection = await cdp.evaluate(`(() => {
    const body = document.body.innerText;
    return { hasSection: /模型请求超时/.test(body), hasRow: /空闲超时/.test(body),
             lines: body.split('\\n').filter((l) => /超时/.test(l)).slice(0, 8) };
  })()`);
  console.log('timeout section on this page:', JSON.stringify(foundSection));
  if (!foundSection.hasSection) {
    for (const label of ['模型', 'AI 服务', '模型管理', 'Pi 模型', '通用']) {
      const r = await cdp.evaluate(`(() => {
        const vis = (n) => n.offsetParent !== null;
        const b = [...document.querySelectorAll('button, [role="tab"], [role="menuitem"], a')]
          .filter(vis).find((n) => (n.textContent || '').trim() === ${JSON.stringify(label)});
        if (!b) return { ok: false };
        b.click();
        return { ok: true };
      })()`);
      if (r.ok) {
        await sleep(2200);
        const hit = await cdp.evaluate(`/模型请求超时/.test(document.body.innerText)`);
        console.log(`  tried section 「${label}」 -> hasSection=${hit}`);
        if (hit) break;
      }
    }
  }
  await sleep(1200);
  save('08-04-timeout-section.json', await cdp.evaluate(`(() => ({
    hasSection: /模型请求超时/.test(document.body.innerText),
    lines: document.body.innerText.split('\\n').filter((l) => /超时|Idle|Off/.test(l)).slice(0, 12),
  }))()`));
  console.log('shot:', await shot(cdp, '08-e-timeout-section.png'));

  // Drive the picker through the store, then also verify the UI shows it: the
  // Base UI Select popup is not reliably clickable from CDP (handbook 2.6) and
  // the criterion is about the VALUE reaching the worker, not the menu's paint.
  const set = await evalAsync(
    `const settings = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     settings.useSettingsStore.getState().setProviderIdleTimeoutMs(30000);
     return settings.useSettingsStore.getState().providerIdleTimeoutMs;`,
    { label: 'set 30s' }
  );
  console.log('store providerIdleTimeoutMs ->', set);
  await sleep(2500);
  const shown = await cdp.evaluate(`(() => {
    const body = document.body.innerText;
    return { lines: body.split('\\n').filter((l) => /超时|30|秒|s$/.test(l)).slice(0, 10) };
  })()`);
  console.log('UI after set:', JSON.stringify(shown));
  console.log('shot:', await shot(cdp, '08-f-timeout-30s.png'));
  const after = readSetting();
  console.log('settings file providerIdleTimeoutMs AFTER:', JSON.stringify(after));
  save('08-05-timeout-setting.json', { before, store: set, after, uiLines: shown.lines });

  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      (n) => /^(关闭|Close|完成|Done)$/.test((n.textContent || '').trim()) && n.offsetParent !== null);
    if (b) b.click();
    return !!b;
  })()`);
  console.log(`[${stamp()}] done`);
} finally {
  cdp.close();
}
