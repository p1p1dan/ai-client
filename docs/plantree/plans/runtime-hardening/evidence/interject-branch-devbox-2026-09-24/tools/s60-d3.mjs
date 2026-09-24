/** D3 — kill switch AICLIENT_RUNTIME_LOOP_GUARD=0: a short form-B reply (12 triples) must NOT be cut. */
import fs from 'node:fs';
import {
  connect,
  driveTurn,
  ENTER_MAIN_SURFACE,
  EXPAND_ALL,
  gwLines,
  gwMark,
  messagesOf,
  newSession,
  STATE_ROOT,
  save,
  sendText,
  shot,
  sleep,
  stamp,
  waitGw,
} from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp() };
try {
  // Prove the worker actually sees the variable: the dev log prints every dev.env key it forwards only for credentials,
  // so read it off the utility process environment instead.
  out.entry = await cdp.evaluate(ENTER_MAIN_SURFACE).catch((e) => `ERR ${e.message}`);
  await cdp.waitFor(`document.querySelector('textarea') !== null`, { timeoutMs: 180000 });
  await sleep(2500);
  for (let i = 0; i < 6; i += 1) {
    const n = await cdp.evaluate(`document.querySelectorAll('[role="dialog"]').length`);
    if (!n) break;
    await cdp.evaluate(
      `(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => ['知道了','以后再说','关闭'].includes((x.innerText||'').trim())); if (b) b.click(); return !!b; })()`
    );
    await sleep(800);
  }
  out.newSession = await newSession(cdp, evalAsync);
  const mark = gwMark();
  const s = await sendText(
    cdp,
    evalAsync,
    '⟦formBshort⟧ D3 关闭开关：短形态B（12 组三件套）应完整流完、不被掐断'
  );
  out.sid = s.sid;
  const req = await waitGw(
    (l) => l.event === 'request' && /formBshort: degenerate/.test(l.reply ?? ''),
    mark,
    30000
  );
  out.degenerateRequest = req && { t: req.t, seq: req.seq, reply: req.reply };
  out.streamEnd = await waitGw(
    (l) => (l.event === 'client_abort' || l.event === 'response_complete') && l.seq === req.seq,
    mark,
    120000
  );
  out.drive = await driveTurn(evalAsync, s.sid, { timeoutMs: 180000, busyGraceMs: 3000 });
  await sleep(3000);
  out.requests = gwLines(mark)
    .lines.filter((l) => l.event === 'request')
    .map((l) => ({
      t: l.t,
      seq: l.seq,
      route: l.route,
      reply: l.reply,
      lastToolResultsCount: (l.lastToolResults ?? []).length,
      refused: (l.lastToolResults ?? []).filter((r) => /^Refused/.test(r.text)).length,
    }));
  out.aborts = gwLines(mark).lines.filter((l) => l.event === 'client_abort');
  out.files = {
    sentinel: fs.existsSync('/tmp/loopguard-d3-sentinel.txt'),
    touched: fs.existsSync('/tmp/loopguard-d3-touched.txt'),
  };
  out.store = await evalAsync(
    `const chat = await import('/stores/chatSessions.ts'); const x = chat.useChatSessionsStore.getState().sessions.find((v) => v.id === ${JSON.stringify(s.sid)}); return { status: x?.status, runtimeError: x?.runtimeError ?? null, runtimeErrorCode: x?.runtimeErrorCode ?? null };`
  );
  const file = `${STATE_ROOT}/pi-agent/sessions/${s.sid}.jsonl`;
  out.loopGuardEntries = fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.includes('aiclient.loopGuard')).length
    : null;
  out.shot = await shot(cdp, '60-d3-guard-off.png');
  await cdp.evaluate(EXPAND_ALL);
  await sleep(700);
  out.shotExpanded = await shot(cdp, '60-d3-guard-off-expanded.png');
  const msgs = await evalAsync(messagesOf(s.sid));
  out.lastText = msgs
    .filter((m) => m.role === 'assistant')
    .at(-1)
    ?.blocks.filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  console.log(
    JSON.stringify(
      {
        degenerateRequest: out.degenerateRequest,
        streamEnd: out.streamEnd,
        requests: out.requests,
        aborts: out.aborts,
        files: out.files,
        store: out.store,
        loopGuardEntries: out.loopGuardEntries,
        lastText: out.lastText,
      },
      null,
      1
    )
  );
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save('60-d3.json', out);
  cdp.close();
}
