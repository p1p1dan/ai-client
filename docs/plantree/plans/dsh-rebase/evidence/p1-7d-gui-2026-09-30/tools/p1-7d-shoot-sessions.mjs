#!/usr/bin/env node
/**
 * Open chats by id suffix and take one privacy-checked screenshot of each:
 *   node p1-7d-shoot-sessions.mjs <suffix>=<shot name> [...]
 * An optional `@text` after the name scrolls that text into view instead of
 * scrolling to the end, e.g. `2uv9916=A10-context-summary@Context summary`.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { lib } = await import(path.join(here, 'p1-7d-gui.mjs'));
const body = fs.readFileSync(path.join(here, 'timeline.body.txt'), 'utf8');

const cdp = await lib.attach(30_000);
const evalAsync = lib.makeEval(cdp);
for (const arg of process.argv.slice(2)) {
  const [suffix, rest] = arg.split('=');
  const [name, anchor] = rest.split('@');
  await cdp.evaluate(`(() => { window.__p17dOpen = ${JSON.stringify(suffix)}; return true; })()`);
  await evalAsync(body, { label: `open ${suffix}`, timeoutMs: 60_000 });
  if (anchor) {
    await cdp.evaluate(`(() => {
      const n = [...document.querySelectorAll('*')].find((x) => x.offsetParent !== null && x.children.length === 0 && (x.innerText || '').trim() === ${JSON.stringify(anchor)});
      if (n) n.scrollIntoView({ block: 'center' });
      return !!n;
    })()`);
    await lib.sleep(600);
  }
  console.log(await lib.shot(cdp, name));
}
cdp.close();
process.exit(0);
