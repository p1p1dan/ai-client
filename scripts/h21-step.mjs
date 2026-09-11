/**
 * One question at a time against the already-running dev app.
 *
 * Kept separate from `h21-cdp.mjs` so the app is launched once and asked many
 * things: on this host a relaunch costs ~30s and ~900 MB.
 *
 *   node scripts/h21-step.mjs look
 */

import { Cdp, clickByText, DIALOG_STATE, FLAG, hasText, sleep, toggleBox } from './h21-cdp.mjs';

const [command, ...rest] = process.argv.slice(2);

const cdp = await Cdp.attach();
cdp.collectRendererProblems();
await cdp.waitFor(`(document.getElementById('root')?.innerText.length ?? 0) > 10`, {
  timeoutMs: 120_000,
  label: 'renderer painted',
});

const show = (label, value) => console.log(`\n=== ${label} ===\n${value}`);

switch (command) {
  case 'look': {
    show('flag', await cdp.evaluate(`localStorage.getItem(${JSON.stringify(FLAG)})`));
    show('root text', await cdp.evaluate(`document.getElementById('root').innerText.slice(0, 900)`));
    show('dialog', JSON.stringify(await cdp.evaluate(DIALOG_STATE), null, 1));
    break;
  }
  case 'click': {
    show('clicked', await cdp.evaluate(clickByText(rest.join(' '))));
    await sleep(900);
    show('dialog after', JSON.stringify(await cdp.evaluate(DIALOG_STATE), null, 1));
    break;
  }
  case 'toggle': {
    show('checked now', await cdp.evaluate(toggleBox(rest.join(' '))));
    await sleep(500);
    show('dialog after', JSON.stringify(await cdp.evaluate(DIALOG_STATE), null, 1));
    break;
  }
  case 'has': {
    show(rest.join(' '), String(await cdp.evaluate(hasText(rest.join(' ')))));
    break;
  }
  case 'eval': {
    show('result', JSON.stringify(await cdp.evaluate(rest.join(' ')), null, 1));
    break;
  }
  case 'flag': {
    const value = rest[0];
    await cdp.evaluate(
      value === 'clear'
        ? `localStorage.removeItem(${JSON.stringify(FLAG)}); 'cleared'`
        : `localStorage.setItem(${JSON.stringify(FLAG)}, 'true'); 'set'`
    );
    show('flag', await cdp.evaluate(`localStorage.getItem(${JSON.stringify(FLAG)})`));
    break;
  }
  case 'reload': {
    await cdp.evaluate(`location.reload(); 'reloading'`);
    await sleep(Number(rest[0] ?? 6000));
    show('dialog after reload', JSON.stringify(await cdp.evaluate(DIALOG_STATE), null, 1));
    break;
  }
  case 'shot': {
    show('saved', await cdp.screenshot(rest[0] ?? 'shot'));
    break;
  }
  default:
    console.error(`unknown command: ${command}`);
}

if (cdp.problems.length) show('renderer problems', JSON.stringify(cdp.problems, null, 1));
cdp.close();
process.exit(0);
