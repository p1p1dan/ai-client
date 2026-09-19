/** Diagnostic: dump the file-tree rows around tree-demo. */
import { connect, save, sleep } from './lib.mjs';

const { cdp } = await connect();
const PANEL = `(() => {
  const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
    .filter((v) => v.offsetParent !== null);
  return vps.find((v) => /node_modules|package\\.json|tsconfig/.test(v.innerText || '')) ?? null;
})()`;
const ROWS = `(() => {
  const p = ${PANEL};
  if (!p) return { ok: false };
  return {
    ok: true,
    scrollTop: p.scrollTop, max: p.scrollHeight - p.clientHeight,
    rows: [...p.querySelectorAll('[role="button"], [role="treeitem"]')]
      .filter((n) => n.offsetParent !== null)
      .map((n) => ({
        name: (n.textContent || '').trim(),
        pad: getComputedStyle(n).paddingLeft,
        depth: Math.round((parseFloat(getComputedStyle(n).paddingLeft) - 8) / 12),
        expanded: n.getAttribute('aria-expanded'),
      })).filter((r) => r.name),
  };
})()`;
try {
  const max = await cdp.evaluate(`(() => { const p = ${PANEL}; return p ? p.scrollHeight - p.clientHeight : 0; })()`);
  const seen = [];
  for (let top = 0; top <= max + 240; top += 240) {
    await cdp.evaluate(`(() => { const p = ${PANEL}; if (p) p.scrollTop = ${top}; })()`);
    await sleep(180);
    const r = await cdp.evaluate(ROWS);
    for (const row of r.rows) seen.push({ top, ...row });
  }
  const interesting = seen.filter((r) => /tree-demo|alpha|beta|gamma|pointcheck/.test(r.name));
  console.log('max scroll:', max, 'rows seen:', seen.length);
  console.log(JSON.stringify(interesting, null, 1));
  save('12x-rows.json', { max, interesting, all: seen.map((r) => `${r.depth}:${r.name}`) });
} finally {
  cdp.close();
}
