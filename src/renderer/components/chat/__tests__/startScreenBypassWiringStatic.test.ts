import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * User ruling 2026-10-16 (route B plan README §1 ruling 16): bypass picked on
 * the start screen goes to the chat the next start-screen send creates. Neither
 * `sendFromHome` nor `runSend` can be rendered in this suite (see
 * `retryLastTurn.test.ts`), so where the hold is handed over is pinned by source
 * scan; what `adoptStartScreenPermissions` does is `composerPermissions.test.ts`'s.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPOSER = stripComments(
  readFileSync(path.resolve(here, '../ChatComposer.tsx'), 'utf8'),
  'ChatComposer.tsx'
).replace(/\s+/g, ' ');
const slice = (from: string, to: string) => {
  const start = COMPOSER.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  return COMPOSER.slice(start, COMPOSER.indexOf(to, start));
};

describe('[ruling 2026-10-16] start-screen bypass reaches the chat it starts', () => {
  it('the home send hands it to the chat it just made, before the message goes or queues', () => {
    const home = slice('const sendFromHome = async', 'const sendHomeOnCurrentBranch');
    const made = home.indexOf('if (!sessionId) return;');
    const adopted = home.indexOf('adoptStartScreenPermissions(sessionId);');
    expect(made).toBeGreaterThan(-1);
    expect(adopted).toBeGreaterThan(made);
    expect(adopted).toBeLessThan(home.indexOf("if (action === 'enqueue') { const queued"));
    expect(adopted).toBeLessThan(home.indexOf('await runSend('));
  });

  it('runSend hands it only to a chat it makes itself, before reading what to spawn on', () => {
    const run = slice('const runSend = async (', 'const wireAttachments =');
    expect(run).toContain(
      'if (!options.home && activeSessionId === null) adoptStartScreenPermissions(sessionId);'
    );
    expect(run.indexOf('adoptStartScreenPermissions(')).toBeLessThan(
      run.indexOf('let spawnPermissions =')
    );
  });
});
