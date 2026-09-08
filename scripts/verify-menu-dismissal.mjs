// Run with: node scripts/verify-menu-dismissal.mjs
// Uses the installed Electron and real Tailwind CSS; Linux needs DISPLAY (or Xvfb).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import electron from 'electron';
import { build } from 'esbuild';

const repo = fileURLToPath(new URL('../', import.meta.url));
const probeDir = await mkdtemp(path.join(tmpdir(), 'aiclient-menu-dismissal-'));

async function runBrowserChecks() {
  const { app, BrowserWindow } = require('electron');
  const assert = require('node:assert/strict');
  const path = require('node:path');
  app.setPath('userData', path.join(__dirname, 'user-data'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const window = new BrowserWindow({
    show: true,
    width: 1000,
    height: 750,
    webPreferences: { backgroundThrottling: false },
  });
  await window.loadFile(path.join(__dirname, 'index.html'));
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 220));
  const trigger = 'button[aria-haspopup="menu"]';
  const row = (index) => `[role="menuitemradio"]:nth-child(${index + 1})`;
  const click = async (selector) => {
    const { x, y } = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  const open = async () => {
    await click(trigger);
    await settle();
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(trigger)}).getAttribute('aria-expanded')`
      ),
      'true'
    );
  };
  const assertClosed = async () => {
    await settle();
    assert.equal(
      await evaluate(
        `document.querySelectorAll('[data-slot="menu-popup"], [data-slot="menu-positioner"], [data-base-ui-portal]').length`
      ),
      0
    );
    const previous = await evaluate('window.outsideClicks');
    await click('#outside');
    assert.equal(await evaluate('window.outsideClicks'), previous + 1);
  };
  const results = [];
  await settle();
  for (const index of [0, 1, 2, 2, 0, 1]) {
    await open();
    await click(row(index));
    await assertClosed();
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(trigger)}).textContent`),
      ['Read-only', 'Pragmatic', 'Hands-off'][index]
    );
  }
  results.push('tier changes, same-tier selection, repeated opening, outside interaction');

  await open();
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await assertClosed();
  await open();
  await click('#outside');
  await assertClosed();
  results.push('Escape and outside dismissal');

  await open();
  await click(row(3));
  await settle();
  assert.equal(await evaluate('window.tierRequests.at(-1).tier'), 'pragmatic');
  await click('[data-slot="menu-popup"] button:first-of-type');
  await settle();
  assert.equal(await evaluate('document.querySelectorAll("[role=menuitemradio]").length'), 4);
  await click(row(3));
  await settle();
  await click('[data-slot="menu-popup"] button:last-of-type');
  await assertClosed();
  assert.equal(await evaluate('window.tierRequests.at(-1).tier'), 'fullopen');
  results.push('full access confirmation, cancel and apply');

  // Close during the opening transition: this used to cancel the animation
  // awaited by Base UI when the newly selected radio indicator was removed.
  await click(trigger);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await click(row(0));
  await assertClosed();
  results.push('selection during opening animation');

  console.log(JSON.stringify({ passed: results }));
  window.destroy();
  app.quit();
}

try {
  const sourceFiles = [
    'src/renderer/components/ui/menu.tsx',
    'src/renderer/components/chat/middleColumnLayout.ts',
    'src/renderer/components/chat/ComposerPermissionTrigger.tsx',
  ];
  const sources = await Promise.all(
    sourceFiles.map((file) => readFile(path.join(repo, file), 'utf8'))
  );
  const css = await compile(
    await readFile(path.join(repo, 'src/renderer/styles/globals.css'), 'utf8'),
    {
      base: path.join(repo, 'src/renderer/styles'),
      onDependency() {},
    }
  );
  const bundle = await build({
    stdin: {
      contents: `
        import { createRoot } from 'react-dom/client';
        import { ComposerPermissionTrigger } from '@/components/chat/ComposerPermissionTrigger';
        window.outsideClicks = 0;
        window.tierRequests = [];
        window.electronAPI = { chat: { setPermissionTier: async value => { window.tierRequests.push(value); } } };
        createRoot(document.getElementById('root')).render(<>
          <button id="outside" onClick={() => window.outsideClicks++}>Outside</button>
          <ComposerPermissionTrigger sessionId="menu-probe" hostState="ready" mode="session" />
        </>);
      `,
      resolveDir: repo,
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { '@': path.join(repo, 'src/renderer'), '@shared': path.join(repo, 'src/shared') },
    plugins: [
      {
        name: 'probe-i18n',
        setup(builder) {
          builder.onResolve({ filter: /^@\/i18n$/ }, () => ({ path: 'i18n', namespace: 'probe' }));
          builder.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({
            contents: 'export const useI18n = () => ({ t: key => key });',
          }));
        },
      },
    ],
  });
  await writeFile(path.join(probeDir, 'bundle.js'), bundle.outputFiles[0].text);
  await writeFile(
    path.join(probeDir, 'style.css'),
    css.build(new Scanner({}).scanFiles(sources.map((content) => ({ content, extension: 'tsx' }))))
  );
  await writeFile(
    path.join(probeDir, 'index.html'),
    '<link rel="stylesheet" href="style.css"><div id="root" style="margin:250px 100px"></div><script src="bundle.js"></script>'
  );
  await writeFile(
    path.join(probeDir, 'main.cjs'),
    `(${runBrowserChecks.toString()})().catch(error => { console.error(error); require('electron').app.exit(1); });`
  );
  const args = ['--no-sandbox', '--disable-gpu'];
  args.push(path.join(probeDir, 'main.cjs'));
  const { ELECTRON_RUN_AS_NODE: _nodeMode, ...env } = process.env;
  const child = spawn(electron, args, { stdio: 'inherit', env });
  const timeout = setTimeout(() => child.kill(), 30000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0, 'Electron menu dismissal checks failed');
  } finally {
    clearTimeout(timeout);
  }
} finally {
  await rm(probeDir, { recursive: true, force: true });
}
