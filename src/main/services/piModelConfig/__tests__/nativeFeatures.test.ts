/**
 * cutover-10 — the feature-switch registry, after the opt-in vocabulary left.
 *
 * This table used to declare which BUNDLED pi extension a switch injected, and
 * carried a `defaultEnabled` that the settings page read as the answer to "is
 * it on". The packages are gone (T025) and the default now belongs to
 * `nativeSubagentSettings` alone, so what is guarded here is the shape that
 * makes a second copy of the default impossible to add by accident.
 *
 * Replaces `optInFeatures.test.ts`, whose subject (`resolveOptInFeatures`) was
 * deleted with the chain it fed.
 */

import { describe, expect, it } from 'vitest';
import {
  NATIVE_FEATURE_SWITCHES,
  nativeFeatureRegistry,
} from '../../../../agent-host/bundledPlugins.mjs';

describe('native feature registry', () => {
  it('offers exactly the delegation switch', () => {
    expect(nativeFeatureRegistry().map((feature) => feature.id)).toEqual(['subagents']);
  });

  it('requires a label and a cost description, because the page prints both', () => {
    expect(nativeFeatureRegistry().every((feature) => feature.cost.trim().length > 0)).toBe(true);
    expect(nativeFeatureRegistry().every((feature) => feature.label.trim().length > 0)).toBe(true);
    expect(() => nativeFeatureRegistry([{ id: 'invalid' }])).toThrow('cost description');
    expect(() =>
      nativeFeatureRegistry([{ id: 'invalid', settings: { label: 'X', cost: '  ' } }])
    ).toThrow('cost description');
  });

  it('declares no default for any switch — that answer has one owner', () => {
    // A `defaultEnabled` here is what let the page say "off" while the runtime
    // registered the tools anyway. Reintroducing one must fail loudly.
    for (const entry of NATIVE_FEATURE_SWITCHES) {
      expect(entry.settings).not.toHaveProperty('defaultEnabled');
    }
    for (const feature of nativeFeatureRegistry()) {
      expect(feature).not.toHaveProperty('defaultEnabled');
    }
  });

  it('describes the switch as on unless turned off', () => {
    // The cost sentence is user-visible and was the concrete lie in cutover-10:
    // "Off by default" next to a runtime that had it on.
    const [subagents] = nativeFeatureRegistry();
    expect(subagents.cost).not.toMatch(/off by default/i);
    expect(subagents.cost).toMatch(/unless you turn it off/i);
  });

  it('keeps no "bundled extension" vocabulary in the user-visible strings', () => {
    for (const feature of nativeFeatureRegistry()) {
      expect(`${feature.label} ${feature.cost}`).not.toMatch(/bundled|extension/i);
    }
  });
});
