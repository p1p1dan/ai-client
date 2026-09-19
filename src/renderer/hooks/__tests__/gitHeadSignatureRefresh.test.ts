// @vitest-environment happy-dom
/**
 * T100: the git panel's History section and branch list are not polled — before
 * this, a `git commit` / `git checkout` / `git branch` run outside the app
 * (terminal, agent) stayed invisible for as long as the panel stayed open, and
 * the refresh button reloaded only the changed-files list.
 *
 * These cases pin the four judgements that make the fix safe rather than merely
 * fresh: a moved fingerprint refreshes, an unmoved one costs nothing, coming
 * back to the window refreshes exactly once (the 60s global `staleTime` means
 * React Query's own refetch-on-focus would skip it), and one refresh click
 * covers all three queries.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { gitQueryKeys } from '../gitQueryKeys';
import { useGitExternalRefresh } from '../useGitHeadSignature';

const WORKDIR = '/repo';

const signatureA = { head: 'aaaa', ref: 'refs/heads/main', refs: 'digest-1' };
/** Same repository after an external commit: HEAD moved and so did the branch tip. */
const signatureB = { head: 'bbbb', ref: 'refs/heads/main', refs: 'digest-2' };

const getHeadSignature = vi.fn();

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let refresh: () => void;
let invalidateSpy: MockInstance<QueryClient['invalidateQueries']>;

function Probe() {
  refresh = useGitExternalRefresh(WORKDIR, true).refresh;
  return null;
}

/** The queries History and the branch switcher actually read from. */
const historyKey = gitQueryKeys.log(WORKDIR, 30);
const historyInfiniteKey = gitQueryKeys.logInfinite(WORKDIR);
const branchesKey = gitQueryKeys.branches(WORKDIR);
const fileChangesKey = gitQueryKeys.fileChanges(WORKDIR);
const otherRepoKey = gitQueryKeys.branches('/other');

/** `log(workdir)` omits `maxCount` — the prefix the hook invalidates with. */
const historyPrefix = gitQueryKeys.log(WORKDIR);

const seededKeys = [historyKey, historyInfiniteKey, branchesKey, fileChangesKey, otherRepoKey];

function invalidated(key: readonly unknown[]): boolean {
  return client.getQueryState(key)?.isInvalidated === true;
}

/** How many `invalidateQueries` calls targeted exactly this key. */
function invalidateCalls(key: readonly unknown[]): number {
  const serialized = JSON.stringify(key);
  return invalidateSpy.mock.calls.filter(
    ([filters]) => JSON.stringify(filters?.queryKey) === serialized
  ).length;
}

/**
 * A drained microtask queue is NOT enough here: React Query notifies its
 * observers out of band, so the render that first carries query data lands a
 * task later. Awaiting a timer inside `act` is what makes the baseline reading
 * observable; without it the first signature the hook ever sees is the second
 * one, and these cases silently stop testing what they claim to.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Stands in for the 5s poll tick, without waiting for it. */
async function pollAgain(): Promise<void> {
  await act(async () => {
    await client.refetchQueries({ queryKey: gitQueryKeys.headSignature(WORKDIR) });
  });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('electronAPI', { git: { getHeadSignature } });
  getHeadSignature.mockReset().mockResolvedValue(signatureA);

  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const key of seededKeys) client.setQueryData(key, []);

  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  await flush();
  // The first reading is a baseline, not a change: opening the panel must not
  // throw away caches that are already correct.
  expect(getHeadSignature).toHaveBeenCalledWith(WORKDIR);
  for (const key of seededKeys) expect(invalidated(key)).toBe(false);

  invalidateSpy = vi.spyOn(client, 'invalidateQueries');
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  invalidateSpy.mockRestore();
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
  // useWindowFocus keeps module-level state; leave the window focused for the
  // next case no matter which one just ran.
  window.dispatchEvent(new Event('focus'));
});

describe('T100 external git changes refresh the panel', () => {
  it('a changed head signature invalidates history and branches', async () => {
    getHeadSignature.mockResolvedValue(signatureB);
    await pollAgain();
    await flush();

    expect(invalidated(historyKey)).toBe(true);
    expect(invalidated(historyInfiniteKey)).toBe(true);
    expect(invalidated(branchesKey)).toBe(true);
    // The working tree has its own 5s poll; the fingerprint deliberately does
    // not pile a second refetch onto it.
    expect(invalidated(fileChangesKey)).toBe(false);
    expect(invalidated(otherRepoKey)).toBe(false);
  });

  it('an unchanged signature invalidates nothing', async () => {
    await pollAgain();
    await pollAgain();

    expect(getHeadSignature.mock.calls.length).toBeGreaterThan(1);
    for (const key of seededKeys) expect(invalidated(key)).toBe(false);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('window focus invalidates history and branches once', async () => {
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();

    expect(invalidateCalls(historyPrefix)).toBe(1);
    expect(invalidateCalls(historyInfiniteKey)).toBe(1);
    expect(invalidateCalls(branchesKey)).toBe(1);
    expect(invalidated(historyKey)).toBe(true);
    expect(invalidated(branchesKey)).toBe(true);
  });

  it('the refresh button invalidates all three keys', async () => {
    await act(async () => {
      refresh();
    });
    await flush();

    expect(invalidated(fileChangesKey)).toBe(true);
    expect(invalidated(historyKey)).toBe(true);
    expect(invalidated(historyInfiniteKey)).toBe(true);
    expect(invalidated(branchesKey)).toBe(true);
    expect(invalidated(otherRepoKey)).toBe(false);
  });
});
