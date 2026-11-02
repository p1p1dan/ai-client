import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffHunks, formatPatch, hunkRows, patchPath } from '../diffPatch';
import { numberedLineDiff, type ToolDiffLineRow } from '../textDiff';

const lines = (count: number, tag = 'line') =>
  Array.from({ length: count }, (_, index) => `${tag} ${index + 1}`).join('\n');

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** Write `before`, `git apply` the patch, return what the file became (null = deleted/missing). */
function gitApply(path: string, before: string | null, patch: string): string {
  dir = mkdtempSync(join(tmpdir(), 'diff-patch-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (before !== null) writeFileSync(join(dir, path), before);
  writeFileSync(join(dir, 'change.patch'), patch);
  execFileSync('git', ['apply', 'change.patch'], { cwd: dir });
  return readFileSync(join(dir, path), 'utf8');
}

describe('[PILAB-R2-PATCH] formatPatch', () => {
  const cases: Array<[string, string, string]> = [
    ['one line in the middle', `${lines(30)}\n`, `${lines(30).replace('line 15', 'changed 15')}\n`],
    [
      'two far-apart changes',
      `${lines(40)}\n`,
      `${lines(40).replace('line 3\n', 'new 3\n').replace('line 37', 'x\ny')}\n`,
    ],
    ['insertion at the top', `${lines(10)}\n`, `first\n${lines(10)}\n`],
    ['deletion at the end', `${lines(10)}\n`, `${lines(8)}\n`],
    ['final newline dropped', `${lines(5)}\n`, lines(5)],
    ['final newline added', lines(5), `${lines(5)}\n`],
    ['no final newline either side', lines(5), lines(5).replace('line 5', 'last')],
  ];
  for (const [name, before, after] of cases) {
    it(`git apply reproduces the new text: ${name}`, () => {
      const patch = formatPatch([{ path: 'a.txt', rows: numberedLineDiff(before, after) }]);
      expect(gitApply('a.txt', before, patch)).toBe(after);
    });
  }

  it('a new file patches from /dev/null', () => {
    const after = `${lines(4)}\n`;
    const patch = formatPatch([
      { path: 'n.txt', rows: numberedLineDiff('', after), created: true },
    ]);
    expect(patch.startsWith('--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,4 @@\n')).toBe(true);
    expect(gitApply('n.txt', null, patch)).toBe(after);
  });

  it('keeps rows a view folds away and cuts context to three lines', () => {
    const patch = formatPatch([
      {
        path: 'a.txt',
        rows: numberedLineDiff(`${lines(30)}\n`, `${lines(30).replace('line 15', 'x')}\n`),
      },
    ]);
    expect(patch).toBe(
      [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -12,7 +12,7 @@',
        ' line 12',
        ' line 13',
        ' line 14',
        '-line 15',
        '+x',
        ' line 16',
        ' line 17',
        ' line 18',
        '',
      ].join('\n')
    );
  });

  it('two edits of one file apply one after the other', () => {
    const v1 = `${lines(10)}\n`;
    const v2 = v1.replace('line 2\n', 'two\n');
    const v3 = v2.replace('line 9\n', 'nine\n');
    const patch = formatPatch([
      { path: 'a.txt', rows: numberedLineDiff(v1, v2) },
      { path: 'a.txt', rows: numberedLineDiff(v2, v3) },
    ]);
    expect(gitApply('a.txt', v1, patch)).toBe(v3);
  });

  it('rows without line numbers become bare @@ hunks, whole', () => {
    const rows: ToolDiffLineRow[] = [
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'c' },
      { kind: 'del', text: 'x', hunkStart: true },
      { kind: 'add', text: 'y' },
    ];
    expect(formatPatch([{ path: 'f.ts', rows }])).toBe(
      '--- a/f.ts\n+++ b/f.ts\n@@\n a\n-b\n+c\n@@\n-x\n+y\n'
    );
  });

  it('a recorded hunk keeps its own coordinates', () => {
    // As `reviewEntryRows` builds them from `@@ -20,3 +20,4 @@`.
    const rows: ToolDiffLineRow[] = [
      { kind: 'same', text: 'p', oldLine: 20, newLine: 20 },
      { kind: 'add', text: 'q', newLine: 21 },
      { kind: 'same', text: 'r', oldLine: 21, newLine: 22 },
      { kind: 'same', text: 's', oldLine: 22, newLine: 23 },
    ];
    expect(formatPatch([{ path: 'f', rows }])).toContain('@@ -20,3 +20,4 @@\n p\n+q\n r\n s\n');
  });

  it('nothing changed is an empty patch', () => {
    expect(formatPatch([{ path: 'a', rows: numberedLineDiff('x\n', 'x\n') }])).toBe('');
  });
});

describe('[PILAB-R2-PATCH] hunkRows', () => {
  it('keeps only the hunks, a later one marked as a new region', () => {
    const rows = hunkRows(
      diffHunks(
        numberedLineDiff(
          `${lines(40)}\n`,
          `${lines(40).replace('line 3\n', 'a\n').replace('line 37', 'b')}\n`
        )
      )
    );
    expect(rows.filter((row) => row.hunkStart)).toHaveLength(1);
    expect(rows.find((row) => row.hunkStart)?.oldLine).toBe(34);
    expect(rows.length).toBeLessThan(20);
  });
});

describe('[PILAB-R2-PATCH] patchPath', () => {
  it('makes a path inside the root relative, with / separators', () => {
    expect(patchPath('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(patchPath('C:\\Repo\\src\\a.ts', 'c:\\repo\\')).toBe('src/a.ts');
    expect(patchPath('./src/a.ts', '/repo')).toBe('src/a.ts');
    expect(patchPath('/elsewhere/a.ts', '/repo')).toBe('/elsewhere/a.ts');
  });
});
