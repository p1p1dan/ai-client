/**
 * rc-lib.mjs — probes added for the T128 GUI re-check (2026-09-24).
 *
 * Run every rc*.mjs with `IJ_PROFILE=ijrc IJ_OUT=recheck-t128` so the shared
 * ij-lib writes into `recheck-t128/{shots,data}` and drives the throwaway
 * profile. Nothing here writes to src/ or to any real profile.
 */
import { STORE_IMPORT, TRANSCRIPT_VP } from './ij-lib.mjs';

/** Store facts for the failure surface (status survives the closing idle since T128). */
export const failureStore = (sid) => `
  ${STORE_IMPORT}
  const st = chat.useChatSessionsStore.getState();
  const x = st.sessions.find((v) => v.id === ${JSON.stringify(sid)});
  return { t: new Date().toISOString(), status: x?.status ?? null, failureSettled: x?.failureSettled ?? null,
    runtimeError: x?.runtimeError ?? null, runtimeErrorCode: x?.runtimeErrorCode ?? null,
    title: x?.title ?? null, lastError: st.lastError ?? null,
    nextTurnStatus: chat.statusForNextTurn ? chat.statusForNextTurn(x) : 'n/a' };
`;

/**
 * DOM facts for the failure surface: the timeline card, the composer's raw red
 * box (the one outside the transcript with the mono destructive styling), the
 * sidebar row's failed marker and the 「会话分支」 button.
 */
export const failureDom = (title) => `(() => {
  const vis = (n) => n.offsetParent !== null;
  const vp = ${TRANSCRIPT_VP};
  const cards = vp ? [...vp.querySelectorAll('[role="alert"]')].filter(vis).map((n) => ({
    text: (n.innerText || '').trim().slice(0, 700),
    title: (n.querySelector('p')?.innerText || '').trim(),
    buttons: [...n.querySelectorAll('button')].map((b) => (b.innerText || '').trim()),
    rawEnglishInside: /The model wrote the same/.test(n.innerText || ''),
  })) : [];
  const composerBoxes = [...document.querySelectorAll('div')].filter(vis)
    .filter((n) => !(vp && vp.contains(n)) && /bg-destructive\\/10/.test(String(n.className)) && /font-mono/.test(String(n.className)))
    .map((n) => (n.innerText || '').trim().slice(0, 400));
  const bodyText = document.body.innerText || '';
  const rawEnglishAnywhere = bodyText.includes('The model wrote the same');
  const rawEnglishOutsideTranscript = rawEnglishAnywhere && !(vp && (vp.innerText || '').includes('The model wrote the same'))
    ? true : composerBoxes.some((t) => t.includes('The model wrote the same'));
  const rows = [...document.querySelectorAll('[role="button"][title]')].filter(vis)
    .filter((n) => n.getAttribute('title') === ${JSON.stringify(title ?? '')});
  const sidebar = rows.map((r) => ({
    text: (r.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 160),
    failedBadge: [...r.querySelectorAll('span, div')].some((s) => (s.innerText || '').trim() === 'failed'),
    destructiveDot: !!r.querySelector('.bg-destructive'),
    dotLabel: r.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label') ?? null,
  }));
  const tree = [...document.querySelectorAll('button')].filter(vis)
    .filter((b) => (b.getAttribute('title') || '') === '会话分支' || (b.innerText || '').trim() === '会话分支')
    .map((b) => ({ text: (b.innerText || '').trim(), disabled: b.disabled === true }));
  return { t: new Date().toISOString(), cards, composerBoxes, rawEnglishAnywhere, rawEnglishOutsideTranscript, sidebar, tree };
})()`;

/** Click the 「继续」 button inside the timeline's failure card. */
export const CLICK_CARD_CONTINUE = `(() => {
  const vp = ${TRANSCRIPT_VP};
  const card = [...vp.querySelectorAll('[role="alert"]')].find((n) => n.offsetParent !== null && /重复调用|停下|失败|出错/.test(n.innerText || ''));
  if (!card) return { ok: false, why: 'no card' };
  const b = [...card.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === '继续');
  if (!b) return { ok: false, why: 'no continue button', buttons: [...card.querySelectorAll('button')].map((x) => (x.innerText || '').trim()) };
  b.click();
  return { ok: true, at: new Date().toISOString() };
})()`;

/** Toasts currently on screen (Base UI toast viewport). */
export const TOASTS = `(() => {
  const titles = [...document.querySelectorAll('[data-slot="toast-title"]')];
  const out = titles.map((n) => {
    const root = n.closest('[data-slot="toast-viewport"] > *') ?? n.parentElement?.parentElement ?? n;
    return { title: (n.innerText || '').trim(),
      description: (root.querySelector('[data-slot="toast-description"]')?.innerText || '').trim() };
  });
  return out.slice(0, 8);
})()`;

/** Every visible text line in the body matching a regex (cheap text-level fallback). */
export const bodyLines = (re) =>
  `(() => (document.body.innerText || '').split('\\n').map((l) => l.trim()).filter((l) => ${re}.test(l)).slice(0, 20))()`;

/**
 * Tool rows of the transcript: every element that carries the tool-row verb
 * span with an optional outcome word (data-slot="tool-row-outcome").
 */
export const TOOL_ROWS_WITH_OUTCOME = (needle) => `(() => {
  const vp = ${TRANSCRIPT_VP};
  const secs = [...vp.querySelectorAll('section[data-turn-id]')];
  const sec = ${needle ? `secs.find((s) => (s.innerText || '').includes(${JSON.stringify(needle)}))` : 'secs.at(-1)'};
  if (!sec) return null;
  const outcomes = [...sec.querySelectorAll('[data-slot="tool-row-outcome"]')];
  const rowOf = (n) => n.closest('button, [role="button"], summary') ?? n.parentElement;
  const rows = outcomes.map((o) => {
    const r = rowOf(o);
    const txt = (r?.innerText || '').trim().replace(/\\s+/g, ' ');
    return { text: txt.slice(0, 140), outcome: (o.innerText || '').trim(), outcomeColor: getComputedStyle(o).color,
      rowColor: r ? getComputedStyle(r).color : null, verbColor: r?.querySelector('span') ? getComputedStyle(r.querySelector('span')).color : null,
      destructive: /destructive/.test(String(r?.className ?? '')) || !!r?.querySelector('[class*="text-destructive"]') };
  });
  const hist = {};
  for (const r of rows) hist[r.outcome] = (hist[r.outcome] ?? 0) + 1;
  return { outcomeRows: rows.length, hist, spinners: sec.querySelectorAll('[class*="animate-spin"]').length,
    redTextNodes: sec.querySelectorAll('[class*="text-destructive"]').length, sample: rows.slice(0, 6), last: rows.slice(-3) };
})()`;

/** The visible clock facts of the turn whose text contains `needle`. */
export const turnClock = (needle) => `(() => {
  const vp = ${TRANSCRIPT_VP};
  const sec = [...vp.querySelectorAll('section[data-turn-id]')].find((s) => (s.innerText || '').includes(${JSON.stringify(needle)}));
  if (!sec) return null;
  const text = (sec.innerText || '').replace(/\\s+/g, ' ');
  return { worked: (text.match(/已工作[^·✻]*?秒|已工作[^·✻]*?分/) ?? [null])[0]?.trim() ?? null,
    completed: (text.match(/完成于 \\d\\d:\\d\\d/) ?? [null])[0], tail: text.slice(-160),
    summary: [...sec.querySelectorAll('details > summary')].map((s) => (s.innerText || '').trim().replace(/\\s+/g, ' ')).slice(0, 3) };
})()`;
export const storeStamps = (sid) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const msgs = chat.useChatSessionsStore.getState().messages[${JSON.stringify(sid)}] ?? [];
  return msgs.map((m) => ({ id: m.id, role: m.role, stopCause: m.stopCause ?? null, timestamp: m.timestamp ?? null, settledAt: m.settledAt ?? null,
    iso: m.timestamp ? new Date(m.timestamp).toISOString() : null, settledIso: m.settledAt ? new Date(m.settledAt).toISOString() : null }));
`;

/**
 * Open a conversation through its REAL sidebar row (the path that resumes a
 * session with no timeline yet after a restart). The same title shows twice —
 * under 「最近」 and under the repository — so the first visible row is
 * clicked; pc-lib's `switchTo` insists on exactly one match and fell back to
 * a bare `selectSession`, which shows an empty transcript after a restart.
 */
export async function openFromSidebar(cdp, evalAsync, sessionId, sleepFn) {
  const title = await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     return chat.useChatSessionsStore.getState().sessions.find((x) => x.id === ${JSON.stringify(sessionId)})?.title ?? null;`
  );
  const clicked = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="button"][title]')].filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(title)});
    if (!rows.length) return { ok: false, matches: 0 };
    rows[0].click();
    return { ok: true, matches: rows.length };
  })()`);
  let active = null;
  for (let i = 0; i < 25; i += 1) {
    active = await evalAsync(
      `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts'); return chat.useChatSessionsStore.getState().activeSessionId;`
    );
    if (active === sessionId) break;
    await sleepFn(400);
  }
  return { sessionId, title, clicked, activeSessionId: active };
}
