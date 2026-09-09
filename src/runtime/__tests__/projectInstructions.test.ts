/**
 * P2-2 gate (pure half).
 *
 * The instruction chain is the one part of the prompt the user writes, so its
 * failure modes are all quiet: a file silently skipped, a precedence order
 * silently reversed, a symlink silently pulling `~/.ssh/config` into the
 * prompt, or one oversized AGENTS.md silently eating the context window. None
 * of those throws, so each one is pinned here.
 *
 * Reading goes through {@link InstructionSource}, so the whole chain runs
 * against an in-memory tree — no fixture directory, and no dependency on
 * P1-0's `runtimeHostIo` landing first.
 */

import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type InstructionSource,
  instructionDirectories,
  limitUtf8,
  loadInstructionChain,
  MAX_INSTRUCTION_BYTES,
  projectInstructionsSegment,
} from '../plugins/prompt/projectInstructions.ts';

// `resolve` is what the loader applies to the root, and on Windows it adds a
// drive letter. Resolving here too, and keying the in-memory tree with `join`,
// keeps the fake tree spelled the way the loader will look it up.
const ROOT = resolve('/work/repo');
const at = (...parts: string[]) => join(ROOT, ...parts);

/**
 * In-memory source. `links` maps a path to what `realpath` answers, so a test
 * can point a file outside the root without creating one.
 */
function fakeSource(files: Record<string, string>, links: Record<string, string> = {}) {
  const calls: string[] = [];
  const source: InstructionSource = {
    async readText(path) {
      calls.push(path);
      return files[path];
    },
    async realpath(path) {
      if (links[path]) return links[path];
      return path in files || path === ROOT ? path : undefined;
    },
  };
  return { source, calls };
}

describe('instructionDirectories', () => {
  it('walks root first and the target directory last', () => {
    expect(instructionDirectories(ROOT, 'src/main/app.ts')).toEqual([
      ROOT,
      at('src'),
      at('src', 'main'),
    ]);
  });

  it('is just the root when no target file is named', () => {
    expect(instructionDirectories(ROOT)).toEqual([ROOT]);
    expect(instructionDirectories(ROOT, '   ')).toEqual([ROOT]);
  });

  it('refuses a target that climbs out of the workspace', () => {
    expect(instructionDirectories(ROOT, '../secrets/app.ts')).toBeUndefined();
    expect(instructionDirectories(ROOT, '/etc/passwd')).toBeUndefined();
  });
});

describe('limitUtf8', () => {
  it('never splits a multi-byte character', () => {
    // 中 is three bytes; a byte-wise cut at 4 would leave half of the second.
    expect(limitUtf8('中中', 4)).toBe('中');
    expect(Buffer.byteLength(limitUtf8('中中', 4), 'utf8')).toBeLessThanOrEqual(4);
  });

  it('returns nothing when there is no budget left', () => {
    expect(limitUtf8('anything', 0)).toBe('');
  });

  it('leaves content that fits untouched', () => {
    expect(limitUtf8('short', 100)).toBe('short');
  });
});

describe('loadInstructionChain', () => {
  it('gives nested files the last word', async () => {
    const { source } = fakeSource({
      [at('AGENTS.md')]: 'root rule',
      [at('src', 'AGENTS.md')]: 'src rule',
    });
    const entries = await loadInstructionChain(source, { root: ROOT, targetPath: 'src/app.ts' });
    expect(entries.map((entry) => entry.source)).toEqual(['AGENTS.md', 'src/AGENTS.md']);
  });

  it('takes one file per directory, override first', async () => {
    const { source } = fakeSource({
      [at('AGENTS.override.md')]: 'override',
      [at('AGENTS.md')]: 'plain',
      [at('CLAUDE.md')]: 'claude',
    });
    const entries = await loadInstructionChain(source, { root: ROOT });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toBe('override');
  });

  it('falls through to CLAUDE.md when no AGENTS file exists', async () => {
    const { source } = fakeSource({ [at('CLAUDE.md')]: 'claude rule' });
    const entries = await loadInstructionChain(source, { root: ROOT });
    expect(entries[0]).toEqual({ source: 'CLAUDE.md', content: 'claude rule' });
  });

  it('puts globals before every project file', async () => {
    const { source } = fakeSource({
      '/home/u/.pilab/pi-agent/AGENTS.md': 'managed global',
      '/home/u/.pi/agent/AGENTS.md': 'borrowed global',
      [at('AGENTS.md')]: 'project rule',
    });
    const entries = await loadInstructionChain(source, {
      root: ROOT,
      globals: [
        { path: '/home/u/.pilab/pi-agent/AGENTS.md', label: 'managed AGENTS.md' },
        { path: '/home/u/.pi/agent/AGENTS.md', label: 'borrowed AGENTS.md' },
      ],
    });
    expect(entries.map((entry) => entry.source)).toEqual([
      'managed AGENTS.md',
      'borrowed AGENTS.md',
      'AGENTS.md',
    ]);
  });

  it('treats a missing global as the ordinary first-run state', async () => {
    const { source } = fakeSource({ [at('AGENTS.md')]: 'project rule' });
    const entries = await loadInstructionChain(source, {
      root: ROOT,
      globals: [{ path: '/nowhere/AGENTS.md', label: 'global' }],
    });
    expect(entries.map((entry) => entry.source)).toEqual(['AGENTS.md']);
  });

  it('skips a file whose real path leaves the workspace', async () => {
    const { source } = fakeSource(
      { [at('AGENTS.md')]: 'ssh config contents' },
      { [at('AGENTS.md')]: '/home/u/.ssh/config' }
    );
    expect(await loadInstructionChain(source, { root: ROOT })).toEqual([]);
  });

  it('ignores a file that is only whitespace', async () => {
    const { source } = fakeSource({ [at('AGENTS.md')]: '   \n\n  ' });
    expect(await loadInstructionChain(source, { root: ROOT })).toEqual([]);
  });

  it('shares one budget across the chain and stops when it runs out', async () => {
    const { source } = fakeSource({
      [at('AGENTS.md')]: 'a'.repeat(40),
      [at('src', 'AGENTS.md')]: 'b'.repeat(40),
    });
    const entries = await loadInstructionChain(source, {
      root: ROOT,
      targetPath: 'src/app.ts',
      maxBytes: 50,
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.content).toHaveLength(40);
    // The second file only gets what the first left behind.
    expect(entries[1]?.content).toHaveLength(10);
  });

  it('does not read the project chain at all once the globals fill the budget', async () => {
    const { source, calls } = fakeSource({
      '/g/AGENTS.md': 'g'.repeat(64),
      [at('AGENTS.md')]: 'project rule',
    });
    const entries = await loadInstructionChain(source, {
      root: ROOT,
      globals: [{ path: '/g/AGENTS.md', label: 'global' }],
      maxBytes: 64,
    });
    expect(entries.map((entry) => entry.source)).toEqual(['global']);
    expect(calls).not.toContain(at('AGENTS.md'));
  });

  it('returns nothing rather than the root chain when the target escapes', async () => {
    const { source } = fakeSource({ [at('AGENTS.md')]: 'root rule' });
    expect(
      await loadInstructionChain(source, { root: ROOT, targetPath: '../other/app.ts' })
    ).toEqual([]);
  });

  it('defaults to the 32 KiB budget', async () => {
    const { source } = fakeSource({ [at('AGENTS.md')]: 'x'.repeat(MAX_INSTRUCTION_BYTES * 2) });
    const [entry] = await loadInstructionChain(source, { root: ROOT });
    expect(Buffer.byteLength(entry?.content ?? '', 'utf8')).toBe(MAX_INSTRUCTION_BYTES);
  });
});

describe('projectInstructionsSegment', () => {
  it('contributes nothing when the chain is empty', () => {
    expect(projectInstructionsSegment([])).toBeUndefined();
  });

  it('names the slot and keeps chain order in the rendered block', () => {
    const segment = projectInstructionsSegment([
      { source: 'AGENTS.md', content: 'root rule' },
      { source: 'src/AGENTS.md', content: 'src rule' },
    ]);
    expect(segment?.slot).toBe('project-instructions');
    expect(segment?.text.indexOf('root rule')).toBeLessThan(
      segment?.text.indexOf('src rule') ?? -1
    );
    // Without this sentence the model has no rule for two contradicting files.
    expect(segment?.text).toContain('take precedence');
    expect(segment?.text).toMatch(/## src\/AGENTS\.md/);
  });

  it('ends without trailing blank lines, so the next slot is one separator away', () => {
    const segment = projectInstructionsSegment([{ source: 'AGENTS.md', content: 'rule' }]);
    expect(segment?.text.endsWith('rule')).toBe(true);
  });
});
