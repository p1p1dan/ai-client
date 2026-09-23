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

    // DOM storage commits to leveldb lazily. This REQUESTS the commit; it does
    // not wait for it, so a crash in the next moment could still lose the
    // writes after the marker lands. Accepted: the main window opens right
    // after and keeps the session alive far longer than one commit takes.
    session.defaultSession.flushStorageData();
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf-8');
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
