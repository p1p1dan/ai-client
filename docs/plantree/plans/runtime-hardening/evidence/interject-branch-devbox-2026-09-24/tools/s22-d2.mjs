/** D2 — form A: after the report is delivered the parent answers twice with nothing but the idle triple. */
import {
  connect,
  driveTurn,
  EXPAND_ALL,
  gwLines,
  gwMark,
  lanesOf,
  messagesOf,
  newSession,
  save,
  sendText,
  sessionState,
  shot,
  sleep,
  stamp,
  TURNS,
} from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp() };
try {
  out.newSession = await newSession(cdp, evalAsync);
  const mark = gwMark();
  const s = await sendText(cdp, evalAsync, '⟦formA⟧ D2 形态A：子代理交付后连续两条空转回复');
  out.sid = s.sid;
  out.drive = await driveTurn(evalAsync, s.sid, { timeoutMs: 180000, busyGraceMs: 10000 });
  await sleep(8000);
  const gw = gwLines(mark).lines;
  out.requests = gw
    .filter((l) => l.event === 'request')
    .map((l) => ({
      t: l.t,
      seq: l.seq,
      route: l.route,
      reply: l.reply,
      hasTools: l.hasTools,
      toolCount: l.toolCount,
      lastRole: l.lastRole,
      lastText: l.lastText,
      lastToolResults: l.lastToolResults,
      digest: l.digest,
    }));
  out.statusAfter = await evalAsync(sessionState(s.sid));
  out.store = await evalAsync(`
    const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
    const x = chat.useChatSessionsStore.getState().sessions.find((v) => v.id === ${JSON.stringify(s.sid)});
    return { stopCause: x?.stopCause ?? null, runtimeError: x?.runtimeError ?? null, runtimeErrorCode: x?.runtimeErrorCode ?? null };
  `);
  out.lanes = await evalAsync(lanesOf(s.sid));
  out.domCeiling = await cdp.evaluate(
    `(() => { const t = document.body.innerText; return { ceiling: /轮次上限|已暂停|turn limit|ceiling/i.test(t), lines: t.split('\\n').filter((l) => /上限|暂停|继续/.test(l)).slice(0, 6) }; })()`
  );
  out.shot = await shot(cdp, '22-d2-end.png');
  await cdp.evaluate(EXPAND_ALL);
  await sleep(800);
  out.turns = await cdp.evaluate(TURNS);
  out.shotExpanded = await shot(cdp, '22-d2-end-expanded.png');
  out.messages = await evalAsync(messagesOf(s.sid));
  console.log(
    JSON.stringify(
      {
        drive: out.drive,
        requests: out.requests.map((r) => ({
          t: r.t,
          seq: r.seq,
          route: r.route,
          reply: r.reply,
          hasTools: r.hasTools,
          lastRole: r.lastRole,
          lastText: (r.lastText ?? '').slice(0, 220),
          results: (r.lastToolResults ?? []).map(
            (x) => (x.isError ? 'ERR ' : '') + x.text.slice(0, 260)
          ),
        })),
        store: out.store,
        domCeiling: out.domCeiling,
        lanes: out.lanes,
      },
      null,
      1
    )
  );
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save('22-d2.json', out);
  cdp.close();
}
