/** A9 — after a restart, reopen each A8 conversation: the default fold must still follow the persisted end cause. */
import { switchTo } from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck/tools/pc-lib.mjs';
import {
  connect,
  messagesOf,
  save,
  shot,
  sleep,
  stamp,
  TURNS,
  toggleTurnGroup,
} from './ij-lib.mjs';

const CASES = [
  ['A2-interjected', 'session-1790254889907-bpcop4v', 'A2 长回合'],
  ['A4-interjected', 'session-1790254966174-4xupb8n', 'A4 优先级'],
  ['A7-interjected', 'session-1790255259304-itxchqv', 'A7 派慢子代理'],
  ['A8-stop', 'session-1790255141875-has4n58', 'A8-stop'],
  ['A8-normal', 'session-1790255173512-h20a3va', 'A8-normal'],
  ['A8-toolend', 'session-1790255201495-95u2tu7', 'A8-toolend'],
  ['A6-normal', 'session-1790255048446-z82ivrc', 'A6 运行中'],
];
const { cdp, evalAsync } = await connect();
const out = { at: stamp(), cases: [] };
try {
  for (const [tag, sid, needle] of CASES) {
    const sw = await switchTo(cdp, evalAsync, sid);
    let turns = [];
    for (let i = 0; i < 12; i += 1) {
      turns = await cdp.evaluate(TURNS);
      if (turns.length) break;
      await sleep(700);
    }
    await sleep(800);
    turns = await cdp.evaluate(TURNS);
    const msgs = await evalAsync(messagesOf(sid));
    const shotDefault = await shot(cdp, `52-a9-${tag}-default.png`);
    const target = turns.find((t) => t.head.includes(needle));
    let toggled = null;
    let after = null;
    if (target?.details?.length) {
      toggled = await cdp.evaluate(toggleTurnGroup(needle));
      await sleep(700);
      after = (await cdp.evaluate(TURNS)).find((t) => t.head.includes(needle))?.details ?? null;
    }
    const rec = {
      tag,
      sid,
      via: sw.via,
      activeSessionId: sw.activeSessionId,
      turns: turns.map((t) => ({ head: t.head.slice(0, 70), details: t.details })),
      assistantStopCauses: msgs.filter((m) => m.role === 'assistant').map((m) => m.stopCause),
      targetDefault: target?.details ?? null,
      toggled,
      targetAfterClick: after,
      shotDefault,
    };
    out.cases.push(rec);
    console.log(
      tag,
      JSON.stringify({
        via: sw.via,
        targetDefault: rec.targetDefault,
        afterClick: after,
        stopCauses: rec.assistantStopCauses,
      })
    );
  }
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save('52-a9.json', out);
  cdp.close();
}
