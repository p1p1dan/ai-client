/**
 * `priorLocalStorageImport` reached a real defect by having no test at all: the
 * marker went down on the strength of `flushStorageData()`, which only REQUESTS
 * a commit. A crash in the gap left `.migrated-prior-local-storage` on disk
 * with the writes lost, and the marker short-circuits every later boot — so the
 * repository list was never migrated again and the sidebar stayed empty
 * forever.
 *
 * These tests drive the module through a fake Chromium, which is the only way
 * to reach that ordering without an Electron runtime. What they pin:
 *  - the marker is written ONLY after the planned keys read back, and a store
 *    that never shows the writes fails WITHOUT marking, so the next boot
 *    retries;
 *  - a copied store that still carries the previous build's `LOCK` is unusable,
 *    and the import therefore drops it;
 *  - a marked install short-circuits.
 *
 * They cannot prove Chromium commits either way — that needs the packaged app.
 * They pin the CONTRACT the fix is made of.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The DEFAULT session's store, shared with the pages that read it back — the
 * round trip the real code performs. A `prior` store is modelled separately:
 * its contents live in the leveldb file a scratch profile was copied from, so
 * only the default session may read this map.
 */
const store = new Map<string, string>();
/** Set to false to model a store whose writes never reach disk. */
let writesPersist = true;
/** Directories a blank page opened, newest last. */
const openedDirs: string[] = [];

function readLevelDb(dir: string): Record<string, string> {
  // A copied store's contents are whatever the test put in its `.ldb`.
  const lsDir = join(dir, 'Local Storage');
  const file = existsSync(lsDir)
    ? readdirSync(lsDir).find((name) => name.endsWith('.ldb'))
    : undefined;
  if (!file) return {};
  return JSON.parse(readFileSync(join(lsDir, file), 'utf-8')) as Record<string, string>;
}

function runScript(dir: string, script: string): unknown {
  const inDefault = dir === 'default';
  const read = (key: string): string | null =>
    inDefault ? (store.get(key) ?? null) : (readLevelDb(dir)[key] ?? null);
  const all = (): Record<string, string> =>
    inDefault ? Object.fromEntries(store) : readLevelDb(dir);

  if (script.includes('Object.keys(localStorage)')) return JSON.stringify(all());
  const single = /localStorage\.getItem\((.*)\)$/.exec(script);
  if (single) return read(JSON.parse(single[1]));
  const writes = /const writes = (\{.*?\});/s.exec(script);
  if (writes) {
    if (inDefault && writesPersist) {
      for (const [key, value] of Object.entries(JSON.parse(writes[1]) as Record<string, string>)) {
        store.set(key, value);
      }
    }
    return undefined;
  }
  throw new Error(`unhandled script: ${script}`);
}

const { fakeSession, FakeWebContentsView } = vi.hoisted(() => {
  class HoistedView {
    webContents = {
      // Mirrors Chromium: a leveldb whose LOCK is still present is not openable.
      loadFile: async (page: string) => {
        const dir = (this as unknown as { __dir?: string }).__dir;
        if (dir && dir !== 'default' && existsSync(join(dir, 'Local Storage', 'LOCK'))) {
          throw new Error(`leveldb LOCK is held: ${dir}`);
        }
        if (!existsSync(page)) throw new Error(`missing page: ${page}`);
      },
      executeJavaScript: async (script: string) =>
        runScript((this as unknown as { __dir?: string }).__dir ?? 'default', script),
      close: () => {},
    };
    constructor(init: { webPreferences?: { session?: { __dir?: string } } }) {
      const dir = init.webPreferences?.session?.__dir;
      if (dir) {
        (this as unknown as { __dir?: string }).__dir = dir;
        openedDirs.push(dir);
      }
    }
  }
  return {
    FakeWebContentsView: HoistedView,
    fakeSession: {
      defaultSession: {
        __dir: 'default',
        flushStorageData: () => {},
      },
      fromPath: (dir: string) => ({ __dir: dir, flushStorageData: () => {} }),
    },
  };
});

vi.mock('electron', () => ({
  session: fakeSession,
  WebContentsView: FakeWebContentsView,
}));

import {
  importPriorLocalStorage,
  PRIOR_LOCAL_STORAGE_MARKER_FILE_NAME,
} from '../priorLocalStorageImport';

/** A store with one repository, as the renderer would have written it. */
const EXISTING = JSON.stringify([{ path: '/home/me/existing' }]);

/** The row appended by the merge above, which is what makes `writes` non-empty. */
const EXPECTED_MERGED = JSON.stringify([
  { path: '/home/me/existing' },
  { path: '/home/me/old-only' },
]);

let userDataDir: string;
let priorDir: string;
const markerPath = () => join(userDataDir, PRIOR_LOCAL_STORAGE_MARKER_FILE_NAME);

beforeEach(() => {
  store.clear();
  writesPersist = true;
  openedDirs.length = 0;
  userDataDir = mkdtempSync(join(tmpdir(), 'pilab-userdata-'));
  priorDir = mkdtempSync(join(tmpdir(), 'pilab-prior-'));
  mkdirSync(join(priorDir, 'Local Storage'), { recursive: true });
  // The only prior key that produces a write against a store that already has
  // its own repository list: same key, a row the new build does not have.
  writeFileSync(
    join(priorDir, 'Local Storage', '000005.ldb'),
    JSON.stringify({ 'aiclient-repositories': JSON.stringify([{ path: '/home/me/old-only' }]) }),
    'utf-8'
  );
  // What a previous build that crashed mid-write leaves behind.
  writeFileSync(join(priorDir, 'Local Storage', 'LOCK'), '', 'utf-8');
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(priorDir, { recursive: true, force: true });
});

describe('prior local storage import', () => {
  it('opens the copied store by dropping the stale LOCK, and merges the repository list', async () => {
    store.set('aiclient-repositories', EXISTING);
    const outcome = await importPriorLocalStorage({ userDataDir, priorUserDataDirs: [priorDir] });
    // Without the `rmSync(… 'LOCK')` the page load above throws, the function
    // returns `failed`, and nothing is merged — on every boot, forever.
    expect(outcome).toMatchObject({ kind: 'migrated', addedRepositories: 1 });
    expect(openedDirs.some((dir) => dir !== 'default')).toBe(true);
    expect(store.get('aiclient-repositories')).toBe(EXPECTED_MERGED);
  });

  it('writes the marker only after the planned keys read back', async () => {
    store.set('aiclient-repositories', EXISTING);
    await importPriorLocalStorage({ userDataDir, priorUserDataDirs: [priorDir] });
    expect(store.get('aiclient-repositories')).toBe(EXPECTED_MERGED);
    expect(existsSync(markerPath())).toBe(true);
  });

  it('withholds the marker when the writes never reach the store, so the next boot retries', async () => {
    store.set('aiclient-repositories', EXISTING);
    writesPersist = false;
    // The confirm loop spends its whole budget (5s) before giving up, so this
    // case legitimately outlives vitest's 5s default.
    const outcome = await importPriorLocalStorage({ userDataDir, priorUserDataDirs: [priorDir] });
    // The defect this replaces wrote the marker here, permanently stranding the
    // repository list.
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(existsSync(markerPath())).toBe(false);
  }, 20_000);

  it('skips a marked install and still cleans the leftover scratch dir', async () => {
    writeFileSync(markerPath(), 'done\n', 'utf-8');
    const scratch = join(userDataDir, '.prior-local-storage');
    mkdirSync(scratch, { recursive: true });
    const outcome = await importPriorLocalStorage({ userDataDir, priorUserDataDirs: [priorDir] });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'marker_present' });
    expect(existsSync(scratch)).toBe(false);
  });

  it('reports nothing_to_migrate when no earlier store exists, and does not mark', async () => {
    rmSync(join(priorDir, 'Local Storage'), { recursive: true, force: true });
    const outcome = await importPriorLocalStorage({ userDataDir, priorUserDataDirs: [priorDir] });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'nothing_to_migrate' });
    expect(existsSync(markerPath())).toBe(false);
  });
});
