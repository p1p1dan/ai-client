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
  onDemandInstructionsText,
  projectInstructionsSegment,
} from '../plugins/prompt/projectInstructions.ts';

// `resolve` is what the loader applies to the root, and on Windows it adds a
// drive letter. Resolving here too, and keying the in-memory tree with `join`,
// keeps the fake tree spelled the way the loader will look it up.
const ROOT = resolve('/work/repo');
const at = (...parts: string[]) => join(ROOT, ...parts);
/**
 * decision 007 / 008 — the project and local tiers only load for a workspace
 * the host has trusted, so every case that expects a project file to appear has
 * to say so. Spelled as one shared constant rather than repeated inline: the
 * cases below are about tiers and budgets, and trust is not what any of them is
 * testing. The cases that DO test it pass the flag themselves.
 */
const TRUSTED = { projectTrusted: true } as const;

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

describe('instructionDirectories', () => {
  it('walks to just below the filesystem root, least specific first', () => {
    // decision 007 follows Claude Code's documented "recurses up to but not
    // including /". The last entry has to be the workspace itself, because the
    // prompt block tells the model the more specific file wins and "more
    // specific" is spelled "later" in the rendered order.
    const chain = instructionDirectories(resolve('/a/b/c'));
    expect(chain).toEqual([resolve('/a'), resolve('/a/b'), resolve('/a/b/c')]);
    expect(chain).not.toContain(resolve('/'));
  });

  it('answers with the workspace itself when that workspace IS the root', () => {
    // context-prompt-13's workspace. Excluding `/` as a PARENT must not also
    // exclude it as the workspace someone actually opened.
    expect(instructionDirectories(resolve('/'))).toEqual([resolve('/')]);
  });
});

describe('loadInstructionChain', () => {
  it('loads the workspace and every parent, and never a subdirectory', async () => {
    // context-prompt-03 / decision 007. The root→leaf walk was driven by a
    // `targetPath` no caller ever supplied. The official rule replaces it: every
    // parent at session start, subdirectories only on demand — so a nested file
    // must not be read here at all, and no read must be attempted for one.
    const { source, calls } = fakeSource({
      [resolve('/work', 'AGENTS.md')]: 'outer rule',
      [at('AGENTS.md')]: 'root rule',
      [at('src', 'AGENTS.md')]: 'src rule',
    });
    const entries = await loadInstructionChain(source, { root: ROOT, ...TRUSTED });
    expect(entries.map((entry) => entry.content)).toEqual(['outer rule', 'root rule']);
    expect(calls).not.toContain(at('src', 'AGENTS.md'));
  });

  it('orders two levels of parent from least to most specific', async () => {
    // The workspace is two levels down, so `/work` and `/work/repo` are both
    // parents and both have to appear, outermost first.
    const workspace = at('a', 'b');
    const { source } = fakeSource({
      [resolve('/work', 'CLAUDE.md')]: 'grandparent rule',
      [at('AGENTS.md')]: 'parent rule',
      [join(workspace, 'AGENTS.md')]: 'workspace rule',
    });
    const entries = await loadInstructionChain(source, { root: workspace, ...TRUSTED });
    expect(entries.map((entry) => entry.content)).toEqual([
      'grandparent rule',
      'parent rule',
      'workspace rule',
    ]);
    // Labelled relative to the workspace, so a parent reads as one in the
    // prompt rather than as an absolute path off someone's machine.
    expect(entries.map((entry) => entry.source)).toEqual([
      '../../../CLAUDE.md',
      '../../AGENTS.md',
      'AGENTS.md',
    ]);
  });

  it('spends one budget across the parents and stops where it runs out', async () => {
    const { source, calls } = fakeSource({
      [resolve('/work', 'AGENTS.md')]: 'o'.repeat(40),
      [at('AGENTS.md')]: 'w'.repeat(40),
    });
    const entries = await loadInstructionChain(source, { root: ROOT, ...TRUSTED, maxBytes: 40 });
    // The outer file took the whole budget, so the workspace's own was never
    // even read — the same exhaust-and-stop rule the globals already follow.
    expect(entries.map((entry) => entry.content)).toEqual(['o'.repeat(40)]);
    expect(calls).not.toContain(at('AGENTS.md'));
  });

  it('checks the symlink guard per directory, so a parent cannot escape either', async () => {
    const parent = resolve('/work');
    const { source } = fakeSource(
      { [join(parent, 'AGENTS.md')]: 'ssh config contents', [at('AGENTS.md')]: 'workspace rule' },
      { [join(parent, 'AGENTS.md')]: '/home/u/.ssh/config' }
    );
    const entries = await loadInstructionChain(source, { root: ROOT, ...TRUSTED });
    expect(entries.map((entry) => entry.content)).toEqual(['workspace rule']);
  });

  it('finds the instruction file when the workspace IS the filesystem root', async () => {
    // context-prompt-13. `resolve('/')` keeps its trailing separator, so the
    // old `startsWith(root + sep)` containment test built the prefix '//' and
    // matched nothing: the symlink guard rejected a file that was plainly
    // inside the workspace, and the whole section vanished with no diagnostic.
    const fsRoot = resolve('/');
    const file = join(fsRoot, 'AGENTS.md');
    const { source } = fakeSource({ [file]: 'root-of-the-world rule' });
    const entries = await loadInstructionChain(source, { root: fsRoot, ...TRUSTED });
    expect(entries.map((entry) => entry.content)).toEqual(['root-of-the-world rule']);
  });

  it('takes one file per directory, override first', async () => {
    const { source } = fakeSource({
      [at('AGENTS.override.md')]: 'override',
      [at('AGENTS.md')]: 'plain',
      [at('CLAUDE.md')]: 'claude',
    });
    const entries = await loadInstructionChain(source, { root: ROOT, ...TRUSTED });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toBe('override');
  });

  it('falls through to CLAUDE.md when no AGENTS file exists', async () => {
    const { source } = fakeSource({ [at('CLAUDE.md')]: 'claude rule' });
    const entries = await loadInstructionChain(source, { root: ROOT, ...TRUSTED });
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
      ...TRUSTED,
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
      ...TRUSTED,
      globals: [{ path: '/nowhere/AGENTS.md', label: 'global' }],
    });
    expect(entries.map((entry) => entry.source)).toEqual(['AGENTS.md']);
  });

  it('skips a file whose real path leaves the workspace', async () => {
    const { source } = fakeSource(
      { [at('AGENTS.md')]: 'ssh config contents' },
      { [at('AGENTS.md')]: '/home/u/.ssh/config' }
    );
    expect(await loadInstructionChain(source, { root: ROOT, ...TRUSTED })).toEqual([]);
  });

  it('ignores a file that is only whitespace', async () => {
    const { source } = fakeSource({ [at('AGENTS.md')]: '   \n\n  ' });
    expect(await loadInstructionChain(source, { root: ROOT, ...TRUSTED })).toEqual([]);
  });

  it('shares one budget across the chain and stops when it runs out', async () => {
    const { source } = fakeSource({
      '/g/AGENTS.md': 'a'.repeat(40),
      [at('AGENTS.md')]: 'b'.repeat(40),
    });
    const entries = await loadInstructionChain(source, {
      root: ROOT,
      ...TRUSTED,
      globals: [{ path: '/g/AGENTS.md', label: 'global' }],
      maxBytes: 50,
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.content).toHaveLength(40);
    // The project file only gets what the global left behind.
    expect(entries[1]?.content).toHaveLength(10);
  });

  it('does not read the project chain at all once the globals fill the budget', async () => {
    const { source, calls } = fakeSource({
      '/g/AGENTS.md': 'g'.repeat(64),
      [at('AGENTS.md')]: 'project rule',
    });
    const entries = await loadInstructionChain(source, {
      root: ROOT,
      ...TRUSTED,
      globals: [{ path: '/g/AGENTS.md', label: 'global' }],
      maxBytes: 64,
    });
    expect(entries.map((entry) => entry.source)).toEqual(['global']);
    expect(calls).not.toContain(at('AGENTS.md'));
  });

  it('defaults to the 32 KiB budget', async () => {
    const { source } = fakeSource({ [at('AGENTS.md')]: 'x'.repeat(MAX_INSTRUCTION_BYTES * 2) });
    const [entry] = await loadInstructionChain(source, { root: ROOT, ...TRUSTED });
    expect(Buffer.byteLength(entry?.content ?? '', 'utf8')).toBe(MAX_INSTRUCTION_BYTES);
  });
});

describe('loadInstructionChain tiers (decision 007 / 008)', () => {
  it('adds CLAUDE.local.md to the same directory rather than replacing its file', async () => {
    // The point of the local tier: it is the not-checked-in companion to a
    // shared file, so a repository's AGENTS.md must still be there. If this
    // ever returns one entry, someone made the local name a fifth
    // first-one-wins candidate.
    const { source } = fakeSource({
      [resolve('/work', 'CLAUDE.local.md')]: 'parent local rule',
      [at('AGENTS.md')]: 'shared rule',
      [at('CLAUDE.local.md')]: 'local rule',
    });
    const entries = await loadInstructionChain(source, { root: ROOT, ...TRUSTED });
    expect(entries.map((entry) => entry.content)).toEqual([
      'parent local rule',
      'shared rule',
      'local rule',
    ]);
  });

  it('leaves CLAUDE.local.md unread when the local source is switched off', async () => {
    const { source, calls } = fakeSource({
      [at('AGENTS.md')]: 'shared rule',
      [at('CLAUDE.local.md')]: 'local rule',
    });
    const entries = await loadInstructionChain(source, {
      root: ROOT,
      ...TRUSTED,
      settingSources: ['user', 'project'],
    });
    expect(entries.map((entry) => entry.content)).toEqual(['shared rule']);
    expect(calls).not.toContain(at('CLAUDE.local.md'));
  });

  it('loads no project or local file for a workspace the host has not trusted', async () => {
    // A CLAUDE.md is text the model is told to obey. A folder nobody vouched
    // for must not be able to write it, exactly as it cannot contribute a
    // permission rule or a skill.
    const { source, calls } = fakeSource({
      '/g/AGENTS.md': 'global rule',
      [resolve('/work', 'AGENTS.md')]: 'parent rule',
      [at('AGENTS.md')]: 'project rule',
      [at('CLAUDE.local.md')]: 'local rule',
    });
    const entries = await loadInstructionChain(source, {
      root: ROOT,
      globals: [{ path: '/g/AGENTS.md', label: 'global' }],
    });
    expect(entries.map((entry) => entry.source)).toEqual(['global']);
    expect(calls).toEqual(['/g/AGENTS.md']);
  });

  it('switches off a host-supplied global but never the managed one', async () => {
    // decision 008 clause 3 in one case: `<agentDir>/AGENTS.md` ships with the
    // app, so it is not a "source" the caller can drop; `~/.claude/CLAUDE.md`
    // arrives through the same list and is the `user` tier.
    const { source } = fakeSource({
      '/managed/AGENTS.md': 'managed rule',
      '/home/u/.claude/CLAUDE.md': 'user rule',
      [at('AGENTS.md')]: 'project rule',
    });
    const globals = [
      { path: '/managed/AGENTS.md', label: 'Managed AGENTS.md', scope: 'managed' as const },
      { path: '/home/u/.claude/CLAUDE.md', label: 'User CLAUDE.md' },
    ];
    expect(
      (
        await loadInstructionChain(source, {
          root: ROOT,
          ...TRUSTED,
          globals,
          settingSources: ['project', 'local'],
        })
      ).map((entry) => entry.source)
    ).toEqual(['Managed AGENTS.md', 'AGENTS.md']);
    expect(
      (await loadInstructionChain(source, { root: ROOT, ...TRUSTED, globals })).map(
        (entry) => entry.source
      )
    ).toEqual(['Managed AGENTS.md', 'User CLAUDE.md', 'AGENTS.md']);
  });

  it('treats an omitted settingSources as all three', async () => {
    const { source } = fakeSource({
      '/home/u/.claude/CLAUDE.md': 'user rule',
      [at('AGENTS.md')]: 'project rule',
      [at('CLAUDE.local.md')]: 'local rule',
    });
    const globals = [{ path: '/home/u/.claude/CLAUDE.md', label: 'User CLAUDE.md' }];
    const omitted = await loadInstructionChain(source, { root: ROOT, ...TRUSTED, globals });
    const explicit = await loadInstructionChain(source, {
      root: ROOT,
      ...TRUSTED,
      globals,
      settingSources: ['user', 'project', 'local'],
    });
    expect(omitted).toEqual(explicit);
    expect(omitted).toHaveLength(3);
  });

  it('reads nothing at all when the list is empty', async () => {
    // An empty array is a real answer, not a missing one: it is what a fixed
    // probe asks for. The managed file is still not a setting source.
    const { source } = fakeSource({
      '/managed/AGENTS.md': 'managed rule',
      [at('AGENTS.md')]: 'project rule',
    });
    const entries = await loadInstructionChain(source, {
      root: ROOT,
      ...TRUSTED,
      globals: [{ path: '/managed/AGENTS.md', label: 'Managed AGENTS.md', scope: 'managed' }],
      settingSources: [],
    });
    expect(entries.map((entry) => entry.source)).toEqual(['Managed AGENTS.md']);
  });
});

describe('onDemandInstructionsText', () => {
  it('says nothing when nothing came into scope', () => {
    expect(onDemandInstructionsText([])).toBeUndefined();
  });

  it('keeps the accumulation wording the system prompt block uses', () => {
    const text = onDemandInstructionsText([{ source: 'src/AGENTS.md', content: 'src rule' }]);
    // The same sentence as `projectInstructionsSegment`: a subdirectory's file
    // is one more entry in the same list, not a new regime.
    expect(text).toContain('the more specific file says so itself');
    expect(text).toContain('## src/AGENTS.md');
    expect(text).toContain('src rule');
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
    expect(segment?.text).toContain('the more specific file says so itself');
    expect(segment?.text).toMatch(/## src\/AGENTS\.md/);
  });

  it('ends without trailing blank lines, so the next slot is one separator away', () => {
    const segment = projectInstructionsSegment([{ source: 'AGENTS.md', content: 'rule' }]);
    expect(segment?.text.endsWith('rule')).toBe(true);
  });
});
