/**
 * The DSH plugin allowlist as this build ships it, read by Main for the
 * settings page (dsh-rebase P1-10c; decisions 059, 108 rule 3 and 117).
 *
 * The host report (`ready.plugins`) carries only name, version, state and
 * reason, and there is none before the first host start. The page also needs
 * the source kind, every tool's gate class and the review, so Main reads the
 * same list the host reads, by the host's own rule (host.ts
 * `readHostAllowlist`):
 *
 *   `<hostDir>/dsh-host-manifest.json` present  its `plugins` section, which
 *                                               the build audited (packaged)
 *   absent                                      `<hostDir>/plugins/allowlist.json`
 *                                               with the build's own
 *                                               `parseAllowlist` (checkout);
 *                                               descriptions come from the
 *                                               installed packages, as the
 *                                               build's `displayOf` takes them
 *
 * Read-only, and never the user's data: only the app's own install tree.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type PluginKind, type PluginToolClass, parseAllowlist } from '@shared/dshPluginAllowlist';
import type { DshPluginCatalogEntry } from '@shared/dshPluginSettings';
import { isDshPluginPackageName } from '@shared/dshPlugins';
import { app } from 'electron';
import { DSH_HOST_LAYOUT } from '../agent-host/DshHostProcess';

export const DSH_HOST_MANIFEST_FILE = 'dsh-host-manifest.json';
export const DSH_PLUGIN_ALLOWLIST_FILE = path.join('plugins', 'allowlist.json');

export interface DshPluginCatalog {
  plugins: DshPluginCatalogEntry[];
  /** Why nothing could be read; `plugins` is empty then. */
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function reviewOf(raw: unknown): DshPluginCatalogEntry['review'] {
  if (!isRecord(raw)) return null;
  const { date, verdict } = raw;
  if (typeof date !== 'string' || !DATE.test(date)) return null;
  if (verdict !== 'approved' && verdict !== 'conditional') return null;
  return { date, verdict };
}

/**
 * The allowlist's `tools` map split by gate class. Anything that is not a
 * read or write refinement counts as "ask" — the gate's own default for a
 * plugin tool (decision 047), so a malformed class never looks harmless.
 */
export function toolAccessOf(
  tools: unknown
): Pick<DshPluginCatalogEntry, 'readTools' | 'writeTools' | 'askTools' | 'unlistedToolsAsk'> {
  const readTools: string[] = [];
  const writeTools: string[] = [];
  const askTools: string[] = [];
  let unlistedToolsAsk = false;
  if (isRecord(tools)) {
    for (const [name, value] of Object.entries(tools as Record<string, PluginToolClass>)) {
      if (name === '*') {
        unlistedToolsAsk = true;
        continue;
      }
      if (isRecord(value) && value.class === 'read') readTools.push(name);
      else if (isRecord(value) && value.class === 'write') writeTools.push(name);
      else askTools.push(name);
    }
  }
  return {
    readTools: readTools.sort(),
    writeTools: writeTools.sort(),
    askTools: askTools.sort(),
    unlistedToolsAsk,
  };
}

function entryOf(raw: Record<string, unknown>, description: string): DshPluginCatalogEntry | null {
  const { name, version, kind, defaultEnabled } = raw;
  if (!isDshPluginPackageName(name)) return null;
  if (typeof version !== 'string' || version === '') return null;
  if (kind !== 'official' && kind !== 'internal') return null;
  if (typeof defaultEnabled !== 'boolean') return null;
  return {
    name,
    version,
    kind: kind as PluginKind,
    defaultEnabled,
    description,
    ...toolAccessOf(raw.tools),
    review: reviewOf(raw.review),
  };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * A packaged host's catalog: the manifest's `plugins` section. An entry
 * without a name, version, kind or `defaultEnabled` is left out, as the host
 * leaves it out (`allowlistFromManifest`); later duplicates too.
 */
export function catalogFromManifest(section: unknown): DshPluginCatalog {
  if (!Array.isArray(section)) {
    return { plugins: [], error: `${DSH_HOST_MANIFEST_FILE} has no plugins section` };
  }
  const plugins: DshPluginCatalogEntry[] = [];
  for (const raw of section) {
    if (!isRecord(raw)) continue;
    const display = isRecord(raw.display) ? raw.display : {};
    const entry = entryOf(raw, text(display.description) ?? text(raw.description) ?? '');
    if (entry && !plugins.some((plugin) => plugin.name === entry.name)) plugins.push(entry);
  }
  return { plugins, error: null };
}

/**
 * A checkout's catalog: `plugins/allowlist.json` by the build's rules (only
 * the entries that pass). `describe` supplies each package's description.
 */
export function catalogFromAllowlist(
  raw: unknown,
  describe: (name: string) => string
): DshPluginCatalog {
  const { allowlist } = parseAllowlist(raw);
  const plugins: DshPluginCatalogEntry[] = [];
  for (const item of allowlist.plugins) {
    const entry = entryOf(item as unknown as Record<string, unknown>, describe(item.name));
    if (entry) plugins.push(entry);
  }
  return { plugins, error: null };
}

export interface CatalogFiles {
  /** The host's directory: where `host.js` (or `host.ts`) lives. */
  hostDir: string;
  /** Throws like `fs.readFileSync` (`code: 'ENOENT'` for a missing file). */
  readText: (file: string) => string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A checkout's package description, the way the build's `displayOf` takes
 * it: `locale/en.json`'s `description`, else `package.json`'s. Empty when
 * neither can be read (the page then shows its own summary, or nothing).
 */
function describeInstalled(files: CatalogFiles, name: string): string {
  const dir = path.join(files.hostDir, 'node_modules', ...name.split('/'));
  const field = (file: string): string | undefined => {
    try {
      const parsed: unknown = JSON.parse(files.readText(path.join(dir, file)));
      return isRecord(parsed) ? text(parsed.description) : undefined;
    } catch {
      return undefined;
    }
  };
  return field(path.join('locale', 'en.json')) ?? field('package.json') ?? '';
}

/** The catalog of the host at `files.hostDir`, by the host's own packaged/checkout rule. */
export function readDshPluginCatalog(files: CatalogFiles): DshPluginCatalog {
  const manifestFile = path.join(files.hostDir, DSH_HOST_MANIFEST_FILE);
  let manifest: string | null = null;
  try {
    manifest = files.readText(manifestFile);
  } catch (error) {
    if (!isMissing(error)) {
      return { plugins: [], error: `${manifestFile} is unreadable: ${messageOf(error)}` };
    }
  }
  if (manifest !== null) {
    try {
      const parsed: unknown = JSON.parse(manifest);
      return catalogFromManifest(isRecord(parsed) ? parsed.plugins : undefined);
    } catch (error) {
      return { plugins: [], error: `${manifestFile} is not valid JSON: ${messageOf(error)}` };
    }
  }
  const allowlistFile = path.join(files.hostDir, DSH_PLUGIN_ALLOWLIST_FILE);
  try {
    const parsed: unknown = JSON.parse(files.readText(allowlistFile));
    return catalogFromAllowlist(parsed, (name) => describeInstalled(files, name));
  } catch (error) {
    return { plugins: [], error: `${allowlistFile} is unreadable: ${messageOf(error)}` };
  }
}

/** The running app's host directory, from the same layout the host launch uses. */
export function currentDshHostDir(): string {
  const layout = app.isPackaged ? DSH_HOST_LAYOUT.packaged : DSH_HOST_LAYOUT.unpackaged;
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return path.join(root, ...layout.entry.slice(0, -1));
}

/** The catalog this running app ships. */
export function readCurrentDshPluginCatalog(): DshPluginCatalog {
  return readDshPluginCatalog({
    hostDir: currentDshHostDir(),
    readText: (file) => readFileSync(file, 'utf8'),
  });
}
