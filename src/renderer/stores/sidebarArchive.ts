/**
 * Issue #15: how the chat sidebar files its conversations.
 *
 * Four modes (layout 5b, ruling L2 added the last two), chosen from the list
 * menu (the list title's icon, a group heading's hover icon, the list's
 * right-click):
 *
 *  - `workspace` (what the sidebar has always done): one
 *    group per repository, ordered by when the repository was ADDED — newest
 *    first. The order used to follow each group's last activity, which moved
 *    folders under the pointer as chats elsewhere finished turns; the issue
 *    asked for a stable order that reflects the user's own arrangement, and
 *    the add time is that.
 *  - `group`: the user's own groups (issue #15 phase 2, decision 187), plus
 *    the fixed 「未分组」 bucket every conversation falls into until it is put
 *    somewhere. A conversation is in exactly ONE group — moving it is a move,
 *    not a tag — which is what keeps this mode a filing cabinet rather than a
 *    filter.
 *  - `status` / `date` (layout 5b): derived buckets — 运行中 / 等你处理 /
 *    最近完成, or 今天 / 昨天 / 本周 / 更早 (`sidebar/sidebarGrouping.ts`).
 *    Nothing is filed in them; the user's groups above stay as they are.
 *
 * Persisted the way the rest of the shell's preferences are (zustand
 * `persist` over `localStorage`, synchronous), so a restart reopens the mode
 * the user left and the groups they made — a mode that reset to the default
 * on every launch would be a setting nobody could rely on.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export const SIDEBAR_ARCHIVE_MODES = ['workspace', 'group', 'status', 'date'] as const;

export type SidebarArchiveMode = (typeof SIDEBAR_ARCHIVE_MODES)[number];

function isSidebarArchiveMode(value: unknown): value is SidebarArchiveMode {
  return (SIDEBAR_ARCHIVE_MODES as readonly unknown[]).includes(value);
}

/** User, 2026-10-23: 按时间 by default; a mode already saved is kept. */
export const DEFAULT_SIDEBAR_ARCHIVE_MODE: SidebarArchiveMode = 'date';

/**
 * The id of the fixed bucket (decision 187). Not a real group — it cannot be
 * renamed or deleted and is always last — but it is keyed like one so the list
 * can render it through the same code path.
 */
export const UNGROUPED_GROUP_ID = '__ungrouped__';

/** A group the user made. `name` is trimmed and non-empty by construction. */
export interface SidebarGroup {
  id: string;
  name: string;
  /**
   * When the group was made, in ms. Groups are ordered newest first — the same
   * order the repositories use (`Repository.addedAt`), so the two modes read
   * alike, and a group the user just made is where they are looking.
   */
  createdAt: number;
}

/**
 * Session id → group id. A session with no entry is in 「未分组」: absence is
 * the default, so a chat the user has never filed does not need an entry, and
 * a chat whose group was deleted needs no cleanup beyond dropping the key.
 */
type SessionAssignments = Record<string, string>;

interface PersistedSidebarArchivePreferences {
  archiveMode: SidebarArchiveMode;
  groups: SidebarGroup[];
  assignments: SessionAssignments;
}

interface SidebarArchiveState extends PersistedSidebarArchivePreferences {
  setArchiveMode: (mode: SidebarArchiveMode) => void;
  /** Creates a group and returns it, so the caller can file a chat into it at once. */
  createGroup: (name: string) => SidebarGroup;
  renameGroup: (groupId: string, name: string) => void;
  /**
   * Deletes a group. Its conversations return to 「未分组」 — deleting a group
   * files them away, it does not delete them (decision 187).
   */
  deleteGroup: (groupId: string) => void;
  /** Files a conversation. `UNGROUPED_GROUP_ID` (or null) returns it to the bucket. */
  assignSession: (sessionId: string, groupId: string | null) => void;
}

/** A stored value this build understands, else the default. */
export function sanitizeSidebarArchivePreferences(
  value: unknown
): PersistedSidebarArchivePreferences {
  const stored = value as
    | {
        archiveMode?: unknown;
        groups?: unknown;
        assignments?: unknown;
      }
    | null
    | undefined;
  const mode = stored?.archiveMode;
  const groups = sanitizeGroups(stored?.groups);
  return {
    archiveMode: isSidebarArchiveMode(mode) ? mode : DEFAULT_SIDEBAR_ARCHIVE_MODE,
    groups,
    // An assignment pointing at a group that did not survive sanitizing is
    // dropped here rather than repaired at render time: every reader of this
    // map would otherwise need the same "does that group exist" check.
    assignments: sanitizeAssignments(stored?.assignments, groups),
  };
}

function sanitizeGroups(value: unknown): SidebarGroup[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const groups: SidebarGroup[] = [];
  for (const item of value) {
    const candidate = item as { id?: unknown; name?: unknown; createdAt?: unknown } | null;
    const id = typeof candidate?.id === 'string' ? candidate.id : '';
    const name = typeof candidate?.name === 'string' ? candidate.name.trim() : '';
    // A group with no id would be unaddressable and one with no name would be
    // unreadable; both are worse than not having the group at all.
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    groups.push({
      id,
      name,
      createdAt: typeof candidate?.createdAt === 'number' ? candidate.createdAt : 0,
    });
  }
  return groups;
}

function sanitizeAssignments(value: unknown, groups: readonly SidebarGroup[]): SessionAssignments {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const known = new Set(groups.map((group) => group.id));
  const assignments: SessionAssignments = {};
  for (const [sessionId, groupId] of Object.entries(value as Record<string, unknown>)) {
    if (!sessionId || typeof groupId !== 'string' || !known.has(groupId)) continue;
    assignments[sessionId] = groupId;
  }
  return assignments;
}

/** Newest first, ties broken by creation order so a rename never reorders. */
export function orderGroups(groups: readonly SidebarGroup[]): SidebarGroup[] {
  return [...groups].sort((a, b) => b.createdAt - a.createdAt);
}

export const useSidebarArchiveStore = create<SidebarArchiveState>()(
  persist(
    (set) => ({
      archiveMode: DEFAULT_SIDEBAR_ARCHIVE_MODE,
      groups: [],
      assignments: {},
      setArchiveMode: (mode) => set({ archiveMode: mode }),
      createGroup: (name) => {
        const group: SidebarGroup = {
          id: `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name: name.trim(),
          createdAt: Date.now(),
        };
        set((state) => ({ groups: [group, ...state.groups] }));
        return group;
      },
      renameGroup: (groupId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set((state) => ({
          groups: state.groups.map((group) =>
            group.id === groupId ? { ...group, name: trimmed } : group
          ),
        }));
      },
      deleteGroup: (groupId) =>
        set((state) => {
          const next: SessionAssignments = {};
          for (const [sessionId, assigned] of Object.entries(state.assignments)) {
            // Dropping the key IS the return to 「未分组」 — absence is that
            // bucket's membership (see `SessionAssignments`).
            if (assigned !== groupId) next[sessionId] = assigned;
          }
          return {
            groups: state.groups.filter((group) => group.id !== groupId),
            assignments: next,
          };
        }),
      assignSession: (sessionId, groupId) =>
        set((state) => {
          const next = { ...state.assignments };
          if (!groupId || groupId === UNGROUPED_GROUP_ID) delete next[sessionId];
          else next[sessionId] = groupId;
          return { assignments: next };
        }),
    }),
    {
      name: 'aiclient-sidebar-archive',
      // v2 added `groups` / `assignments` (issue #15 phase 2). v1 stored only
      // the mode, and a v1 payload sanitizes to "no groups, everything in
      // 「未分组」" — the same list the user had before the upgrade.
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedSidebarArchivePreferences => ({
        archiveMode: state.archiveMode,
        groups: state.groups,
        assignments: state.assignments,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...sanitizeSidebarArchivePreferences(persisted),
      }),
    }
  )
);
