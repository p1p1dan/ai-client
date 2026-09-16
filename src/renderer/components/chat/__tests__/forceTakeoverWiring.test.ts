import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * concurrency-02 — the half of the forced takeover that lives in a `.tsx`.
 *
 * The repo's vitest environment is `node` and collects only `.ts`, so the
 * decisions were kept in `historyError.ts` where they can be asserted
 * (`deriveTakeoverControl`, `describeSessionLockOwner`). What is left in
 * `MessageTimeline.tsx` is the wiring — which handler calls which action with
 * which flag — and a source scan is the only thing that can pin it. Same shape
 * as `piResumeNoFallback.test.ts`.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../MessageTimeline.tsx', import.meta.url)),
  'utf8'
);

function handler(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = async () => {`);
  if (start < 0) throw new Error(`MessageTimeline handler ${name} not found`);
  const end = SOURCE.indexOf('\n  };', start);
  if (end < 0) throw new Error(`MessageTimeline handler ${name} is unterminated`);
  return SOURCE.slice(start, end);
}

describe('forced takeover wiring (concurrency-02)', () => {
  it('asks for the takeover through the resume call, not beside it', () => {
    const takeover = handler('handleForceTakeover');
    expect(takeover).toContain('resume(sessionId, {');
    expect(takeover).toContain('forceTakeover: true');
    expect(takeover.indexOf('forceTakeover: true')).toBeGreaterThan(
      takeover.indexOf('resume(sessionId, {')
    );
    // The model still has to be resolved, for the same reason the Retry above
    // resolves it: without one the Host registry entry's `model` stays
    // undefined and every later direct send falls back to the gateway default.
    expect(takeover).toContain('resolveSessionModel(sessionId)');
  });

  it('never forces the plain Retry', () => {
    // Retry is the harmless answer when the holder is a window the user is
    // about to close. A flag that leaked into it would make the safe button
    // displace a live writer.
    expect(handler('handleRetry')).not.toContain('forceTakeover');
  });

  it('gives the locked card an icon of its own', () => {
    // The table is `as const` and indexed by code, so a MISSING entry is a
    // compile error — a wrong one is not, and a padlock is the only icon here
    // that says "occupied" rather than "missing" or "damaged".
    const start = SOURCE.indexOf('const HISTORY_ERROR_ICON = {');
    const end = SOURCE.indexOf('} as const;', start);
    expect(SOURCE.slice(start, end)).toContain('session_locked: Lock,');
  });
});
