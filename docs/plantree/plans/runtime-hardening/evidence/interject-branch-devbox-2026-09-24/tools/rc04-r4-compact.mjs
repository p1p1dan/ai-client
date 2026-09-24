/**
 * R4 (T128 re-check of N1) — `/compact` while a turn runs, by Enter and by
 * Ctrl+Enter: a Chinese notice must say to wait, and `/compact ` must stay in
 * the box. After the turn ends one more Enter must really compact (the fake
 * gateway answers the tool-less summary request with `SUMMARY: …`).
 */
import fs from 'node:fs';
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
  STATE_ROOT,
  save,
  sendText,
  shot,
  sleep,
  stamp,
  typeInto,
  USER_DATA,
  waitGw,
} from './ij-lib.mjs';
import { TOASTS } from './rc-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp() };
const SLASH = `(() => {
  const vis = (n) => n.offsetParent !== null;
  return { options: [...document.querySelectorAll('[role="option"]')].filter(vis).map((n) => (n.innerText || '').trim().replace(/\\s+/g, ' ')).slice(0, 6),
    value: document.querySelector('textarea')?.value ?? null };
})()`;

/** Press (Ctrl+)Enter until the slash popup no longer eats the key; watch toasts right after each press. */
async function runSlash(ctrl, tag) {
  const r = { presses: [] };
  const cur = await cdp.evaluate(SLASH);
  if (!(cur.value ?? '').trim().startsWith('/compact')) {
    r.typed = await cdp.evaluate(typeInto('/compact'));
    await sleep(600);
  }
  for (let i = 0; i < 3; i += 1) {
    const before = await cdp.evaluate(SLASH);
    const at = await pressEnter(cdp, { ctrl });
    const toasts = [];
    for (let k = 0; k < 8; k += 1) {
      await sleep(150);
      // Only the compact notice counts: an unrelated toast (e.g. a capacity
      // hand-off 「有一个对话已转入后台」) must not end the loop early.
      const t = (await cdp.evaluate(TOASTS)).filter((x) => /压缩/.test(x.title));
      if (t.length) toasts.push({ t: stamp(), toasts: t });
      if (t.length && k >= 2) break;
    }
    const after = await cdp.evaluate(SLASH);
    r.presses.push({ at, before, after, toasts, queue: await cdp.evaluate(QUEUE_ROWS) });
    if (toasts.length) {
      r.shot = await shot(cdp, `r4-${tag}-toast.png`);
      break;
    }
  }
  r.composer = await cdp.evaluate(COMPOSER);
  return r;
}

try {
  out.newSession = await newSession(cdp, evalAsync);
  const mark = gwMark();
  const first = await sendText(cdp, evalAsync, '⟦long⟧ R4 运行中执行 /compact');
  const sid = first.sid;
  out.sid = sid;
  out.step1 = await waitGw(
    (l) => l.event === 'response_complete' && /long step1/.test(l.label),
    mark,
    60000
  );
  await sleep(1500);
  out.enter = await runSlash(false, 'enter');
  await sleep(2500);
  out.ctrlEnter = await runSlash(true, 'ctrl-enter');
  out.whileRunningRequests = gwLines(mark)
    .lines.filter((l) => l.event === 'request')
    .map((l) => ({
      t: l.t,
      seq: l.seq,
      reply: l.reply,
      hasTools: l.hasTools,
      slashCompactInUserText: l.userTextHas?.slashCompact,
      lastText: l.lastText,
    }));
  out.settle = await driveTurn(evalAsync, sid, { timeoutMs: 120000, busyGraceMs: 3000 });
  await sleep(2000);
  out.afterTurn = {
    composer: await cdp.evaluate(COMPOSER),
    messages: (await evalAsync(messagesOf(sid))).map(
      (m) => `${m.role} ${m.stopCause ?? ''} ${(m.text ?? '').slice(0, 60)}`
    ),
  };
  out.shotAfterTurn = await shot(cdp, 'r4-after-turn-box-kept.png');
  // One Enter after the turn ended: must really compact.
  const mark2 = gwMark();
  const sessFile = `${STATE_ROOT}/pi-agent/sessions/${sid}.jsonl`;
  const linesBefore = fs.existsSync(sessFile)
    ? fs.readFileSync(sessFile, 'utf8').split('\n').filter(Boolean).length
    : null;
  out.finalPress = { before: await cdp.evaluate(SLASH), at: await pressEnter(cdp) };
  const toasts = [];
  for (let k = 0; k < 20; k += 1) {
    await sleep(300);
    const t = await cdp.evaluate(TOASTS);
    if (t.length) toasts.push({ t: stamp(), toasts: t });
  }
  out.finalPress.toasts = toasts;
  out.finalPress.after = await cdp.evaluate(SLASH);
  if (
    (out.finalPress.after.value ?? '').trim().startsWith('/compact') &&
    !gwLines(mark2).lines.some((l) => l.event === 'request')
  ) {
    // The first Enter may only have closed the slash popup.
    out.finalPress2 = { at: await pressEnter(cdp) };
    await sleep(4000);
    out.finalPress2.after = await cdp.evaluate(SLASH);
    out.finalPress2.toasts = await cdp.evaluate(TOASTS);
  }
  await sleep(3000);
  out.compactRequests = gwLines(mark2).lines.map((l) => ({
    t: l.t,
    event: l.event,
    seq: l.seq,
    route: l.route,
    reply: l.reply ?? l.label,
    hasTools: l.hasTools,
    systemHead: l.systemHead,
    messageCount: l.messageCount,
    lastText: (l.lastText ?? '').slice(0, 200),
  }));
  const text = fs.existsSync(sessFile)
    ? fs.readFileSync(sessFile, 'utf8').split('\n').filter(Boolean)
    : [];
  out.sessionFile = {
    linesBefore,
    linesAfter: text.length,
    newEntries: text.slice(linesBefore ?? 0).map((l) => {
      try {
        const j = JSON.parse(l);
        return {
          type: j.type,
          customType: j.customType,
          summaryHead: typeof j.summary === 'string' ? j.summary.slice(0, 80) : undefined,
          tokensBefore: j.tokensBefore,
          timestamp: j.timestamp,
        };
      } catch {
        return l.slice(0, 80);
      }
    }),
  };
  out.afterCompact = {
    composer: await cdp.evaluate(COMPOSER),
    messages: (await evalAsync(messagesOf(sid))).map(
      (m) => `${m.role} ${(m.text ?? '').slice(0, 60)} ${m.blocks.map((b) => b.type).join(',')}`
    ),
  };
  out.timelineTail = await cdp.evaluate(
    `(() => (document.body.innerText || '').split('\\n').filter((l) => /压缩|摘要|compact|SUMMARY/i.test(l)).slice(0, 10))()`
  );
  out.shotAfterCompact = await shot(cdp, 'r4-after-compact.png');
  const today = new Date().toISOString().slice(0, 10);
  const logFile = `${USER_DATA}/logs/aiclient-${today}.log`;
  out.mainLog = fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .filter((l) => /compact/i.test(l))
        .slice(-12)
    : `missing ${logFile}`;
  console.log(
    JSON.stringify(
      {
        enter: out.enter,
        ctrlEnter: out.ctrlEnter,
        whileRunningRequests: out.whileRunningRequests,
        afterTurn: out.afterTurn,
        finalPress: out.finalPress,
        finalPress2: out.finalPress2,
        compactRequests: out.compactRequests,
        sessionFile: out.sessionFile,
        afterCompact: out.afterCompact,
        timelineTail: out.timelineTail,
        mainLog: out.mainLog,
      },
      null,
      1
    )
  );
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save('r4-compact.json', out);
  cdp.close();
}
