import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decidePermissionPlugin,
  describePackageSource,
  lookupBundledPermissionPlugin,
  PERMISSION_PLUGIN_PACKAGE,
  packageEntryLoadsExtensions,
  permissionPluginConfiguredByUser,
  resolveBundledPermissionPlugin,
  verifyPermissionExtensionLoaded,
} from '../permissionPlugin.ts';

/**
 * T08-a — deciding whether to load the bundled permission plugin.
 *
 * The asymmetry these tests encode: skipping our copy when the user's config
 * does NOT actually load one is fail-open (no gate at all); injecting ours when
 * they already have one is a double prompt. So "we could not confirm" must land
 * on inject, and every disabled-by-config shape has to be recognised as
 * disabled rather than as "the user has this covered".
 */

const temporaries: string[] = [];

function fixture(manifest: unknown | null): string {
  const base = mkdtempSync(join(tmpdir(), 'perm-plugin-'));
  temporaries.push(base);
  const root = join(base, 'node_modules', '@gotgenes', 'pi-permission-system');
  mkdirSync(root, { recursive: true });
  if (manifest !== null) {
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  }
  return base;
}

/** A standalone package directory, the shape a user's local source points at. */
function localPackage(dirName: string, manifest: unknown | null): string {
  const base = mkdtempSync(join(tmpdir(), 'perm-local-'));
  temporaries.push(base);
  const root = join(base, dirName);
  mkdirSync(root, { recursive: true });
  if (manifest !== null) writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  return root;
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('lookupBundledPermissionPlugin', () => {
  it('returns the package directory when the bundle is intact', () => {
    const base = fixture({ name: PERMISSION_PLUGIN_PACKAGE, version: '27.0.1' });
    expect(resolveBundledPermissionPlugin(base)).toBe(
      join(base, 'node_modules', '@gotgenes', 'pi-permission-system')
    );
    expect(lookupBundledPermissionPlugin(base).problem).toBeUndefined();
  });

  /**
   * The packaging filter keeps `.ts` for this one package, so "the directory is
   * there but empty" is a real build outcome — and it must not be reported with
   * the same word as "the directory is not there", or the person debugging it
   * goes looking for a file that exists.
   */
  it('separates a half-copied tree from an absent one', () => {
    const half = lookupBundledPermissionPlugin(fixture(null));
    expect(half.problem).toBe('half_copied');
    expect(half.path).toBeUndefined();

    const absent = lookupBundledPermissionPlugin(join(tmpdir(), 'definitely-not-here'));
    expect(absent.problem).toBe('not_present');
  });

  it('refuses a manifest that is unreadable or names another package', () => {
    const base = mkdtempSync(join(tmpdir(), 'perm-plugin-'));
    temporaries.push(base);
    const root = join(base, 'node_modules', '@gotgenes', 'pi-permission-system');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{ not json');
    expect(lookupBundledPermissionPlugin(base).problem).toBe('half_copied');

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'something-else' }));
    const wrong = lookupBundledPermissionPlugin(base);
    expect(wrong.problem).toBe('wrong_package');
    expect(wrong.detail).toContain('something-else');
  });
});

describe('describePackageSource', () => {
  it('parses the three source kinds pi itself distinguishes', () => {
    expect(describePackageSource('npm:@gotgenes/pi-permission-system@27.0.1')).toEqual({
      kind: 'npm',
      name: '@gotgenes/pi-permission-system',
    });
    expect(describePackageSource('https://github.com/gotgenes/pi-permission-system.git')).toEqual({
      kind: 'git',
      name: 'pi-permission-system',
    });
    expect(describePackageSource('git@github.com:gotgenes/pi-permission-system.git')).toEqual({
      kind: 'git',
      name: 'pi-permission-system',
    });
    expect(describePackageSource('~/pi-extensions/pi-permission-system')).toMatchObject({
      kind: 'local',
      name: 'pi-permission-system',
    });
  });

  /** `npm:` wins over the local fallback; getting the order wrong reads specs as directories. */
  it('never reads an npm spec as a path', () => {
    expect(describePackageSource('npm:pi-cc-extensions').kind).toBe('npm');
  });
});

describe('permissionPluginConfiguredByUser', () => {
  it('matches a bare and a version-pinned npm spec', () => {
    expect(permissionPluginConfiguredByUser([`npm:${PERMISSION_PLUGIN_PACKAGE}`])).toBe(true);
    expect(permissionPluginConfiguredByUser([`npm:${PERMISSION_PLUGIN_PACKAGE}@27.0.1`])).toBe(
      true
    );
    expect(permissionPluginConfiguredByUser([`npm:${PERMISSION_PLUGIN_PACKAGE}@^27`])).toBe(true);
  });

  /**
   * A git URL carries no npm scope, so the repo name is the whole of the
   * evidence. Missing this one was a false NEGATIVE: our copy got injected
   * alongside the user's, and every tool call prompted twice.
   */
  it('matches a git source', () => {
    for (const source of [
      'https://github.com/gotgenes/pi-permission-system.git',
      'https://github.com/gotgenes/pi-permission-system',
      'git@github.com:gotgenes/pi-permission-system.git',
      'git:https://github.com/gotgenes/pi-permission-system.git#v27',
    ]) {
      expect(permissionPluginConfiguredByUser([source])).toBe(true);
    }
  });

  it('matches a local directory by its own package.json name', () => {
    const forked = localPackage('my-fork', { name: PERMISSION_PLUGIN_PACKAGE });
    expect(permissionPluginConfiguredByUser([forked], { resolveLocalPath: (path) => path })).toBe(
      true
    );

    const impostor = localPackage('pi-permission-system', { name: '@someone/other-thing' });
    expect(permissionPluginConfiguredByUser([impostor], { resolveLocalPath: (path) => path })).toBe(
      false
    );
  });

  /** No manifest to read (not installed yet): fall back to the directory name. */
  it('matches an unresolvable local path by its directory name', () => {
    expect(permissionPluginConfiguredByUser(['~/pi-extensions/pi-permission-system'])).toBe(true);
    expect(permissionPluginConfiguredByUser(['/opt/pi-permission-system/'])).toBe(true);
    expect(permissionPluginConfiguredByUser(['file:../pi-permission-system'])).toBe(true);
  });

  it('ignores the other packages a real settings.json carries', () => {
    expect(
      permissionPluginConfiguredByUser([
        'npm:pi-cc-extensions',
        'npm:@tintinweb/pi-subagents',
        'npm:pi-observational-memory',
      ])
    ).toBe(false);
  });

  /**
   * A scoped name contains an '@' of its own, so a naive first-'@' split would
   * read the scope as the version and match nothing.
   */
  it('does not confuse the scope marker with a version separator', () => {
    expect(permissionPluginConfiguredByUser(['npm:@gotgenes/something-else@1.0.0'])).toBe(false);
  });

  it('tolerates a missing or malformed packages list', () => {
    for (const value of [undefined, null, 'npm:x', 42, {}]) {
      expect(permissionPluginConfiguredByUser(value)).toBe(false);
    }
    expect(permissionPluginConfiguredByUser([null, 7, {}, { source: 5 }])).toBe(false);
  });

  /**
   * The fail-open shapes. Each of these names the package while telling pi not
   * to load its extensions; reading any of them as "the user has a permission
   * system" leaves the session with no gate at all.
   */
  it('refuses entries that name the package but disable it', () => {
    const source = `npm:${PERMISSION_PLUGIN_PACKAGE}@27.0.1`;
    expect(permissionPluginConfiguredByUser([{ source, autoload: false, extensions: [] }])).toBe(
      false
    );
    expect(permissionPluginConfiguredByUser([{ source, autoload: false }])).toBe(false);
    expect(permissionPluginConfiguredByUser([{ source, extensions: [] }])).toBe(false);
    expect(permissionPluginConfiguredByUser([{ source, extensions: ['!**/*'] }])).toBe(false);
  });

  it('accepts an entry whose filter still enables something', () => {
    const source = `npm:${PERMISSION_PLUGIN_PACKAGE}`;
    expect(permissionPluginConfiguredByUser([{ source }])).toBe(true);
    expect(permissionPluginConfiguredByUser([{ source, extensions: ['src/index.ts'] }])).toBe(true);
    expect(
      permissionPluginConfiguredByUser([{ source, autoload: false, extensions: ['src/index.ts'] }])
    ).toBe(true);
  });
});

describe('packageEntryLoadsExtensions', () => {
  it('mirrors pi collectPackageResources for every filter shape', () => {
    expect(packageEntryLoadsExtensions('npm:x')).toBe(true);
    expect(packageEntryLoadsExtensions({ source: 'npm:x' })).toBe(true);
    // `extensions: []` — pi's own comment: "Empty array explicitly disables all
    // resources of this type".
    expect(packageEntryLoadsExtensions({ source: 'npm:x', extensions: [] })).toBe(false);
    // `autoload: false` with no patterns — applyPackageDeltaFilter returns early.
    expect(packageEntryLoadsExtensions({ source: 'npm:x', autoload: false })).toBe(false);
    expect(
      packageEntryLoadsExtensions({ source: 'npm:x', autoload: false, extensions: ['a'] })
    ).toBe(true);
  });
});

describe('decidePermissionPlugin', () => {
  it('injects the bundled copy when the user configured nothing', () => {
    const base = fixture({ name: PERMISSION_PLUGIN_PACKAGE });
    const decision = decidePermissionPlugin(['npm:pi-cc-extensions'], base);
    expect(decision.reason).toBe('bundled');
    expect(decision.gated).toBe(true);
    expect(decision.additionalExtensionPaths).toHaveLength(1);
  });

  /** The double-prompt guard: their copy wins, ours stays out. */
  it('injects nothing when the user already loads the package', () => {
    const base = fixture({ name: PERMISSION_PLUGIN_PACKAGE });
    const decision = decidePermissionPlugin([`npm:${PERMISSION_PLUGIN_PACKAGE}`], base);
    expect(decision).toEqual({
      additionalExtensionPaths: [],
      reason: 'user_configured',
      gated: true,
    });
  });

  /** Disabled config + intact bundle = ours goes in. This is the fail-open fix. */
  it('injects the bundle when the user entry is switched off', () => {
    const base = fixture({ name: PERMISSION_PLUGIN_PACKAGE });
    for (const entry of [
      { source: `npm:${PERMISSION_PLUGIN_PACKAGE}@27.0.1`, autoload: false, extensions: [] },
      { source: `npm:${PERMISSION_PLUGIN_PACKAGE}`, extensions: [] },
    ]) {
      const decision = decidePermissionPlugin([entry], base);
      expect(decision.reason).toBe('bundled');
      expect(decision.gated).toBe(true);
    }
  });

  /**
   * Reported, not thrown — but `gated: false`, which the caller turns into a
   * refusal to start the session. This function has no channel to tell the user
   * anything; it returns the finding plus the words to diagnose it.
   */
  it('reports an ungated outcome with a diagnosable detail', () => {
    const decision = decidePermissionPlugin([], join(tmpdir(), 'definitely-not-here'));
    expect(decision.reason).toBe('missing');
    expect(decision.gated).toBe(false);
    expect(decision.detail).toContain('no bundled plugin directory');

    const half = decidePermissionPlugin([], fixture(null));
    expect(half.gated).toBe(false);
    expect(half.detail).toContain('package.json');
  });

  /** The user's own config wins even when our bundle is broken. */
  it('prefers the user configuration over an absent bundle', () => {
    const decision = decidePermissionPlugin(
      [`npm:${PERMISSION_PLUGIN_PACKAGE}`],
      join(tmpdir(), 'definitely-not-here')
    );
    expect(decision.reason).toBe('user_configured');
    expect(decision.gated).toBe(true);
  });
});

describe('verifyPermissionExtensionLoaded', () => {
  const root = '/app/node_modules/@gotgenes/pi-permission-system';

  it('accepts a list containing the injected extension', () => {
    const result = verifyPermissionExtensionLoaded(
      { extensions: [{ path: `${root}/src/index.ts`, resolvedPath: `${root}/src/index.ts` }] },
      [root]
    );
    expect(result.ok).toBe(true);
  });

  /**
   * pi COLLECTS an import failure into `errors` and keeps going, so this is the
   * only place a plugin that threw on load is distinguishable from one that is
   * quietly allowing everything.
   */
  it('rejects a list where the permission extension failed to load', () => {
    const result = verifyPermissionExtensionLoaded(
      {
        extensions: [{ path: '/other/ext.ts' }],
        errors: [{ path: `${root}/src/index.ts`, error: 'SyntaxError: boom' }],
      },
      [root]
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('SyntaxError: boom');
  });

  it('rejects a list with no permission extension in it at all', () => {
    const result = verifyPermissionExtensionLoaded({ extensions: [{ path: '/other/ext.ts' }] }, [
      root,
    ]);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no permission extension');
  });

  /** A user-configured copy lands somewhere else entirely; match on the name. */
  it('recognises a user-installed copy outside the injected root', () => {
    const result = verifyPermissionExtensionLoaded(
      { extensions: [{ resolvedPath: '/home/u/.pi/packages/pi-permission-system/src/index.ts' }] },
      []
    );
    expect(result.ok).toBe(true);
  });

  /** An SDK that cannot answer must not take every session down with it. */
  it('treats an unavailable extension list as unverified, not as failure', () => {
    const result = verifyPermissionExtensionLoaded(undefined, [root]);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('not verified');
  });
});
