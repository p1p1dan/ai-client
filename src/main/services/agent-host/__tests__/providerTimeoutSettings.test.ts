/**
 * The Main-side read of the provider idle timeout (T093 / decision 029).
 *
 * Lives on the Main side for the reason `promptCacheSettings.test.ts` states:
 * `src/runtime` is its own npm package, and a test there importing this file
 * would drag `src/main` into the runtime type-check gate.
 *
 * The trap this setting has and the TTLs do not: `0` is a real choice — the
 * user's "never time out" — so every guard on the way to the worker has to be
 * written as "is it absent" and never as "is it truthy". A truthiness test
 * anywhere on this path silently turns "off" back into the 120-second default.
 */

import { describe, expect, it } from 'vitest';
import { providerTimeoutSettings } from '../providerTimeoutSettings';

function state(values: Record<string, unknown>): () => Record<string, unknown> {
  return () => values;
}

describe('provider idle timeout setting', () => {
  it('reports nothing for an install that never chose', () => {
    // Absence is what keeps the bootstrap payload byte-identical to a pre-T093
    // build's, which is what `sameBootstrap` compares.
    expect(providerTimeoutSettings(state({}))).toEqual({});
  });

  it('carries a chosen value through', () => {
    expect(providerTimeoutSettings(state({ providerIdleTimeoutMs: 30_000 }))).toEqual({
      providerIdleTimeoutMs: 30_000,
    });
  });

  it('keeps zero, because zero is the user saying "off"', () => {
    expect(providerTimeoutSettings(state({ providerIdleTimeoutMs: 0 }))).toEqual({
      providerIdleTimeoutMs: 0,
    });
  });

  it('accepts the numeric string a JSON settings store may hold', () => {
    expect(providerTimeoutSettings(state({ providerIdleTimeoutMs: '120000' }))).toEqual({
      providerIdleTimeoutMs: 120_000,
    });
  });

  it('drops anything it cannot trust rather than passing it on', () => {
    for (const value of ['2 minutes', -1, 1.5, Number.NaN, 99_999_999, null, {}]) {
      expect(providerTimeoutSettings(state({ providerIdleTimeoutMs: value }))).toEqual({});
    }
  });
});
