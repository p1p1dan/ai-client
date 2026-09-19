/**
 * pc-lib.mjs — shared page helpers for the 2026-09-19 MODEL point-check
 * (MODEL-19 / MODEL-23 / MODEL-11).
 *
 * Everything here is lifted verbatim from `m27-ask.mjs` (which ran green on
 * this build) so the three probes below cannot drift from the one recipe that
 * is known to work: `evalAsync` stashes async page work on `window` because
 * `Runtime.evaluate` is always called with `awaitPromise:false`; every injected
 * snippet is a self-contained IIFE because `evaluate` runs in global scope; the
 * composer is typed into FIRST and the send button polled for AFTER (it is
 * correctly disabled while the box is empty).
 */
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';

export const SKIP_TEXT = '跳过';
export const CONTINUE_TEXT = '继续';
export const OTHER_TEXT = '其他…';
export const SEND_LABEL = '发送消息';
/** zh copy for `PERMISSION_ALLOW` — `i18n.ts` maps Allow → 直接允许 (NOT 本会话内允许). */
export const ALLOW_TEXT = '直接允许';
export const ALLOW_SESSION_TEXT = '本会话内允许';

let slot = 0;

export function makeEval(cdp, prefix = 'pc') {
  return async function evalAsync(body, { timeoutMs = 120_000, label = 'evalAsync' } = {}) {
    const key = `__${prefix}_${slot++}`;
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
  };
}

export async function shoot(cdp, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

export function writeJson(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

/** The live QA card, anchored on 跳过 (unique to the question card). */
export const CARD = `(() => {
  const skip = [...document.querySelectorAll('button')]
    .find((b) => (b.innerText || '').trim() === ${JSON.stringify(SKIP_TEXT)} && b.offsetParent !== null);
  if (!skip) return null;
  const card = skip.closest('div[class*="rounded-md"]');
  if (!card) return null;
  const rows = [...card.querySelectorAll('[role="radio"],[role="checkbox"]')];
  return {
    text: card.innerText,
    buttons: [...card.querySelectorAll('button')]
      .filter((b) => rows.indexOf(b) === -1)
      .map((b) => ({
        text: (b.innerText || '').trim().replace(/\\s+/g, ' '),
        disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true',
      })),
    options: rows.map((o, i) => ({
      index: i,
      role: o.getAttribute('role'),
      ariaChecked: o.getAttribute('aria-checked'),
      visible: o.offsetParent !== null,
      letter: (o.children[0]?.innerText || '').trim(),
      label: (o.children[1]?.childNodes[0]?.textContent || o.children[1]?.innerText || '').trim(),
    })),
  };
})()`;

/** The live permission card, anchored on 直接允许. */
export const PERMISSION_CARD = `(() => {
  const allow = [...document.querySelectorAll('button')]
    .find((b) => (b.innerText || '').trim() === ${JSON.stringify(ALLOW_TEXT)} && b.offsetParent !== null);
  if (!allow) return null;
  const card = allow.closest('div[class*="rounded-md"]');
  if (!card) return null;
  return {
    text: card.innerText,
    buttons: [...card.querySelectorAll('button')]
      .map((b) => (b.innerText || '').trim().replace(/\\s+/g, ' '))
      .filter(Boolean),
  };
})()`;

export const typeIntoComposer = (text) => `(() => {
  const ta = document.querySelector('textarea');
  if (!ta) throw new Error('no composer textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return ta.value.length;
})()`;

export const SEND_READY = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')]
    .find((n) => n.getAttribute('aria-label') === ${JSON.stringify(SEND_LABEL)});
  return !!b && !b.disabled && b.offsetParent !== null;
})()`;

export const CLICK_SEND = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')]
    .find((n) => n.getAttribute('aria-label') === ${JSON.stringify(SEND_LABEL)});
  if (!b) throw new Error('no send button');
  if (b.disabled) throw new Error('send button is disabled');
  b.click();
  return true;
})()`;

/**
 * Everything the criteria ask about, read off the store rather than the paint:
 * the whole `pendingQuestions` array (global, not per session — that IS the
 * MODEL-19 question), plus a block-by-block structure summary of one session.
 */
export const storeSummary = (sessionId) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const s = chat.useChatSessionsStore.getState();
  const sid = ${JSON.stringify(sessionId)};
  const msgs = s.messages[sid] ?? [];
  const clip = (v, n) => (v == null ? undefined : String(v).slice(0, n));
  const counts = {};
  const messages = msgs.map((m) => ({
    id: m.id,
    role: m.role,
    blocks: (m.blocks ?? []).map((b) => {
      counts[b.type] = (counts[b.type] ?? 0) + 1;
      return {
        id: b.id,
        type: b.type,
        toolName: b.toolName,
        toolOk: b.toolOk,
        textLen: b.text == null ? undefined : String(b.text).length,
        textHead: clip(b.text, 160),
        toolInputHead: b.toolInput === undefined ? undefined : clip(JSON.stringify(b.toolInput), 240),
        toolOutputHead: b.toolOutput === undefined ? undefined : clip(JSON.stringify(b.toolOutput), 240),
        questionId: b.questionId,
        questionCount: b.questions ? b.questions.length : undefined,
        resolved: b.resolved,
        questionOutcome: b.questionOutcome,
        questionAnswers: b.questionAnswers ? JSON.parse(JSON.stringify(b.questionAnswers)) : undefined,
        questionResponse: clip(b.questionResponse, 120),
        permissionId: b.permissionId,
        permissionDecision: b.permissionDecision,
        allowed: b.allowed,
        permissionActivity: b.permissionActivity
          ? JSON.parse(JSON.stringify(b.permissionActivity))
          : undefined,
      };
    }),
  }));
  const session = s.sessions.find((x) => x.id === sid) ?? null;
  return {
    sessionId: sid,
    activeSessionId: s.activeSessionId,
    status: session?.status ?? null,
    title: session?.title ?? null,
    messageCount: msgs.length,
    blockTypeCounts: counts,
    messages,
    pendingQuestions: JSON.parse(JSON.stringify(s.pendingQuestions)),
    pendingPermissions: JSON.parse(JSON.stringify(s.pendingPermissions)),
    sessions: s.sessions.map((x) => ({ id: x.id, title: x.title, status: x.status })),
  };
`;

/** What the transcript actually PAINTS — cards, permission audit rows, text. */
export const DOM_SUMMARY = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const cards = [...document.querySelectorAll('div[class*="rounded-md"][class*="bg-card"]')]
    .filter(vis)
    .map((n) => ({
      text: (n.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 300),
      buttons: [...n.querySelectorAll('button')]
        .map((b) => (b.innerText || '').trim().replace(/\\s+/g, ' '))
        .filter(Boolean),
      interactiveOptions: n.querySelectorAll('[role="radio"],[role="checkbox"]').length,
    }));
  // PermissionActivityRows renders <li data-tone=...> and nothing else does.
  const permissionActivityRows = [...document.querySelectorAll('li[data-tone]')].map((n) => ({
    tone: n.getAttribute('data-tone'),
    text: (n.innerText || '').trim().replace(/\\s+/g, ' '),
  }));
  const bodyText = document.body.innerText;
  return {
    cards,
    permissionActivityRows,
    mentions: {
      allow: (bodyText.match(/直接允许/g) || []).length,
      allowed: (bodyText.match(/已允许/g) || []).length,
      permissionWord: (bodyText.match(/权限/g) || []).length,
      ask: (bodyText.match(/提问|Ask/g) || []).length,
    },
    bodyText: bodyText.slice(0, 8000),
  };
})()`;

/**
 * Expand every turn work group.
 *
 * A settled turn folds its whole process — tool rows, the answered QA card, the
 * approved permission card — into one `<details>` whose `<summary>` is the
 * 「Worked for …」 line (`MessageTimeline.tsx`'s work group). Nothing about
 * MODEL-23 is visible until these are open, and `summary.click()` is the only
 * way in: the component intercepts the click and drives `open` from React
 * state, so setting `details.open` directly would be reverted on next render.
 */
export const EXPAND_WORK_GROUPS = `(() => {
  const summaries = [...document.querySelectorAll('details > summary')].filter((s) => s.offsetParent !== null);
  const opened = [];
  for (const s of summaries) {
    const d = s.parentElement;
    const text = (s.innerText || '').trim().replace(/\\s+/g, ' ');
    if (!d.open) { s.click(); opened.push(text); }
  }
  return { summaries: summaries.length, clicked: opened };
})()`;

/** Transcript-only text: the scroll viewport that actually holds the turns. */
export const TRANSCRIPT_TEXT = `(() => {
  const viewports = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')];
  let best = null;
  let bestScore = -1;
  for (const v of viewports) {
    const text = v.innerText || '';
    const score = (text.match(/Worked for|工作中|耗时/g) || []).length * 100 + text.length / 1000;
    if (score > bestScore) { bestScore = score; best = text; }
  }
  return (best ?? document.body.innerText).slice(0, 12000);
})()`;

/** A turn is over when the session leaves every busy state AND the text stops growing. */
export const settled = (sessionId, timeoutMs) => `
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
  let ok = false;
  while (Date.now() < deadline) {
    const state = store.getState();
    const session = state.sessions.find((s) => s.id === sid);
    const text = lastAssistant(state);
    if (text.length > 0 && !busy.has(session?.status ?? 'idle') && text === previous) { ok = true; break; }
    previous = text;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const state = store.getState();
  const session = state.sessions.find((s) => s.id === sid);
  return { settled: ok, status: session?.status ?? null, reply: lastAssistant(state) };
`;

/**
 * Enter the app the way every other probe in this batch does, and clear the
 * cold-start announcement dialog that otherwise covers the composer.
 */
export async function enterApp(cdp, ENTER_MAIN_SURFACE) {
  const entered = await cdp.evaluate(ENTER_MAIN_SURFACE).catch((error) => `ERROR: ${error.message}`);
  await cdp.waitFor(`document.querySelector('textarea') !== null`, {
    timeoutMs: 180_000,
    label: 'composer mounted',
  });
  await sleep(1500);
  const dismissed = await cdp.evaluate(`(() => {
    const hit = [...document.querySelectorAll('button')]
      .find((b) => ['知道了','我知道了','Got it'].includes((b.innerText || '').trim()) && b.offsetParent !== null);
    if (!hit) return null;
    hit.click();
    return (hit.innerText || '').trim();
  })()`);
  await sleep(800);
  return { entered, dismissed };
}

/**
 * Switch sessions through the REAL sidebar row when its title is unambiguous,
 * because that path (`useActivateSession`) is the one that resumes a session
 * with no timeline yet — a bare `selectSession` would show an empty transcript
 * after a restart. Falls back to the store action and says so in the result.
 */
export async function switchTo(cdp, evalAsync, sessionId) {
  const title = await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     const hit = s.sessions.find((x) => x.id === ${JSON.stringify(sessionId)});
     return hit ? hit.title : null;`,
    { label: 'title of target session' }
  );
  let via = 'sidebar';
  const clicked = title
    ? await cdp.evaluate(`(() => {
        const rows = [...document.querySelectorAll('[role="button"][title]')]
          .filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(title)});
        if (rows.length !== 1) return { ok: false, matches: rows.length };
        rows[0].click();
        return { ok: true, matches: 1 };
      })()`)
    : { ok: false, matches: 0 };

  let active = null;
  if (clicked.ok) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      active = await evalAsync(
        `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
         return chat.useChatSessionsStore.getState().activeSessionId;`,
        { label: 'active session after sidebar click' }
      );
      if (active === sessionId) break;
      await sleep(400);
    }
  }
  if (active !== sessionId) {
    via = 'store.selectSession';
    await evalAsync(
      `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
       chat.useChatSessionsStore.getState().selectSession(${JSON.stringify(sessionId)});
       return true;`,
      { label: 'selectSession fallback' }
    );
    await sleep(1200);
    active = await evalAsync(
      `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
       return chat.useChatSessionsStore.getState().activeSessionId;`,
      { label: 'active session after fallback' }
    );
  }
  await sleep(1200);
  return { sessionId, title, via, sidebarMatches: clicked.matches, activeSessionId: active };
}
