/** Session tree dialog screenshots (「会话分支」) for the active conversation. NAME=<file tag> */
import { connect, save, shot, sleep, stamp } from './ij-lib.mjs';

const { cdp, evalAsync } = await connect();
const out = { at: stamp() };
try {
  out.active = await evalAsync(
    `const chat = await import('/stores/chatSessions.ts'); return chat.useChatSessionsStore.getState().activeSessionId;`
  );
  out.click = await cdp.evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '会话分支' && n.offsetParent !== null); if (!b) return false; b.click(); return true; })()`
  );
  for (let i = 0; i < 12; i += 1) {
    await sleep(500);
    if (
      await cdp.evaluate(
        `[...document.querySelectorAll('[role="dialog"]')].some((n) => n.offsetParent !== null)`
      )
    )
      break;
  }
  await sleep(1200);
  out.dialog = await cdp.evaluate(
    `(() => { const d = [...document.querySelectorAll('[role="dialog"]')].filter((n) => n.offsetParent !== null)[0]; return d ? (d.innerText || '').trim().split('\\n').filter(Boolean).slice(0, 60) : null; })()`
  );
  out.shot = await shot(cdp, `55-tree-${process.env.NAME ?? 'active'}.png`);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await sleep(600);
  console.log(JSON.stringify(out, null, 1));
} finally {
  save(`55-tree-ui-${process.env.NAME ?? 'active'}.json`, out);
  cdp.close();
}
