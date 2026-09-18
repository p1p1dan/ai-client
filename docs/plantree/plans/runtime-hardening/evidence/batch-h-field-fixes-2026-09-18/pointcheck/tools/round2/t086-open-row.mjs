#!/usr/bin/env node
/**
 * t086-open-row.mjs — click the row the sweep just wrote and see whether the chat
 * opens. The claim under test is that no conversion code was needed: the runtime's
 * `prepareSessionConfig` (runtime/plugins/session/legacy.ts) turns pi's v3 file
 * into a `<file>.native-v4.jsonl` sibling on the first open and resumes from that.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-field-fixes-2026-09-18/pointcheck/tools/bh-cdp.mjs';

const title = process.argv[2] ?? 'Session a5eed4';
const cdp = await connect();
try {
  const clicked = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('div[role][title]')]
      .filter(e => /h-7/.test(e.className))
      .find(e => e.getAttribute('title') === ${JSON.stringify(title)});
    if (!row) return 'row not found';
    row.click();
    return 'clicked';
  })()`);
  console.log('click:', clicked);

  for (let i = 0; i < 12; i++) {
    await delay(1500);
    const s = await cdp.evaluate(`(() => {
      const t = document.body.innerText;
      const header = document.querySelector('header')?.innerText?.replace(/\\n/g, ' | ') ?? '';
      return {
        header: header.slice(0, 120),
        error: /无法|失败|错误|mismatch|session_cwd|Error|error/.test(t.slice(-2500)),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(e => (e.innerText||'').slice(0,160)),
        tail: t.slice(-260).replace(/\\n+/g, ' | '),
      };
    })()`);
    console.log(`t+${((i + 1) * 1.5).toFixed(1)}s`, JSON.stringify(s));
    if (s.header.includes('a5e') || s.tail.includes('丁')) break;
  }
} finally {
  cdp.close();
}
