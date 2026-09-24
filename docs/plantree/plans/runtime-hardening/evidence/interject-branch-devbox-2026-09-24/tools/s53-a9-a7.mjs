/** A9 (A7 conversation) — its title appears twice in the sidebar, so click the repo-list row directly. */
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

const sid = 'session-1790255259304-itxchqv';
const { cdp, evalAsync } = await connect();
const out = { at: stamp() };
try {
  out.click = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="button"][title]')].filter((n) => n.offsetParent !== null && (n.getAttribute('title') || '').startsWith('⟦sub⟧ A7'));
    if (!rows.length) return { ok: false };
    rows[rows.length - 1].click();
    return { ok: true, matches: rows.length };
  })()`);
  for (let i = 0; i < 15; i += 1) {
    await sleep(700);
    const a = await evalAsync(
      `const chat = await import('/stores/chatSessions.ts'); return chat.useChatSessionsStore.getState().activeSessionId;`
    );
    const turns = await cdp.evaluate(TURNS);
    if (a === sid && turns.length) break;
  }
  await sleep(1000);
  out.turns = await cdp.evaluate(TURNS);
  out.stopCauses = (await evalAsync(messagesOf(sid)))
    .filter((m) => m.role === 'assistant')
    .map((m) => m.stopCause);
  out.shotDefault = await shot(cdp, '53-a9-A7-interjected-default.png');
  out.toggle = await cdp.evaluate(toggleTurnGroup('A7 派慢子代理'));
  await sleep(700);
  out.after = (await cdp.evaluate(TURNS)).map((t) => ({
    head: t.head.slice(0, 60),
    details: t.details,
  }));
  console.log(
    JSON.stringify(
      {
        click: out.click,
        turns: out.turns.map((t) => ({ head: t.head.slice(0, 60), details: t.details })),
        stopCauses: out.stopCauses,
        after: out.after,
      },
      null,
      1
    )
  );
} finally {
  save('53-a9-a7.json', out);
  cdp.close();
}
