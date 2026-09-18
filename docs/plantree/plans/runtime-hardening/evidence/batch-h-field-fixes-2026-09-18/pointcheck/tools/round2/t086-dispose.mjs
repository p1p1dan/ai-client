#!/usr/bin/env node
/**
 * t086-dispose.mjs — close the terminal and watch the three things `f3b658d4`
 * claims happen: the stranded `/new` chat is written into session-index.json, a
 * `piTui:sessionsIndexed` push tells the renderer, and the sidebar refreshes.
 */
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-field-fixes-2026-09-18/pointcheck/tools/bh-cdp.mjs';

const INDEX = '/home/ai/.config/jyw-ai-client-dev/session-index.json';
const rows = () => JSON.parse(fs.readFileSync(INDEX, 'utf8'));

const cdp = await connect();
try {
  const before = rows();
  console.log('index rows before dispose:', before.length);

  // What the sidebar shows right now, so "the row appeared" can be checked in the UI.
  const sidebarBefore = await cdp.evaluate(
    `(() => document.querySelectorAll('[data-session-id]').length)()`
  );
  console.log('sidebar [data-session-id] nodes before:', sidebarBefore);

  console.log(
    'dispose:',
    await cdp.evaluate(
      `(() => { window.electronAPI.piTui.dispose(window.__bh2.id); return 'disposing'; })()`
    )
  );

  for (let i = 0; i < 20; i++) {
    await delay(1500);
    const state = await cdp.evaluate(
      `JSON.stringify({ exit: window.__bh2.exit, indexed: window.__bh2.indexed })`
    );
    const after = rows();
    console.log(
      `t+${((i + 1) * 1.5).toFixed(1)}s rows=${after.length} ${state}`
    );
    if (after.length > before.length && JSON.parse(state).indexed.length > 0) break;
  }

  const after = rows();
  const added = after.filter((r) => !before.some((b) => b.sessionId === r.sessionId));
  console.log('--- rows added ---');
  console.log(JSON.stringify(added, null, 2));
  fs.writeFileSync('/tmp/bh2/t086-added-rows.json', JSON.stringify(added, null, 2));
} finally {
  cdp.close();
}
