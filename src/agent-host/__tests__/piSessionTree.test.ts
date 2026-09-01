import { describe, expect, it } from 'vitest';
import { buildPiSessionTreeSnapshot, readPiLeafCheckpoint } from '../piSessionTree.ts';

function message(id: string, parentId: string | null, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

describe('piSessionTree', () => {
  it('iteratively projects branches, active path, leaf, labels, and orphans', () => {
    const entries = [
      message('a', null, 'A'),
      message('b', 'a', 'B'),
      message('c', 'b', 'C'),
      message('d', 'a', 'D'),
      message('orphan', 'missing', 'orphan'),
    ];
    const manager = {
      getEntries: () => entries,
      getBranch: () => [entries[0], entries[3]],
      getLeafId: () => 'd',
      getLabel: (id: string) => (id === 'a' ? 'branch point' : undefined),
    };
    const snapshot = buildPiSessionTreeSnapshot({
      manager,
      logicalSessionId: 'logical',
      sessionFile: '/sessions/one.jsonl',
      workspacePath: '/repo',
    });

    expect(snapshot.leaf).toEqual({ activeEntryId: 'd', fileTailEntryId: 'orphan' });
    expect(snapshot.nodes.map((node) => [node.id, node.depth, node.active, node.leaf])).toEqual([
      ['a', 0, true, false],
      ['b', 1, false, false],
      ['c', 2, false, false],
      ['d', 1, true, true],
      ['orphan', 0, false, false],
    ]);
    expect(snapshot.nodes[0]).toMatchObject({
      label: 'branch point',
      childCount: 2,
      preview: 'A',
      forkable: false,
    });
    expect(snapshot.nodes.find((node) => node.id === 'c')).toMatchObject({ forkable: false });
  });

  it('caps a deep tree without recursive stack growth', () => {
    const entries = Array.from({ length: 10_000 }, (_, index) =>
      message(`n-${index}`, index === 0 ? null : `n-${index - 1}`, `node ${index}`)
    );
    const snapshot = buildPiSessionTreeSnapshot({
      manager: {
        getEntries: () => entries,
        getBranch: () => entries,
        getLeafId: () => 'n-9999',
      },
      logicalSessionId: 'logical',
      sessionFile: '/sessions/deep.jsonl',
      workspacePath: '/repo',
    });

    expect(snapshot.totalNodes).toBe(10_000);
    expect(snapshot.returnedNodes).toBe(4_000);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.nodes[0]).toMatchObject({ id: 'n-6000', depth: 6000 });
    expect(snapshot.nodes.at(-1)).toMatchObject({ id: 'n-9999', depth: 9999, leaf: true });
  });

  it('retains an explicit root leaf checkpoint', () => {
    expect(
      readPiLeafCheckpoint({
        getEntries: () => [message('a', null, 'A')],
        getLeafId: () => null,
      })
    ).toEqual({ activeEntryId: null, fileTailEntryId: 'a' });
  });
});
