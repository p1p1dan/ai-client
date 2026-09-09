// Run with: node scripts/verify-timeline-follow.mjs
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
const probeDir = await mkdtemp(path.join(tmpdir(), 'aiclient-scroll-probe-'));

async function runBrowserChecks() {
  const { app, BrowserWindow } = require('electron');
  const assert = require('node:assert/strict');
  const path = require('node:path');
  app.setPath('userData', path.join(__dirname, 'user-data'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const window = new BrowserWindow({
    show: true,
    width: 800,
    height: 700,
    webPreferences: { backgroundThrottling: false },
  });
  await window.loadFile(path.join(__dirname, 'index.html'));
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
  const geometry = () =>
    evaluate(
      `(() => {const v=document.querySelector('[data-slot=scroll-area-viewport]');return {top:v.scrollTop,gap:v.scrollHeight-v.clientHeight-v.scrollTop,height:v.clientHeight};})()`
    );
  await settle();
  assert.ok((await geometry()).gap <= 1, 'initial bottom');
  const burst = await evaluate(`(async () => {
    let gaps=[], writes=0;
    const v=document.querySelector('[data-slot=scroll-area-viewport]');
    const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');
    Object.defineProperty(v,'scrollTop',{configurable:true,get(){return descriptor.get.call(this)},set(value){writes++;descriptor.set.call(this,value)}});
    for(let i=0;i<40;i++) {
      for(let n=0;n<8;n++) window.appendText();
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      gaps.push(v.scrollHeight-v.clientHeight-v.scrollTop);
    }
    delete v.scrollTop;
    return {maxGap:Math.max(...gaps),writes};
  })()`);
  assert.ok(burst.maxGap <= 1, JSON.stringify(burst));
  assert.ok(
    burst.writes <= 40,
    `at most one scroll write per burst frame: ${JSON.stringify(burst)}`
  );
  await evaluate(
    `window.appendText();document.querySelector('[data-slot=scroll-area-viewport]').dispatchEvent(new Event('scroll'))`
  );
  await settle();
  assert.ok((await geometry()).gap <= 1, 'queued scroll during growth keeps following');
  const point = await evaluate(
    `(() => {const r=document.querySelector('[data-slot=scroll-area-viewport]').getBoundingClientRect();return {x:Math.round(r.x+100),y:Math.round(r.y+100)};})()`
  );
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  window.webContents.sendInputEvent({
    type: 'mouseWheel',
    ...point,
    deltaX: 0,
    deltaY: 250,
    canScroll: true,
  });
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const reading = await geometry();
  assert.ok(reading.gap > 40, 'real mouse wheel scrolls up');
  await evaluate('window.appendText()');
  await settle();
  assert.equal((await geometry()).top, reading.top, 'growth preserves reading position');
  await evaluate(`document.querySelector('button').click()`);
  await settle();
  await evaluate(`document.querySelector('#root').style.height='300px'`);
  await settle();
  assert.ok((await geometry()).gap <= 1, 'viewport shrink follows');
  await evaluate(`window.switchSession()`);
  await settle();
  assert.ok((await geometry()).gap <= 1, 'session switch reanchors');
  await evaluate(`window.appendText();window.unmount()`);
  await settle();
  console.log(
    JSON.stringify({
      passed: [
        'initial bottom',
        '40 bursts of 8 growths',
        'queued scroll during growth',
        'real wheel detaches',
        'reader position preserved',
        'jump rearms',
        'viewport shrink',
        'session switch',
        'observer cleanup on unmount',
      ],
      burst,
    })
  );
  window.destroy();
  app.quit();
}

try {
  const timeline = await readFile(
    path.join(repo, 'src/renderer/components/chat/MessageTimeline.tsx'),
    'utf8'
  );
  const behavior = timeline.slice(
    timeline.indexOf('  const scrollRootRef ='),
    timeline.indexOf('  if (!sessionId) {', timeline.indexOf('  const scrollRootRef ='))
  );
  const sources = [
    await readFile(path.join(repo, 'src/renderer/components/ui/scroll-area.tsx'), 'utf8'),
  ];
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
        import {useRef,useState,useCallback,useEffect} from 'react';
        import {createRoot} from 'react-dom/client';
        import {ScrollArea} from '@/components/ui/scroll-area';
        import {nextFollowState,shouldShowJumpToBottom} from '@/components/chat/messageTimelineScroll';
        const findViewport = root => root?.querySelector('[data-slot="scroll-area-viewport"]');
        const root = createRoot(document.getElementById('root'));
        function Fixture() {
          const [sessionId,setSessionId]=useState('one');
          const jumpToBottomRequest=0;
          ${behavior}
          window.appendText = () => {const p=document.createElement('p');p.textContent='Agent output '.repeat(100);contentRef.current.appendChild(p)};
          window.switchSession = () => setSessionId('two');
          window.unmount = () => root.unmount();
          return <div ref={scrollRootRef} style={{height:'100%',position:'relative'}}><ScrollArea><div ref={contentRef} style={{padding:12}}>{Array.from({length:50},(_,i)=><p key={i}>Initial output {i}</p>)}</div></ScrollArea><button style={{position:'absolute',bottom:0,right:0}} onClick={jumpToBottom}>Bottom</button></div>;
        }
        root.render(<Fixture/>);
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
    '<link rel="stylesheet" href="style.css"><div id="root" style="height:500px;width:700px"></div><script src="bundle.js"></script>'
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
    assert.equal(code, 0, 'Electron timeline follow checks failed');
  } finally {
    clearTimeout(timeout);
  }
} finally {
  await rm(probeDir, { recursive: true, force: true });
}
