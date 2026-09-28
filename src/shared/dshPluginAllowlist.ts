/**
 * DSH plugin allowlist (dsh-rebase P1-10a, decisions 058 to 060).
 *
 * Plugins ship preinstalled in the host's install scope: each is an exact
 * dependency of `src/dsh-host/package.json`, locked by integrity, and listed in
 * `src/dsh-host/plugins/allowlist.json`. This module holds the pure rules both
 * the build script and (from P1-10b) the host apply:
 *
 * - the allowlist schema ({@link parseAllowlist});
 * - the double key between the allowlist, the host package and its lockfile,
 *   including the registered dependency closure and install scripts
 *   ({@link checkAllowlistKeys});
 * - the bundle patch audit: a plugin may only insert the rows it declares
 *   ({@link auditBundlePatches});
 * - the profile bundle list the host composes ({@link targetProfileBundles}).
 *
 * No I/O and no imports: `scripts/*.mjs` load this file through Node's type
 * stripping, so the syntax stays erasable. host.js takes it in too (P1-10b,
 * `src/dsh-host/lib/hostPlugins.ts`; `HOST_INPUTS` in the build lib).
 */

export const ALLOWLIST_SCHEMA = 1;

/** Product row ids start with this; no plugin may claim one. */
export const RESERVED_ROW_PREFIX = 'aiclient-';

export type PluginKind = 'official' | 'internal';

/**
 * Gate class of one plugin tool (decision 047): `ask`, or a read / write
 * refinement naming the argument that carries the path. Nothing is allowed
 * outright.
 */
export type PluginToolClass = 'ask' | { class: 'read' | 'write'; path: string };

export interface PluginReview {
  /** Review record, relative to `src/dsh-host/plugins/`. */
  record: string;
  date: string;
  reviewer: string;
  verdict: 'approved' | 'conditional';
}

export interface AllowlistEntry {
  name: string;
  version: string;
  /** The lockfile's (and the registry's) sha512 integrity of the tarball. */
  integrity: string;
  kind: PluginKind;
  defaultEnabled: boolean;
  /** Row ids the plugin's bundle patch may insert. */
  rows: string[];
  tools: Record<string, PluginToolClass>;
  review: PluginReview;
  /** Former package names whose enabled state this plugin inherits. */
  replaces?: string[];
  /** Registered run-time closure beyond the host's own tree: `name@version` -> integrity. */
  dependencies?: Record<string, string>;
  /** Packages of the closure with an install script, each with why it works without it. */
  installScripts?: Record<string, string>;
  /** Ceilings approved in the review record instead of the defaults (packaging-budget.mjs). */
  limits?: { maxBytes: number; maxFiles: number };
}

export interface PluginAllowlist {
  schema: typeof ALLOWLIST_SCHEMA;
  plugins: AllowlistEntry[];
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_KEYS = new Set([
  'name',
  'version',
  'integrity',
  'kind',
  'defaultEnabled',
  'rows',
  'tools',
  'review',
  'replaces',
  'dependencies',
  'installScripts',
  'limits',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** `name@version` -> `[name, version]`, scoped names included. */
export function splitPackageKey(key: string): [string, string] | null {
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  return PACKAGE_NAME.test(name) && EXACT_VERSION.test(version) ? [name, version] : null;
}

function checkTools(tools: unknown, where: string, failures: string[]): void {
  if (!isRecord(tools)) {
    failures.push(`${where}.tools must be an object (use {"*": "ask"} when nothing is refined)`);
    return;
  }
  for (const [tool, value] of Object.entries(tools)) {
    const at = `${where}.tools[${JSON.stringify(tool)}]`;
    if (tool === '') failures.push(`${at}: empty tool name`);
    if (tool === '*' && value !== 'ask') {
      failures.push(`${at} must be "ask": unlisted plugin tools always ask (decision 047)`);
      continue;
    }
    if (value === 'ask') continue;
    if (!isRecord(value)) {
      failures.push(
        `${at} must be "ask" or {class: "read" | "write", path}; no plugin tool is allowed outright (decision 047)`
      );
      continue;
    }
    const extra = Object.keys(value).filter((key) => key !== 'class' && key !== 'path');
    if (value.class !== 'read' && value.class !== 'write') {
      failures.push(`${at}.class must be "read" or "write", got ${JSON.stringify(value.class)}`);
    }
    if (typeof value.path !== 'string' || value.path === '') {
      failures.push(`${at}.path must name the argument that carries the path`);
    }
    if (extra.length > 0) failures.push(`${at} has unknown keys: ${extra.join(', ')}`);
  }
}

function checkReview(review: unknown, where: string, failures: string[]): void {
  if (!isRecord(review)) {
    failures.push(`${where}.review must be an object {record, date, reviewer, verdict}`);
    return;
  }
  const record = review.record;
  if (
    typeof record !== 'string' ||
    !record.endsWith('.md') ||
    record.startsWith('/') ||
    /^[A-Za-z]:/.test(record) ||
    record.split(/[\\/]/).includes('..')
  ) {
    failures.push(`${where}.review.record must be a .md path inside src/dsh-host/plugins/`);
  }
  if (typeof review.date !== 'string' || !DATE.test(review.date)) {
    failures.push(`${where}.review.date must be YYYY-MM-DD`);
  }
  if (typeof review.reviewer !== 'string' || review.reviewer.trim() === '') {
    failures.push(`${where}.review.reviewer is required`);
  }
  if (review.verdict !== 'approved' && review.verdict !== 'conditional') {
    failures.push(`${where}.review.verdict must be "approved" or "conditional"`);
  }
}

function checkEntry(raw: unknown, index: number, failures: string[]): AllowlistEntry | null {
  const where = `plugins[${index}]`;
  if (!isRecord(raw)) {
    failures.push(`${where} must be an object`);
    return null;
  }
  const at = typeof raw.name === 'string' ? `${where} (${raw.name})` : where;
  const unknown = Object.keys(raw).filter((key) => !ENTRY_KEYS.has(key));
  if (unknown.length > 0) failures.push(`${at} has unknown keys: ${unknown.join(', ')}`);
  const before = failures.length;

  if (typeof raw.name !== 'string' || !PACKAGE_NAME.test(raw.name)) {
    failures.push(`${at}.name must be an npm package name`);
  }
  if (typeof raw.version !== 'string' || !EXACT_VERSION.test(raw.version)) {
    failures.push(`${at}.version must be an exact version`);
  }
  if (typeof raw.integrity !== 'string' || !SHA512.test(raw.integrity)) {
    failures.push(`${at}.integrity must be the lockfile's sha512 integrity`);
  }
  if (raw.kind === 'official') {
    if (typeof raw.name === 'string' && !raw.name.startsWith('@deepseek-ai/')) {
      failures.push(`${at}: kind "official" is for @deepseek-ai/* packages`);
    }
  } else if (raw.kind === 'internal') {
    if (typeof raw.name === 'string' && raw.name.startsWith('@deepseek-ai/')) {
      failures.push(`${at}: @deepseek-ai/* packages are kind "official"`);
    }
  } else {
    failures.push(`${at}.kind must be "official" or "internal"`);
  }
  if (typeof raw.defaultEnabled !== 'boolean') {
    failures.push(`${at}.defaultEnabled must be true or false`);
  }
  if (
    !Array.isArray(raw.rows) ||
    raw.rows.length === 0 ||
    !raw.rows.every((row) => typeof row === 'string' && ROW_ID.test(row))
  ) {
    failures.push(`${at}.rows must list the row ids its bundle patch inserts`);
  } else {
    if (new Set(raw.rows).size !== raw.rows.length) failures.push(`${at}.rows has duplicates`);
    for (const row of raw.rows as string[]) {
      if (row.startsWith(RESERVED_ROW_PREFIX)) {
        failures.push(`${at}.rows: ${row} uses the product prefix ${RESERVED_ROW_PREFIX}`);
      }
    }
  }
  checkTools(raw.tools, at, failures);
  checkReview(raw.review, at, failures);
  if (raw.replaces !== undefined) {
    if (
      !Array.isArray(raw.replaces) ||
      !raw.replaces.every((name) => typeof name === 'string' && PACKAGE_NAME.test(name))
    ) {
      failures.push(`${at}.replaces must list package names`);
    } else if (raw.replaces.includes(raw.name)) {
      failures.push(`${at}.replaces names the plugin itself`);
    }
  }
  if (raw.dependencies !== undefined) {
    if (!isRecord(raw.dependencies)) failures.push(`${at}.dependencies must be an object`);
    else {
      for (const [key, integrity] of Object.entries(raw.dependencies)) {
        if (splitPackageKey(key) === null) {
          failures.push(`${at}.dependencies: ${key} is not name@exact-version`);
        }
        if (typeof integrity !== 'string' || !SHA512.test(integrity)) {
          failures.push(`${at}.dependencies[${key}] must be a sha512 integrity`);
        }
      }
    }
  }
  if (raw.installScripts !== undefined) {
    if (
      !isRecord(raw.installScripts) ||
      !Object.values(raw.installScripts).every(
        (reason) => typeof reason === 'string' && reason.trim() !== ''
      )
    ) {
      failures.push(`${at}.installScripts must map package names to a reason`);
    }
  }
  if (raw.limits !== undefined) {
    if (
      !isRecord(raw.limits) ||
      !isPositiveInteger(raw.limits.maxBytes) ||
      !isPositiveInteger(raw.limits.maxFiles)
    ) {
      failures.push(`${at}.limits must be {maxBytes, maxFiles} as positive integers`);
    }
  }
  return failures.length === before ? (raw as unknown as AllowlistEntry) : null;
}

/** Validate the parsed `allowlist.json`; `allowlist` holds only the entries that passed. */
export function parseAllowlist(raw: unknown): { allowlist: PluginAllowlist; failures: string[] } {
  const failures: string[] = [];
  const allowlist: PluginAllowlist = { schema: ALLOWLIST_SCHEMA, plugins: [] };
  if (!isRecord(raw)) return { allowlist, failures: ['allowlist must be a JSON object'] };
  const unknown = Object.keys(raw).filter(
    (key) => key !== 'schema' && key !== 'plugins' && key !== '$comment'
  );
  if (unknown.length > 0) failures.push(`allowlist has unknown keys: ${unknown.join(', ')}`);
  if (raw.schema !== ALLOWLIST_SCHEMA) {
    failures.push(
      `allowlist schema must be ${ALLOWLIST_SCHEMA}, got ${JSON.stringify(raw.schema)}`
    );
  }
  if (!Array.isArray(raw.plugins)) {
    failures.push('allowlist.plugins must be an array');
    return { allowlist, failures };
  }
  const names = new Set<string>();
  const rows = new Map<string, string>();
  raw.plugins.forEach((item, index) => {
    const entry = checkEntry(item, index, failures);
    if (!entry) return;
    if (names.has(entry.name)) failures.push(`${entry.name} is listed twice`);
    names.add(entry.name);
    for (const row of entry.rows) {
      const owner = rows.get(row);
      if (owner !== undefined)
        failures.push(`row ${row} is declared by ${owner} and ${entry.name}`);
      rows.set(row, entry.name);
    }
    allowlist.plugins.push(entry);
  });
  for (const entry of allowlist.plugins) {
    for (const name of entry.replaces ?? []) {
      if (names.has(name)) failures.push(`${entry.name} replaces ${name}, which is still listed`);
    }
  }
  return { allowlist, failures };
}

// ---- lockfile ----------------------------------------------------------------

export interface LockPackage {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dev?: boolean;
  hasInstallScript?: boolean;
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface Lockfile {
  packages?: Record<string, LockPackage>;
}

/** Package name of a lockfile path (`node_modules/a/node_modules/@s/b` -> `@s/b`). */
export function lockPathName(lockPath: string): string {
  const at = lockPath.lastIndexOf('node_modules/');
  return at === -1 ? lockPath : lockPath.slice(at + 'node_modules/'.length);
}

/**
 * Where Node finds `name` from the package at `from` (a lockfile path, `''`
 * for the root): its own node_modules, then each ancestor's.
 */
export function resolveLockPath(
  packages: Record<string, LockPackage>,
  from: string,
  name: string
): string | undefined {
  let base = from;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return undefined;
    const up = base.lastIndexOf('/node_modules/');
    base = up === -1 ? '' : base.slice(0, up);
  }
}

/**
 * Lockfile paths reachable from `starts` through dependencies, optional
 * dependencies and peers, following `file:` links to their targets. Paths in
 * `stop` are neither returned nor walked through.
 */
export function lockClosure(
  lock: Lockfile,
  starts: string[],
  stop: ReadonlySet<string> = new Set()
): Set<string> {
  const packages = lock.packages ?? {};
  const seen = new Set<string>();
  const queue = starts.filter((start) => !stop.has(start));
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const node = packages[current];
    if (!node) continue;
    if (node.link && typeof node.resolved === 'string') {
      if (!stop.has(node.resolved)) queue.push(node.resolved);
      continue;
    }
    const names = new Set([
      ...Object.keys(node.dependencies ?? {}),
      ...Object.keys(node.optionalDependencies ?? {}),
      ...Object.keys(node.peerDependencies ?? {}),
    ]);
    for (const name of names) {
      const found = resolveLockPath(packages, current, name);
      if (found !== undefined && !stop.has(found) && !seen.has(found)) queue.push(found);
    }
  }
  return seen;
}

/** The host's own tree: everything the root reaches without going through a plugin. */
export function hostBaseClosure(lock: Lockfile, pluginNames: readonly string[]): Set<string> {
  const root = lock.packages?.['']?.dependencies ?? {};
  const pluginPaths = new Set(pluginNames.map((name) => `node_modules/${name}`));
  const starts = Object.keys(root)
    .map((name) => `node_modules/${name}`)
    .filter((path) => !pluginPaths.has(path));
  return lockClosure(lock, starts, pluginPaths);
}

/** Lockfile paths a plugin brings beyond the host's own tree, the plugin excluded. */
export function pluginClosure(lock: Lockfile, name: string, base: ReadonlySet<string>): string[] {
  const own = `node_modules/${name}`;
  return [...lockClosure(lock, [own], base)].filter((path) => path !== own).sort();
}

export interface AllowlistKeyInput {
  allowlist: PluginAllowlist;
  /** `src/dsh-host/package.json`. */
  manifest: { dependencies?: Record<string, string>; overrides?: unknown };
  lock: Lockfile;
  /** Host dependencies that are not plugins (P1-2's exact list). */
  hostDependencies: readonly string[];
  /** The pinned DSH version. */
  dshPin: string;
}

/**
 * The npm `overrides` a plugin may carry: its `@deepseek-ai/*` peers pinned to
 * the version the host tree has. npm matches prereleases more strictly than
 * DSH, so `^0.1.0-rc.6` rejects the pinned `0.1.7-rc.2` with ERESOLVE
 * (P1-10a experiment E2); DSH's own peer check still judges the plugin.
 */
function checkOverrides(input: AllowlistKeyInput, failures: string[]): void {
  const overrides = input.manifest.overrides;
  if (overrides === undefined) return;
  if (!isRecord(overrides)) {
    failures.push('package.json overrides must be an object');
    return;
  }
  const packages = input.lock.packages ?? {};
  const listed = new Set(input.allowlist.plugins.map((entry) => entry.name));
  for (const [plugin, pins] of Object.entries(overrides)) {
    if (!listed.has(plugin)) {
      failures.push(`package.json overrides ${plugin}, which is not an allowlisted plugin`);
      continue;
    }
    if (!isRecord(pins)) {
      failures.push(`package.json overrides.${plugin} must pin peers by name`);
      continue;
    }
    for (const [peer, version] of Object.entries(pins)) {
      const hostVersion = packages[`node_modules/${peer}`]?.version;
      if (!peer.startsWith('@deepseek-ai/')) {
        failures.push(
          `package.json overrides.${plugin} may only pin @deepseek-ai/* peers: ${peer}`
        );
      } else if (version !== hostVersion) {
        failures.push(
          `package.json overrides.${plugin}.${peer} is ${JSON.stringify(version)}, not the host's ${hostVersion}`
        );
      }
    }
  }
}

/**
 * The double key (decision 059): every allowlisted plugin is an exact host
 * dependency locked at the listed integrity from a registry; every host
 * dependency is either a host package or allowlisted; the closure a plugin
 * brings beyond the host's tree is registered exactly; install scripts in it
 * are acknowledged. Returns the closure per plugin (lockfile paths).
 */
export function checkAllowlistKeys(input: AllowlistKeyInput): {
  failures: string[];
  closures: Record<string, string[]>;
} {
  const { allowlist, manifest, lock, hostDependencies, dshPin } = input;
  const failures: string[] = [];
  const closures: Record<string, string[]> = {};
  const deps = manifest.dependencies ?? {};
  const packages = lock.packages ?? {};
  const lockRoot = packages['']?.dependencies ?? {};
  const names = allowlist.plugins.map((entry) => entry.name);

  for (const name of Object.keys(deps)) {
    if (!hostDependencies.includes(name) && !names.includes(name)) {
      failures.push(`${name} is a host dependency but neither a host package nor allowlisted`);
    }
  }
  const base = hostBaseClosure(lock, names);

  for (const entry of allowlist.plugins) {
    const { name, version } = entry;
    if (hostDependencies.includes(name)) {
      failures.push(`${name} is a host package and cannot be allowlisted`);
      continue;
    }
    if (deps[name] !== version) {
      failures.push(`package.json has ${name}@${deps[name] ?? '(missing)'}, allowlist ${version}`);
    }
    if (lockRoot[name] !== version) {
      failures.push(
        `lockfile root has ${name}@${lockRoot[name] ?? '(missing)'}, allowlist ${version}`
      );
    }
    if (entry.kind === 'official' && version !== dshPin) {
      failures.push(`${name} is official but ${version} is not the DSH pin ${dshPin}`);
    }
    const node = packages[`node_modules/${name}`];
    if (!node) {
      failures.push(`lockfile has no node_modules/${name}`);
      continue;
    }
    if (node.link || typeof node.resolved !== 'string' || !node.resolved.startsWith('https://')) {
      failures.push(`${name} must come from a registry tarball, not ${node.resolved ?? 'a link'}`);
    }
    if (node.version !== version) {
      failures.push(`lockfile has ${name}@${node.version}, allowlist ${version}`);
    }
    if (node.integrity !== entry.integrity) {
      failures.push(`${name}@${version}: lockfile integrity differs from the allowlist`);
    }

    const closure = pluginClosure(lock, name, base);
    closures[name] = closure;
    const registered = entry.dependencies ?? {};
    const reached = new Set<string>();
    for (const path of closure) {
      const dep = packages[path] ?? {};
      const key = `${lockPathName(path)}@${dep.version}`;
      reached.add(key);
      if (!(key in registered)) {
        failures.push(`${name} brings ${key} (${path}), which its dependencies do not register`);
      } else if (registered[key] !== dep.integrity) {
        failures.push(`${name}: ${key} integrity differs from the lockfile`);
      }
    }
    for (const key of Object.keys(registered)) {
      if (!reached.has(key)) failures.push(`${name} registers ${key}, which it does not bring`);
    }

    const acknowledged = entry.installScripts ?? {};
    for (const path of [`node_modules/${name}`, ...closure]) {
      if (packages[path]?.hasInstallScript && !(lockPathName(path) in acknowledged)) {
        failures.push(
          `${lockPathName(path)} (${name}) has an install script, which never runs (--ignore-scripts); acknowledge it in installScripts once the smoke shows it works without`
        );
      }
    }
  }
  checkOverrides(input, failures);
  return { failures, closures };
}

// ---- bundle patch audit --------------------------------------------------------

/** DSH's parsed `!!js` scalar (dsh-app-boot's entry-list dialect). */
function isJsExpr(value: unknown): value is { __jsExpr: string } {
  return isRecord(value) && typeof value.__jsExpr === 'string';
}

function collectExpressions(value: unknown, out: string[]): void {
  if (isJsExpr(value)) out.push(value.__jsExpr);
  else if (Array.isArray(value)) for (const item of value) collectExpressions(item, out);
  else if (isRecord(value)) for (const item of Object.values(value)) collectExpressions(item, out);
}

/** Every row id a patch list inserts or targets, group children included. */
export function patchRowIds(patches: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  const visitRow = (row: unknown): void => {
    if (!isRecord(row)) return;
    if (typeof row.id === 'string') ids.add(row.id);
    if (row.group && Array.isArray(row.config)) row.config.forEach(visitRow);
  };
  for (const patch of patches) {
    if (!isRecord(patch)) continue;
    if (typeof patch.id === 'string') ids.add(patch.id);
    if (Array.isArray(patch.insert)) patch.insert.forEach(visitRow);
  }
  return ids;
}

export interface BundlePatchAuditInput {
  /** The plugin's patch list, parsed with DSH's own dialect. */
  patches: readonly unknown[];
  packageName: string;
  /** `file:` URL of the installed package directory (DSH anchors `./` names to it). */
  packageUrl?: string;
  /** The allowlist's `rows` for this plugin. */
  rows: readonly string[];
  /** Row ids of the product composition (dsh-base and @aiclient/dsh-app). */
  existingIds: ReadonlySet<string>;
}

/**
 * Decision 059: a plugin's bundle patch only inserts the rows it declares,
 * each loading a module of its own package; it never touches a row it did not
 * insert. `!!js` expressions are listed for the reviewer.
 */
export function auditBundlePatches(input: BundlePatchAuditInput): {
  failures: string[];
  inserted: string[];
  expressions: string[];
} {
  const { patches, packageName, packageUrl, rows, existingIds } = input;
  const failures: string[] = [];
  const inserted: string[] = [];
  const expressions: string[] = [];
  const ownModule = (name: string): boolean =>
    name === packageName ||
    name.startsWith(`${packageName}/`) ||
    (packageUrl !== undefined && name.startsWith(`${packageUrl.replace(/\/$/, '')}/`));

  const visitRow = (row: unknown, where: string): void => {
    if (!isRecord(row)) {
      failures.push(`${where}: inserted row is not a mapping`);
      return;
    }
    const id = row.id;
    if (typeof id !== 'string') {
      failures.push(`${where}: inserted row has no literal id`);
    } else {
      if (!rows.includes(id)) failures.push(`${where}: inserts undeclared row ${id}`);
      if (existingIds.has(id))
        failures.push(`${where}: inserts ${id}, a row the product already has`);
      if (inserted.includes(id)) failures.push(`${where}: inserts ${id} twice`);
      inserted.push(id);
    }
    const label = typeof id === 'string' ? id : where;
    if (row.name === undefined) {
      if (!row.group) failures.push(`${label}: row has no module name`);
    } else if (typeof row.name !== 'string') {
      failures.push(`${label}: module name must be literal, not an expression`);
    } else if (!ownModule(row.name)) {
      failures.push(`${label}: loads ${row.name}, which is not a module of ${packageName}`);
    }
    for (const [key, value] of Object.entries(row)) {
      if (key === 'config' && row.group && Array.isArray(value)) {
        for (const [index, child] of value.entries()) visitRow(child, `${label}.config[${index}]`);
      } else collectExpressions(value, expressions);
    }
  };

  patches.forEach((patch, index) => {
    const where = `patch ${index + 1}`;
    if (!isRecord(patch)) {
      failures.push(`${where} is not a mapping`);
      return;
    }
    if (patch.insert !== undefined) {
      if (!Array.isArray(patch.insert)) {
        failures.push(`${where}: insert must be a list`);
        return;
      }
      const extra = Object.keys(patch).filter((key) => key !== 'insert' && key !== 'id');
      if (extra.length > 0) failures.push(`${where}: insert patch also sets ${extra.join(', ')}`);
      if (patch.id !== undefined && typeof patch.id !== 'string') {
        failures.push(`${where}: insert target must be a literal id`);
      }
      for (const [rowIndex, row] of patch.insert.entries()) {
        visitRow(row, `${where}.insert[${rowIndex}]`);
      }
      return;
    }
    const id = patch.id;
    if (typeof id !== 'string') {
      failures.push(`${where}: a non-insert patch without a literal id`);
    } else if (!inserted.includes(id)) {
      failures.push(`${where}: changes row ${id}, which this plugin did not insert`);
    } else if (patch.name !== undefined) {
      failures.push(`${where}: renames the module of ${id}`);
    }
    for (const [key, value] of Object.entries(patch)) {
      if (key !== 'id') collectExpressions(value, expressions);
    }
  });
  for (const row of rows) {
    if (!inserted.includes(row))
      failures.push(`declares row ${row}, which its patch never inserts`);
  }
  return { failures, inserted, expressions };
}

// ---- composition ----------------------------------------------------------------

/**
 * The profile bundle list the host composes (decision 058 rule 2): the
 * product bundles in their fixed order, then the enabled allowlisted plugins
 * in allowlist order. A former name in `enabled` enables the plugin that
 * `replaces` it; names off the allowlist are dropped.
 */
export function targetProfileBundles(
  productBundles: readonly string[],
  enabled: readonly string[],
  allowlist: { plugins: ReadonlyArray<Pick<AllowlistEntry, 'name' | 'replaces'>> }
): string[] {
  const wanted = new Set(enabled);
  const plugins = allowlist.plugins
    .filter(
      (entry) =>
        wanted.has(entry.name) || (entry.replaces ?? []).some((former) => wanted.has(former))
    )
    .map((entry) => entry.name)
    .filter((name) => !productBundles.includes(name));
  return [...productBundles, ...plugins];
}
