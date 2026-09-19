/**
 * T101 — the tool row must appear WHILE the arguments are still arriving.
 *
 * Sampling runs inside the page (a 250 ms `setInterval` that appends to an
 * array) rather than as a CDP poll loop: the claim is measured in hundreds of
 * milliseconds and a round trip over the debugger socket on this 2-core box is
 * itself worth tens of them.
 *
 * The anchor for "when did the arguments start" is the preamble text. The
 * gateway's slow-write plan emits 下面开始编写文件： and then opens the tool
 * block 500 ms later, so `firstToolRowAt - (preambleAt + 500 ms)` is the number
 * the criterion asks about, with no clock shared between two processes.
 */
import { CLICK_NEW, CLICK_SEND, connect, messagesOf, save, sessionStatus, shot, sleep, stamp, typeInto } from './lib.mjs';

const { cdp, evalAsync } = await connect();

const INSTALL_SAMPLER = `(() => {
  if (window.__pci_sampler) { clearInterval(window.__pci_sampler); }
  window.__pci_samples = [];
  // WIDEST visible scroller, not longest text: the sidebar holds 200+ rows and
  // would win a text-length contest every time (that is exactly how the first
  // run of this probe measured nothing while the turn ran correctly).
  const pick = () => {
    const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
      .filter((v) => v.offsetParent !== null);
    let best = null, bestWidth = -1;
    for (const v of vps) {
      const w = v.getBoundingClientRect().width;
      if (w > bestWidth) { bestWidth = w; best = v; }
    }
    return best;
  };
  window.__pci_sampler = setInterval(() => {
    const vp = pick();
    const text = vp ? (vp.innerText || '') : '';
    const lines = text.split('\\n').map((l) => l.trim()).filter(Boolean);
    const toolish = lines.filter((l) =>
      /已收到|编辑中|已编辑|out\\.html|写入|创建/.test(l) && l.length < 120);
    // The store side of the same moment: what the tool block's toolInput
    // actually carries while the arguments stream (T101 __streaming marker).
    let toolInput = null;
    try {
      const st = window.__pci_store.getState();
      const msgs = st.messages[st.activeSessionId] ?? [];
      for (let i = msgs.length - 1; i >= 0 && toolInput === null; i -= 1) {
        for (const b of msgs[i].blocks ?? []) {
          if (b.type === 'tool_call') toolInput = JSON.stringify(b.toolInput).slice(0, 160);
        }
      }
    } catch { /* store not prefetched */ }
    window.__pci_samples.push({
      t: Date.now(),
      preamble: text.includes('下面开始编写文件'),
      toolish,
      linesSoFar: (text.match(/已收到 (\\d+) 行/g) || []),
      details: vp ? vp.querySelectorAll('details').length : 0,
      toolInput,
    });
    if (window.__pci_samples.length > 600) clearInterval(window.__pci_sampler);
  }, 250);
  return 'sampler on';
})()`;

try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__pci_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );

  // Fresh session: the slow-write plan replies plain text once ANY tool_result
  // is in the history, so it must be asked on a conversation that has none.
  const created = await cdp.evaluate(CLICK_NEW);
  await sleep(2000);
  const sid = await evalAsync(
    `return window.__pci_store.getState().activeSessionId;`,
    { label: 'new session id' }
  );
  console.log(`[${stamp()}] new session ${sid} (clicked ${created.at})`);

  console.log('sampler:', await cdp.evaluate(INSTALL_SAMPLER));
  console.log('typed:', await cdp.evaluate(typeInto('T101：请写一个文件（点验用，流式参数）')));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 20_000, label: 'send enabled' }
  );
  const sentAt = Date.now();
  console.log(`[${stamp()}] send:`, JSON.stringify(await cdp.evaluate(CLICK_SEND)));

  // Let the whole 40 × 300 ms argument stream plus the execution play out.
  const shots = [];
  for (let i = 0; i < 12; i += 1) {
    await sleep(2000);
    const st = await evalAsync(sessionStatus(sid), { label: `poll ${i}` });
    console.log(`  [${st.t}] status=${st.status} msgs=${st.msgs}`);
    if (i === 2 || i === 5) shots.push(await shot(cdp, `03-${i}-streaming.png`));
    if (st.status === 'idle' && i > 6) break;
  }
  console.log('mid-stream shots:', JSON.stringify(shots));

  const samples = await cdp.evaluate(
    `(() => { clearInterval(window.__pci_sampler); return JSON.parse(JSON.stringify(window.__pci_samples)); })()`
  );
  save('03-01-samples.json', { sentAt, sid, samples });

  const firstPreamble = samples.find((s) => s.preamble);
  const firstTool = samples.find((s) => s.toolish.length > 0);
  const firstLines = samples.find((s) => s.linesSoFar.length > 0);
  const rel = (s) => (s ? `${s.t - sentAt}ms after send` : '(never)');
  console.log(`preamble first seen : ${rel(firstPreamble)}`);
  console.log(`tool row first seen : ${rel(firstTool)} -> ${JSON.stringify(firstTool?.toolish)}`);
  console.log(`"已收到 N 行" first  : ${rel(firstLines)} -> ${JSON.stringify(firstLines?.linesSoFar)}`);
  if (firstPreamble && firstTool) {
    // The gateway opens the tool block 500 ms after the preamble frame.
    console.log(
      `tool row latency after first input_json_delta ≈ ${firstTool.t - firstPreamble.t - 500}ms`
    );
  }

  // The climbing counter, one line per distinct value.
  const seen = [];
  for (const s of samples) {
    const label = s.linesSoFar.join(' ');
    if (label && label !== seen[seen.length - 1]?.label) seen.push({ dt: s.t - sentAt, label });
  }
  console.log('已收到 N 行 sequence:');
  for (const row of seen) console.log(`  +${row.dt}ms  ${row.label}`);
  save('03-02-lines-sequence.json', seen);

  const toolSeq = [];
  for (const s of samples) {
    const label = s.toolish.join(' | ');
    if (label && label !== toolSeq[toolSeq.length - 1]?.label) toolSeq.push({ dt: s.t - sentAt, label });
  }
  console.log('tool row text sequence:');
  for (const row of toolSeq) console.log(`  +${row.dt}ms  ${row.label}`);
  save('03-03-tool-row-sequence.json', toolSeq);

  const streamInputs = [];
  for (const s of samples) {
    if (s.toolInput && s.toolInput !== streamInputs[streamInputs.length - 1]?.toolInput) {
      streamInputs.push({ dt: s.t - sentAt, toolInput: s.toolInput });
    }
  }
  console.log('store toolInput sequence (first 8):');
  for (const row of streamInputs.slice(0, 8)) console.log(`  +${row.dt}ms  ${row.toolInput}`);
  save('03-05-toolinput-sequence.json', streamInputs);

  // After settling: is the row expandable, and does opening it show a preview?
  const settled = await cdp.evaluate(`(() => {
    const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
      .filter((v) => v.offsetParent !== null);
    let vp = null, w = -1;
    for (const v of vps) { const x = v.getBoundingClientRect().width; if (x > w) { w = x; vp = v; } }
    if (!vp) return { ok: false };
    const rows = [...vp.querySelectorAll('details')].map((d) => ({
      summary: (d.querySelector('summary')?.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
      open: d.open,
    }));
    const toolRow = [...vp.querySelectorAll('details')].find((d) =>
      /out\\.html/.test((d.querySelector('summary')?.innerText || '')));
    let afterOpen = null;
    if (toolRow) {
      toolRow.querySelector('summary').click();
      afterOpen = { open: toolRow.open, text: (toolRow.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 700) };
    }
    return { ok: true, rows, foundToolDetails: !!toolRow, afterOpen,
             transcriptTail: (vp.innerText || '').slice(-900) };
  })()`);
  console.log('settled row state:', JSON.stringify(settled, null, 1).slice(0, 2500));
  save('03-06-settled-row.json', settled);
  await sleep(800);
  console.log('shot (expanded):', await shot(cdp, '03-y-expanded.png'));

  save('03-04-messages.json', await evalAsync(messagesOf(sid), { label: 'msgs' }));
  console.log('shot:', await shot(cdp, '03-z-settled.png'));
  console.log('gateway:', JSON.stringify(await fetch('http://127.0.0.1:18099/health').then((r) => r.json())));
  console.log('SID', sid);
} finally {
  cdp.close();
}
