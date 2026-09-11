/**
 * H/21 C6 — live check of the Claude Code / Codex import pane.
 *
 * Drives the already-running dev app over CDP (start it with the same helper
 * the rest of the H/21 point-check uses). One question per sub-command so the
 * app is launched once:
 *
 *   node scripts/h21-import-check.mjs open      # Settings → Pi, report the pane
 *   node scripts/h21-import-check.mjs project <text>
 *   node scripts/h21-import-check.mjs import    # select all + import, report
 *   node scripts/h21-import-check.mjs sidebar <title>
 *   node scripts/h21-import-check.mjs shot <name>
 */

import { Cdp, sleep } from './h21-cdp.mjs';

const [command, ...rest] = process.argv.slice(2);
const argument = rest.join(' ');

const cdp = await Cdp.attach();
cdp.collectRendererProblems();
await cdp.waitFor(`(document.getElementById('root')?.innerText.length ?? 0) > 10`, {
  timeoutMs: 120_000,
  label: 'renderer painted',
});

const show = (label, value) => console.log(`\n=== ${label} ===\n${value}`);

/** The import pane's own text, without the rest of the settings page. */
const PANE = `(() => {
  const heading = [...document.querySelectorAll('h3')]
    .find((n) => (n.textContent ?? '').includes('导入历史对话'));
  if (!heading) return null;
  const pane = heading.closest('div.space-y-4')?.parentElement ?? heading.parentElement;
  return (pane?.innerText ?? '').slice(0, 2000);
})()`;

const PROJECT_ROWS = `(() => {
  const heading = [...document.querySelectorAll('h3')]
    .find((n) => (n.textContent ?? '').includes('导入历史对话'));
  const pane = heading?.closest('div.space-y-4')?.parentElement;
  return [...(pane?.querySelectorAll('li button') ?? [])]
    .map((n) => (n.innerText ?? '').replace(/\\n/g, ' | '));
})()`;

switch (command) {
  case 'open': {
    // The gear is aria-labelled, not text-labelled.
    await cdp.evaluate(`(() => {
      const gear = [...document.querySelectorAll('button')]
        .find((n) => (n.getAttribute('aria-label') ?? '').startsWith('设置'));
      if (!gear) throw new Error('no settings button');
      gear.click();
      return true;
    })()`);
    await sleep(1200);
    await cdp.evaluate(`(() => {
      const tab = [...document.querySelectorAll('nav button')]
        .find((n) => (n.textContent ?? '').trim() === 'Pi');
      if (!tab) throw new Error('no Pi tab');
      tab.click();
      return true;
    })()`);
    await sleep(2500);
    show('pane', await cdp.evaluate(PANE));
    show('projects', JSON.stringify(await cdp.evaluate(PROJECT_ROWS), null, 1));
    break;
  }
  case 'project': {
    show(
      'opened',
      await cdp.evaluate(`(() => {
        const row = [...document.querySelectorAll('li button')]
          .find((n) => (n.innerText ?? '').includes(${JSON.stringify(argument)}));
        if (!row) throw new Error('no project row containing ' + ${JSON.stringify(argument)});
        row.click();
        return row.innerText.replace(/\\n/g, ' | ');
      })()`)
    );
    await sleep(2500);
    show('pane', await cdp.evaluate(PANE));
    break;
  }
  case 'select': {
    show(
      'checked',
      await cdp.evaluate(`(() => {
        const boxes = [...document.querySelectorAll('[role="checkbox"]')];
        const target = boxes.find((n) => (n.getAttribute('aria-label') ?? '') === '全选');
        if (!target) throw new Error('no select-all checkbox');
        target.click();
        return true;
      })()`)
    );
    await sleep(800);
    show('pane', await cdp.evaluate(PANE));
    break;
  }
  case 'select-one': {
    show(
      'checked',
      await cdp.evaluate(`(() => {
        const labels = [...document.querySelectorAll('label')]
          .filter((n) => (n.innerText ?? '').includes(${JSON.stringify(argument)}));
        const box = labels[0]?.querySelector('[role="checkbox"], input[type="checkbox"]');
        if (!box) throw new Error('no session row containing ' + ${JSON.stringify(argument)});
        box.click();
        return labels[0].innerText.replace(/\\n/g, ' | ');
      })()`)
    );
    await sleep(800);
    break;
  }
  case 'import': {
    show(
      'pressed',
      await cdp.evaluate(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((n) => (n.textContent ?? '').includes('导入所选') && !n.disabled);
        if (!button) throw new Error('import button missing or disabled');
        button.click();
        return button.textContent.trim();
      })()`)
    );
    await cdp.waitFor(`document.body.innerText.includes('新导入')`, {
      timeoutMs: 180_000,
      label: 'import report',
    });
    show('pane', await cdp.evaluate(PANE));
    break;
  }
  case 'sidebar': {
    await cdp.evaluate(`(() => {
      const close = [...document.querySelectorAll('button')]
        .find((n) => (n.getAttribute('aria-label') ?? '') === 'Close' && n.closest('[role="dialog"]'));
      close?.click();
      return true;
    })()`);
    await sleep(1200);
    show(
      'match',
      await cdp.evaluate(`(() => {
        const rows = [...document.querySelectorAll('button')]
          .map((n) => (n.textContent ?? '').trim())
          .filter((text) => text.includes(${JSON.stringify(argument)}));
        return JSON.stringify(rows.slice(0, 5));
      })()`)
    );
    break;
  }
  case 'open-session': {
    show(
      'opened',
      await cdp.evaluate(`(() => {
        const row = [...document.querySelectorAll('button')]
          .find((n) => (n.textContent ?? '').trim().includes(${JSON.stringify(argument)}));
        if (!row) throw new Error('no sidebar row containing ' + ${JSON.stringify(argument)});
        row.click();
        return row.textContent.trim();
      })()`)
    );
    await sleep(3000);
    show(
      'transcript',
      await cdp.evaluate(`document.getElementById('root').innerText.slice(0, 1800)`)
    );
    break;
  }
  case 'send': {
    show(
      'typed',
      await cdp.evaluate(`(() => {
        const box = document.querySelector('textarea, [contenteditable="true"]');
        if (!box) throw new Error('no composer');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(box, ${JSON.stringify(argument)});
        box.dispatchEvent(new Event('input', { bubbles: true }));
        return box.value ?? box.innerText;
      })()`)
    );
    await sleep(500);
    await cdp.evaluate(`(() => {
      const box = document.querySelector('textarea, [contenteditable="true"]');
      box.focus();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await sleep(Number(process.env.H21_WAIT ?? 25_000));
    show(
      'transcript',
      await cdp.evaluate(`document.getElementById('root').innerText.slice(0, 2500)`)
    );
    break;
  }
  case 'text': {
    show(
      'root text',
      await cdp.evaluate(`document.getElementById('root').innerText.slice(0, 2500)`)
    );
    break;
  }
  case 'shot': {
    show('saved', await cdp.screenshot(argument || 'h21-import'));
    break;
  }
  default:
    console.error(`unknown command: ${command}`);
    process.exitCode = 1;
}

if (cdp.problems.length)
  show('renderer problems', JSON.stringify(cdp.problems.slice(0, 8), null, 1));
cdp.close();
process.exit(0);
