#!/usr/bin/env node
/**
 * m19-m23.mjs — first half of the 2026-09-19 MODEL point-check, in ONE app run.
 *
 * MODEL-19 (cross-session ask): park an unanswered question card in session A,
 * raise a DIFFERENT one in a fresh session B, switch back to A, and check that
 * A still has an ANSWERABLE card (not a frozen leftover) and that its turn can
 * still finish. The store's `pendingQuestions` is read at three moments because
 * the criterion is about a global array surviving a session switch, and a
 * screenshot cannot show that.
 *
 * MODEL-23 (replay), phase 1: give the same session A an approved permission
 * card, then capture the transcript THREE ways — live, after a B→A round trip,
 * and (in `m23-after.mjs`, after a real restart) rebuilt from `session.history`.
 * This file writes the first two; the third needs the app stopped and started,
 * which is done outside the probe.
 *
 * Deliberately not `stopDevApp()` anywhere: this batch stops Electron by
 * scanning /proc, never `pkill -f`.
 */
import path from 'node:path';
import { Cdp, DEBUG_PORT, ENTER_MAIN_SURFACE, sleep } from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';
import {
  ALLOW_TEXT,
  CARD,
  CLICK_SEND,
  CONTINUE_TEXT,
  DOM_SUMMARY,
  OTHER_TEXT,
  PERMISSION_CARD,
  SEND_READY,
  SKIP_TEXT,
  enterApp,
  makeEval,
  settled,
  shoot,
  storeSummary,
  switchTo,
  typeIntoComposer,
  writeJson,
} from './pc-lib.mjs';

const ROOT =
  process.env.PC_OUT_DIR ??
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck';
const OUT19 = path.join(ROOT, 'model-19');
const OUT23 = path.join(ROOT, 'model-23');

const PROMPT_A =
  '用提问工具问我一个二选一的问题：部署环境用 staging 还是 production？只给这两个选项，不要做别的事。' +
  '拿到我的回答后，用一句话把我选中的那一项原样复述出来。';
const PROMPT_B = '用提问工具问我：配置文件用 YAML 还是 TOML？只给这两个选项，不要做别的事。';
const PROMPT_PERM = '读取 /etc/hostname 这个文件，把内容告诉我。';

const cdp = await Cdp.attach(DEBUG_PORT, 120_000);
cdp.collectRendererProblems();
const evalAsync = makeEval(cdp, 'm19');

const report = {
  probe: 'm19-m23.mjs',
  criteria: ['MODEL-19', 'MODEL-23 (phase 1: live + switch-back)'],
  startedAt: new Date().toISOString(),
  turns: [],
  steps: {},
};

const now = () => Date.now();

async function send(prompt) {
  const typed = await cdp.evaluate(typeIntoComposer(prompt));
  await cdp.waitFor(SEND_READY, { timeoutMs: 60_000, label: 'send button ready' });
  const t0 = now();
  await cdp.evaluate(CLICK_SEND);
  return { typed, t0 };
}

async function readActive() {
  return evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     const sid = s.activeSessionId;
     return { sid, messageCount: sid ? (s.messages[sid] ?? []).length : null };`,
    { label: 'read active session' }
  );
}

async function readPending() {
  return evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     return {
       activeSessionId: s.activeSessionId,
       pendingQuestions: JSON.parse(JSON.stringify(s.pendingQuestions)),
       statuses: s.sessions.map((x) => ({ id: x.id, status: x.status })),
     };`,
    { label: 'read pendingQuestions' }
  );
}

try {
  report.entry = await enterApp(cdp, ENTER_MAIN_SURFACE);

  // --- MODEL-19 step 1: an EMPTY session A ---------------------------------
  const before = await readActive();
  await cdp.evaluate(`(() => {
    const hits = [...document.querySelectorAll('button[aria-label="新建对话"]')].filter((b) => b.offsetParent !== null);
    if (hits.length === 0) throw new Error('no 新建对话 button');
    hits[hits.length - 1].click();
    return true;
  })()`);
  await sleep(2500);
  const afterNew = await readActive();
  const A = afterNew.sid;
  report.steps.sessionA = { before, after: afterNew, sessionId: A };
  if (!A) throw new Error('no active session after 新建对话');
  if (afterNew.messageCount !== 0) throw new Error(`session A is not empty (${afterNew.messageCount})`);

  // --- step 2: park A's question, do NOT answer ----------------------------
  console.log('[A] sending ask prompt');
  const sentA = await send(PROMPT_A);
  await cdp.waitFor(`${CARD} !== null`, { timeoutMs: 480_000, label: 'A: question card' });
  const aCardMs = now() - sentA.t0;
  report.steps.aCard = { atMs: aCardMs, card: await cdp.evaluate(CARD) };
  report.steps.pendingAfterA = await readPending();
  report.steps.aCardScreenshot = await shoot(cdp, OUT19, 'model-19-a-card.png');
  console.log(`[A] card up after ${aCardMs}ms`);

  // --- step 3: a DIFFERENT question in a fresh session B -------------------
  await cdp.evaluate(`(() => {
    const hits = [...document.querySelectorAll('button[aria-label="新建对话"]')].filter((b) => b.offsetParent !== null);
    if (hits.length === 0) throw new Error('no 新建对话 button');
    hits[hits.length - 1].click();
    return true;
  })()`);
  await sleep(2500);
  const afterB = await readActive();
  const B = afterB.sid;
  report.steps.sessionB = { sessionId: B, distinct: B !== A, messageCount: afterB.messageCount };
  if (!B || B === A) throw new Error(`新建对话 did not create a second session (A=${A} B=${B})`);

  console.log('[B] sending ask prompt');
  const sentB = await send(PROMPT_B);
  await cdp.waitFor(`${CARD} !== null`, { timeoutMs: 480_000, label: 'B: question card' });
  const bCardMs = now() - sentB.t0;
  report.steps.bCard = { atMs: bCardMs, card: await cdp.evaluate(CARD) };
  report.steps.pendingTwo = await readPending();
  report.steps.bCardScreenshot = await shoot(cdp, OUT19, 'model-19-b-card.png');
  console.log(`[B] card up after ${bCardMs}ms; pending=${report.steps.pendingTwo.pendingQuestions.length}`);

  // --- step 4: back to A — the card must still be ANSWERABLE ---------------
  report.steps.switchBackToA = await switchTo(cdp, evalAsync, A);
  await sleep(1200);
  report.steps.aCardAfterSwitch = await cdp.evaluate(CARD);
  report.steps.pendingAfterSwitchBack = await readPending();
  report.steps.concurrentScreenshot = await shoot(cdp, OUT19, 'model-19-concurrent-ask.png');
  report.steps.domAfterSwitchBack = await cdp.evaluate(DOM_SUMMARY);

  // --- step 5: answer A, and watch A's own turn finish --------------------
  const answerT0 = now();
  report.steps.picked = await cdp.evaluate(`(() => {
    const skip = [...document.querySelectorAll('button')]
      .find((b) => (b.innerText || '').trim() === ${JSON.stringify(SKIP_TEXT)} && b.offsetParent !== null);
    const card = skip?.closest('div[class*="rounded-md"]');
    if (!card) throw new Error('no card to answer');
    const rows = [...card.querySelectorAll('[role="radio"],[role="checkbox"]')];
    const first = rows[0];
    if (!first) throw new Error('no option control in the card');
    const label = (first.children[1]?.childNodes[0]?.textContent || first.children[1]?.innerText || '').trim();
    if (label === ${JSON.stringify(OTHER_TEXT)}) throw new Error('first row is the free-text row');
    first.click();
    return label;
  })()`);
  await sleep(700);
  report.steps.cardAfterPick = await cdp.evaluate(CARD);
  report.steps.continueClicked = await cdp.evaluate(`(() => {
    const skip = [...document.querySelectorAll('button')]
      .find((b) => (b.innerText || '').trim() === ${JSON.stringify(SKIP_TEXT)} && b.offsetParent !== null);
    const card = skip?.closest('div[class*="rounded-md"]');
    const rows = [...card.querySelectorAll('[role="radio"],[role="checkbox"]')];
    const go = [...card.querySelectorAll('button')]
      .filter((b) => rows.indexOf(b) === -1)
      .find((b) => (b.innerText || '').trim().startsWith(${JSON.stringify(CONTINUE_TEXT)}));
    if (!go) throw new Error('no 继续 button');
    if (go.disabled) throw new Error('继续 still disabled after picking');
    go.click();
    return (go.innerText || '').trim().replace(/\\s+/g, ' ');
  })()`);
  report.steps.aCardCleared = await (async () => {
    const deadline = now() + 30_000;
    while (now() < deadline) {
      if ((await cdp.evaluate(`${CARD} === null`)) === true) return true;
      await sleep(400);
    }
    return false;
  })();
  const settledA = await evalAsync(settled(A, 480_000), { timeoutMs: 520_000, label: 'A settled' });
  report.steps.aTurn = {
    answerToSettleMs: now() - answerT0,
    totalMs: now() - sentA.t0,
    ...settledA,
  };
  report.turns.push({ id: 'A-ask', ms: aCardMs }, { id: 'A-answer', ms: now() - answerT0 });
  console.log(`[A] settled=${settledA.settled} status=${settledA.status}`);
  console.log(`[A] reply: ${settledA.reply.slice(0, 200).replace(/\n/g, ' | ')}`);
  report.steps.pendingAfterAAnswered = await readPending();

  // --- step 6: B gets skipped ---------------------------------------------
  report.steps.switchToB = await switchTo(cdp, evalAsync, B);
  const skipT0 = now();
  report.steps.bSkipClicked = await cdp.evaluate(`(() => {
    const skip = [...document.querySelectorAll('button')]
      .find((b) => (b.innerText || '').trim() === ${JSON.stringify(SKIP_TEXT)} && b.offsetParent !== null);
    if (!skip) throw new Error('no 跳过 button in B');
    skip.click();
    return true;
  })()`);
  const settledB = await evalAsync(settled(B, 480_000), { timeoutMs: 520_000, label: 'B settled' });
  report.steps.bTurn = { skipToSettleMs: now() - skipT0, totalMs: now() - sentB.t0, ...settledB };
  report.turns.push({ id: 'B-ask', ms: bCardMs }, { id: 'B-skip', ms: now() - skipT0 });
  report.steps.pendingFinal = await readPending();
  console.log(`[B] settled=${settledB.settled} pending=${report.steps.pendingFinal.pendingQuestions.length}`);

  report.model19 = {
    twoCardsParkedAtOnce: report.steps.pendingTwo.pendingQuestions.length === 2,
    parkedSessionIds: report.steps.pendingTwo.pendingQuestions.map((p) => p.sessionId),
    stillTwoAfterSwitchBack: report.steps.pendingAfterSwitchBack.pendingQuestions.length === 2,
    activeIsAAfterSwitchBack: report.steps.pendingAfterSwitchBack.activeSessionId === A,
    aCardAnswerableAfterSwitchBack:
      (report.steps.aCardAfterSwitch?.options?.length ?? 0) > 0 &&
      (report.steps.aCardAfterSwitch?.buttons ?? []).some((b) => b.text.startsWith(CONTINUE_TEXT)),
    continueEnabledAfterPick: (report.steps.cardAfterPick?.buttons ?? []).some(
      (b) => b.text.startsWith(CONTINUE_TEXT) && b.disabled === false
    ),
    aCardCleared: report.steps.aCardCleared === true,
    aTurnSettled: settledA.settled === true,
    aReplyEchoesPick:
      report.steps.picked != null && (settledA.reply ?? '').includes(report.steps.picked),
    pendingEmptyAtEnd: report.steps.pendingFinal.pendingQuestions.length === 0,
  };
  report.model19.pass = Object.values(report.model19).every((v) => v === true || Array.isArray(v));
  console.log('\nMODEL-19 ' + JSON.stringify(report.model19, null, 1));
  writeJson(OUT19, 'report.json', {
    probe: report.probe,
    criterion: 'MODEL-19',
    sessionA: A,
    sessionB: B,
    verdict: report.model19,
    pendingQuestions: {
      afterAOnly: report.steps.pendingAfterA,
      bothParked: report.steps.pendingTwo,
      afterSwitchBackToA: report.steps.pendingAfterSwitchBack,
      afterAAnswered: report.steps.pendingAfterAAnswered,
      final: report.steps.pendingFinal,
    },
    cards: {
      a: report.steps.aCard,
      b: report.steps.bCard,
      aAfterSwitchBack: report.steps.aCardAfterSwitch,
      aAfterPick: report.steps.cardAfterPick,
    },
    picked: report.steps.picked,
    aTurn: report.steps.aTurn,
    bTurn: report.steps.bTurn,
    timings: report.turns,
    screenshots: [
      report.steps.aCardScreenshot,
      report.steps.bCardScreenshot,
      report.steps.concurrentScreenshot,
    ],
  });

  // --- MODEL-23 step 8: A also gets an APPROVED permission card ------------
  report.steps.switchBackToAForPermission = await switchTo(cdp, evalAsync, A);
  console.log('[A] sending outside-workspace read prompt');
  const sentPerm = await send(PROMPT_PERM);
  await cdp.waitFor(`${PERMISSION_CARD} !== null`, {
    timeoutMs: 480_000,
    label: 'A: permission card',
  });
  const permCardMs = now() - sentPerm.t0;
  report.steps.permissionCard = { atMs: permCardMs, card: await cdp.evaluate(PERMISSION_CARD) };
  report.steps.permissionCardScreenshot = await shoot(cdp, OUT23, 'model-23-permission-card.png');
  // Synthetic click: the modal overlay would eat a real mouse event.
  report.steps.allowClicked = await cdp.evaluate(`(() => {
    const allow = [...document.querySelectorAll('button')]
      .find((b) => (b.innerText || '').trim() === ${JSON.stringify(ALLOW_TEXT)} && b.offsetParent !== null);
    if (!allow) throw new Error('no 直接允许 button');
    allow.click();
    return (allow.innerText || '').trim();
  })()`);
  const settledPerm = await evalAsync(settled(A, 480_000), {
    timeoutMs: 520_000,
    label: 'A permission turn settled',
  });
  report.steps.permissionTurn = { cardAtMs: permCardMs, totalMs: now() - sentPerm.t0, ...settledPerm };
  report.turns.push({ id: 'A-permission', ms: now() - sentPerm.t0 });
  console.log(`[A] permission turn settled=${settledPerm.settled}`);

  // --- step 9: the "before" capture ----------------------------------------
  await sleep(1500);
  report.steps.beforeScreenshot = await shoot(cdp, OUT23, 'model-23-replay-前.png');
  const beforeStore = await evalAsync(storeSummary(A), { label: 'store summary before' });
  const beforeDom = await cdp.evaluate(DOM_SUMMARY);
  writeJson(OUT23, 'model-23-before.json', { at: 'live', sessionId: A, store: beforeStore, dom: beforeDom });

  // --- step 10a: the light round trip B → A --------------------------------
  report.steps.switchAwayToB = await switchTo(cdp, evalAsync, B);
  await sleep(1500);
  report.steps.switchBackAgain = await switchTo(cdp, evalAsync, A);
  await sleep(2000);
  report.steps.switchBackScreenshot = await shoot(cdp, OUT23, 'model-23-switch-back.png');
  const switchStore = await evalAsync(storeSummary(A), { label: 'store summary after switch' });
  const switchDom = await cdp.evaluate(DOM_SUMMARY);
  writeJson(OUT23, 'model-23-switch-back.json', {
    at: 'switch-back',
    sessionId: A,
    store: switchStore,
    dom: switchDom,
  });

  report.sessions = { A, B, titleA: beforeStore.title };
  console.log(`\nsession A = ${A} (${beforeStore.title})\nsession B = ${B}`);
} catch (error) {
  report.error = String(error?.stack ?? error?.message ?? error);
  console.error('probe failed:', report.error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  try {
    report.rendererProblems = cdp.problems.slice(0, 20);
  } catch {
    /* socket gone */
  }
  const file = writeJson(ROOT, 'm19-m23-run.json', report);
  console.log(`run log → ${file}`);
  cdp.close();
}
