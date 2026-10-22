import { UNGROUPED_GROUP_ID } from '@/stores/sidebarArchive';

/**
 * Issue #26 item 7: the sidebar's drag-to-group and keyboard navigation, as
 * pure decisions. `LeftNav` wires them to DOM events; nothing here reads
 * layout (F10).
 */

/** The drag payload type of a sidebar chat row (never a file, so the add-repository drop ignores it). */
export const SIDEBAR_SESSION_DRAG_TYPE = 'application/x-pilab-sidebar-session';

/**
 * The group a chat is listed under in 「按分组」 mode: its assignment when that
 * names a group that still exists, else 「未分组」 — the same rule
 * `LeftNav`'s `groupFolders` buckets by.
 */
export function currentGroupOf(
  sessionId: string,
  assignments: Readonly<Record<string, string>>,
  groupIds: readonly string[]
): string {
  const assigned = assignments[sessionId];
  return assigned && groupIds.includes(assigned) ? assigned : UNGROUPED_GROUP_ID;
}

/**
 * Where a chat dropped on a group header goes: the target group's id, or null
 * when the drop means nothing (no chat being dragged, an unknown target, or the
 * group it is already in). Null is also "do not offer the drop", so the
 * header does not light up for its own chats.
 */
export function resolveGroupDrop({
  sessionId,
  targetGroupId,
  assignments,
  groupIds,
}: {
  sessionId: string | null;
  targetGroupId: string;
  assignments: Readonly<Record<string, string>>;
  groupIds: readonly string[];
}): string | null {
  if (!sessionId) return null;
  if (targetGroupId !== UNGROUPED_GROUP_ID && !groupIds.includes(targetGroupId)) return null;
  if (currentGroupOf(sessionId, assignments, groupIds) === targetGroupId) return null;
  return targetGroupId;
}

/** One focusable stop of the list, in DOM (= visual) order. */
export interface SidebarNavItem {
  kind: 'header' | 'row' | 'aux';
  key: string;
  /** Headers only: the group they fold. */
  groupId?: string;
  /** Headers only. */
  expanded?: boolean;
}

export type SidebarNavAction =
  | { type: 'focus'; index: number }
  | { type: 'toggle'; groupId: string; expanded: boolean }
  | null;

/**
 * What a key does on the item at `index` (adapted from open-claude-ui's
 * `useClaudeRovingFocus`, MIT): Up / Down step and wrap, Home / End jump.
 * Tree conventions on top: Left folds an open header or goes from a row to its
 * group's header; Right opens a folded header or steps into an open one.
 * Enter is not handled here — rows and header buttons already answer it.
 */
export function resolveSidebarNavKey(
  items: readonly SidebarNavItem[],
  index: number,
  key: string
): SidebarNavAction {
  const count = items.length;
  const item = items[index];
  if (!item || count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return { type: 'focus', index: (index + 1) % count };
    case 'ArrowUp':
      return { type: 'focus', index: (index - 1 + count) % count };
    case 'Home':
      return { type: 'focus', index: 0 };
    case 'End':
      return { type: 'focus', index: count - 1 };
    case 'ArrowLeft': {
      if (item.kind === 'header') {
        return item.expanded && item.groupId
          ? { type: 'toggle', groupId: item.groupId, expanded: false }
          : null;
      }
      for (let at = index - 1; at >= 0; at -= 1) {
        if (items[at]?.kind === 'header') return { type: 'focus', index: at };
      }
      return null;
    }
    case 'ArrowRight': {
      if (item.kind !== 'header' || !item.groupId) return null;
      if (!item.expanded) return { type: 'toggle', groupId: item.groupId, expanded: true };
      const next = items[index + 1];
      return next && next.kind !== 'header' ? { type: 'focus', index: index + 1 } : null;
    }
    default:
      return null;
  }
}

/**
 * The one item Tab lands on (roving tabindex): the last one focused while it
 * is still listed, else the open chat's row, else the first item.
 */
export function resolveRovingKey(
  keys: readonly string[],
  focused: string | null,
  fallback: string | null
): string | null {
  if (focused && keys.includes(focused)) return focused;
  if (fallback && keys.includes(fallback)) return fallback;
  return keys[0] ?? null;
}

export const sidebarRowNavKey = (sessionId: string) => `row:${sessionId}`;
export const sidebarHeaderNavKey = (groupId: string) => `header:${groupId}`;
export const sidebarAuxNavKey = (groupId: string) => `aux:${groupId}`;
