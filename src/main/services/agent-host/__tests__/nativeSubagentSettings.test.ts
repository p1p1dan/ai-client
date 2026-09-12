/**
 * P5-2-5 — the native delegation switch, read from shared settings.
 *
 * Lives on the Main side rather than next to the other subagent tests in
 * `src/runtime/__tests__/`: `src/runtime` is its own npm package with its own
 * tsconfig, and a test there that imports this file dragged `src/main` into the
 * runtime type-check gate, where the repo's `@shared/*` aliases do not exist.
 * The assertions are unchanged; only the side of the boundary they run on is.
 */

import { describe, expect, it } from 'vitest';
import { nativeSubagentSettings } from '../nativeSubagentSettings';

describe('P5-2-5 · native delegation is on unless the user turned it off', () => {
  it('defaults on for an install that has never been asked', () => {
    expect(nativeSubagentSettings({})).toEqual({ enabled: true });
  });

  it('reads an explicit opt-in override as the decision', () => {
    expect(nativeSubagentSettings({ piOptInFeatures: { subagents: false } }).enabled).toBe(false);
    expect(nativeSubagentSettings({ piOptInFeatures: { subagents: true } }).enabled).toBe(true);
  });

  it('honours the older boolean when no override exists', () => {
    expect(nativeSubagentSettings({ enablePiSubagents: false }).enabled).toBe(false);
  });

  it('lets the override win over the older boolean', () => {
    expect(
      nativeSubagentSettings({
        enablePiSubagents: false,
        piOptInFeatures: { subagents: true },
      }).enabled
    ).toBe(true);
  });

  it('ignores an unrelated opt-in feature', () => {
    // `false` for something else is not a statement about delegation.
    expect(nativeSubagentSettings({ piOptInFeatures: { jingle: false } }).enabled).toBe(true);
  });

  it('carries the per-install disabled list, and only strings', () => {
    expect(
      nativeSubagentSettings({ nativeSubagentsDisabled: ['fixer', 7, 'explorer'] }).disabled
    ).toEqual(['fixer', 'explorer']);
    expect(nativeSubagentSettings({ nativeSubagentsDisabled: [] }).disabled).toBeUndefined();
  });
});
