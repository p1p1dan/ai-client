import { describe, expect, it } from 'vitest';
import {
  allowlistFromManifest,
  allowlistFromSource,
  auditPluginLayers,
  enabledNames,
  type HostPlugin,
  type InstallVerdict,
  judgeInstalled,
  PLUGINS_ENV,
  PROBE_BUNDLE_ENV,
  packagedProfilePatches,
  planProfileBundles,
  pluginReport,
  readEnabledInput,
  withInactiveRows,
} from '../hostPlugins.ts';

/**
 * dsh-rebase P1-10b — the plugin rules host.ts applies at every start
 * (decisions 025 rule 5, 058, 059, 108, 110): the allowlist it reads, the
 * enabled set, the profile's bundle list, the load audit and the packaged
 * host's home-layer-free patch composition.
 */

const BASE = '@deepseek-ai/dsh-base';
const APP = '@aiclient/dsh-app';
const PRODUCT = [BASE, APP];
const PROBE = '@aiclient/dsh-probe';
const DIR = '/host/node_modules';

function plugin(overrides: Partial<HostPlugin> = {}): HostPlugin {
  return {
    name: 'dsh-a',
    version: '1.0.0',
    rows: ['a-row'],
    defaultEnabled: false,
    replaces: [],
    ...overrides,
  };
}

const A = plugin();
const B = plugin({ name: '@s/dsh-b', rows: ['b-row'], defaultEnabled: true });
const C = plugin({ name: 'dsh-c', rows: ['c-row'], replaces: ['dsh-c-old'] });
const ok: InstallVerdict = { ok: true };
const allInstalled = (...plugins: HostPlugin[]) =>
  new Map<string, InstallVerdict>(plugins.map((item) => [item.name, ok]));

describe('the variables (decision 108 rules 4 and 6, decision 110)', () => {
  it('reads Main’s overrides and the probe switch under their own names', () => {
    expect(PLUGINS_ENV).toBe('AICLIENT_DSH_PLUGINS');
    expect(PROBE_BUNDLE_ENV).toBe('AICLIENT_DSH_PROBE_BUNDLE');
  });
});

describe('allowlistFromManifest (packaged host)', () => {
  it('takes what the host needs from the build’s plugins section', () => {
    const { plugins, failures } = allowlistFromManifest([
      { name: 'dsh-a', version: '1.0.0', rows: ['a-row'], defaultEnabled: false, tools: {} },
      {
        name: '@s/dsh-b',
        version: '2.0.0',
        rows: ['b-row'],
        defaultEnabled: true,
        replaces: ['x'],
      },
    ]);
    expect(failures).toEqual([]);
    expect(plugins).toEqual([
      plugin(),
      plugin({
        name: '@s/dsh-b',
        version: '2.0.0',
        rows: ['b-row'],
        defaultEnabled: true,
        replaces: ['x'],
      }),
    ]);
  });

  it('allowlists nothing without the section, and leaves out entries it cannot use', () => {
    expect(allowlistFromManifest(undefined)).toEqual({
      plugins: [],
      failures: ['dsh-host-manifest.json has no plugins section'],
    });
    expect(allowlistFromManifest({}).plugins).toEqual([]);
    const { plugins, failures } = allowlistFromManifest([
      { name: 'Not A Name', version: '1.0.0', rows: ['r'], defaultEnabled: false },
      { name: 'dsh-a', version: '1.0.0', rows: [], defaultEnabled: false },
      { name: 'dsh-a', version: '1.0.0', rows: ['r'], defaultEnabled: 'yes' },
      { name: 'dsh-a', version: '1.0.0', rows: ['a-row'], defaultEnabled: false },
      { name: 'dsh-a', version: '1.0.1', rows: ['a-row'], defaultEnabled: false },
    ]);
    expect(plugins).toEqual([plugin()]);
    expect(failures).toHaveLength(4);
    expect(failures[3]).toMatch(/dsh-a is listed twice/);
  });
});

describe('allowlistFromSource (checkout host)', () => {
  it('applies the build’s own schema to plugins/allowlist.json', () => {
    expect(allowlistFromSource({ schema: 1, plugins: [] })).toEqual({ plugins: [], failures: [] });
    const { plugins, failures } = allowlistFromSource({ schema: 1, plugins: [{ name: 'dsh-a' }] });
    expect(plugins).toEqual([]);
    expect(failures.length).toBeGreaterThan(0);
  });
});

describe('readEnabledInput and enabledNames (decision 110, revising decision 108 rule 6)', () => {
  it('takes the allowlist’s defaults when Main sent nothing', () => {
    expect(readEnabledInput(undefined)).toEqual({ from: 'default' });
    expect(enabledNames([A, B, C], { from: 'default' })).toEqual(['@s/dsh-b']);
  });

  it('takes Main’s overrides, and follows defaultEnabled for a plugin not overridden', () => {
    const input = readEnabledInput('{"dsh-a":true,"dsh-gone":true,"@s/dsh-b":false}');
    expect(input).toEqual({
      from: 'main',
      overrides: { 'dsh-a': true, 'dsh-gone': true, '@s/dsh-b': false },
    });
    // dsh-a: overridden on; @s/dsh-b: overridden off (its defaultEnabled is
    // true); dsh-c: not overridden, follows its defaultEnabled (false).
    expect(enabledNames([A, B, C], input)).toEqual(['dsh-a']);
    // An empty overrides object: nobody has touched anything, so B (whose
    // defaultEnabled is true) is still enabled — same as `{ from: 'default' }`.
    expect(enabledNames([A, B], readEnabledInput('{}'))).toEqual(['@s/dsh-b']);
  });

  it('a plugin the allowlist adds later, defaultEnabled true, turns on for a user who only touched another switch', () => {
    const input = readEnabledInput('{"dsh-a":true}');
    // B (@s/dsh-b, defaultEnabled: true) is not in the overrides at all.
    expect(enabledNames([A, B], input)).toEqual(['dsh-a', '@s/dsh-b']);
  });

  it('enables nothing when the value is malformed (fail closed)', () => {
    for (const raw of ['', 'dsh-a', '["dsh-a"]', '{"dsh-a":"yes"}', '{"Bad Name":true}']) {
      const input = readEnabledInput(raw);
      expect(input.from, raw).toBe('invalid');
      expect(enabledNames([A, B], input), raw).toEqual([]);
    }
  });
});

describe('packagedProfilePatches (decision 110, revising decision 108 rule 12 and decision 023 rule 3)', () => {
  it('composes the bundle layers, the (always empty) profile layer, and the overlays — home layer left out', () => {
    const profile = {
      layers: [{ patches: [{ id: 'a', name: 'x' }] }, { patches: [{ id: 'b', name: 'y' }] }],
      patches: [],
    };
    const overlays = [{ id: 'a', disabled: true }];
    expect(packagedProfilePatches(profile, overlays)).toEqual([
      { id: 'a', name: 'x' },
      { id: 'b', name: 'y' },
      { id: 'a', disabled: true },
    ]);
  });

  it('returns a deep copy: mutating the result does not touch the inputs', () => {
    const layerPatch = { id: 'a', config: { nested: 1 } };
    const profile = { layers: [{ patches: [layerPatch] }], patches: [] };
    const result = packagedProfilePatches(profile, []) as Array<{ config: { nested: number } }>;
    result[0].config.nested = 2;
    expect(layerPatch.config.nested).toBe(1);
  });
});

describe('judgeInstalled (decision 025 rule 5)', () => {
  it('passes the listed name and version declaring a bundle', () => {
    expect(
      judgeInstalled(A, { found: true, name: 'dsh-a', version: '1.0.0', bundle: true })
    ).toEqual(ok);
  });

  it('calls an absent or unreadable install missing, anything else there rejected', () => {
    expect(judgeInstalled(A, { found: false })).toMatchObject({ ok: false, state: 'missing' });
    expect(judgeInstalled(A, { found: 'unreadable', error: 'EACCES' })).toMatchObject({
      ok: false,
      state: 'missing',
      reason: 'unreadable package.json: EACCES',
    });
    expect(
      judgeInstalled(A, { found: true, name: 'dsh-a', version: '1.0.1', bundle: true })
    ).toEqual({
      ok: false,
      state: 'rejected',
      reason: 'installed as dsh-a@1.0.1, allowlisted 1.0.0',
    });
    expect(
      judgeInstalled(A, { found: true, name: 'dsh-a', version: '1.0.0', bundle: false })
    ).toEqual({
      ok: false,
      state: 'rejected',
      reason: 'declares no dsh.bundle.patch',
    });
  });
});

describe('planProfileBundles (decisions 058 rule 2, 108 rule 1)', () => {
  const plan = (overrides: Partial<Parameters<typeof planProfileBundles>[0]> = {}) =>
    planProfileBundles({
      listed: PRODUCT,
      product: PRODUCT,
      plugins: [A, B, C],
      enabled: [],
      installed: allInstalled(A, B, C),
      testBundles: [],
      ...overrides,
    });

  it('composes the product bundles alone on a fresh install with nothing enabled', () => {
    expect(plan()).toEqual({
      bundles: PRODUCT,
      plugins: [
        { name: 'dsh-a', version: '1.0.0', defaultEnabled: false, state: 'disabled' },
        { name: '@s/dsh-b', version: '1.0.0', defaultEnabled: true, state: 'disabled' },
        { name: 'dsh-c', version: '1.0.0', defaultEnabled: false, state: 'disabled' },
      ],
      dropped: [],
    });
  });

  it('adds the enabled plugins in allowlist order, whatever order Main or the profile had', () => {
    const result = plan({ listed: [...PRODUCT, 'dsh-c'], enabled: ['dsh-c', 'dsh-a'] });
    expect(result.bundles).toEqual([...PRODUCT, 'dsh-a', 'dsh-c']);
    expect(result.plugins.map((item) => [item.name, item.state])).toEqual([
      ['dsh-a', 'loaded'],
      ['@s/dsh-b', 'disabled'],
      ['dsh-c', 'loaded'],
    ]);
    expect(result.dropped).toEqual([]);
  });

  it('keeps a user’s plugins across restarts and is idempotent', () => {
    const once = plan({ listed: PRODUCT, enabled: ['@s/dsh-b'] });
    const twice = plan({ listed: once.bundles, enabled: ['@s/dsh-b'] });
    expect(twice).toEqual(once);
    expect(twice.bundles).toEqual([...PRODUCT, '@s/dsh-b']);
  });

  it('drops, and says why, whatever the profile lists off the allowlist or not enabled', () => {
    const result = plan({
      listed: [...PRODUCT, '@evil/bundle', 'dsh-a', PROBE],
      enabled: [],
    });
    expect(result.bundles).toEqual(PRODUCT);
    expect(result.dropped).toEqual([
      { name: '@evil/bundle', reason: 'not on the allowlist' },
      { name: 'dsh-a', reason: 'not enabled' },
      { name: PROBE, reason: 'not on the allowlist' },
    ]);
  });

  it('delists: an enabled plugin the allowlist no longer has is dropped and reported', () => {
    const result = plan({
      listed: [...PRODUCT, 'dsh-gone'],
      enabled: ['dsh-gone', 'dsh-new-gone'],
    });
    expect(result.bundles).toEqual(PRODUCT);
    expect(result.dropped).toEqual([
      { name: 'dsh-gone', reason: 'not on the allowlist' },
      { name: 'dsh-new-gone', reason: 'not on the allowlist' },
    ]);
  });

  it('renames: a former name enables the plugin that replaces it', () => {
    const result = plan({ listed: [...PRODUCT, 'dsh-c-old'], enabled: ['dsh-c-old'] });
    expect(result.bundles).toEqual([...PRODUCT, 'dsh-c']);
    expect(result.dropped).toEqual([{ name: 'dsh-c-old', reason: 'replaced by dsh-c' }]);
  });

  it('warns about an enabled plugin missing from the install directory and boots without it', () => {
    const installed = new Map<string, InstallVerdict>([
      ['dsh-a', { ok: false, state: 'missing', reason: 'not in the install directory' }],
      [
        'dsh-c',
        { ok: false, state: 'rejected', reason: 'installed as dsh-c@0.9.0, allowlisted 1.0.0' },
      ],
    ]);
    const result = plan({ listed: [...PRODUCT, 'dsh-a'], enabled: ['dsh-a', 'dsh-c'], installed });
    expect(result.bundles).toEqual(PRODUCT);
    expect(result.plugins.filter((item) => item.state !== 'disabled')).toEqual([
      {
        name: 'dsh-a',
        version: '1.0.0',
        defaultEnabled: false,
        state: 'missing',
        reason: 'not in the install directory',
      },
      {
        name: 'dsh-c',
        version: '1.0.0',
        defaultEnabled: false,
        state: 'rejected',
        reason: 'installed as dsh-c@0.9.0, allowlisted 1.0.0',
      },
    ]);
    expect(result.dropped).toEqual([
      { name: 'dsh-a', reason: 'missing: not in the install directory' },
    ]);
  });

  it('keeps a test bundle only when this start allows it and the profile lists it', () => {
    expect(plan({ listed: [...PRODUCT, PROBE], testBundles: [PROBE] }).bundles).toEqual([
      ...PRODUCT,
      PROBE,
    ]);
    expect(plan({ listed: PRODUCT, testBundles: [PROBE] }).bundles).toEqual(PRODUCT);
    expect(
      plan({ listed: [...PRODUCT, PROBE, 'dsh-a'], enabled: ['dsh-a'], testBundles: [PROBE] })
        .bundles
    ).toEqual([...PRODUCT, PROBE, 'dsh-a']);
  });
});

describe('auditPluginLayers (decision 059 rule 3)', () => {
  const productLayers = [
    {
      packageName: BASE,
      patches: [{ insert: [{ id: 'fs', name: '@deepseek-ai/dsh-fs' }] }],
      packageUrl: 'file:///host/node_modules/@deepseek-ai/dsh-base',
      realDir: `${DIR}/@deepseek-ai/dsh-base`,
    },
    {
      packageName: APP,
      patches: [
        { insert: [{ id: 'aiclient-permissions', name: '@aiclient/dsh-app/permissions' }] },
      ],
      packageUrl: 'file:///host/bundle',
      realDir: '/host/bundle',
    },
  ];
  const layerOf = (name: string, patches: unknown[], realDir = `${DIR}/${name}`) => ({
    packageName: name,
    patches,
    packageUrl: `file://${realDir}`,
    realDir,
  });
  const loaded = (item: HostPlugin) => ({
    name: item.name,
    version: item.version,
    defaultEnabled: item.defaultEnabled,
    state: 'loaded' as const,
  });
  const audit = (
    layers: ReturnType<typeof layerOf>[],
    skipped: Array<{ packageName: string; reason: string }> = []
  ) =>
    auditPluginLayers({
      layers: [...productLayers, ...layers],
      skipped,
      plugins: [A],
      statuses: [loaded(A)],
      expectedDirs: new Map([['dsh-a', `${DIR}/dsh-a`]]),
    });

  it('passes a plugin from its own directory that inserts its declared row', () => {
    expect(audit([layerOf('dsh-a', [{ insert: [{ id: 'a-row', name: 'dsh-a' }] }])])).toEqual({
      plugins: [loaded(A)],
      rejected: [],
    });
  });

  it('rejects a patch that inserts an undeclared row, and leaves the plugin out', () => {
    const result = audit([
      layerOf('dsh-a', [
        {
          insert: [
            { id: 'a-row', name: 'dsh-a' },
            { id: 'a-extra', name: 'dsh-a' },
          ],
        },
      ]),
    ]);
    expect(result.rejected).toEqual(['dsh-a']);
    expect(result.plugins[0]).toMatchObject({
      state: 'rejected',
      reason: 'bundle patch: patch 1.insert[1]: inserts undeclared row a-extra',
    });
  });

  it('rejects a patch that touches a product row', () => {
    const result = audit([
      layerOf('dsh-a', [
        { insert: [{ id: 'a-row', name: 'dsh-a' }] },
        { id: 'aiclient-permissions', disabled: true },
      ]),
    ]);
    expect(result.rejected).toEqual(['dsh-a']);
    expect(result.plugins[0].reason).toMatch(
      /changes row aiclient-permissions, which this plugin did not insert/
    );
  });

  it('rejects a layer resolved anywhere but its own directory under the host', () => {
    const result = audit([
      layerOf(
        'dsh-a',
        [{ insert: [{ id: 'a-row', name: 'dsh-a' }] }],
        '/home/u/.dsh/profiles/aiclient/node_modules/dsh-a'
      ),
    ]);
    expect(result.rejected).toEqual(['dsh-a']);
    expect(result.plugins[0].reason).toMatch(/not the install directory/);
  });

  it('reports a plugin DSH skipped (an unmet peer) as rejected, with DSH’s reason', () => {
    const result = audit([], [{ packageName: 'dsh-a', reason: 'Error: incompatible with dsh' }]);
    expect(result.rejected).toEqual([]);
    expect(result.plugins[0]).toMatchObject({
      state: 'rejected',
      reason: 'DSH skipped it: Error: incompatible with dsh',
    });
  });

  it('leaves final states alone', () => {
    const disabled = { ...loaded(A), state: 'disabled' as const };
    expect(
      auditPluginLayers({
        layers: productLayers,
        skipped: [],
        plugins: [A],
        statuses: [disabled],
        expectedDirs: new Map(),
      }).plugins
    ).toEqual([disabled]);
  });
});

describe('withInactiveRows and pluginReport (decision 108 rule 8)', () => {
  it('marks a loaded plugin whose declared row did not start', () => {
    const statuses = [
      { name: 'dsh-a', version: '1.0.0', defaultEnabled: false, state: 'loaded' as const },
      { name: '@s/dsh-b', version: '1.0.0', defaultEnabled: true, state: 'disabled' as const },
    ];
    expect(withInactiveRows(statuses, [A, B], new Set(['a-row', 'b-row']))).toEqual([
      { ...statuses[0], inactiveRows: ['a-row'] },
      statuses[1],
    ]);
    expect(withInactiveRows(statuses, [A, B], new Set())).toEqual(statuses);
    expect(pluginReport({ from: 'default' }, statuses, [])).toEqual({
      enabledFrom: 'default',
      plugins: statuses,
      dropped: [],
    });
  });
});
