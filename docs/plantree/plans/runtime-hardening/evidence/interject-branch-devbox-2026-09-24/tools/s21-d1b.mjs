/** D1 re-check — read the failure surface and every tool row right after the cut, before anything clears it. */
import fs from 'node:fs';
import {
  connect,
  EXPAND_ALL,
  gwLines,
  gwMark,
  newSession,
  save,
  sendText,
  shot,
  sleep,
  stamp,
  TRANSCRIPT_VP,
  waitGw,
  waitStatus,
} from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp() };
try {
  for (const f of ['/tmp/loopguard-sentinel.txt', '/tmp/loopguard-touched.txt'])
    if (fs.existsSync(f)) fs.unlinkSync(f);
  out.newSession = await newSession(cdp, evalAsync);
  const mark = gwMark();
  const s = await sendText(cdp, evalAsync, '⟦formB⟧ D1 复核：掐断后立刻读失败卡与工具行');
  out.sid = s.sid;
  const req = await waitGw(
    (l) => l.event === 'request' && /degenerate reply/.test(l.reply ?? ''),
    mark,
    30000
  );
  out.streamEnd = await waitGw(
    (l) => (l.event === 'client_abort' || l.event === 'response_complete') && l.seq === req.seq,
    mark,
    120000
  );
  out.idle = await waitStatus(evalAsync, s.sid, (st) => st.status === 'idle', 30000);
  await sleep(1500);
  out.store = await evalAsync(`
    const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
    const st = chat.useChatSessionsStore.getState();
    const x = st.sessions.find((v) => v.id === ${JSON.stringify(s.sid)});
    const msgs = st.messages[${JSON.stringify(s.sid)}] ?? [];
    const last = msgs.at(-1);
    return { runtimeError: x?.runtimeError ?? null, runtimeErrorCode: x?.runtimeErrorCode ?? null, status: x?.status,
      lastError: st.lastError ?? null,
      lastMsg: last ? { role: last.role, stopReason: last.stopReason ?? null, blockTypes: (last.blocks ?? []).map((b) => b.type),
        errorBlocks: (last.blocks ?? []).filter((b) => /error|notice/.test(b.type)).map((b) => ({ type: b.type, text: String(b.text ?? '').slice(0, 300), code: b.code ?? b.errorCode ?? null })) } : null };
  `);
  out.dom = await cdp.evaluate(`(() => {
    const t = document.body.innerText;
    const boxes = [...document.querySelectorAll('[role="alert"], [class*="destructive"]')].filter((n) => n.offsetParent !== null)
      .map((n) => ({ tag: n.tagName, cls: String(n.className).slice(0, 120), text: (n.innerText || '').trim().slice(0, 300) })).filter((b) => b.text).slice(0, 8);
    return { friendlyTitle: t.includes('模型输出出现重复调用'), friendlyReason: t.includes('本应用中断了这条回复'), rawEnglish: t.includes('The model wrote the same subagent tool call'), boxes };
  })()`);
  out.shot = await shot(cdp, '21-d1b-failure-surface.png');
  await cdp.evaluate(EXPAND_ALL);
  await sleep(800);
  out.rows = await cdp.evaluate(`(() => {
    const vp = ${TRANSCRIPT_VP};
    const sec = [...vp.querySelectorAll('section[data-turn-id]')].at(-1);
    const rows = [...sec.querySelectorAll('button, div')].filter((n) => n.offsetParent !== null)
      .filter((n) => n.querySelector(':scope > svg') && (n.innerText || '').trim().length > 0 && (n.innerText || '').length < 140);
    const uniq = [];
    for (const n of rows) { const t = (n.innerText || '').trim().replace(/\\s+/g, ' '); if (!uniq.some((u) => u.text === t && u.top === Math.round(n.getBoundingClientRect().top))) uniq.push({ text: t, top: Math.round(n.getBoundingClientRect().top), color: getComputedStyle(n).color, spin: !!n.querySelector('[class*="animate-spin"]') }); }
    return { count: uniq.length, spinners: sec.querySelectorAll('[class*="animate-spin"]').length, rows: uniq };
  })()`);
  out.sentinelExists = fs.existsSync('/tmp/loopguard-sentinel.txt');
  out.touchedExists = fs.existsSync('/tmp/loopguard-touched.txt');
  out.requestsAfter = gwLines(mark).lines.filter(
    (l) => l.event === 'request' && l.seq > req.seq
  ).length;
  console.log(
    JSON.stringify(
      {
        streamEnd: out.streamEnd,
        store: out.store,
        dom: out.dom,
        rowCount: out.rows?.count,
        spinners: out.rows?.spinners,
        firstRows: out.rows?.rows?.slice(0, 14),
        lastRows: out.rows?.rows?.slice(-5),
        sentinel: out.sentinelExists,
        touched: out.touchedExists,
        requestsAfter: out.requestsAfter,
      },
      null,
      1
    )
  );
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save('21-d1b.json', out);
  cdp.close();
}
