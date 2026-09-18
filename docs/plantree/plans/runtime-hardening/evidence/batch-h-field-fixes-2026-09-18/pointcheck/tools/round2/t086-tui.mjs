#!/usr/bin/env node
/**
 * t086-tui.mjs — T086: a chat created with `/new` inside the embedded TUI has to
 * land in the sidebar when the terminal closes.
 *
 * Two things this does differently from round 1's bh-tui.mjs:
 *
 * 1. It opens the terminal WITH a `sessionFile`. `ipc/piTui.ts` only takes the
 *    session-directory snapshot when one is supplied (`if (request.sessionFile)`
 *    guards `rememberSessionDirectory`), and that snapshot is the whole basis of
 *    the sweep this item is about. A terminal opened on a bare cwd can never
 *    report a stranded chat, so round 1 could not have seen this even with a
 *    working model.
 *
 * 2. It refuses to type a message until pi's status line names the fake gateway.
 *    The app process carries ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from
 *    dev.env and a local-mode PTY does NOT strip them (PiTuiPty.ts only drops
 *    credential keys when `managed`), so a pi that fell back to its built-in
 *    anthropic provider would fire a REAL request at a REAL endpoint. The gate
 *    below is what stops that; on a miss it disposes and exits non-zero.
 *
 * Usage: node t086-tui.mjs <sessionFile> <cwd>
 */
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-field-fixes-2026-09-18/pointcheck/tools/bh-cdp.mjs';

const sessionFile = process.argv[2];
const cwd = process.argv[3] ?? '/home/ai/code/ai-client';
const message = process.argv[4] ?? '回一个字：丁';
if (!sessionFile) {
  console.error('usage: node t086-tui.mjs <sessionFile> <cwd> [message]');
  process.exit(2);
}
const terminalId = `bh2-t086-${Date.now()}`;
const cdp = await connect();

const strip = (s) =>
  String(s)
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\][^]*(?:|\\)/g, '')
    .replace(/[()][B0]/g, '')
    .replace(/[=><]/g, '');

const transcript = async () => strip(await cdp.evaluate('window.__bh2.data'));
const dispose = async () =>
  cdp.evaluate(
    `(() => { window.electronAPI.piTui.dispose(window.__bh2.id); return 'disposing'; })()`
  );

try {
  await cdp.evaluate(`(() => {
    window.__bh2 = { id: ${JSON.stringify(terminalId)}, data: '', open: null, exit: null, indexed: [] };
    window.__bh2Off = window.electronAPI.piTui.onData((e) => {
      if (e.terminalId === window.__bh2.id) window.__bh2.data += e.data;
    });
    window.__bh2OffExit = window.electronAPI.piTui.onExit((e) => { window.__bh2.exit = e; });
    window.__bh2OffIdx = window.electronAPI.piTui.onSessionsIndexed((e) => { window.__bh2.indexed.push(e); });
    window.electronAPI.piTui
      .open({ terminalId: window.__bh2.id, cwd: ${JSON.stringify(cwd)}, sessionFile: ${JSON.stringify(sessionFile)}, cols: 120, rows: 30 })
      .then((r) => { window.__bh2.open = r; })
      .catch((err) => { window.__bh2.open = { error: String(err) }; });
    return 'opening';
  })()`);
  await cdp.waitFor(`(() => !!window.__bh2.open)()`, { timeout: 60000, label: 'piTui.open' });
  const open = await cdp.evaluate('JSON.stringify(window.__bh2.open)');
  console.log('open:', open);
  if (open.includes('error')) process.exit(4);

  await delay(14000);
  let text = await transcript();
  console.log('bytes after open:', text.length);
  console.log('--- status region ---');
  console.log(text.slice(-1200));

  // SAFETY GATE — the model pi is about to use must be the fake gateway.
  if (!/probe-fake/.test(text) || /claude-opus|anthropic\)/.test(text)) {
    console.error('\n!! GATE FAILED: pi is not on probe-fake. Disposing without sending.');
    await dispose();
    await delay(4000);
    process.exit(5);
  }
  console.log('\nGATE OK: pi is on probe-fake/fake-sonnet');

  const write = (data) =>
    cdp.evaluate(
      `(() => { window.electronAPI.piTui.write(window.__bh2.id, ${JSON.stringify(data)}); return 'w'; })()`
    );

  await write('/new\r');
  await delay(9000);
  text = await transcript();
  console.log('after /new, bytes:', text.length);
  console.log(text.slice(-600));

  // Gate again: `/new` re-picks the initial model.
  if (!/probe-fake/.test(text.slice(-2000))) {
    console.error('\n!! GATE FAILED after /new. Disposing without sending.');
    await dispose();
    await delay(4000);
    process.exit(5);
  }

  await write(message);
  await delay(1500);
  await write('\r');
  await delay(25000);
  text = await transcript();
  console.log('after message, bytes:', text.length);
  console.log('--- tail ---');
  console.log(text.slice(-1500));
} finally {
  cdp.close();
}
