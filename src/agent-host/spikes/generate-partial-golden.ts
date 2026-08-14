/**
 * ONE-SHOT generator for the OFF-position golden baseline.
 *
 * ⚠️ RED LINE — DO NOT RE-RUN AFTER THE PARTIAL-MESSAGES CHANGE ⚠️
 *
 * `__tests__/fixtures/partial-messages/control.golden.json` is the arbiter for
 * "the OFF position (`AICLIENT_HOST_PARTIAL_MESSAGES=0`, and every ON-position
 * turn where the gateway never honours `includePartialMessages`) behaves
 * byte-for-byte as it did before the partial-messages batch". Regenerating it
 * with changed normalizer code turns that arbiter into a rubber stamp — the
 * classic "generate after the refactor" false green. The golden was produced
 * once, on the commit recorded in its own `generatedAtCommit` field, which is
 * the LAST commit before any片1 production code landed.
 *
 * If a future change legitimately alters OFF-position output, the honest move
 * is to hand-edit the golden in the same commit as the behavior change, with
 * the diff visible in review — not to re-run this script.
 *
 * Usage (from `src/agent-host`, Node 24 type stripping, same convention as the
 * other probes in this directory):
 *   node --experimental-strip-types spikes/generate-partial-golden.ts
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventNormalizer } from '../eventNormalizer.ts';

/**
 * Frozen wall clock. `beginTurn`/`ensureAssistant` mint ids as
 * `user-${sessionId}-${Date.now()}` / `asst-${sessionId}-${Date.now()}`, so
 * without this every regeneration (and every test run) would drift. The test
 * that consumes the golden freezes the SAME instant via `vi.setSystemTime`.
 */
const FROZEN_NOW_MS = Date.parse('2026-08-14T00:00:00.000Z');
const SESSION_ID = 'sess-golden-control';
const REQUEST_ID = 'req-golden-control';
const USER_TEXT = 'Run the echo probe and tell me what it printed.';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, '..', '__tests__', 'fixtures', 'partial-messages');
const sdkPath = path.join(fixtureDir, 'control.sdk.json');
const goldenPath = path.join(fixtureDir, 'control.golden.json');

const originalNow = Date.now;
Date.now = () => FROZEN_NOW_MS;

const messages = JSON.parse(readFileSync(sdkPath, 'utf8')) as unknown[];
const events: Record<string, unknown>[] = [];
const normalizer = new EventNormalizer(
  SESSION_ID,
  (event) => events.push(event),
  () => undefined
);
normalizer.beginTurn(USER_TEXT, undefined, REQUEST_ID);
for (const message of messages) {
  normalizer.ingest(message, REQUEST_ID);
}

Date.now = originalNow;

const generatedAtCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: here,
  encoding: 'utf8',
}).trim();

writeFileSync(
  goldenPath,
  `${JSON.stringify(
    {
      note:
        'Generated once by spikes/generate-partial-golden.ts against the ' +
        'pre-partial-messages normalizer. Never regenerate — see that file.',
      generatedAtCommit,
      frozenNowMs: FROZEN_NOW_MS,
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      userText: USER_TEXT,
      sdkFixture: 'control.sdk.json',
      events,
    },
    null,
    2
  )}\n`,
  'utf8'
);

process.stdout.write(
  `golden written: ${goldenPath}\n  commit=${generatedAtCommit}\n  events=${events.length}\n`
);
