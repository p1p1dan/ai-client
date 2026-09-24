/**
 * R2 (T128 re-check) — while a form-B turn streams, queue one plain Enter and
 * one Ctrl+Enter interjection; the loop guard then cuts the turn (session
 * `failed`). Both queued messages must still go out on their own. Records the
 * order and time each reaches the gateway, and whether the failure card
 * flashed in between.
 */
import fs from 'node:fs';
import {
  COMPOSER,
  connect,
  gwLines,
  gwMark,
  messagesOf,
  newSession,
  QUEUE_ROWS,
  save,
  sendText,
  shot,
  sleep,
  stamp,
  waitGw,
} from './ij-lib.mjs';
import { failureDom, failureStore } from './rc-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp() };
try {
  for (const f of ['/tmp/loopguard-sentinel.txt', '/tmp/loopguard-touched.txt'])
    if (fs.existsSync(f)) fs.unlinkSync(f);
  out.newSession = await newSession(cdp, evalAsync);
  const mark = gwMark();
  const s = await sendText(cdp, evalAsync, '⟦formB⟧ R2 运行中排队 + 插话，然后被掐断');
  const sid = s.sid;
  out.sid = sid;
  const req = await waitGw(
    (l) => l.event === 'request' && /formB: degenerate reply/.test(l.reply ?? ''),
    mark,
    30000
  );
  out.degenerateRequest = { t: req.t, seq: req.seq };
  await sleep(2500);
  out.queued = await sendText(cdp, evalAsync, '⟦echo⟧ R2-排队（普通 Enter）');
  await sleep(500);
  out.interject = await sendText(cdp, evalAsync, '⟦echo⟧ R2-插话（Ctrl+Enter）', { ctrl: true });
  await sleep(400);
  out.queueRows = await cdp.evaluate(QUEUE_ROWS);
  out.composer = await cdp.evaluate(COMPOSER);
  out.shotQueued = await shot(cdp, 'r2-queued-while-streaming.png');
  // Fast sampling from the cut until both queued prompts reached the gateway.
  const samples = [];
  const t0 = Date.now();
  let cutAt = null;
  let shotCard = null;
  while (Date.now() - t0 < 90000) {
    const st = await evalAsync(failureStore(sid));
    const dom = await cdp.evaluate(failureDom(st.title));
    const q = await cdp.evaluate(QUEUE_ROWS);
    const key = `${st.status}|${dom.cards.map((c) => c.title).join('/')}|${q.length}`;
    if (samples.at(-1)?.key !== key)
      samples.push({
        key,
        t: st.t,
        status: st.status,
        failureSettled: st.failureSettled,
        card: dom.cards.map((c) => c.title),
        queue: q.map((r) => r.text),
      });
    if (!shotCard && dom.cards.length) shotCard = await shot(cdp, 'r2-card-flash.png');
    const lines = gwLines(mark).lines;
    cutAt = cutAt ?? lines.find((l) => l.event === 'client_abort' && l.seq === req.seq)?.t ?? null;
    const reqs = lines.filter((l) => l.event === 'request' && l.seq > req.seq);
    if (
      reqs.some((r) => /R2-排队/.test(r.lastText ?? '')) &&
      reqs.some((r) => /R2-插话/.test(r.lastText ?? '')) &&
      st.status === 'idle'
    )
      break;
    await sleep(120);
  }
  out.samples = samples;
  out.shotCard = shotCard;
  await sleep(3000);
  const lines = gwLines(mark).lines;
  out.cutAt = cutAt;
  out.streamEnd =
    lines.find(
      (l) => (l.event === 'client_abort' || l.event === 'response_complete') && l.seq === req.seq
    ) ?? null;
  out.requests = lines
    .filter((l) => l.event === 'request')
    .map((l) => ({
      t: l.t,
      seq: l.seq,
      reply: l.reply,
      lastText: l.lastText,
      digest: l.digest,
      historyToolUseCount: l.historyToolUseCount,
    }));
  out.responses = lines
    .filter((l) => l.event === 'response_complete' || l.event === 'client_abort')
    .map((l) => ({ t: l.t, seq: l.seq, event: l.event, label: l.label }));
  out.userOrder = (await evalAsync(messagesOf(sid)))
    .filter((m) => m.role === 'user')
    .map((m) => m.blocks.map((b) => b.text ?? '').join(''));
  out.storeEnd = await evalAsync(failureStore(sid));
  out.shotEnd = await shot(cdp, 'r2-end.png');
  console.log(
    JSON.stringify(
      {
        degenerate: out.degenerateRequest,
        queuedAt: out.queued.at,
        interjectAt: out.interject.at,
        queueRows: out.queueRows,
        cutAt,
        streamEnd: out.streamEnd?.event,
        samples,
        requests: out.requests.map(
          (r) => `${r.t} #${r.seq} ${r.reply} | ${r.lastText} | hist tools=${r.historyToolUseCount}`
        ),
        responses: out.responses,
        userOrder: out.userOrder,
        storeEnd: out.storeEnd.status,
      },
      null,
      1
    )
  );
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save('r2-queue-after-failure.json', out);
  cdp.close();
}
