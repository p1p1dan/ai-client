import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * U12 fix — the renderer half of "the chip and the runtime must agree".
 *
 * `chat:setPermissionTier` can only reach a worker that already exists. Two
 * ordinary flows produced no worker to reach:
 *
 *  A. the user picks a tier BEFORE sending the first message — arguably the
 *     most natural way to use a safety control — and there is no session yet;
 *  B. a worker crashes and respawns, rebuilding its authorizer from scratch.
 *
 * In both cases the composer chip kept showing the user's choice while the
 * runtime enforced the shipped default, i.e. something laxer than what the
 * screen promised. Main closes B (`WorkerManager.test.ts`); A is closed here,
 * by making every spawn request carry the stored tier.
 *
 * Source-scanned because the fix is "this value is present at these three
 * dispatch sites" — a fact no unit test of a pure function can reach, and one
 * that a future edit to the payload literals would silently drop.
 */

const COMPOSER = stripComments(
  readFileSync(path.join(__dirname, '..', 'ChatComposer.tsx'), 'utf8'),
  'ChatComposer.tsx'
);
const RESUME_HOOK = stripComments(
  readFileSync(path.join(__dirname, '..', 'sessionIndex', 'useResumeSession.ts'), 'utf8'),
  'useResumeSession.ts'
);

describe('[U12 fix] the send path carries the stored tier into the spawn', () => {
  it('reads the tier from the same store the chip writes', () => {
    // Not from component state: `runSend` can be entered from a queue release
    // or a retry, and the chip's own React state is not in scope there. One
    // store means the two cannot disagree.
    expect(COMPOSER).toContain('readSessionTier');
    expect(COMPOSER).toContain('const spawnTier = readSessionTier(sessionId) ?? undefined');
  });

  it('sends it with createSession', () => {
    expect(COMPOSER).toMatch(
      /createSession\(\{[\s\S]{0,600}\.\.\.\(spawnTier \? \{ tier: spawnTier \} : \{\}\)/
    );
  });

  it('sends it with both resume dispatch sites', () => {
    // Two, not one: the ordinary resume preamble and the `session_not_found`
    // reopen. Either can be the call that spawns the worker for this turn.
    const occurrences = COMPOSER.split('...(spawnTier ? { tier: spawnTier } : {})').length - 1;
    expect(occurrences).toBe(3);
  });

  it('omits the key entirely for an untouched session', () => {
    // `?? undefined` plus a conditional spread, not `tier: readSessionTier(...)`.
    // Sending an explicit `undefined` would still be a present key on some
    // paths, and "no preference" has to stay distinguishable from a choice.
    expect(COMPOSER).not.toContain('tier: readSessionTier(');
  });
});

describe('[U12 fix] the sidebar resume path carries it too', () => {
  it('reads the stored tier and passes it to the resume intent', () => {
    // Opening a session from the sidebar spawns a worker just like a send
    // does, so leaving this one out would reopen the same drift by a different
    // door.
    expect(RESUME_HOOK).toContain('const storedTier = readSessionTier(sessionId)');
    expect(RESUME_HOOK).toMatch(
      /shouldResumeSession\([\s\S]{0,300}storedTier \? \{ tier: storedTier \}/
    );
  });
});
