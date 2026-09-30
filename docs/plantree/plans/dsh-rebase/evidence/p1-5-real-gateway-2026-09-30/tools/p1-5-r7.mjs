#!/usr/bin/env node
/**
 * p1-5-r7.mjs — R7 of the P1-5 real-gateway run: the three one-shot
 * completions (commit message, branch name, code review), Automatic and a
 * named model, one review stopped midway. Scratch repo:
 * /tmp/aiclient-real-gw/workspace (git init + one commit + one staged change).
 *
 *   node p1-5-r7.mjs git                         open the Git surface, list the controls
 *   node p1-5-r7.mjs commit <auto|model id> <tag>
 *   node p1-5-r7.mjs branch <auto|model id> <tag>
 *   node p1-5-r7.mjs review <auto|model id> <tag> [stopAfterChars]
 *
 * The model is set through the settings store's own setters (what the AI
 * features settings page calls). Commit and review are clicked in the Git
 * surface. The branch-name generator has no mounted UI in this build
 * (CreateWorktreeDialog is exported but rendered nowhere), so `branch` calls
 * the same preload method the dialog calls, with the dialog's own prompt
 * expansion.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { gw } = await import(path.join(here, 'p1-5-gw.mjs'));
const { attach, makeEval, save, sleep } = gw;

const WORKDIR = '/tmp/aiclient-real-gw/workspace';

const SETTINGS = `const m = await import(/* @vite-ignore */ '/stores/settings/index.ts');
  const st = m.useSettingsStore.getState();`;

const setModel = (evalAsync, section, model) =>
  evalAsync(
    `${SETTINGS}
     const setter = { commit: st.setCommitMessageGenerator, branch: st.setBranchNameGenerator, review: st.setCodeReview }[${JSON.stringify(section)}];
     setter({ model: ${JSON.stringify(model === 'auto' ? '' : model)}${section === 'branch' ? ', enabled: true' : ''} });
     await new Promise((r) => setTimeout(r, 300));
     const now = m.useSettingsStore.getState();
     const v = { commit: now.commitMessageGenerator, branch: now.branchNameGenerator, review: now.codeReview }[${JSON.stringify(section)}];
     return { enabled: v.enabled, model: v.model, effort: v.effort };`,
    { label: `set ${section} model` }
  );

const CLICK_GIT_NAV = `(() => {
  const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && ['Git'].includes((n.innerText || n.getAttribute('aria-label') || '').trim()));
  if (!b) return false;
  b.click();
  return true;
})()`;

const CONTROLS = `[...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && (b.getAttribute('title') || b.getAttribute('aria-label')))
  .map((b) => (b.getAttribute('title') || b.getAttribute('aria-label')) + (b.disabled ? ' [disabled]' : '')).slice(0, 80)`;

async function openGit(cdp) {
  await cdp.evaluate(CLICK_GIT_NAV);
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    const seen = await cdp.evaluate(`document.body.innerText.includes('calc.js')`);
    if (seen) return true;
  }
  return false;
}

async function gitStep() {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await gw.learnEndpointHost(evalAsync);
  const shown = await openGit(cdp);
  // A freshly initialised repo may need the panel's own refresh.
  if (!shown) {
    await cdp.evaluate(
      `(() => { const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && ['刷新', 'Refresh'].includes(n.getAttribute('title') || '')); if (b) b.click(); return !!b; })()`
    );
    await sleep(1500);
  }
  const out = {
    shown,
    calcVisible: await cdp.evaluate(`document.body.innerText.includes('calc.js')`),
    controls: await cdp.evaluate(CONTROLS),
  };
  cdp.close();
  save('r7-git-surface', out);
}

const COMMIT_BOX = `(() => {
  const b = [...document.querySelectorAll('button[title]')].find((n) => n.offsetParent !== null && ['生成 commit 消息', 'Generate commit message'].includes(n.getAttribute('title')));
  let ta = null;
  if (b) { let box = b.parentElement; ta = box?.querySelector('textarea') ?? null; }
  return { button: !!b, disabled: b?.disabled ?? null, value: ta ? ta.value : null };
})()`;

async function commitStep(mode, tag) {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await gw.learnEndpointHost(evalAsync);
  await openGit(cdp);
  const settings = await setModel(evalAsync, 'commit', mode);
  const before = await cdp.evaluate(COMMIT_BOX);
  if (!before.button || before.disabled) {
    cdp.close();
    save(tag, { error: 'generate button not usable', before, settings });
    return;
  }
  const toastMark = await cdp.evaluate(`document.querySelectorAll('[data-slot="toast"]').length`);
  const n = gw.spendRequest({ item: tag, model: mode, kind: 'completion: commit message' });
  const t0 = Date.now();
  await cdp.evaluate(
    `(() => { const b = [...document.querySelectorAll('button[title]')].find((n) => n.offsetParent !== null && ['生成 commit 消息', 'Generate commit message'].includes(n.getAttribute('title'))); b.click(); return true; })()`
  );
  let after = null;
  let sawBusy = false;
  while (Date.now() - t0 < 180_000) {
    await sleep(300);
    after = await cdp.evaluate(COMMIT_BOX);
    if (after.disabled) sawBusy = true;
    if (sawBusy && !after.disabled) break;
    if (!sawBusy && Date.now() - t0 > 5000 && after.value) break;
  }
  const toasts = await cdp.evaluate(
    `[...document.querySelectorAll('[data-slot="toast"]')].slice(${toastMark}).map((n) => (n.innerText || '').replace(/\\s+/g, ' ').slice(0, 300))`
  );
  const out = {
    request: n,
    mode,
    settings,
    durationMs: Date.now() - t0,
    sawBusy,
    message: after?.value ?? null,
    toasts,
  };
  cdp.close();
  save(tag, out);
}

async function branchStep(mode, tag) {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await gw.learnEndpointHost(evalAsync);
  const settings = await setModel(evalAsync, 'branch', mode);
  const n = gw.spendRequest({ item: tag, model: mode, kind: 'completion: branch name' });
  const out = await evalAsync(
    `${SETTINGS}
     const g = m.useSettingsStore.getState().branchNameGenerator;
     const now = new Date();
     const pad2 = (v) => String(v).padStart(2, '0');
     const prompt = g.prompt
       .replaceAll('{description}', '给 calc.js 增加中位数函数')
       .replaceAll('{current_date}', now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()))
       .replaceAll('{current_time}', pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds()));
     const t0 = Date.now();
     const result = await window.electronAPI.git.generateBranchName(${JSON.stringify(WORKDIR)}, { prompt, model: g.model, effort: g.effort });
     return { durationMs: Date.now() - t0, result };`,
    { label: 'branch name', timeoutMs: 200_000 }
  );
  cdp.close();
  save(tag, { request: n, mode, settings, ...out });
}

const REVIEW_STATE = `(() => {
  const d = [...document.querySelectorAll('[role="dialog"]')].filter((n) => n.getAttribute('data-open') !== null && /代码审查|Code Review/.test(n.innerText || '')).pop();
  if (!d) return null;
  const buttons = [...d.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => (b.innerText || b.getAttribute('title') || '').trim()).filter(Boolean);
  const text = d.innerText || '';
  const status = ['正在初始化', '正在审查代码', '审查完成', '审查失败', 'Initializing', 'Reviewing code', 'Review complete', 'Review failed'].find((s) => text.includes(s)) ?? null;
  return { status, buttons, length: text.length, head: text.slice(0, 200) };
})()`;

const clickDialogButton = (labels) => `(() => {
  const d = [...document.querySelectorAll('[role="dialog"]')].filter((n) => n.getAttribute('data-open') !== null && /代码审查|Code Review/.test(n.innerText || '')).pop();
  if (!d) return 'no dialog';
  const b = [...d.querySelectorAll('button')].find((n) => n.offsetParent !== null && ${JSON.stringify(labels)}.includes((n.innerText || '').trim()));
  if (!b) return 'no button';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`;

async function reviewStep(mode, tag, stopAfterChars = '') {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await gw.learnEndpointHost(evalAsync);
  await openGit(cdp);
  const settings = await setModel(evalAsync, 'review', mode);
  const opened = await cdp.evaluate(
    `(() => { const b = [...document.querySelectorAll('button[aria-label]')].find((n) => n.offsetParent !== null && ['开始代码审查', 'Start code review', '查看代码审查', 'View code review'].includes(n.getAttribute('aria-label'))); if (!b) return false; b.click(); return true; })()`
  );
  await sleep(1200);
  const ready = await cdp.evaluate(REVIEW_STATE);
  // A finished earlier review offers 「重新审查」; a fresh one 「开始代码审查」.
  const n = gw.spendRequest({
    item: tag,
    model: mode,
    kind: stopAfterChars ? 'completion: code review (stopped midway)' : 'completion: code review',
  });
  const t0 = Date.now();
  const started = await cdp.evaluate(
    clickDialogButton(['开始代码审查', 'Start code review', '重新审查', 'Re-review'])
  );
  await sleep(500);
  // Re-review may ask to confirm.
  await cdp.evaluate(
    `(() => { const b = [...document.querySelectorAll('[role="alertdialog"] button')].find((n) => ['重新开始', 'Restart'].includes((n.innerText || '').trim())); if (b) b.click(); return !!b; })()`
  );
  const trace = [];
  let stoppedAt = null;
  let last = null;
  let firstContentMs = null;
  const content = () =>
    evalAsync(
      `const m = await import(/* @vite-ignore */ '/stores/codeReview.ts'); const r = m.useCodeReviewStore.getState().review; return { status: r.status, len: (r.content || '').length, error: r.error ?? null };`,
      { label: 'review store' }
    );
  while (Date.now() - t0 < 300_000) {
    await sleep(400);
    last = await content();
    if (trace.at(-1)?.status !== last.status)
      trace.push({ dt: Date.now() - t0, status: last.status, len: last.len });
    if (firstContentMs === null && last.len > 0) firstContentMs = Date.now() - t0;
    if (stopAfterChars && stoppedAt === null && last.len >= Number(stopAfterChars)) {
      const r = await cdp.evaluate(clickDialogButton(['停止', 'Stop']));
      stoppedAt = { dt: Date.now() - t0, len: last.len, click: r };
    }
    if (['complete', 'error', 'idle'].includes(last.status) && Date.now() - t0 > 1500) break;
    if (stoppedAt && Date.now() - t0 > stoppedAt.dt + 8000) break;
  }
  // After a stop: does the content keep growing?
  let afterStop = null;
  if (stoppedAt) {
    const a = await content();
    await sleep(4000);
    const b = await content();
    afterStop = {
      lenAtStop: stoppedAt.len,
      lenAfter: a.len,
      lenAfter4s: b.len,
      status: b.status,
      error: b.error,
    };
  }
  const final = await evalAsync(
    `const m = await import(/* @vite-ignore */ '/stores/codeReview.ts'); const r = m.useCodeReviewStore.getState().review; return { status: r.status, len: (r.content || '').length, head: (r.content || '').slice(0, 600), error: r.error ?? null };`,
    { label: 'review final' }
  );
  const dialog = await cdp.evaluate(REVIEW_STATE);
  // Close the modal (minimise keeps it running; close only when finished).
  await gw.pressEscape(cdp);
  cdp.close();
  save(tag, {
    request: n,
    mode,
    settings,
    opened,
    ready,
    started,
    durationMs: Date.now() - t0,
    firstContentMs,
    trace,
    stoppedAt,
    afterStop,
    final,
    dialog,
  });
}

const steps = {
  git: gitStep,
  commit: commitStep,
  branch: branchStep,
  review: reviewStep,
};

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const name = process.argv[2];
  if (!steps[name]) {
    console.error(`usage: p1-5-r7.mjs ${Object.keys(steps).join('|')}`);
    process.exit(2);
  }
  await steps[name](...process.argv.slice(3));
  process.exit(0);
}
