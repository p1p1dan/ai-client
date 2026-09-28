/**
 * The DSH host's plugin rules (dsh-rebase P1-10b; decisions 025, 058, 059 and
 * 108).
 *
 * Pure: host.ts does the I/O (the allowlist file, the installed packages'
 * manifests, real paths) and applies these at every start, the unit tests pin
 * them, and the packaged build bundles this file into host.js together with
 * the shared allowlist library it builds on (`HOST_INPUTS`).
 *
 *   allowlist  packaged: `dsh-host-manifest.json`'s `plugins` section, which
 *              the build audited; source checkout: `plugins/allowlist.json`
 *   enabled    Main's list (`AICLIENT_DSH_PLUGINS`); the allowlist's
 *              `defaultEnabled` when Main sent none; nothing when the list
 *              is malformed
 *   bundles    the product bundles, the test-only probe bundle when a probe
 *              driver asks for it in a source checkout (decision 015), then
 *              every enabled allowlisted plugin found in the install
 *              directory, in allowlist order; everything else the profile
 *              listed is dropped with a warning
 *   audit      a plugin layer must resolve to the install directory and its
 *              bundle patch may only insert the rows the allowlist declares
 *              (the plugin is left out otherwise); a row that no composed
 *              bundle declares, inserted by the home layer, refuses a
 *              packaged boot
 */

import {
  type AllowlistEntry,
  auditBundlePatches,
  parseAllowlist,
  patchRowIds,
  targetProfileBundles,
} from '../../shared/dshPluginAllowlist.ts';
import type {
  DshDroppedBundle,
  DshPluginReport,
  DshPluginState,
  DshPluginStatus,
} from '../../shared/dshPlugins.ts';
import { isDshPluginPackageName } from '../../shared/dshPlugins.ts';

/**
 * Main's enabled list, a JSON array of package names (decision 108 rule 6).
 * Absent: nobody chose, the allowlist's defaults apply. Declared again as
 * `DSH_HOST_PLUGINS_ENV` in src/main/services/agent-host/dshHostEnvironment.ts;
 * hostStatic.test.ts pins the two equal.
 */
export const PLUGINS_ENV = 'AICLIENT_DSH_PLUGINS';

/**
 * A probe driver's switch (`1`) that keeps the test-only probe bundle it
 * listed in the profile, in a source checkout only (decision 015). Main never
 * sets it: the `AICLIENT_` family is never inherited by the host.
 */
export const PROBE_BUNDLE_ENV = 'AICLIENT_DSH_PROBE_BUNDLE';

/** The `fatal` code of a packaged boot refused for rows no bundle declares (decision 108 rule 12). */
export const UNDECLARED_ROWS_CODE = 'DSH_HOST_UNDECLARED_ROWS';

/** What the host needs of one allowlisted plugin. */
export interface HostPlugin {
  name: string;
  /** The allowlisted (exact) version. */
  version: string;
  /** Row ids its bundle patch inserts, and the only ones it may. */
  rows: string[];
  defaultEnabled: boolean;
  /** Former package names whose enabled state it inherits. */
  replaces: string[];
}

export interface HostAllowlist {
  plugins: HostPlugin[];
  /** Entries left out, and why; the host warns about each. */
  failures: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function hostPluginOf(
  entry: Pick<AllowlistEntry, 'name' | 'version' | 'rows' | 'defaultEnabled' | 'replaces'>
): HostPlugin {
  return {
    name: entry.name,
    version: entry.version,
    rows: [...entry.rows],
    defaultEnabled: entry.defaultEnabled,
    replaces: [...(entry.replaces ?? [])],
  };
}

/**
 * A packaged host's allowlist: the manifest's `plugins` section, audited when
 * the artifact was built (scripts/dsh-host-build-lib.mjs). Only the shape the
 * host relies on is checked again; an entry without it is left out.
 */
export function allowlistFromManifest(section: unknown): HostAllowlist {
  if (section === undefined) {
    return { plugins: [], failures: ['dsh-host-manifest.json has no plugins section'] };
  }
  if (!Array.isArray(section)) {
    return { plugins: [], failures: ['dsh-host-manifest.json plugins is not a list'] };
  }
  const plugins: HostPlugin[] = [];
  const failures: string[] = [];
  section.forEach((raw, index) => {
    const where = `plugins[${index}]`;
    if (
      !isRecord(raw) ||
      !isDshPluginPackageName(raw.name) ||
      typeof raw.version !== 'string' ||
      raw.version === '' ||
      !isStringList(raw.rows) ||
      raw.rows.length === 0 ||
      typeof raw.defaultEnabled !== 'boolean' ||
      !(raw.replaces === undefined || isStringList(raw.replaces))
    ) {
      failures.push(`${where} lacks a name, version, rows or defaultEnabled; left out`);
      return;
    }
    if (plugins.some((plugin) => plugin.name === raw.name)) {
      failures.push(`${where}: ${raw.name} is listed twice; the second is left out`);
      return;
    }
    plugins.push(
      hostPluginOf({
        name: raw.name,
        version: raw.version,
        rows: raw.rows,
        defaultEnabled: raw.defaultEnabled,
        replaces: raw.replaces as string[] | undefined,
      })
    );
  });
  return { plugins, failures };
}

/** A source checkout's allowlist: `src/dsh-host/plugins/allowlist.json`, by the build's own rules. */
export function allowlistFromSource(raw: unknown): HostAllowlist {
  const { allowlist, failures } = parseAllowlist(raw);
  return { plugins: allowlist.plugins.map(hostPluginOf), failures };
}

// ---- the enabled set -------------------------------------------------------------

export type EnabledInput =
  | { from: 'default' }
  | { from: 'main'; names: string[] }
  | { from: 'invalid'; error: string };

/** `AICLIENT_DSH_PLUGINS` as the host reads it. Fail-closed: a malformed list enables nothing. */
export function readEnabledInput(raw: string | undefined): EnabledInput {
  if (raw === undefined) return { from: 'default' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { from: 'invalid', error: 'not JSON' };
  }
  if (!Array.isArray(parsed) || !parsed.every(isDshPluginPackageName)) {
    return { from: 'invalid', error: 'not a JSON list of package names' };
  }
  return { from: 'main', names: [...new Set(parsed)] };
}

/** The names the enabled set holds: Main's, or the allowlist's defaults. */
export function enabledNames(plugins: readonly HostPlugin[], input: EnabledInput): string[] {
  if (input.from === 'main') return [...input.names];
  if (input.from === 'invalid') return [];
  return plugins.filter((plugin) => plugin.defaultEnabled).map((plugin) => plugin.name);
}

// ---- the install directory -------------------------------------------------------

/** What host.ts found at `<host>/node_modules/<name>/package.json`. */
export type InstalledPackage =
  | { found: false }
  | { found: 'unreadable'; error: string }
  | { found: true; name: unknown; version: unknown; bundle: boolean };

export type InstallVerdict =
  | { ok: true }
  | { ok: false; state: Extract<DshPluginState, 'missing' | 'rejected'>; reason: string };

/**
 * Whether the install directory holds the allowlisted plugin: the listed name
 * and exact version, declaring a DSH bundle. Absent or unreadable is
 * `missing` (a warning, decision 025 rule 5); anything else there is
 * `rejected`.
 */
export function judgeInstalled(plugin: HostPlugin, found: InstalledPackage): InstallVerdict {
  if (found.found === false) {
    return { ok: false, state: 'missing', reason: 'not in the install directory' };
  }
  if (found.found === 'unreadable') {
    return { ok: false, state: 'missing', reason: `unreadable package.json: ${found.error}` };
  }
  if (found.name !== plugin.name || found.version !== plugin.version) {
    return {
      ok: false,
      state: 'rejected',
      reason: `installed as ${String(found.name)}@${String(found.version)}, allowlisted ${plugin.version}`,
    };
  }
  if (!found.bundle) {
    return { ok: false, state: 'rejected', reason: 'declares no dsh.bundle.patch' };
  }
  return { ok: true };
}

// ---- the profile's bundle list -----------------------------------------------------

export interface BundlePlan {
  /** The list to write into the profile manifest, and to load. */
  bundles: string[];
  /**
   * Every allowlisted plugin. `disabled`, `missing` and `rejected` are final
   * here; `loaded` means "layered", which the load audit may still reject.
   */
  plugins: DshPluginStatus[];
  /** What this start will not compose although the profile listed it or Main enabled it. */
  dropped: DshDroppedBundle[];
}

/**
 * Decision 058 rule 2 and decision 108 rule 1: the product bundles in their
 * order, then the test bundles this start keeps (only those `listed`), then
 * every enabled allowlisted plugin the install directory holds, in allowlist
 * order. `listed` is the profile's list after `reconcileProductBundles`.
 */
export function planProfileBundles(input: {
  listed: readonly string[];
  product: readonly string[];
  plugins: readonly HostPlugin[];
  enabled: readonly string[];
  installed: ReadonlyMap<string, InstallVerdict>;
  testBundles: readonly string[];
}): BundlePlan {
  const { listed, product, plugins, enabled, installed, testBundles } = input;
  const wanted = new Set(targetProfileBundles(product, enabled, { plugins }).slice(product.length));
  const statuses: DshPluginStatus[] = plugins.map((plugin) => {
    const base = {
      name: plugin.name,
      version: plugin.version,
      defaultEnabled: plugin.defaultEnabled,
    };
    if (!wanted.has(plugin.name)) return { ...base, state: 'disabled' };
    const verdict = installed.get(plugin.name) ?? {
      ok: false,
      state: 'missing',
      reason: 'not in the install directory',
    };
    if (!verdict.ok) return { ...base, state: verdict.state, reason: verdict.reason };
    return { ...base, state: 'loaded' };
  });
  const tests = testBundles.filter((name) => listed.includes(name) && !product.includes(name));
  const layered = statuses
    .filter((status) => status.state === 'loaded')
    .map((status) => status.name);
  const bundles = [...product, ...tests, ...layered];

  const byName = new Map(statuses.map((status) => [status.name, status]));
  const why = (name: string): string => {
    const status = byName.get(name);
    if (status?.state === 'disabled') return 'not enabled';
    if (status) return `${status.state}: ${status.reason ?? ''}`;
    const successor = plugins.find((plugin) => plugin.replaces.includes(name));
    if (successor) return `replaced by ${successor.name}`;
    return 'not on the allowlist';
  };
  const dropped: DshDroppedBundle[] = [];
  const drop = (name: string): void => {
    if (!bundles.includes(name) && !dropped.some((item) => item.name === name)) {
      dropped.push({ name, reason: why(name) });
    }
  };
  for (const name of listed) drop(name);
  // An enabled name off the allowlist (delisted, or a former name); an
  // allowlisted one that is not layered already says why in its status.
  for (const name of enabled) if (!byName.has(name)) drop(name);
  return { bundles, plugins: statuses, dropped };
}

// ---- the load audit ----------------------------------------------------------------

/** One loaded layer, with what host.ts resolved about it. */
export interface LoadedLayer {
  packageName: string;
  patches: readonly unknown[];
  /** `file:` URL of `packageDir` as DSH resolved it (relative row names anchor to it). */
  packageUrl: string;
  /** Real path of `packageDir`. */
  realDir: string;
}

const REASON_MAX = 500;

function clip(text: string): string {
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
}

/**
 * Decision 059 rule 3 on the loaded profile: every plugin layered by the plan
 * must have loaded (DSH skips a plugin whose peers it does not satisfy),
 * resolved to its own directory under the host's node_modules (`expectedDirs`,
 * real paths: never a profile or ancestor copy of the same name), and carry a
 * bundle patch that inserts only its declared rows and touches no other row.
 * Returns the final statuses and the plugins to leave out of the composition.
 */
export function auditPluginLayers(input: {
  layers: readonly LoadedLayer[];
  skipped: ReadonlyArray<{ packageName: string; reason: string }>;
  plugins: readonly HostPlugin[];
  statuses: readonly DshPluginStatus[];
  expectedDirs: ReadonlyMap<string, string>;
}): { plugins: DshPluginStatus[]; rejected: string[] } {
  const { layers, skipped, plugins, statuses, expectedDirs } = input;
  const pluginNames = new Set(plugins.map((plugin) => plugin.name));
  const existingIds = patchRowIds(
    layers.filter((layer) => !pluginNames.has(layer.packageName)).flatMap((layer) => layer.patches)
  );
  const rejected: string[] = [];
  const judged = statuses.map((status): DshPluginStatus => {
    if (status.state !== 'loaded') return status;
    const reject = (reason: string): DshPluginStatus => {
      rejected.push(status.name);
      return { ...status, state: 'rejected', reason: clip(reason) };
    };
    const skip = skipped.find((item) => item.packageName === status.name);
    if (skip)
      return { ...status, state: 'rejected', reason: clip(`DSH skipped it: ${skip.reason}`) };
    const layer = layers.find((item) => item.packageName === status.name);
    if (!layer) return { ...status, state: 'rejected', reason: 'DSH did not layer it' };
    const expected = expectedDirs.get(status.name);
    if (expected === undefined || layer.realDir !== expected) {
      return reject(`resolved from ${layer.realDir}, not the install directory`);
    }
    const plugin = plugins.find((item) => item.name === status.name);
    const audit = auditBundlePatches({
      patches: layer.patches,
      packageName: status.name,
      packageUrl: layer.packageUrl,
      rows: plugin?.rows ?? [],
      existingIds,
    });
    if (audit.failures.length > 0) return reject(`bundle patch: ${audit.failures.join('; ')}`);
    return status;
  });
  return { plugins: judged, rejected };
}

/** Marks each loaded plugin's declared rows that did not start (the activation census). */
export function withInactiveRows(
  statuses: readonly DshPluginStatus[],
  plugins: readonly HostPlugin[],
  inactive: ReadonlySet<string>
): DshPluginStatus[] {
  return statuses.map((status) => {
    if (status.state !== 'loaded') return status;
    const rows = plugins.find((plugin) => plugin.name === status.name)?.rows ?? [];
    const down = rows.filter((row) => inactive.has(row));
    return down.length > 0 ? { ...status, inactiveRows: down } : status;
  });
}

export function pluginReport(
  input: EnabledInput,
  plugins: DshPluginStatus[],
  dropped: DshDroppedBundle[]
): DshPluginReport {
  return { enabledFrom: input.from, plugins, dropped };
}

// ---- rows no bundle declares ---------------------------------------------------------

function rowKey(row: Record<string, unknown>): string {
  return typeof row.id === 'string' && row.id !== ''
    ? row.id
    : `(no id) ${typeof row.name === 'string' ? row.name : JSON.stringify(row.name ?? null)}`;
}

/** Row keys of a composed entry list, nested rows included, counted. */
function countRows(entries: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (list: readonly unknown[]): void => {
    for (const row of list) {
      if (!isRecord(row)) continue;
      const key = rowKey(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      // Both nestings: a loader group's config list, and an `initial` list.
      if (row.group && Array.isArray(row.config)) visit(row.config);
      const initial = isRecord(row.config) ? row.config.initial : undefined;
      if (Array.isArray(initial)) visit(initial);
    }
  };
  visit(entries);
  return counts;
}

/**
 * Rows of `composed` that `trusted` does not have, one per extra occurrence:
 * `trusted` is the composition of the bundle layers and the launch overlays
 * alone, `composed` the full one (the home layer included). Patches never
 * remove a row, so every extra is a row some other layer inserted.
 */
export function undeclaredRows(
  trusted: readonly unknown[],
  composed: readonly unknown[]
): string[] {
  const allowed = countRows(trusted);
  const extras: string[] = [];
  for (const [key, count] of countRows(composed)) {
    for (let index = allowed.get(key) ?? 0; index < count; index += 1) extras.push(key);
  }
  return extras;
}
