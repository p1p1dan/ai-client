/**
 * A8 (Stop / normal / tool-ended turns) + C1 (running bash row clock).
 * Each scenario in its own fresh conversation so every turn's default fold is read untouched.
 */
import fs from 'node:fs';
import {
  clickLabel,
  connect,
  driveTurn,
  gwLines,
  gwMark,
  messagesOf,
  newSession,
  save,
  sendText,
  shot,
  sleep,
  stamp,
  TURNS,
  toggleTurnGroup,
  toolRowText,
  typeInto,
  waitGw,
  waitStatus,
} from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp() };
const only = new Set((process.env.PARTS ?? 'stop,normal,toolend').split(','));
try {
  await cdp.evaluate(typeInto(''));
  if (only.has('stop')) {
    const r = { newSession: await newSession(cdp, evalAsync) };
    const mark = gwMark();
    const s = await sendText(cdp, evalAsync, '⟦long⟧ A8-stop：sleep 中途点 Stop');
    r.sid = s.sid;
    r.step1 = await waitGw(
      (l) => l.event === 'response_complete' && /long step1/.test(l.label),
      mark,
      60000
    );
    const markerBefore = fs.readdirSync('/tmp/ij/markers');
    await sleep(4000);
    r.stopClick = await cdp.evaluate(clickLabel('停止当前回合'));
    r.idle = await waitStatus(evalAsync, r.sid, (st) => st.status === 'idle', 30000);
    await sleep(2500);
    r.gateway = gwLines(mark)
      .lines.filter((l) => l.event === 'request')
      .map((l) => `${l.t} ${l.seq} ${l.reply}`);
    r.markerWritten = fs.readdirSync('/tmp/ij/markers').filter((f) => !markerBefore.includes(f));
    r.messages = await evalAsync(messagesOf(r.sid));
    r.turnsDefault = await cdp.evaluate(TURNS);
    r.shotDefault = await shot(cdp, '14-a8-stop-default.png');
    r.toggle = await cdp.evaluate(toggleTurnGroup('A8-stop'));
    await sleep(700);
    r.turnsAfterClick = await cdp.evaluate(TURNS);
    r.shotAfterClick = await shot(cdp, '14-a8-stop-after-click.png');
    out.stop = r;
    console.log(
      'stop:',
      JSON.stringify({
        step1: r.step1?.t,
        stopClick: r.stopClick,
        idle: r.idle?.t,
        gateway: r.gateway,
        markerWritten: r.markerWritten,
        def: r.turnsDefault.map((t) => t.details),
        after: r.turnsAfterClick.map((t) => t.details),
        lastStop: r.messages
          .filter((m) => m.role === 'assistant')
          .map((m) => [m.stopCause, m.stopReason]),
      })
    );
    // A later check wants the bash to have actually ended when Stop landed.
    await sleep(20000);
    r.markerWrittenLater = fs
      .readdirSync('/tmp/ij/markers')
      .filter((f) => !markerBefore.includes(f));
  }
  if (only.has('normal')) {
    const r = { newSession: await newSession(cdp, evalAsync) };
    const mark = gwMark();
    const s = await sendText(cdp, evalAsync, '⟦long⟧ A8-normal / C1：计时行采样，正常跑完');
    r.sid = s.sid;
    r.step1 = await waitGw(
      (l) => l.event === 'response_complete' && /long step1/.test(l.label),
      mark,
      60000
    );
    const tStart = Date.parse(r.step1.t);
    const samples = [];
    for (let i = 0; i < 36; i += 1) {
      const wall = Date.now();
      const text = await cdp.evaluate(toolRowText('sleep 20'));
      samples.push({ wallIso: new Date(wall).toISOString(), sinceStep1Ms: wall - tStart, text });
      if (i === 8) r.c1Shot = await shot(cdp, '14-c1-running-clock.png');
      const spent = Date.now() - wall;
      await sleep(Math.max(0, 500 - spent));
    }
    r.c1Samples = samples;
    r.settle = await driveTurn(evalAsync, r.sid, { timeoutMs: 90000, busyGraceMs: 3000 });
    await sleep(2500);
    r.messages = await evalAsync(messagesOf(r.sid));
    r.turnsDefault = await cdp.evaluate(TURNS);
    r.shotDefault = await shot(cdp, '14-a8-normal-default.png');
    out.normal = r;
    console.log(
      'normal:',
      JSON.stringify(
        {
          def: r.turnsDefault.map((t) => t.details),
          samples: samples.map((x) => `${x.sinceStepMs ?? x.sinceStep1Ms} ${x.text}`),
        },
        null,
        1
      )
    );
  }
  if (only.has('toolend')) {
    const r = { newSession: await newSession(cdp, evalAsync) };
    const mark = gwMark();
    const s = await sendText(cdp, evalAsync, '⟦toolend⟧ A8-toolend：两次工具后空回复结束');
    r.sid = s.sid;
    r.settle = await driveTurn(evalAsync, r.sid, { timeoutMs: 60000, busyGraceMs: 8000 });
    await sleep(2500);
    r.gateway = gwLines(mark)
      .lines.filter((l) => l.event === 'request')
      .map((l) => `${l.t} ${l.seq} ${l.reply}`);
    r.messages = await evalAsync(messagesOf(r.sid));
    r.turnsDefault = await cdp.evaluate(TURNS);
    r.shotDefault = await shot(cdp, '14-a8-toolend-default.png');
    out.toolend = r;
    console.log(
      'toolend:',
      JSON.stringify(
        {
          gateway: r.gateway,
          def: r.turnsDefault.map((t) => [t.head, t.details]),
          msgs: r.messages.map((m) => [m.role, m.stopCause, m.stopReason, m.blocks.length]),
        },
        null,
        1
      )
    );
  }
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save(`14-a8-c1${process.env.PARTS ? `-${process.env.PARTS.replace(/,/g, '-')}` : ''}.json`, out);
  cdp.close();
}
