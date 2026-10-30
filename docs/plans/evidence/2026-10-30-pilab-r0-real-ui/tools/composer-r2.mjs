#!/usr/bin/env node
/**
 * PiLab R2 composer probes against the running dev app (CDP 9222), with
 * trusted input: `Input.dispatchKeyEvent` and `Input.imeSetComposition` /
 * `Input.insertText` go through Chromium's own input pipeline, so the page
 * sees the same isComposing / keyCode 229 / composition events an IME gives.
 *
 *   node composer-r2.mjs ime            # Enter while composing, in the composer and its menus
 *   node composer-r2.mjs state          # composer text, menus, user-message count
 *
 * Prerequisite: app launched and entered (see ../README.md §2), a chat or the
 * home composer on screen. Never sends to a real model: the fake gateway only.
 */
import { lib } from '../../../../plantree/plans/dsh-rebase/evidence/p1-7d-gui-2026-09-30/tools/p1-7d-gui.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STATE = `(() => {
  const ta = document.querySelector('textarea');
  // The two composer menus are plain popovers (no listbox role): find them by their surface.
  const pops = [...document.querySelectorAll('.elev-popover')].filter((n) => n.offsetParent !== null && n.querySelector('button'));
  return {
    text: ta ? ta.value : null,
    focused: document.activeElement === ta,
    menus: pops.map((n) => n.innerText.replace(/\\s+/g, ' ').slice(0, 60)),
    userBubbles: document.querySelectorAll('[data-slot=user-bubble], [data-role=user]').length,
  };
})()`;

async function userCount(cdp) {
  const evalAsync = lib.makeEval(cdp, 'r2');
  return evalAsync(
    `${lib.STORE}
     const id = s.activeSessionId;
     return { id, users: id ? (s.messages[id] ?? []).filter((m) => m.role === 'user').length : 0, sessions: s.sessions.length };`,
    { label: 'user count' }
  );
}

async function key(cdp, type, k, extra = {}) {
  const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, Process: 229 };
  const code = extra.keyCode ?? codes[k] ?? 0;
  await cdp.send('Input.dispatchKeyEvent', {
    type,
    key: k,
    code: k === 'Process' ? '' : k,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    ...(type === 'keyDown' && k === 'Enter' && !extra.noText ? { text: '\r', unmodifiedText: '\r' } : {}),
    ...extra.params,
  });
}

async function focusComposer(cdp, text = '') {
  await cdp.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    return true;
  })()`);
  await sleep(150);
}

/**
 * One IME pick: compose `pinyin`, then commit `word` the way the Windows
 * Microsoft Pinyin IME does on Enter (keydown 229 while composing, then the
 * commit), optionally followed by the stray Enter some IMEs / platforms deliver
 * right after compositionend.
 */
async function imePick(cdp, pinyin, word, { strayEnter = false, enterKeyCode = 229 } = {}) {
  await cdp.send('Input.imeSetComposition', {
    text: pinyin,
    selectionStart: pinyin.length,
    selectionEnd: pinyin.length,
  });
  await sleep(80);
  await key(cdp, 'keyDown', enterKeyCode === 229 ? 'Process' : 'Enter', {
    keyCode: enterKeyCode,
    noText: true,
  });
  await cdp.send('Input.insertText', { text: word });
  await key(cdp, 'keyUp', 'Enter');
  if (strayEnter) {
    await key(cdp, 'keyDown', 'Enter');
    await key(cdp, 'keyUp', 'Enter');
  }
  await sleep(250);
}

async function imeStep() {
  const cdp = await lib.attach(30_000);
  const out = [];
  const record = async (name) => {
    process.stderr.write(`· ${name}\n`);
    const st = await cdp.evaluate(STATE);
    const count = await userCount(cdp);
    out.push({ name, ...st, users: count.users, session: count.id });
  };
  const before = await userCount(cdp);
  out.push({ name: 'before', ...before });

  // 1. Plain composer: Enter (229) commits the candidate, nothing is sent.
  await focusComposer(cdp, '');
  await imePick(cdp, 'nihao', '你好');
  await record('composer: pick with 229 Enter');

  // 2. Enter keydown reported as 13 while the composition is still open.
  await imePick(cdp, 'shijie', '世界', { enterKeyCode: 13 });
  await record('composer: pick with 13 Enter while composing');

  // (Not probed: a plain Enter right after compositionend. macOS delivers one; on Windows
  // and Linux it is the user pressing Enter again, which must send. Measured 2026-10-30.)

  // 4. Slash menu open, pick a Chinese word by IME: the menu must not run its item.
  await focusComposer(cdp, '');
  await typeText(cdp, '/');
  await record('slash: menu open');
  await imePick(cdp, 'ce', '测');
  await record('slash: pick with 229 Enter');

  // 5. @ menu open, pick a Chinese word by IME: no file inserted.
  await focusComposer(cdp, '');
  await typeText(cdp, '看看 @');
  await record('mention: menu open');
  await imePick(cdp, 'wen', '文');
  await record('mention: pick with 229 Enter');

  // Leave the composer empty again.
  await focusComposer(cdp, '');
  cdp.close();
  console.log(JSON.stringify(out, null, 2));
}

const POPUP = `(() => {
  const ta = document.querySelector('textarea');
  const pop = [...document.querySelectorAll('.elev-popover')].find((n) => n.offsetParent !== null && n.querySelector('button'));
  return {
    text: ta.value,
    caret: ta.selectionStart,
    focused: document.activeElement === ta,
    popup: pop ? [...pop.querySelectorAll('button')].slice(0, 5).map((b) => b.innerText.replace(/\\s+/g, ' ').trim()) : null,
  };
})()`;

/** Type `text` as keystrokes would (each piece through Chromium's input path). */
async function typeText(cdp, text) {
  for (const ch of text) await cdp.send('Input.insertText', { text: ch });
  await sleep(900); // the @ search: 150 ms debounce + IPC
}

async function mentionStep() {
  const cdp = await lib.attach(30_000);
  const out = [];
  const record = async (name) => {
    process.stderr.write(`· ${name}\n`);
    out.push({ name, ...(await cdp.evaluate(POPUP)) });
  };
  const fresh = async (typed) => {
    await focusComposer(cdp, '');
    await typeText(cdp, typed);
  };
  const press = async (k, params = {}) => {
    await key(cdp, 'rawKeyDown', k, { params, noText: true });
    await key(cdp, 'keyUp', k, { params });
    await sleep(300);
  };

  await fresh('see @entry');
  await record('typed "see @entry"');
  await press('Tab');
  await record('then Tab');

  await fresh('see @entry');
  await press('Home', { windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36, code: 'Home' });
  await record('then Home');
  await press('Enter', { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await record('then Enter (after Home)');

  await fresh('see @entry');
  await press('ArrowLeft', { windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37, code: 'ArrowLeft' });
  await press('ArrowLeft', { windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37, code: 'ArrowLeft' });
  await record('then ArrowLeft ×2');
  await press('Enter', { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await record('then Enter (after ArrowLeft ×2)');

  await fresh('@a-spaced');
  await record('typed "@a-spaced" (file under "My Docs/")');
  await press('Enter', { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await record('then Enter (pick)');
  out.at(-1).chips = await cdp.evaluate(
    `[...document.querySelectorAll('[data-slot=mention-chip], [data-mention-chip]')].map((n) => n.innerText)`
  );

  await fresh('请看@中文');
  await record('typed "请看@中文" (no space before @)');
  await fresh('说明：@entry');
  await record('typed "说明：@entry"');
  await fresh('see @src\\main');
  await record('typed "see @src\\main" (backslash)');
  await fresh('see @src/main');
  await record('typed "see @src/main"');
  await fresh('mail a@entry');
  await record('typed "mail a@entry" (email-like)');

  await focusComposer(cdp, '');
  cdp.close();
  console.log(JSON.stringify(out, null, 2));
}

async function stateStep() {
  const cdp = await lib.attach(30_000);
  const st = await cdp.evaluate(STATE);
  console.log(JSON.stringify({ ...st, ...(await userCount(cdp)) }, null, 2));
  cdp.close();
}

const steps = { ime: imeStep, mention: mentionStep, state: stateStep };
const step = steps[process.argv[2]];
if (!step) {
  console.error(`usage: composer-r2.mjs ${Object.keys(steps).join('|')}`);
  process.exit(2);
}
await step();
