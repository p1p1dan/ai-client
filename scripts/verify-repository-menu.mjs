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
const probeDir = await mkdtemp(path.join(tmpdir(), 'aiclient-repo-menu-'));

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
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));
  const results = [];
  const clickAt = async (x, y) => {
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await settle();
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await settle();
    window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await settle();
  };
  const bounds = (selector) =>
    evaluate(
      `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`
    );
  const click = async (selector) => {
    const { x, y } = await bounds(selector);
    await clickAt(x, y);
  };
  await settle();
  const open = async () => {
    await click('#header');
    const before = await bounds('[aria-label="Repository actions"]');
    await clickAt(before.x, before.y);
    const after = await bounds('[aria-label="Repository actions"]');
    assert.equal(before.x, after.x, 'trigger must not move after mouse down/up');
    assert.equal(
      await evaluate(
        `document.querySelector('[aria-label="Repository actions"]').getAttribute('aria-expanded')`
      ),
      'true'
    );
  };
  await open();
  assert.equal(
    await evaluate(
      `document.querySelector('[data-slot="menu-popup"]').contains(document.activeElement)`
    ),
    true,
    'open menu owns focus'
  );
  await click('[role="menuitem"]');
  assert.equal(await evaluate('window.actions'), 1);
  assert.equal(await evaluate('document.querySelectorAll("[data-slot=menu-popup]").length'), 0);
  await open();
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await settle();
  assert.equal(await evaluate('document.querySelectorAll("[data-slot=menu-popup]").length'), 0);
  assert.equal(
    await evaluate(
      `document.activeElement === document.querySelector('[aria-label="Repository actions"]')`
    ),
    true,
    'Escape returns focus to trigger'
  );
  await open();
  await click('#outside');
  assert.equal(await evaluate('document.querySelectorAll("[data-slot=menu-popup]").length'), 0);
  assert.equal(
    await evaluate(
      'document.querySelectorAll("[data-base-ui-portal], .fixed.inset-0.z-40").length'
    ),
    0
  );
  results.push('repository focus, mouse down/up, item action, Escape, outside dismissal');
  console.log(JSON.stringify({ passed: results }));
  window.destroy();
  app.quit();
}

try {
  const sourceFiles = [
    'src/renderer/components/ui/menu.tsx',
    'src/renderer/components/chat/middleColumnLayout.ts',
    'src/renderer/components/workspace-shell/LeftNav.tsx',
    'src/renderer/components/ui/button.tsx',
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
        import { Menu, MenuTrigger, MenuPopup, MenuItem } from '@/components/ui/menu';
        import { Button } from '@/components/ui/button';
        import { MoreHorizontal, Settings, FolderMinus, Plus } from 'lucide-react';
        const workspaces = [{id:'ws',path:'/repo'}]; const folderRepo = {}; const newSessionWorkspaceId = 'ws'; const t = key => key;
        const setRepoToConfigure = () => window.actions++; const setRepoToRemove = () => window.actions++;
        const onRemoveRepository = true; const createChatSessionOnWorkspace = () => {};
        window.actions = 0;
        createRoot(document.getElementById('root')).render(<>
          <button id="outside">Outside</button>
          <div id="header" className="group flex h-7 w-full items-center gap-1 rounded-md px-2 text-ui hover:bg-hover" style={{width:280}}>
            <button className="flex min-w-0 flex-1">Project</button>
            ${(() => {
              const nav = sources[2];
              return nav
                .slice(
                  nav.indexOf('{folderRepo && ('),
                  nav.indexOf('\n                    </div>', nav.indexOf('{folderRepo && ('))
                )
                .replace(
                  '<Menu>',
                  '<Menu onOpenChange={(open, details) => console.log(open, details.reason)}>'
                );
            })()}
          </div>
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
    define: { 'process.env.NODE_ENV': '"development"' },
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
