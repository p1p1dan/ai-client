import { describe, expect, it } from 'vitest';
import {
  DSH_PLUGIN_STATES,
  DSH_PLUGINS_SETTING_KEY,
  type DshPluginReport,
  isDshPluginPackageName,
  isDshPluginReport,
  parseDshPluginSelection,
} from '../dshPlugins';

/**
 * dsh-rebase P1-10b — the plugin contract between Main and the shared host
 * (decision 108): the settings value Main keeps, and the `ready.plugins`
 * report it takes from the host.
 */

const report: DshPluginReport = {
  enabledFrom: 'main',
  plugins: [
    { name: 'dsh-a', version: '1.0.0', state: 'loaded', defaultEnabled: false },
    {
      name: '@s/dsh-b',
      version: '2.0.0',
      state: 'loaded',
      defaultEnabled: true,
      inactiveRows: ['b'],
    },
    { name: 'dsh-c', version: '1.0.0', state: 'disabled', defaultEnabled: false },
    {
      name: 'dsh-d',
      version: '1.0.0',
      state: 'missing',
      reason: 'not in the install directory',
      defaultEnabled: false,
    },
    {
      name: 'dsh-e',
      version: '1.0.0',
      state: 'rejected',
      reason: 'bundle patch: …',
      defaultEnabled: false,
    },
  ],
  dropped: [{ name: '@evil/bundle', reason: 'not on the allowlist' }],
};

describe('the settings value (decision 110, revising decision 108 rule 5)', () => {
  it('lives under a Main-owned key', () => {
    expect(DSH_PLUGINS_SETTING_KEY).toBe('dshPlugins');
  });

  it('is absent (every plugin follows its default) unless it holds an overrides object', () => {
    for (const raw of [undefined, null, [], 'dsh-a', { overrides: ['dsh-a'] }, { other: {} }]) {
      expect(parseDshPluginSelection(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });

  it('keeps package name -> boolean entries only, sorted by key; an empty object is a choice too', () => {
    expect(
      parseDshPluginSelection({
        overrides: {
          'dsh-b': true,
          '@s/dsh-a': false,
          'Bad Name': true,
          '': true,
          'dsh-c': 'yes',
        },
      })
    ).toEqual({ '@s/dsh-a': false, 'dsh-b': true });
    expect(parseDshPluginSelection({ overrides: {} })).toEqual({});
    expect(isDshPluginPackageName('@aiclient-test/dsh-fixture-plugin')).toBe(true);
    expect(isDshPluginPackageName('../evil')).toBe(false);
  });
});

describe('isDshPluginReport (decision 108 rule 8)', () => {
  it('accepts every state the host reports', () => {
    expect([...DSH_PLUGIN_STATES]).toEqual(['loaded', 'disabled', 'missing', 'rejected']);
    expect(isDshPluginReport(report)).toBe(true);
    expect(isDshPluginReport({ enabledFrom: 'default', plugins: [], dropped: [] })).toBe(true);
  });

  it('refuses anything else', () => {
    const bad: unknown[] = [
      undefined,
      [],
      { ...report, enabledFrom: 'user' },
      { ...report, plugins: [{ ...report.plugins[0], state: 'skipped' }] },
      { ...report, plugins: [{ ...report.plugins[0], defaultEnabled: 'no' }] },
      { ...report, plugins: [{ ...report.plugins[0], inactiveRows: [1] }] },
      { ...report, dropped: [{ name: 'x' }] },
      { enabledFrom: 'main', plugins: [] },
    ];
    for (const value of bad) expect(isDshPluginReport(value), JSON.stringify(value)).toBe(false);
  });
});
