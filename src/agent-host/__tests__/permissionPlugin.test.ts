import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decidePermissionPlugin,
  PERMISSION_PLUGIN_PACKAGE,
  permissionPluginConfiguredByUser,
  resolveBundledPermissionPlugin,
} from '../permissionPlugin.ts';

/**
 * T08-a — deciding whether to load the bundled permission plugin.
 *
 * Two failures this guards, in order of severity:
 *
 *  1. **Loading it twice.** pi merges `additionalExtensionPaths` with the
 *     settings-derived extension list, so injecting ours alongside the user's
 *     own copy means two prompts for every tool call — the second arriving after
 *     they already answered the first.
 *  2. **Reporting a broken copy as working.** The build filter treats this
 *     package specially (it keeps `.ts`, which the generic rule drops), so a
 *     half-copied tree is reachable, and calling it present would leave tool
 *     calls ungated with nothing said.
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

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveBundledPermissionPlugin', () => {
  it('returns the package directory when the bundle is intact', () => {
    const base = fixture({ name: PERMISSION_PLUGIN_PACKAGE, version: '27.0.1' });
    expect(resolveBundledPermissionPlugin(base)).toBe(
      join(base, 'node_modules', '@gotgenes', 'pi-permission-system')
    );
  });

  it('reports missing when the directory exists but was not populated', () => {
    expect(resolveBundledPermissionPlugin(fixture(null))).toBeUndefined();
  });

  it('reports missing when the manifest is unreadable or names another package', () => {
    const base = mkdtempSync(join(tmpdir(), 'perm-plugin-'));
    temporaries.push(base);
    const root = join(base, 'node_modules', '@gotgenes', 'pi-permission-system');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{ not json');
    expect(resolveBundledPermissionPlugin(base)).toBeUndefined();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'something-else' }));
    expect(resolveBundledPermissionPlugin(base)).toBeUndefined();
  });

  it('reports missing when there is no bundle at all', () => {
    expect(resolveBundledPermissionPlugin(join(tmpdir(), 'definitely-not-here'))).toBeUndefined();
  });
});

describe('permissionPluginConfiguredByUser', () => {
  it('matches a bare npm spec', () => {
    expect(permissionPluginConfiguredByUser([`npm:${PERMISSION_PLUGIN_PACKAGE}`])).toBe(true);
  });

  /** A pinned spec is the same package — the version must not defeat the match. */
  it('matches a version-pinned npm spec', () => {
    expect(permissionPluginConfiguredByUser([`npm:${PERMISSION_PLUGIN_PACKAGE}@27.0.1`])).toBe(
      true
    );
    expect(permissionPluginConfiguredByUser([`npm:${PERMISSION_PLUGIN_PACKAGE}@^27`])).toBe(true);
  });

  it('matches the object form pi also accepts', () => {
    expect(
      permissionPluginConfiguredByUser([{ source: `npm:${PERMISSION_PLUGIN_PACKAGE}@27.0.1` }])
    ).toBe(true);
  });

  it('matches a local or git source that names the package', () => {
    expect(permissionPluginConfiguredByUser([`/opt/${PERMISSION_PLUGIN_PACKAGE}`])).toBe(true);
    expect(
      permissionPluginConfiguredByUser(['https://github.com/gotgenes/pi-permission-system.git'])
    ).toBe(false);
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
});

describe('decidePermissionPlugin', () => {
  it('injects the bundled copy when the user configured nothing', () => {
    const base = fixture({ name: PERMISSION_PLUGIN_PACKAGE });
    const decision = decidePermissionPlugin(['npm:pi-cc-extensions'], base);
    expect(decision.reason).toBe('bundled');
    expect(decision.additionalExtensionPaths).toHaveLength(1);
  });

  /** The double-prompt guard: their copy wins, ours stays out. */
  it('injects nothing when the user already loads the package', () => {
    const base = fixture({ name: PERMISSION_PLUGIN_PACKAGE });
    const decision = decidePermissionPlugin([`npm:${PERMISSION_PLUGIN_PACKAGE}`], base);
    expect(decision).toEqual({ additionalExtensionPaths: [], reason: 'user_configured' });
  });

  /**
   * Reported, not thrown: a Host that refuses to start leaves the user with no
   * app, while one that starts and says so leaves them a diagnosable gap.
   */
  it('reports a missing bundle instead of throwing', () => {
    const decision = decidePermissionPlugin([], join(tmpdir(), 'definitely-not-here'));
    expect(decision).toEqual({ additionalExtensionPaths: [], reason: 'missing' });
  });

  /** The user's own config wins even when our bundle is broken. */
  it('prefers the user configuration over an absent bundle', () => {
    const decision = decidePermissionPlugin(
      [`npm:${PERMISSION_PLUGIN_PACKAGE}`],
      join(tmpdir(), 'definitely-not-here')
    );
    expect(decision.reason).toBe('user_configured');
  });
});
