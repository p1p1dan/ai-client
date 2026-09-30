#!/usr/bin/env node
/**
 * p1-7e-e45.mjs — re-check items for P1-7e groups e4 (wording, the question
 * card; decision 144) and e5 (plugins, legacy notice, grant activity row,
 * image size cap; decision 143). Helpers from p1-7e-items.mjs (`e7`).
 *
 *   P17D_SCRATCH=/tmp/aiclient-p17e node p1-7e-e45.mjs <item> [args]
 *
 *   question               P1-QUESTION three times: answer (multi-select), Skip, Stop
 *   grants [tag]           ask mode, P1-PERM-GRANTS: 「本会话内允许」, then the activity row
 *   image                  fake-vision: an 8192×1 PNG is taken, an 8193×1 one refused
 *   plugins                Settings → Extensions open, switch the plugin: badge and hint follow
 *   texts                  review panel note, Settings nav 「模型」 and its page, temp chat badge
 *   h-seed                 1.0.x leftovers in the scratch HOME and workspace (app stopped)
 *   h-notice <tag>         first start: the legacy-asset notice (not dismissed by `enter`)
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { lib } = await import(path.join(here, 'p1-7e-gui.mjs'));
const { e7 } = await import(path.join(here, 'p1-7e-items.mjs'));
const { attach, makeEval, sendText, waitTurn, STORE, sleep } = lib;
const {
  shot,
  save,
  newChat,
  setGear,
  pressKey,
  waitFor,
  clickButtonText,
  CLICK_STOP,
  TRANSCRIPT,
  COMPOSER,
  lastAssistantText,
  bashCalls,
  pickModel,
  pastePng,
  toastMark,
  toastsSince,
  OPEN_DIALOGS,
  SIDEBAR,
  hostPids,
  BUSY,
  repoRoot,
} = e7;

// ---- e4: the question card ------------------------------------------------------------------

const QA_CARD = `(() => {
  const skip = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '跳过' && b.offsetParent !== null);
  if (!skip) return null;
  let card = skip;
  for (let i = 0; i < 10 && card.parentElement; i += 1) {
    card = card.parentElement;
    if (card.querySelector('[role="radiogroup"], [role="group"]')) break;
  }
  return {
    text: (card.innerText || '').slice(0, 1200),
    options: [...card.querySelectorAll('[role="radio"], [role="checkbox"]')].filter((o) => o.offsetParent !== null)
      .map((o) => ({ role: o.getAttribute('role'), checked: o.getAttribute('aria-checked'), text: (o.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 80) })),
  };
})()`;
const clickOption = (prefix) => `(() => {
  const o = [...document.querySelectorAll('[role="radio"], [role="checkbox"]')]
    .find((n) => n.offsetParent !== null && (n.innerText || '').trim().replace(/^[A-Z]\\s+/, '').startsWith(${JSON.stringify(prefix)}));
  if (!o) return false;
  if (o.getAttribute('aria-checked') !== 'true') o.click();
  return o.getAttribute('aria-checked') === 'true' ? 'checked' : 'clicked';
})()`;
const clickTab = (index) => `(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')].filter((n) => n.offsetParent !== null);
  if (!tabs[${index}]) return false;
  tabs[${index}].click();
  return true;
})()`;
/** The frozen question cards in the timeline (after the turn). */
const FROZEN_CARDS = `(() => {
  const heads = [...document.querySelectorAll('*')].filter((n) => n.offsetParent !== null && n.children.length === 0 && /^(回答|已跳过提问|提问已停止|Questions stopped|Skipped)/.test((n.innerText || '').trim()));
  return heads.map((h) => {
    let box = h;
    for (let i = 0; i < 6 && box.parentElement; i += 1) { box = box.parentElement; if ((box.innerText || '').length > 80) break; }
    return { head: (h.innerText || '').trim(), text: (box.innerText || '').slice(0, 800), lis: [...box.querySelectorAll('li')].map((li) => (li.innerText || '').trim()) };
  });
})()`;

async function question() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid };
  // 1. Answer, with two options and an 「其他」 note on the multi-select question.
  await sendText(cdp, 'P1-QUESTION: ask me before you start.');
  out.card1 = await waitFor(cdp, QA_CARD);
  await cdp.evaluate(clickTab(0));
  await sleep(400);
  out.pick = [];
  out.pick.push(await cdp.evaluate(clickOption('Bridge (Recommended)')));
  await sleep(400);
  out.pick.push(await cdp.evaluate(clickTab(1)));
  await sleep(400);
  out.pick.push(await cdp.evaluate(clickOption('tsc')));
  out.pick.push(await cdp.evaluate(clickOption('smoke, then record')));
  out.pick.push(await cdp.evaluate(clickOption('其他')));
  await sleep(400);
  out.otherInput = await cdp.evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find((n) => n.offsetParent !== null && ['你的回答', 'Your answer'].includes(n.getAttribute('aria-label')));
    if (!input) return 'no other input';
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'E4-OTHER, typed note');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { aria: input.getAttribute('aria-label'), placeholder: input.getAttribute('placeholder') };
  })()`);
  await sleep(500);
  out.shotFilled = await shot(cdp, 'e4-question-1-filled');
  out.submit = await cdp.evaluate(clickButtonText('继续'));
  out.turn1 = (await waitTurn(evalAsync, sid, { neverBusyMs: 3000 })).status;
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.answer1 = await lastAssistantText(evalAsync, sid);
  out.frozen1 = await cdp.evaluate(FROZEN_CARDS);
  out.shotAnswered = await shot(cdp, 'e4-question-2-answered-multiselect-lines');
  // 2. Skip.
  await sendText(cdp, 'P1-QUESTION: ask me again, I will skip.');
  out.card2 = await waitFor(cdp, QA_CARD);
  out.skip = await cdp.evaluate(clickButtonText('跳过'));
  out.turn2 = (await waitTurn(evalAsync, sid, { neverBusyMs: 3000 })).status;
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.frozen2 = await cdp.evaluate(FROZEN_CARDS);
  out.shotSkipped = await shot(cdp, 'e4-question-3-skipped');
  // 3. Stop while the card is up.
  await sendText(cdp, 'P1-QUESTION: ask once more, then I press Stop.');
  out.card3 = await waitFor(cdp, QA_CARD);
  out.stop = await cdp.evaluate(CLICK_STOP);
  out.turn3 = (await waitTurn(evalAsync, sid, { neverBusyMs: 3000 })).status;
  await sleep(1000);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.frozen3 = await cdp.evaluate(FROZEN_CARDS);
  out.transcript = (await cdp.evaluate(TRANSCRIPT)).slice(-2500);
  out.shotStopped = await shot(cdp, 'e4-question-4-stopped');
  cdp.close();
  save('e4-question', out);
}

// ---- e5: the grant activity row -----------------------------------------------------------

const CARDS = `(() => {
  const out = [];
  const seen = new Set();
  for (const b of document.querySelectorAll('button')) {
    const t = (b.innerText || '').trim();
    if (b.offsetParent === null || !['直接允许', '本会话内允许', '拒绝'].includes(t)) continue;
    let card = b;
    for (let i = 0; i < 10 && card.parentElement; i += 1) {
      card = card.parentElement;
      if (/rounded/.test(card.className) && /border/.test(card.className) && (card.innerText || '').length > 60) break;
    }
    if (seen.has(card)) continue;
    seen.add(card);
    out.push({ text: (card.innerText || '').replace(/\\n+/g, ' | ').slice(0, 600) });
  }
  return out;
})()`;

async function grants(tag = 'e5-grant-activity') {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1200);
  const out = { sid, gear: await setGear(cdp, '每次询问') };
  const t0 = await sendText(cdp, 'P1-PERM-GRANTS: echo three times.');
  const log = [];
  let seenBusy = false;
  let idle = 0;
  let n = 0;
  while (Date.now() - t0 < 150_000) {
    const st = await lib.turnStatus(evalAsync, sid);
    if (BUSY.includes(st.status)) {
      seenBusy = true;
      idle = 0;
    } else if (seenBusy && ++idle >= 3) break;
    if (st.status === 'waiting_permission') {
      const cards = await cdp.evaluate(CARDS);
      if (cards.length) {
        n += 1;
        const label = n === 1 ? '本会话内允许' : '直接允许';
        await cdp.evaluate(clickButtonText(label));
        log.push({ dt: Date.now() - t0, n, card: cards[0].text, answered: label });
        await sleep(900);
        continue;
      }
    }
    await sleep(300);
  }
  out.cards = log;
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(600);
  out.calls = await bashCalls(evalAsync, sid);
  out.activityRows = await cdp.evaluate(
    `[...document.querySelectorAll('*')].filter((n) => n.offsetParent !== null && n.children.length <= 6 && /本会话已授权/.test(n.innerText || '') && (n.innerText || '').length < 200).map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim()).slice(0, 4)`
  );
  out.storeBlocks = await evalAsync(
    `${STORE}
     const blocks = (s.messages[${JSON.stringify(sid)}] ?? []).flatMap((m) => m.blocks ?? []);
     return blocks.filter((b) => b.type === 'permission_activity').map((b) => JSON.parse(JSON.stringify(b)));`,
    { label: 'activity blocks' }
  );
  out.transcript = (await cdp.evaluate(TRANSCRIPT)).slice(-1500);
  await cdp.evaluate(`(() => {
    const n = [...document.querySelectorAll('*')].filter((x) => x.offsetParent !== null && x.children.length <= 6 && /本会话已授权/.test(x.innerText || '')).pop();
    if (n) n.scrollIntoView({ block: 'center' });
    return !!n;
  })()`);
  await sleep(400);
  out.shotLight = await lib.shot(cdp, `${tag}-light`);
  out.dark = await lib.setTheme(cdp, 'dark');
  await sleep(800);
  out.shotDark = await lib.shot(cdp, `${tag}-dark`);
  out.light = await lib.setTheme(cdp, 'light');
  cdp.close();
  save(tag, out);
}

// ---- e5: the image edge cap ------------------------------------------------------------------

async function image() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid };
  out.model = await pickModel(cdp, 'fake-vision');
  // 8192 x 1: at the cap, taken.
  const tm = await toastMark(cdp);
  out.paste8192 = await evalAsync(pastePng(8192, 1, 'e5-8192x1.png'), { label: 'paste 8192' });
  await sleep(1500);
  out.after8192 = await cdp.evaluate(COMPOSER);
  out.toasts8192 = await toastsSince(cdp, tm);
  await cdp.evaluate(lib.typeIntoComposer('P1-IMAGE: an image 8192 px wide.'));
  await sleep(300);
  out.shot8192 = await shot(cdp, 'e5-image-8192-accepted-draft');
  await cdp.waitFor(lib.SEND_READY, { timeoutMs: 20_000, label: 'send ready (8192)' });
  await cdp.evaluate(lib.CLICK_SEND);
  out.turn8192 = (await waitTurn(evalAsync, sid)).status;
  await sleep(800);
  out.answer8192 = await lastAssistantText(evalAsync, sid);
  out.shotSent = await shot(cdp, 'e5-image-8192-sent');
  // 8193 x 1: refused by the pre-check, the notice names 8192.
  const tm2 = await toastMark(cdp);
  out.paste8193 = await evalAsync(pastePng(8193, 1, 'e5-8193x1.png'), { label: 'paste 8193' });
  await sleep(1500);
  out.after8193 = await cdp.evaluate(COMPOSER);
  out.toasts8193 = await toastsSince(cdp, tm2);
  out.notice8193 = await cdp.evaluate(`(() => {
    const t = document.body.innerText;
    const i = t.indexOf('e5-8193x1.png');
    return i >= 0 ? t.slice(Math.max(0, i - 20), i + 160) : null;
  })()`);
  out.shot8193 = await shot(cdp, 'e5-image-8193-refused');
  cdp.close();
  save('e5-image', out);
}

// ---- e5: the plugins page follows the host ------------------------------------------------

async function openSettings(cdp, evalAsync, category) {
  await evalAsync(
    `const m = await import(/* @vite-ignore */ '/stores/settingsIntent.ts');
     m.useSettingsIntentStore.getState().requestSettings(${JSON.stringify(category)});
     return true;`,
    { label: 'open settings' }
  );
  await sleep(1500);
  await lib.pumpFrames(cdp, 600);
}

async function closeSettings(cdp) {
  await pressKey(cdp, 'Escape');
  await sleep(600);
  const still = await cdp.evaluate(
    `!!document.querySelector('[data-slot="dialog-popup"][data-open]')`
  );
  if (still) {
    await cdp.evaluate(`(() => {
      const d = document.querySelector('[data-slot="dialog-popup"][data-open]');
      const b = d && [...d.querySelectorAll('button')].find((n) => (n.getAttribute('aria-label') || n.innerText || '').trim() === '关闭');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(600);
  }
}

const SECTION = (heading, mustInclude = null) => `(() => {
  const h = [...document.querySelectorAll('h2, h3, h4')].find((n) => n.offsetParent !== null && (n.innerText || '').trim() === ${JSON.stringify(heading)});
  if (!h) return null;
  const must = ${JSON.stringify(mustInclude)};
  let box = h;
  for (let i = 0; i < 8 && box.parentElement; i += 1) {
    box = box.parentElement;
    if (must ? (box.innerText || '').includes(must) : (box.innerText || '').length > (h.innerText || '').length + 40) break;
  }
  return {
    text: box.innerText,
    badges: [...box.querySelectorAll('[data-slot="badge"]')].map((b) => (b.innerText || '').trim()),
    switches: [...box.querySelectorAll('[role="switch"]')].map((sw) => ({ checked: sw.getAttribute('aria-checked') ?? sw.getAttribute('data-checked'), disabled: sw.hasAttribute('data-disabled') || sw.getAttribute('aria-disabled') === 'true' })),
  };
})()`;
const scrollToHeading = (text) => `(() => {
  const h = [...document.querySelectorAll('h1, h2, h3, h4')].find((n) => n.offsetParent !== null && (n.innerText || '').trim() === ${JSON.stringify(text)});
  if (!h) return false;
  h.scrollIntoView({ block: 'start' });
  return true;
})()`;
const HINT = '插件的改动在对话引擎下次启动时生效';

async function plugins(tag = 'e5-plugins') {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = {
    hostsBefore: hostPids(),
    state: await evalAsync(`return await window.electronAPI.dshPlugins.list();`, { label: 'list' }),
  };
  await openSettings(cdp, evalAsync, 'extensions');
  await cdp.evaluate(scrollToHeading('插件'));
  await sleep(500);
  out.before = await cdp.evaluate(SECTION('插件', 'dsh-office-tools'));
  out.shotBefore = await shot(cdp, `${tag}-1-before`, { bottom: false });
  const t0 = Date.now();
  out.click = await cdp.evaluate(`(() => {
    const h = [...document.querySelectorAll('h2, h3, h4')].find((n) => (n.innerText || '').trim() === '插件');
    let box = h; for (let i = 0; i < 6 && box.parentElement; i += 1) box = box.parentElement;
    const sw = box.querySelector('[role="switch"]');
    if (!sw) return 'no switch';
    sw.click();
    return 'clicked';
  })()`);
  const samples = [];
  let last = '';
  const shots = {};
  while (Date.now() - t0 < 45_000) {
    const sec = await cdp.evaluate(SECTION('插件', 'dsh-office-tools'));
    const row = {
      badges: sec?.badges ?? null,
      hint: (sec?.text ?? '').includes(HINT),
      switches: sec?.switches ?? null,
      hosts: hostPids(),
    };
    const key = JSON.stringify(row);
    if (key !== last) {
      samples.push({ dt: Date.now() - t0, ...row });
      last = key;
      if (!shots.pending && row.hint) shots.pending = await lib.shot(cdp, `${tag}-2-pending`);
    }
    if (row.badges?.some((b) => b === '已加载') && !row.hint) {
      shots.loaded = await lib.shot(cdp, `${tag}-3-loaded-same-page`);
      break;
    }
    await lib.pumpFrames(cdp, 250);
  }
  out.samples = samples;
  out.shots = shots;
  out.loadedAfterMs = samples.find((s) => s.badges?.includes('已加载') && !s.hint)?.dt ?? null;
  out.after = await cdp.evaluate(SECTION('插件', 'dsh-office-tools'));
  out.hostsAfter = hostPids();
  await closeSettings(cdp);
  cdp.close();
  save(tag, out);
}

// ---- e4: review note, Settings 「模型」, temporary chat badge ---------------------------------

async function texts() {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = {};
  // Review panel.
  out.reviewOpen = await cdp.evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && (n.innerText || '').trim().startsWith('审阅')); if (!b) return false; b.click(); return true; })()`
  );
  await lib.pumpFrames(cdp, 1500);
  out.reviewNote = await cdp.evaluate(
    `[...document.querySelectorAll('*')].filter((n) => n.offsetParent !== null && n.children.length === 0 && /记录当前对话中|Edit 和 Write/.test(n.innerText || '')).map((n) => (n.innerText || '').trim())`
  );
  out.shotReview = await lib.shot(cdp, 'e4-review-panel-note');
  await cdp.evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && (n.innerText || '').trim().startsWith('审阅')); if (b) b.click(); return !!b; })()`
  );
  await sleep(800);
  // Settings: the 「模型」 page.
  await openSettings(cdp, evalAsync, 'pi');
  out.nav = await cdp.evaluate(
    `[...document.querySelectorAll('nav button, button[aria-current]')].filter((b) => b.offsetParent !== null).map((b) => (b.innerText || '').trim() + (b.getAttribute('aria-current') ? ' *' : '')).filter(Boolean).slice(0, 30)`
  );
  out.headings = await cdp.evaluate(
    `[...document.querySelectorAll('h1, h2, h3, h4')].filter((n) => n.offsetParent !== null).map((n) => (n.innerText || '').trim()).filter(Boolean)`
  );
  out.piWords = await cdp.evaluate(`(() => {
    const d = document.querySelector('[data-slot="dialog-popup"][data-open]') ?? document.body;
    const t = d.innerText || '';
    return (t.match(/[^\\n]*\\bPi\\b[^\\n]*/g) || []).slice(0, 10);
  })()`);
  out.ownSetupLine = await cdp.evaluate(
    `[...document.querySelectorAll('*')].filter((n) => n.offsetParent !== null && n.children.length <= 2 && /使用本机已有配置|Use my own setup/.test(n.innerText || '') && (n.innerText || '').length < 200).map((n) => (n.innerText || '').trim()).slice(0, 4)`
  );
  out.shotSettings = await lib.shot(cdp, 'e4-settings-models-page');
  await closeSettings(cdp);
  // A temporary chat: its kind chip.
  out.temp = await evalAsync(
    `const m = await import(/* @vite-ignore */ '/stores/chatSessionActions.ts');
     m.createOrReuseUnboundChatSession();
     await new Promise((r) => setTimeout(r, 1500));
     ${STORE.replace('const s =', 'const s2 =')}
     return { id: s2.activeSessionId };`,
    { label: 'temp chat' }
  );
  await lib.pumpFrames(cdp, 800);
  out.sidebar = (await cdp.evaluate(SIDEBAR)).rows.filter((r) => r.badges.length);
  out.shotTemp = await shot(cdp, 'e4-sidebar-badges-temp-failed', { bottom: false });
  cdp.close();
  save('e4-texts', out);
}

// ---- e5 + e4: the legacy-asset notice at a first start ----------------------------------------

const profileDir = () => {
  const pilab = path.join(lib.dirs.home, '.pilab');
  const names = fs.existsSync(pilab)
    ? fs.readdirSync(pilab).filter((n) => fs.statSync(path.join(pilab, n)).isDirectory())
    : [];
  return path.join(pilab, names.find((n) => n.endsWith('-dev')) ?? 'jyw-ai-client-dev');
};
const settingsFile = () => path.join(profileDir(), 'settings.json');
const NOTICE_TITLE = '以下内容在新版中不再生效';

function readSeenKey() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return { dshLegacyAssetNoticeSeen: data.dshLegacyAssetNoticeSeen ?? null };
  } catch (error) {
    return { error: String(error.message ?? error) };
  }
}

function appIsDown() {
  const c = lib.classify();
  return c.devRoot.length === 0 && c.electronMain.length === 0;
}

/** Batch 3's H1 leftovers (same files), in this scratch's HOME and workspace. */
function hSeed() {
  if (!appIsDown()) throw new Error('the app is running');
  const home = lib.dirs.home;
  const ws = lib.dirs.workspace;
  const written = [];
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    written.push(path.relative(lib.SCRATCH, file));
  };
  put(path.join(home, '.pilab', 'AGENTS.md'), '# My rules\n\nAlways answer in short sentences.\n');
  put(
    path.join(home, '.agents', 'subagents', 'x.md'),
    '---\nname: x-reviewer\ndescription: Reviews a diff.\n---\nReview the diff you are given.\n'
  );
  put(
    path.join(ws, '.pi', 'prompts', 'review.md'),
    '---\ndescription: Review the change\n---\nReview $@\n'
  );
  put(path.join(ws, '.pi', 'prompts', 'ship.md'), 'Ship it: $@\n');
  put(
    path.join(ws, '.pi', 'mcp.json'),
    `${JSON.stringify({ mcpServers: { 'demo-files': { command: 'node', args: ['server.js'] }, 'demo-web': { url: 'http://127.0.0.1:9/mcp' } } }, null, 2)}\n`
  );
  put(
    path.join(profileDir(), 'pi-agent', 'skills', 'Bad_Skill', 'SKILL.md'),
    '---\nname: Bad_Skill\ndescription: A skill whose name DSH refuses.\n---\nDo the thing.\n'
  );
  put(
    path.join(ws, '.pi', 'skills', 'legacy-skill', 'SKILL.md'),
    '---\nname: legacy-skill\ndescription: A project skill in a folder DSH does not scan.\n---\nDo the other thing.\n'
  );
  put(settingsFile(), `${JSON.stringify({ enablePiSubagents: false }, null, 2)}\n`);
  save(`e5-h-seed-${path.basename(lib.SCRATCH)}`, { written });
}

/** First start without `enter` (it would close the notice with 「知道了」). */
async function hNotice(tag = 'e5-legacy-notice-first-start', waitMs = '60000') {
  const cdp = await attach(600_000);
  const evalAsync = makeEval(cdp);
  await cdp.waitFor(
    `document.visibilityState === 'visible' && (document.getElementById('root')?.innerText.length ?? 0) > 20`,
    { timeoutMs: 120_000, label: 'painted' }
  );
  const out = { tag, seenBefore: readSeenKey() };
  out.language = await evalAsync(
    `const m = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     if (m.useSettingsStore.getState().language !== 'zh') m.useSettingsStore.getState().setLanguage('zh');
     return m.useSettingsStore.getState().language;`,
    { label: 'zh' }
  );
  await sleep(1500);
  const { ENTER_MAIN_SURFACE } = await import(path.join(repoRoot, 'scripts/h21-cdp.mjs'));
  out.entered = await cdp.evaluate(ENTER_MAIN_SURFACE).catch((e) => `ERROR: ${e.message}`);
  const t0 = Date.now();
  out.otherDialogs = [];
  const seenNotices = [];
  let notice = null;
  let captured = false;
  let stableSince = null;
  const NOTICE_BUTTONS = `(() => {
    const d = [...document.querySelectorAll('[role="dialog"][data-open]')].find((x) => (x.innerText || '').includes(${JSON.stringify(NOTICE_TITLE)}));
    if (!d) return null;
    return [...d.querySelectorAll('button')].map((b) => ({ text: (b.innerText || '').trim(), textTransform: getComputedStyle(b).textTransform, cls: String(b.className).split(' ').filter((c) => /case/.test(c)).join(' ') }));
  })()`;
  // Re-check (run 3 of this re-check): the service announcement can push the
  // notice off the top at any moment, so it is captured only when it is the one
  // open dialog (besides Settings) and has not changed for 2 s.
  while (Date.now() - t0 < Number(waitMs) && !captured) {
    await lib.pumpFrames(cdp, 300);
    const dialogs = await cdp.evaluate(OPEN_DIALOGS);
    notice = dialogs.find((d) => d.text.includes(NOTICE_TITLE)) ?? null;
    if (notice && seenNotices.at(-1)?.text !== notice.text) {
      seenNotices.push({ dt: Date.now() - t0, text: notice.text, buttons: notice.buttons });
      stableSince = Date.now();
    }
    if (!notice) stableSince = null;
    const blocking = dialogs.some(
      (d) => !d.text.includes(NOTICE_TITLE) && !d.text.startsWith('设置')
    );
    const project = /mcp|提示词模板|\.pi\/skills|\.pi\/prompts/.test(notice?.text ?? '');
    if (
      notice &&
      !blocking &&
      stableSince &&
      Date.now() - stableSince > 2000 &&
      (project || Date.now() - t0 > 30_000)
    ) {
      const dom = await cdp.evaluate(NOTICE_BUTTONS);
      const again = await cdp.evaluate(OPEN_DIALOGS);
      if (dom && !again.some((d) => !d.text.includes(NOTICE_TITLE) && !d.text.startsWith('设置'))) {
        out.buttonsDom = dom;
        out.shot = await e7.shot(cdp, `${tag}-notice`, { bottom: false });
        out.closed = await cdp.evaluate(`(() => {
          const d = [...document.querySelectorAll('[role="dialog"][data-open]')].find((x) => (x.innerText || '').includes(${JSON.stringify(NOTICE_TITLE)}));
          const b = d && [...d.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '知道了');
          if (!b) return 'no 知道了';
          b.click();
          return '知道了';
        })()`);
        captured = true;
        await sleep(1500);
        break;
      }
    }
    const other =
      dialogs.find((d) => !d.text.includes(NOTICE_TITLE) && !d.text.startsWith('设置')) ?? null;
    if (other) {
      const hit = await cdp.evaluate(`(() => {
        const labels = ['以后再说', '知道了', '我知道了', '关闭', '跳过', '稍后'];
        for (const d of [...document.querySelectorAll('[role="dialog"][data-open], [role="alertdialog"][data-open]')].reverse()) {
          if ((d.innerText || '').includes(${JSON.stringify(NOTICE_TITLE)}) || (d.innerText || '').startsWith('设置')) continue;
          const b = [...d.querySelectorAll('button')].find((n) => labels.includes((n.innerText || n.getAttribute('aria-label') || '').trim()) && n.offsetParent !== null);
          if (b) { b.click(); return (b.innerText || b.getAttribute('aria-label')).trim(); }
        }
        return null;
      })()`);
      // Title line only: the announcement body is the service's own text (it names people).
      if (hit)
        out.otherDialogs.push({
          dt: Date.now() - t0,
          title: other.text.split('\n')[0],
          closedWith: hit,
        });
    }
    await sleep(400);
  }
  out.noticeTexts = seenNotices;
  out.notice = notice;
  out.captured = captured;
  out.seenAfter = readSeenKey();
  out.inspect = await evalAsync(
    `return await window.electronAPI.legacyAssets.inspect({ cwd: ${JSON.stringify(lib.dirs.workspace)} });`,
    { label: 'inspect' }
  ).catch((e) => String(e));
  // Never shoot while the announcement is up: its body names people.
  const announcementUp = (await cdp.evaluate(OPEN_DIALOGS)).some((d) => d.text.startsWith('公告'));
  if (!captured && !announcementUp)
    out.shotNoNotice = await e7.shot(cdp, `${tag}-no-notice`, { bottom: false });
  await cdp.evaluate(lib.INSTALL_RECORDERS).catch(() => undefined);
  cdp.close();
  save(tag, out);
}

const items = {
  question,
  grants,
  image,
  plugins,
  texts,
  'h-seed': hSeed,
  'h-notice': hNotice,
};
export const e45 = { openSettings, closeSettings, SECTION, scrollToHeading, CARDS };
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const name = process.argv[2];
  if (!items[name]) {
    console.error(`usage: p1-7e-e45.mjs ${Object.keys(items).join('|')}`);
    process.exit(2);
  }
  await items[name](...process.argv.slice(3));
  process.exit(0);
}
