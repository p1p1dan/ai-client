#!/usr/bin/env node
/**
 * bh-tui.mjs — drive the embedded pi TUI through the preload IPC, for T086.
 *
 * The GUI/TUI segmented control cannot be driven from CDP (batch E handbook §2.6:
 * neither `.click()` nor a synthesized mouse sequence flips `aria-pressed`), so the
 * terminal is opened by calling the same channel the button calls:
 * `window.electronAPI.piTui.open({ terminalId, cwd, cols, rows })`. `terminalId` is
 * required — omitting it fails inside Main with "Cannot read properties of undefined".
 *
 * What it does, in one CDP session so the page globals survive between steps:
 *   open -> subscribe to piTui.onData -> type `/new` -> type one sentence ->
 *   wait for the reply text to appear in the pty stream -> dispose.
 *
 * The pty transcript is printed at the end (ANSI stripped) and the raw text is left
 * on `window.__bhTui.data` for a follow-up read.
 *
 * Usage: node bh-tui.mjs <cwd> '<message to type>'
 */
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from './bh-cdp.mjs';

const cwd = process.argv[2] ?? '/home/ai/code/ai-client';
const message = process.argv[3] ?? '回一个字：丁';
const terminalId = `bh-t086-${Date.now()}`;

const cdp = await connect();
try {
  await cdp.evaluate(`(() => {
    window.__bhTui = { id: ${JSON.stringify(terminalId)}, data: '', open: null, exit: null, indexed: [] };
    window.__bhTuiOff = window.electronAPI.piTui.onData((e) => {
      if (e.terminalId === window.__bhTui.id) window.__bhTui.data += e.data;
    });
    window.__bhTuiOffExit = window.electronAPI.piTui.onExit((e) => { window.__bhTui.exit = e; });
    if (window.electronAPI.piTui.onSessionsIndexed) {
      window.__bhTuiOffIdx = window.electronAPI.piTui.onSessionsIndexed((e) => {
        window.__bhTui.indexed.push(e);
      });
    }
    window.electronAPI.piTui
      .open({ terminalId: window.__bhTui.id, cwd: ${JSON.stringify(cwd)}, cols: 120, rows: 30 })
      .then((r) => { window.__bhTui.open = r; })
      .catch((err) => { window.__bhTui.open = { error: String(err) }; });
    return 'opening';
  })()`);

  await cdp.waitFor(`(() => !!window.__bhTui.open)()`, { timeout: 60000, label: 'piTui.open' });
  console.log('open:', JSON.stringify(await cdp.evaluate('window.__bhTui.open')));

  // Let the TUI paint its first frame before typing into it.
  await delay(12000);
  console.log('after open, bytes:', await cdp.evaluate('window.__bhTui.data.length'));

  const write = async (data) =>
    cdp.evaluate(
      `(() => { window.electronAPI.piTui.write(window.__bhTui.id, ${JSON.stringify(data)}); return 'w'; })()`
    );

  await write('/new\r');
  await delay(8000);
  console.log('after /new, bytes:', await cdp.evaluate('window.__bhTui.data.length'));

  await write(message);
  await delay(1500);
  await write('\r');
  await delay(25000);
  console.log('after message, bytes:', await cdp.evaluate('window.__bhTui.data.length'));

  await cdp.evaluate(
    `(() => { window.electronAPI.piTui.dispose(window.__bhTui.id); return 'disposing'; })()`
  );
  await delay(6000);
  const state = await cdp.evaluate(
    `JSON.stringify({ exit: window.__bhTui.exit, indexed: window.__bhTui.indexed, bytes: window.__bhTui.data.length })`
  );
  console.log('after dispose:', state);

  const transcript = await cdp.evaluate(
    `(() => window.__bhTui.data.replace(/\\u001b\\[[0-9;?]*[a-zA-Z]/g, '').replace(/\\u001b[()][B0]/g, ''))()`
  );
  console.log('----- pty transcript (ANSI stripped) -----');
  console.log(transcript.slice(-4000));
} finally {
  cdp.close();
}
