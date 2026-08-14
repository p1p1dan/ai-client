// Collapsing diagnostic event ring — pure leaf module, ZERO imports (see
// docs/plans/2026-08-14-partial-messages-build-spec.md §"片 2" and the
// "施工纪律" pureModuleImports gate: this file must never import `react`,
// `@/stores/*`, or anything settings-related, or the static import gate
// fails).
//
// Rev.2 replaces the rejected rev.1 "flat tail ring": a plain fixed-size
// ring that drops the OLDEST events once full would, under partial-message
// traffic (thousands of `message.delta` per turn), leave nothing but
// `message.delta ×N` by the time a turn ends — destroying the evidence the
// create-timeout diagnostic (ChatComposer.tsx's `rawEvents=[...]` line)
// needs, which is specifically the EARLIEST events in a turn (session
// creation, the first assistant progress, an early host.error, etc).
//
// Two independent mechanisms fix that:
//
// 1. Consecutive-duplicate collapse: a run of pushes that fold to the same
//    key is stored as ONE entry with a running count, rendered as
//    `firstPushedString ×N` in `snapshot()`. High-frequency stream event
//    types (`message.delta` / `thinking.delta` / `usage.updated`) always
//    fold by TYPE PREFIX rather than full-string equality, so a run of them
//    collapses to one line even if a future `formatRuntimeEvent` change
//    appends varying detail after the type name.
// 2. A head window: the first HEAD_WINDOW_SIZE (post-fold) entries are never
//    evicted. Only once that window is full do further entries land in the
//    tail ring, which is capped at TAIL_CAP (post-fold) entries — pushing
//    past the cap evicts the oldest TAIL entry and adds its underlying push
//    count (not just 1) to the running `dropped()` total, so the counter
//    stays honest about how many original events were actually lost.

/** First N post-fold entries that are protected from eviction. */
const HEAD_WINDOW_SIZE = 50;

/** Max post-fold entries kept in the tail ring once the head window fills. */
const TAIL_CAP = 250;

/**
 * Stream event types that arrive at very high frequency during partial
 * streaming. Matched by PREFIX (not full-string equality) against whatever
 * `formatRuntimeEvent` produced — see that function: today it happens to
 * format these three types as their bare type name with no parenthesized
 * detail, but prefix matching keeps the fold working even if that changes.
 */
const HIGH_FREQUENCY_PREFIXES: readonly string[] = [
  'message.delta',
  'thinking.delta',
  'usage.updated',
];

interface RingEntry {
  /** The first pushed string for this run — the label `snapshot()` renders. */
  text: string;
  /** How many push() calls folded into this entry. */
  count: number;
}

export interface EventRing {
  /** Fold `s` into the ring — see module doc for the collapse rules. */
  push: (s: string) => void;
  /** Rendered lines, oldest first — a folded run renders as `text ×N`. */
  snapshot: () => string[];
  /** Total events evicted from the tail since creation (head window is never evicted). */
  dropped: () => number;
}

/** The fold key for `s`: a high-frequency prefix if it matches one, else `s` itself. */
function foldKey(s: string): string {
  for (const prefix of HIGH_FREQUENCY_PREFIXES) {
    if (s.startsWith(prefix)) return prefix;
  }
  return s;
}

function renderEntry(entry: RingEntry): string {
  return entry.count > 1 ? `${entry.text} ×${entry.count}` : entry.text;
}

export function createEventRing(): EventRing {
  const head: RingEntry[] = [];
  const tail: RingEntry[] = [];
  let droppedCount = 0;

  function push(s: string): void {
    const key = foldKey(s);
    // The ring's logical "last entry" is the tail's last entry if the tail
    // has started, else the head's last entry — folding must reach across
    // the head/tail boundary so a run that starts in the head and keeps
    // repeating never spills into (and consumes) tail capacity.
    const active = tail.length > 0 ? tail : head;
    const lastEntry = active.length > 0 ? active[active.length - 1] : undefined;
    if (lastEntry && foldKey(lastEntry.text) === key) {
      lastEntry.count += 1;
      return;
    }

    if (head.length < HEAD_WINDOW_SIZE) {
      head.push({ text: s, count: 1 });
      return;
    }

    tail.push({ text: s, count: 1 });
    if (tail.length > TAIL_CAP) {
      const evicted = tail.shift();
      if (evicted) {
        droppedCount += evicted.count;
      }
    }
  }

  function snapshot(): string[] {
    return [...head, ...tail].map(renderEntry);
  }

  function dropped(): number {
    return droppedCount;
  }

  return { push, snapshot, dropped };
}
