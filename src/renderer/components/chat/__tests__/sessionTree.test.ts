import type { SessionTreeSnapshot } from '@shared/types/sessionHistory';
import { describe, expect, it } from 'vitest';
import { capSessionTreeForDisplay, sessionTreeNodeTitle } from '../sessionTree';

function snapshot(count: number, leafIndex = count - 1): SessionTreeSnapshot {
  return {
    logicalSessionId: 's1',
    sessionFile: '/sessions/s1.jsonl',
    workspacePath: '/repo',
    leaf: {
      activeEntryId: leafIndex >= 0 ? `n-${leafIndex}` : null,
      fileTailEntryId: count > 0 ? `n-${count - 1}` : null,
    },
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `n-${index}`,
      parentId: index === 0 ? null : `n-${index - 1}`,
      depth: index,
      entryType: 'message',
      role: 'user',
      preview: `node ${index}`,
      childCount: index < count - 1 ? 1 : 0,
      forkable: index > 0,
      active: index <= leafIndex,
      leaf: index === leafIndex,
    })),
    totalNodes: count,
    returnedNodes: count,
    truncated: false,
  };
}

describe('sessionTree display helpers', () => {
  it('caps at 320 while retaining the active leaf and normalizing indentation', () => {
    const display = capSessionTreeForDisplay(snapshot(500, 450));
    expect(display.nodes).toHaveLength(320);
    expect(display.hiddenCount).toBe(180);
    expect(display.nodes.some((node) => node.leaf && node.id === 'n-450')).toBe(true);
    expect(display.nodes[0]?.depth).toBe(0);
  });

  it('prefers label, then preview, then entry type when role is absent', () => {
    const node = snapshot(1).nodes[0];
    expect(node).toBeDefined();
    if (!node) return;
    expect(sessionTreeNodeTitle({ ...node, label: 'checkpoint' })).toBe('checkpoint');
    expect(sessionTreeNodeTitle(node)).toBe('node 0');
    expect(sessionTreeNodeTitle({ ...node, preview: undefined, role: undefined })).toBe('message');
  });
});
