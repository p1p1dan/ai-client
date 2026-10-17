#!/usr/bin/env node
/**
 * Route B: dev-GUI point-check of the Claude Agent SDK engine (S-1 checklist in
 * docs/plantree/plans/claude-sdk-engine/topics/s1-engine-selection.md §3).
 *
 *   node gui-probe.mjs setup        scratch dirs and a fake-only env file
 *   node gui-probe.mjs launch       `node scripts/dev.js --remote-debugging-port=<port>` (detached);
 *                                   CCSDK_GUI_KEEP_RENDERING=1 keeps the page rendering behind other windows
 *   node gui-probe.mjs enter        attach CDP, get past the welcome surface
 *   node gui-probe.mjs seed         add the fake gateway as two custom AI services (fake keys):
 *                                   an anthropic-messages one with two Claude models and a GLM
 *                                   (all on the SDK engine: the protocol decides)
 *                                   and an openai-completions one with a GLM model (DSH)
 *   node gui-probe.mjs look         what is on screen
 *   node gui-probe.mjs send <text>  type into the composer and send
 *   node gui-probe.mjs click <text> click the visible button with that text
 *   node gui-probe.mjs eval <js>    evaluate in the renderer (async body, `return` a value)
 *   node gui-probe.mjs shot <name>  screenshot into the scratch dir
 *   node gui-probe.mjs stop         stop the dev app tree
 *
 * Isolation: HOME and USERPROFILE point at a scratch home, so the app's
 * `~/.pilab` profile, vault and any `~/.claude` it might look at are scratch
 * copies; `AICLIENT_PROFILE` keeps userData apart too; `AICLIENT_DEV_ENV_FILE`
 * points at a scratch env file with fake values only (the real dev.env is never
 * read). Every model request goes to the local fake gateway (`--plan claude-sdk`).
 * No real credential is read or written anywhere.
 *
 * CDP mechanics: scripts/h21-cdp.mjs and the batch-h pc-lib.mjs.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const { Cdp, ENTER_MAIN_SURFACE, sleep } = await import(
  pathToFileURL(path.join(repoRoot, 'scripts/h21-cdp.mjs')).href
);
// The batch-h pc-lib.mjs helpers this driver needs, inlined: that file imports
// h21-cdp.mjs by an absolute Linux path.
const SEND_LABEL = '发送消息';
let evalSlot = 0;
const pc = {
  makeEval(cdp, prefix) {
    return async function evalAsync(body, { timeoutMs = 120_000, label = 'evalAsync' } = {}) {
      const key = `__${prefix}_${evalSlot++}`;
      await cdp.evaluate(`(() => {
        window.${key} = null;
        (async () => { ${body} })()
          .then((value) => { window.${key} = { done: true, value }; })
          .catch((error) => { window.${key} = { done: true, error: String(error?.stack ?? error?.message ?? error) }; });
        return true;
      })()`);
      const out = await cdp.waitFor(`window.${key}?.done ? window.${key} : null`, {
        timeoutMs,
        label,
      });
      if (out.error) throw new Error(`${label}: ${out.error}`);
      return out.value;
    };
  },
  async shoot(cdp, dir, name) {
    fs.mkdirSync(dir, { recursive: true });
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  },
  typeIntoComposer: (text) => `(() => {
    const ta = document.querySelector('textarea');
    if (!ta) throw new Error('no composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value.length;
  })()`,
  SEND_READY: `(() => {
    const b = [...document.querySelectorAll('button[aria-label]')]
      .find((n) => n.getAttribute('aria-label') === ${JSON.stringify(SEND_LABEL)});
    return !!b && !b.disabled && b.offsetParent !== null;
  })()`,
  CLICK_SEND: `(() => {
    const b = [...document.querySelectorAll('button[aria-label]')]
      .find((n) => n.getAttribute('aria-label') === ${JSON.stringify(SEND_LABEL)});
    if (!b) throw new Error('no send button');
    if (b.disabled) throw new Error('send button is disabled');
    b.click();
    return true;
  })()`,
  async enterApp(cdp, enterMainSurface) {
    const entered = await cdp
      .evaluate(enterMainSurface)
      .catch((error) => `ERROR: ${error.message}`);
    await cdp.waitFor(`document.querySelector('textarea') !== null`, {
      timeoutMs: 180_000,
      label: 'composer mounted',
    });
    await sleep(1500);
    return { entered };
  },
};

const SCRATCH = process.env.CCSDK_GUI_SCRATCH ?? path.join(os.tmpdir(), 'ccsdk-gui');
const PORT = Number(process.env.CCSDK_GUI_PORT ?? 9341);
const GATEWAY = process.env.CCSDK_GUI_GATEWAY ?? 'http://127.0.0.1:18932';
const dirs = {
  home: path.join(SCRATCH, 'home'),
  workspace: path.join(SCRATCH, 'workspace'),
  shots: path.join(SCRATCH, 'shots'),
};
const envFile = path.join(SCRATCH, 'ccsdk.env');
const pidFile = path.join(SCRATCH, 'dev.pid');
const log = (...args) => console.error('[ccsdk-gui]', ...args);

function setup() {
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dirs.workspace, 'README.md'),
    '# Claude SDK engine point-check workspace\n\nThrowaway; the prototype runs its tools here.\n'
  );
  spawnSync('git', ['init', '-q'], { cwd: dirs.workspace });
  fs.writeFileSync(
    envFile,
    [
      '# Route-B GUI point-check: fake values only, never a real credential.',
      `ANTHROPIC_BASE_URL=${GATEWAY}`,
      'ANTHROPIC_AUTH_TOKEN=ccsdk-gui-fake-token',
      'AICLIENT_MANAGED_CREDENTIALS=0',
      'AICLIENT_SKIP_AUTH_GATE=1',
      'AICLIENT_PROFILE=ccsdkproto',
      `AICLIENT_DSH_NODE=${process.execPath}`,
      // S-1: the SDK engine is the settings switch (default on) and takes its
      // gateway and key from the seeded services, like DSH; no env for either.
      '',
    ].join('\n')
  );
  log(`scratch ${SCRATCH}`);
}

function launch() {
  const logFd = fs.openSync(path.join(SCRATCH, 'dev.log'), 'w');
  const keep = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'COMMONPROGRAMFILES',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
    'USERNAME',
    'USERDOMAIN',
    'COMPUTERNAME',
    'LANG',
    'TERM',
    'DISPLAY',
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && keep.has(name.toUpperCase())
    )
  );
  Object.assign(env, {
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    AICLIENT_DEV_ENV_FILE: envFile,
    no_proxy: 'localhost,127.0.0.1,::1',
    NO_PROXY: 'localhost,127.0.0.1,::1',
  });
  const child = spawn(
    process.execPath,
    [
      path.join(repoRoot, 'scripts/dev.js'),
      `--open-path=${dirs.workspace}`,
      `--remote-debugging-port=${PORT}`,
      // Behind other windows Chromium marks the page hidden and stops animation
      // frames, so dialogs never finish opening and focus lands late. Set
      // CCSDK_GUI_KEEP_RENDERING=1 to keep it rendering while occluded.
      ...(process.env.CCSDK_GUI_KEEP_RENDERING === '1'
        ? [
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
          ]
        : []),
    ],
    { cwd: repoRoot, env, detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true }
  );
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  log(`dev.js pid ${child.pid}; log ${path.join(SCRATCH, 'dev.log')}`);
}

function stop() {
  const pid = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '';
  if (!pid) return log('no pid file');
  const result = spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { encoding: 'utf8' });
  log((result.stdout || result.stderr || '').trim().split('\n').slice(-3).join(' | '));
}

async function attach() {
  const cdp = await Cdp.attach(PORT, 300_000);
  cdp.collectRendererProblems();
  await cdp.waitFor(`(document.getElementById('root')?.innerText.length ?? 0) > 10`, {
    timeoutMs: 180_000,
    label: 'renderer painted',
  });
  return cdp;
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'setup':
    setup();
    break;
  case 'launch':
    launch();
    break;
  case 'stop':
    stop();
    break;
  default: {
    const cdp = await attach();
    const evalAsync = pc.makeEval(cdp, 'ccsdk');
    try {
      switch (command) {
        case 'enter': {
          const textarea = await cdp.evaluate(`document.querySelector('textarea') !== null`);
          console.log(
            textarea ? 'already in' : JSON.stringify(await pc.enterApp(cdp, ENTER_MAIN_SURFACE))
          );
          break;
        }
        case 'seed': {
          // The gateway answers any OpenAI-wire request with one plain line, whatever
          // its plan, so one fake gateway serves both services.
          const value = await evalAsync(
            `const claude = await window.electronAPI.userProviders.upsert({
               name: 'Fake Claude gateway', baseUrl: ${JSON.stringify(GATEWAY)}, api: 'anthropic-messages',
               apiKey: 'sk-ccsdk-gui-fake-key', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'glm-anth-1'], enabled: true });
             const glm = await window.electronAPI.userProviders.upsert({
               name: 'Fake GLM gateway', baseUrl: ${JSON.stringify(`${GATEWAY}/v1`)}, api: 'openai-completions',
               apiKey: 'sk-ccsdk-gui-fake-glm-key', models: ['glm-fake-1'], enabled: true });
             return { claude, glm };`,
            { label: 'seed providers' }
          );
          console.log(JSON.stringify(value, null, 1));
          break;
        }
        case 'look':
          console.log(
            await cdp.evaluate(`document.getElementById('root').innerText.slice(0, 3000)`)
          );
          break;
        case 'send': {
          console.log('typed', await cdp.evaluate(pc.typeIntoComposer(rest.join(' '))));
          await cdp.waitFor(pc.SEND_READY, { timeoutMs: 20_000, label: 'send ready' });
          console.log('sent', await cdp.evaluate(pc.CLICK_SEND));
          break;
        }
        case 'click': {
          const label = rest.join(' ');
          console.log(
            await cdp.evaluate(`(() => {
              const want = ${JSON.stringify(label)};
              const hit = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],[role="radio"]')]
                .find((b) => b.offsetParent !== null && ((b.innerText || '').trim() === want || b.getAttribute('aria-label') === want));
              if (!hit) return 'not found';
              hit.click();
              return 'clicked';
            })()`)
          );
          break;
        }
        case 'eval':
          console.log(JSON.stringify(await evalAsync(rest.join(' '), { label: 'eval' }), null, 1));
          break;
        case 'shot':
          console.log(await pc.shoot(cdp, dirs.shots, `${rest[0] ?? 'shot'}.png`));
          break;
        default:
          console.log(`unknown command ${command}`);
      }
      if (cdp.problems.length > 0)
        console.log('renderer problems:', JSON.stringify(cdp.problems.slice(-5), null, 1));
    } finally {
      cdp.close();
    }
  }
}
