import { describe, expect, it } from 'vitest';
import { parseWorktreeListPorcelain } from '../worktreeListParse';

/**
 * `WorktreeService.list()` returning `[]` for a real repository (the
 * E:\C1Algorithm field case) is indistinguishable from "not a git repository"
 * everywhere downstream, and the old parser could produce it silently: every
 * branch is a `startsWith` / `===` on a raw split line, so a single stray
 * byte at the front or the end of a line drops the entry with no error.
 *
 * The service itself cannot be imported here — it reaches simple-git through
 * `./runtime`, which pulls in PtyManager (node-pty, a native binding) and
 * hangs a vitest node run. The parser is therefore its own pure module and
 * these cases exercise it directly.
 */
const CLEAN_OUTPUT = [
  'worktree /repo',
  'HEAD abc123',
  'branch refs/heads/main',
  '',
  'worktree /repo-wt',
  'HEAD def456',
  'branch refs/heads/feat/demo',
  '',
].join('\n');

describe('parseWorktreeListPorcelain', () => {
  it('parses ordinary LF porcelain output', () => {
    const { worktrees, emptyDiagnostic } = parseWorktreeListPorcelain(CLEAN_OUTPUT);

    expect(emptyDiagnostic).toBeUndefined();
    expect(worktrees).toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'main',
        isMainWorktree: true,
        isLocked: false,
        prunable: false,
      },
      {
        path: '/repo-wt',
        head: 'def456',
        branch: 'feat/demo',
        isMainWorktree: false,
        isLocked: false,
        prunable: false,
      },
    ]);
  });

  it('parses output that starts with a UTF-8 BOM', () => {
    // `'\uFEFFworktree /repo'.startsWith('worktree ')` is false: before the
    // strip, a BOM silently dropped the FIRST worktree — and for a repo with
    // no linked worktrees, that is the whole list.
    const { worktrees, emptyDiagnostic } = parseWorktreeListPorcelain(`\uFEFF${CLEAN_OUTPUT}`);

    expect(emptyDiagnostic).toBeUndefined();
    expect(worktrees.map((wt) => wt.path)).toEqual(['/repo', '/repo-wt']);
    expect(worktrees[0].isMainWorktree).toBe(true);
  });

  it('parses CRLF output without leaking carriage returns into branches or flags', () => {
    // Splitting on '\n' leaves a trailing '\r' on every line: the exact
    // matches (`line === 'bare'`) fail outright and the captured values come
    // back as 'main\r', which then never matches a branch name anywhere.
    const crlf = ['worktree /repo', 'HEAD abc123', 'branch refs/heads/main', 'bare', ''].join(
      '\r\n'
    );
    const { worktrees, emptyDiagnostic } = parseWorktreeListPorcelain(crlf);

    expect(emptyDiagnostic).toBeUndefined();
    expect(worktrees).toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'main',
        isMainWorktree: true,
        isLocked: false,
        prunable: false,
      },
    ]);
  });

  it('handles a BOM and CRLF together', () => {
    const bomCrlf = `\uFEFF${['worktree /repo', 'HEAD abc123', 'branch refs/heads/main', ''].join('\r\n')}`;
    const { worktrees } = parseWorktreeListPorcelain(bomCrlf);

    expect(worktrees).toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'main',
        isMainWorktree: true,
        isLocked: false,
        prunable: false,
      },
    ]);
  });

  it('reports raw evidence when nothing parsed, so an empty list can be diagnosed', () => {
    const { worktrees, emptyDiagnostic } = parseWorktreeListPorcelain('');

    expect(worktrees).toEqual([]);
    expect(emptyDiagnostic).toEqual({
      byteLength: 0,
      lineCount: 1,
      head: '',
      firstCharCode: null,
    });
  });

  it('names the offending first character when the output is non-empty but unparsable', () => {
    const { worktrees, emptyDiagnostic } = parseWorktreeListPorcelain(
      '\uFEFFfatal: not a git repo'
    );

    expect(worktrees).toEqual([]);
    // 65279 = U+FEFF. The head + code point are what turn "list came back
    // empty" into a readable cause without another test round.
    expect(emptyDiagnostic?.firstCharCode).toBe(65279);
    expect(emptyDiagnostic?.head).toBe('\uFEFFfatal: not a git repo');
    // 21 ASCII characters + 3 bytes of BOM: the byte count is what shows the
    // stdout was not actually empty.
    expect(emptyDiagnostic?.byteLength).toBe(24);
  });

  it('applies fromGitPath to every worktree path (WSL UNC round-trip)', () => {
    const { worktrees } = parseWorktreeListPorcelain(
      CLEAN_OUTPUT,
      (inputPath) => `\\\\wsl.localhost\\Ubuntu${inputPath.replace(/\//g, '\\')}`
    );

    expect(worktrees.map((wt) => wt.path)).toEqual([
      '\\\\wsl.localhost\\Ubuntu\\repo',
      '\\\\wsl.localhost\\Ubuntu\\repo-wt',
    ]);
  });
});
