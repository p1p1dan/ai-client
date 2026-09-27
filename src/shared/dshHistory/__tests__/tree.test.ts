import { describe, expect, it } from 'vitest';
import type { HistoryMessage } from '../../types/sessionHistory.ts';
import { buildDshSessionTree, dshLeafCheckpoint, dshTreeNodeId } from '../tree.ts';

/**
 * dsh-rebase P1-4a — the session tree and leaf of a DSH-backed session
 * (decision 026 rule 4). P1-4a builds one chain; the merge of several chains
 * is exercised here already because P1-4b feeds it the retired sessions.
 */

function user(id: string, text: string, timestamp?: number): HistoryMessage {
  return {
    id: `h:${id}`,
    entryId: id,
    role: 'user',
    ...(timestamp !== undefined ? { timestamp } : {}),
    blocks: [{ type: 'text', id: `h:${id}:text:0`, text }],
  };
}

function assistant(id: string, text: string): HistoryMessage {
  return {
    id: `h:${id}`,
    entryId: id,
    role: 'assistant',
    blocks: text ? [{ type: 'text', id: `h:${id}:text:0`, text }] : [],
  };
}

function summary(id: string): HistoryMessage {
  return {
    id: `h:${id}`,
    entryId: id,
    role: 'system',
    blocks: [{ type: 'text', id: `h:${id}:summary:0`, text: 'Context summary\n\nall of it' }],
  };
}

function note(id: string): HistoryMessage {
  return {
    id: `h:${id}`,
    entryId: id,
    role: 'system',
    blocks: [{ type: 'text', id: `h:${id}:interrupted:0`, text: 'interrupted' }],
  };
}

const META = {
  logicalSessionId: 'chat-1',
  sessionFile: '/home/stub.dsh.json',
  workspacePath: '/w',
};

describe('buildDshSessionTree — one DSH session', () => {
  it('chains the messages, flags the leaf and what can be forked', () => {
    const messages = [
      user('u1', 'hello', 10),
      assistant('a1', 'hi'),
      summary('c1'),
      note('u1:interrupted'),
    ];
    const leaf = dshLeafCheckpoint(messages, 'aiclient-chat-1', 41);
    const snapshot = buildDshSessionTree({ ...META, chains: [{ messages, current: true }], leaf });
    expect(snapshot).toEqual({
      ...META,
      leaf: { activeEntryId: 'u1:interrupted', fileTailEntryId: 'aiclient-chat-1#41' },
      nodes: [
        {
          id: 'u1',
          parentId: null,
          depth: 0,
          entryType: 'message',
          role: 'user',
          preview: 'hello',
          timestamp: 10,
          childCount: 1,
          forkable: false,
          active: true,
          leaf: false,
        },
        {
          id: 'a1',
          parentId: 'u1',
          depth: 1,
          entryType: 'message',
          role: 'assistant',
          preview: 'hi',
          childCount: 1,
          forkable: true,
          active: true,
          leaf: false,
        },
        {
          id: 'c1',
          parentId: 'a1',
          depth: 2,
          entryType: 'compaction',
          role: 'system',
          preview: 'Context summary all of it',
          childCount: 1,
          forkable: true,
          active: true,
          leaf: false,
        },
        {
          id: 'u1:interrupted',
          parentId: 'c1',
          depth: 3,
          entryType: 'notice',
          role: 'system',
          preview: 'interrupted',
          childCount: 0,
          forkable: true,
          active: true,
          leaf: true,
        },
      ],
      totalNodes: 4,
      returnedNodes: 4,
      truncated: false,
    });
  });

  it('answers an empty session with no nodes and an empty leaf', () => {
    const leaf = dshLeafCheckpoint([], 'aiclient-chat-1', -1);
    expect(leaf).toEqual({ activeEntryId: null, fileTailEntryId: null });
    expect(
      buildDshSessionTree({ ...META, chains: [{ messages: [], current: true }], leaf })
    ).toEqual({
      ...META,
      leaf,
      nodes: [],
      totalNodes: 0,
      returnedNodes: 0,
      truncated: false,
    });
  });

  it('moves the file tail with every event, even one that adds no message', () => {
    const messages = [user('u1', 'hello')];
    expect(dshLeafCheckpoint(messages, 's', 3)).not.toEqual(dshLeafCheckpoint(messages, 's', 4));
    expect(dshLeafCheckpoint(messages, 's', 3).activeEntryId).toBe('u1');
  });

  it('shortens a long preview and uses the entry id as the node id', () => {
    const long = user('u1', `${'word '.repeat(40)}end`);
    const [node] = buildDshSessionTree({
      ...META,
      chains: [{ messages: [long], current: true }],
      leaf: dshLeafCheckpoint([long], 's', 0),
    }).nodes;
    expect(node?.preview?.length).toBe(96);
    expect(node?.preview?.endsWith('…')).toBe(true);
    expect(dshTreeNodeId({ ...long, entryId: undefined })).toBe('u1');
  });

  it('keeps the leaf inside the window when the tree is over its limit', () => {
    const messages = Array.from({ length: 10 }, (_, index) => user(`u${index}`, `m${index}`));
    const snapshot = buildDshSessionTree({
      ...META,
      chains: [{ messages, current: true }],
      leaf: dshLeafCheckpoint(messages, 's', 9),
      limit: 4,
    });
    expect(snapshot.nodes.map((node) => node.id)).toEqual(['u6', 'u7', 'u8', 'u9']);
    expect(snapshot).toMatchObject({ totalNodes: 10, returnedNodes: 4, truncated: true });
  });
});

describe('buildDshSessionTree — chains of a lineage (P1-4b input)', () => {
  it('merges a shared prefix and leaves what the rewind abandoned as a sibling branch', () => {
    const retired = [
      user('u1', 'first'),
      assistant('a1', 'one'),
      user('u2', 'second'),
      assistant('a2', 'two'),
    ];
    const current = [user('u1', 'first'), assistant('a1', 'one'), user('u3', 'instead')];
    const snapshot = buildDshSessionTree({
      ...META,
      chains: [
        { messages: retired, current: false },
        { messages: current, current: true },
      ],
      leaf: dshLeafCheckpoint(current, 's.r2', 9),
    });
    expect(
      snapshot.nodes.map((node) => [node.id, node.parentId, node.depth, node.active, node.leaf])
    ).toEqual([
      ['u1', null, 0, true, false],
      ['a1', 'u1', 1, true, false],
      ['u2', 'a1', 2, false, false],
      ['a2', 'u2', 3, false, false],
      ['u3', 'a1', 2, true, true],
    ]);
    expect(snapshot.nodes.find((node) => node.id === 'a1')?.childCount).toBe(2);
    expect(snapshot.totalNodes).toBe(5);
  });
});
