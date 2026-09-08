/**
 * The mechanical half of `docs/agent-project-engineering.md` A3.
 *
 * A3 requires that a module with nothing to contribute says so explicitly, and
 * that a GATE rejects the unexplained empty shell rather than leaving the check
 * to review discipline. This file is that gate: it runs in the existing
 * `pnpm test` chain, so a P1 author who deletes `runtimeTools` from
 * `DEFERRED_SERVICES` without registering a real service fails CI instead of
 * quietly leaving the graph with a name nobody provides.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFERRED_REASON_MARKER,
  DEFERRED_SERVICES,
  LOOP_SERVICE,
  MODEL_SERVICE,
  P0_SERVICES,
  TRACE_SERVICE,
} from '../contracts.ts';

describe('service contracts', () => {
  it('registers exactly the three services P0 implements', () => {
    expect([...P0_SERVICES]).toEqual([MODEL_SERVICE, TRACE_SERVICE, LOOP_SERVICE]);
  });

  it('never lists a service as both implemented and deferred', () => {
    const overlap = P0_SERVICES.filter((name) => name in DEFERRED_SERVICES);
    expect(overlap).toEqual([]);
  });

  it.each(
    Object.entries(DEFERRED_SERVICES)
  )('%s explains why it has no implementation', (_name, declaration) => {
    expect(declaration.reason.startsWith(DEFERRED_REASON_MARKER)).toBe(true);
    // A marker with nothing after it would satisfy `startsWith` and explain
    // nothing, which is the shell A3 rules out. The threshold is a sentence,
    // not a word.
    expect(declaration.reason.length).toBeGreaterThan(DEFERRED_REASON_MARKER.length + 40);
  });

  it('ties every deferred service to a plan-board phase', () => {
    for (const declaration of Object.values(DEFERRED_SERVICES)) {
      expect(['P1', 'P2', 'P3', 'P5']).toContain(declaration.phase);
    }
  });
});
