import { describe, expect, it } from 'vitest';
import * as sharedCatalog from '../../shared/subagentCatalogRoots.ts';
import * as catalog from '../plugins/subagent/catalog.ts';

/**
 * dsh-rebase P1-16 prep — the runtime half of the subagent catalog move.
 *
 * `src/runtime/plugins/subagent/catalog.ts` used to hold the directory roots,
 * merge and pin-resolution logic; it is now a thin re-export of
 * `src/shared/subagentCatalogRoots.ts` (moved with `subagentDefinitions.test.ts`,
 * whose pure-logic cases became
 * `src/shared/__tests__/subagentCatalogRoots.test.ts`; nothing in that file
 * touched Cordis, so nothing stayed behind to keep testing here). This file
 * checks only what the shared-side suite cannot: every name the runtime module
 * exported before the move is still exported from the same module, and a
 * re-export IS the shared value, not a copy that could drift.
 */

describe('plugins/subagent/catalog.ts still exports what it did', () => {
  it('the same value names as src/shared/subagentCatalogRoots.ts', () => {
    // Type-only exports (SubagentCatalog, SubagentCatalogConfig, ...) have no
    // runtime binding, so this only sees the five functions both ever had.
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(sharedCatalog).sort());
  });

  it('each export is the shared value itself', () => {
    for (const [name, value] of Object.entries(sharedCatalog)) {
      expect((catalog as Record<string, unknown>)[name], name).toBe(value);
    }
  });
});
