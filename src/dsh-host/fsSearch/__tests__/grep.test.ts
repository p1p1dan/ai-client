import { describe, expect, it } from 'vitest';
import {
  buildGrepArgv,
  capLine,
  DEFAULT_GREP_HEAD_LIMIT,
  GREP_PARAMETERS,
  GREP_TOOL_DESCRIPTION,
  type GrepEntry,
  type GrepInput,
  GrepOutputError,
  type GrepValue,
  grepHeader,
  LINE_TRUNCATED,
  NON_UTF8_LINE,
  orderByRecency,
  orderContent,
  parseContentOutput,
  parseCountOutput,
  parseFilesOutput,
  parseGrepArgs,
  presentGrepCall,
  renderGrep,
  splitGlobs,
  unreadablePathNotes,
} from '../grep.ts';

/**
 * dsh-rebase decision 190 — the rules of the enhanced `grep`, without a host
 * or a ripgrep binary. `grepTool.test.ts` runs the same tool over the real
 * binary.
 */

const VCS = ['.git', '.svn'];
const same = (path: string) => path;

function input(overrides: Partial<GrepInput> = {}): GrepInput {
  return { ...parseGrepArgs({ pattern: 'foo' }), ...overrides };
}

function json(type: string, path: string, line: number, text: string): string {
  return JSON.stringify({
    type,
    data: { path: { text: path }, lines: { text }, line_number: line, submatches: [] },
  });
}

describe('the model-facing schema', () => {
  it("names Claude Code's grep parameters, with our own words", () => {
    expect(Object.keys(GREP_PARAMETERS)).toEqual([
      'pattern',
      'path',
      'glob',
      'type',
      'output_mode',
      '-A',
      '-B',
      '-C',
      '-n',
      '-i',
      'multiline',
      'head_limit',
      'offset',
    ]);
    expect(GREP_PARAMETERS.pattern.required).toBe(true);
    expect(GREP_PARAMETERS.output_mode.enum).toEqual(['content', 'files_with_matches', 'count']);
    for (const spec of Object.values(GREP_PARAMETERS)) {
      expect(spec.description.length).toBeGreaterThan(20);
    }
    // The description states the defaults and how paging works.
    expect(GREP_TOOL_DESCRIPTION).toContain('"files_with_matches" (the default)');
    expect(GREP_TOOL_DESCRIPTION).toContain('250 by default');
    expect(GREP_TOOL_DESCRIPTION).toContain('which offset fetches the next page');
  });

  it('shows a literal backslash once in the escaping advice', () => {
    expect(GREP_PARAMETERS.pattern.description).toContain('"interface\\{\\}"');
    expect(GREP_PARAMETERS.pattern.description).not.toContain('\\\\');
  });
});

describe('parseGrepArgs', () => {
  it('defaults to a file listing of 250 entries, line numbers on', () => {
    expect(parseGrepArgs({ pattern: 'x' })).toEqual({
      pattern: 'x',
      globs: [],
      outputMode: 'files_with_matches',
      before: 0,
      after: 0,
      lineNumbers: true,
      caseInsensitive: false,
      multiline: false,
      headLimit: DEFAULT_GREP_HEAD_LIMIT,
      offset: 0,
    });
  });

  it('reads -C for both sides and lets -A / -B win for theirs', () => {
    expect(parseGrepArgs({ pattern: 'x', '-C': 2 })).toMatchObject({ before: 2, after: 2 });
    expect(parseGrepArgs({ pattern: 'x', '-C': 2, '-A': 5 })).toMatchObject({
      before: 2,
      after: 5,
    });
    expect(parseGrepArgs({ pattern: 'x', '-B': 1 })).toMatchObject({ before: 1, after: 0 });
    // Claude Code's alias for -C, accepted though not advertised.
    expect(parseGrepArgs({ pattern: 'x', context: 3 })).toMatchObject({ before: 3, after: 3 });
  });

  it('keeps whitespace patterns and the other switches as given', () => {
    expect(
      parseGrepArgs({
        pattern: ' ',
        path: 'src',
        glob: '*.ts',
        type: 'ts',
        output_mode: 'content',
        '-n': false,
        '-i': true,
        multiline: true,
        head_limit: 0,
        offset: 10,
      })
    ).toEqual({
      pattern: ' ',
      path: 'src',
      globs: ['*.ts'],
      type: 'ts',
      outputMode: 'content',
      before: 0,
      after: 0,
      lineNumbers: false,
      caseInsensitive: true,
      multiline: true,
      headLimit: 0,
      offset: 10,
    });
  });

  it.each([
    [{ pattern: '' }, 'pattern must be a non-empty string'],
    [{ pattern: 'x', path: '  ' }, 'path must be a non-empty string when given'],
    [{ pattern: 'x', glob: ' , ' }, 'glob must name at least one glob'],
    [{ pattern: 'x', type: 'type script' }, 'type must be one ripgrep file type name'],
    [{ pattern: 'x', '-C': -1 }, '-C must be a whole number of 0 or more'],
    [{ pattern: 'x', '-A': 101 }, '-A must be at most 100'],
    [{ pattern: 'x', head_limit: 1.5 }, 'head_limit must be a whole number of 0 or more'],
    [{ pattern: 'x', offset: -3 }, 'offset must be a whole number of 0 or more'],
    [{ pattern: 'x', output_mode: 'lines' as never }, 'output_mode must be one of'],
  ])('refuses %j', (args, message) => {
    expect(() => parseGrepArgs(args)).toThrow(message);
  });

  it('splits globs on top-level commas only', () => {
    expect(splitGlobs('*.ts, *.tsx')).toEqual(['*.ts', '*.tsx']);
    expect(splitGlobs('*.{ts,tsx}')).toEqual(['*.{ts,tsx}']);
    expect(splitGlobs('src/**/*.{js,jsx},!*.test.js')).toEqual(['src/**/*.{js,jsx}', '!*.test.js']);
    expect(splitGlobs(',')).toEqual([]);
  });
});

describe('buildGrepArgv', () => {
  it('lists files by default: hidden files in, VCS metadata out, the path behind --', () => {
    expect(buildGrepArgv(input({ path: '-odd' }), VCS)).toEqual([
      '--hidden',
      '--files-with-matches',
      '--null',
      '--glob=!**/.git',
      '--glob=!**/.git/**',
      '--glob=!**/.svn',
      '--glob=!**/.svn/**',
      '--regexp=foo',
      '--',
      '-odd',
    ]);
  });

  it('asks for JSON with context in content mode, and only there', () => {
    const content = buildGrepArgv(
      input({ outputMode: 'content', before: 2, after: 1, caseInsensitive: true, multiline: true }),
      []
    );
    expect(content).toEqual([
      '--hidden',
      '--json',
      '--ignore-case',
      '--multiline',
      '--multiline-dotall',
      '--before-context=2',
      '--after-context=1',
      '--regexp=foo',
    ]);
    const count = buildGrepArgv(input({ outputMode: 'count', before: 2, type: 'ts' }), []);
    expect(count).toEqual([
      '--hidden',
      '--count',
      '--with-filename',
      '--null',
      '--type=ts',
      '--regexp=foo',
    ]);
  });

  it('puts the VCS excludes after every glob of the call, so none can undo them', () => {
    const argv = buildGrepArgv(input({ globs: ['**/.git/**', '*.ts'] }), ['.git']);
    expect(argv.indexOf('--glob=!**/.git/**')).toBeGreaterThan(argv.indexOf('--glob=*.ts'));
    // A pattern that looks like a flag stays the pattern.
    expect(buildGrepArgv(input({ pattern: '--files' }), [])).toContain('--regexp=--files');
  });
});

describe('parsing ripgrep output', () => {
  it('reads --json matches and context, splitting a multi-line match into lines', () => {
    const stdout = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'src/a.ts' } } }),
      json('context', 'src/a.ts', 1, 'alpha\n'),
      json('match', 'src/a.ts', 2, 'beta foo\r\n'),
      json('match', 'src/a.ts', 4, 'foo one\nfoo two\n'),
      JSON.stringify({ type: 'end', data: { path: { text: 'src/a.ts' } } }),
      JSON.stringify({ type: 'summary', data: {} }),
      '',
    ].join('\n');
    const files = parseContentOutput(stdout, (path) => `./${path}`, 2000);
    expect([...files.keys()]).toEqual(['./src/a.ts']);
    expect(files.get('./src/a.ts')).toEqual([
      { path: './src/a.ts', line: 1, text: 'alpha', context: true },
      { path: './src/a.ts', line: 2, text: 'beta foo' },
      { path: './src/a.ts', line: 4, text: 'foo one' },
      { path: './src/a.ts', line: 5, text: 'foo two' },
    ]);
  });

  it('keeps a line that is not UTF-8 as a placeholder, and decodes a byte path', () => {
    const stdout = JSON.stringify({
      type: 'match',
      data: {
        path: { bytes: Buffer.from('b.bin').toString('base64') },
        lines: { bytes: 'gA==' },
        line_number: 7,
      },
    });
    expect(parseContentOutput(stdout, same, 2000).get('b.bin')).toEqual([
      { path: 'b.bin', line: 7, text: NON_UTF8_LINE },
    ]);
  });

  it('fails on output it cannot read rather than return part of it', () => {
    expect(() => parseContentOutput('{not json', same, 2000)).toThrow(GrepOutputError);
    expect(() =>
      parseContentOutput(JSON.stringify({ type: 'match', data: {} }), same, 2000)
    ).toThrow('no path');
    expect(() => parseCountOutput('a.ts\x003\ngarbage', same)).toThrow(GrepOutputError);
  });

  it('reads NUL-separated file lists and counts, newlines in names included', () => {
    expect(parseFilesOutput('a.ts\0dir\\b.ts\0odd\nname\0', same).map((e) => e.path)).toEqual([
      'a.ts',
      'dir\\b.ts',
      'odd\nname',
    ]);
    expect(parseCountOutput('a.ts\x003\nodd\nname\x0012\r\n', same)).toEqual([
      { path: 'a.ts', count: 3 },
      { path: 'odd\nname', count: 12 },
    ]);
    expect(parseFilesOutput('', same)).toEqual([]);
    expect(parseCountOutput('', same)).toEqual([]);
  });

  it('cuts a long line on a character boundary and says so', () => {
    expect(capLine('short', 10)).toBe('short');
    expect(capLine('abcdef', 4)).toBe(`abcd${LINE_TRUNCATED}`);
    // 'é' is two bytes: a cut never splits it.
    expect(capLine('aéé', 4)).toBe(`aé${LINE_TRUNCATED}`);
    expect(capLine('😀😀', 5)).toBe(`😀${LINE_TRUNCATED}`);
  });
});

describe('ordering', () => {
  it('orders content by path, keeping each file’s lines as printed', () => {
    const files = new Map<string, GrepEntry[]>([
      ['src/z.ts', [{ path: 'src/z.ts', line: 3, text: 'z' }]],
      [
        'src/a.ts',
        [
          { path: 'src/a.ts', line: 9, text: 'a9' },
          { path: 'src/a.ts', line: 10, text: 'a10' },
        ],
      ],
    ]);
    expect(orderContent(files).map((entry) => `${entry.path}:${entry.line}`)).toEqual([
      'src/a.ts:9',
      'src/a.ts:10',
      'src/z.ts:3',
    ]);
  });

  it('lists files newest first, then by path; unknown times last', () => {
    const times: Record<string, number> = { 'old.ts': 1, 'new.ts': 9, 'b.ts': 5, 'a.ts': 5 };
    const ordered = orderByRecency(
      ['old.ts', 'gone.ts', 'b.ts', 'new.ts', 'a.ts'].map((path) => ({ path })),
      (path) => times[path]
    );
    expect(ordered.map((entry) => entry.path)).toEqual([
      'new.ts',
      'a.ts',
      'b.ts',
      'old.ts',
      'gone.ts',
    ]);
  });
});

describe('renderGrep', () => {
  const lines = (count: number, path = 'a.ts'): GrepEntry[] =>
    Array.from({ length: count }, (_, index) => ({
      path,
      line: index + 1,
      text: `line ${index + 1}`,
    }));

  it('prints ripgrep’s content shape: path:line:text, context with -, groups split by --', () => {
    const value: GrepValue = {
      mode: 'content',
      entries: [
        { path: 'a.ts', line: 1, text: 'before', context: true },
        { path: 'a.ts', line: 2, text: 'foo()' },
        { path: 'a.ts', line: 9, text: 'foo again' },
        { path: 'b.ts', line: 3, text: 'foo' },
      ],
      notes: [],
    };
    expect(renderGrep(input({ outputMode: 'content', before: 1 }), value)).toBe(
      [
        'Found 3 matching lines in 2 files',
        '',
        'a.ts-1-before',
        'a.ts:2:foo()',
        '--',
        'a.ts:9:foo again',
        '--',
        'b.ts:3:foo',
      ].join('\n')
    );
    // No context asked for: no separators, as ripgrep prints it.
    expect(renderGrep(input({ outputMode: 'content' }), value)).not.toContain('--');
    // Line numbers off.
    expect(renderGrep(input({ outputMode: 'content', lineNumbers: false }), value)).toContain(
      '\na.ts-before\na.ts:foo()\n'
    );
  });

  it('prints files and counts, with totals in the header', () => {
    expect(
      renderGrep(input(), {
        mode: 'files_with_matches',
        entries: [{ path: 'a.ts' }, { path: 'b.ts' }],
        notes: [],
      })
    ).toBe('Found 2 files\n\na.ts\nb.ts');
    expect(
      renderGrep(input({ outputMode: 'count' }), {
        mode: 'count',
        entries: [
          { path: 'a.ts', count: 3 },
          { path: 'b.ts', count: 1 },
        ],
        notes: [],
      })
    ).toBe('Found 4 matching lines in 2 files\n\na.ts:3\nb.ts:1');
    expect(grepHeader({ mode: 'files_with_matches', entries: [{ path: 'a' }], notes: [] })).toBe(
      'Found 1 file'
    );
    expect(renderGrep(input(), { mode: 'files_with_matches', entries: [], notes: [] })).toBe(
      'No matches found'
    );
  });

  it('pages: says which offset comes next, the last page, and an offset past the end', () => {
    const value: GrepValue = { mode: 'content', entries: lines(600), notes: [] };
    const first = renderGrep(input({ outputMode: 'content' }), value);
    expect(first.split('\n').filter((line) => line.startsWith('a.ts:'))).toHaveLength(250);
    expect(first).toContain(
      '(Showing lines 1-250 of 600. Call grep again with the same arguments and offset: 250 for the next page, or narrow the search.)'
    );
    const last = renderGrep(input({ outputMode: 'content', offset: 500 }), value);
    expect(last).toContain('a.ts:501:line 501');
    expect(last).toContain('(Showing lines 501-600 of 600: the last page.)');
    expect(renderGrep(input({ outputMode: 'content', offset: 700 }), value)).toBe(
      'Found 600 matching lines in 1 file\n\n(offset 700 is past the end: the search found 600 lines.)'
    );
    // head_limit 0 shows everything, with no footer.
    const all = renderGrep(input({ outputMode: 'content', headLimit: 0 }), value);
    expect(all).not.toContain('(Showing');
    expect(all.split('\n')).toHaveLength(602);
    // Files are counted per file.
    const files = renderGrep(input({ headLimit: 2 }), {
      mode: 'files_with_matches',
      entries: ['a', 'b', 'c'].map((path) => ({ path })),
      notes: [],
    });
    expect(files).toContain('(Showing files 1-2 of 3.');
  });

  it('closes a partial result with what ripgrep could not read', () => {
    const notes = unreadablePathNotes('rg: ./x: Permission denied (os error 13)\n\n');
    expect(notes).toEqual(['rg: ./x: Permission denied (os error 13)']);
    expect(
      renderGrep(input(), { mode: 'files_with_matches', entries: [{ path: 'a.ts' }], notes })
    ).toBe(
      'Found 1 file\n\na.ts\n\n(Some paths could not be searched: rg: ./x: Permission denied (os error 13))'
    );
    expect(unreadablePathNotes('a\nb\nc\nd\ne')).toEqual(['a', 'b', 'c', 'and 2 more']);
  });
});

describe('presentGrepCall', () => {
  it('titles the card with the pattern, the path and the filters', () => {
    expect(presentGrepCall({ pattern: 'TODO', path: 'src', glob: '*.ts', type: 'ts' })).toEqual({
      card: 'generic',
      title: 'Grep TODO in src (*.ts, type ts)',
      kind: 'search',
      rawInput: 'TODO',
    });
    expect(presentGrepCall({ pattern: 'x' }).title).toBe('Grep x');
  });
});
