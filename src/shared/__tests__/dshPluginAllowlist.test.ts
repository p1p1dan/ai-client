import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type AllowlistEntry,
  auditBundlePatches,
  checkAllowlistKeys,
  type Lockfile,
  lockClosure,
  type PluginAllowlist,
  parseAllowlist,
  patchRowIds,
  resolveLockPath,
  splitPackageKey,
  targetProfileBundles,
} from '../dshPluginAllowlist';

/**
 * dsh-rebase P1-10a — the plugin allowlist rules (decisions 058 to 060):
 * schema, the double key against package.json and the lockfile, the
 * registered closure, and the bundle patch audit.
 */

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const integrity = (seed: string) => `sha512-${seed.repeat(86).slice(0, 86)}==`;
const PIN = '0.1.7-rc.2';

function entry(overrides: Partial<AllowlistEntry> = {}): AllowlistEntry {
  return {
    name: 'dsh-fixture-plugin',
    version: '1.0.0',
    integrity: integrity('P'),
    kind: 'internal',
    defaultEnabled: false,
    rows: ['dsh-fixture-plugin'],
    tools: { '*': 'ask', fixture_read: { class: 'read', path: 'path' } },
    review: {
      record: 'reviews/dsh-fixture-plugin@1.0.0.md',
      date: '2026-09-27',
      reviewer: 'fixture',
      verdict: 'conditional',
    },
    ...overrides,
  };
}

const allowlistOf = (...plugins: AllowlistEntry[]): PluginAllowlist => ({ schema: 1, plugins });

describe('parseAllowlist', () => {
  it('accepts the committed allowlist, which stays empty until the pilot is approved (decision 060)', () => {
    const raw = JSON.parse(
      readFileSync(path.join(repoRoot, 'src', 'dsh-host', 'plugins', 'allowlist.json'), 'utf8')
    );
    const { allowlist, failures } = parseAllowlist(raw);
    expect(failures).toEqual([]);
    expect(allowlist.plugins).toEqual([]);
  });

  it('accepts a complete entry', () => {
    const good = entry({
      replaces: ['dsh-old-fixture'],
      dependencies: { 'left-pad@1.3.0': integrity('L'), '@s/x@2.0.0-rc.1': integrity('X') },
      installScripts: { 'left-pad': 'runs only a banner; the smoke passes without it' },
      limits: { maxBytes: 6_000_000, maxFiles: 600 },
    });
    const { allowlist, failures } = parseAllowlist({ schema: 1, plugins: [good] });
    expect(failures).toEqual([]);
    expect(allowlist.plugins).toEqual([good]);
  });

  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an unknown key', { signature: 'x' }, /unknown keys: signature/],
    ['a version range', { version: '^1.0.0' }, /version must be an exact version/],
    ['a sha1 integrity', { integrity: 'sha1-abc' }, /integrity must be/],
    ['an official kind off the DSH scope', { kind: 'official' }, /official" is for @deepseek-ai/],
    ['an internal @deepseek-ai package', { name: '@deepseek-ai/dsh-x' }, /are kind "official"/],
    ['a missing defaultEnabled', { defaultEnabled: undefined }, /defaultEnabled must be/],
    ['no rows', { rows: [] }, /rows must list/],
    ['a product row id', { rows: ['aiclient-bridge'] }, /uses the product prefix aiclient-/],
    ['a wildcard that is not ask', { tools: { '*': 'allow' } }, /must be "ask".*decision 047/],
    ['a tool allowed outright', { tools: { x: 'allow' } }, /no plugin tool is allowed outright/],
    [
      'an exec class',
      { tools: { x: { class: 'exec', path: 'p' } } },
      /class must be "read" or "write"/,
    ],
    [
      'a write without its path',
      { tools: { x: { class: 'write' } } },
      /path must name the argument/,
    ],
    ['no review', { review: undefined }, /review must be an object/],
    [
      'a review record outside plugins/',
      { review: { record: '../x.md', date: '2026-09-27', reviewer: 'r', verdict: 'approved' } },
      /review\.record must be/,
    ],
    [
      'a rejected verdict',
      {
        review: { record: 'reviews/x.md', date: '2026-09-27', reviewer: 'r', verdict: 'rejected' },
      },
      /verdict must be/,
    ],
    ['replacing itself', { replaces: ['dsh-fixture-plugin'] }, /replaces names the plugin itself/],
    [
      'a closure key without a version',
      { dependencies: { 'left-pad': integrity('L') } },
      /not name@exact-version/,
    ],
    ['zero limits', { limits: { maxBytes: 0, maxFiles: 10 } }, /limits must be/],
  ];
  for (const [label, overrides, pattern] of bad) {
    it(`rejects ${label}`, () => {
      const { allowlist, failures } = parseAllowlist({
        schema: 1,
        plugins: [{ ...entry(), ...overrides }],
      });
      expect(failures.join('\n')).toMatch(pattern);
      if (label !== 'an unknown key') expect(allowlist.plugins).toEqual([]);
    });
  }

  it('rejects duplicates, shared rows, a replaced name still listed and a wrong schema', () => {
    const other = entry({
      name: 'dsh-other',
      rows: ['dsh-fixture-plugin'],
      replaces: ['dsh-fixture-plugin'],
    });
    const { failures } = parseAllowlist({ schema: 2, plugins: [entry(), entry(), other] });
    const text = failures.join('\n');
    expect(text).toMatch(/schema must be 1/);
    expect(text).toMatch(/dsh-fixture-plugin is listed twice/);
    expect(text).toMatch(/row dsh-fixture-plugin is declared by dsh-fixture-plugin and dsh-other/);
    expect(text).toMatch(/dsh-other replaces dsh-fixture-plugin, which is still listed/);
    expect(parseAllowlist({ schema: 1 }).failures).toEqual(['allowlist.plugins must be an array']);
    expect(parseAllowlist([]).failures).toEqual(['allowlist must be a JSON object']);
  });

  it('splits scoped and prerelease closure keys', () => {
    expect(splitPackageKey('@s/x@2.0.0-rc.1')).toEqual(['@s/x', '2.0.0-rc.1']);
    expect(splitPackageKey('left-pad@1.3.0')).toEqual(['left-pad', '1.3.0']);
    expect(splitPackageKey('@s/x')).toBeNull();
  });
});

/** A host with one base package, one allowlisted plugin and the closure it brings. */
function fixtureLock(): Lockfile {
  const registry = (name: string, version: string) =>
    `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
  return {
    packages: {
      '': {
        dependencies: {
          '@aiclient/dsh-app': 'file:./bundle',
          'host-a': '1.0.0',
          'dsh-fixture-plugin': '1.0.0',
        },
      },
      bundle: { version: '0.1.0', peerDependencies: { '@deepseek-ai/dsh-llm': PIN } },
      'node_modules/@aiclient/dsh-app': { resolved: 'bundle', link: true },
      'node_modules/host-a': {
        version: '1.0.0',
        resolved: registry('host-a', '1.0.0'),
        integrity: integrity('A'),
        dependencies: { 'shared-dep': '^2.0.0' },
      },
      'node_modules/@deepseek-ai/dsh-llm': { version: PIN, integrity: integrity('D') },
      'node_modules/shared-dep': { version: '2.0.0', integrity: integrity('S') },
      'node_modules/dsh-fixture-plugin': {
        version: '1.0.0',
        resolved: registry('dsh-fixture-plugin', '1.0.0'),
        integrity: integrity('P'),
        dependencies: { 'shared-dep': '^2.0.0', 'own-dep': '^1.0.0', nested: '1.0.0' },
        peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.0-rc.6' },
      },
      'node_modules/dsh-fixture-plugin/node_modules/nested': {
        version: '1.0.0',
        integrity: integrity('N'),
      },
      'node_modules/own-dep': {
        version: '1.2.0',
        integrity: integrity('O'),
        dependencies: { 'shared-dep': '^3.0.0' },
      },
      'node_modules/own-dep/node_modules/shared-dep': {
        version: '3.1.0',
        integrity: integrity('T'),
      },
    },
  };
}

const CLOSURE = {
  'nested@1.0.0': integrity('N'),
  'own-dep@1.2.0': integrity('O'),
  'shared-dep@3.1.0': integrity('T'),
};
const HOST = ['@aiclient/dsh-app', 'host-a'];

function keys(
  plugin: AllowlistEntry = entry({ dependencies: CLOSURE }),
  change: (input: { manifest: Record<string, any>; lock: Lockfile }) => void = () => {}
) {
  const lock = fixtureLock();
  const manifest: Record<string, any> = {
    dependencies: {
      '@aiclient/dsh-app': 'file:./bundle',
      'host-a': '1.0.0',
      'dsh-fixture-plugin': '1.0.0',
    },
  };
  change({ manifest, lock });
  return checkAllowlistKeys({
    allowlist: allowlistOf(plugin),
    manifest,
    lock,
    hostDependencies: HOST,
    dshPin: PIN,
  });
}

describe('lockfile resolution', () => {
  it('prefers the nearest node_modules and walks up to the root', () => {
    const packages = fixtureLock().packages ?? {};
    expect(resolveLockPath(packages, 'node_modules/own-dep', 'shared-dep')).toBe(
      'node_modules/own-dep/node_modules/shared-dep'
    );
    expect(resolveLockPath(packages, 'node_modules/dsh-fixture-plugin', 'shared-dep')).toBe(
      'node_modules/shared-dep'
    );
    expect(resolveLockPath(packages, 'bundle', '@deepseek-ai/dsh-llm')).toBe(
      'node_modules/@deepseek-ai/dsh-llm'
    );
    expect(resolveLockPath(packages, '', 'missing')).toBeUndefined();
  });

  it('follows file: links to their targets', () => {
    expect([...lockClosure(fixtureLock(), ['node_modules/@aiclient/dsh-app'])].sort()).toEqual([
      'bundle',
      'node_modules/@aiclient/dsh-app',
      'node_modules/@deepseek-ai/dsh-llm',
    ]);
  });
});

describe('checkAllowlistKeys (the double key)', () => {
  it('passes a plugin whose closure beyond the host tree is registered exactly', () => {
    const { failures, closures } = keys();
    expect(failures).toEqual([]);
    // Nested under the plugin, hoisted beside it, nested under a hoisted one:
    // none is skipped, and the host's own shared-dep@2 is not the plugin's to register.
    expect(closures['dsh-fixture-plugin']).toEqual([
      'node_modules/dsh-fixture-plugin/node_modules/nested',
      'node_modules/own-dep',
      'node_modules/own-dep/node_modules/shared-dep',
    ]);
  });

  it('refuses an unregistered, a stale and a mismatched closure entry', () => {
    const { 'own-dep@1.2.0': _, ...partial } = CLOSURE;
    const text = keys(
      entry({
        dependencies: { ...partial, 'ghost@1.0.0': integrity('G'), 'nested@1.0.0': integrity('Z') },
      })
    ).failures.join('\n');
    expect(text).toMatch(
      /brings own-dep@1\.2\.0 \(node_modules\/own-dep\), which its dependencies do not register/
    );
    expect(text).toMatch(/registers ghost@1\.0\.0, which it does not bring/);
    expect(text).toMatch(/nested@1\.0\.0 integrity differs from the lockfile/);
  });

  it('refuses a plugin off by version or integrity, or not from a registry', () => {
    expect(keys(entry({ dependencies: CLOSURE, integrity: integrity('Q') })).failures).toEqual([
      'dsh-fixture-plugin@1.0.0: lockfile integrity differs from the allowlist',
    ]);
    const text = keys(undefined, ({ manifest, lock }) => {
      manifest.dependencies['dsh-fixture-plugin'] = '1.0.1';
      const node = lock.packages?.['node_modules/dsh-fixture-plugin'];
      if (node) node.resolved = 'file:../dsh-fixture-plugin-1.0.0.tgz';
    }).failures.join('\n');
    expect(text).toMatch(/package\.json has dsh-fixture-plugin@1\.0\.1, allowlist 1\.0\.0/);
    expect(text).toMatch(/must come from a registry tarball/);
  });

  it('refuses a plugin missing from the lockfile or its root', () => {
    const text = keys(undefined, ({ lock }) => {
      const packages = lock.packages ?? {};
      delete packages['node_modules/dsh-fixture-plugin'];
      delete packages['']?.dependencies?.['dsh-fixture-plugin'];
    }).failures.join('\n');
    expect(text).toMatch(/lockfile root has dsh-fixture-plugin@\(missing\)/);
    expect(text).toMatch(/lockfile has no node_modules\/dsh-fixture-plugin/);
  });

  it('refuses a host dependency that is neither a host package nor allowlisted', () => {
    const { failures } = checkAllowlistKeys({
      allowlist: allowlistOf(),
      manifest: fixtureLock().packages?.[''] ?? {},
      lock: fixtureLock(),
      hostDependencies: HOST,
      dshPin: PIN,
    });
    expect(failures).toEqual([
      'dsh-fixture-plugin is a host dependency but neither a host package nor allowlisted',
    ]);
  });

  it('refuses allowlisting a host package and an official plugin off the DSH pin', () => {
    expect(keys(entry({ name: 'host-a' })).failures).toContain(
      'host-a is a host package and cannot be allowlisted'
    );
    const official = entry({
      name: '@deepseek-ai/dsh-llm',
      kind: 'official',
      version: '0.1.6',
    });
    expect(keys(official).failures).toContain(
      '@deepseek-ai/dsh-llm is official but 0.1.6 is not the DSH pin 0.1.7-rc.2'
    );
  });

  it('refuses an install script in the closure until it is acknowledged', () => {
    const withScript = ({ lock }: { lock: Lockfile }) => {
      const node = lock.packages?.['node_modules/own-dep'];
      if (node) node.hasInstallScript = true;
    };
    expect(keys(undefined, withScript).failures.join('\n')).toMatch(
      /own-dep \(dsh-fixture-plugin\) has an install script/
    );
    const acknowledged = entry({
      dependencies: CLOSURE,
      installScripts: { 'own-dep': 'builds an optional speedup; the smoke passes without it' },
    });
    expect(keys(acknowledged, withScript).failures).toEqual([]);
  });

  it('allows overrides that pin a plugin’s @deepseek-ai peers to the host’s versions only (E2)', () => {
    const withOverrides =
      (overrides: unknown) =>
      ({ manifest }: { manifest: Record<string, any> }) => {
        manifest.overrides = overrides;
      };
    expect(
      keys(undefined, withOverrides({ 'dsh-fixture-plugin': { '@deepseek-ai/dsh-llm': PIN } }))
        .failures
    ).toEqual([]);
    const text = keys(
      undefined,
      withOverrides({
        'host-a': { 'shared-dep': '2.0.0' },
        'dsh-fixture-plugin': { 'shared-dep': '2.0.0', '@deepseek-ai/dsh-llm': '0.1.5' },
      })
    ).failures.join('\n');
    expect(text).toMatch(/overrides host-a, which is not an allowlisted plugin/);
    expect(text).toMatch(/may only pin @deepseek-ai\/\* peers: shared-dep/);
    expect(text).toMatch(/dsh-llm is "0\.1\.5", not the host's 0\.1\.7-rc\.2/);
  });
});

describe('auditBundlePatches', () => {
  const EXISTING = new Set(['llm', 'session-log-deepseek', 'aiclient-permissions', 'tools']);
  const audit = (patches: unknown[], rows = ['dsh-fixture-plugin'], packageUrl?: string) =>
    auditBundlePatches({
      patches,
      packageName: 'dsh-fixture-plugin',
      packageUrl,
      rows,
      existingIds: EXISTING,
    });

  it('passes inserting its declared row from its own package, and lists !!js expressions', () => {
    const result = audit([
      {
        insert: [
          {
            id: 'dsh-fixture-plugin',
            name: 'dsh-fixture-plugin/tools',
            disabled: { __jsExpr: "!ctx.get('profileContext')" },
          },
        ],
      },
      { id: 'dsh-fixture-plugin', config: { limit: 3 } },
    ]);
    expect(result.failures).toEqual([]);
    expect(result.inserted).toEqual(['dsh-fixture-plugin']);
    expect(result.expressions).toEqual(["!ctx.get('profileContext')"]);
  });

  it('accepts a ./ name DSH anchored inside the package, not one outside it', () => {
    const url = 'file:///opt/app/resources/dsh-host/node_modules/dsh-fixture-plugin';
    expect(
      audit(
        [{ insert: [{ id: 'dsh-fixture-plugin', name: `${url}/lib/index.js` }] }],
        undefined,
        url
      ).failures
    ).toEqual([]);
    expect(
      audit(
        [
          {
            insert: [
              { id: 'dsh-fixture-plugin', name: 'file:///opt/app/resources/dsh-host/host.js' },
            ],
          },
        ],
        undefined,
        url
      ).failures
    ).toEqual([
      'dsh-fixture-plugin: loads file:///opt/app/resources/dsh-host/host.js, which is not a module of dsh-fixture-plugin',
    ]);
  });

  it('refuses changing a row it did not insert: re-enabling a privacy row, disabling the gate', () => {
    const own = { insert: [{ id: 'dsh-fixture-plugin', name: 'dsh-fixture-plugin' }] };
    expect(audit([own, { id: 'session-log-deepseek', disabled: false }]).failures).toEqual([
      'patch 2: changes row session-log-deepseek, which this plugin did not insert',
    ]);
    expect(audit([own, { id: 'aiclient-permissions', disabled: true }]).failures).toEqual([
      'patch 2: changes row aiclient-permissions, which this plugin did not insert',
    ]);
    // An override before its own insert targets whatever row already has that id.
    expect(audit([{ id: 'dsh-fixture-plugin', disabled: true }, own]).failures).toEqual([
      'patch 1: changes row dsh-fixture-plugin, which this plugin did not insert',
    ]);
  });

  it('refuses undeclared, colliding and foreign rows', () => {
    const text = audit(
      [
        {
          insert: [
            { id: 'dsh-fixture-plugin', name: 'dsh-fixture-plugin' },
            { id: 'extra-row', name: 'dsh-fixture-plugin/extra' },
            { id: 'llm', name: 'dsh-fixture-plugin/llm' },
            { id: 'plugin-manager-2', name: '@deepseek-ai/dsh-plugin-manager' },
            // A package whose name merely starts with ours is not ours.
            { id: 'lookalike', name: 'dsh-fixture-plugin-evil' },
          ],
        },
      ],
      ['dsh-fixture-plugin', 'llm', 'plugin-manager-2', 'lookalike']
    ).failures.join('\n');
    expect(text).toMatch(/inserts undeclared row extra-row/);
    expect(text).toMatch(/inserts llm, a row the product already has/);
    expect(text).toMatch(
      /plugin-manager-2: loads @deepseek-ai\/dsh-plugin-manager, which is not a module/
    );
    expect(text).toMatch(/lookalike: loads dsh-fixture-plugin-evil, which is not a module/);
  });

  it('audits group children instead of skipping the group', () => {
    const group = (children: unknown[]) => [
      { insert: [{ id: 'fixture-group', group: true, config: children }] },
    ];
    expect(
      audit(group([{ id: 'dsh-fixture-plugin', name: 'dsh-fixture-plugin' }]), [
        'fixture-group',
        'dsh-fixture-plugin',
      ]).failures
    ).toEqual([]);
    expect(
      audit(group([{ id: 'hidden', name: '@deepseek-ai/dsh-tool-shell' }]), ['fixture-group'])
        .failures
    ).toEqual([
      'fixture-group.config[0]: inserts undeclared row hidden',
      'hidden: loads @deepseek-ai/dsh-tool-shell, which is not a module of dsh-fixture-plugin',
    ]);
  });

  it('refuses expression ids and names, mixed insert patches, and declared rows never inserted', () => {
    const text = audit(
      [
        { insert: [{ id: { __jsExpr: "'x'" }, name: 'dsh-fixture-plugin' }] },
        { insert: [{ id: 'dsh-fixture-plugin', name: { __jsExpr: "'dsh-fixture-plugin'" } }] },
        { id: 'tools', insert: [], disabled: true },
      ],
      ['dsh-fixture-plugin', 'never-inserted']
    ).failures.join('\n');
    expect(text).toMatch(/inserted row has no literal id/);
    expect(text).toMatch(/module name must be literal/);
    expect(text).toMatch(/insert patch also sets disabled/);
    expect(text).toMatch(/declares row never-inserted, which its patch never inserts/);
  });

  it('collects every row id a patch list inserts or targets', () => {
    expect(
      [
        ...patchRowIds([
          { insert: [{ id: 'a' }, { id: 'g', group: true, config: [{ id: 'b' }] }] },
          { id: 'c', disabled: true },
        ]),
      ].sort()
    ).toEqual(['a', 'b', 'c', 'g']);
  });
});

describe('targetProfileBundles', () => {
  const PRODUCT = ['@deepseek-ai/dsh-base', '@aiclient/dsh-app'];
  const allowlist = allowlistOf(
    entry({ name: 'dsh-b', rows: ['b'] }),
    entry({ name: 'dsh-a', rows: ['a'], replaces: ['dsh-a-old'] })
  );

  it('keeps the product bundles first and the enabled plugins in allowlist order', () => {
    expect(targetProfileBundles(PRODUCT, ['dsh-a', 'dsh-b'], allowlist)).toEqual([
      ...PRODUCT,
      'dsh-b',
      'dsh-a',
    ]);
  });

  it('drops names off the allowlist, maps a replaced name, and is idempotent', () => {
    const once = targetProfileBundles(
      PRODUCT,
      ['dsh-a-old', 'dsh-gone', '@aiclient/dsh-app'],
      allowlist
    );
    expect(once).toEqual([...PRODUCT, 'dsh-a']);
    expect(targetProfileBundles(PRODUCT, once, allowlist)).toEqual(once);
    expect(targetProfileBundles(PRODUCT, [], allowlistOf())).toEqual(PRODUCT);
  });
});
