/** Step 2 — smoke: one echo turn through textarea + Enter; the gateway must see it. */
import {
  activeSid,
  connect,
  driveTurn,
  gwLines,
  gwMark,
  messagesOf,
  pressEnter,
  save,
  shot,
  sleep,
  typeInto,
} from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
try {
  const sid = await evalAsync(activeSid);
  const mark = gwMark();
  console.log('typed', JSON.stringify(await cdp.evaluate(typeInto('⟦echo⟧ 冒烟：假网关通不通'))));
  await sleep(300);
  console.log('enter at', await pressEnter(cdp));
  const drive = await driveTurn(evalAsync, sid, { timeoutMs: 90_000 });
  console.log('drive', JSON.stringify(drive));
  const gw = gwLines(mark).lines;
  console.log(
    'gateway lines',
    gw.length,
    gw
      .map(
        (l) =>
          `${l.event} ${l.seq} ${l.route ?? ''} ${l.plan ?? ''} ${l.reply ?? l.label ?? ''} tools=${l.toolCount ?? ''}`
      )
      .join('\n')
  );
  const msgs = await evalAsync(messagesOf(sid));
  console.log(JSON.stringify(msgs.slice(-2)));
  save('02-smoke.json', { sid, drive, gw, msgs });
  console.log(await shot(cdp, '02-smoke.png'));
} finally {
  cdp.close();
}
