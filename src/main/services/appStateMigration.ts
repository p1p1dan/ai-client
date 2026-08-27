/**
 * One-shot move of an existing install onto the S2 layout.
 *
 * Two things move, from two different places:
 *
 *  - `~/.aiclient/*`            ->  `~/.pilab/<profile>/*`      (the rename)
 *  - `<userData>/credentials/*` ->  `~/.pilab/<profile>/credentials/*`  (the merge)
 *
 * The hard requirement this file exists to meet: **an existing user must never
 * be asked to log in again.** The credential vault is the thing that decides
 * that, so it is copied before anything can read from the new root.
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

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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

  const hasLegacyRoot = existsSync(input.legacyRoot);
  const hasLegacyCredentials = existsSync(input.legacyCredentialsDir);
  if (!hasLegacyRoot && !hasLegacyCredentials) {
    // A fresh install. Deliberately no marker: writing one would mean a user
    // who restores `~/.aiclient` from a backup tomorrow never gets migrated.
    return { kind: 'skipped', reason: 'nothing_to_migrate' };
  }

  const copied: string[] = [];
  const skippedExisting: string[] = [];
  try {
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
