import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GREP_TOOL_GUIDANCE, type GrepValue } from '../grep.ts';
import {
  applyRichGrepTool,
  type GrepExecution,
  type GrepSubprocess,
  type RichGrepCaps,
  type RichGrepContext,
} from '../grepTool.ts';

/**
 * dsh-rebase decision 190 — the enhanced `grep` over the real packaged
 * ripgrep (the host's `@vscode/ripgrep`), through a `ctx.subprocess` stand-in
 * built on `child_process`, on a scratch workspace. What DSH's registry adds
 * (scheduling, the timeout policy, the permission row's filter) is the real
 * host's: `fsSearch.integration.test.ts`.
 */

const HOST_DIR = fileURLToPath(new URL('../..', import.meta.url));
const RG = (createRequire(join(HOST_DIR, 'package.json'))('@vscode/ripgrep') as { rgPath: string })
  .rgPath;

const CAPS: RichGrepCaps = {
  maxLineBytes: 2000,
  rawOutputMaxBytes: 20_000_000,
  graceMs: 1000,
  stderrMaxBytes: 65536,
  timeoutMs: 30_000,
};

/** `ctx.subprocess.spawn` on `child_process`, collect mode only, as the seam behaves. */
function nodeSubprocess(): GrepSubprocess {
  return {
    spawn(spec) {
      const child = spawn(spec.argv[0] as string, spec.argv.slice(1), {
        cwd: spec.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const collect = (stream: NodeJS.ReadableStream | null, maxBytes: number) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let lossy = false;
        stream?.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) lossy = true;
          else chunks.push(chunk);
        });
        return { readFrom: () => ({ text: Buffer.concat(chunks).toString('utf8'), lossy }) };
      };
      const stdout = collect(child.stdout, spec.stdio.stdout.maxBytes);
      const stderr = collect(child.stderr, spec.stdio.stderr.maxBytes);
      spec.signal?.addEventListener('abort', () => child.kill(), { once: true });
      const done = new Promise<{ exitCode: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.on('error', reject);
          child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
        }
      );
      return { done, collected: { stdout, stderr } };
    },
  };
}

/** A subprocess whose one run ends as told, for the outcomes a real rg rarely gives. */
function scriptedSubprocess(exitCode: number, stdout: string, stderr: string): GrepSubprocess {
  return {
    spawn: () => ({
      done: Promise.resolve({ exitCode, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
        stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
      },
    }),
  };
}

interface Registered {
  definition: {
    name: string;
    description: string;
    parameters: unknown;
    timeoutMs?: number;
    output: { schema: unknown; render(args: unknown, value: unknown): Array<{ text: string }> };
    execute(args: unknown, exec: unknown): Promise<unknown>;
    presentCall?(args: unknown): unknown;
  };
  sections: Array<{ name: string; order: number; text: (assembly: object) => string }>;
}

function mount(subprocess: GrepSubprocess = nodeSubprocess()): Registered {
  const registered = { sections: [] } as unknown as Registered;
  const ctx = {
    tools: {
      register: (definition: Registered['definition']) => {
        registered.definition = definition;
      },
      get: (name: string) => (name === 'grep' ? registered.definition : undefined),
    },
    systemPrompt: {
      section: (section: Registered['sections'][number]) => registered.sections.push(section),
      getSectionOrder: (name: string) => (name === 'TOOL_GREP' ? 4242 : 0),
    },
    subprocess,
  } as unknown as RichGrepContext;
  applyRichGrepTool(ctx, CAPS, { rgPath: async () => RG });
  return registered;
}

let workspace: string;

function exec(cwd = workspace, signal = new AbortController().signal): GrepExecution {
  return { signal, agent: { session: { header: { cwd } } } };
}

async function grep(
  args: Record<string, unknown>,
  registered = mount()
): Promise<{ value: GrepValue; text: string }> {
  const value = (await registered.definition.execute(args, exec())) as GrepValue;
  // The registry checks every value against the declared schema.
  expect(validateJsonSchemaValue(registered.definition.output.schema as never, value)).toEqual([]);
  const [block] = registered.definition.output.render(args, value);
  return { value, text: block?.text ?? '' };
}

function write(rel: string, text: string, mtimeSeconds?: number): void {
  const file = join(workspace, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  if (mtimeSeconds !== undefined) utimesSync(file, mtimeSeconds, mtimeSeconds);
}

const sep = process.platform === 'win32' ? '\\' : '/';
const p = (rel: string) => rel.split('/').join(sep);

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'aiclient-grep-'));
  write('src/a.ts', 'alpha\nbeta foo\ngamma\ndelta\nFOO epsilon\nzeta\n', 1_000_000);
  write('src/sub/b.js', 'const foo = 1;\n', 3_000_000);
  write('.github/ci.yml', 'run: foo\n', 2_000_000);
  write('.git/config', 'foo\n');
  write('.gitignore', 'dist/\n');
  write('dist/out.js', 'foo\n');
  write('notes.md', 'nothing here\n');
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('the tool and its prompt section', () => {
  it('registers grep with our schema, its timeout, and the TOOL_GREP section', () => {
    const { definition, sections } = mount();
    expect(definition.name).toBe('grep');
    expect(definition.timeoutMs).toBe(30_000);
    const properties = (definition.parameters as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties)).toContain('-C');
    expect(Object.keys(properties)).toContain('head_limit');
    expect(sections).toHaveLength(1);
    expect(sections[0]?.name).toBe('tool:grep');
    expect(sections[0]?.order).toBe(4242);
    expect(sections[0]?.text({})).toBe(GREP_TOOL_GUIDANCE);
    expect(definition.presentCall?.({ pattern: 'foo', path: 'src' })).toMatchObject({
      title: 'Grep foo in src',
    });
  });

  it('refuses ill-typed arguments before anything runs', async () => {
    const { definition } = mount(scriptedSubprocess(0, '', ''));
    await expect(definition.execute({ pattern: 'x', '-C': '3' }, exec())).rejects.toThrow();
    await expect(definition.execute({ path: 'src' }, exec())).rejects.toThrow();
    await expect(definition.execute({ pattern: 'x', head_limit: -1 }, exec())).rejects.toThrow(
      'head_limit must be a whole number of 0 or more'
    );
  });
});

describe('searching with the real ripgrep', () => {
  it('lists matching files newest first: hidden files in, .git and ignored files out', async () => {
    const { text } = await grep({ pattern: 'foo', '-i': true });
    expect(text).toBe(
      ['Found 3 files', '', p('src/sub/b.js'), p('.github/ci.yml'), p('src/a.ts')].join('\n')
    );
  });

  it('prints matching lines with numbers and context, in path order', async () => {
    const { text } = await grep({ pattern: 'foo', output_mode: 'content', '-i': true, '-C': 1 });
    expect(text).toBe(
      [
        'Found 4 matching lines in 3 files',
        '',
        `${p('.github/ci.yml')}:1:run: foo`,
        '--',
        `${p('src/a.ts')}-1-alpha`,
        `${p('src/a.ts')}:2:beta foo`,
        `${p('src/a.ts')}-3-gamma`,
        `${p('src/a.ts')}-4-delta`,
        `${p('src/a.ts')}:5:FOO epsilon`,
        `${p('src/a.ts')}-6-zeta`,
        '--',
        `${p('src/sub/b.js')}:1:const foo = 1;`,
      ].join('\n')
    );
  });

  it('counts matching lines per file, and narrows by type, glob and path', async () => {
    expect((await grep({ pattern: 'foo', output_mode: 'count', '-i': true })).text).toBe(
      [
        'Found 4 matching lines in 3 files',
        '',
        `${p('.github/ci.yml')}:1`,
        `${p('src/a.ts')}:2`,
        `${p('src/sub/b.js')}:1`,
      ].join('\n')
    );
    expect((await grep({ pattern: 'foo', type: 'js' })).text).toBe(
      `Found 1 file\n\n${p('src/sub/b.js')}`
    );
    expect(
      (await grep({ pattern: 'foo', '-i': true, glob: '*.ts,*.yml' })).value.entries
    ).toHaveLength(2);
    expect((await grep({ pattern: 'foo', '-i': true, glob: '!*.yml' })).value.entries).toHaveLength(
      2
    );
    expect((await grep({ pattern: 'foo', '-i': true, path: 'src' })).value.entries).toHaveLength(2);
    // Case matters unless -i says otherwise.
    expect((await grep({ pattern: 'FOO', output_mode: 'count' })).text).toBe(
      `Found 1 matching line in 1 file\n\n${p('src/a.ts')}:1`
    );
  });

  it('matches across lines with multiline', async () => {
    const { text } = await grep({
      pattern: 'beta.*gamma',
      output_mode: 'content',
      multiline: true,
    });
    expect(text).toBe(
      `Found 2 matching lines in 1 file\n\n${p('src/a.ts')}:2:beta foo\n${p('src/a.ts')}:3:gamma`
    );
    expect((await grep({ pattern: 'beta.*gamma' })).text).toBe('No matches found');
  });

  it('pages a result with head_limit and offset', async () => {
    const first = await grep({ pattern: '.', output_mode: 'content', path: 'src', head_limit: 4 });
    expect(first.text).toContain('Found 7 matching lines in 2 files');
    expect(first.text).toContain(
      '(Showing lines 1-4 of 7. Call grep again with the same arguments and offset: 4'
    );
    const rest = await grep({
      pattern: '.',
      output_mode: 'content',
      path: 'src',
      head_limit: 4,
      offset: 4,
    });
    expect(rest.text).toContain(`${p('src/a.ts')}:5:FOO epsilon`);
    expect(rest.text).toContain('(Showing lines 5-7 of 7: the last page.)');
  });

  it('shows a path outside the workspace as given, and one inside relative to it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'aiclient-grep-outside-'));
    try {
      writeFileSync(join(outside, 'x.txt'), 'foo\n');
      const { text } = await grep({ pattern: 'foo', path: outside });
      expect(text).toBe(`Found 1 file\n\n${join(outside, 'x.txt')}`);
      const inside = await grep({ pattern: 'foo', path: join(workspace, 'src', 'sub') });
      expect(inside.text).toBe(`Found 1 file\n\n${p('src/sub/b.js')}`);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports a bad pattern, a bad type and a missing path with ripgrep’s words', async () => {
    const registered = mount();
    await expect(registered.definition.execute({ pattern: 'foo(' }, exec())).rejects.toMatchObject({
      code: 'SEARCH_INVALID_PATTERN',
    });
    await expect(
      registered.definition.execute({ pattern: 'foo', type: 'nope' }, exec())
    ).rejects.toThrow(/unrecognized file type: nope/);
    await expect(
      registered.definition.execute({ pattern: 'foo', path: 'missing' }, exec())
    ).rejects.toMatchObject({ code: 'SEARCH_FAILED' });
  });
});

describe('outcomes a real ripgrep rarely gives', () => {
  it('returns what an exit-2 run printed, with its complaints as a note', async () => {
    const { text } = await grep(
      { pattern: 'foo' },
      mount(scriptedSubprocess(2, 'a.ts\0', 'rg: ./locked: Permission denied (os error 13)\n'))
    );
    expect(text).toBe(
      'Found 1 file\n\na.ts\n\n(Some paths could not be searched: rg: ./locked: Permission denied (os error 13))'
    );
  });

  it('fails an exit-2 run that printed nothing, and output it cannot read', async () => {
    const failed = mount(scriptedSubprocess(2, '', 'rg: ./x: some error\n'));
    await expect(failed.definition.execute({ pattern: 'foo' }, exec())).rejects.toMatchObject({
      code: 'SEARCH_FAILED',
      message: 'grep search failed (exit 2): rg: ./x: some error',
    });
    const garbled = mount(scriptedSubprocess(0, '{not json\n', ''));
    await expect(
      garbled.definition.execute({ pattern: 'foo', output_mode: 'content' }, exec())
    ).rejects.toMatchObject({ code: 'SEARCH_FAILED' });
  });

  it('turns an abort into SEARCH_ABORTED', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      mount().definition.execute({ pattern: 'foo' }, exec(workspace, controller.signal))
    ).rejects.toMatchObject({ code: 'SEARCH_ABORTED' });
  });
});
