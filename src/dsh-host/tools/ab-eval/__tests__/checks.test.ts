import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addedLines, matchesAny, staticChecks } from '../lib/checks.ts';
import type { ChangedFile } from '../lib/types.ts';

/**
 * The deterministic layer decides pass or fail on its own, so its edges are
 * pinned here: globs, the lines a diff added, and each check kind's verdict.
 */

const PATCH = [
  'diff --git a/src/stats.js b/src/stats.js',
  '--- a/src/stats.js',
  '+++ b/src/stats.js',
  '@@ -1,3 +1,3 @@',
  '-  const sorted = [...values].sort();',
  '+  const sorted = [...values].sort((a, b) => a - b);',
  '+  console.log(sorted);',
  'diff --git a/old.txt b/old.txt',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  'diff --git a/test/new.test.js b/test/new.test.js',
  '--- /dev/null',
  '+++ b/test/new.test.js',
  '@@ -0,0 +1 @@',
  "+test.skip('later', () => {});",
].join('\n');

const CHANGES: ChangedFile[] = [
  { path: 'src/stats.js', status: 'M', added: 2, deleted: 1, binary: false },
  { path: 'old.txt', status: 'D', added: 0, deleted: 1, binary: false },
  { path: 'test/new.test.js', status: 'A', added: 1, deleted: 0, binary: false },
];

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ab-eval-checks-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe('matchesAny', () => {
  it('matches repository paths against globs', () => {
    expect(matchesAny('test/a/b.test.js', ['test/**'])).toBe(true);
    expect(matchesAny('src/x.js', ['test/**'])).toBe(false);
    expect(matchesAny('README.md', ['**'])).toBe(true);
    expect(matchesAny('src/a/b.js', ['src/*.js'])).toBe(false);
  });
});

describe('addedLines', () => {
  it('collects added lines per file and skips deleted files', () => {
    const added = addedLines(PATCH);
    expect(added.get('src/stats.js')).toEqual([
      '  const sorted = [...values].sort((a, b) => a - b);',
      '  console.log(sorted);',
    ]);
    expect(added.has('old.txt')).toBe(false);
    expect(added.get('test/new.test.js')).toEqual(["test.skip('later', () => {});"]);
  });
});

describe('staticChecks', () => {
  const ctx = (ws: string, answer = '') => ({
    ws,
    changes: CHANGES,
    patch: PATCH,
    answer,
    env: {},
  });

  it('judges mustChange and mustNotChange by the changed paths', () => {
    const results = staticChecks(
      { mustChange: ['src/stats.js', 'src/other.js'], mustNotChange: ['test/**', 'package.json'] },
      ctx(workspace({}))
    );
    expect(results.map((r) => [r.id, r.passed])).toEqual([
      ['mustChange:src/stats.js', true],
      ['mustChange:src/other.js', false],
      ['mustNotChange:test/**', false],
      ['mustNotChange:package.json', true],
    ]);
  });

  it('looks for forbidden patterns in added lines, scoped by paths', () => {
    const results = staticChecks(
      {
        forbidden: [
          { id: 'console', pattern: 'console\\.log', paths: ['src/**'] },
          { id: 'skip', pattern: '\\.skip\\(' },
          { id: 'console-in-tests', pattern: 'console\\.log', paths: ['test/**'] },
        ],
      },
      ctx(workspace({}))
    );
    expect(results.map((r) => [r.id, r.passed])).toEqual([
      ['forbidden:console', false],
      ['forbidden:skip', false],
      ['forbidden:console-in-tests', true],
    ]);
  });

  it('checks required patterns in the answer, without the g flag leaking state', () => {
    const answer = 'Total: 4,600 ms (src/retry.js:18).';
    const results = staticChecks(
      {
        required: [
          { id: 'total', pattern: '(?<![0-9])4[,，]?600(?![0-9])', in: 'answer', flags: 'g' },
          { id: 'cite', pattern: 'retry\\.js:\\d+', in: 'answer' },
          { id: 'missing', pattern: 'maxDelayMs', in: 'answer' },
        ],
      },
      ctx(workspace({}), answer)
    );
    expect(results.map((r) => [r.id, r.passed])).toEqual([
      ['required:total', true],
      ['required:cite', true],
      ['required:missing', false],
    ]);
  });

  it('reads the content of changed files when no paths are given', () => {
    const ws = workspace({ 'src/stats.js': 'const sorted = [...values].sort();\n' });
    const [result] = staticChecks(
      { forbidden: [{ id: 'sort', pattern: '\\.sort\\(\\s*\\)', in: 'content' }] },
      ctx(ws)
    );
    expect(result.passed).toBe(false);
    expect(result.detail.hits).toEqual([{ path: 'src/stats.js', text: '.sort()' }]);
  });
});
