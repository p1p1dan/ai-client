/** A6 — Ctrl+Enter on the built-in `/compact` while a turn runs: runs locally, never reaches the model as text, never interjects. */
import {
  COMPOSER,
  connect,
  driveTurn,
  gwLines,
  gwMark,
  messagesOf,
  newSession,
  pressEnter,
  QUEUE_ROWS,
  save,
  sendText,
  shot,
  sleep,
  stamp,
  TURNS,
  typeInto,
  waitGw,
} from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp() };
const slashPopup = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const opts = [...document.querySelectorAll('[role="listbox"] [role="option"], [role="option"]')].filter(vis).map((n) => (n.innerText || '').trim().replace(/\\s+/g, ' ')).slice(0, 8);
  return { options: opts, value: document.querySelector('textarea')?.value ?? null };
})()`;
try {
  out.newSession = await newSession(cdp, evalAsync);
  const mark = gwMark();
  const first = await sendText(cdp, evalAsync, '⟦long⟧ A6 运行中 Ctrl+Enter 发 /compact');
  const sid = first.sid;
  out.sid = sid;
  out.step1 = await waitGw(
    (l) => l.event === 'response_complete' && /long step1/.test(l.label),
    mark,
    60000
  );
  await sleep(1500);
  out.typed = await cdp.evaluate(typeInto('/compact'));
  await sleep(600);
  out.popupAfterTyping = await cdp.evaluate(slashPopup);
  out.shotPopup = await shot(cdp, '13-a6-slash-popup.png');
  out.ctrlEnter1 = await pressEnter(cdp, { ctrl: true });
  await sleep(700);
  out.afterCtrlEnter1 = {
    popup: await cdp.evaluate(slashPopup),
    composer: await cdp.evaluate(COMPOSER),
    queue: await cdp.evaluate(QUEUE_ROWS),
  };
  if ((out.afterCtrlEnter1.composer.value ?? '').trim().startsWith('/compact')) {
    out.ctrlEnter2 = await pressEnter(cdp, { ctrl: true });
    await sleep(1200);
    out.afterCtrlEnter2 = {
      popup: await cdp.evaluate(slashPopup),
      composer: await cdp.evaluate(COMPOSER),
      queue: await cdp.evaluate(QUEUE_ROWS),
    };
  }
  out.shotAfter = await shot(cdp, '13-a6-after-ctrl-enter.png');
  out.settle = await driveTurn(evalAsync, sid, { timeoutMs: 120000, busyGraceMs: 3000 });
  await sleep(4000);
  const gw = gwLines(mark).lines;
  out.gateway = gw
    .filter((l) => l.event === 'request')
    .map((l) => ({
      t: l.t,
      seq: l.seq,
      route: l.route,
      reply: l.reply,
      hasTools: l.hasTools,
      lastText: l.lastText,
      slashCompactInUserText: l.userTextHas?.slashCompact,
      systemHead: l.systemHead,
    }));
  out.aborts = gw.filter((l) => l.event === 'client_abort');
  out.messages = await evalAsync(messagesOf(sid));
  out.turns = await cdp.evaluate(TURNS);
  out.shotEnd = await shot(cdp, '13-a6-end.png');
  console.log(
    JSON.stringify(
      {
        ...out,
        messages: out.messages.map(
          (m) =>
            `${m.role} ${m.stopCause ?? ''} ${m.blocks
              .map((b) => `${b.type}:${b.text ?? b.toolName ?? ''}`)
              .join(' | ')
              .slice(0, 200)}`
        ),
      },
      null,
      1
    )
  );
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save('13-a6.json', out);
  cdp.close();
}
