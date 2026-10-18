import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app', getVersion: () => '0' },
}));

const { ClaudeSdkCommandCatalog, CLAUDE_SDK_CATALOG_FRESH_MS } = await import(
  '../claudeSdkCatalog'
);

/**
 * dsh-rebase decision 194 Q1: the Agent SDK CLI's list for a folder no SDK chat runs in,
 * kept per folder. `run` stands in for the catalog host.
 */

const rows = (...names: string[]) => ({
  commands: names.map((name) => ({ name, source: 'skill' })),
  truncated: false,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ClaudeSdkCommandCatalog', () => {
  it('lists a folder once, and answers the next opening at once', async () => {
    const run = vi.fn(async () => rows('a'));
    let now = 1_000;
    const catalog = new ClaudeSdkCommandCatalog({ run, now: () => now });
    expect(await catalog.list('/repo')).toEqual(rows('a'));
    now += 1_000;
    expect(await catalog.list('/repo')).toEqual(rows('a'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ cwd: '/repo' });
  });

  it('answers a stale list at once and redoes it behind the menu', async () => {
    const next = deferred<ReturnType<typeof rows>>();
    const run = vi.fn().mockResolvedValueOnce(rows('a')).mockReturnValueOnce(next.promise);
    let now = 0;
    const catalog = new ClaudeSdkCommandCatalog({ run, now: () => now });
    await catalog.list('/repo');
    now += CLAUDE_SDK_CATALOG_FRESH_MS + 1;
    expect(await catalog.list('/repo')).toEqual(rows('a'));
    expect(await catalog.list('/repo')).toEqual(rows('a'));
    expect(run).toHaveBeenCalledTimes(2);
    next.resolve(rows('a', 'new-skill'));
    await next.promise;
    await Promise.resolve();
    expect(await catalog.list('/repo')).toEqual(rows('a', 'new-skill'));
  });

  it('shares one listing between openings, and keeps folders apart', async () => {
    const first = deferred<ReturnType<typeof rows>>();
    const run = vi.fn(({ cwd }: { cwd: string | null }) =>
      cwd === '/repo' ? first.promise : Promise.resolve(rows('user-only'))
    );
    const catalog = new ClaudeSdkCommandCatalog({ run });
    const a = catalog.list('/repo');
    const b = catalog.list('/repo');
    expect(await catalog.list(null)).toEqual(rows('user-only'));
    first.resolve(rows('project'));
    expect(await a).toEqual(rows('project'));
    expect(await b).toEqual(rows('project'));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a failed first listing answers an empty menu, and the next opening tries again', async () => {
    const log = vi.fn();
    const run = vi.fn().mockRejectedValueOnce(new Error('no CLI')).mockResolvedValueOnce(rows('a'));
    const catalog = new ClaudeSdkCommandCatalog({ run, log });
    expect(await catalog.list('/repo')).toEqual({ commands: [], truncated: false });
    expect(log).toHaveBeenCalledTimes(1);
    expect(await catalog.list('/repo')).toEqual(rows('a'));
  });

  it('on Windows one folder is one entry, whatever its spelling', async () => {
    const run = vi.fn(async () => rows('a'));
    const catalog = new ClaudeSdkCommandCatalog({ run, platform: 'win32' });
    const folder = process.platform === 'win32' ? 'C:\\Work\\Repo' : '/work/repo';
    await catalog.list(folder);
    await catalog.list(folder.toUpperCase());
    expect(run).toHaveBeenCalledTimes(1);
  });
});
