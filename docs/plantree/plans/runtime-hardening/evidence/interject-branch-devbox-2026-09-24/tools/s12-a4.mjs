/** A4 — two plain-Enter queue entries, then a Ctrl+Enter: the interjection must go first. */
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
  TURNS,
  waitGw,
} from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp() };
try {
  out.newSession = await newSession(cdp, evalAsync);
  const mark = gwMark();
  const first = await sendText(cdp, evalAsync, '⟦long⟧ A4 优先级：长回合里先排两条再插话');
  const sid = first.sid;
  out.sid = sid;
  out.step1 = await waitGw(
    (l) => l.event === 'response_complete' && /long step1/.test(l.label),
    mark,
    60000
  );
  await sleep(1500);
  out.q1 = await sendText(cdp, evalAsync, '⟦echo⟧ 排队-1（普通 Enter）');
  await sleep(500);
  out.q2 = await sendText(cdp, evalAsync, '⟦echo⟧ 排队-2（普通 Enter）');
  await sleep(500);
  out.queueBeforeInterject = await cdp.evaluate(QUEUE_ROWS);
  out.ij = await sendText(cdp, evalAsync, '⟦echo⟧ 插话-A4（Ctrl+Enter）', { ctrl: true });
  await sleep(400);
  out.queueAfterInterject = await cdp.evaluate(QUEUE_ROWS);
  out.composer = await cdp.evaluate(COMPOSER);
  out.shot = await shot(cdp, '12-a4-queue-order.png');
  const _last = await waitGw((l) => l.event === 'response_complete' && false, mark, 1); // no-op
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const reqs = gwLines(mark).lines.filter((l) => l.event === 'request');
    if (reqs.some((r) => /排队-2/.test(r.lastText ?? ''))) break;
    await sleep(500);
  }
  await sleep(3000);
  const gw = gwLines(mark).lines;
  out.requestOrder = gw
    .filter((l) => l.event === 'request')
    .map((l) => ({ t: l.t, seq: l.seq, reply: l.reply, lastText: l.lastText }));
  out.step2Requested = gw.some((l) => /long step2/.test(l.reply ?? ''));
  out.userMessageOrder = (await evalAsync(messagesOf(sid)))
    .filter((m) => m.role === 'user')
    .map((m) => m.blocks.map((b) => b.text).join(''));
  out.turns = await cdp.evaluate(TURNS);
  out.shotAfter = await shot(cdp, '12-a4-after.png');
  console.log(JSON.stringify(out, null, 1));
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save('12-a4.json', out);
  cdp.close();
}
