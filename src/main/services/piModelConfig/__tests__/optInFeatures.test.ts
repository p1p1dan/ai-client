import { PI_OPT_IN_FEATURE_SETTINGS_KEY } from '@shared/piModelConfig';
import { describe, expect, it } from 'vitest';
import { optInFeatureRegistry } from '../../../../agent-host/bundledPlugins.mjs';
import { resolveOptInFeatures } from '../optInFeatures';

describe('bundled opt-in feature settings', () => {
  it('uses the bundled registry and requires a cost description', () => {
    expect(optInFeatureRegistry().map((feature) => feature.id)).toEqual(['subagents']);
    expect(optInFeatureRegistry().every((feature) => feature.cost.length > 0)).toBe(true);
    expect(() =>
      optInFeatureRegistry([
        { package: 'invalid', entry: 'index.ts', shipsLicenceFile: true, optIn: 'invalid' },
      ])
    ).toThrow('cost description');
  });

  it('preserves an existing opt-in and lets an explicit new preference override it', () => {
    expect(resolveOptInFeatures({ enablePiSubagents: true })).toEqual(['subagents']);
    expect(
      resolveOptInFeatures({
        enablePiSubagents: true,
        [PI_OPT_IN_FEATURE_SETTINGS_KEY]: { subagents: false },
      })
    ).toEqual([]);
  });

  it('ignores unknown features and uses defaults from the registry', () => {
    expect(resolveOptInFeatures({ [PI_OPT_IN_FEATURE_SETTINGS_KEY]: { unknown: true } })).toEqual(
      []
    );
    expect(
      resolveOptInFeatures({}, [
        { id: 'future', label: 'Future', cost: 'One token', defaultEnabled: true },
      ])
    ).toEqual(['future']);
    expect(resolveOptInFeatures({ enablePiSubagents: true }, [])).toEqual([]);
  });
});
