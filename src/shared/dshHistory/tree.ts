// New in dsh-rebase P1-4a

/**
 * The session tree and leaf of a DSH-backed session (decision 026 rule 4;
 * plan P1-4 shard 03 §2).
 *
 * DSH has no tree inside a session, so a node is a projected message and its
 * parent is the message before it in the same DSH session. P1-4a builds the
 * one chain of the current session. P1-4b adds the retired sessions of the
 * stub's lineage as further chains: an inherited prefix carries the same
 * `MessageId`s, so chains merge on node id and what a rewind left behind
 * becomes a sibling branch. The DFS, the flags and the window follow
 * `legacyPiSession/tree.ts`.
 */

import {
  type HistoryMessage,
  PI_SESSION_TREE_BACKEND_LIMIT,
  type PiLeafCheckpoint,
  type SessionTreeNode,
  type SessionTreeSnapshot,
} from '../types/sessionHistory.ts';
import { dshHistoryEntryType } from './projection.ts';

const PREVIEW_MAX = 96;

/** The projected timeline of one DSH session. */
export interface DshTreeChain {
  readonly messages: readonly HistoryMessage[];
  /** The session the stub names now; `false` for a retired one (P1-4b). */
  readonly current: boolean;
}

export interface DshTreeInput {
  readonly chains: readonly DshTreeChain[];
  readonly logicalSessionId: string;
  readonly sessionFile: string;
  readonly workspacePath: string;
  readonly leaf: PiLeafCheckpoint;
  /** At most `PI_SESSION_TREE_BACKEND_LIMIT`. */
  readonly limit?: number;
}

/** A node's id: the entry id the projection gave the message (the DSH `MessageId`). */
export function dshTreeNodeId(message: HistoryMessage): string {
  return message.entryId ?? message.id.slice('h:'.length);
}

/**
 * Only equality matters to Main (`syncLeafCheckpoint`): the last message of
 * the current chain, and `<dshSessionId>#<last seq>`, which moves with every
 * append and with a pointer switch to another DSH session.
 */
export function dshLeafCheckpoint(
  messages: readonly HistoryMessage[],
  dshSessionId: string,
  lastSeq: number
): PiLeafCheckpoint {
  const last = messages.at(-1);
  return {
    activeEntryId: last ? dshTreeNodeId(last) : null,
    fileTailEntryId: lastSeq >= 0 ? `${dshSessionId}#${lastSeq}` : null,
  };
}

function previewOf(message: HistoryMessage): string | undefined {
  const text = message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length <= PREVIEW_MAX ? text : `${text.slice(0, PREVIEW_MAX - 1)}…`;
}

interface TreeEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly message: HistoryMessage;
}

export function buildDshSessionTree(input: DshTreeInput): SessionTreeSnapshot {
  const byId = new Map<string, TreeEntry>();
  const order: TreeEntry[] = [];
  const activeIds = new Set<string>();
  let leafId: string | null = null;
  for (const chain of input.chains) {
    let parentId: string | null = null;
    for (const message of chain.messages) {
      const id = dshTreeNodeId(message);
      if (chain.current) activeIds.add(id);
      // A prefix two chains share is the same events, so the first copy stands.
      if (!byId.has(id)) {
        const entry = { id, parentId, message };
        byId.set(id, entry);
        order.push(entry);
      }
      parentId = id;
    }
    if (chain.current) leafId = parentId;
  }

  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const entry of order) {
    if (entry.parentId === null || !byId.has(entry.parentId)) {
      roots.push(entry.id);
      continue;
    }
    const siblings = children.get(entry.parentId) ?? [];
    siblings.push(entry.id);
    children.set(entry.parentId, siblings);
  }

  const limit = Math.max(
    1,
    Math.min(input.limit ?? PI_SESSION_TREE_BACKEND_LIMIT, PI_SESSION_TREE_BACKEND_LIMIT)
  );
  const projected: SessionTreeNode[] = [];
  const visited = new Set<string>();
  const stack = roots
    .slice()
    .reverse()
    .map((id) => ({ id, depth: 0, forkable: false }));
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || visited.has(next.id)) continue;
    const entry = byId.get(next.id);
    if (!entry) continue;
    visited.add(next.id);
    const forkable = next.forkable || entry.message.role === 'assistant';
    const childIds = children.get(entry.id) ?? [];
    const preview = previewOf(entry.message);
    projected.push({
      id: entry.id,
      parentId: entry.parentId,
      depth: next.depth,
      entryType: dshHistoryEntryType(entry.message),
      role: entry.message.role,
      ...(preview ? { preview } : {}),
      ...(entry.message.timestamp !== undefined ? { timestamp: entry.message.timestamp } : {}),
      childCount: childIds.length,
      forkable,
      active: activeIds.has(entry.id),
      leaf: leafId === entry.id,
    });
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      const childId = childIds[index];
      if (childId) stack.push({ id: childId, depth: next.depth + 1, forkable });
    }
  }

  // The window keeps the leaf in view, as the pi tree does.
  const leafIndex = projected.findIndex((node) => node.leaf);
  const windowEnd = leafIndex >= 0 ? Math.max(limit, leafIndex + 1) : projected.length;
  const windowStart = Math.max(0, Math.min(projected.length - limit, windowEnd - limit));
  const nodes = projected.slice(windowStart, windowStart + limit);

  return {
    logicalSessionId: input.logicalSessionId,
    sessionFile: input.sessionFile,
    workspacePath: input.workspacePath,
    leaf: input.leaf,
    nodes,
    totalNodes: order.length,
    returnedNodes: nodes.length,
    truncated: nodes.length < order.length,
  };
}
