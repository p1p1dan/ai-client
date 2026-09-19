/**
 * T101 follow-up — a settled turn folds everything into ONE work group, so the
 * tool row is only reachable after that group is opened. Checks the row is
 * expandable, that opening it shows a preview, and reads the work-group head
 * verbatim (it came back in English the first time round).
 */
import { connect, save, shot, sleep } from './lib.mjs';

const { cdp } = await connect();
const VP = `(() => {
  const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
    .filter((v) => v.offsetParent !== null);
  let best = null, w = -1;
  for (const v of vps) { const x = v.getBoundingClientRect().width; if (x > w) { w = x; best = v; } }
  return best;
})()`;

try {
  const head = await cdp.evaluate(`(() => {
    const vp = ${VP};
    const sums = [...vp.querySelectorAll('details > summary')];
    return sums.map((s) => ({ text: (s.innerText || '').trim().replace(/\\s+/g, ' '),
                              open: s.parentElement.open }));
  })()`);
  console.log('work-group summaries BEFORE:', JSON.stringify(head));
  save('03b-00-summaries.json', head);

  const opened = await cdp.evaluate(`(() => {
    const vp = ${VP};
    const sums = [...vp.querySelectorAll('details > summary')].filter((s) => s.offsetParent !== null);
    const clicked = [];
    for (const s of sums) { if (!s.parentElement.open) { s.click(); clicked.push((s.innerText||'').trim().replace(/\\s+/g,' ')); } }
    return clicked;
  })()`);
  console.log('opened work groups:', JSON.stringify(opened));
  await sleep(1200);

  const rows = await cdp.evaluate(`(() => {
    const vp = ${VP};
    const all = [...vp.querySelectorAll('details')].map((d) => ({
      summary: (d.querySelector('summary')?.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 140),
      open: d.open,
    }));
    return { all, text: (vp.innerText || '').slice(-1600) };
  })()`);
  console.log('rows after opening:', JSON.stringify(rows.all, null, 1));
  console.log('transcript tail:', JSON.stringify(rows.text.slice(-700)));
  save('03b-01-rows.json', rows);
  console.log('shot:', await shot(cdp, '03b-a-workgroup-open.png'));

  const toolRow = await cdp.evaluate(`(() => {
    const vp = ${VP};
    const d = [...vp.querySelectorAll('details')].find((x) =>
      /out\\.html/.test((x.querySelector('summary')?.innerText || '')));
    if (!d) return { found: false,
      candidates: [...vp.querySelectorAll('details')].map((x) => (x.querySelector('summary')?.innerText || '').trim().slice(0,80)) };
    const before = { open: d.open, summary: (d.querySelector('summary').innerText || '').trim().replace(/\\s+/g,' ') };
    d.querySelector('summary').click();
    return { found: true, before };
  })()`);
  console.log('tool row:', JSON.stringify(toolRow, null, 1));
  await sleep(1200);
  const expanded = await cdp.evaluate(`(() => {
    const vp = ${VP};
    const d = [...vp.querySelectorAll('details')].find((x) =>
      /out\\.html/.test((x.querySelector('summary')?.innerText || '')));
    if (!d) return null;
    const body = (d.innerText || '').trim().replace(/\\s+/g, ' ');
    return {
      open: d.open,
      bodyChars: body.length,
      bodyHead: body.slice(0, 500),
      // A diff preview paints added/removed lines; look for the markers the
      // renderer uses rather than guessing a class name.
      hasPlusLines: /\\+\\s*<|doctype|html/.test(d.innerText || ''),
      innerHtmlHasDiff: /diff|added|removed/i.test(d.innerHTML.slice(0, 4000)),
    };
  })()`);
  console.log('expanded tool row:', JSON.stringify(expanded, null, 1));
  save('03b-02-expanded.json', { toolRow, expanded });
  console.log('shot:', await shot(cdp, '03b-b-toolrow-expanded.png'));
} finally {
  cdp.close();
}
