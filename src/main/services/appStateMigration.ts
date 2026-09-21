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
 * ## ⚠️ What this does NOT migrate — three known gaps, 2026-09-21
 *
 * Found on a tester's Windows machine upgrading 1.0.0-test.16 -> test.18. The
 * name gap below is fixed (`d4b9445e`); the other two are NOT, and together
 * they mean an upgraded install still comes up with an empty sidebar even
 * though every session file was copied.
 *
 *  1. **The prior name was wrong** — `PRIOR_USER_DATA_DIR_NAMES` said
 *     `AiClient`, read off `electron-builder.yml`'s `productName`. Electron
 *     names `<userData>` from the packaged `package.json`, which had no
 *     `productName` key, so every pre-test.17 install actually wrote
 *     `jyw-ai-client`. FIXED — see that constant's own note.
 *  2. **`<appData>/<name>/Local Storage/` is never copied.** Chromium's leveldb
 *     holds the REPOSITORY LIST (`aiclient-repositories` and the rest of
 *     `renderer/App/storage.ts`'s keys). NOT FIXED. Note that `copyTree`'s
 *     per-file "skip existing" is WRONG for leveldb: a half-merged store with
 *     a stale MANIFEST is worse than no copy, so this one needs
 *     whole-directory granularity — copy only when the destination directory
 *     is absent.
 *  3. **`<appData>/<name>/session-index.json` is never copied.** That file IS
 *     the conversation list (`services/chat/SessionIndexService.ts:95`), and
 *     each row's `runtimeIdentity` is an ABSOLUTE path to the `.jsonl`
 *     containing the old profile name — so copying it is not enough, the paths
 *     have to be rewritten onto the new root. NOT FIXED.
 *
 * `session-state.json`'s `localStorage` mirror looks like it should cover (2),
 * but it does not: `preload` exposes the `sessionStorage` bridge and NOTHING in
 * the renderer calls it, so the mirror is write-only and reads back empty.
 *
 * Deliberately left unfixed here rather than patched blind: the evidence is in
 * Windows-only paths this repo's dev machine cannot exercise (user decision,
 * 2026-09-21). Handover notes:
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
