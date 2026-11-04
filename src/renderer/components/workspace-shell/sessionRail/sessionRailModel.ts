/**
 * Layout 5e (ui-cohesion §6, ruling L5): the pure half of the session rail —
 * the column of cards right of the chat (environment, changes, todo, running,
 * context; the reference is Claude Code desktop's session details panel).
 *
 * No React, no store: node-env tests assert every rule here.
 */
import { deriveCacheHitRate, deriveContextOccupancy, type PiUsagePayload } from '@shared/piUsage';
import { chatEngineForDisplay } from '@/components/chat/chatEngineView';
import type { TaskRow } from '../panes/backgroundTasksModel';
import type { SessionReviewEntry } from '../sessionReview';

/** The rail's own width, cards included (the reference's panel is ~260px). */
export const SESSION_RAIL_WIDTH = 260;
/**
 * The narrowest conversation left beside the rail. Below this the rail hides
 * by itself. Decision 209 §4: 600 → 480, so the rail and an open pane fit
 * together on an ordinary laptop window (1536 wide: 508 + 260 + 496).
 */
export const SESSION_RAIL_MIN_CHAT_WIDTH = 480;

export type SessionRailCardId =
  | 'environment'
  | 'outputs'
  | 'changes'
  | 'todo'
  | 'subagents'
  | 'servers'
  | 'running'
  | 'context';

/** Top-to-bottom order. */
export const SESSION_RAIL_CARDS: readonly SessionRailCardId[] = [
  'environment',
  'context',
  // Decision 209 §2: the documents the conversation created (the reference's
  // order: environment, context, connectors, outputs, changes…).
  'outputs',
  'changes',
  'todo',
  // Decision 207 §8: DSH 0.2.1's subagents all run in the background.
  'subagents',
  // The local addresses running commands announced, above the commands themselves.
  'servers',
  'running',
];

/** Open unless the user folded it; the context card starts folded (the reference). */
export const SESSION_RAIL_CARD_DEFAULT_OPEN: Readonly<Record<SessionRailCardId, boolean>> = {
  environment: true,
  outputs: true,
  changes: true,
  todo: true,
  subagents: true,
  servers: true,
  running: true,
  context: false,
};

export type SessionRailHiddenReason = 'user' | 'no-session' | 'side-chat' | 'narrow';

export interface SessionRailVisibility {
  visible: boolean;
  /** Why it is not on screen; null while it is. */
  hidden: SessionRailHiddenReason | null;
}

/**
 * Whether the rail shows. One rule, in this order:
 *  - no conversation open (the home page) — nothing to describe;
 *  - the user hid it;
 *  - the side chat is docked (layout 5f) — it takes the rail's place;
 *  - it does not fit: `fitShell` (decision 209 §4) found no way to leave the
 *    conversation `SESSION_RAIL_MIN_CHAT_WIDTH` beside it, even with the panes
 *    squeezed to their floor.
 *
 * Decision 209 §4 overturns ruling L5's 「打开右侧工作面板时让位」: an open pane
 * no longer hides the rail; the rail sits between the conversation and the
 * panes, as in the reference. Nothing here is stored (F10).
 */
export function resolveSessionRailVisibility(input: {
  userShown: boolean;
  sessionOpen: boolean;
  /** Layout 5f: the side chat is on screen as a docked column. */
  sideChatDocked?: boolean;
  /** `fitShell(...).slotFits` with the rail as the slot. */
  fits: boolean;
}): SessionRailVisibility {
  if (!input.sessionOpen) return { visible: false, hidden: 'no-session' };
  if (!input.userShown) return { visible: false, hidden: 'user' };
  if (input.sideChatDocked) return { visible: false, hidden: 'side-chat' };
  if (!input.fits) return { visible: false, hidden: 'narrow' };
  return { visible: true, hidden: null };
}

/** The toggle can act only when the user's choice is what decides. */
export function sessionRailToggleEnabled(visibility: SessionRailVisibility): boolean {
  return visibility.hidden === null || visibility.hidden === 'user';
}

/** Persisted fold state merged over the defaults; junk values fall back. */
export function resolveCardOpen(
  saved: Partial<Record<string, unknown>> | undefined,
  id: SessionRailCardId
): boolean {
  const value = saved?.[id];
  return typeof value === 'boolean' ? value : SESSION_RAIL_CARD_DEFAULT_OPEN[id];
}

/** Keeps only known card ids with boolean values (localStorage is untrusted). */
export function sanitizeCardOpen(value: unknown): Partial<Record<SessionRailCardId, boolean>> {
  if (!value || typeof value !== 'object') return {};
  const out: Partial<Record<SessionRailCardId, boolean>> = {};
  for (const id of SESSION_RAIL_CARDS) {
    const entry = (value as Record<string, unknown>)[id];
    if (typeof entry === 'boolean') out[id] = entry;
  }
  return out;
}

// ── changes card ─────────────────────────────────────────────────────────

/** Files listed in the changes card before 「还有 N 个」. */
export const CHANGES_CARD_FILES = 3;

export interface ChangesCardFile {
  entryId: string;
  path: string;
  name: string;
  /** The folder part, '' at the root. */
  dir: string;
  added: number;
  removed: number;
  /** PiLab R2: too large or binary — no line counts to show. */
  uncounted: boolean;
  status: SessionReviewEntry['status'];
}

export interface ChangesCardView {
  count: number;
  added: number;
  removed: number;
  /** Whether any change has line counts; when none does, the header shows none. */
  counted: boolean;
  files: ChangesCardFile[];
  more: number;
}

function splitPath(path: string): { name: string; dir: string } {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index < 0
    ? { name: normalized, dir: '' }
    : { name: normalized.slice(index + 1), dir: normalized.slice(0, index) };
}

/** Null (no card) when the review is off or nothing changed. */
export function deriveChangesCardView(
  entries: readonly SessionReviewEntry[] | null
): ChangesCardView | null {
  if (!entries || entries.length === 0) return null;
  let added = 0;
  let removed = 0;
  let counted = false;
  for (const entry of entries) {
    added += entry.added;
    removed += entry.removed;
    if (!entry.unavailable) counted = true;
  }
  const files = entries.slice(0, CHANGES_CARD_FILES).map((entry) => ({
    entryId: entry.id,
    path: entry.path,
    ...splitPath(entry.path),
    added: entry.added,
    removed: entry.removed,
    uncounted: entry.unavailable !== undefined,
    status: entry.status,
  }));
  return {
    count: entries.length,
    added,
    removed,
    counted,
    files,
    more: entries.length - files.length,
  };
}

/** `12,345` — the reference's line counts. */
export function formatLineCount(value: number): string {
  return value.toLocaleString('en-US');
}

// ── environment card ─────────────────────────────────────────────────────

/**
 * Cuts the middle out of a long path so both the drive / root and the last
 * folder stay readable (`F:\Projects\…\ai-client`). CSS can only cut the end.
 */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(text.length - tail) : ''}`;
}

export interface EnvironmentInput {
  runLocation: { text: string; tone: 'local' | 'remote' } | null;
  workspace: {
    name: string;
    path: string;
    kind: 'main' | 'worktree' | 'remote' | 'temp';
    branch?: string;
  } | null;
  projectName: string | null;
  /** A temporary chat's scratch directory. */
  unboundPath: string | null;
  engine: 'dsh' | 'claude-sdk' | null;
  model: string | null;
  /** Where the chat's record is on disk, once Main has found it. */
  transcriptPath?: string | null;
  permission: string | null;
}

export type EnvironmentRow =
  | { id: 'location'; text: string; tone: 'local' | 'remote' }
  | { id: 'folder'; name: string; path: string | null }
  | { id: 'branch'; text: string; worktree: boolean }
  | { id: 'engine'; engine: 'dsh' | 'claude-sdk'; model: string | null }
  | { id: 'model'; model: string }
  | { id: 'permission'; text: string }
  | { id: 'transcript'; path: string };

function lastSegment(path: string): string {
  return splitPath(path).name || path;
}

/**
 * The environment card's rows. A row with nothing to say is left out — no
 * placeholders (the DSH and SDK engines report different things).
 */
export function deriveEnvironmentRows(input: EnvironmentInput): EnvironmentRow[] {
  const rows: EnvironmentRow[] = [];
  if (input.runLocation) {
    rows.push({ id: 'location', text: input.runLocation.text, tone: input.runLocation.tone });
  }
  const workspacePath = input.workspace?.path?.trim() ? input.workspace.path : null;
  const folderPath = workspacePath ?? (input.unboundPath?.trim() ? input.unboundPath : null);
  const folderName =
    input.projectName ?? input.workspace?.name ?? (folderPath ? lastSegment(folderPath) : null);
  if (folderName) rows.push({ id: 'folder', name: folderName, path: folderPath });
  const worktree = input.workspace?.kind === 'worktree';
  const branch = input.workspace?.branch ?? (worktree ? input.workspace?.name : undefined);
  if (branch) rows.push({ id: 'branch', text: branch, worktree });
  if (input.engine) {
    rows.push({ id: 'engine', engine: input.engine, model: input.model });
  } else if (input.model) {
    rows.push({ id: 'model', model: input.model });
  }
  if (input.permission) rows.push({ id: 'permission', text: input.permission });
  if (input.transcriptPath) rows.push({ id: 'transcript', path: input.transcriptPath });
  return rows;
}

/**
 * The engine a chat runs on, only once it is known: Main's report, or the
 * identity stub of a chat reopened from the index. A chat that has not
 * started yet shows no engine row (the composer's prediction is a guess).
 */
export function resolveKnownEngine(input: {
  bound: boolean;
  engine?: 'claude-sdk';
  runtimeIdentity?: string;
}): 'dsh' | 'claude-sdk' | null {
  if (!input.bound && !input.engine && !input.runtimeIdentity) return null;
  return chatEngineForDisplay({
    bound: input.bound,
    ...(input.engine ? { engine: input.engine } : {}),
    ...(input.runtimeIdentity ? { runtimeIdentity: input.runtimeIdentity } : {}),
    predicted: 'dsh',
  });
}

// ── context card ─────────────────────────────────────────────────────────

export interface ContextCardView {
  /** Share of the window in use, 0–100; null until the engine measured it. */
  percent: number | null;
  usedTokens: number | null;
  contextWindow: number | null;
  /** Latest settled request's cache hit rate; null when not reported. */
  cacheHitRate: number | null;
}

/**
 * Null (no card) for a chat with nothing to describe: no measurement and no
 * message loaded. A chat with messages but no measurement yet (a reopened
 * one before its first turn) still gets the card, for its composition and
 * 「压缩」.
 */
export function deriveContextCardView(input: {
  usage: PiUsagePayload | null;
  hasMessages: boolean;
}): ContextCardView | null {
  const occupancy = deriveContextOccupancy(input.usage?.context);
  if (!occupancy && !input.hasMessages) return null;
  const cacheHitRate =
    input.usage && !input.usage.unreported ? deriveCacheHitRate(input.usage) : null;
  return {
    percent: occupancy ? Math.min(100, Math.max(0, occupancy.percent)) : null,
    usedTokens: occupancy?.usedTokens ?? null,
    contextWindow: occupancy?.contextWindow ?? null,
    cacheHitRate,
  };
}

// ── which cards show ─────────────────────────────────────────────────────

/** The cards on screen, in order; a card with nothing to say is not drawn. */
export function visibleRailCards(input: {
  environmentRows: number;
  context: boolean;
  /** Decision 209 §2: the conversation created a document. */
  outputs?: boolean;
  changes: boolean;
  todo: boolean;
  /** Decision 207 §8: the session has started a subagent. */
  subagents?: boolean;
  servers: number;
  running: number;
}): SessionRailCardId[] {
  const shown: Record<SessionRailCardId, boolean> = {
    environment: input.environmentRows > 0,
    context: input.context,
    outputs: input.outputs === true,
    changes: input.changes,
    todo: input.todo,
    subagents: input.subagents === true,
    servers: input.servers > 0,
    running: input.running > 0,
  };
  return SESSION_RAIL_CARDS.filter((id) => shown[id]);
}

/**
 * The running card's rows: commands and workflows only. Subagents have their
 * own card (decision 207 §8, decision 206's 「不重复」); the tasks pane keeps
 * listing them.
 */
export function railRunningRows(rows: readonly TaskRow[]): TaskRow[] {
  return rows.filter((row) => row.kind !== 'subagent');
}
