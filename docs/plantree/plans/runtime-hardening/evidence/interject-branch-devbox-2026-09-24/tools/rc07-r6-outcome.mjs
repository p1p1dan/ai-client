/**
 * R6 (T128 re-check of N5) — calls that never did their work say so.
 *   MODE=live    two fresh conversations: ⟦formA⟧ (refused idle calls → 「· 已拒绝」)
 *                and ⟦formB⟧ (loop-guard cut → 「· 未执行」); rows read live, one row
 *                of each kind expanded; formB's session file inspected.
 *   MODE=reopen  after a restart: reopen both from the sidebar and read the same rows.
 * Case ids go through /tmp/ij/r6-cases.json.
 */
import fs from 'node:fs';
import {
  connect,
  driveTurn,
  gwMark,
  newSession,
  STATE_ROOT,
  save,
  sendText,
  shot,
  sleep,
  stamp,
  TRANSCRIPT_VP,
  waitGw,
  waitStatus,
} from './ij-lib.mjs';
import { openFromSidebar } from './rc-lib.mjs';

const MODE = process.env.MODE ?? 'live';
const CASES_FILE = '/tmp/ij/r6-cases.json';
const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp(), mode: MODE };

const EXPAND_SECTION = (needle) => `(() => {
  const vp = ${TRANSCRIPT_VP};
  const sec = [...vp.querySelectorAll('section[data-turn-id]')].find((s) => (s.textContent || '').includes(${JSON.stringify(needle)}));
  if (!sec) return null;
  let n = 0;
  for (const d of sec.querySelectorAll('details')) if (!d.open) { d.querySelector(':scope > summary')?.click(); n += 1; }
  return n;
})()`;

/** Every tool row of the turn: verb, outcome word, colours; histogram by row text shape. */
const ROWS = (needle) => `(() => {
  const vp = ${TRANSCRIPT_VP};
  const sec = [...vp.querySelectorAll('section[data-turn-id]')].find((s) => (s.textContent || '').includes(${JSON.stringify(needle)}));
  if (!sec) return null;
  const norm = (s) => (s || '').trim().replace(/\\s+/g, ' ');
  const rows = [...sec.querySelectorAll('[class*="group/row"]')].filter((n) => n.offsetParent !== null);
  const data = rows.map((r) => {
    const spans = [...r.querySelectorAll(':scope > span')];
    const outcome = r.querySelector('[data-slot="tool-row-outcome"]');
    return { text: norm(r.textContent).slice(0, 120), verb: norm(spans[0]?.textContent), outcome: outcome ? norm(outcome.textContent) : null,
      rowColor: getComputedStyle(r).color, outcomeColor: outcome ? getComputedStyle(outcome).color : null,
      destructive: /text-destructive/.test(String(r.className)), expandable: r.tagName === 'BUTTON' || r.getAttribute('role') === 'button' };
  });
  const hist = {};
  for (const d of data) { const k = d.verb + (d.outcome ? ' ' + d.outcome : '') + (d.destructive ? ' [RED]' : ''); hist[k] = (hist[k] ?? 0) + 1; }
  const colors = {};
  for (const d of data) { const k = (d.outcome ?? 'no-outcome') + ' ' + d.rowColor; colors[k] = (colors[k] ?? 0) + 1; }
  return { rows: data.length, hist, colors, spinners: sec.querySelectorAll('[class*="animate-spin"]').length,
    destructiveRows: data.filter((d) => d.destructive).length, first: data.slice(0, 5), withOutcome: data.filter((d) => d.outcome).slice(0, 4) };
})()`;

/** Open the first row with the given outcome word and return what its panel shows. */
const OPEN_ROW = (needle, word, verb = '') => `(async () => {
  const vp = ${TRANSCRIPT_VP};
  const sec = [...vp.querySelectorAll('section[data-turn-id]')].find((s) => (s.textContent || '').includes(${JSON.stringify(needle)}));
  // Only a row that can expand (a Collapsible trigger carries aria-expanded); a Read/Glob row that never ran has nothing to open.
  const o = sec && [...sec.querySelectorAll('[data-slot="tool-row-outcome"]')].find((n) => (n.textContent || '').includes(${JSON.stringify(word)}) && n.offsetParent !== null
    && n.closest('[class*="group/row"]')?.hasAttribute('aria-expanded') && (n.closest('[class*="group/row"]')?.textContent || '').includes(${JSON.stringify(verb)}));
  if (!o) return { ok: false, why: 'no row' };
  const trig = o.closest('[class*="group/row"]');
  trig.scrollIntoView({ block: 'center' });
  trig.click();
  await new Promise((r) => setTimeout(r, 600));
  const panelId = trig.getAttribute('aria-controls');
  const panel = panelId ? document.getElementById(panelId) : trig.nextElementSibling;
  return { ok: true, row: (trig.textContent || '').trim().replace(/\\s+/g, ' '), expanded: trig.getAttribute('aria-expanded'),
    panel: panel ? (panel.innerText || panel.textContent || '').trim().slice(0, 500) : null,
    englishNotStarted: panel ? /The run ended before this call started/.test(panel.textContent || '') : null };
})()`;

async function readTurn(needle, tag) {
  const r = {};
  r.expanded = await cdp.evaluate(EXPAND_SECTION(needle));
  await sleep(900);
  r.rows = await cdp.evaluate(ROWS(needle));
  r.shotRows = await shot(cdp, `r6-${tag}-rows.png`);
  const word = /formB/.test(needle) || /R6-B/.test(needle) ? '未执行' : '已拒绝';
  r.open = await evalAsync(`return await ${OPEN_ROW(needle, word)};`);
  await sleep(500);
  r.shotOpen = await shot(cdp, `r6-${tag}-row-open.png`);
  if (word === '未执行') {
    // Two more never-run rows of other kinds: a bash command, and the write whose
    // content must show as a preview (`TaskList {}` has no arguments, so it does not expand).
    r.open2 = await evalAsync(`return await ${OPEN_ROW(needle, word, '运行')};`);
    await sleep(500);
    r.shotOpen2 = await shot(cdp, `r6-${tag}-row-open-2.png`);
    r.open3 = await evalAsync(`return await ${OPEN_ROW(needle, word, '编辑')};`);
    await sleep(500);
    r.shotOpen3 = await shot(cdp, `r6-${tag}-row-open-3.png`);
  }
  return r;
}

function sessionFileFacts(sid) {
  const file = `${STATE_ROOT}/pi-agent/sessions/${sid}.jsonl`;
  if (!fs.existsSync(file)) return { file, exists: false };
  const entries = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return {
    file: file.replace(STATE_ROOT, '<stateRoot>'),
    exists: true,
    entries: entries.map((e) => {
      const m = e.message;
      if (e.type === 'message' && m) {
        const content = Array.isArray(m.content) ? m.content : [];
        return {
          type: e.type,
          role: m.role,
          stopReason: m.stopReason ?? null,
          toolCalls: content.filter((c) => c.type === 'toolCall').length,
          toolName: m.toolName ?? undefined,
          isError: m.isError ?? undefined,
          refused: m.details?.refused ?? undefined,
          text: content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('')
            .slice(0, 60),
        };
      }
      return {
        type: e.type,
        customType: e.customType,
        data: e.customType === 'aiclient.loopGuard' ? e.data : undefined,
      };
    }),
  };
}

try {
  if (MODE === 'live') {
    // ---- formA ----
    out.a = { newSession: await newSession(cdp, evalAsync) };
    const sA = await sendText(cdp, evalAsync, '⟦formA⟧ R6-A 形态A：被拒的空转调用');
    out.a.sid = sA.sid;
    out.a.drive = await driveTurn(evalAsync, sA.sid, { timeoutMs: 240000, busyGraceMs: 10000 });
    await sleep(6000);
    out.a.live = await readTurn('R6-A 形态A', 'a-live');
    out.a.file = sessionFileFacts(sA.sid);
    console.log(
      'formA live',
      JSON.stringify(
        { drive: out.a.drive.ok, rows: out.a.live.rows, open: out.a.live.open },
        null,
        1
      )
    );
    // ---- formB ----
    for (const f of ['/tmp/loopguard-sentinel.txt', '/tmp/loopguard-touched.txt'])
      if (fs.existsSync(f)) fs.unlinkSync(f);
    out.b = { newSession: await newSession(cdp, evalAsync) };
    const mark = gwMark();
    const sB = await sendText(cdp, evalAsync, '⟦formB⟧ R6-B 形态B：未执行的调用');
    out.b.sid = sB.sid;
    const req = await waitGw(
      (l) => l.event === 'request' && /formB: degenerate reply/.test(l.reply ?? ''),
      mark,
      30000
    );
    out.b.streamEnd = await waitGw(
      (l) => (l.event === 'client_abort' || l.event === 'response_complete') && l.seq === req.seq,
      mark,
      120000
    );
    out.b.settled = await waitStatus(
      evalAsync,
      sB.sid,
      (st) => st.status !== 'running' && st.status !== 'starting' && st.status !== 'stopping',
      30000
    );
    await sleep(2000);
    out.b.live = await readTurn('R6-B 形态B', 'b-live');
    out.b.file = sessionFileFacts(sB.sid);
    console.log(
      'formB live',
      JSON.stringify(
        {
          end: out.b.streamEnd?.event,
          status: out.b.settled?.status,
          rows: out.b.live.rows,
          open: out.b.live.open,
          file: out.b.file.entries,
        },
        null,
        1
      )
    );
    fs.writeFileSync(CASES_FILE, JSON.stringify({ a: out.a.sid, b: out.b.sid }, null, 2));
  } else if (MODE === 'live-b-open') {
    // Re-read the still-open live formB conversation after fixing OPEN_ROW (first live run opened a non-expandable row).
    out.b = { live: await readTurn('R6-B 形态B', 'b-live') };
    console.log(
      'formB live re-open',
      JSON.stringify(
        {
          rows: out.b.live.rows.hist,
          open: out.b.live.open,
          open2: out.b.live.open2,
          open3: out.b.live.open3,
        },
        null,
        1
      )
    );
  } else {
    const cases = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
    for (const [k, needle] of [
      ['a', 'R6-A 形态A'],
      ['b', 'R6-B 形态B'],
    ]) {
      const r = { sid: cases[k] };
      r.switch = await openFromSidebar(cdp, evalAsync, cases[k], sleep);
      for (let i = 0; i < 15; i += 1) {
        const ok = await cdp.evaluate(
          `!![...document.querySelectorAll('section[data-turn-id]')].find((s) => (s.textContent || '').includes(${JSON.stringify(needle)}))`
        );
        if (ok) break;
        await sleep(700);
      }
      await sleep(1200);
      r.reopen = await readTurn(needle, `${k}-reopen`);
      r.file = sessionFileFacts(cases[k]);
      out[k] = r;
      console.log(
        k,
        'reopen',
        JSON.stringify(
          {
            clicked: r.switch.clicked,
            rows: r.reopen.rows,
            open: r.reopen.open,
            open2: r.reopen.open2,
            open3: r.reopen.open3,
          },
          null,
          1
        )
      );
    }
  }
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save(`r6-outcome-${MODE}.json`, out);
  cdp.close();
}
