/** D1 — form B: one streamed reply degenerating into TaskList/TaskStop/TaskWait; must be cut mid-stream. */
import fs from 'node:fs';
import {
  connect,
  driveTurn,
  EXPAND_ALL,
  FAILURE_TEXT,
  gwLines,
  gwMark,
  messagesOf,
  newSession,
  save,
  sendText,
  sessionState,
  shot,
  sleep,
  stamp,
  TRANSCRIPT_VP,
  TURNS,
  waitGw,
  waitStatus,
} from './ij-lib.mjs';

const SENTINEL = '/tmp/loopguard-sentinel.txt';
const TOUCHED = '/tmp/loopguard-touched.txt';
const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp() };
const TOOL_ROWS = `(() => {
  const vp = ${TRANSCRIPT_VP};
  const secs = [...vp.querySelectorAll('section[data-turn-id]')];
  const sec = secs.find((s) => (s.innerText || '').includes('D1 形态B'));
  if (!sec) return null;
  const rows = [...sec.querySelectorAll('button, div')].filter((n) => n.offsetParent !== null && n.children.length > 0)
    .map((n) => (n.innerText || '').trim().replace(/\\s+/g, ' ')).filter((t) => t.length < 140);
  const verbs = rows.filter((t) => /^(终端|运行中|读取|读|搜索|查找|写入|编辑|列出|停止|等待|已委派|子 ?Agent|Task|未执行|未开始|已取消|已中断)/.test(t));
  return {
    text: (sec.innerText || '').slice(0, 3000),
    spinners: sec.querySelectorAll('[class*="animate-spin"]').length,
    candidateRows: [...new Set(verbs)].slice(0, 80),
  };
})()`;
try {
  for (const f of [SENTINEL, TOUCHED])
    if (fs.existsSync(f)) {
      out.preExisting = (out.preExisting ?? []).concat(f);
      fs.unlinkSync(f);
    }
  out.newSession = await newSession(cdp, evalAsync);
  const mark = gwMark();
  const s = await sendText(
    cdp,
    evalAsync,
    '⟦formB⟧ D1 形态B：一条回复里写 40 个杂调用再无限重复三件套'
  );
  const sid = s.sid;
  out.sid = sid;
  const req = await waitGw(
    (l) => l.event === 'request' && /degenerate reply/.test(l.reply ?? ''),
    mark,
    30000
  );
  out.degenerateRequest = req && { t: req.t, seq: req.seq, reply: req.reply };
  await sleep(4000);
  out.shotStreaming = await shot(cdp, '20-d1-streaming.png');
  const abort = await waitGw(
    (l) => (l.event === 'client_abort' || l.event === 'response_complete') && l.seq === req.seq,
    mark,
    120000
  );
  out.streamEnd = abort;
  out.idle = await waitStatus(
    evalAsync,
    sid,
    (st) => st.status !== 'running' && st.status !== 'starting',
    30000
  );
  await sleep(15000); // any auto-resume / wrap-up would show up as a new request by now
  out.requestsAfterDegenerate = gwLines(mark)
    .lines.filter((l) => l.event === 'request' && l.seq > req.seq)
    .map((l) => `${l.t} ${l.seq} ${l.route} ${l.reply}`);
  out.sentinelExists = fs.existsSync(SENTINEL);
  out.touchedExists = fs.existsSync(TOUCHED);
  out.statusAfter = await evalAsync(sessionState(sid));
  out.failure = await cdp.evaluate(FAILURE_TEXT);
  out.messages = await evalAsync(messagesOf(sid));
  out.shotSettled = await shot(cdp, '20-d1-settled.png');
  out.expanded = await cdp.evaluate(EXPAND_ALL);
  await sleep(800);
  out.rows = await cdp.evaluate(TOOL_ROWS);
  out.turns = await cdp.evaluate(TURNS);
  out.shotExpanded = await shot(cdp, '20-d1-settled-expanded.png');
  // Carry on: the next request must not carry the degenerate reply.
  const mark2 = gwMark();
  await sendText(cdp, evalAsync, '⟦echo⟧ D1 之后再发一条，看上下文');
  const next = await waitGw(
    (l) => l.event === 'request' && /D1 之后再发一条/.test(l.lastText ?? ''),
    mark2,
    30000
  );
  out.nextRequest = next && {
    t: next.t,
    seq: next.seq,
    digest: next.digest,
    historyToolUseCount: next.historyToolUseCount,
    historyTaskListCount: next.historyTaskListCount,
    messageCount: next.messageCount,
  };
  await driveTurn(evalAsync, sid, { timeoutMs: 30000, busyGraceMs: 4000 });
  await sleep(1500);
  out.messagesAfterNext = (await evalAsync(messagesOf(sid))).slice(-2);
  out.shotNext = await shot(cdp, '20-d1-next-message.png');
  const blockCounts = out.messages.map((m) => ({
    role: m.role,
    stopReason: m.stopReason,
    blocks: m.blocks.length,
    toolCalls: m.blocks.filter((b) => b.type === 'tool_call').length,
    toolResults: m.blocks.filter((b) => b.type === 'tool_result').length,
    types: [...new Set(m.blocks.map((b) => b.type))],
  }));
  console.log(
    JSON.stringify(
      {
        degenerateRequest: out.degenerateRequest,
        streamEnd: out.streamEnd,
        idle: out.idle?.t,
        requestsAfterDegenerate: out.requestsAfterDegenerate,
        sentinelExists: out.sentinelExists,
        touchedExists: out.touchedExists,
        failure: out.failure,
        blockCounts,
        rowsCount: out.rows?.candidateRows?.length,
        spinners: out.rows?.spinners,
        nextRequest: out.nextRequest,
        messagesAfterNext: out.messagesAfterNext,
      },
      null,
      1
    )
  );
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save('20-d1.json', out);
  cdp.close();
}
