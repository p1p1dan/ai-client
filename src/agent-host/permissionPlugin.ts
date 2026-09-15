/**
 * Does the user's own pi configuration load a permission system?
 *
 * ## What is left here and why
 *
 * T025: this file used to decide whether to INJECT the bundled
 * `@gotgenes/pi-permission-system` into a pi session, verify afterwards that it
 * had really loaded, and refuse the session when it had not. P6-5 retired the
 * engine that did the injecting; the native runtime gates every tool call in
 * its own permissions plugin (`src/runtime/plugins/permissions/`) and never
 * hands pi an extension path. The injection decision, the load verification and
 * the bundled-package lookup therefore had no caller at all, while their
 * comments still described a fail-closed chain that no longer existed.
 *
 * What survives is one question with one production caller
 * (`src/main/services/piPlugins/index.ts`): does this user's `settings.json`
 * name a package that pi would actually load extensions from? The plugins page
 * shows the answer as the origin of the permission gate. It has nothing to do
 * with whether this app's own approval flow is running — that one is
 * unconditional.
 *
 * ## Why the shapes below are so fussy
 *
 * Two entry shapes read like "the package is present and working" while pi
 * loads nothing from it: `autoload: false` with no `extensions` patterns, and
 * `extensions: []`. Both are matched against pi's own
 * `PackageManager.collectPackageResources`, because misreading either one as
 * "the user has a permission system" is the mistake worth avoiding.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const PERMISSION_PLUGIN_PACKAGE = '@gotgenes/pi-permission-system';

/** Read a `name` out of a package manifest; `undefined` when unreadable. */
function readPackageName(packageDir: string): string | undefined {
  const manifest = join(packageDir, 'package.json');
  if (!existsSync(manifest)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

// ─── user configuration ───

/**
 * pi's own `PackageSource` (`core/settings-manager.ts`). Restated here rather
 * than imported: this module is read by the Host build, which must not depend on
 * the SDK's type surface staying stable across a pin bump.
 */
export interface PiPackageSourceObject {
  source: string;
  autoload?: boolean;
  extensions?: string[];
  [key: string]: unknown;
}

export type PiPackageSource = string | PiPackageSourceObject;

type SourceKind = 'npm' | 'git' | 'local';

export interface ParsedPackageSource {
  kind: SourceKind;
  /** npm: the package name with scope. git/local: the repo or directory name. */
  name?: string;
  /** local only — the path as written, before resolution. */
  path?: string;
}

/**
 * Split an npm spec into name and version, mirroring pi's own
 * `PackageManager.parseNpmSpec` regex so a scoped name with a version pin
 * (`@gotgenes/pi-permission-system@27.0.1`) parses the way pi will parse it.
 */
function parseNpmSpecName(spec: string): string {
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  return match?.[1] ?? spec;
}

/** Strip a trailing `.git` and any `#ref` from the last segment of a git URL. */
function gitRepoName(url: string): string | undefined {
  const withoutRef = url.split('#')[0] ?? url;
  const withoutQuery = withoutRef.split('?')[0] ?? withoutRef;
  const segments = withoutQuery.replace(/[/\\]+$/, '').split(/[/:]/);
  const last = segments.pop();
  if (!last) return undefined;
  return last.replace(/\.git$/i, '') || undefined;
}

/**
 * Classify one `source` string the way pi's `PackageManager.parseSource` does.
 *
 * The three branches are pi's, in pi's order: an `npm:` prefix wins, then
 * anything with a known remote prefix is tried as a git URL, and everything else
 * — including a bare `./x`, `~/x` or `/x` — is a local path. Getting the ORDER
 * wrong is how `npm:` specs end up matched as directories.
 */
export function describePackageSource(source: string): ParsedPackageSource {
  const trimmed = source.trim();
  if (trimmed.startsWith('npm:')) {
    return { kind: 'npm', name: parseNpmSpecName(trimmed.slice('npm:'.length).trim()) };
  }
  if (/^(git:|github:|gitlab:|bitbucket:|https?:\/\/|ssh:\/\/|git@)/i.test(trimmed)) {
    return { kind: 'git', name: gitRepoName(trimmed) };
  }
  const path = trimmed.startsWith('file:') ? trimmed.slice('file:'.length) : trimmed;
  return { kind: 'local', path, name: basename(path.replace(/[/\\]+$/, '')) || undefined };
}

export interface PermissionPluginMatchOptions {
  /**
   * How to resolve a local `source` to an absolute directory. Injected so tests
   * (and a Host whose cwd is not the project) can decide what a relative path
   * means; omitted, a relative path is only matched by its directory name.
   */
  resolveLocalPath?: (path: string) => string | undefined;
  /** Test seam over `package.json` reads. */
  readPackageName?: (packageDir: string) => string | undefined;
}

/**
 * Does this `source` string name the permission plugin?
 *
 * Each source kind is matched by the strongest evidence available to it:
 *
 *  - **npm** — the parsed package name, exactly. `npm:@gotgenes/…@27.0.1` and
 *    `npm:@gotgenes/…` are the same package; `npm:@someone/pi-permission-system`
 *    is not.
 *  - **local** — the directory's OWN `package.json` name when it can be read
 *    (`~/pi-extensions/pi-permission-system` that is really some fork resolves
 *    to whatever it actually declares), falling back to the directory name.
 *  - **git** — the repository name, which is all a URL carries. There is no
 *    manifest to read without cloning, so `…/gotgenes/pi-permission-system.git`
 *    matches on `pi-permission-system`.
 *
 * A false positive here only mislabels the origin shown on the plugins page,
 * which is why the CALLER never treats a match alone as an answer; see
 * {@link permissionPluginConfiguredByUser}, where a match must ALSO be shown to
 * load extensions.
 */
function packageSourceMatches(
  source: string,
  packageName: string,
  options: PermissionPluginMatchOptions = {}
): boolean {
  const unscoped = packageName.split('/').pop() as string;
  const parsed = describePackageSource(source);
  if (parsed.kind === 'npm') {
    return parsed.name === packageName;
  }
  if (parsed.kind === 'git') {
    return parsed.name === unscoped;
  }
  const read = options.readPackageName ?? readPackageName;
  const resolved = options.resolveLocalPath?.(parsed.path ?? source);
  if (resolved) {
    const declared = read(resolved);
    if (declared !== undefined) return declared === packageName;
  }
  return parsed.name === unscoped;
}

/**
 * Will pi actually LOAD this entry's extensions?
 *
 * Measured against pi's `PackageManager.collectPackageResources`, which is where
 * the two disabling shapes live and where neither is obvious from the settings
 * file alone:
 *
 *  - `autoload: false` with no `extensions` patterns → `applyPackageDeltaFilter`
 *    with an empty pattern list, which returns before adding anything. Nothing
 *    from the package loads.
 *  - `extensions: []` → `applyPackageFilter` with an empty list, documented in
 *    pi's own source as "Empty array explicitly disables all resources of this
 *    type". Every extension is registered as DISABLED.
 *
 * Both read like a package that is present and working. Treating either as "the
 * user has a permission system" is the fail-open this function exists to stop.
 *
 * A non-empty pattern list cannot be resolved here — the patterns are matched
 * against files inside a package that may not be installed yet — so it is taken
 * at face value UNLESS every pattern is a negation, which can only subtract.
 */
export function packageEntryLoadsExtensions(entry: PiPackageSource): boolean {
  if (typeof entry === 'string') return true;
  const patterns = Array.isArray(entry.extensions)
    ? entry.extensions.filter((value): value is string => typeof value === 'string')
    : undefined;
  // Delta form: nothing loads unless a pattern re-enables it, so an absent list
  // is a package that is switched off rather than one left at its default.
  if (entry.autoload === false) {
    if (patterns === undefined) return false;
    return enablesAnything(patterns);
  }
  if (patterns === undefined) return true;
  return enablesAnything(patterns);
}

/** A list of nothing but negations can only subtract; it enables no file. */
function enablesAnything(patterns: readonly string[]): boolean {
  return patterns.some((pattern) => !pattern.startsWith('!'));
}

function entrySource(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const source = (entry as { source?: unknown }).source;
    if (typeof source === 'string' && source) return source;
  }
  return undefined;
}

/**
 * Is the user's own pi configuration CONFIRMED to load this package's
 * extensions?
 *
 * Every other answer — no entry, an entry that names it but is switched off, a
 * shape we cannot read — is `false`. "Could not confirm" deliberately reads the
 * same as "not configured": the plugins page would otherwise claim the user
 * supplied a gate this app cannot see.
 */
function packageConfiguredByUser(
  packages: unknown,
  packageName: string,
  options: PermissionPluginMatchOptions = {}
): boolean {
  if (!Array.isArray(packages)) return false;
  return packages.some((entry) => {
    const source = entrySource(entry);
    if (!source) return false;
    if (!packageSourceMatches(source, packageName, options)) return false;
    return packageEntryLoadsExtensions(entry as PiPackageSource);
  });
}

export function permissionPluginConfiguredByUser(
  packages: unknown,
  options: PermissionPluginMatchOptions = {}
): boolean {
  return packageConfiguredByUser(packages, PERMISSION_PLUGIN_PACKAGE, options);
}
