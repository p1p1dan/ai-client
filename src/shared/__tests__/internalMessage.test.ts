/**
 * T005, extended by decision 007 — the mark that says "the user did not write
 * this".
 *
 * Three consumers read it and none of them fails loudly when it is wrong: the
 * projector draws a bubble for a message nobody typed, compaction keeps it as
 * the surviving user instruction, and the session file hands it back as the
 * newest user task on reopen. The recogniser used to compare against one string
 * literal, which meant a second origin would have been silently invisible to
 * all three — so every case here runs over EVERY origin rather than the one
 * that happened to exist first.
 */

import { describe, expect, it } from 'vitest';
import {
  type InternalMessageOrigin,
  internalMessageMark,
  internalMessageOrigin,
  isInternalMessage,
  markInternalMessage,
} from '../internalMessage.ts';

const ORIGINS = [
  'subagent-report',
  'project-instructions',
  'turn-ceiling',
] as const satisfies readonly InternalMessageOrigin[];

describe('internal message marks', () => {
  it.each(ORIGINS)('recognises a %s message', (origin) => {
    const marked = markInternalMessage({ role: 'user', content: 'x' }, origin);
    expect(internalMessageOrigin(marked)).toBe(origin);
    expect(isInternalMessage(marked)).toBe(true);
    // The message itself is untouched: the text still has to reach the model.
    expect(marked).toMatchObject({ role: 'user', content: 'x' });
  });

  it.each(ORIGINS)('keeps the %s mark across a JSONL round trip', (origin) => {
    // The session codec carries unknown message fields through untouched, so
    // the mark has to survive `JSON.parse(JSON.stringify(...))` — the reopen is
    // exactly where an unmarked message gets mistaken for the user's newest
    // instruction.
    const marked = markInternalMessage({ role: 'user', content: 'x' }, origin);
    const reopened: unknown = JSON.parse(JSON.stringify(marked));
    expect(internalMessageOrigin(reopened)).toBe(origin);
  });

  it('answers undefined for a real message and for an unknown origin', () => {
    expect(internalMessageOrigin({ role: 'user', content: 'x' })).toBeUndefined();
    expect(isInternalMessage({ role: 'user', content: 'x' })).toBe(false);
    // A future or corrupted value must not be waved through as internal: a
    // message wrongly hidden is a message the user never sees they sent.
    expect(internalMessageOrigin({ aiclientInternal: 'something-else' })).toBeUndefined();
    expect(internalMessageOrigin(undefined)).toBeUndefined();
    expect(internalMessageOrigin('subagent-report')).toBeUndefined();
  });

  it.each(ORIGINS)('exposes %s as plain fields for a caller that merges its own', (origin) => {
    expect(internalMessageMark(origin)).toEqual({ aiclientInternal: origin });
  });
});
