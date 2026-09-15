/**
 * T035 — the on-demand half of decision 007's instruction tiers.
 *
 * Everything here is quiet when it breaks: a subdirectory's AGENTS.md that
 * never arrives looks exactly like one that does not exist, and a file injected
 * twice looks like a model that repeated itself. So each rule gets a case: the
 * directories between the workspace and the file, the order they come in, the
 * once-per-session guarantee, and the three ways a directory can be out of
 * scope (outside the workspace, already in the system prompt, or in a workspace
 * nobody trusted).
 *
 * Runs against the same in-memory {@link InstructionSource} the chain tests use,
 * so there is no fixture tree and no dependency on the host IO service.
 */

import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InstructionTracker } from '../plugins/prompt/instructionTracker.ts';
import type { InstructionSource } from '../plugins/prompt/projectInstructions.ts';

const ROOT = resolve('/work/repo');
const at = (...parts: string[]) => join(ROOT, ...parts);

function fakeSource(files: Record<string, string>) {
  const calls: string[] = [];
  const source: InstructionSource = {
    async readText(path) {
      calls.push(path);
      return files[path];
    },
    async realpath(path) {
      return path in files ? path : path;
    },
  };
  return { source, calls };
}

function tracker(
  files: Record<string, string>,
  options: Partial<{ enabled: boolean; local: boolean; maxBytes: number }> = {}
) {
  const { source, calls } = fakeSource(files);
  return {
    calls,
    tracker: new InstructionTracker({
      source,
      root: ROOT,
      enabled: options.enabled ?? true,
      local: options.local ?? false,
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    }),
  };
}

describe('InstructionTracker', () => {
  it('loads every directory between the workspace and the touched file, outermost first', async () => {
    const subject = tracker({
      [at('src', 'AGENTS.md')]: 'src rule',
      [at('src', 'deep', 'CLAUDE.md')]: 'deep rule',
    });
    await subject.tracker.note([at('src', 'deep', 'file.ts')]);
    expect(subject.tracker.take().map((entry) => entry.content)).toEqual(['src rule', 'deep rule']);
  });

  it('injects each directory exactly once per session', async () => {
    const subject = tracker({ [at('src', 'AGENTS.md')]: 'src rule' });
    await subject.tracker.note([at('src', 'one.ts')]);
    expect(subject.tracker.take()).toHaveLength(1);
    await subject.tracker.note([at('src', 'two.ts')]);
    expect(subject.tracker.take()).toEqual([]);
    // Not merely "returned nothing": a second read must not even look, or a
    // large repository pays a stat storm for every tool call.
    expect(subject.calls.filter((path) => path === at('src', 'AGENTS.md'))).toHaveLength(1);
  });

  it('drains, so a second take after one note is empty', async () => {
    const subject = tracker({ [at('src', 'AGENTS.md')]: 'src rule' });
    await subject.tracker.note([at('src', 'one.ts')]);
    expect(subject.tracker.take()).toHaveLength(1);
    expect(subject.tracker.take()).toEqual([]);
  });

  it('ignores a file outside the workspace', async () => {
    const subject = tracker({ [resolve('/elsewhere', 'AGENTS.md')]: 'stranger rule' });
    await subject.tracker.note([resolve('/elsewhere', 'file.ts')]);
    expect(subject.tracker.take()).toEqual([]);
    expect(subject.calls).toEqual([]);
  });

  it('ignores the workspace and its parents, which the system prompt already has', async () => {
    const subject = tracker({
      [at('AGENTS.md')]: 'workspace rule',
      [resolve('/work', 'AGENTS.md')]: 'parent rule',
    });
    await subject.tracker.note([at('file.ts'), resolve('/work', 'other.ts')]);
    expect(subject.tracker.take()).toEqual([]);
    expect(subject.calls).toEqual([]);
  });

  it('adds the local file only when the local source is on', async () => {
    const files = {
      [at('src', 'AGENTS.md')]: 'src rule',
      [at('src', 'CLAUDE.local.md')]: 'src local rule',
    };
    const off = tracker(files);
    await off.tracker.note([at('src', 'file.ts')]);
    expect(off.tracker.take().map((entry) => entry.content)).toEqual(['src rule']);

    const on = tracker(files, { local: true });
    await on.tracker.note([at('src', 'file.ts')]);
    expect(on.tracker.take().map((entry) => entry.content)).toEqual(['src rule', 'src local rule']);
  });

  it('reads nothing when the project tier is closed', async () => {
    const subject = tracker({ [at('src', 'AGENTS.md')]: 'src rule' }, { enabled: false });
    await subject.tracker.note([at('src', 'file.ts')]);
    expect(subject.tracker.take()).toEqual([]);
    expect(subject.calls).toEqual([]);
  });

  it('stops once the session budget is spent', async () => {
    const subject = tracker(
      {
        [at('a', 'AGENTS.md')]: 'a'.repeat(40),
        [at('b', 'AGENTS.md')]: 'b'.repeat(40),
      },
      { maxBytes: 40 }
    );
    await subject.tracker.note([at('a', 'file.ts')]);
    await subject.tracker.note([at('b', 'file.ts')]);
    expect(subject.tracker.take().map((entry) => entry.content)).toEqual(['a'.repeat(40)]);
  });

  it('never lets a failing read escape into the tool call', async () => {
    // A tool result must not turn into an error because an AGENTS.md beside the
    // file it read was unreadable in a way the source could not absorb.
    const source: InstructionSource = {
      async readText() {
        throw new Error('disk on fire');
      },
      async realpath(path) {
        return path;
      },
    };
    const subject = new InstructionTracker({ source, root: ROOT, enabled: true, local: false });
    await expect(subject.note([at('src', 'file.ts')])).resolves.toBeUndefined();
    expect(subject.take()).toEqual([]);
  });
});
