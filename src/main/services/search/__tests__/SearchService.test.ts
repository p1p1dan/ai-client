import { describe, expect, it } from 'vitest';
import { toPosixRelative } from '../SearchService';

/**
 * Regression: `path.relative` returns backslashes on win32, and the `@` mention
 * chain treats `relativePath` as a POSIX string end to end — fuzzy queries are
 * matched against it, `lastIndexOf('/')` splits it for the popup's directory
 * suffix, and it is inserted verbatim as `@<path>`. A backslash value broke all
 * three: `@src/renderer` scored zero, the directory suffix never rendered, and
 * the inserted mention carried backslashes downstream.
 *
 * These assertions hold on every platform (on POSIX hosts `path.relative`
 * already yields forward slashes); on win32 they fail without the normalization.
 */
describe('toPosixRelative', () => {
  it('returns forward slashes for a nested path', () => {
    const rel = toPosixRelative('/repo', '/repo/src/renderer/components/Chat.tsx');
    expect(rel).toBe('src/renderer/components/Chat.tsx');
  });

  it('never emits a backslash', () => {
    const rel = toPosixRelative('/repo', '/repo/src/main/AGENTS.md');
    expect(rel).not.toContain('\\');
  });

  it('keeps a slash-containing query matchable as a substring', () => {
    const rel = toPosixRelative('/repo', '/repo/src/renderer/index.ts');
    expect(rel.includes('src/renderer')).toBe(true);
  });

  it('splits into directory and file parts the way the popup does', () => {
    const rel = toPosixRelative('/repo', '/repo/docs/design-system.md');
    const lastSep = rel.lastIndexOf('/');
    expect(lastSep).toBeGreaterThan(0);
    expect(rel.slice(0, lastSep)).toBe('docs');
    expect(rel.slice(lastSep + 1)).toBe('design-system.md');
  });

  it('leaves a root-level file without a directory part', () => {
    const rel = toPosixRelative('/repo', '/repo/CLAUDE.md');
    expect(rel).toBe('CLAUDE.md');
    expect(rel.lastIndexOf('/')).toBe(-1);
  });
});
