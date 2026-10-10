/**
 * dsh-rebase decision 174 (GitHub issue #6, second wave): the home page's pure
 * half — which conversations 「最近对话」 lists, how they are cut and grouped,
 * and the class strings of the layout the prototype fixed
 * (`docs/plantree/plans/dsh-rebase/evidence/sidebar-regions-2026-10/`, v4).
 *
 * Pure so vitest (node env) can cover it, like `sidebarTree.ts`.
 */

import type { ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import { isUnboundSessionRow, type SidebarSessionRow, sidebarRowsForSessions } from './sidebarTree';

/** User ruling 2026-10-10 (v4): five rows, then 「查看更多（N）」. */
export const HOME_RECENT_LIMIT = 5;

/**
 * How many more rows each 「查看更多」 adds. Decision 174: the list is every
 * conversation, and a long history is shown in batches rather than all at once
 * — one press shows the rest for anything up to this many.
 */
export const HOME_RECENT_BATCH = 100;

/**
 * Every conversation the sidebar lists — in a repository folder or among the
 * temporary chats — newest activity first. Orphans (a workspace that is gone)
 * are left out, as the sidebar leaves them out.
 */
export function deriveHomeRecentRows(input: {
  sessions: readonly ChatSession[];
  workspaces: readonly ChatWorkspace[];
}): SidebarSessionRow[] {
  const known = new Set(input.workspaces.map((ws) => ws.id));
  return sidebarRowsForSessions(
    input.sessions.filter(
      (session) => isUnboundSessionRow(session) || known.has(session.workspaceId)
    ),
    input.workspaces
  ).sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface HomeRowsLimit {
  rows: SidebarSessionRow[];
  /** Rows behind 「查看更多（N）」; 0 when nothing is hidden. */
  hiddenCount: number;
  /** Offer 「收起」: more than the first five are showing. */
  collapsible: boolean;
}

/**
 * The first `shown` rows (five until 「查看更多」 is pressed). The selected
 * conversation is not pinned: on the home page none is open.
 */
export function limitHomeRows(rows: readonly SidebarSessionRow[], shown: number): HomeRowsLimit {
  const count = Math.max(HOME_RECENT_LIMIT, shown);
  const visible = rows.slice(0, count);
  return {
    rows: visible,
    hiddenCount: rows.length - visible.length,
    collapsible: visible.length > HOME_RECENT_LIMIT,
  };
}

/** What one more press of 「查看更多」 shows. */
export function nextHomeRowsShown(shown: number): number {
  return Math.max(HOME_RECENT_LIMIT, shown) + HOME_RECENT_BATCH;
}

export type HomeDayGroup = 'today' | 'yesterday' | 'earlier';

/** The local calendar day a row's last activity falls on, relative to `now`. */
export function homeDayGroup(updatedAt: number, now: number): HomeDayGroup {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (updatedAt >= today.getTime()) return 'today';
  if (updatedAt >= yesterday.getTime()) return 'yesterday';
  return 'earlier';
}

export interface HomeRowGroup {
  /** `null`: the five-row list, which reads fine by its own times. */
  group: HomeDayGroup | null;
  rows: SidebarSessionRow[];
}

/**
 * User ruling 2026-10-10 (v4): five rows are not grouped; once 「查看更多」
 * is pressed the list is split into 今天 / 昨天 / 更早, in that order (the
 * rows are newest first, so each group is one run).
 */
export function groupHomeRows(
  rows: readonly SidebarSessionRow[],
  expanded: boolean,
  now: number
): HomeRowGroup[] {
  if (!expanded) return rows.length > 0 ? [{ group: null, rows: [...rows] }] : [];
  const groups: HomeRowGroup[] = [];
  for (const row of rows) {
    const group = homeDayGroup(row.updatedAt, now);
    const last = groups.at(-1);
    if (last && last.group === group) last.rows.push(row);
    else groups.push({ group, rows: [row] });
  }
  return groups;
}

// ---- Layout (prototype v4; see docs/design-system.md 「首页」) ----

/**
 * The room above the composer: a SIZE container, so the spacer below can
 * place the title against its height in `cqh` without a script.
 */
export const HOME_AREA_CLASS = 'relative min-h-0 flex-1 @container-[size]';

/** The column inside the area's scroll viewport, the composer's `px-6` inset. */
export const HOME_COLUMN_CLASS = 'flex h-full flex-col px-6';

/**
 * The top spacer puts the title's centre at 38.2% of the area (the golden
 * section): the anchor minus half the title's line box (26px × 1.3 / 2). It is
 * the only part that gives way — down to 48px — when the recent list would
 * come closer than 32px to the composer; below that the area scrolls.
 */
export const HOME_TOP_SPACER_CLASS = 'h-[calc(38.2cqh_-_var(--text-display)*0.65)] min-h-12';

/** Title and list: the reading column, never squeezed. */
export const HOME_BODY_CLASS = 'mx-auto w-full max-w-reading shrink-0';

/** What is left below the list; at least 32px above the composer. */
export const HOME_BOTTOM_SPACER_CLASS = 'min-h-8 grow';

/**
 * The title: a quiet sentence — 26px, 400, the secondary ink — around one
 * emphasised name. The heading tracking (-0.01em) is allowed at >= 18px.
 */
export const HOME_TITLE_CLASS =
  'font-heading text-display font-normal tracking-[-0.01em] text-muted-foreground';

/** The repository's name (or 「PiLab」 with none): 600, body ink, cut at 14em. */
export const HOME_TITLE_EMPHASIS_CLASS =
  'inline-block max-w-[14em] truncate align-bottom font-semibold text-foreground';

/** The line under the title when there is no repository. */
export const HOME_SUBLINE_CLASS = 'mx-auto mt-3 max-w-md text-ui text-muted-foreground';

/** 「最近对话」 hangs 40px under the title. */
export const HOME_RECENT_SECTION_CLASS = 'mt-10';

/** Its heading is a quiet 14px label: the title is the anchor, the list secondary. */
export const HOME_RECENT_HEADING_CLASS = 'text-meta font-normal text-muted-foreground';

/** A conversation row: 36px, 15px body ink. */
export const HOME_ROW_CLASS =
  'group flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-ui hover:bg-hover focus-visible:bg-hover';

/** 「查看更多（N）」 and 「收起」. */
export const HOME_AUX_ROW_CLASS =
  'flex h-7 w-full items-center gap-2 rounded-sm px-2 text-meta text-muted-foreground tabular-nums hover:bg-hover focus-visible:bg-hover';

/** 今天 / 昨天 / 更早 (the expanded list only). */
export const HOME_GROUP_LABEL_CLASS = 'flex h-6 items-center px-2 text-meta text-muted-foreground';
