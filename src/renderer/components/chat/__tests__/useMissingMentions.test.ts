// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mentionTarget, useMissingMentions } from '../useMissingMentions';

/** PiLab R2 (user ruling 2026-10-30): a reference to nothing is marked before it is sent. */

describe('[PILAB-R2-MISSING-REF] mentionTarget', () => {
  it('joins in the folder’s own separator style', () => {
    expect(mentionTarget('/repo', 'src/a.ts')).toBe('/repo/src/a.ts');
    expect(mentionTarget('/repo/', './src/')).toBe('/repo/src');
    expect(mentionTarget('C:\\repo', 'src/a.ts')).toBe('C:\\repo\\src\\a.ts');
  });
  it('takes absolute paths as they are and leaves ~ unchecked', () => {
    expect(mentionTarget('/repo', '/etc/hosts')).toBe('/etc/hosts');
    expect(mentionTarget('/repo', 'D:/x.md')).toBe('D:/x.md');
    expect(mentionTarget('/repo', '~/notes.md')).toBe(null);
  });
});

let root: Root | undefined;
let seen: Set<string> = new Set();
const listed: string[] = [];
function Harness(props: { paths: string[]; cwd: string | null }) {
  seen = useMissingMentions(props.paths, props.cwd);
  return null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  listed.length = 0;
  const files = new Set(['/repo/src/a.ts']);
  window.electronAPI = {
    file: {
      exists: async (path: string) => files.has(path),
      list: async (dir: string) => {
        listed.push(dir);
        if (dir === '/repo') {
          return [{ name: 'src', path: '/repo/src', isDirectory: true, size: 0, modifiedAt: 0 }];
        }
        if (dir === '/repo/src') return [];
        throw new Error('ENOENT');
      },
    },
  } as unknown as typeof window.electronAPI;
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('[PILAB-R2-MISSING-REF] useMissingMentions', () => {
  it('marks only what is not there: a file and a folder both count as there', async () => {
    await act(async () =>
      root?.render(
        createElement(Harness, { paths: ['src/a.ts', 'src', 'docs/old.md', '~/x'], cwd: '/repo' })
      )
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect([...seen]).toEqual(['docs/old.md']);
    // Only folders known to be there are listed: a missing one never fails a read in Main.
    expect(listed.every((dir) => dir === '/repo' || dir === '/repo/src')).toBe(true);
  });

  it('says nothing without a folder to look in', async () => {
    await act(async () => root?.render(createElement(Harness, { paths: ['a.md'], cwd: null })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(seen.size).toBe(0);
  });
});
