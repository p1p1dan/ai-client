/**
 * Bundled permission plugin — T08-a.
 *
 * ## What ships and why
 *
 * `@gotgenes/pi-permission-system` (MIT, pinned in `src/agent-host/package.json`)
 * is the extension that gates tool calls behind user approval. It travels inside
 * the app rather than being installed on demand, because "the user happens to
 * have it globally" is not a security posture — on a machine without it, every
 * tool call would run unattended and nothing would say so.
 *
 * ## How it gets loaded
 *
 * Through the SDK's `resourceLoaderOptions.additionalExtensionPaths`, as an
 * ABSOLUTE LOCAL PATH. pi's package manager parses such a path as
 * `{ type: 'local' }` and, for a directory, reads its `package.json` to find the
 * real entry (`pi.extensions: ["./src/index.ts"]`). Three consequences worth
 * stating, because each rules out an approach that looks simpler:
 *
 *  - **A directory, never the file.** The package's `exports` entry is
 *    `src/service.ts` while its pi entry is `src/index.ts`. Resolving the module
 *    would load the wrong one.
 *  - **No network.** A local path is never installed, so this works offline and
 *    on a locked-down machine.
 *  - **The user's `settings.json` is not touched.** Editing someone's global pi
 *    config to make our app work would change their `pi` CLI too.
 *
 * ## What it does with no config
 *
 * Nothing is shipped: no policy file, no defaults. The plugin's own fall-through
 * is `ask` for every request that matches no built-in rule (`rule.ts`:
 * `defaultAction ?? "ask"`, plus an explicit `origin: "fail-closed"` arm), so a
 * fresh install prompts for anything not covered by its own infrastructure
 * rules. That is deliberate and is what makes this task independent of Q9 —
 * choosing which surfaces may default to `allow` is T08-c's job, and until it is
 * decided the safe posture is the one that asks.
 *
 * ## The one asymmetry that drives every decision below
 *
 * Skipping the bundled copy when the user's config would NOT actually load a
 * permission system is FAIL-OPEN: tools then run with no gate at all. Injecting
 * it when the user already has one is a double prompt — annoying, never unsafe.
 * So the question this module answers is deliberately narrow: *can we CONFIRM
 * the user's own configuration loads this package's extensions?* Anything short
 * of a confirmation means we inject ours.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PERMISSION_PLUGIN_PACKAGE = '@gotgenes/pi-permission-system';

/**
 * The name without its npm scope.
 *
 * A git URL or a checkout directory carries no scope — `pi-permission-system` is
 * all `https://github.com/gotgenes/pi-permission-system.git` and
 * `~/pi-extensions/pi-permission-system` ever say — so the unscoped form is the
 * only thing those two source kinds can be matched on.
 */
const PERMISSION_PLUGIN_UNSCOPED = PERMISSION_PLUGIN_PACKAGE.split('/').pop() as string;

/**
 * Where the bundled copy lives, relative to the Host entry.
 *
 * The same shape in dev and packaged, which is why it is a constant rather than
 * two branches: esbuild emits `out-agent-host/piHost.js` beside the pruned
 * `out-agent-host/node_modules/`, and in dev `src/agent-host/piHost.ts` sits
 * beside `src/agent-host/node_modules/`. The pi SDK is already resolved this way
 * (T04) — this is the same sibling-node_modules contract, not a new one.
 */
const BUNDLED_RELATIVE_PATH = ['node_modules', '@gotgenes', 'pi-permission-system'];

/** The directory holding the running Host entry (bundled or TS source). */
function hostDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

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

/**
 * Why the bundled plugin could not be used, in the words the user needs.
 *
 * `half_copied` is a real build failure and not a theoretical one: the packaging
 * filter is selective about this package (it keeps `.ts`, which the generic rule
 * drops), so a tree that exists but has no manifest has been seen. Reporting it
 * as "missing" would send someone looking for a file that is right there.
 */
export type PermissionPluginProblem = 'not_present' | 'half_copied' | 'wrong_package';

export interface BundledPermissionPluginLookup {
  /** Absolute path to hand to `additionalExtensionPaths`, when usable. */
  path?: string;
  problem?: PermissionPluginProblem;
  /** Human-readable, for the security error the user actually sees. */
  detail?: string;
}

/**
 * Locate the bundled plugin directory and say precisely what is wrong when it
 * cannot be used.
 *
 * Verified by READING `package.json` rather than by `existsSync` on the
 * directory: an empty or partially copied directory would otherwise be reported
 * as a working plugin, and the failure would then surface as "no prompts ever
 * appeared" — the one symptom indistinguishable from "nothing needed approval".
 */
export function lookupBundledPermissionPlugin(
  baseDir = hostDirectory()
): BundledPermissionPluginLookup {
  const root = join(baseDir, ...BUNDLED_RELATIVE_PATH);
  if (!existsSync(root)) {
    return { problem: 'not_present', detail: `no bundled plugin directory at ${root}` };
  }
  const name = readPackageName(root);
  if (name === undefined) {
    return {
      problem: 'half_copied',
      detail: `${root} exists but its package.json is missing or unreadable`,
    };
  }
  if (name !== PERMISSION_PLUGIN_PACKAGE) {
    return {
      problem: 'wrong_package',
      detail: `${root} declares itself as "${name}", not ${PERMISSION_PLUGIN_PACKAGE}`,
    };
  }
  return { path: root };
}

/**
 * Absolute path to the bundled plugin directory, or `undefined`.
 *
 * Kept as the narrow form for callers that only need the path; the reason a
 * lookup failed lives on {@link lookupBundledPermissionPlugin}.
 */
export function resolveBundledPermissionPlugin(baseDir?: string): string | undefined {
  return lookupBundledPermissionPlugin(baseDir).path;
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
 * A false positive here means "the user has their own copy" and costs an
 * uninjected bundle — which is why the CALLER never treats a match alone as a
 * gate; see {@link permissionPluginConfiguredByUser}, where a match must ALSO be
 * shown to load extensions.
 */
export function packageSourceIsPermissionPlugin(
  source: string,
  options: PermissionPluginMatchOptions = {}
): boolean {
  const parsed = describePackageSource(source);
  if (parsed.kind === 'npm') {
    return parsed.name === PERMISSION_PLUGIN_PACKAGE;
  }
  if (parsed.kind === 'git') {
    return parsed.name === PERMISSION_PLUGIN_UNSCOPED;
  }
  const read = options.readPackageName ?? readPackageName;
  const resolved = options.resolveLocalPath?.(parsed.path ?? source);
  if (resolved) {
    const declared = read(resolved);
    if (declared !== undefined) return declared === PERMISSION_PLUGIN_PACKAGE;
  }
  return parsed.name === PERMISSION_PLUGIN_UNSCOPED;
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
 * Only then may the bundled copy be skipped: pi merges the settings-derived
 * extension list with `additionalExtensionPaths`, so two live copies means two
 * prompts per tool call, with the second arriving after the user already
 * answered the first.
 *
 * Every other answer — no entry, an entry that names it but is switched off, a
 * shape we cannot read — returns `false`, and the caller injects. The cost of
 * being wrong in this direction is a duplicate prompt; the cost of being wrong
 * in the other direction is no permission system at all.
 */
export function permissionPluginConfiguredByUser(
  packages: unknown,
  options: PermissionPluginMatchOptions = {}
): boolean {
  if (!Array.isArray(packages)) return false;
  return packages.some((entry) => {
    const source = entrySource(entry);
    if (!source) return false;
    if (!packageSourceIsPermissionPlugin(source, options)) return false;
    return packageEntryLoadsExtensions(entry as PiPackageSource);
  });
}

// ─── did it actually load? ───

/** pi's `LoadExtensionsResult`, narrowed to the two fields this check reads. */
export interface LoadedExtensionsSnapshot {
  extensions?: Array<{ path?: unknown; resolvedPath?: unknown }>;
  errors?: Array<{ path?: unknown; error?: unknown }>;
}

export interface PermissionExtensionVerification {
  ok: boolean;
  detail?: string;
}

function pathsOf(entry: { path?: unknown; resolvedPath?: unknown }): string[] {
  return [entry.path, entry.resolvedPath].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
}

function looksLikePermissionPlugin(path: string, injectedRoots: string[]): boolean {
  if (injectedRoots.some((root) => path.startsWith(root))) return true;
  return path.includes(PERMISSION_PLUGIN_UNSCOPED);
}

/**
 * Did pi actually end up with a permission extension loaded?
 *
 * This is the check the injection decision cannot make. `decidePermissionPlugin`
 * only says which path to hand pi; whether the module at that path imported
 * cleanly is decided later, inside the resource loader — and pi's contract there
 * is to COLLECT the failure into `errors` and carry on. A plugin that threw on
 * import therefore produces a perfectly healthy-looking session with no gate in
 * it, which is the exact state this function refuses.
 *
 * `undefined` (an SDK build with no `resourceLoader.getExtensions()`) is treated
 * as OK: refusing to run on an SDK that cannot answer the question would break
 * every session on that build, and the injection itself already succeeded. The
 * `detail` says so, so the log records that this was unverified rather than
 * verified-good.
 */
export function verifyPermissionExtensionLoaded(
  loaded: LoadedExtensionsSnapshot | undefined,
  injectedRoots: string[] = []
): PermissionExtensionVerification {
  if (!loaded) {
    return { ok: true, detail: 'extension list unavailable; load was not verified' };
  }
  const failures = (loaded.errors ?? []).filter((entry) =>
    pathsOf(entry).some((path) => looksLikePermissionPlugin(path, injectedRoots))
  );
  if (failures.length > 0) {
    const first = failures[0];
    const where = first ? (pathsOf(first)[0] ?? 'unknown path') : 'unknown path';
    const why = first && typeof first.error === 'string' ? first.error : 'unknown error';
    return { ok: false, detail: `the permission extension at ${where} failed to load — ${why}` };
  }
  const loadedPermission = (loaded.extensions ?? []).some((entry) =>
    pathsOf(entry).some((path) => looksLikePermissionPlugin(path, injectedRoots))
  );
  if (!loadedPermission) {
    return {
      ok: false,
      detail: 'no permission extension is present in the loaded extension list',
    };
  }
  return { ok: true };
}

/** What the runtime learned when it decided whether to inject. */
export interface PermissionPluginDecision {
  /** Pass to `resourceLoaderOptions.additionalExtensionPaths`; empty = nothing to add. */
  additionalExtensionPaths: string[];
  /** Why, for the Host log — a silent permission system is the thing to avoid. */
  reason: 'bundled' | 'user_configured' | 'missing';
  /**
   * True when a permission gate is known to be in place for this session.
   * `false` is a REFUSAL TO PROCEED upstream, not a warning — see
   * `piRuntime.ts`, which turns it into a session-level security error rather
   * than starting a runtime whose tools would run unattended.
   */
  gated: boolean;
  /** Why it is not gated, in words a user can act on. */
  detail?: string;
}

/**
 * Decide whether to inject the bundled plugin for this session.
 *
 * `missing` is RETURNED, not thrown, because this function has no way to tell
 * the user anything — it has no event channel. The caller owns the fail-closed
 * decision and owns making it visible; what this returns is the finding plus the
 * detail needed to diagnose it.
 */
export function decidePermissionPlugin(
  configuredPackages: unknown,
  baseDir?: string,
  options: PermissionPluginMatchOptions = {}
): PermissionPluginDecision {
  if (permissionPluginConfiguredByUser(configuredPackages, options)) {
    return { additionalExtensionPaths: [], reason: 'user_configured', gated: true };
  }
  const bundled = lookupBundledPermissionPlugin(baseDir);
  if (bundled.path) {
    return { additionalExtensionPaths: [bundled.path], reason: 'bundled', gated: true };
  }
  return {
    additionalExtensionPaths: [],
    reason: 'missing',
    gated: false,
    detail: bundled.detail ?? 'the bundled permission system could not be located',
  };
}
