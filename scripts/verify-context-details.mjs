// Run with: node scripts/verify-context-details.mjs
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
const probeDir = await mkdtemp(path.join(tmpdir(), 'aiclient-context-probe-'));

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
  await settle();
  for (const width of [430, 1000]) {
    window.setSize(width, 750);
    await settle();
    const point = await evaluate(
      `(() => {const r=document.querySelector('[data-slot=tooltip-trigger]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`
    );
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    await settle();
    await settle();
    const panel = await evaluate(
      `(() => {const e=document.querySelector('[data-context-details]');const r=e.getBoundingClientRect();return {text:e.textContent,left:r.left,right:r.right,bottom:r.bottom,top:r.top,viewport:innerWidth};})()`
    );
    assert.ok(
      panel.text.includes('479.0k') && panel.text.includes('96%'),
      'actual usage breakdown'
    );
    assert.ok(
      panel.left >= 0 && panel.right <= panel.viewport && panel.top >= 0 && panel.bottom <= 750,
      'tooltip stays inside window'
    );
    window.webContents.sendInputEvent({ type: 'mouseMove', x: width - 20, y: 20 });
    await settle();
    results.push(`context hover details and viewport bounds at ${width}px`);
  }
  await evaluate(`document.querySelector('[data-slot=tooltip-trigger]').focus()`);
  await settle();
  await require('node:fs/promises').writeFile(
    '/tmp/aiclient-context-details.png',
    (await window.webContents.capturePage()).toPNG()
  );
  console.log(JSON.stringify({ passed: results }));
  window.destroy();
  app.quit();
}

try {
  const sourceFiles = [
    'src/renderer/components/chat/ComposerUsageChip.tsx',
    'src/renderer/components/ui/tooltip.tsx',
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
        import {createRoot} from 'react-dom/client';
        import {TooltipProvider} from '@/components/ui/tooltip';
        import {ComposerUsageChip} from '@/components/chat/ComposerUsageChip';
        import {useSessionRuntimeFactsStore} from '@/stores/sessionRuntimeFacts';
        useSessionRuntimeFactsStore.setState({factsBySession:{s:{usage:{input:20000,output:79,cacheRead:128,cacheWrite:0,totalTokens:20207,costUsd:0,context:{tokens:21000,contextWindow:500000,percent:4.2},session:{turns:3,toolResults:0,input:40000,output:200,cacheRead:128,cacheWrite:0,totalTokens:40328,costUsd:0}}}}});
        createRoot(document.getElementById('root')).render(<TooltipProvider delay={0}><ComposerUsageChip sessionId="s" /></TooltipProvider>);
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
            contents: `export const useI18n = () => ({ t: (key, params) => key.replace(/\\{\\{(\\w+)\\}\\}/g, (_,name) => params?.[name] ?? name) });`,
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
    '<link rel="stylesheet" href="style.css"><div id="root" style="position:absolute;left:20px;bottom:20px"></div><script src="bundle.js"></script>'
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
