import { describe, expect, it } from 'vitest';
import {
  PRODUCT_BUNDLES,
  partitionSkippedBundles,
  REQUIRED_DISABLED,
  reconcileProductBundles,
  requiredDisabledOverlays,
  sameBundles,
} from '../hostProfile.ts';

/**
 * dsh-rebase P1-3a — the rules host.ts applies at every start (HS-02, HS-03 of
 * the P1-3 plan; decisions 023 and 025).
 */

const BASE = '@deepseek-ai/dsh-base';
const APP = '@aiclient/dsh-app';
const PLUGIN = '@someone/dsh-plugin';
const PROBE = '@aiclient/dsh-probe';

describe('reconcileProductBundles (HS-03, decision 025 rule 5)', () => {
  it('writes the product bundles for a fresh install', () => {
    expect(PRODUCT_BUNDLES).toEqual([BASE, APP]);
    expect(reconcileProductBundles(undefined)).toEqual([BASE, APP]);
    expect(reconcileProductBundles([])).toEqual([BASE, APP]);
  });

  it('puts the product bundles back in front of an older or reordered list', () => {
    expect(reconcileProductBundles([BASE])).toEqual([BASE, APP]);
    expect(reconcileProductBundles([APP, BASE])).toEqual([BASE, APP]);
    expect(reconcileProductBundles([PLUGIN, APP])).toEqual([BASE, APP, PLUGIN]);
  });

  it('keeps plugin and test bundles after the product, once, in their order', () => {
    expect(reconcileProductBundles([BASE, APP, PROBE, PLUGIN, PROBE])).toEqual([
      BASE,
      APP,
      PROBE,
      PLUGIN,
    ]);
  });

  it('drops retired product bundles and anything that is not a bundle name', () => {
    expect(
      reconcileProductBundles(
        [BASE, '@aiclient/old-app', APP, 7, '', null, PLUGIN],
        PRODUCT_BUNDLES,
        ['@aiclient/old-app']
      )
    ).toEqual([BASE, APP, PLUGIN]);
  });

  it('is idempotent', () => {
    for (const listed of [undefined, [PLUGIN], [APP, PLUGIN, BASE, PROBE]]) {
      const once = reconcileProductBundles(listed);
      expect(reconcileProductBundles(once)).toEqual(once);
      expect(sameBundles(reconcileProductBundles(once), once)).toBe(true);
    }
    expect(sameBundles([BASE, APP], [APP, BASE])).toBe(false);
  });
});

describe('requiredDisabledOverlays (HS-02, decision 023 rule 3)', () => {
  it('restates every required row off, and nothing else', () => {
    const overlays = requiredDisabledOverlays();
    expect(overlays.map((patch) => patch.id)).toEqual([...REQUIRED_DISABLED]);
    expect(
      overlays.every((patch) => patch.disabled === true && Object.keys(patch).length === 2)
    ).toBe(true);
  });

  it('covers the privacy and endpoint rows', () => {
    for (const id of [
      'session-telemetry-otel',
      'deepseek-account',
      'llm-deepseek',
      'session-log-deepseek',
      'web-search-deepseek',
    ]) {
      expect(REQUIRED_DISABLED).toContain(id);
    }
  });
});

describe('partitionSkippedBundles (decision 025 rule 5)', () => {
  it('fails on a product bundle and only warns on a plugin bundle', () => {
    const skipped = [
      { packageName: PLUGIN, reason: 'peer mismatch' },
      { packageName: APP, reason: 'missing' },
    ];
    expect(partitionSkippedBundles(skipped)).toEqual({
      product: [{ packageName: APP, reason: 'missing' }],
      plugins: [{ packageName: PLUGIN, reason: 'peer mismatch' }],
    });
  });
});
