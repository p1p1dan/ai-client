/** A5 — Ctrl+Enter with no turn running must behave like a plain send. */
import {
  activeSid,
  COMPOSER,
  connect,
  gwMark,
  messagesOf,
  QUEUE_ROWS,
  save,
  sendText,
  sessionState,
  shot,
  sleep,
  waitGw,
} from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
try {
  const sid0 = await evalAsync(activeSid);
  const before = await evalAsync(sessionState(sid0));
  const mark = gwMark();
  const text = '⟦echo⟧ A5 空闲时按 Ctrl+Enter';
  const sent = await sendText(cdp, evalAsync, text, { ctrl: true });
  const t0 = Date.parse(sent.at);
  const composerRight = await cdp.evaluate(COMPOSER);
  const queue = await cdp.evaluate(QUEUE_ROWS);
  const req = await waitGw(
    (l) => l.event === 'request' && /A5 空闲时/.test(l.lastText ?? ''),
    mark,
    15000
  );
  await sleep(2500);
  const msgs = await evalAsync(messagesOf(sent.sid));
  const out = {
    before,
    sent,
    composerRightAfter: composerRight,
    queueRowsRightAfter: queue,
    gatewayRequest: req && {
      seq: req.seq,
      t: req.t,
      lastText: req.lastText,
      latencyMs: Date.parse(req.t) - t0,
    },
    lastTwo: msgs.slice(-2),
    composerLater: await cdp.evaluate(COMPOSER),
  };
  console.log(JSON.stringify(out, null, 1));
  save('10-a5.json', out);
  console.log(await shot(cdp, '10-a5-idle-ctrl-enter.png'));
} finally {
  cdp.close();
}
