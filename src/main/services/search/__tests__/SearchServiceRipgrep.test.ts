import { describe, expect, it } from 'vitest';
import { searchService } from '../SearchService';

/**
 * T-07 integration: exercises the real ripgrep binary against this repository.
 *
 * The pure-function tests next door cannot see ripgrep's actual behavior — that
 * `--hidden` really surfaces dotfiles, that `!.git/**` still holds once hidden
 * traversal is on, or that directory entries survive the full pipeline. Those
 * are exactly the claims T-07②/① make, so they are asserted here against the
 * checked-in tree (stable fixtures: `.github/`, `src/renderer/`, `CLAUDE.md`).
 *
 * Slower than a unit test (spawns rg over the repo) but still well under a
 * second, and it is the only layer that would catch a wrong rg flag.
 */

const ROOT = process.cwd();

describe('searchFiles against the real repo (T-07)', () => {
  it('② surfaces hidden dotfiles that rg skips by default', async () => {
    const page = await searchService.searchFiles({
      rootPath: ROOT,
      query: 'gitignore',
      maxResults: 50,
    });
    // Without `--hidden` this list is empty — rg never walks dot-prefixed entries.
    expect(page.items.some((r) => r.relativePath === '.gitignore')).toBe(true);
  });

  it('② still excludes the .git object database', async () => {
    const page = await searchService.searchFiles({
      rootPath: ROOT,
      query: '',
      maxResults: 100_000,
    });
    // `--hidden` would drag .git/** in if EXCLUDE_GLOBS stopped applying.
    const leaked = page.items.filter(
      (r) => r.relativePath === '.git' || r.relativePath.startsWith('.git/')
    );
    expect(leaked).toEqual([]);
  });

  it('② reaches files inside hidden directories', async () => {
    const page = await searchService.searchFiles({
      rootPath: ROOT,
      query: '.github/',
      maxResults: 50,
    });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((r) => r.relativePath.startsWith('.github/'))).toBe(true);
  });

  it('① returns selectable directory entries, not just files', async () => {
    const page = await searchService.searchFiles({
      rootPath: ROOT,
      query: 'renderer',
      maxResults: 100,
    });
    const dir = page.items.find((r) => r.relativePath === 'src/renderer');
    expect(dir).toBeDefined();
    expect(dir?.isDirectory).toBe(true);
  });

  it('① keeps files marked as non-directories', async () => {
    const page = await searchService.searchFiles({
      rootPath: ROOT,
      query: 'CLAUDE.md',
      maxResults: 20,
    });
    const file = page.items.find((r) => r.relativePath === 'CLAUDE.md');
    expect(file).toBeDefined();
    expect(file?.isDirectory).toBe(false);
  });

  it('③ reports a total larger than the page when truncating', async () => {
    // The bug report: searching `chat` matched 304 files, popup showed 10.
    const page = await searchService.searchFiles({ rootPath: ROOT, query: 'chat', maxResults: 10 });
    expect(page.items).toHaveLength(10);
    expect(page.total).toBeGreaterThan(10);
    expect(page.truncated).toBe(true);
  });

  it('④ orders results deterministically across repeated identical queries', async () => {
    const [a, b] = await Promise.all([
      searchService.searchFiles({ rootPath: ROOT, query: 'index', maxResults: 30 }),
      searchService.searchFiles({ rootPath: ROOT, query: 'index', maxResults: 30 }),
    ]);
    expect(a.items.map((r) => r.relativePath)).toEqual(b.items.map((r) => r.relativePath));
  });

  it('④ ranks a shallower path above a deeper one at equal score', async () => {
    const page = await searchService.searchFiles({
      rootPath: ROOT,
      query: 'package.json',
      maxResults: 50,
    });
    const rootIdx = page.items.findIndex((r) => r.relativePath === 'package.json');
    const nestedIdx = page.items.findIndex(
      (r) => r.relativePath.endsWith('/package.json') && r.relativePath !== 'package.json'
    );
    expect(rootIdx).toBeGreaterThanOrEqual(0);
    if (nestedIdx >= 0) expect(rootIdx).toBeLessThan(nestedIdx);
  });
});
