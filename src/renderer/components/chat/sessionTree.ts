import {
  PI_SESSION_TREE_UI_LIMIT,
  type SessionTreeNode,
  type SessionTreeSnapshot,
} from '@shared/types/sessionHistory';

export interface DisplaySessionTree {
  nodes: SessionTreeNode[];
  hiddenCount: number;
}

/** Keep one bounded chronological window and normalize its visual indentation. */
export function capSessionTreeForDisplay(
  snapshot: SessionTreeSnapshot,
  limit = PI_SESSION_TREE_UI_LIMIT
): DisplaySessionTree {
  if (snapshot.nodes.length <= limit) return { nodes: snapshot.nodes, hiddenCount: 0 };
  const leafIndex = snapshot.nodes.findIndex((node) => node.leaf);
  const end = leafIndex >= 0 ? Math.max(limit, leafIndex + 1) : snapshot.nodes.length;
  const start = Math.max(0, Math.min(snapshot.nodes.length - limit, end - limit));
  const slice = snapshot.nodes.slice(start, start + limit);
  const minimumDepth = slice.reduce((minimum, node) => Math.min(minimum, node.depth), Infinity);
  return {
    nodes: slice.map((node) => ({
      ...node,
      depth: Math.max(0, node.depth - (Number.isFinite(minimumDepth) ? minimumDepth : 0)),
    })),
    hiddenCount: snapshot.nodes.length - slice.length,
  };
}

export function sessionTreeNodeTitle(node: SessionTreeNode): string {
  if (node.label) return node.label;
  if (node.preview) return node.preview;
  if (node.role) return `${node.role} ${node.entryType}`;
  return node.entryType.replaceAll('_', ' ');
}
