// @vitest-environment happy-dom
import type { ContentSearchResult, FileSearchPage } from '@shared/types';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGlobalSearch } from '../useGlobalSearch';

let root: Root;
let container: HTMLDivElement;
let search: ReturnType<typeof useGlobalSearch>;
const files = vi.fn<() => Promise<FileSearchPage>>();
const content = vi.fn<() => Promise<ContentSearchResult>>();

function Probe() {
  search = useGlobalSearch('/workspace');
  return null;
}

function page(name: string): FileSearchPage {
  return {
    items: [{ name, path: `/workspace/${name}`, relativePath: name, score: 1 }],
    total: 1,
    truncated: false,
  };
}

async function query(value: string) {
  await act(() => search.setQuery(value));
  await act(() => vi.advanceTimersByTimeAsync(300));
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('electronAPI', { search: { files, content } });
  files.mockReset();
  content.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(createElement(Probe)));
  await act(() => search.setMode('files'));
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('global search request lifetime', () => {
  it('retains the newest results when an older IPC reply arrives last', async () => {
    const older = Promise.withResolvers<FileSearchPage>();
    const newer = Promise.withResolvers<FileSearchPage>();
    files.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    await query('old');
    await query('new');
    await act(async () => newer.resolve(page('new.ts')));
    expect(search.fileResults).toEqual(page('new.ts').items);
    await act(async () => older.resolve(page('old.ts')));
    expect(search.fileResults).toEqual(page('new.ts').items);
  });

  it('invalidates a reply immediately when the user edits the query, before debounce fires', async () => {
    const pending = Promise.withResolvers<FileSearchPage>();
    files.mockReturnValueOnce(pending.promise);
    await query('old');
    await act(() => search.setQuery('new'));
    await act(async () => pending.resolve(page('old.ts')));
    expect(search.fileResults).toEqual([]);
    expect(files).toHaveBeenCalledTimes(1);
  });

  it('does not restore results after closing/resetting search', async () => {
    const pending = Promise.withResolvers<FileSearchPage>();
    files.mockReturnValueOnce(pending.promise);
    await query('old');
    await act(() => search.reset());
    await act(async () => pending.resolve(page('old.ts')));
    expect(search.query).toBe('');
    expect(search.fileResults).toEqual([]);
    expect(search.isLoading).toBe(false);
  });

  it('clears loading when an empty query switches mode before its debounce fires', async () => {
    const pending = Promise.withResolvers<FileSearchPage>();
    files.mockReturnValueOnce(pending.promise);
    await query('old');
    await act(() => search.setQuery(''));
    await act(() => search.setMode('content'));
    expect(search.isLoading).toBe(false);
    await act(async () => pending.resolve(page('old.ts')));
    expect(search.fileResults).toEqual([]);
  });

  it('preserves content match locations and ignores the superseded filename reply', async () => {
    const pending = Promise.withResolvers<FileSearchPage>();
    files.mockReturnValueOnce(pending.promise);
    const result: ContentSearchResult = {
      matches: [
        {
          path: '/workspace/a.ts',
          relativePath: 'a.ts',
          line: 8,
          column: 2,
          matchLength: 3,
          content: 'needle',
        },
      ],
      totalMatches: 1,
      totalFiles: 1,
      truncated: false,
    };
    content.mockResolvedValueOnce(result);
    await query('needle');
    await act(async () => search.setMode('content'));
    expect(search.getSelectedItem()).toEqual(result.matches[0]);
    await act(async () => pending.resolve(page('old.ts')));
    expect(search.contentResults).toEqual(result);
    expect(search.fileResults).toEqual([]);
  });
});
