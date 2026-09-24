import { describe, expect, it } from 'vitest';
import { RUN_STOP_CUSTOM_TYPE } from '../../shared/types/sessionHistory.ts';
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

describe('run-stop records in the session tree', () => {
  const assistant = (id: string, parentId: string, text: string) => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' },
  });
  const runStop = (id: string, parentId: string) => ({
    type: 'custom',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:02.000Z',
    customType: RUN_STOP_CUSTOM_TYPE,
    data: { cause: 'interjected', runId: 'run-1' },
  });
  const permissions = (id: string, parentId: string) => ({
    type: 'custom',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.500Z',
    customType: 'aiclient.permissions',
    data: { mode: 'default', gear: 'auto' },
  });

  it('never becomes a node, and hands the leaf mark to the message it closes', () => {
    const entries = [
      message('u', null, 'question'),
      assistant('a', 'u', 'answer'),
      runStop('stop', 'a'),
    ];
    const snapshot = buildPiSessionTreeSnapshot({
      manager: { getEntries: () => entries, getBranch: () => entries, getLeafId: () => 'stop' },
      logicalSessionId: 'logical',
      sessionFile: '/sessions/stop.jsonl',
      workspacePath: '/repo',
    });

    expect(snapshot.nodes.map((node) => node.id)).toEqual(['u', 'a']);
    expect(snapshot.nodes.find((node) => node.id === 'a')).toMatchObject({
      leaf: true,
      childCount: 0,
    });
    expect(snapshot.totalNodes).toBe(2);
    // The file checkpoint is about the file, not the display: it still names
    // the record, so a stale-checkpoint comparison keeps working.
    expect(snapshot.leaf).toEqual({ activeEntryId: 'stop', fileTailEntryId: 'stop' });
  });

  it('re-parents whatever hangs off it onto the message it closes', () => {
    const entries = [
      message('u', null, 'question'),
      assistant('a', 'u', 'answer'),
      runStop('stop', 'a'),
      message('u2', 'stop', 'the interjection'),
      assistant('a2', 'u2', 'second answer'),
    ];
    const snapshot = buildPiSessionTreeSnapshot({
      manager: { getEntries: () => entries, getBranch: () => entries, getLeafId: () => 'a2' },
      logicalSessionId: 'logical',
      sessionFile: '/sessions/stop.jsonl',
      workspacePath: '/repo',
    });

    expect(snapshot.nodes.map((node) => [node.id, node.parentId, node.depth])).toEqual([
      ['u', null, 0],
      ['a', 'u', 1],
      ['u2', 'a', 2],
      ['a2', 'u2', 3],
    ]);
    expect(snapshot.nodes.find((node) => node.id === 'a2')?.leaf).toBe(true);
    // A fork point after the record is still offered.
    expect(snapshot.nodes.find((node) => node.id === 'u2')?.forkable).toBe(true);
  });

  it('leaves every other custom entry exactly where it was', () => {
    const entries = [message('u', null, 'question'), permissions('perm', 'u')];
    const snapshot = buildPiSessionTreeSnapshot({
      manager: { getEntries: () => entries, getBranch: () => entries, getLeafId: () => 'perm' },
      logicalSessionId: 'logical',
      sessionFile: '/sessions/stop.jsonl',
      workspacePath: '/repo',
    });
    expect(snapshot.nodes.map((node) => [node.id, node.entryType, node.leaf])).toEqual([
      ['u', 'message', false],
      ['perm', 'custom', true],
    ]);
  });
});
