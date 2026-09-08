/**
 * A3 — the model catalog that ships inside the release artifact.
 *
 * ## Why it exists
 *
 * Since plan D03 there is no built-in model table: a startup that cannot reach
 * `/api/v1/models-config` reports `unavailable`, and the user gets an empty
 * model menu with nothing to select. That is one failure mode wearing three
 * hats — a first launch with no cache, a weak network, and a management
 * endpoint that is down — and until now none of them had a local floor.
 *
 * The snapshot is that floor. It is read with NO network I/O, so a cold launch
 * has a catalog before the first fetch is even attempted; the background sync
 * then supersedes it through the ordinary state file.
 *
 * ## What it is not
 *
 * Not a second authority. It comes out of the same management endpoint as the
 * live catalog and differs only in age, which is why the sync state gets its
 * own `'bundled'` value: the UI has to be able to say "this is the baseline we
 * shipped with", never to present it as a fresh answer. Nothing here consults
 * `models.dev` or any other external directory — our catalog has one origin.
 *
 * ## Why nothing in this module ever writes
 *
 * Following ADR 0134 §3: the snapshot is a build artifact, replaced only by
 * `scripts/refresh-model-catalog.mjs` before a release is tagged. A runtime
 * refresh replaces the in-process catalog and nothing else — it must not
 * rewrite the packaged file, and it must not drop a copy in the user's data
 * directory, because a per-machine cache is how two installs of one release
 * end up running different configurations and the artifact stops being
 * reproducible.
 *
 * ## Why it validates with credentials FORBIDDEN
 *
 * Every other reader of a catalog passes `credentialsAllowed: true`, because
 * what it is reading is this client's own 0600 copy of an authenticated
 * response. This file is the opposite: it is world-readable inside the package,
 * so a provider key in it would be published to everyone who downloads the app.
 * Validating with credentials forbidden turns that from a review question into
 * a rejected snapshot.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PiManagedModelsConfig } from '@shared/piModelConfig';
import { validatePiManagedModelsConfig } from './configValidation';

/** Directory name under `resources/` (dev) and `<resources>/` (packaged). */
export const MODEL_CATALOG_DIR_NAME = 'model-catalog';
export const MODEL_CATALOG_SNAPSHOT_FILE_NAME = 'snapshot.json';

/** Same ceiling the live fetch enforces; a snapshot is the same document. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/** Returns the bundled catalog, or `null` when there is no usable one. */
export type BundledCatalogReader = () => PiManagedModelsConfig | null;

/**
 * Where to look, expressed as plain values rather than read off `electron`.
 *
 * This module is imported by `PiModelConfigService`, which is covered by tests
 * that run under vitest's `node` environment — importing `app` would make the
 * whole service unloadable there. `process.resourcesPath` is enough on its own:
 * it is set in a packaged Electron main process and points at the directory
 * `extraResources` fills, and in development it points into the Electron
 * install, where the miss simply falls through to the checked-in copy.
 */
export interface BundledCatalogLocation {
  /** `process.resourcesPath`; absent outside Electron. */
  resourcesPath?: string | undefined;
  /** Repository root in development (`process.cwd()`). */
  cwd?: string | undefined;
}

/** Ordered, de-duplicated places the snapshot may live. */
export function bundledCatalogCandidates(location: BundledCatalogLocation): string[] {
  const roots = [location.resourcesPath, location.cwd ? join(location.cwd, 'resources') : null];
  const candidates = roots
    .filter((root): root is string => Boolean(root?.trim()))
    .map((root) => join(root, MODEL_CATALOG_DIR_NAME, MODEL_CATALOG_SNAPSHOT_FILE_NAME));
  return [...new Set(candidates)];
}

/**
 * Read and validate one candidate file.
 *
 * Never throws, and never returns an empty catalog. A snapshot with no models
 * is treated exactly like a missing one, because `'bundled'` with zero models
 * would be indistinguishable from a management endpoint that answered and had
 * nothing enabled — the very confusion D03 removed. "No baseline" has to stay
 * sayable.
 */
export function readBundledCatalogFile(filePath: string): PiManagedModelsConfig | null {
  try {
    if (!existsSync(filePath)) return null;
    if (statSync(filePath).size > MAX_SNAPSHOT_BYTES) return null;
    const config = validatePiManagedModelsConfig(
      JSON.parse(readFileSync(filePath, 'utf8')) as unknown,
      { credentialsAllowed: false }
    );
    const models = Object.values(config.providers).reduce(
      (sum, provider) => sum + provider.models.length,
      0
    );
    return models > 0 ? config : null;
  } catch {
    // A corrupt snapshot must never take the launch down with it: the app is
    // still perfectly able to fetch a live catalog, and this file is only the
    // floor beneath that.
    return null;
  }
}

/**
 * A reader that looks at each candidate once and remembers the answer.
 *
 * Memoized because the snapshot cannot change while the process runs — it is
 * packaged, and nothing in this app writes it — while `readState` and
 * `readCatalog` are called on every settings render and every catalog request.
 */
export function createBundledCatalogReader(
  location: BundledCatalogLocation = {
    resourcesPath: process.resourcesPath,
    cwd: process.cwd(),
  }
): BundledCatalogReader {
  let resolved = false;
  let cached: PiManagedModelsConfig | null = null;
  return () => {
    if (resolved) return cached;
    resolved = true;
    for (const candidate of bundledCatalogCandidates(location)) {
      cached = readBundledCatalogFile(candidate);
      if (cached) break;
    }
    return cached;
  };
}
