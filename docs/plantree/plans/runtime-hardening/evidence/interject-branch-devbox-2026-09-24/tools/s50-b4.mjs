/** B4 — a non-git folder as the workspace: no branch column at all. */
import { connect, save, shot, stamp } from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { at: stamp() };
const BAR = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const ta = document.querySelector('textarea');
  const branchIcons = [...document.querySelectorAll('svg.lucide-git-branch')].filter(vis).map((s) => {
    const host = s.closest('button, span, div');
    const r = s.getBoundingClientRect();
    return { hostTag: host?.tagName, text: (host?.innerText || '').trim().slice(0, 60), top: Math.round(r.top), left: Math.round(r.left) };
  });
  const taRect = ta?.getBoundingClientRect();
  return { branchIcons, textareaTop: taRect ? Math.round(taRect.top) : null,
    targetBarText: [...document.querySelectorAll('div')].filter(vis).filter((d) => /本机/.test(d.innerText || '') && (d.innerText || '').length < 80).map((d) => (d.innerText || '').trim().replace(/\\s+/g, ' ')).slice(-3) };
})()`;
try {
  out.store =
    await evalAsync(`const chat = await import('/stores/chatSessions.ts'); const s = chat.useChatSessionsStore.getState();
    const x = s.sessions.find((v) => v.id === s.activeSessionId); return { active: s.activeSessionId, workspaceId: x?.workspaceId ?? null, title: x?.title ?? null };`);
  out.bar = await cdp.evaluate(BAR);
  out.shot = await shot(cdp, '50-b4-plain-folder.png');
  console.log(JSON.stringify(out, null, 1));
} finally {
  save('50-b4.json', out);
  cdp.close();
}
