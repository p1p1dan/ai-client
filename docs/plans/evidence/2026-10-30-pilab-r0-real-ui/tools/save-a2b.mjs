#!/usr/bin/env node
/**
 * save-a2b.mjs — #10 in the real window: does a stale editor save refuse to
 * overwrite a file changed on disk (A→B)?
 *
 *   node save-a2b.mjs [file-name] [--keep-mine]   (file lands in <scratch>/workspace)
 *
 * Steps: write A; open it through the real file-open intent (the path a tool
 * row / markdown link uses); type into Monaco with CDP input; write B from
 * outside the app; press Ctrl+S on Monaco; read the disk back. Prints the
 * store tab state, toasts and renderer problems at each step.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const { Cdp, sleep } = await import(path.join(repoRoot, 'scripts/h21-cdp.mjs'));
const SCRATCH = process.env.P17D_SCRATCH ?? '/tmp/pilab-r0';
const name = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'r0-save-a2b.txt';
const file = path.join(SCRATCH, 'workspace', name);

const cdp = await Cdp.attach(9222, 30_000);
cdp.collectRendererProblems();
const tab = async () =>
  cdp.evaluate(`(() => {
    const st = window.__pilabEditorStore?.getState();
    const t = st?.tabs.find((x) => x.path === ${JSON.stringify(file)});
    return t ? { active: st.activeTabPath === t.path, content: t.content, baseContent: t.baseContent,
      isDirty: t.isDirty, hasExternalChange: !!t.hasExternalChange, externalContent: t.externalContent ?? null } : null;
  })()`);
const toasts = () =>
  cdp.evaluate(
    `[...document.querySelectorAll('[data-slot="toast-title"], [data-slot="toast-description"]')].map((n) => n.innerText).join(' | ')`
  );
const pump = async (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await cdp
      .send('Page.captureScreenshot', { format: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })
      .catch(() => undefined);
  }
};
const report = {};

fs.writeFileSync(file, 'A\n');
await cdp.evaluate(`(() => {
  (async () => {
    const editor = await import('/stores/editor.ts');
    window.__pilabEditorStore = editor.useEditorStore;
    const intent = await import('/stores/fileOpenIntent.ts');
    intent.useFileOpenIntentStore.getState().requestFileOpen({ path: ${JSON.stringify(file)}, source: 'markdown' });
  })();
  return true;
})()`);
await pump(2500);
await cdp.waitFor(`!!window.__pilabEditorStore?.getState().tabs.find((x) => x.path === ${JSON.stringify(file)} && x.content === 'A\\n')`, {
  timeoutMs: 20_000,
  label: 'tab opened with A',
});
await cdp.waitFor(`!!document.querySelector('.monaco-editor textarea')`, { timeoutMs: 20_000, label: 'monaco mounted' });
report.opened = await tab();

// Type at the start of the document.
await cdp.evaluate(`(() => { (document.querySelector('.monaco-editor .native-edit-context') ?? document.querySelector('.monaco-editor textarea')).focus(); return true; })()`);
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
await cdp.send('Input.insertText', { text: 'edit-' });
await pump(800);
report.edited = await tab();

// External A→B.
fs.writeFileSync(file, 'B\n');
await pump(2500);
report.afterExternal = await tab();

// Ctrl+S on Monaco.
await cdp.evaluate(`(() => { (document.querySelector('.monaco-editor .native-edit-context') ?? document.querySelector('.monaco-editor textarea')).focus(); return true; })()`);
await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
await pump(2000);
report.afterSave = await tab();
report.disk = fs.readFileSync(file, 'utf8');
report.toasts = await toasts();
report.banner = await cdp.evaluate(`document.body.innerText.includes('文件已被外部修改')`);
{
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve(here, '../shots/save-a2b-conflict-prompt.png'), Buffer.from(data, 'base64'));
}

// --keep-mine: choose 「保留本地」 on the banner, then save again (a deliberate overwrite).
if (process.argv.includes('--keep-mine')) {
  report.keepMineClicked = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '保留本地');
    b?.click();
    return !!b;
  })()`);
  await pump(600);
  report.afterKeepMine = await tab();
  await cdp.evaluate(`(() => { (document.querySelector('.monaco-editor .native-edit-context') ?? document.querySelector('.monaco-editor textarea')).focus(); return true; })()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await pump(2000);
  report.afterKeepMineSave = await tab();
  report.diskAfterKeepMine = fs.readFileSync(file, 'utf8');
}
report.problems = cdp.problems.slice(0, 8).map((p) => ({ ...p, text: p.text.split(repoRoot).join('<repo>').slice(0, 300) }));
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
const shot = path.resolve(here, '../shots/save-a2b-conflict.png');
fs.writeFileSync(shot, Buffer.from(data, 'base64'));
report.shot = path.relative(repoRoot, shot);
cdp.close();
console.log(JSON.stringify(report, null, 2).split(SCRATCH).join('<scratch>'));
await sleep(0);
process.exit(0);
