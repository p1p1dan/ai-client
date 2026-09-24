/** B4 (cont.) — point the composer's first column at /tmp/ij/plain, then read the bar again. */
import { connect, mouseClickAt, save, shot, sleep, stamp } from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { at: stamp() };
const REPO_TRIGGER = `(() => {
  const ta = document.querySelector('textarea');
  const taTop = ta.getBoundingClientRect().top;
  const b = [...document.querySelectorAll('button')].filter((n) => n.offsetParent !== null)
    .filter((n) => (n.innerText || '').trim() === 'repo' && Math.abs(n.getBoundingClientRect().top - taTop) < 120)[0];
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;
const ITEMS = `(() => [...document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"]')].filter((n) => n.offsetParent !== null)
  .map((n) => { const r = n.getBoundingClientRect(); return { role: n.getAttribute('role'), text: (n.innerText || '').trim().replace(/\\s+/g, ' '), x: Math.round(r.left + Math.min(50, r.width / 2)), y: Math.round(r.top + r.height / 2) }; }))()`;
const BAR = `(() => {
  const vis = (n) => n.offsetParent !== null;
  return { branchButtons: [...document.querySelectorAll('svg.lucide-git-branch')].filter(vis).map((s) => { const r = s.getBoundingClientRect(); const h = s.closest('button'); return { text: (h?.innerText || '').trim(), top: Math.round(r.top), left: Math.round(r.left) }; }),
    composerBar: (() => { const ta = document.querySelector('textarea'); const t = ta.getBoundingClientRect().top; return [...document.querySelectorAll('button')].filter(vis).filter((b) => Math.abs(b.getBoundingClientRect().top - t) < 60 && b.getBoundingClientRect().top < t).map((b) => (b.innerText || '').trim()).filter(Boolean); })() };
})()`;
try {
  const t = await cdp.evaluate(REPO_TRIGGER);
  out.trigger = t;
  await mouseClickAt(cdp, t.x, t.y);
  await sleep(900);
  out.items = await cdp.evaluate(ITEMS);
  out.shotMenu = await shot(cdp, '51-b4-repo-menu.png');
  const plain = out.items.find((i) => /^plain/.test(i.text));
  if (plain) {
    await mouseClickAt(cdp, plain.x, plain.y);
    await sleep(2000);
  }
  out.clickedPlain = !!plain;
  out.store =
    await evalAsync(`const chat = await import('/stores/chatSessions.ts'); const s = chat.useChatSessionsStore.getState();
    const x = s.sessions.find((v) => v.id === s.activeSessionId); return { active: s.activeSessionId, workspaceId: x?.workspaceId ?? null };`);
  out.bar = await cdp.evaluate(BAR);
  out.shot = await shot(cdp, '51-b4-plain-selected.png');
  console.log(JSON.stringify(out, null, 1));
} finally {
  save('51-b4-switch.json', out);
  cdp.close();
}
