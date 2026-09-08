import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BorrowedResourcePaths,
  defaultSkillInstallInstructions,
  hasBorrowedPaths,
  prependBorrowedInstructions,
  resolveBorrowedResourcePaths,
} from '../userResourcePaths.ts';

/**
 * R01 — borrowing the user's own skills and prompt templates.
 *
 * Real temporary directories rather than a stubbed fs, same as
 * `permissionPlugin.test.ts`: the whole point of this module is what exists on
 * disk, and a stub would let a wrong path pass.
 */

const temporaries: string[] = [];

function agentDir(subdirs: string[]): string {
  const base = mkdtempSync(join(tmpdir(), 'borrow-res-'));
  temporaries.push(base);
  for (const dir of subdirs) mkdirSync(join(base, dir), { recursive: true });
  return base;
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ACTIVE = '/managed/pi-agent';

describe('resolveBorrowedResourcePaths', () => {
  it('borrows both directories when both exist', () => {
    const source = agentDir(['skills', 'prompts']);
    expect(resolveBorrowedResourcePaths(source, ACTIVE)).toEqual({
      skills: [join(source, 'skills')],
      globalInstructions: [],
      promptTemplates: [join(source, 'prompts')],
    });
  });

  it('drops a directory that does not exist rather than passing it on', () => {
    // The loader would report a diagnostic for a missing path, and "you have no
    // prompt templates installed" is not a problem worth a warning.
    const source = agentDir(['skills']);
    expect(resolveBorrowedResourcePaths(source, ACTIVE)).toEqual({
      skills: [join(source, 'skills')],
      globalInstructions: [],
      promptTemplates: [],
    });
  });

  it('borrows nothing from an agent dir with neither directory', () => {
    const source = agentDir([]);
    expect(resolveBorrowedResourcePaths(source, ACTIVE)).toEqual({
      skills: [],
      globalInstructions: [],
      promptTemplates: [],
    });
  });

  it('treats an absent or blank source as "do not borrow"', () => {
    // One value carries both the switch and the target: there is no second
    // state where a path is present but disabled.
    const empty: BorrowedResourcePaths = {
      skills: [],
      promptTemplates: [],
      globalInstructions: [],
    };
    expect(resolveBorrowedResourcePaths(undefined, ACTIVE)).toEqual(empty);
    expect(resolveBorrowedResourcePaths('', ACTIVE)).toEqual(empty);
    expect(resolveBorrowedResourcePaths('   ', ACTIVE)).toEqual(empty);
  });

  it('refuses to borrow the directory this session already loads', () => {
    // Non-managed mode points the agent dir AT the user's own. Borrowing it
    // again would load every skill twice, so the guard lives in this module and
    // not only in Main.
    const source = agentDir(['skills', 'prompts']);
    expect(resolveBorrowedResourcePaths(source, source)).toEqual({
      skills: [],
      globalInstructions: [],
      promptTemplates: [],
    });
  });

  it('recognises the same directory through relative segments', () => {
    const source = agentDir(['skills']);
    const roundabout = join(source, 'skills', '..');
    expect(resolveBorrowedResourcePaths(roundabout, source)).toEqual({
      skills: [],
      globalInstructions: [],
      promptTemplates: [],
    });
  });

  it('returns absolute paths', () => {
    const source = agentDir(['skills']);
    for (const path of resolveBorrowedResourcePaths(source, ACTIVE).skills) {
      expect(path.startsWith(source)).toBe(true);
    }
  });
});

describe('hasBorrowedPaths', () => {
  it('is false only when both lists are empty', () => {
    expect(hasBorrowedPaths({ skills: [], promptTemplates: [], globalInstructions: [] })).toBe(
      false
    );
    expect(hasBorrowedPaths({ skills: ['/a'], promptTemplates: [], globalInstructions: [] })).toBe(
      true
    );
    expect(hasBorrowedPaths({ skills: [], promptTemplates: ['/b'], globalInstructions: [] })).toBe(
      true
    );
  });
});

describe('B1/B2 resource instructions', () => {
  it('resolves the installation hint against the supplied home', () => {
    expect(defaultSkillInstallInstructions('/custom-home')).toContain(
      join('/custom-home', '.agents', 'skills')
    );
  });

  it('borrows global instructions read-only, keeps project context last, and never exposes extension paths', () => {
    const source = agentDir(['extensions']);
    const path = join(source, 'AGENTS.md');
    writeFileSync(path, 'Personal global instructions');
    const paths = resolveBorrowedResourcePaths(source, ACTIVE);
    expect(paths.globalInstructions).toEqual([path]);
    expect(Object.keys(paths).sort()).toEqual(['globalInstructions', 'promptTemplates', 'skills']);
    const base = { agentsFiles: [{ path: '/project/AGENTS.md', content: 'Project instructions' }] };
    expect(prependBorrowedInstructions(base, paths.globalInstructions).agentsFiles).toEqual([
      { path, content: 'Personal global instructions' },
      ...base.agentsFiles,
    ]);
    expect(readFileSync(path, 'utf8')).toBe('Personal global instructions');
    expect(resolveBorrowedResourcePaths(source, source).globalInstructions).toEqual([]);
    expect(
      prependBorrowedInstructions({ agentsFiles: [{ path, content: 'Already loaded' }] }, [path])
        .agentsFiles
    ).toHaveLength(1);
  });

  it('drops missing global instructions and treats an instructions-only borrow as nonempty', () => {
    expect(resolveBorrowedResourcePaths(agentDir([]), ACTIVE).globalInstructions).toEqual([]);
    expect(
      hasBorrowedPaths({ skills: [], promptTemplates: [], globalInstructions: ['/a/AGENTS.md'] })
    ).toBe(true);
  });
});
