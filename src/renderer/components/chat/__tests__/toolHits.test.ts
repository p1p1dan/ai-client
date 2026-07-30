import { describe, expect, it } from 'vitest';
import { parseHitList } from '../toolHits';

describe('parseHitList', () => {
  it('parses one path per line (Glob output)', () => {
    const output =
      'src/renderer/components/chat/toolCard.ts\nsrc/renderer/stores/chatSessions.ts\n';
    const result = parseHitList(output);
    expect(result?.hits).toEqual([
      {
        path: 'src/renderer/components/chat/toolCard.ts',
        name: 'toolCard.ts',
        dir: 'src/renderer/components/chat',
      },
      {
        path: 'src/renderer/stores/chatSessions.ts',
        name: 'chatSessions.ts',
        dir: 'src/renderer/stores',
      },
    ]);
    expect(result?.total).toBe(2);
    expect(result?.truncated).toBe(false);
  });

  it('groups "path:line:content" ripgrep content-mode lines by path, keeping the first line number', () => {
    const output = [
      'src/a.ts:10:const x = 1;',
      'src/a.ts:20:const y = 2;',
      'src/b.ts:5:const z = 3;',
      '',
    ].join('\n');
    const result = parseHitList(output);
    expect(result?.hits).toEqual([
      { path: 'src/a.ts', name: 'a.ts', dir: 'src', line: 10 },
      { path: 'src/b.ts', name: 'b.ts', dir: 'src', line: 5 },
    ]);
  });

  it('excludes noise lines (summary/status/blank) from the parse-ratio denominator', () => {
    const output = ['Found 2 files', 'src/a.ts', '', '--', 'src/b.ts', ''].join('\n');
    const result = parseHitList(output);
    expect(result?.hits.map((hit) => hit.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result?.total).toBe(2);
  });

  it('returns null for unstructured natural-language output (triggers downgrade)', () => {
    const output =
      'I searched thoroughly but found nothing relevant in the given context, sorry.\n';
    expect(parseHitList(output)).toBeNull();
  });

  it('returns null when the parseable share falls below minRatio', () => {
    const output = [
      'src/a.ts',
      'this is not a path at all, just prose',
      'also not a path, still more prose here',
      'nor is this one, more unrelated text',
      '',
    ].join('\n');
    expect(parseHitList(output, { minRatio: 0.6 })).toBeNull();
  });

  it('truncates hits to limit while total remains the de-duplicated count', () => {
    const paths = Array.from({ length: 5 }, (_, i) => `src/file${i}.ts`);
    const output = `${paths.join('\n')}\n`;
    const result = parseHitList(output, { limit: 2 });
    expect(result?.hits).toHaveLength(2);
    expect(result?.total).toBe(5);
  });

  // T-05 adversarial-review fix #5: a missing trailing newline no longer
  // means "blindly drop the last split element" — the old blanket-drop used
  // to also eat a genuine last hit whenever output simply didn't end with a
  // newline (e.g. a single Glob match, or the last of several). The last
  // line is only treated as a 16KB-cut fragment when it fails to parse *and*
  // everything parsed before it is already trustworthy.

  it('parses a single hit with no trailing newline instead of dropping it', () => {
    const result = parseHitList('src/a.ts');
    expect(result?.hits).toEqual([{ path: 'src/a.ts', name: 'a.ts', dir: 'src' }]);
    expect(result?.total).toBe(1);
    expect(result?.truncated).toBe(false);
  });

  it('parses every hit when multi-line output has no trailing newline', () => {
    const result = parseHitList('src/a.ts\nsrc/b.ts');
    expect(result?.hits.map((hit) => hit.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result?.total).toBe(2);
    expect(result?.truncated).toBe(false);
  });

  it('drops a genuinely unparseable trailing fragment (16KB-cut heuristic) and marks truncated', () => {
    // The cut lands mid-word, before any path separator or noise keyword is
    // complete — "Found 2 fil" matches neither the path/content patterns nor
    // NOISE_RE, so it can't be mistaken for a legitimate short hit.
    const output = 'src/a.ts\nsrc/b.ts\nFound 2 fil';
    const result = parseHitList(output);
    expect(result?.hits.map((hit) => hit.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result?.total).toBe(2);
    expect(result?.truncated).toBe(true);
  });

  it('does not speculate about truncation when the preceding context is not trustworthy', () => {
    // Prefix (before the trailing fragment) is already below minRatio, so
    // the ambiguous last line is counted as ordinary noise instead of being
    // specially excluded — which only makes an already-bad ratio worse, so
    // this still (correctly) returns null rather than a speculative parse.
    const output = 'src/a.ts\nnot a path here friend\nalso not a path either\nFound 2 fil';
    expect(parseHitList(output)).toBeNull();
  });

  // T-05 adversarial-review fix #6: a root-level bare filename (no directory
  // separator) used to never match PATH_ONLY_RE at all, so Glob hits at the
  // repo root were silently dropped.

  it('parses root-level bare filenames with no directory separator', () => {
    const output = 'README.md\npackage.json\n';
    const result = parseHitList(output);
    expect(result?.hits).toEqual([
      { path: 'README.md', name: 'README.md', dir: '' },
      { path: 'package.json', name: 'package.json', dir: '' },
    ]);
    expect(result?.total).toBe(2);
  });

  it('mixes root-level files with nested paths and noise without misreading the noise as a filename', () => {
    const output = ['Found 2 files', 'README.md', 'src/a.ts', 'No matches found', ''].join('\n');
    const result = parseHitList(output);
    expect(result?.hits).toEqual([
      { path: 'README.md', name: 'README.md', dir: '' },
      { path: 'src/a.ts', name: 'a.ts', dir: 'src' },
    ]);
    expect(result?.total).toBe(2);
  });

  it('parses Windows backslash paths', () => {
    const output = 'C:\\repo\\src\\a.ts\nC:\\repo\\src\\sub\\b.ts\n';
    const result = parseHitList(output);
    expect(result?.hits).toEqual([
      { path: 'C:\\repo\\src\\a.ts', name: 'a.ts', dir: 'C:/repo/src' },
      { path: 'C:\\repo\\src\\sub\\b.ts', name: 'b.ts', dir: 'C:/repo/src/sub' },
    ]);
  });

  it('returns null for undefined or empty input', () => {
    expect(parseHitList(undefined)).toBeNull();
    expect(parseHitList('')).toBeNull();
  });
});
