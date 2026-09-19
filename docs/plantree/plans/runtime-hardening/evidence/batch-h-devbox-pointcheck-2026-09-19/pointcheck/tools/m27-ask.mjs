#!/usr/bin/env node
/**
 * m27-ask.mjs — MODEL-27: the model asks, the user answers or skips.
 *
 * Two rounds against ONE fresh session:
 *   1. pick an option → 继续 → the model must echo the chosen option back
 *   2. a DIFFERENT question → 跳过 → the model must say it picked a default itself
 *
 * The second half is the one worth running: `formatAnswer` (src/runtime/plugins/
 * tools/ask.ts) sends a SENTENCE for a skip ("Proceed with a reasonable default
 * and say which one you picked"), not an empty answer, so "the model noticed"
 * and "the model was told" are separable only by reading what it says next.
 *
 * ## What the half-finished 2026-09-18 draft got wrong (all fixed here)
 *
 * 1. `waitFor(/Worked for/)` as the turn-settled test. Two defects at once: the
 *    marker is a catalog KEY (`turnTiming.ts` `WORKED_FOR_VERB`) and the zh
 *    catalog renders it 「耗时」, so it never matches on this Chinese build; and
 *    even in English round 2 would pass instantly on round 1's leftover text.
 *    Replaced by the store: `sessions[].status` leaving every busy state, the
 *    assistant text no longer growing between polls, and the round's own
 *    marker present. Same shape as `run-t37c-gui-probe.mjs`'s `settledReply`.
 * 2. `clickByText('继续')` — the Continue button holds TWO spans (label +
 *    「Ctrl + Enter」 chord), so its `textContent` is 「继续Ctrl + Enter」 and an
 *    exact-match click never finds it. Matched by prefix inside the card now.
 * 3. Option labels read as `innerText.split('\n')[0]`, which returns the letter
 *    chip ('A'), not the option. The label now comes from the STORE block, and
 *    the click targets the radio by index inside the card's own radiogroup.
 * 4. No screenshots and no store read at all. Both added: `Page.captureScreenshot`
 *    while the card is still up, and the raw `pendingQuestions` entry plus the
 *    `question` block it points at.
 * 5. Both rounds asked the SAME question, which a prompt cache can answer twice
 *    without calling the tool twice. The two rounds now ask about different
 *    things.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  Cdp,
  DEBUG_PORT,
  ENTER_MAIN_SURFACE,
  sleep,
} from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';

const OUT_DIR =
  process.env.M27_OUT_DIR ??
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck/model-27';

/** zh copy for the card, resolved from `src/shared/i18n.ts` rather than guessed. */
const SKIP_TEXT = '跳过';
const CONTINUE_TEXT = '继续';
const OTHER_TEXT = '其他…';
const SEND_LABEL = '发送消息';

const ROUNDS = [
  {
    mode: 'answer',
    prompt:
      '请调用 ask 工具问我一个问题：「这个项目的缩进用 Tab 还是空格？」，只给「Tab」和「空格」两个选项。' +
      '拿到我的回答后，用一句话把我选中的那一项原样复述出来，不要调用任何别的工具，也不要做别的事。',
  },
  {
    mode: 'skip',
    prompt:
      '请调用 ask 工具问我一个新问题：「日志时间戳用 UTC 还是本地时区？」，只给「UTC」和「本地时区」两个选项。' +
      '拿到结果后用一句话回复，不要调用任何别的工具，也不要做别的事。',
  },
];

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

const cdp = await Cdp.attach(DEBUG_PORT, 60_000);
cdp.collectRendererProblems();

/**
 * `Runtime.evaluate` is called with `awaitPromise:false` all over this repo's
 * probes (a promise that rejects after the call returns takes the socket down),
 * so async page work stashes its own result on `window` and is polled for.
 */
let slot = 0;
async function evalAsync(body, { timeoutMs = 120_000, label = 'evalAsync' } = {}) {
  const key = `__m27_${slot++}`;
  await cdp.evaluate(`(() => {
    window.${key} = null;
    (async () => { ${body} })()
      .then((value) => { window.${key} = { done: true, value }; })
      .catch((error) => { window.${key} = { done: true, error: String(error?.stack ?? error?.message ?? error) }; });
    return true;
  })()`);
  const out = await cdp.waitFor(`window.${key}?.done ? window.${key} : null`, { timeoutMs, label });
  if (out.error) throw new Error(`${label}: ${out.error}`);
  return out.value;
}

async function shoot(name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

// ---------------------------------------------------------------------------
// Page helpers — every one a self-contained IIFE (evaluate runs in global scope)
// ---------------------------------------------------------------------------

/**
 * The live card, read off the DOM.
 *
 * Anchored on the 跳过 button because it is unique to the question card: the
 * permission card next door offers 允许/拒绝 and never a skip. `closest` then
 * walks up past the footer (no radius) to the `QA_SHELL_CLASS` shell.
 */
const CARD = `(() => {
  const skip = [...document.querySelectorAll('button')]
    .find((b) => (b.innerText || '').trim() === ${JSON.stringify(SKIP_TEXT)} && b.offsetParent !== null);
  if (!skip) return null;
  const card = skip.closest('div[class*="rounded-md"]');
  if (!card) return null;
  const rows = [...card.querySelectorAll('[role="radio"],[role="checkbox"]')];
  return {
    title: (card.querySelector('div > span')?.innerText || '').trim(),
    text: card.innerText,
    buttons: [...card.querySelectorAll('button')]
      .map((b) => (b.innerText || '').trim().replace(/\\s+/g, ' '))
      .filter(Boolean),
    footerButtons: [...card.querySelectorAll('button')]
      .filter((b) => rows.indexOf(b) === -1)
      .map((b) => ({
        text: (b.innerText || '').trim().replace(/\\s+/g, ' '),
        disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true',
      })),
    groups: [...card.querySelectorAll('[role="radiogroup"],[role="group"]')].map((g) => ({
      role: g.getAttribute('role'),
      ariaLabel: g.getAttribute('aria-label'),
    })),
    options: rows.map((o, i) => ({
      index: i,
      role: o.getAttribute('role'),
      ariaChecked: o.getAttribute('aria-checked'),
      // children[0] is the letter chip, children[1] the label span whose FIRST
      // child node is the bare label (an optional description follows it).
      letter: (o.children[0]?.innerText || '').trim(),
      label: (o.children[1]?.childNodes[0]?.textContent || o.children[1]?.innerText || '').trim(),
      full: (o.innerText || '').trim().replace(/\\n/g, ' / '),
    })),
  };
})()`;

/**
 * Typing and sending are two calls, not one: the send button is disabled while
 * the composer is empty, so "wait for it to be enabled" only means anything
 * AFTER the text is in. The draft probe waited first and timed out on a button
 * that was correctly disabled.
 */
const typeIntoComposer = (text) => `(() => {
  const ta = document.querySelector('textarea');
  if (!ta) throw new Error('no composer textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return ta.value.length;
})()`;

const SEND_READY = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')]
    .find((n) => n.getAttribute('aria-label') === ${JSON.stringify(SEND_LABEL)});
  return !!b && !b.disabled && b.offsetParent !== null;
})()`;

const CLICK_SEND = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')]
    .find((n) => n.getAttribute('aria-label') === ${JSON.stringify(SEND_LABEL)});
  if (!b) throw new Error('no send button');
  if (b.disabled) throw new Error('send button is disabled');
  b.click();
  return true;
})()`;

/** Composer chrome, so the report names the model instead of guessing it. */
const COMPOSER_CHROME = `(() => {
  const read = (re) => {
    const hit = [...document.querySelectorAll('button[aria-label]')]
      .find((b) => re.test(b.getAttribute('aria-label') || '') && b.offsetParent !== null);
    return hit ? { ariaLabel: hit.getAttribute('aria-label'), text: (hit.innerText || '').trim() } : null;
  };
  return { model: read(/模型与思考强度|Model and reasoning/), permission: read(/每次询问|自动|旁路|Ask every time/) };
})()`;

/** The store's own view of the parked question — the payload, not the paint. */
const READ_QUESTION = (sessionId) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const state = chat.useChatSessionsStore.getState();
  const sid = ${JSON.stringify(sessionId)};
  const pending = state.pendingQuestions.find((p) => p.sessionId === sid) ?? null;
  let block = null;
  if (pending) {
    const message = (state.messages[sid] ?? []).find((m) => m.id === pending.messageId);
    block = message?.blocks.find((b) => b.type === 'question' && b.questionId === pending.questionId) ?? null;
  }
  const session = state.sessions.find((s) => s.id === sid) ?? null;
  return {
    pendingQuestions: JSON.parse(JSON.stringify(state.pendingQuestions)),
    pending: pending ? JSON.parse(JSON.stringify(pending)) : null,
    block: block ? JSON.parse(JSON.stringify(block)) : null,
    status: session?.status ?? null,
  };
`;

const SETTLED = (sessionId, timeoutMs) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const store = chat.useChatSessionsStore;
  const sid = ${JSON.stringify(sessionId)};
  const busy = new Set(['starting','running','stopping','waiting_permission','waiting_question']);
  const lastAssistant = (state) => {
    const msgs = state.messages[sid] ?? [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role !== 'assistant') continue;
      return (msgs[i].blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('').trim();
    }
    return '';
  };
  const deadline = Date.now() + ${timeoutMs};
  let previous = null;
  let settled = false;
  while (Date.now() < deadline) {
    const state = store.getState();
    const session = state.sessions.find((s) => s.id === sid);
    const text = lastAssistant(state);
    if (text.length > 0 && !busy.has(session?.status ?? 'idle') && text === previous) { settled = true; break; }
    previous = text;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const state = store.getState();
  const session = state.sessions.find((s) => s.id === sid);
  return { settled, status: session?.status ?? null, reply: lastAssistant(state) };
`;

// ---------------------------------------------------------------------------

const report = {
  probe: 'm27-ask.mjs',
  criterion: 'MODEL-27',
  startedAt: new Date().toISOString(),
  rounds: [],
};

try {
  const entered = await cdp
    .evaluate(ENTER_MAIN_SURFACE)
    .catch((error) => `ERROR: ${error.message}`);
  report.welcomeEntry = entered;
  await cdp.waitFor(`document.querySelector('textarea') !== null`, {
    timeoutMs: 120_000,
    label: 'composer mounted',
  });
  await sleep(1500);

  // The announcement popup covers the composer on a cold start.
  report.dismissedNotice = await cdp.evaluate(`(() => {
    const hit = [...document.querySelectorAll('button')]
      .find((b) => ['知道了','我知道了','Got it'].includes((b.innerText || '').trim()) && b.offsetParent !== null);
    if (!hit) return null;
    hit.click();
    return (hit.innerText || '').trim();
  })()`);
  await sleep(800);

  // A FRESH session: the default landing spot is whatever was open last, and
  // this probe reads "the last assistant message" for its evidence.
  const before = await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     return chat.useChatSessionsStore.getState().activeSessionId;`,
    { label: 'active session before' }
  );
  await cdp.evaluate(`(() => {
    const hits = [...document.querySelectorAll('button[aria-label="新建对话"]')].filter((b) => b.offsetParent !== null);
    if (hits.length === 0) throw new Error('no 新建对话 button');
    hits[hits.length - 1].click();
    return true;
  })()`);
  await sleep(2500);
  const after = await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     const sid = s.activeSessionId;
     return { sid, messageCount: sid ? (s.messages[sid] ?? []).length : null };`,
    { label: 'active session after' }
  );
  const sessionId = after.sid;
  // Clicking 新建对话 on an already-empty session is a no-op, which is fine:
  // what this step needs is an EMPTY session, not necessarily a new id.
  report.session = {
    before,
    after: sessionId,
    createdNew: before !== sessionId,
    messageCount: after.messageCount,
  };
  if (!sessionId) throw new Error('no active session after 新建对话');
  if (after.messageCount !== 0) {
    throw new Error(`active session is not empty (${after.messageCount} messages)`);
  }

  report.composer = await cdp.evaluate(COMPOSER_CHROME);
  report.modelDefaults = await evalAsync(
    `const m = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     const s = m.useSettingsStore.getState();
     return { chatAgentDefaults: JSON.parse(JSON.stringify(s.chatAgentDefaults ?? null)) };`,
    { label: 'read model defaults' }
  );

  for (const spec of ROUNDS) {
    const { mode, prompt } = spec;
    const round = { mode, prompt };
    console.log(`\n[${mode}] sending`);

    round.typedChars = await cdp.evaluate(typeIntoComposer(prompt));
    await cdp.waitFor(SEND_READY, { timeoutMs: 60_000, label: `${mode}: send button ready` });
    const t0 = Date.now();
    await cdp.evaluate(CLICK_SEND);

    // The DOM card is what the criterion is about; the store is read right
    // after, so a paint delay is never mistaken for a missing payload.
    await cdp.waitFor(`${CARD} !== null`, {
      timeoutMs: 420_000,
      label: `${mode}: question card on screen`,
    });
    round.cardAtMs = Date.now() - t0;
    round.card = await cdp.evaluate(CARD);
    round.store = await evalAsync(READ_QUESTION(sessionId), {
      label: `${mode}: read store question`,
    });
    console.log(`[${mode}] card up after ${round.cardAtMs}ms`);
    console.log(JSON.stringify(round.card, null, 1));

    round.screenshot = await shoot(
      mode === 'answer' ? 'model-27-question-card.png' : 'model-27-skip.png'
    );

    if (mode === 'answer') {
      const optionLabels = (round.store.block?.questions?.[0]?.options ?? []).map((o) => o.label);
      round.optionLabelsFromStore = optionLabels;
      // Click the FIRST real option (never the trailing 其他… row) by index
      // inside the card's own radiogroup.
      round.picked = await cdp.evaluate(`(() => {
        const skip = [...document.querySelectorAll('button')]
          .find((b) => (b.innerText || '').trim() === ${JSON.stringify(SKIP_TEXT)} && b.offsetParent !== null);
        const card = skip?.closest('div[class*="rounded-md"]');
        if (!card) throw new Error('no card');
        const rows = [...card.querySelectorAll('[role="radio"],[role="checkbox"]')];
        const first = rows[0];
        if (!first) throw new Error('no option control in the card');
        const label = (first.children[1]?.childNodes[0]?.textContent || first.children[1]?.innerText || '').trim();
        if (label === ${JSON.stringify(OTHER_TEXT)}) throw new Error('first row is the free-text row');
        first.click();
        return label;
      })()`);
      console.log(`[${mode}] picked: ${round.picked}`);
      await sleep(700);
      round.cardAfterPick = await cdp.evaluate(CARD);
      round.clicked = await cdp.evaluate(`(() => {
        const skip = [...document.querySelectorAll('button')]
          .find((b) => (b.innerText || '').trim() === ${JSON.stringify(SKIP_TEXT)} && b.offsetParent !== null);
        const card = skip?.closest('div[class*="rounded-md"]');
        const rows = [...card.querySelectorAll('[role="radio"],[role="checkbox"]')];
        const go = [...card.querySelectorAll('button')]
          .filter((b) => rows.indexOf(b) === -1)
          .find((b) => (b.innerText || '').trim().startsWith(${JSON.stringify(CONTINUE_TEXT)}));
        if (!go) throw new Error('no 继续 button in the card');
        if (go.disabled) throw new Error('继续 is still disabled after picking an option');
        go.click();
        return (go.innerText || '').trim().replace(/\\s+/g, ' ');
      })()`);
    } else {
      round.picked = null;
      round.clicked = await cdp.evaluate(`(() => {
        const skip = [...document.querySelectorAll('button')]
          .find((b) => (b.innerText || '').trim() === ${JSON.stringify(SKIP_TEXT)} && b.offsetParent !== null);
        if (!skip) throw new Error('no 跳过 button');
        skip.click();
        return (skip.innerText || '').trim();
      })()`);
    }
    console.log(`[${mode}] clicked: ${round.clicked}`);

    // The card must retire, in the DOM and in the store.
    round.cardCleared = await (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const gone = await cdp.evaluate(`${CARD} === null`);
        if (gone === true) return true;
        await sleep(400);
      }
      return false;
    })();
    round.storeAfter = await evalAsync(READ_QUESTION(sessionId), {
      label: `${mode}: read store after answering`,
    });

    const settled = await evalAsync(SETTLED(sessionId, 420_000), {
      timeoutMs: 460_000,
      label: `${mode}: turn settled`,
    });
    round.settled = settled.settled;
    round.statusAfter = settled.status;
    round.reply = settled.reply.slice(0, 600);
    round.replyFull = settled.reply;
    round.totalMs = Date.now() - t0;
    console.log(`[${mode}] cardCleared=${round.cardCleared} settled=${round.settled}`);
    console.log(`[${mode}] reply: ${round.reply.slice(0, 300).replace(/\n/g, ' | ')}`);
    report.rounds.push(round);
    await sleep(2000);
  }

  const [answered, skipped] = report.rounds;
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  report.verdict = {
    cardAppearedBothTimes: report.rounds.length === 2 && report.rounds.every((r) => r.card != null),
    storeParkedBothTimes: report.rounds.every(
      (r) => r.store?.pending != null && r.store?.block != null
    ),
    // 2 offered options + the trailing 其他… row.
    cardHadTwoOptionsPlusOther: (answered?.card?.options?.length ?? 0) >= 3,
    hasSkipAndContinue:
      (answered?.card?.buttons ?? []).some((b) => b === SKIP_TEXT) &&
      (answered?.card?.buttons ?? []).some((b) => b.startsWith(CONTINUE_TEXT)),
    cardClearedBothTimes: report.rounds.every((r) => r.cardCleared === true),
    bothTurnsSettled: report.rounds.every((r) => r.settled === true),
    // The model must echo back the option the user actually chose.
    answerReachedModel:
      answered?.picked != null &&
      new RegExp(escapeRegExp(answered.picked), 'i').test(answered.replyFull ?? ''),
    // A skip is a sentence, not silence: the model should say it chose a default.
    skipReachedModel: /默认|default|自行|我选|跳过|未回答|没有回答/i.test(skipped?.replyFull ?? ''),
    // The two rounds must be different questions (no cache echo).
    twoDistinctQuestions:
      (answered?.store?.block?.questions?.[0]?.question ?? 'a') !==
      (skipped?.store?.block?.questions?.[0]?.question ?? 'b'),
  };
  report.verdict.pass = Object.values(report.verdict).every((v) => v === true);
  report.rendererProblems = cdp.problems.slice(0, 20);
  console.log(`\n${JSON.stringify(report.verdict, null, 1)}`);
} catch (error) {
  report.error = String(error?.stack ?? error?.message ?? error);
  console.error('probe failed:', report.error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  try {
    report.rendererProblems = report.rendererProblems ?? cdp.problems.slice(0, 20);
  } catch {
    /* socket already gone */
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, 'model-27-report.json');
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report → ${file}`);
  cdp.close();
}
