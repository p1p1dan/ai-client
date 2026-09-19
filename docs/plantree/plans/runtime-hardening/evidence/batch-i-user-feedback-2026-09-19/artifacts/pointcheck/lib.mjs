/**
 * Batch I GUI point-check — shared helpers.
 *
 * Built on the existing toolkit, never from scratch:
 *   - CDP driver / ENTER_MAIN_SURFACE : scripts/h21-cdp.mjs
 *   - evalAsync / screenshots         : batch-h .../pointcheck/tools/pc-lib.mjs
 *   - store + sidebar + composer reads: batch-i .../t091-repro/lib.mjs
 *
 * CDP discipline baked in below (all learned the hard way, see the handbook):
 *   - every injected snippet is a self-contained IIFE (`evaluate` runs in the
 *     page's global scope, so `const x = …` would poison the next call)
 *   - never `await` a long promise through `evaluate`; `evalAsync` stashes the
 *     result on `window` and polls for it
 *   - the store is imported as '/stores/chatSessions.ts', NEVER '/@fs/…'
 *     (the `/@fs/` form resolves to a second module instance and edits to it
 *     are silently invisible to the UI)
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { makeEval } from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck/tools/pc-lib.mjs';
import { Cdp, ENTER_MAIN_SURFACE, sleep } from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';

export const REPO = '/home/ai/code/ai-client';
export const OUT = path.dirname(fileURLToPath(import.meta.url));
export const SHOTS = path.join(OUT, 'shots');
export const DATA = path.join(OUT, 'data');
export const WS = '/tmp/pc-i/ws';
export const PORT = 9222;
export const GATEWAY_PORT = 18099;
export const DEV_LOG = '/tmp/pc-i/dev.log';
export const MAIN_LOG = '/home/ai/.config/jyw-ai-client-dev/logs/aiclient-2026-09-19.log';

export { sleep, ENTER_MAIN_SURFACE };
export const stamp = () => new Date().toISOString();

export async function connect(timeoutMs = 240_000) {
  const cdp = await Cdp.attach(PORT, timeoutMs);
  const evalAsync = makeEval(cdp, 'pci');
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

// --- process handling --------------------------------------------------------

/**
 * Every pid whose `/proc/<pid>/cmdline` matches, read from /proc directly.
 *
 * `ps -ef | grep <word>` is banned for this: it matches the grep's own command
 * line, so the count is always wrong by one and sometimes wrong by more.
 */
export function pidsMatching(needle) {
  const out = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let cmd;
    try {
      cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue; // died between readdir and read
    }
    if (cmd.includes(needle)) out.push(Number(entry));
  }
  return out.sort((a, b) => a - b);
}

/** Session worker processes: Electron utility processes running node. */
export const workerPids = () => pidsMatching('utility-sub-type=node.mojom.NodeService');

export function startApp({ openPath = WS, env = {} } = {}) {
  fs.mkdirSync(path.dirname(DEV_LOG), { recursive: true });
  const fd = fs.openSync(DEV_LOG, 'w');
  const child = spawn(
    'node',
    [
      path.join(REPO, 'scripts/dev.js'),
      `--open-path=${openPath}`,
      `--remote-debugging-port=${PORT}`,
    ],
    {
      cwd: REPO,
      stdio: ['ignore', fd, fd],
      detached: true,
      env: {
        ...process.env,
        ...env,
        DISPLAY: process.env.DISPLAY ?? ':0',
        // Chromium only reads the lowercase form; the uppercase NO_PROXY this
        // shell sets is invisible to it and the window then never appears.
        no_proxy: [process.env.no_proxy, 'localhost,127.0.0.1,::1'].filter(Boolean).join(','),
      },
    }
  );
  child.unref();
  return child.pid;
}

/** Block until main says the window is really on screen. */
export async function waitForWindow(timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let log = '';
    try {
      log = fs.readFileSync(DEV_LOG, 'utf8');
    } catch {
      /* not created yet */
    }
    if (log.includes('Showing main window')) return { ok: true, at: stamp() };
    await sleep(2000);
  }
  throw new Error('dev log never printed "Showing main window"');
}

/**
 * Stop the app by pid, never `pkill -f`.
 *
 * SIGTERM to the dev.js wrapper first — it walks its own process tree and
 * terminates each child — then a precise sweep for anything left behind.
 */
export function stopApp() {
  const wrappers = pidsMatching('scripts/dev.js');
  for (const pid of wrappers) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  spawnSync('sleep', ['4']);
  const leftovers = [
    ...pidsMatching(`remote-debugging-port=${PORT}`),
    ...pidsMatching('electron-vite'),
  ];
  for (const pid of new Set(leftovers)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return { wrappers, leftovers: [...new Set(leftovers)] };
}

// --- page snippets -----------------------------------------------------------

export const STORE = `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const s = chat.useChatSessionsStore.getState();
  return {
    t: new Date().toISOString(),
    activeSessionId: s.activeSessionId,
    sessionCount: s.sessions.length,
    sessions: s.sessions.slice(0, 12).map((x) => ({
      id: x.id, title: x.title, status: x.status, workspaceId: x.workspaceId,
      projectId: x.projectId, unbound: x.unbound ? JSON.parse(JSON.stringify(x.unbound)) : null,
      updatedAt: x.updatedAt,
    })),
    hostBoundSessionIds: [...s.hostBoundSessionIds],
    recentSessionIds: s.recentSessionIds.slice(0, 8),
    pendingPermissions: JSON.parse(JSON.stringify(s.pendingPermissions)),
    msgCounts: Object.fromEntries(Object.entries(s.messages).map(([k, v]) => [k, v.length])),
    lastError: s.lastError,
  };
`;

export const sessionStatus = (id) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const s = chat.useChatSessionsStore.getState();
  const x = s.sessions.find((v) => v.id === ${JSON.stringify(id)});
  return { t: new Date().toISOString(), status: x?.status ?? null, title: x?.title ?? null,
           msgs: (s.messages[${JSON.stringify(id)}] ?? []).length,
           hostBound: s.hostBoundSessionIds.includes(${JSON.stringify(id)}),
           active: s.activeSessionId, retry: x?.retry ? JSON.parse(JSON.stringify(x.retry)) : null };
`;

export const messagesOf = (sid) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const s = chat.useChatSessionsStore.getState();
  const msgs = s.messages[${JSON.stringify(sid)}] ?? [];
  return msgs.map((m) => ({
    id: m.id, role: m.role,
    blocks: (m.blocks ?? []).map((b) => ({
      id: b.id, type: b.type, toolName: b.toolName, toolOk: b.toolOk,
      text: b.text == null ? undefined : String(b.text).slice(0, 200),
      toolInput: b.toolInput === undefined ? undefined : JSON.stringify(b.toolInput).slice(0, 300),
    })),
  }));
`;

/** Composer round-slot buttons — the surface T091 is about. */
export const COMPOSER = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const byLabel = (label) =>
    [...document.querySelectorAll('button[aria-label]')]
      .filter((b) => b.getAttribute('aria-label') === label)
      .map((b) => ({ disabled: b.disabled === true, visible: vis(b) }));
  const ta = document.querySelector('textarea');
  return {
    t: new Date().toISOString(),
    send: byLabel('发送消息'),
    stop: byLabel('停止当前回合'),
    queue: byLabel('加入队列'),
    textareaValue: ta ? ta.value : null,
    allAriaLabels: [...document.querySelectorAll('button[aria-label]')]
      .filter(vis).map((b) => b.getAttribute('aria-label')).slice(0, 60),
  };
})()`;

export const SIDEBAR = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const rows = [...document.querySelectorAll('[role="button"][title]')]
    .filter(vis)
    .map((n) => ({
      title: n.getAttribute('title'),
      text: (n.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
      active: /bg-selection/.test(n.className || ''),
    }));
  const newBtn = [...document.querySelectorAll('button')].find(
    (b) => /^(新建|New)$/.test((b.innerText || '').trim()) && vis(b)
  );
  return { t: new Date().toISOString(), rows, hasNewButton: !!newBtn };
})()`;

export const typeInto = (text) => `(() => {
  const ta = document.querySelector('textarea');
  if (!ta) throw new Error('no composer textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return ta.value.length;
})()`;

export const clickLabel = (label) => `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')]
    .find((n) => n.getAttribute('aria-label') === ${JSON.stringify(label)} && n.offsetParent !== null);
  if (!b) return { ok: false, why: 'not found' };
  if (b.disabled) return { ok: false, why: 'disabled' };
  b.click();
  return { ok: true, at: new Date().toISOString() };
})()`;

export const clickText = (text) => `(() => {
  const b = [...document.querySelectorAll('button, [role="menuitem"], [role="button"]')]
    .find((n) => (n.innerText || '').trim() === ${JSON.stringify(text)} && n.offsetParent !== null);
  if (!b) return { ok: false, why: 'not found' };
  b.click();
  return { ok: true, at: new Date().toISOString() };
})()`;

export const CLICK_SEND = clickLabel('发送消息');
export const CLICK_STOP = clickLabel('停止当前回合');

export const CLICK_NEW = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const b = [...document.querySelectorAll('button')].find(
    (n) => /^(新建|New)$/.test((n.innerText || '').trim()) && vis(n)
  );
  if (!b) throw new Error('no 新建 button');
  const at = new Date().toISOString();
  b.click();
  return { at };
})()`;

/**
 * The transcript viewport — the one scroll area that actually holds the turns.
 *
 * Picked by WIDTH, which is the only property that separates it reliably. The
 * obvious "longest innerText" heuristic is wrong on this machine and silently
 * so: the sidebar lists 200+ conversations, so its scroller carries several
 * times the transcript's text and every read lands on the wrong element while
 * still returning plausible-looking data. The sidebar is ~250 px wide and the
 * transcript column is ~800 px, so the widest visible scroller is the one.
 */
export const TRANSCRIPT_VIEWPORT_JS = `(() => {
  const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
    .filter((v) => v.offsetParent !== null);
  let best = null, bestWidth = -1;
  for (const v of vps) {
    const w = v.getBoundingClientRect().width;
    if (w > bestWidth) { bestWidth = w; best = v; }
  }
  return best;
})()`;

/** Every visible timeline row that names a tool, with its live text. */
export const TOOL_ROWS = `(() => {
  const vp = ${TRANSCRIPT_VIEWPORT_JS};
  const root = vp ?? document.body;
  const vis = (n) => n.offsetParent !== null;
  // A tool row is a details/summary or a div carrying a tool verb. Read every
  // short line in the transcript and keep the ones that look like tool rows.
  const lines = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let cur = walker.currentNode;
  while (cur) {
    if (vis(cur) && (cur.tagName === 'SUMMARY' || cur.getAttribute('data-slot') === 'tool-row' ||
        (cur.children.length === 0 && (cur.innerText || '').trim().length > 0))) {
      const txt = (cur.innerText || '').trim().replace(/\\s+/g, ' ');
      if (txt && txt.length < 200) lines.push({ tag: cur.tagName, text: txt });
    }
    cur = walker.nextNode();
  }
  const text = (root.innerText || '');
  return {
    t: new Date().toISOString(),
    matchedRows: lines.filter((l) => /已收到|编辑中|已编辑|写入|demo\\/out\\.html|out\\.html/.test(l.text)),
    detailsCount: root.querySelectorAll('details').length,
    hasWritePath: /out\\.html/.test(text),
    linesSoFar: (text.match(/已收到 \\d+ 行/g) || []),
    transcriptTail: text.slice(-1800),
  };
})()`;

/**
 * The thought row: its trigger, whether the body is rendered, where the trigger
 * sits relative to the scroll viewport, and whether its background is opaque.
 */
export const THOUGHT_STATE = `(() => {
  const vp = ${TRANSCRIPT_VIEWPORT_JS};
  const vis = (n) => n.offsetParent !== null;
  const root = vp ?? document.body;
  const trigger = [...root.querySelectorAll('button, summary, [role="button"]')]
    .filter(vis)
    .find((n) => /^(思考中|已思考|思考)/.test((n.innerText || '').trim().replace(/\\s+/g, ' ')));
  if (!trigger) {
    return { t: new Date().toISOString(), found: false,
             transcriptHead: (root.innerText || '').slice(0, 600) };
  }
  const tr = trigger.getBoundingClientRect();
  const vpRect = vp ? vp.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const style = getComputedStyle(trigger);
  // The sticky wrapper may be the trigger's parent rather than the trigger.
  const stickyAncestor = (() => {
    let n = trigger;
    for (let i = 0; i < 4 && n; i += 1) {
      if (getComputedStyle(n).position === 'sticky') return {
        tag: n.tagName, position: 'sticky',
        background: getComputedStyle(n).backgroundColor,
        top: n.getBoundingClientRect().top,
        height: n.getBoundingClientRect().height,
      };
      n = n.parentElement;
    }
    return null;
  })();
  const chevron = trigger.querySelector('svg') ?? trigger.parentElement?.querySelector('svg') ?? null;
  const body = (() => {
    const holder = trigger.closest('div');
    const ps = holder ? [...holder.querySelectorAll('p')] : [];
    return { paragraphs: ps.length, chars: ps.reduce((n, p) => n + (p.innerText || '').length, 0) };
  })();
  return {
    t: new Date().toISOString(),
    found: true,
    triggerText: (trigger.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
    triggerTag: trigger.tagName,
    ariaExpanded: trigger.getAttribute('aria-expanded'),
    dataState: trigger.getAttribute('data-state') ?? trigger.parentElement?.getAttribute('data-state') ?? null,
    hasChevron: !!chevron,
    triggerTop: tr.top, triggerHeight: tr.height,
    viewportTop: vpRect.top, viewportBottom: vpRect.bottom,
    offsetFromViewportTop: tr.top - vpRect.top,
    triggerPosition: style.position,
    triggerBackground: style.backgroundColor,
    stickyAncestor,
    body,
    scrollTop: vp ? vp.scrollTop : null,
    scrollHeight: vp ? vp.scrollHeight : null,
    clientHeight: vp ? vp.clientHeight : null,
  };
})()`;

export const scrollTranscript = (delta) => `(() => {
  const vp = ${TRANSCRIPT_VIEWPORT_JS};
  if (!vp) return { ok: false };
  const before = vp.scrollTop;
  vp.scrollTop = before + ${delta};
  return { ok: true, before, after: vp.scrollTop, max: vp.scrollHeight - vp.clientHeight };
})()`;

export const scrollTranscriptTo = (top) => `(() => {
  const vp = ${TRANSCRIPT_VIEWPORT_JS};
  if (!vp) return { ok: false };
  vp.scrollTop = ${top};
  return { ok: true, after: vp.scrollTop, max: vp.scrollHeight - vp.clientHeight };
})()`;

export const CLICK_THOUGHT_TRIGGER = `(() => {
  const vp = ${TRANSCRIPT_VIEWPORT_JS};
  const root = vp ?? document.body;
  const vis = (n) => n.offsetParent !== null;
  const trigger = [...root.querySelectorAll('button, summary, [role="button"]')]
    .filter(vis)
    .find((n) => /^(思考中|已思考|思考)/.test((n.innerText || '').trim().replace(/\\s+/g, ' ')));
  if (!trigger) return { ok: false, why: 'no thought trigger' };
  const before = { scrollTop: vp ? vp.scrollTop : null, top: trigger.getBoundingClientRect().top };
  trigger.click();
  return { ok: true, at: new Date().toISOString(), before };
})()`;

/** The transport-retry banner: its words, its countdown, its give-up button. */
export const RETRY_BANNER = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const give = [...document.querySelectorAll('button')]
    .find((b) => (b.innerText || '').trim() === '立即放弃' && vis(b));
  const body = document.body.innerText;
  // The zh copy is '{{delay}} 后重试'; keep the whole clause rather than
  // guessing at how the delay is spelled (8s / 1m 10s / 30 秒 …).
  const countdown = (body.match(/[^\\n]{0,24}后重试/) || [])[0] ?? null;
  return {
    t: new Date().toISOString(),
    countdownText: countdown,
    retryingNow: /正在重试…/.test(body),
    giveUpButton: !!give,
    bannerLines: body.split('\\n').filter((l) => /重试|放弃|上游|网络/.test(l)).slice(0, 8),
  };
})()`;

/** File panel tree nodes, read off the rendered tree. */
export const FILE_TREE = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const nodes = [...document.querySelectorAll('[role="treeitem"], [data-slot="tree-node"]')]
    .filter(vis)
    .map((n) => ({
      text: (n.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
      expanded: n.getAttribute('aria-expanded'),
      level: n.getAttribute('aria-level'),
    }));
  // Fallback: the panel may not use treeitem roles.
  const panelText = (() => {
    const panels = [...document.querySelectorAll('aside, [data-slot="scroll-area-viewport"]')]
      .filter(vis)
      .map((p) => (p.innerText || '').trim())
      .filter((t) => /README\\.md|alpha\\.txt|sub|keep/.test(t));
    return panels[0] ?? null;
  })();
  return { t: new Date().toISOString(), nodes, panelText };
})()`;

/** Right-click a rendered row by its visible text and report the menu items. */
export const contextMenuOn = (text) => `(() => {
  const vis = (n) => n.offsetParent !== null;
  const hit = [...document.querySelectorAll('div,span,button,[role="button"],[role="treeitem"],li')]
    .filter(vis)
    .filter((n) => (n.innerText || '').trim() === ${JSON.stringify(text)})
    .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0];
  if (!hit) return { ok: false, why: 'no row with that text' };
  const r = hit.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + r.height / 2 };
  hit.dispatchEvent(new PointerEvent('pointerdown', { ...opts, button: 2 }));
  hit.dispatchEvent(new MouseEvent('mousedown', { ...opts, button: 2 }));
  hit.dispatchEvent(new MouseEvent('contextmenu', opts));
  return { ok: true, at: new Date().toISOString(), rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
})()`;

export const MENU_ITEMS = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const popups = [...document.querySelectorAll('[data-slot="menu-popup"], [role="menu"]')].filter(vis);
  return popups.map((p) => ({
    open: p.getAttribute('data-open') !== null || p.getAttribute('data-state') === 'open',
    items: [...p.querySelectorAll('[role="menuitem"], button')]
      .map((b) => (b.innerText || '').trim().replace(/\\s+/g, ' '))
      .filter(Boolean),
  }));
})()`;

/**
 * Any open modal. The confirm this batch cares about is an ALERT dialog
 * (`role="alertdialog"`, `data-slot="alert-dialog-popup"`) — a selector list
 * that only knows `role="dialog"` reads a visible confirm box as "no dialog".
 */
export const DIALOG_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [data-slot="dialog-popup"], [data-slot="alert-dialog-popup"]';

export const DIALOG = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const d = [...document.querySelectorAll(${JSON.stringify(
    '[role="dialog"], [role="alertdialog"], [data-slot="dialog-popup"], [data-slot="alert-dialog-popup"]'
  )})].filter(vis)[0];
  if (!d) return null;
  return {
    text: (d.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 600),
    buttons: [...d.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean),
  };
})()`;
