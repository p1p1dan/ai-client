#!/usr/bin/env node
/**
 * diff-a2b.mjs — #10 in the real window, Diff entry: edit the modified side of
 * a working-tree diff, change the file on disk (A→B), press Ctrl+S.
 *
 * Needs the scratch workspace to be a git repo (this script runs `git init`
 * there on first use — /tmp scratch only). File: <scratch>/workspace/r0-diff-<ts>.txt.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const { Cdp, sleep } = await import(path.join(repoRoot, 'scripts/h21-cdp.mjs'));
const SCRATCH = process.env.P17D_SCRATCH ?? '/tmp/pilab-r0';
const ws = path.join(SCRATCH, 'workspace');
if (!ws.startsWith('/tmp/')) throw new Error('refusing to git init outside /tmp');
// A fresh name per run: a reused path reopens on the previous run's cached diff.
const rel = `r0-diff-${Date.now()}.txt`;
const file = path.join(ws, rel);
const git = (...args) =>
  execFileSync('git', ['-C', ws, '-c', 'user.name=r0', '-c', 'user.email=r0@example.invalid', ...args], {
    encoding: 'utf8',
  });
if (!fs.existsSync(path.join(ws, '.git'))) git('init', '-q');
fs.writeFileSync(file, 'base\n');
git('add', '-A');
git('commit', '-q', '-m', 'r0 base', '--allow-empty');
fs.writeFileSync(file, 'A\n');

const cdp = await Cdp.attach(9222, 30_000);
cdp.collectRendererProblems();
const pump = async (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await cdp
      .send('Page.captureScreenshot', { format: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } })
      .catch(() => undefined);
  }
};
const toasts = () =>
  cdp.evaluate(
    `[...document.querySelectorAll('[data-slot="toast-title"], [data-slot="toast-description"]')].map((n) => n.innerText).join(' | ')`
  );
const report = {};
const MODIFIED_LINES = `[...document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line')].map((l) => l.innerText)`;

await cdp.evaluate(`(() => {
  (async () => {
    const editor = await import('/stores/editor.ts');
    editor.useEditorStore.getState().closeAllFiles();
    editor.useEditorStore.getState().openDiffTab({ kind: 'workdir', path: ${JSON.stringify(rel)}, staged: false });
  })();
  return true;
})()`);
await pump(3000);
await cdp.waitFor(`document.querySelectorAll('.monaco-diff-editor .monaco-editor').length >= 2`, {
  timeoutMs: 30_000,
  label: 'diff editor mounted',
});
report.editButton = await cdp.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.title === '编辑文件' || x.title === 'Edit file');
  b?.click();
  return b ? b.title : null;
})()`);
await pump(1000);
// The modified side: Monaco's \`.editor.modified\` pane (the diff editor root is a .monaco-editor too).
await cdp.evaluate(`(() => {
  const ed = document.querySelector('.monaco-diff-editor .editor.modified .monaco-editor');
  (ed.querySelector('.native-edit-context') ?? ed.querySelector('textarea')).focus();
  return true;
})()`);
await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
await cdp.send('Input.insertText', { text: 'diff-edit-' });
await pump(800);
report.modifiedLines = await cdp.evaluate(
  MODIFIED_LINES
);

fs.writeFileSync(file, 'B\n');
await pump(4000);
report.afterExternalLines = await cdp.evaluate(MODIFIED_LINES);
await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
await pump(1500);
report.disk = fs.readFileSync(file, 'utf8');
report.toasts = await toasts();
report.problems = cdp.problems.slice(0, 6).map((p) => p.text.split(repoRoot).join('<repo>').slice(0, 200));
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
const shot = path.resolve(here, '../shots/diff-a2b-conflict.png');
fs.writeFileSync(shot, Buffer.from(data, 'base64'));
report.shot = path.relative(repoRoot, shot);
cdp.close();
console.log(JSON.stringify(report, null, 2).split(SCRATCH).join('<scratch>'));
await sleep(0);
process.exit(0);
