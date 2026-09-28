import type { DshPluginCatalogEntry } from '@shared/dshPluginSettings';
import type { DshPluginReport } from '@shared/dshPlugins';
import { describe, expect, it } from 'vitest';
import type { DshPluginCatalog } from '../pluginCatalog';
import { buildDshPluginsState, withOverride } from '../pluginsView';

/**
 * dsh-rebase P1-10c (decision 117) — the settings page's state: the catalog
 * this build ships, the user's overrides and the latest host report, merged
 * by the host's own "override, else defaultEnabled" rule.
 */

function entry(name: string, extra: Partial<DshPluginCatalogEntry> = {}): DshPluginCatalogEntry {
  return {
    name,
    version: '1.0.0',
    kind: 'internal',
    defaultEnabled: false,
    description: `${name} does things`,
    readTools: [],
    writeTools: [],
    askTools: [],
    unlistedToolsAsk: false,
    review: { date: '2026-09-28', verdict: 'approved' },
    ...extra,
  };
}

const CATALOG: DshPluginCatalog = {
  plugins: [entry('dsh-a'), entry('dsh-b', { defaultEnabled: true }), entry('dsh-c')],
  error: null,
};

function report(extra: Partial<DshPluginReport> = {}): DshPluginReport {
  return {
    enabledFrom: 'main',
    plugins: [
      { name: 'dsh-a', version: '1.0.0', defaultEnabled: false, state: 'disabled' },
      { name: 'dsh-b', version: '1.0.0', defaultEnabled: true, state: 'loaded' },
      {
        name: 'dsh-c',
        version: '1.0.0',
        defaultEnabled: false,
        state: 'rejected',
        reason: 'declares no dsh.bundle.patch',
      },
    ],
    dropped: [],
    ...extra,
  };
}

describe('buildDshPluginsState', () => {
  it('follows the override, else defaultEnabled, and says which ones the user touched', () => {
    const state = buildDshPluginsState({
      catalog: CATALOG,
      overrides: { 'dsh-a': true, 'dsh-b': false },
      report: undefined,
    });
    expect(state.plugins.map((p) => [p.name, p.enabled, p.overridden])).toEqual([
      ['dsh-a', true, true],
      ['dsh-b', false, true],
      ['dsh-c', false, false],
    ]);
  });

  it('with nobody having touched anything, every plugin follows its default', () => {
    const state = buildDshPluginsState({
      catalog: CATALOG,
      overrides: undefined,
      report: undefined,
    });
    expect(state.plugins.map((p) => p.enabled)).toEqual([false, true, false]);
    expect(state.plugins.every((p) => !p.overridden)).toBe(true);
  });

  it('keeps the catalog fields and adds what the last host start reported', () => {
    const state = buildDshPluginsState({ catalog: CATALOG, overrides: {}, report: report() });
    expect(state.plugins[1]).toMatchObject({
      name: 'dsh-b',
      description: 'dsh-b does things',
      review: { date: '2026-09-28', verdict: 'approved' },
      host: { state: 'loaded' },
    });
    expect(state.plugins[2]?.host).toEqual({
      state: 'rejected',
      reason: 'declares no dsh.bundle.patch',
    });
    expect(state.hostReported).toBe(true);
  });

  it('marks a restart pending only where the last start disagrees with the switch', () => {
    // a: off by default, reported disabled, now switched on   -> pending
    // b: on by default, reported loaded, untouched              -> in line
    // c: off, reported rejected (the host was asked for it)     -> pending (turned off since)
    const state = buildDshPluginsState({
      catalog: CATALOG,
      overrides: { 'dsh-a': true },
      report: report(),
    });
    expect(state.plugins.map((p) => [p.name, p.pendingRestart])).toEqual([
      ['dsh-a', true],
      ['dsh-b', false],
      ['dsh-c', true],
    ]);
  });

  it('claims nothing about a restart before any host start has reported', () => {
    const state = buildDshPluginsState({
      catalog: CATALOG,
      overrides: { 'dsh-a': true },
      report: undefined,
    });
    expect(state.plugins.every((p) => p.host === null && !p.pendingRestart)).toBe(true);
    expect(state.hostReported).toBe(false);
  });

  it('lists what this build no longer ships: switched on by the user, or dropped by the host', () => {
    const state = buildDshPluginsState({
      catalog: CATALOG,
      overrides: { 'dsh-gone': true, 'dsh-off-and-gone': false, 'dsh-a': true },
      report: report({
        dropped: [
          { name: 'dsh-gone', reason: 'not on the allowlist' },
          { name: 'dsh-off-and-gone', reason: 'not on the allowlist' },
          { name: 'dsh-default-gone', reason: 'not on the allowlist' },
          // An allowlisted plugin the host left out says why on its own row.
          { name: 'dsh-a', reason: 'not enabled' },
        ],
      }),
    });
    expect(state.delisted).toEqual([
      { name: 'dsh-gone', reason: 'not on the allowlist' },
      { name: 'dsh-default-gone', reason: 'not on the allowlist' },
    ]);
  });

  it('reports a selection the host could not read, and a catalog that could not be read', () => {
    expect(
      buildDshPluginsState({
        catalog: CATALOG,
        overrides: {},
        report: report({ enabledFrom: 'invalid' }),
      }).selectionInvalid
    ).toBe(true);
    const broken = buildDshPluginsState({
      catalog: { plugins: [], error: 'allowlist.json is unreadable' },
      overrides: undefined,
      report: undefined,
    });
    expect(broken).toMatchObject({ plugins: [], catalogError: 'allowlist.json is unreadable' });
  });
});

describe('withOverride', () => {
  it('changes one entry and keeps every other, delisted names included', () => {
    expect(withOverride({ 'dsh-gone': true, 'dsh-b': false }, 'dsh-a', true)).toEqual({
      'dsh-gone': true,
      'dsh-b': false,
      'dsh-a': true,
    });
    expect(withOverride(undefined, 'dsh-a', false)).toEqual({ 'dsh-a': false });
  });
});
