/**
 * T091 repro shared helpers.
 *
 * Built on the existing point-check toolkit rather than from scratch:
 *   - CDP driver / ENTER_MAIN_SURFACE: /home/ai/code/ai-client/scripts/h21-cdp.mjs
 *   - evalAsync / typing / screenshots: batch-h pointcheck tools/pc-lib.mjs
 *
 * CDP discipline reminders that are already baked in below:
 *   - every injected snippet is a self-contained IIFE (evaluate runs in global scope)
 *   - never await a long promise through `evaluate`; evalAsync stashes on window
 *   - store import path is '/stores/chatSessions.ts', never '/@fs/...'
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  enterApp,
  makeEval,
} from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck/tools/pc-lib.mjs';
import { Cdp, ENTER_MAIN_SURFACE, sleep } from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';

export const OUT = '/tmp/t091-repro';
export const SHOTS = path.join(OUT, 'shots');
export const DATA = path.join(OUT, 'data');
export { sleep, ENTER_MAIN_SURFACE, enterApp };

export const stamp = () => new Date().toISOString();

export async function connect() {
  const cdp = await Cdp.attach(9222, 240_000);
  const evalAsync = makeEval(cdp, 't091');
  return { cdp, evalAsync };
}

export function save(name, value) {
  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

export async function shot(cdp, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

/** Full store read, every field the two reports hinge on. */
export const STORE = `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const s = chat.useChatSessionsStore.getState();
  return {
    t: new Date().toISOString(),
    activeSessionId: s.activeSessionId,
    sessionCount: s.sessions.length,
    sessions: s.sessions.slice(0, 8).map((x) => ({
      id: x.id, title: x.title, status: x.status, workspaceId: x.workspaceId,
      projectId: x.projectId, unbound: x.unbound ? JSON.parse(JSON.stringify(x.unbound)) : null,
      updatedAt: x.updatedAt, runtimeIdentity: x.runtimeIdentity ?? null,
    })),
    hostBoundSessionIds: [...s.hostBoundSessionIds],
    recentSessionIds: s.recentSessionIds.slice(0, 8),
    unreadSessionIds: [...s.unreadSessionIds],
    pendingPermissions: JSON.parse(JSON.stringify(s.pendingPermissions)),
    msgCounts: Object.fromEntries(Object.entries(s.messages).map(([k, v]) => [k, v.length])),
    lastError: s.lastError,
  };
`;

export const messagesOf = (sid) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const s = chat.useChatSessionsStore.getState();
  const msgs = s.messages[${JSON.stringify(sid)}] ?? [];
  return msgs.map((m) => ({
    id: m.id, role: m.role,
    blocks: (m.blocks ?? []).map((b) => ({
      type: b.type, toolName: b.toolName,
      text: b.text == null ? undefined : String(b.text).slice(0, 200),
      toolInput: b.toolInput === undefined ? undefined : JSON.stringify(b.toolInput).slice(0, 200),
    })),
  }));
`;

/**
 * What the sidebar actually PAINTS, walked in document order so a row's group
 * is read off the header that precedes it rather than guessed from the store.
 * The sidebar root is found as the nearest ancestor of the New button that also
 * contains the 最近 header — no brittle class selector.
 */
export const SIDEBAR = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const NEW_RE = /^(新建|New)$/;
  const HEAD_RE = /^(最近|Recent|项目|Projects|临时对话|Temporary chats)$/;
  const newBtn = [...document.querySelectorAll('button')].find(
    (b) => NEW_RE.test((b.innerText || '').trim()) && vis(b)
  );
  const recentHeader = [...document.querySelectorAll('p')].find(
    (p) => /^(最近|Recent)$/.test((p.innerText || '').trim())
  );
  let root = null;
  if (newBtn) {
    let n = newBtn.parentElement;
    while (n && n !== document.body) {
      if (!recentHeader || n.contains(recentHeader)) { root = n; break; }
      n = n.parentElement;
    }
  }
  root = root ?? recentHeader?.closest('section')?.parentElement ?? null;
  if (!root) return { error: 'sidebar root not found', bodyHead: document.body.innerText.slice(0, 600) };

  // Ordered walk: group headers, folder headers, rows, Show more.
  const items = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let cur = walker.currentNode;
  while (cur) {
    const role = cur.getAttribute && cur.getAttribute('role');
    const txt = (cur.innerText || '').trim().replace(/\\s+/g, ' ');
    if (role === 'button' && cur.hasAttribute('title')) {
      items.push({
        kind: 'row',
        title: cur.getAttribute('title'),
        text: txt.slice(0, 80),
        visible: vis(cur),
        active: /bg-selection/.test(cur.className || ''),
        busyDot: !!cur.querySelector('span[class*="bg-accent"],span[class*="animate"]'),
      });
    } else if (cur.tagName === 'P' && HEAD_RE.test(txt)) {
      items.push({ kind: 'groupHeader', text: txt, visible: vis(cur) });
    } else if (cur.tagName === 'BUTTON' && /^(显示更多|Show more)/.test(txt)) {
      items.push({ kind: 'showMore', text: txt, visible: vis(cur) });
    } else if (
      cur.tagName === 'BUTTON' &&
      cur.getAttribute('aria-label') &&
      /^(展开|收起)/.test(cur.getAttribute('aria-label'))
    ) {
      items.push({ kind: 'toggle', ariaLabel: cur.getAttribute('aria-label'), visible: vis(cur) });
    }
    cur = walker.nextNode();
  }
  return {
    t: new Date().toISOString(),
    items,
    rootText: (root.innerText || '').slice(0, 2500),
  };
})()`;

/** Composer round button + top bar, the surface report 1 is about. */
export const COMPOSER = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const byLabel = (label) =>
    [...document.querySelectorAll('button[aria-label]')].filter(
      (b) => b.getAttribute('aria-label') === label
    ).map((b) => ({ disabled: b.disabled === true, visible: vis(b), text: (b.innerText||'').trim() }));
  const ta = document.querySelector('textarea');
  return {
    t: new Date().toISOString(),
    send: byLabel('发送消息'),
    stop: byLabel('停止当前回合'),
    queue: byLabel('加入队列'),
    retry: byLabel('重试上一条消息'),
    textareaValue: ta ? ta.value : null,
    textareaPlaceholder: ta ? ta.placeholder : null,
    // Every round-slot button, whatever its label, so a renamed label cannot hide one.
    allAriaLabels: [...document.querySelectorAll('button[aria-label]')]
      .filter(vis)
      .map((b) => b.getAttribute('aria-label'))
      .slice(0, 60),
    bodyHasStopWord: document.body.innerText.includes('停止'),
  };
})()`;

/** IPC spy: record which sessionId each chat call actually carries. */
export const INSTALL_SPY = `(() => {
  if (window.__t091_spy) return 'already installed';
  window.__t091_calls = [];
  const api = window.electronAPI.chat;
  const wrap = (name) => {
    const original = api[name].bind(api);
    api[name] = (...args) => {
      window.__t091_calls.push({
        t: new Date().toISOString(),
        method: name,
        sessionId: args[0]?.sessionId ?? null,
        text: typeof args[0]?.text === 'string' ? args[0].text.slice(0, 120) : undefined,
      });
      return original(...args);
    };
  };
  ['send', 'stop', 'createSession', 'resumeSession', 'closeSession'].forEach(wrap);
  window.__t091_spy = true;
  return 'installed';
})()`;

export const READ_SPY = `JSON.parse(JSON.stringify(window.__t091_calls ?? []))`;

export const CLICK_NEW = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const b = [...document.querySelectorAll('button')].find(
    (n) => (n.innerText || '').trim() === '新建' && vis(n)
  );
  if (!b) throw new Error('no 新建 button');
  const t0 = new Date().toISOString();
  b.click();
  return { clickedAt: t0, title: b.getAttribute('title') };
})()`;

export const typeInto = (text) => `(() => {
  const ta = document.querySelector('textarea');
  if (!ta) throw new Error('no composer textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return ta.value.length;
})()`;

export const CLICK_SEND = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')].find(
    (n) => n.getAttribute('aria-label') === '发送消息'
  );
  if (!b) return { ok: false, why: 'no 发送消息 button' };
  if (b.disabled) return { ok: false, why: 'disabled' };
  b.click();
  return { ok: true, at: new Date().toISOString() };
})()`;

export const CLICK_STOP = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')].find(
    (n) => n.getAttribute('aria-label') === '停止当前回合'
  );
  if (!b) return { ok: false, why: 'no 停止当前回合 button' };
  b.click();
  return { ok: true, at: new Date().toISOString() };
})()`;
