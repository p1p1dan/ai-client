// Run with: node scripts/verify-question-layout.mjs
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
const probeDir = await mkdtemp(path.join(tmpdir(), 'aiclient-question-probe-'));

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
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
  const click = async (selector) => {
    const { x, y } = await evaluate(
      `(() => { const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`
    );
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await settle();
  };
  const results = [];
  await settle();
  for (const width of [360, 800]) {
    await evaluate(
      `document.getElementById('root').style.width='${width}px';window.showQuestion()`
    );
    await settle();
    const geometry = await evaluate(
      `(() => {const e=document.querySelector('[role=radio]');const r=e.getBoundingClientRect();return {height:r.height,client:e.clientWidth,scroll:e.scrollWidth};})()`
    );
    assert.ok(geometry.height > 40, 'long option must grow');
    assert.ok(geometry.scroll <= geometry.client + 2, 'long option must wrap');
    await click('[role=radio]');
    assert.equal(
      await evaluate(`document.querySelector('[role=radio]').getAttribute('aria-checked')`),
      'true'
    );
    await evaluate(
      `Array.from(document.querySelectorAll('#root button')).find(button=>button.textContent.includes('Continue')).id='submit'`
    );
    await click('#submit');
    assert.equal(await evaluate('window.answers.length'), width === 360 ? 1 : 2);
    await evaluate('window.showExtension()');
    await settle();
    const extension = await evaluate(
      `(() => {const e=document.querySelector('[role=group] button');const r=e.getBoundingClientRect();return {height:r.height,client:e.clientWidth,scroll:e.scrollWidth};})()`
    );
    assert.ok(extension.height > 40, 'extension options must grow at desktop breakpoints too');
    assert.ok(extension.scroll <= extension.client + 2, 'extension option must wrap');
    await click('[role=group] button');
    assert.equal(await evaluate('window.extensionAnswers.length'), width === 360 ? 1 : 2);
    results.push(`real mouse selection/submission and wrapped layout at ${width}px`);
  }
  await evaluate("window.showQuestion();document.getElementById('root').style.width='360px'");
  await settle();
  await require('node:fs/promises').writeFile(
    '/tmp/aiclient-question-card.png',
    (await window.webContents.capturePage()).toPNG()
  );
  console.log(JSON.stringify({ passed: results }));
  window.destroy();
  app.quit();
}

try {
  const sourceFiles = [
    'src/renderer/components/ui/button.tsx',
    'src/renderer/components/chat/QuestionCard.tsx',
    'src/renderer/components/chat/ExtensionUiDialog.tsx',
    'src/renderer/components/chat/questionCardModel.ts',
    'src/renderer/components/ui/input.tsx',
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
        import {QuestionCard} from '@/components/chat/QuestionCard';
        import {ExtensionUiInlineDock} from '@/components/chat/ExtensionUiDialog';
        import {useExtensionUiStore} from '@/stores/extensionUi';
        const root=createRoot(document.getElementById('root'));
        window.answers=[];window.extensionAnswers=[];
        window.electronAPI={chat:{respondExtensionUi:async value=>window.extensionAnswers.push(value)}};
        let id=0;
        window.showQuestion=()=>root.render(<QuestionCard key={++id} variant="interactive" block={{id:'q',questionId:'q',type:'question',questions:[{question:'请选择当前项目采用的技术方案，并说明后续迁移约束。'.repeat(2),options:[{label:'保留 Qt 6.8 + QML —— 维持现有接口、部署与现场验证方式，工作模式画面保持可读。'.repeat(4),description:'现有代码可以继续复用，后续另行安排迁移。'},{label:'其他方案'}]}]}} onSubmit={async value=>{window.answers.push(value);return false;}} onSkip={async()=>false} />);
        window.showExtension=()=>{useExtensionUiStore.setState({pending:[{runtimeId:'r',sessionId:'s',uiRequestId:'q'+(++id),receivedAt:0,dialog:{method:'select',title:'[UI 技术栈] 当前项目采用哪种方案？',options:['保持 Qt 6.8 + QML（推荐）—— 保留现有工具链和部署方式。'.repeat(8),'自由输入其他方案']}}],sending:[],sendErrors:{}});root.render(<ExtensionUiInlineDock sessionId="s"/>);};
        window.showQuestion();
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
    '<link rel="stylesheet" href="style.css"><div id="root" style="margin:20px;width:360px"></div><script src="bundle.js"></script>'
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
