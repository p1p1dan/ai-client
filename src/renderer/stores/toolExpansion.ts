import { create } from 'zustand';

/**
 * T12-d: which tool rows the user has opened, per chat session.
 *
 * ## The defect this exists for (measured, not supposed)
 *
 * A tool row's open/closed state used to live entirely inside its `Collapsible`
 * instance, so it survived exactly as long as that instance did. Two things
 * unmount one:
 *
 *  1. Switching sessions and coming back — every row returns collapsed.
 *  2. **Aggregation absorbing the row**, which is the sharp one. Probe on the
 *     pi backend, two sequential `read` calls in one turn:
 *
 *       step 1  (a.ts done)          -> [ key "block-a",     "Read a.ts"        ]
 *       step 2a (b.ts running)       -> [ key "block-a", key "block-b" ]
 *       step 2b (b.ts done)          -> [ key "block-a~agg", "Explored 2 files" ]
 *
 *     At 2b the row the user had open stops existing at top level: both reads
 *     fold into ONE collapsed aggregate whose `detail` holds them. So opening a
 *     file's output while the agent keeps working means that output disappears
 *     the moment the next read finishes. This path is newly reachable — before
 *     T12-b's vocabulary fix `classifyTool` never returned `read` for pi's
 *     lowercase tool names, so aggregation never fired on this backend at all.
 *
 * ## Why remembering the row is not enough on its own
 *
 * Restoring `block-a` inside the aggregate would restore it *inside a collapsed
 * container* — still invisible. `resolveToolRowOpen` therefore has a second
 * rule: a row whose `detail` holds a remembered-open child opens too. An
 * explicit choice on the row itself always outranks it, so a user who closes
 * the aggregate keeps it closed even though a child is still marked open.
 *
 * ## Deliberately NOT ported from the reference implementation
 *
 * pi-app also auto-expands the last N tools of the running turn
 * (`timeline-tool-expand-policy.ts`). That reverses a standing user decision
 * recorded in `ToolRows.tsx` (2026-08-25): rows open only when something
 * explicitly asks them to, because auto-opening put a wall of output on screen
 * for every failed or denied call. This store remembers choices; it never makes
 * one.
 *
 * ## Lifetime
 *
 * In memory only, like the reference implementation's. This is view state keyed
 * by tool-call block ids — persisting it would grow a `localStorage` blob
 * without bound and outlive the transcripts that give the keys meaning. Entries
 * for a deleted session are left behind on purpose: a stale boolean costs
 * nothing and clearing needs a session-deletion hook this store has no business
 * owning.
 */

/** One session's row: row key -> the user's explicit choice. */
export type ToolExpandMemory = Readonly<Record<string, boolean>>;

export const EMPTY_TOOL_EXPAND_MEMORY: ToolExpandMemory = Object.freeze({});

/**
 * The shape `resolveToolRowOpen` needs. Structural rather than `ToolRowView` so
 * this store stays free of any `components/` import — the dependency would run
 * the wrong way and, in this bundle, has formed a chunk cycle before.
 */
export interface ToolExpandTarget {
  key: string;
  /** Mount-time seed when nothing is remembered (T-34's live subagent panel). */
  defaultOpen?: boolean;
  /** Aggregate rows only: the child rows folded into this one. */
  detail?: readonly { key: string }[];
}

/**
 * Whether a row should mount open. In order:
 *
 *  1. an explicit remembered choice for THIS row — either direction wins;
 *  2. otherwise, open if the row swallowed a child the user had open (the
 *     aggregation case above). Only `=== true` counts, so a child the user
 *     explicitly closed does not force its parent open;
 *  3. otherwise the row's own `defaultOpen`, defaulting to closed.
 *
 * One level of `detail` is enough by construction: aggregate children come from
 * `buildEntryRow`, which returns run and thought rows, and neither carries a
 * `detail` of its own — aggregates never nest.
 */
export function resolveToolRowOpen(target: ToolExpandTarget, memory: ToolExpandMemory): boolean {
  const remembered = memory[target.key];
  if (typeof remembered === 'boolean') return remembered;
  if (target.detail?.some((child) => memory[child.key] === true)) return true;
  return target.defaultOpen ?? false;
}

/** Pure reducer — unit testable independent of the store shell (see `fileOpenIntent.ts`). */
export function rememberToolExpansion(
  memory: ToolExpandMemory,
  key: string,
  expanded: boolean
): Record<string, boolean> {
  return { ...memory, [key]: expanded };
}

interface ToolExpansionState {
  bySession: Record<string, Record<string, boolean>>;
  setToolRowExpanded: (sessionId: string, key: string, expanded: boolean) => void;
}

export const useToolExpansionStore = create<ToolExpansionState>((set) => ({
  bySession: {},

  setToolRowExpanded: (sessionId, key, expanded) =>
    set((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: rememberToolExpansion(
          state.bySession[sessionId] ?? EMPTY_TOOL_EXPAND_MEMORY,
          key,
          expanded
        ),
      },
    })),
}));

/**
 * Read a session's memory WITHOUT subscribing.
 *
 * Every consumer reads this once, in a mount-time initializer, and that is the
 * whole point: `defaultOpen` is consumed by the collapsible only at mount, so a
 * subscription here would re-render every tool row in the timeline on every
 * toggle and change nothing on screen. Remounts — session switch, aggregation —
 * are exactly the moments a fresh read is wanted, and they re-run the
 * initializer for free.
 */
export function readToolExpandMemory(sessionId: string | null | undefined): ToolExpandMemory {
  if (!sessionId) return EMPTY_TOOL_EXPAND_MEMORY;
  return useToolExpansionStore.getState().bySession[sessionId] ?? EMPTY_TOOL_EXPAND_MEMORY;
}
