import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describePackageSource,
  PERMISSION_PLUGIN_PACKAGE,
  packageEntryLoadsExtensions,
  permissionPluginConfiguredByUser,
} from '../permissionPlugin.ts';

/**
 * Reading a user's pi `settings.json` for a permission-system package.
 *
 * T025 cut this suite down with the module: the injection decision and the
 * load verification it also covered had no production caller after P6-5, so
 * both are gone. What is left feeds one thing — the origin the plugins page
 * shows — and the shapes that still matter are the ones where a package is
 * named but pi would load nothing from it.
 */

const temporaries: string[] = [];

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
