/**
 * Applies `planLocalStorageMerge` through Chromium itself, so the repository
 * list reaches a `Local Storage` the new build has already created.
 *
 * Why Chromium and not a leveldb reader: the store is Chromium's own format
 * (snappy blocks, a MANIFEST, a write-ahead log), and the one component that
 * is guaranteed to read and write it correctly is the one that will read it
 * back. The origin is `file://` in both v0.3.4 and today (both `loadFile` the
 * renderer, neither sets a partition), so a blank local page sees exactly the
 * keys the app sees — measured on Windows with Electron 39.3, 2026-09-23.
 *
 * ## The earlier store is never opened in place
 *
 * Chromium rewrites a store it opens (log recovery, compaction, a new LOG), and
 * the old directory has to stay untouched so the old build can be rolled back
 * to. Each earlier `Local Storage` is copied into a scratch profile under this
 * `<userData>` and read from there via `session.fromPath`.
 *
 * ## No `BrowserWindow`
 *
 * Unattached `WebContentsView`s only. The first `BrowserWindow` fires
 * `browser-window-created`, which `main/index.ts` uses as the vault's crypto
 * upgrade latch, and closing the last one fires `window-all-closed`, which
 * quits the app. Both were measured NOT to fire for a `WebContentsView`.
 *
 * Must finish before the main window loads: the renderer hydrates the
 * repository list from `localStorage` once, on mount.
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { session, WebContentsView } from 'electron';
import { LOCAL_STORAGE_DIR_NAME } from './appStateMigration';
import { planLocalStorageMerge } from './priorLocalStorageMerge';

/** Its own marker, like `PRIOR_USER_DATA_MARKER_FILE_NAME`: written only after the merge reached disk. */
export const PRIOR_LOCAL_STORAGE_MARKER_FILE_NAME = '.migrated-prior-local-storage';

/** Scratch copies of the earlier stores; removed on the next boot, once no session holds them. */
const SCRATCH_DIR_NAME = '.prior-local-storage';

/** A hung renderer must not hold the app's startup hostage; the next boot retries. */
const STEP_TIMEOUT_MS = 15_000;

/**
 * How long the merged keys get to become durable before the marker is withheld.
 *
 * The cost of waiting is startup latency on the ONE boot that migrates; the
 * cost of not waiting is the defect this loop exists to close. Total budget is
 * the timeout, not the per-attempt one: every attempt is a fresh read of one
 * key out of a small `file://` store.
 */
const PERSIST_CONFIRM_TIMEOUT_MS = 5_000;
const PERSIST_CONFIRM_INTERVAL_MS = 50;

export type PriorLocalStorageImportOutcome =
  | { kind: 'skipped'; reason: 'marker_present' | 'nothing_to_migrate' }
  | { kind: 'migrated'; addedKeys: number; addedRepositories: number; addedGroups: number }
  | { kind: 'failed'; error: string };

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), STEP_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const READ_ALL = `JSON.stringify(Object.fromEntries(
  Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])
))`;

/** One key, or `null`. Used to confirm a write survived, not to plan one. */
const readKey = (key: string) => `localStorage.getItem(${JSON.stringify(key)})`;

/** Loads the blank page in `ses` and runs `use` against it. The view is always closed. */
async function withBlankPage<T>(
  ses: Electron.Session,
  blankPage: string,
  use: (run: (script: string) => Promise<unknown>) => Promise<T>
): Promise<T> {
  const view = new WebContentsView({
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await withTimeout(view.webContents.loadFile(blankPage), 'loading the blank page');
    return await use((script) =>
      withTimeout(view.webContents.executeJavaScript(script), 'a localStorage script')
    );
  } finally {
    view.webContents.close();
  }
}

/**
 * Reads the planned keys back out of `ses` until they all match, or gives up.
 *
 * Deliberately a FRESH page load per round (via `withBlankPage`), not the page
 * that did the writing: a script that re-reads from the same context can be
 * answered out of that renderer's in-memory DOM storage, which proves nothing
 * about what reached disk. A new page faces the same question the next boot
 * will face.
 *
 * Never throws — a page that will not load is reported as "nothing confirmed",
 * which withholds the marker, which is the correct answer for a boot that
 * could not verify its own work.
 */
async function confirmWrittenKeys(
  ses: Electron.Session,
  blankPage: string,
  writes: Record<string, string>
): Promise<{ missingKeys: string[] }> {
  const keys = Object.keys(writes);
  if (keys.length === 0) return { missingKeys: [] };

  const deadline = Date.now() + PERSIST_CONFIRM_TIMEOUT_MS;
  let missingKeys = keys;
  for (;;) {
    try {
      const observed = await withBlankPage(ses, blankPage, async (run) => {
        const seen: Record<string, string | null> = {};
        for (const key of keys) seen[key] = (await run(readKey(key))) as string | null;
        return seen;
      });
      missingKeys = keys.filter((key) => observed[key] !== writes[key]);
    } catch {
      missingKeys = keys;
    }
    if (missingKeys.length === 0 || Date.now() >= deadline) return { missingKeys };
    await new Promise((resolve) => setTimeout(resolve, PERSIST_CONFIRM_INTERVAL_MS));
    // The commit is re-requested on every round: the flush is asynchronous, and
    // a round that observed a stale value is the one that can benefit from
    // asking again.
    ses.flushStorageData();
  }
}

/**
 * Never throws. On failure nothing is marked, so the next boot retries — and
 * every rule in the plan is "add only", so a retry after a partial write is
 * harmless.
 */
export async function importPriorLocalStorage(input: {
  userDataDir: string;
  /** `<appData>/<former name>`, newest first. Empty for dev builds. */
  priorUserDataDirs: string[];
}): Promise<PriorLocalStorageImportOutcome> {
  const scratchDir = join(input.userDataDir, SCRATCH_DIR_NAME);
  const markerPath = join(input.userDataDir, PRIOR_LOCAL_STORAGE_MARKER_FILE_NAME);
  try {
    if (existsSync(markerPath)) {
      // Leftover from the boot that did the merge: its session held the copy
      // open. Best effort — a scratch dir that will not go away is not a reason
      // to report a finished merge as failed.
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // Retried on the next boot.
      }
      return { kind: 'skipped', reason: 'marker_present' };
    }
    const sources = input.priorUserDataDirs
      .filter((dir) => dir !== input.userDataDir)
      .map((dir) => join(dir, LOCAL_STORAGE_DIR_NAME))
      .filter((dir) => existsSync(dir));
    if (sources.length === 0) {
      return { kind: 'skipped', reason: 'nothing_to_migrate' };
    }

    rmSync(scratchDir, { recursive: true, force: true });
    mkdirSync(scratchDir, { recursive: true });
    const blankPage = join(scratchDir, 'blank.html');
    writeFileSync(blankPage, '<!doctype html><title></title>', 'utf-8');

    const priors: Record<string, string>[] = [];
    for (const [index, source] of sources.entries()) {
      const profileDir = join(scratchDir, String(index));
      cpSync(source, join(profileDir, LOCAL_STORAGE_DIR_NAME), { recursive: true });
      // Chromium refuses to open a leveldb whose `LOCK` is already taken, and a
      // `cpSync` carries the previous build's `LOCK` along. That file is a
      // stale artifact of a process that is gone (the old build is not running
      // — this one holds the single-instance lock), and leaving it in place
      // makes this whole step fail on EVERY boot, forever, with the sidebar
      // still empty. Copied stores are scratch, so dropping it is safe.
      rmSync(join(profileDir, LOCAL_STORAGE_DIR_NAME, 'LOCK'), { force: true });
      const raw = await withBlankPage(session.fromPath(profileDir), blankPage, (run) =>
        run(READ_ALL)
      );
      priors.push(JSON.parse(String(raw)) as Record<string, string>);
    }

    const plan = await withBlankPage(session.defaultSession, blankPage, async (run) => {
      const current = JSON.parse(String(await run(READ_ALL))) as Record<string, string>;
      const next = planLocalStorageMerge(current, priors);
      if (Object.keys(next.writes).length > 0) {
        await run(`(() => {
          const writes = ${JSON.stringify(next.writes)};
          for (const key of Object.keys(writes)) localStorage.setItem(key, writes[key]);
        })()`);
      }
      return next;
    });

    // DOM storage commits to leveldb lazily, and `flushStorageData()` only
    // REQUESTS that commit — it does not wait for it. Writing the marker on the
    // strength of that call is the defect this block closes: a crash in the
    // window between the request and the commit left the marker on disk and the
    // writes lost, and because the marker short-circuits every later boot, the
    // repository list was never migrated again. The sidebar stayed empty and
    // nothing ever retried.
    //
    // So the marker is now gated on EVIDENCE instead: the writes are read back
    // from the live session until every planned key returns the planned value.
    // Only then is the merge declared done. If confirmation never arrives the
    // function fails without marking, and the next boot replays the merge —
    // which is safe by construction, since every rule in
    // `planLocalStorageMerge` is "add only" and the second pass computes the
    // same no-op plan.
    session.defaultSession.flushStorageData();
    const confirmed = await confirmWrittenKeys(session.defaultSession, blankPage, plan.writes);
    if (!confirmed.missingKeys.length) {
      writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf-8');
    } else {
      return {
        kind: 'failed',
        error: `local storage writes did not persist: ${confirmed.missingKeys.join(', ')}`,
      };
    }
    return {
      kind: 'migrated',
      addedKeys: plan.addedKeys,
      addedRepositories: plan.addedRepositories,
      addedGroups: plan.addedGroups,
    };
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
