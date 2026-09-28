/**
 * Scratch host installs with preinstalled plugins (dsh-rebase P1-10b,
 * decision 108), for the drivers and tests that check plugin loading: the
 * integration test's plugin phase and tools/e3-readonly-plugin-install.ts.
 *
 * A plugin ships the way the product ships one (decision 058): its own
 * directory under the host's node_modules, a dependency of the host's
 * package.json (so DSH counts it in the install scope), and an entry in
 * `dsh-host-manifest.json`'s `plugins` section, which is the allowlist a
 * packaged host reads. Two bases:
 *
 *   artifact  a real copy of a built host (`out-dsh-host`): the product's
 *             bytes, for the read-only experiment (E3)
 *   source    host.js bundled from this checkout (the build's own esbuild
 *             options) beside a node_modules of symlinks onto
 *             src/dsh-host/node_modules, so nothing in the shared checkout is
 *             written and nothing depends on a fresh build
 *
 * The fixture plugin (tools/plugin-fixture) and its bad variants never leave
 * the scratch directory. Nothing here touches the network.
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const hostSource = resolve(here, '..', '..');
const repoRoot = resolve(hostSource, '..', '..');

export const FIXTURE_PLUGIN_SOURCE = resolve(here, '..', 'plugin-fixture');
export const FIXTURE_PLUGIN = '@aiclient-test/dsh-fixture-plugin';
export const FIXTURE_VERSION = '0.0.1';
export const FIXTURE_ROW = 'fixture-ping';
export const FIXTURE_TOOL = 'fixture_ping';
/** The fixture row's stderr line on activation (lib/index.js), followed by its directory. */
export const FIXTURE_ACTIVE_MARKER = '[dsh-fixture-plugin] active from ';

/**
 * The fixture plugin and its bad variants:
 *   good           inserts `fixture-ping`, the one row it declares
 *   undeclared-row also inserts `fixture-undeclared`, which it does not declare
 *   touches-row    also turns off `aiclient-permissions`, a row it did not insert
 *   peer-mismatch  asks for a dsh-tools version the pinned DSH is not
 */
export type FixtureVariant = 'good' | 'undeclared-row' | 'touches-row' | 'peer-mismatch';

/** A copy of the fixture plugin under `root`, altered for `variant`. */
export function fixtureVariant(root: string, variant: FixtureVariant): string {
  const dir = join(root, 'fixtures', variant);
  rmSync(dir, { recursive: true, force: true });
  cpSync(FIXTURE_PLUGIN_SOURCE, dir, { recursive: true });
  const patch = join(dir, 'cordis.patch.yml');
  if (variant === 'undeclared-row') {
    writeFileSync(
      patch,
      `${readFileSync(patch, 'utf8')}    - id: fixture-undeclared\n      name: '${FIXTURE_PLUGIN}'\n`
    );
  } else if (variant === 'touches-row') {
    writeFileSync(
      patch,
      `${readFileSync(patch, 'utf8')}\n- id: aiclient-permissions\n  disabled: true\n`
    );
  } else if (variant === 'peer-mismatch') {
    const file = join(dir, 'package.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
      peerDependencies: Record<string, string>;
    };
    manifest.peerDependencies['@deepseek-ai/dsh-tools'] = '9.9.9';
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return dir;
}

/** The manifest `plugins` entry the build would write, reduced to what the host reads. */
export interface ManifestPlugin {
  name: string;
  version: string;
  rows: string[];
  defaultEnabled: boolean;
  replaces?: string[];
  [detail: string]: unknown;
}

export function fixtureManifestEntry(overrides: Partial<ManifestPlugin> = {}): ManifestPlugin {
  return {
    name: FIXTURE_PLUGIN,
    version: FIXTURE_VERSION,
    kind: 'internal',
    defaultEnabled: false,
    description: 'Test-only fixture plugin (P1-10b)',
    rows: [FIXTURE_ROW],
    tools: { '*': 'ask' },
    replaces: [],
    ...overrides,
  };
}

export interface PreinstalledPlugin {
  /** The package directory to copy in (e.g. `fixtureVariant(...)`), installed under its own name. */
  dir: string;
  /** Its manifest entry; `null` installs it without allowlisting it. */
  entry: ManifestPlugin | null;
}

export interface ScratchInstall {
  dir: string;
  /** The host entry to run: `<dir>/host.js`. */
  entry: string;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/**
 * Build a host install at `into` (replaced if present) and preinstall
 * `plugins` in it: copied under node_modules, made dependencies of its
 * package.json, and listed in its manifest's `plugins` section. `listOnly`
 * entries are allowlisted without being installed (a plugin gone missing).
 */
export async function assembleInstall(options: {
  into: string;
  base: { artifact: string } | 'source';
  plugins: readonly PreinstalledPlugin[];
  listOnly?: readonly ManifestPlugin[];
}): Promise<ScratchInstall> {
  const { into, base, plugins, listOnly = [] } = options;
  rmSync(into, { recursive: true, force: true });
  if (base === 'source') {
    mkdirSync(join(into, 'node_modules'), { recursive: true });
    cpSync(join(hostSource, 'package.json'), join(into, 'package.json'));
    const modules = join(hostSource, 'node_modules');
    for (const name of readdirSync(modules)) {
      if (name.startsWith('.')) continue;
      symlinkSync(realpathSync(join(modules, name)), join(into, 'node_modules', name));
    }
    // The build's own rules (host.ts plus its lib/ and the shared plugin
    // library, npm packages external), from the repo root's esbuild.
    const lib = await import(
      pathToFileURL(join(repoRoot, 'scripts', 'dsh-host-build-lib.mjs')).href
    );
    const esbuild = await import('esbuild');
    const result = await esbuild.build(lib.hostBuildOptions(hostSource, into));
    const verdict = lib.checkHostMetafile(result.metafile, repoRoot) as { failures: string[] };
    if (verdict.failures.length > 0) throw new Error(verdict.failures.join('; '));
    const pin = (readJson(join(hostSource, 'package.json')).dependencies as Record<string, string>)[
      '@deepseek-ai/dsh-base'
    ];
    writeFileSync(
      join(into, 'dsh-host-manifest.json'),
      `${JSON.stringify({ schema: 1, artifact: '@aiclient/dsh-host', dsh: pin, scratch: 'source', plugins: [] }, null, 2)}\n`
    );
  } else {
    if (!existsSync(join(base.artifact, 'host.js'))) {
      throw new Error(
        `${base.artifact} holds no built host (host.js); run scripts/build-dsh-host.mjs`
      );
    }
    cpSync(base.artifact, into, { recursive: true, verbatimSymlinks: true });
  }
  const packageFile = join(into, 'package.json');
  const manifestFile = join(into, 'dsh-host-manifest.json');
  const hostPackage = readJson(packageFile);
  const manifest = readJson(manifestFile);
  const dependencies = { ...(hostPackage.dependencies as Record<string, string>) };
  const listed = Array.isArray(manifest.plugins) ? [...(manifest.plugins as unknown[])] : [];
  for (const plugin of plugins) {
    const own = readJson(join(plugin.dir, 'package.json'));
    const name = String(own.name);
    const target = join(into, 'node_modules', ...name.split('/'));
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(plugin.dir, target, { recursive: true });
    dependencies[name] = String(own.version);
    if (plugin.entry) listed.push(plugin.entry);
  }
  listed.push(...listOnly);
  writeFileSync(packageFile, `${JSON.stringify({ ...hostPackage, dependencies }, null, 2)}\n`);
  writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, plugins: listed }, null, 2)}\n`);
  return { dir: into, entry: join(into, 'host.js') };
}

/** Every file and directory below `root`, symlinks left as they are (never followed). */
function walkTree(root: string): Array<{ rel: string; kind: 'file' | 'dir' | 'link' }> {
  const out: Array<{ rel: string; kind: 'file' | 'dir' | 'link' }> = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = lstatSync(full);
      const rel = relative(root, full);
      if (stat.isSymbolicLink()) out.push({ rel, kind: 'link' });
      else if (stat.isDirectory()) {
        out.push({ rel, kind: 'dir' });
        visit(full);
      } else out.push({ rel, kind: 'file' });
    }
  };
  visit(root);
  return out;
}

/**
 * Read-only for everyone (files 0444, directories 0555), or back to the
 * owner's write (0644 / 0755). Symlinks are skipped: their targets are not
 * this tree's to change.
 */
export function setTreeWritable(root: string, writable: boolean): void {
  const entries = walkTree(root);
  // Directories last on the way down, first on the way back up.
  const ordered = writable
    ? [{ rel: '', kind: 'dir' as const }, ...entries]
    : [...entries.reverse(), { rel: '', kind: 'dir' as const }];
  for (const item of ordered) {
    if (item.kind === 'link') continue;
    const full = join(root, item.rel);
    if (item.kind === 'dir') chmodSync(full, writable ? 0o755 : 0o555);
    else chmodSync(full, writable ? 0o644 : 0o444);
  }
}

/** Size and mtime of every file, the kind of every entry: equal before and after means nothing was written. */
export function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const item of walkTree(root)) {
    const stat = lstatSync(join(root, item.rel));
    snapshot[item.rel] =
      item.kind === 'file'
        ? `file ${stat.size} ${stat.mtimeMs}`
        : `${item.kind} ${stat.mode & 0o777}`;
  }
  return snapshot;
}

/** Entries that differ between two snapshots: added, removed or changed. */
export function treeChanges(
  before: Record<string, string>,
  after: Record<string, string>
): string[] {
  const changes: string[] = [];
  for (const [rel, value] of Object.entries(after)) {
    if (!(rel in before)) changes.push(`added ${rel}`);
    else if (before[rel] !== value) changes.push(`changed ${rel}`);
  }
  for (const rel of Object.keys(before)) if (!(rel in after)) changes.push(`removed ${rel}`);
  return changes;
}
