import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseOptInFeatures, resolveBundledFeaturePlugins } from '../bundledFeaturePlugins.ts';
import {
  BUNDLED_FEATURE_PLUGINS,
  bundledFeaturePluginEntryPaths,
  bundledFeaturePluginPackages,
  optInFeatureIds,
} from '../bundledPlugins.mjs';

/**
 * R03 — resolving the bundled feature extensions.
 *
 * The posture under test is the OPPOSITE of the permission plugin's: a missing
 * feature is reported and the session continues. So every case here asserts two
 * things at once — the right paths came back, AND the reason for anything left
 * out is on the record. A silent skip is a bug nobody can file: the symptom is
 * "the questionnaire dialog never appears", which is indistinguishable from
 * "the model never asked a question".
 */

const temporaries: string[] = [];

/** An installed tree with the named packages present and self-declaring. */
function install(...packages: string[]): string {
  const base = mkdtempSync(join(tmpdir(), 'bundled-feature-'));
  temporaries.push(base);
  for (const name of packages) {
    const root = join(base, 'node_modules', ...name.split('/'));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
  }
  return base;
}

function packageDir(base: string, name: string): string {
  return join(base, 'node_modules', ...name.split('/'));
}

/**
 * Every opt-in feature turned on.
 *
 * Most cases below are about resolution (installed? right package? user's own
 * copy?), which is orthogonal to the switch, so they run with everything
 * enabled and the DEFAULT-OFF behaviour gets its own cases. Derived from
 * `optInFeatureIds()` so adding a second opt-in plugin does not quietly narrow
 * what these cases cover.
 */
const ALL_OPT_IN = { optInFeatures: new Set(optInFeatureIds()) };

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the bundled plugin table', () => {
  /**
   * The table's whole purpose is that three consumers agree. If it were ever
   * emptied the build would still pass and the app would quietly ship without
   * the questionnaire dialog or sub-agents.
   */
  it('names the two packages R03 ships, and derives both views from them', () => {
    expect(bundledFeaturePluginPackages()).toEqual([
      '@juicesharp/rpiv-ask-user-question',
      '@gotgenes/pi-subagents',
    ]);
    expect(bundledFeaturePluginEntryPaths()).toEqual([
      'node_modules/@juicesharp/rpiv-ask-user-question/index.ts',
      'node_modules/@gotgenes/pi-subagents/src/index.ts',
    ]);
  });

  /**
   * Bundling `tintinweb/pi-subagents` is a security regression, not a taste
   * difference: the permission system's own compatibility table records it as
   * emitting no lifecycle events, so its sub-agents' tool calls bypass the
   * approval dialog while the UI still shows a permission tier.
   */
  it('takes sub-agents from @gotgenes, the fork that emits lifecycle events', () => {
    const subagents = BUNDLED_FEATURE_PLUGINS.find((plugin) =>
      plugin.package.endsWith('pi-subagents')
    );
    expect(subagents?.package).toBe('@gotgenes/pi-subagents');
  });
});

describe('resolveBundledFeaturePlugins', () => {
  it('returns an absolute directory per installed package, in table order', () => {
    const base = install(...bundledFeaturePluginPackages());
    const resolved = resolveBundledFeaturePlugins([], base, ALL_OPT_IN);
    expect(resolved.paths).toEqual([
      packageDir(base, '@juicesharp/rpiv-ask-user-question'),
      packageDir(base, '@gotgenes/pi-subagents'),
    ]);
    expect(resolved.skipped).toEqual([]);
  });

  it('skips a package that is not installed and keeps the others', () => {
    const base = install('@gotgenes/pi-subagents');
    const resolved = resolveBundledFeaturePlugins([], base, ALL_OPT_IN);
    expect(resolved.paths).toEqual([packageDir(base, '@gotgenes/pi-subagents')]);
    expect(resolved.skipped).toEqual([
      {
        package: '@juicesharp/rpiv-ask-user-question',
        reason: 'not_present',
        detail: expect.stringContaining('@juicesharp/rpiv-ask-user-question'),
      },
    ]);
  });

  /**
   * Same check as the permission plugin's, for the same reason: an empty or
   * half-copied directory would otherwise be handed to pi as a working
   * extension, and the load failure surfaces far from its cause.
   */
  it('treats a directory with no readable manifest as half-copied', () => {
    const base = install('@gotgenes/pi-subagents');
    mkdirSync(packageDir(base, '@juicesharp/rpiv-ask-user-question'), { recursive: true });
    const resolved = resolveBundledFeaturePlugins([], base, ALL_OPT_IN);
    expect(resolved.paths).not.toContain(packageDir(base, '@juicesharp/rpiv-ask-user-question'));
    expect(resolved.skipped[0]).toMatchObject({ reason: 'half_copied' });
  });

  it('rejects a directory that declares some other package name', () => {
    const base = install(...bundledFeaturePluginPackages());
    writeFileSync(
      join(packageDir(base, '@gotgenes/pi-subagents'), 'package.json'),
      JSON.stringify({ name: 'tintinweb-pi-subagents', version: '1.0.0' })
    );
    const resolved = resolveBundledFeaturePlugins([], base, ALL_OPT_IN);
    expect(resolved.paths).toEqual([packageDir(base, '@juicesharp/rpiv-ask-user-question')]);
    expect(resolved.skipped[0]).toMatchObject({
      package: '@gotgenes/pi-subagents',
      reason: 'wrong_package',
    });
  });

  /**
   * Two live copies of one extension register their tools and commands twice.
   * The user's copy wins because they chose its version and can undo the choice.
   */
  it('stands down when the user configures the same package themselves', () => {
    const base = install(...bundledFeaturePluginPackages());
    const resolved = resolveBundledFeaturePlugins(['npm:@gotgenes/pi-subagents'], base, ALL_OPT_IN);
    expect(resolved.paths).toEqual([packageDir(base, '@juicesharp/rpiv-ask-user-question')]);
    expect(resolved.skipped).toEqual([
      {
        package: '@gotgenes/pi-subagents',
        reason: 'user_configured',
        detail: expect.stringContaining('@gotgenes/pi-subagents'),
      },
    ]);
  });

  /**
   * The mirror of the permission gate's rule. An entry the user has DISABLED
   * loads nothing, so standing down for it would remove the feature and put
   * nothing in its place — and unlike the gate, nobody would be told.
   */
  it('still injects when the user entry cannot load extensions', () => {
    const base = install(...bundledFeaturePluginPackages());
    for (const entry of [
      { source: 'npm:@gotgenes/pi-subagents', autoload: false },
      { source: 'npm:@gotgenes/pi-subagents', extensions: [] },
    ]) {
      const resolved = resolveBundledFeaturePlugins([entry], base, ALL_OPT_IN);
      expect(resolved.paths).toContain(packageDir(base, '@gotgenes/pi-subagents'));
      expect(resolved.skipped).toEqual([]);
    }
  });

  /** A malformed settings value must not be read as "the user has this covered". */
  it('injects everything when the configured list is not an array', () => {
    const base = install(...bundledFeaturePluginPackages());
    for (const packages of [undefined, null, 'npm:@gotgenes/pi-subagents', {}]) {
      expect(resolveBundledFeaturePlugins(packages, base, ALL_OPT_IN).paths).toHaveLength(
        BUNDLED_FEATURE_PLUGINS.length
      );
    }
  });
});

describe('the opt-in switch', () => {
  /**
   * The measurement behind the default: on a first turn (2026-09-07,
   * `claude-sonnet-5`) the request carried 11.4 KB of tool JSON, and
   * `subagent` + `get_subagent_result` + `steer_subagent` were 4.8 KB of it —
   * written into the cached prefix of every request in the session, whether or
   * not anything is ever delegated.
   */
  it('is the sub-agent extension, and it is off when nothing is enabled', () => {
    expect(optInFeatureIds()).toEqual(['subagents']);
    const base = install(...bundledFeaturePluginPackages());
    const resolved = resolveBundledFeaturePlugins([], base);
    expect(resolved.paths).toEqual([packageDir(base, '@juicesharp/rpiv-ask-user-question')]);
    expect(resolved.skipped).toEqual([
      {
        package: '@gotgenes/pi-subagents',
        reason: 'not_enabled',
        detail: expect.stringContaining('@gotgenes/pi-subagents'),
      },
    ]);
  });

  /**
   * `ask_user_question` must NOT be gated: the renderer has had a complete
   * consumer for `ui.select` / `ui.input` and this is its only producer, so
   * turning it off would make a shipped surface unreachable with no message.
   */
  it('never gates the questionnaire extension', () => {
    const questionnaire = BUNDLED_FEATURE_PLUGINS.find((plugin) =>
      plugin.package.endsWith('rpiv-ask-user-question')
    );
    expect(questionnaire?.optIn).toBeUndefined();
  });

  /**
   * The gate is checked BEFORE the user-configured check, so a user who lists
   * the package themselves while the switch is off is told the switch is off —
   * the accurate reason — rather than that we stood aside for their copy.
   */
  it('reports the switch, not the user copy, when both apply', () => {
    const base = install(...bundledFeaturePluginPackages());
    const resolved = resolveBundledFeaturePlugins(['npm:@gotgenes/pi-subagents'], base);
    expect(resolved.skipped).toEqual([
      { package: '@gotgenes/pi-subagents', reason: 'not_enabled', detail: expect.any(String) },
    ]);
  });
});

describe('parseOptInFeatures', () => {
  it('reads a comma list and treats absent, empty and blank as none', () => {
    expect([...parseOptInFeatures('subagents')]).toEqual(['subagents']);
    expect([...parseOptInFeatures(' subagents , future ')]).toEqual(['subagents', 'future']);
    for (const value of [undefined, '', '   ', ',,']) {
      expect(parseOptInFeatures(value).size).toBe(0);
    }
  });

  /**
   * A newer Main may name a feature this Host build does not carry. Keeping the
   * id rather than rejecting the whole list means the ids that DO match still
   * take effect.
   */
  it('keeps ids this build does not know', () => {
    expect(parseOptInFeatures('subagents,not-a-plugin').has('subagents')).toBe(true);
  });
});
