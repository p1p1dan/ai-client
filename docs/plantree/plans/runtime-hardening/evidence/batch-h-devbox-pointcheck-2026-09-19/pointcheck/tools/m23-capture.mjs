#!/usr/bin/env node
/**
 * m23-capture.mjs — one MODEL-23 capture of session A, collapsed AND expanded.
 *
 * Usage: m23-capture.mjs <sessionId> <stage>   (stage: before | after)
 *
 * The first pass of this point-check captured only the collapsed transcript and
 * saw nothing: a settled turn folds its whole process into the 「Worked for …」
 * work group, so the answered QA card and the approved permission card are both
 * behind a `<details>` that starts closed. Every capture therefore does two
 * passes — as the transcript lands, and with every work group opened — because
 * "the approval row is gone" and "the approval row is one click away" are
 * different answers and the criterion is about which one is true.
 *
 * On `after`, this also waits for the session to appear in the restored index
 * and opens it through the SIDEBAR row, since only that path (useActivateSession)
 * resumes a session with no timeline and replays `session.history`.
 */
import path from 'node:path';
import {
  Cdp,
  DEBUG_PORT,
  ENTER_MAIN_SURFACE,
  sleep,
} from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';
import {
  DOM_SUMMARY,
  EXPAND_WORK_GROUPS,
  enterApp,
  makeEval,
  shoot,
  storeSummary,
  switchTo,
  TRANSCRIPT_TEXT,
  writeJson,
} from './pc-lib.mjs';

const ROOT =
  process.env.PC_OUT_DIR ??
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck';
const OUT23 = path.join(ROOT, 'model-23');
const A = process.argv[2];
const STAGE = process.argv[3] ?? 'before';
if (!A) throw new Error('usage: m23-capture.mjs <sessionId> <stage>');

const cdp = await Cdp.attach(DEBUG_PORT, 120_000);
cdp.collectRendererProblems();
const evalAsync = makeEval(cdp, `m23${STAGE}`);

const out = {
  probe: 'm23-capture.mjs',
  criterion: 'MODEL-23',
  stage: STAGE,
  sessionId: A,
  startedAt: new Date().toISOString(),
};

try {
  out.entry = await enterApp(cdp, ENTER_MAIN_SURFACE);

  if (STAGE === 'after') {
    const deadlineIndex = Date.now() + 120_000;
    let inIndex = false;
    while (Date.now() < deadlineIndex) {
      inIndex = await evalAsync(
        `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
         return chat.useChatSessionsStore.getState().sessions.some((s) => s.id === ${JSON.stringify(A)});`,
        { label: 'session in restored index' }
      );
      if (inIndex) break;
      await sleep(1000);
    }
    out.sessionInIndex = inIndex;
    if (!inIndex) throw new Error(`session ${A} never appeared in the restored session list`);
  }

  out.opened = await switchTo(cdp, evalAsync, A);

  // Wait for the message list to stop moving (history replay on `after`).
  const deadline = Date.now() + 180_000;
  let previous = -1;
  let stable = 0;
  let count = 0;
  while (Date.now() < deadline) {
    count = await evalAsync(
      `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
       return (chat.useChatSessionsStore.getState().messages[${JSON.stringify(A)}] ?? []).length;`,
      { label: 'message count' }
    );
    if (count > 0 && count === previous) {
      stable += 1;
      if (stable >= 3) break;
    } else {
      stable = 0;
    }
    previous = count;
    await sleep(1200);
  }
  out.messageCount = count;
  await sleep(2000);

  out.collapsed = {
    screenshot: await shoot(cdp, OUT23, `model-23-replay-${STAGE === 'before' ? '前' : '后'}.png`),
    dom: await cdp.evaluate(DOM_SUMMARY),
    transcript: await cdp.evaluate(TRANSCRIPT_TEXT),
  };

  out.expand = await cdp.evaluate(EXPAND_WORK_GROUPS);
  await sleep(1500);
  // A second pass: opening a group can reveal nested groups.
  out.expand2 = await cdp.evaluate(EXPAND_WORK_GROUPS);
  await sleep(1500);

  out.expanded = {
    screenshot: await shoot(
      cdp,
      OUT23,
      `model-23-replay-${STAGE === 'before' ? '前' : '后'}-展开.png`
    ),
    dom: await cdp.evaluate(DOM_SUMMARY),
    transcript: await cdp.evaluate(TRANSCRIPT_TEXT),
  };

  out.store = await evalAsync(storeSummary(A), { label: 'store summary' });
  out.file = writeJson(OUT23, `model-23-${STAGE}.json`, out);
  console.log(
    `[${STAGE}] messages=${count} blockTypes=${JSON.stringify(out.store.blockTypeCounts)}`
  );
  console.log(`[${STAGE}] expand clicked=${JSON.stringify(out.expand.clicked)}`);
  console.log(
    `[${STAGE}] permissionActivityRows collapsed=${out.collapsed.dom.permissionActivityRows.length} expanded=${out.expanded.dom.permissionActivityRows.length}`
  );
  console.log(`[${STAGE}] cards expanded=${out.expanded.dom.cards.length}`);
  console.log(`[${STAGE}] transcript(expanded):\n${out.expanded.transcript.slice(0, 2500)}`);
} catch (error) {
  out.error = String(error?.stack ?? error?.message ?? error);
  console.error('capture failed:', out.error);
  process.exitCode = 1;
} finally {
  out.finishedAt = new Date().toISOString();
  try {
    out.rendererProblems = cdp.problems.slice(0, 20);
  } catch {
    /* socket gone */
  }
  if (!out.file) writeJson(OUT23, `model-23-${STAGE}.json`, out);
  cdp.close();
}
