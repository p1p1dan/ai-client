/**
 * One-shot move of an existing install onto the S2 layout.
 *
 * Three things move, from three different places:
 *
 *  - `~/.pilab/<prior productName>/*`  ->  `~/.pilab/<profile>/*`  (the product rename)
 *  - `~/.aiclient/*`            ->  `~/.pilab/<profile>/*`      (the directory rename)
 *  - `<userData>/credentials/*` ->  `~/.pilab/<profile>/credentials/*`  (the merge)
 *
 * The hard requirement this file exists to meet: **an existing user must never
 * be asked to log in again.** The credential vault is the thing that decides
 * that, so it is copied before anything can read from the new root.
 *
 * The first line is the newest: `productName` went `AiClient` -> `PiLab Ai` in
 * 1.0.0-test.17, and `<profile>` is `<userData>`'s basename, so a tester who
 * had been running `AiClient` has a full state root sitting under the old name.
 * See `PRIOR_USER_DATA_DIR_NAMES` in `@shared/appStateLayout`.
 *
 * ## The `<userData>` half — three gaps found 2026-09-21, all closed
 *
 * Found on a tester's Windows machine upgrading 1.0.0-test.16 -> test.18: every
 * session file was copied and the sidebar still came up empty.
 *
 *  1. **The prior name was wrong** — `PRIOR_USER_DATA_DIR_NAMES` said
 *     `AiClient`, read off `electron-builder.yml`'s `productName`. Electron
 *     names `<userData>` from the packaged `package.json`, which had no
 *     `productName` key, so every pre-test.17 install actually wrote
 *     `jyw-ai-client`. FIXED (`d4b9445e`) — see that constant's own note.
 *  2. **`<appData>/<name>/Local Storage/`** holds the REPOSITORY LIST
 *     (`aiclient-repositories` and the rest of `renderer/App/storage.ts`).
 *     FIXED in two layers. `migratePriorUserData` below copies the directory
 *     WHOLE when the destination is absent (every v0.3.4 user) — never
 *     `copyTree`'s per-file merge, which would splice an old MANIFEST into a
 *     new store. When the destination already exists (a machine that booted
 *     test.17+), `priorLocalStorageImport.ts` merges key by key through
 *     Chromium, because without the repositories the conversation list below
 *     has nothing to hang under. The origin is `file://` in v0.3.4 and today
 *     alike, so the copied keys are read back as-is (measured on Windows,
 *     Electron 39.3, 2026-09-23).
 *  3. **`<appData>/<name>/session-index.json`** IS the conversation list
 *     (`services/chat/SessionIndexService.ts`), and each row's
 *     `runtimeIdentity` is an ABSOLUTE `.jsonl` path carrying the old profile
 *     name. FIXED: `migratePriorUserData` merges it by `sessionId` and
 *     re-points each carried row at the new root when — and only when — the
 *     `.jsonl` is there (`rewriteRuntimeIdentity`).
 *
 * Both new steps have their OWN markers. `.migrated-from-aiclient` is already
 * present on every test.17+ machine, written by a build that never carried
 * these files, so gating on it would have locked exactly those machines out.
 *
 * `session-state.json`'s `localStorage` mirror looks like it should cover (2),
 * but it does not: `preload` exposes the `sessionStorage` bridge and NOTHING in
 * the renderer calls it, so the mirror is write-only and reads back empty.
 *
 * Handover notes and evidence:
 * `docs/plantree/plans/runtime-hardening/topics/app-state-migration-gaps.md`.
 *
 * ## Why COPY and never move
 *
 * Two reasons, and the first one is a correctness bug waiting to happen:
 *
 *  1. The legacy root has NO profile layer — `~/.aiclient` is shared by the
 *     release build and the dev build. If the first one to boot MOVED those
 *     bytes into its own profile, the second would find an empty legacy root
 *     and come up factory-fresh. Copying lets both migrate from the same
 *     source, which is exactly what the profile layer is supposed to allow.
 *  2. A copy leaves a working rollback. The old build reads the old paths and
 *     still finds everything where it left it.
 *
 * The cost is disk that is never reclaimed. That is the intended trade: this
 * directory holds settings and a small vault, not caches.
 *
 * ## Never overwrite the destination
 *
 * Every copy is skipped when the destination already exists. That makes the
 * whole thing idempotent and re-entrant, and it means a user who has already
 * used the new build (and changed a setting) cannot have that setting reverted
 * by a stale legacy file. "First writer wins" is the rule, and the new
 * location is always considered the newer writer.
 *
 * ## No `electron` import
 *
 * Every root is a parameter, so the tests run against `mkdtemp` directories.
 * `main/index.ts` supplies the real ones, immediately after
 * `app.setPath('userData', …)` and before any service touches a path.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** Written into the new root once something was actually copied. Presence short-circuits every later boot. */
export const MIGRATION_MARKER_FILE_NAME = '.migrated-from-aiclient';

export interface AppStateMigrationInput {
  /** `~/.aiclient` — the pre-rename root, shared by every profile. */
  legacyRoot: string;
  /** `<userData>/credentials` — where the vault lived before S2. */
  legacyCredentialsDir: string;
  /** `~/.pilab/<profile>` — this install's new root. */
  newRoot: string;
  /** `~/.pilab/<profile>/credentials` — where the vault lives from S2 on. */
  newCredentialsDir: string;
  /**
   * Roots written under an earlier `productName`, newest first — see
   * `getPriorInstallRoots()`. Empty for dev builds, whose `<userData>` name has
   * never depended on the product name.
   */
  priorInstalls?: PriorInstallSource[];
}

/** One earlier `productName`'s pair of roots. Mirrors `appStatePaths.PriorInstallRoots`. */
export interface PriorInstallSource {
  /** `~/.pilab/<former productName>` — already in the S2 layout, vault included. */
  root: string;
  /** `<appData>/<former productName>/credentials` — that release's pre-S2 vault. */
  credentialsDir: string;
}

export type AppStateMigrationOutcome =
  | { kind: 'skipped'; reason: 'marker_present' | 'nothing_to_migrate' }
  | { kind: 'migrated'; copied: string[]; skippedExisting: string[] }
  | { kind: 'failed'; error: string; copied: string[] };

/**
 * Copies one tree, skipping anything already present at the destination.
 * Records what it did into `copied` / `skippedExisting` as repo-relative-ish
 * labels, so a caller can log the shape of a migration without logging paths
 * that may contain a username.
 */
function copyTree(
  sourceDir: string,
  targetDir: string,
  label: string,
  copied: string[],
  skippedExisting: string[]
): void {
  if (!existsSync(sourceDir)) {
    return;
  }
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const from = join(sourceDir, entry.name);
    const to = join(targetDir, entry.name);
    const entryLabel = label ? `${label}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      copyTree(from, to, entryLabel, copied, skippedExisting);
      continue;
    }
    // Symlinks and sockets are not things this directory is supposed to hold;
    // copying them blind is how a migration follows a link somewhere it was
    // never asked to write.
    if (!entry.isFile()) {
      continue;
    }
    if (existsSync(to)) {
      skippedExisting.push(entryLabel);
      continue;
    }
    // `copyFileSync` — not `writeFileSync(to, readFileSync(from))` — because
    // it carries the source's permission bits over, and one of the files being
    // carried is the credential vault at 0600. A read+write would recreate it
    // at the process umask (0644 on a default Linux box), which is a
    // credential file the whole machine can read.
    // [实测] the migration test asserts the resulting mode, and swapping in a
    // read+write turns it red with 436 (0o664) against the expected 384 (0o600).
    // A follow-up `chmodSync` was written here first and then removed: no
    // mutation could kill it, precisely because `copyFileSync` had already
    // done the job.
    copyFileSync(from, to);
    copied.push(entryLabel);
  }
}

/**
 * Runs the migration if it has not run before. Safe to call on every boot.
 *
 * Never throws: a machine that cannot be migrated must still start. The
 * failure is reported so the caller can log it, and the marker is NOT written,
 * so the next boot tries again.
 */
export function migrateAppState(input: AppStateMigrationInput): AppStateMigrationOutcome {
  const markerPath = join(input.newRoot, MIGRATION_MARKER_FILE_NAME);
  if (existsSync(markerPath)) {
    return { kind: 'skipped', reason: 'marker_present' };
  }

  // A root equal to the destination would be the app copying onto itself —
  // harmless (every `to` already exists, so every entry is skipped) but
  // meaningless. Dropping it keeps `nothing_to_migrate` honest on a build whose
  // `<userData>` name has been set back to a former one.
  const priorInstalls = (input.priorInstalls ?? []).filter((prior) => prior.root !== input.newRoot);

  const hasLegacyRoot = existsSync(input.legacyRoot);
  const hasLegacyCredentials = existsSync(input.legacyCredentialsDir);
  const hasPriorInstall = priorInstalls.some(
    (prior) => existsSync(prior.root) || existsSync(prior.credentialsDir)
  );
  if (!hasLegacyRoot && !hasLegacyCredentials && !hasPriorInstall) {
    // A fresh install. Deliberately no marker: writing one would mean a user
    // who restores `~/.aiclient` from a backup tomorrow never gets migrated.
    return { kind: 'skipped', reason: 'nothing_to_migrate' };
  }

  const copied: string[] = [];
  const skippedExisting: string[] = [];
  try {
    // Newest source first, because "first writer wins" makes this ordering the
    // precedence rule. A prior install's root is already in the S2 layout — it
    // carries that release's vault in its own `credentials/` sub-tree — so it
    // outranks every pre-S2 source below it.
    for (const prior of priorInstalls) {
      copyTree(prior.root, input.newRoot, '', copied, skippedExisting);
    }
    for (const prior of priorInstalls) {
      copyTree(
        prior.credentialsDir,
        input.newCredentialsDir,
        'credentials',
        copied,
        skippedExisting
      );
    }

    // Credentials first. Everything else is a preference; this is the file
    // that decides whether the user is still logged in.
    copyTree(
      input.legacyCredentialsDir,
      input.newCredentialsDir,
      'credentials',
      copied,
      skippedExisting
    );
    copyTree(input.legacyRoot, input.newRoot, '', copied, skippedExisting);

    mkdirSync(input.newRoot, { recursive: true });
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf-8');
  } catch (error) {
    return {
      kind: 'failed',
      error: error instanceof Error ? error.message : String(error),
      copied,
    };
  }

  return { kind: 'migrated', copied, skippedExisting };
}

// ---------------------------------------------------------------------------
// `<userData>` half: the repository list and the conversation list.
// ---------------------------------------------------------------------------

/**
 * Written into `<userData>` once the two `<userData>` steps below have run.
 *
 * Deliberately NOT `MIGRATION_MARKER_FILE_NAME`: every test.17+ machine
 * already carries that marker, and it was written by a build that never
 * copied these two things — reusing it would lock those machines out of the
 * fix forever.
 */
export const PRIOR_USER_DATA_MARKER_FILE_NAME = '.migrated-prior-userdata';

/** Chromium's per-origin DOM storage (leveldb). Holds `aiclient-repositories`. */
export const LOCAL_STORAGE_DIR_NAME = 'Local Storage';

/** `SessionIndexService`'s file — the conversation list. */
export const SESSION_INDEX_FILE_NAME = 'session-index.json';

export interface PriorUserDataMigrationInput {
  /** This install's `<userData>`. */
  userDataDir: string;
  /** `~/.pilab/<profile>` — where a rewritten `runtimeIdentity` has to point. */
  newRoot: string;
  /**
   * `<appData>/<former name>` for each earlier packaged release, newest first.
   * The basename IS the former profile name, which is what the identity
   * rewrite looks for. Empty for dev builds.
   */
  priorUserDataDirs: string[];
}

export interface SessionIndexMergeStats {
  /** Rows carried over from an older index. */
  added: number;
  /** Rows skipped because the new index already has that `sessionId`. */
  keptExisting: number;
  /** Added rows whose `runtimeIdentity` now points into the new root. */
  identityRewritten: number;
  /** Added rows left on their old path because the new `.jsonl` does not exist. */
  identityKept: number;
  /** Older index files that could not be parsed and were ignored. */
  unreadableSources: number;
}

export type PriorUserDataMigrationOutcome =
  | { kind: 'skipped'; reason: 'marker_present' | 'nothing_to_migrate' }
  | {
      kind: 'migrated';
      localStorage: 'copied' | 'kept_existing' | 'no_source';
      sessionIndex: SessionIndexMergeStats;
    }
  | { kind: 'failed'; error: string };

function lastSegment(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Points one `runtimeIdentity` (an ABSOLUTE `.jsonl` path) at the new profile.
 *
 * `.pilab/<former name>/` and the older `.aiclient/` both become
 * `.pilab/<new profile>/`. Matching is by path SEGMENT, case-insensitively and
 * with either separator on each side, because this string was written by a
 * Windows build and Windows paths are neither case- nor separator-sensitive;
 * everything before and after the matched segment is kept byte for byte.
 *
 * The rewrite is only taken when `exists` says the new file is there. When it
 * is not, the old path is the better answer: the old directory is never
 * deleted, so the old path still resolves, and a rewritten one would not.
 */
export function rewriteRuntimeIdentity(
  identity: string,
  options: {
    priorProfileNames: string[];
    newProfileName: string;
    exists: (path: string) => boolean;
  }
): { identity: string; outcome: 'unchanged' | 'rewritten' | 'kept_missing' } {
  const names = options.priorProfileNames
    .filter((name) => name && name.toLowerCase() !== options.newProfileName.toLowerCase())
    .map(escapeRegExp);
  const patterns: RegExp[] = [];
  if (names.length > 0) {
    patterns.push(new RegExp(`([\\\\/])\\.pilab[\\\\/](?:${names.join('|')})(?=[\\\\/])`, 'i'));
  }
  patterns.push(/([\\/])\.aiclient(?=[\\/])/i);

  for (const pattern of patterns) {
    const match = pattern.exec(identity);
    if (!match) continue;
    const separator = match[1];
    const candidate =
      identity.slice(0, match.index) +
      `${separator}.pilab${separator}${options.newProfileName}` +
      identity.slice(match.index + match[0].length);
    return options.exists(candidate)
      ? { identity: candidate, outcome: 'rewritten' }
      : { identity, outcome: 'kept_missing' };
  }
  return { identity, outcome: 'unchanged' };
}

type IndexRow = { sessionId: string; runtimeIdentity?: unknown } & Record<string, unknown>;

/** Same tolerance as `SessionIndexService`: a bare array, rows kept iff they carry a `sessionId`. */
function readIndexRows(file: string): IndexRow[] {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
  if (!Array.isArray(parsed)) {
    throw new Error('the top level is not a JSON array');
  }
  return parsed.filter(
    (row): row is IndexRow =>
      !!row &&
      typeof row === 'object' &&
      typeof (row as { sessionId?: unknown }).sessionId === 'string' &&
      (row as { sessionId: string }).sessionId.length > 0
  );
}

/**
 * Whole-directory copy for Chromium's leveldb.
 *
 * `copyTree`'s per-file "skip existing" would splice an old `MANIFEST` /
 * `CURRENT` into a new store, so the unit here is the directory: an existing
 * destination is kept whole, and an absent one is filled in a staging
 * directory and swapped in with one `rename`. The staging step is what keeps a
 * crash mid-copy from leaving a half store that every later boot would then
 * see as "already exists" and keep forever.
 */
function copyDirectoryWhole(sourceDir: string, targetDir: string): 'copied' | 'kept_existing' {
  if (existsSync(targetDir)) {
    return 'kept_existing';
  }
  const stagingDir = `${targetDir}.migrating`;
  // Only ever this function's own leftover from an interrupted earlier attempt.
  rmSync(stagingDir, { recursive: true, force: true });
  copyTree(sourceDir, stagingDir, '', [], []);
  renameSync(stagingDir, targetDir);
  return 'copied';
}

/**
 * Carries the repository list (`Local Storage`) and the conversation list
 * (`session-index.json`) over from an earlier release's `<userData>`.
 *
 * Runs AFTER `migrateAppState`, because a rewritten `runtimeIdentity` is only
 * taken when the `.jsonl` it names already sits in the new root — and BEFORE
 * any `BrowserWindow`, because Chromium opens `Local Storage` with the first
 * renderer and the copy must not race it. A `Local Storage` that already
 * exists is left whole here and filled key by key later, before the main
 * window, by `priorLocalStorageImport.ts`.
 *
 * Same rules as the rest of this file: copy never move, first writer wins,
 * never throws, no marker on failure so the next boot retries.
 */
export function migratePriorUserData(
  input: PriorUserDataMigrationInput
): PriorUserDataMigrationOutcome {
  const markerPath = join(input.userDataDir, PRIOR_USER_DATA_MARKER_FILE_NAME);
  if (existsSync(markerPath)) {
    return { kind: 'skipped', reason: 'marker_present' };
  }

  const priors = input.priorUserDataDirs.filter((dir) => dir !== input.userDataDir);
  const localStorageSource = priors
    .map((dir) => join(dir, LOCAL_STORAGE_DIR_NAME))
    .find((dir) => existsSync(dir));
  const indexSources = priors
    .map((dir) => ({ name: lastSegment(dir), file: join(dir, SESSION_INDEX_FILE_NAME) }))
    .filter((source) => existsSync(source.file));
  if (!localStorageSource && indexSources.length === 0) {
    // Same reasoning as `nothing_to_migrate` above: no marker, so an old
    // `<userData>` restored later is still picked up.
    return { kind: 'skipped', reason: 'nothing_to_migrate' };
  }

  const stats: SessionIndexMergeStats = {
    added: 0,
    keptExisting: 0,
    identityRewritten: 0,
    identityKept: 0,
    unreadableSources: 0,
  };
  try {
    const localStorage = localStorageSource
      ? copyDirectoryWhole(localStorageSource, join(input.userDataDir, LOCAL_STORAGE_DIR_NAME))
      : 'no_source';

    if (indexSources.length > 0) {
      const targetFile = join(input.userDataDir, SESSION_INDEX_FILE_NAME);
      // A target that exists but will not parse THROWS here, on purpose: this
      // step must never replace rows it cannot read. `SessionIndexService`
      // sets such a file aside on its next load, and the next boot retries.
      const merged: IndexRow[] = existsSync(targetFile) ? readIndexRows(targetFile) : [];
      const known = new Set(merged.map((row) => row.sessionId));
      const priorProfileNames = priors.map(lastSegment);
      const newProfileName = lastSegment(input.newRoot);

      for (const source of indexSources) {
        let rows: IndexRow[];
        try {
          rows = readIndexRows(source.file);
        } catch {
          stats.unreadableSources += 1;
          continue;
        }
        for (const row of rows) {
          if (known.has(row.sessionId)) {
            stats.keptExisting += 1;
            continue;
          }
          known.add(row.sessionId);
          let next = row;
          if (typeof row.runtimeIdentity === 'string') {
            const result = rewriteRuntimeIdentity(row.runtimeIdentity, {
              priorProfileNames,
              newProfileName,
              exists: existsSync,
            });
            if (result.outcome === 'rewritten') {
              next = { ...row, runtimeIdentity: result.identity };
              stats.identityRewritten += 1;
            } else if (result.outcome === 'kept_missing') {
              stats.identityKept += 1;
            }
          }
          merged.push(next);
          stats.added += 1;
        }
      }

      if (stats.added > 0) {
        mkdirSync(input.userDataDir, { recursive: true });
        const tempFile = `${targetFile}.migrating.tmp`;
        writeFileSync(tempFile, JSON.stringify(merged), 'utf-8');
        renameSync(tempFile, targetFile);
      }
    }

    mkdirSync(input.userDataDir, { recursive: true });
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf-8');
    return { kind: 'migrated', localStorage, sessionIndex: stats };
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
