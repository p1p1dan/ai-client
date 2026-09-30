import { englishTranslate, type Translate } from '@shared/i18n';
import {
  PI_SESSION_TREE_UI_LIMIT,
  type SessionTreeNode,
  type SessionTreeSnapshot,
} from '@shared/types/sessionHistory';
import { localizeContextSummaryTitle } from './dshTimelineRowModel';

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

/**
 * dsh-rebase P1-7e problem 9 (decision 144): a node's role and entry type are
 * identifiers (`user` / `assistant` / `system`; DSH's `message` /
 * `compaction` / `notice`, `DshHistoryEntryType`). These are their catalog
 * keys. A value this build does not know is shown as it came, underscores
 * turned into spaces.
 */
const ROLE_KEYS: Readonly<Record<string, string>> = {
  user: 'user',
  assistant: 'assistant',
  system: 'system',
};

/** The title of a message node that has no preview text (a reply that only called tools). */
const MESSAGE_TITLE_KEYS: Readonly<Record<string, string>> = {
  user: 'user message',
  assistant: 'assistant message',
  system: 'system message',
};

const ENTRY_TYPE_KEYS: Readonly<Record<string, string>> = {
  message: 'message',
  compaction: 'context summary',
  notice: 'notice',
};

function entryTypeText(entryType: string, t: Translate): string {
  const key = ENTRY_TYPE_KEYS[entryType];
  return key ? t(key) : entryType.replaceAll('_', ' ');
}

/** The short tag at the end of a node's row: its role, else its entry type. */
export function sessionTreeNodeTag(node: SessionTreeNode, t: Translate = englishTranslate): string {
  if (node.role) {
    const key = ROLE_KEYS[node.role];
    return key ? t(key) : node.role;
  }
  return entryTypeText(node.entryType, t);
}

export function sessionTreeNodeTitle(
  node: SessionTreeNode,
  t: Translate = englishTranslate
): string {
  if (node.label) return node.label;
  // A compaction's preview opens with the projection's English title.
  if (node.preview) return localizeContextSummaryTitle(node.preview, t);
  const messageKey =
    node.role && node.entryType === 'message' ? MESSAGE_TITLE_KEYS[node.role] : undefined;
  if (messageKey) return t(messageKey);
  // An unknown role on a message keeps the old `<role> <entry type>` shape.
  if (node.role && node.entryType === 'message') {
    return `${node.role} ${entryTypeText(node.entryType, t)}`;
  }
  return entryTypeText(node.entryType, t);
}
