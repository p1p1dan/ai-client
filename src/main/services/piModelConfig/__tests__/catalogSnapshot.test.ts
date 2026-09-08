import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bundledCatalogCandidates,
  createBundledCatalogReader,
  MODEL_CATALOG_DIR_NAME,
  MODEL_CATALOG_SNAPSHOT_FILE_NAME,
  readBundledCatalogFile,
} from '../catalogSnapshot';

/** A snapshot as the release script writes one: no credentials anywhere. */
const SNAPSHOT = {
  version: 1,
  updatedAt: '2026-09-01T00:00:00.000Z',
  providers: {
    dan: {
      name: 'Company Dan',
      api: 'openai-responses',
      credentials: { baseUrl: 'onboarding', apiKey: 'onboarding' },
      models: [{ id: 'deepseek-v4', name: 'DeepSeek V4', contextWindow: 128000 }],
    },
  },
};

describe('bundledCatalogCandidates', () => {
  it('looks in the packaged resources dir first, then the checked-in copy', () => {
    expect(bundledCatalogCandidates({ resourcesPath: '/app/Resources', cwd: '/repo' })).toEqual([
      join('/app/Resources', MODEL_CATALOG_DIR_NAME, MODEL_CATALOG_SNAPSHOT_FILE_NAME),
      join('/repo', 'resources', MODEL_CATALOG_DIR_NAME, MODEL_CATALOG_SNAPSHOT_FILE_NAME),
    ]);
  });

  it('drops locations this process does not have', () => {
    // `process.resourcesPath` is undefined outside Electron — a plain absence,
    // not a path to probe.
    expect(bundledCatalogCandidates({ cwd: '/repo' })).toHaveLength(1);
    expect(bundledCatalogCandidates({ resourcesPath: '   ', cwd: undefined })).toEqual([]);
  });
});

describe('readBundledCatalogFile', () => {
  let dir: string;
  let snapshotPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-catalog-snapshot-'));
    snapshotPath = join(dir, MODEL_CATALOG_SNAPSHOT_FILE_NAME);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads and validates a well-formed snapshot', () => {
    writeFileSync(snapshotPath, JSON.stringify(SNAPSHOT), 'utf8');
    expect(readBundledCatalogFile(snapshotPath)?.providers.dan?.models).toEqual([
      { id: 'deepseek-v4', name: 'DeepSeek V4', contextWindow: 128000 },
    ]);
  });

  it('rejects a corrupt snapshot without throwing (arm 1)', () => {
    // The launch must survive this: the app can still fetch a live catalog, and
    // the snapshot is only the floor beneath that.
    writeFileSync(snapshotPath, '{ not json', 'utf8');
    expect(readBundledCatalogFile(snapshotPath)).toBeNull();
    writeFileSync(snapshotPath, JSON.stringify({ version: 9, providers: {} }), 'utf8');
    expect(readBundledCatalogFile(snapshotPath)).toBeNull();
    writeFileSync(snapshotPath, JSON.stringify({ version: 1, providers: 'dan' }), 'utf8');
    expect(readBundledCatalogFile(snapshotPath)).toBeNull();
  });

  it('refuses a snapshot carrying a provider key', () => {
    // The packaged file is world-readable, so `credentialsAllowed: false` is
    // what stops an administrator key from being published with the app.
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        ...SNAPSHOT,
        providers: {
          dan: {
            ...SNAPSHOT.providers.dan,
            credentials: { baseUrl: 'onboarding', apiKey: 'managed' },
            apiKey: 'sk-should-never-ship',
          },
        },
      }),
      'utf8'
    );
    expect(readBundledCatalogFile(snapshotPath)).toBeNull();
  });

  it('treats a snapshot with no models as no snapshot at all', () => {
    // `bundled` with an empty menu would be indistinguishable from a management
    // endpoint that answered and had nothing enabled — the confusion D03 removed.
    writeFileSync(snapshotPath, JSON.stringify({ version: 1, providers: {} }), 'utf8');
    expect(readBundledCatalogFile(snapshotPath)).toBeNull();
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        version: 1,
        providers: { dan: { ...SNAPSHOT.providers.dan, models: [] } },
      }),
      'utf8'
    );
    expect(readBundledCatalogFile(snapshotPath)).toBeNull();
  });

  it('reports a missing file as absent, not as an error', () => {
    expect(readBundledCatalogFile(join(dir, 'nope.json'))).toBeNull();
  });
});

describe('the checked-in resources/model-catalog/snapshot.json', () => {
  const checkedIn = join(
    process.cwd(),
    'resources',
    MODEL_CATALOG_DIR_NAME,
    MODEL_CATALOG_SNAPSHOT_FILE_NAME
  );

  it('is either a valid catalog or nothing — never a half-read one', () => {
    // The file that actually ships, through the reader that actually reads it.
    // Today it is the empty placeholder (the management endpoint is not
    // deployed yet), so `null` is the correct answer and the client stays
    // `unavailable`; once the release script fills it in, this arm becomes the
    // gate that says the committed baseline parses, validates and carries no
    // credentials.
    const parsed = JSON.parse(readFileSync(checkedIn, 'utf8')) as {
      version: number;
      providers?: Record<string, { models?: unknown[] }>;
    };
    expect(parsed.version).toBe(1);
    const models = Object.values(parsed.providers ?? {}).reduce(
      (sum, provider) => sum + (provider.models?.length ?? 0),
      0
    );
    expect(readBundledCatalogFile(checkedIn)).toEqual(models > 0 ? expect.any(Object) : null);
  });
});

describe('createBundledCatalogReader', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-catalog-reader-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls through to the next candidate and then remembers the answer', () => {
    const cwd = join(dir, 'repo');
    mkdirSync(join(cwd, 'resources', MODEL_CATALOG_DIR_NAME), { recursive: true });
    const checkedIn = join(
      cwd,
      'resources',
      MODEL_CATALOG_DIR_NAME,
      MODEL_CATALOG_SNAPSHOT_FILE_NAME
    );
    writeFileSync(checkedIn, JSON.stringify(SNAPSHOT), 'utf8');

    const read = createBundledCatalogReader({ resourcesPath: join(dir, 'absent'), cwd });
    const first = read();
    expect(first?.providers.dan?.models).toHaveLength(1);

    // Memoized: the snapshot is a build artifact that nothing in this process
    // writes, and both catalog readers call this on every settings render.
    rmSync(checkedIn);
    expect(read()).toBe(first);
  });

  it('remembers a negative answer too', () => {
    const read = createBundledCatalogReader({ resourcesPath: join(dir, 'absent'), cwd: dir });
    expect(read()).toBeNull();
    expect(read()).toBeNull();
  });
});
