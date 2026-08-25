import type { ChatMessage } from '@/stores/chatSessions';
import { groupTimeline, joinResolvedPermissions, type TimelineItem } from './toolCard';

/**
 * T-31 turn layer (reply-anatomy spec §4). The timeline used to be a flat
 * `messages.map(<MessageBubble/>)`, so nothing bracketed "this question" with
 * "its reply" — the status line, the `Worked for Ns` collapsible shell and the
 * pinned user bubble each need that missing container. This module derives it
 * purely, with no new store field (`chatSessions.ts` is a red-line file).
 *
 * Three layers, mirroring `toolCard.ts`'s own shape:
 *
 *  1. grouping  — `groupMessagesIntoTurns` folds the flat message list into
 *     `Turn`s (§4.1 rule table).
 *  2. flatten   — `flattenTurnItems` concatenates one turn's body messages into
 *     a single ordered item list, reusing `groupTimeline` per assistant message.
 *  3. segments  — `segmentTurnBody` cuts that list into maximal runs of
 *     same-placement items (§4.2/§4.4): prose and notices outside any shell,
 *     tool / thinking / authorization runs in their own segments.
 *
 * ## Judgement calls (spec left these to the implementation)
 *
 * **`system` / `error` messages become their own `notice` item**, carrying the
 * whole message rather than its blocks. `MessageTimeline`'s `NoticeMessage`
 * renders one `Alert` per message (not per block), so a per-block mapping would
 * have no renderer; and `groupTimeline` is documented as "one *assistant*
 * message's blocks", so running it over a notice would mint `text` items that
 * are not assistant prose.
 *
 * **A `notice` is its own segment kind — it neither collapses nor enters the
 * answer container.** FB4 retired the old tail rule ("`answer` = the trailing
 * run of `text` items"), under which a turn ending in an error notice had
 * `answer === []` and sent its ENTIRE body — every paragraph the model had
 * written — into the collapsed process segment. That is the defect FB4 exists
 * to fix, and it was a rule, not a bug: the tail scan was literal.
 *
 * What survives from that reasoning is the reason notices are not made
 * transparent to the scan: doing so would render a notice *before* prose that
 * arrived after it, breaking T-05 D-5's "block order, position unchanged"
 * ruling. `segmentTurnBody` is run-length and order-preserving precisely so
 * that ruling keeps holding.
 *
 * **`turnHasFailure` means `toolOk === false`**, not "the turn contains an
 * `error` message" — §4.3 names failed tool calls, and D26 ②'s row-level
 * cluster rule keys off the same fact (spec §7.2 nests the two levels).
 *
 * There is no "collapsing is disabled" export, and since 2026-08-25 no
 * collapsing at all — see the retirement note at the end of this file.
 */

export interface Turn {
  /** Anchor id: the user message's id, or the first body message's id for an orphan turn. */
  id: string;
  /** `null` for an orphan turn (restored history that opens with an assistant message / a bare notice). */
  user: ChatMessage | null;
  /** Every message after this turn's user message and before the next one. May be empty while awaiting the first reply. */
  body: ChatMessage[];
}

/**
 * Fold the flat session message list into turns (§4.1):
 *  - `user` opens a new turn (two queued `user` sends in a row therefore open
 *    two turns, the first of which may keep an empty `body` — T-19 queue
 *    semantics need both questions independently anchorable);
 *  - `assistant` / `system` / `error` join the current turn's body — notices
 *    are *about this round*, so they must travel with it when it collapses or
 *    its bubble pins;
 *  - anything before the first `user` opens one orphan turn (`user: null`) so
 *    no message is ever dropped.
 *
 * Invariant (F-B1): `Σ body.length + Σ (user ? 1 : 0) === messages.length` for
 * any input.
 */
export function groupMessagesIntoTurns(messages: readonly ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const message of messages) {
    if (message.role === 'user') {
      current = { id: message.id, user: message, body: [] };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { id: message.id, user: null, body: [] };
      turns.push(current);
    }
    current.body.push(message);
  }

  return turns;
}

/**
 * Reuse the previous render's `Turn` objects wherever a turn's content is
 * unchanged by reference (review batch F7).
 *
 * `groupMessagesIntoTurns` is a pure fold, so it necessarily mints a fresh
 * object per turn on every call — and the red-line store hands the timeline a
 * fresh bucket array on every streamed token. Without this pass, one token
 * changes the identity of EVERY turn, so `React.memo` on the turn component
 * never holds and each token re-runs `flattenTurnItems` + `segmentTurnBody` +
 * `deriveTurnStats` + `deriveToolGroupRows` across the whole session.
 *
 * The store's own update paths (`upsertMessage`) replace exactly the message
 * they touch and keep every other message's identity, which is what makes a
 * reference comparison sufficient here — no structural/deep equality, no
 * memoization cache to invalidate.
 *
 * Idempotent by construction (`stabilize(prev, stabilize(prev, next))` returns
 * the same objects), so it is safe to run inside a `useMemo` that feeds its own
 * previous result back in.
 */
export function stabilizeTurns(previous: readonly Turn[], next: readonly Turn[]): Turn[] {
  if (previous.length === 0) return [...next];
  const byId = new Map(previous.map((turn) => [turn.id, turn]));
  return next.map((turn) => {
    const prior = byId.get(turn.id);
    return prior && sameTurnContent(prior, turn) ? prior : turn;
  });
}

function sameTurnContent(a: Turn, b: Turn): boolean {
  if (a.user !== b.user) return false;
  if (a.body.length !== b.body.length) return false;
  for (let index = 0; index < a.body.length; index += 1) {
    if (a.body[index] !== b.body[index]) return false;
  }
  return true;
}

/** A timeline item stamped with the body message it came from (the `.tsx` layer keys and renders per message). */
export type TurnItem = (TimelineItem | { kind: 'notice'; message: ChatMessage }) & {
  messageId: string;
};

export type TurnItemKind = TurnItem['kind'];

/**
 * Flatten a turn's body into one ordered item list: assistant messages expand
 * through `groupTimeline` (same block-order contract as the pre-T-31 render),
 * every other role becomes a single `notice` item. Message order is preserved,
 * and every item carries its source `messageId`.
 *
 * A `user` message cannot appear in a body (`groupMessagesIntoTurns` opens a
 * new turn for it); the `notice` fallback covers it defensively so this
 * function never silently drops a message it was handed.
 *
 * FB7: the flattened list then passes through `joinResolvedPermissions`, which
 * folds each settled approval into the tool row it authorised. It runs HERE,
 * once the whole turn is flat, because that is the smallest scope where both
 * halves are guaranteed to be present — the store routes `tool_call` blocks to
 * the message the event names but `permission_request` blocks to "the last
 * non-history assistant message", so the pair is only co-located by ordering
 * luck. Pending approvals pass through untouched and keep their own item.
 */
export function flattenTurnItems(turn: Turn): TurnItem[] {
  const items: TurnItem[] = [];
  for (const message of turn.body) {
    if (message.role === 'assistant') {
      for (const item of groupTimeline(message)) {
        items.push({ ...item, messageId: message.id });
      }
      continue;
    }
    items.push({ kind: 'notice', message, messageId: message.id });
  }
  return joinResolvedPermissions(items);
}

/** Where an item sits relative to the collapsible shell. */
export type TurnSegmentKind = 'answer' | 'notice' | 'process';

/**
 * The ONE place that decides whether an item is collapsible (§4.3).
 *
 * A WHITELIST, deliberately: it names only the kinds that are always visible,
 * and everything else — today `question` / `permission` / `toolGroup`, tomorrow
 * whatever FB7 and its successors mint — falls to `process`. Written as a
 * blacklist it would have the opposite failure mode: a new kind would default
 * to always-visible and escape the shell, which is how a batch whose whole
 * point is to REMOVE rows quietly starts adding them.
 *
 * `process` is also the safe default in the other direction: process segments
 * render unconditionally, so nothing routed there can hide — not even the
 * authorization card, which is the only Allow/Deny surface in the app.
 *
 * `chatTurn.test.ts` asserts this member by member, not with a `satisfies`
 * check on a lookup table: this is a function, and a `satisfies Record<…>` on a
 * function body constrains nothing — the black-list mutation would survive it.
 * This is the one interface lock between FB4 and FB7.
 */
export function turnItemPlacement(kind: TurnItemKind): TurnSegmentKind {
  if (kind === 'text') return 'answer';
  if (kind === 'notice') return 'notice';
  return 'process';
}

export interface TurnSegment<T> {
  kind: TurnSegmentKind;
  items: T[];
}

/**
 * Cut a flattened turn body into maximal runs of same-placement items (§4.2).
 *
 * Replaces `splitTurnBody`, whose `{process, answer}` shape carried the claim
 * that a turn has ONE of each. Interleaving ("said something, ran a tool, said
 * something else") makes several of each the normal case, so keeping those two
 * field names would have left a pair of same-named holders whose meaning had
 * silently changed.
 *
 * Order is preserved and never rearranged — see the head note on why notices
 * are not made transparent (T-05 D-5).
 *
 * Streaming stability (F-B6): tokens append inside the last `text` block, so an
 * arriving token changes an item's CONTENT, never its placement — the segment
 * boundaries cannot oscillate while a turn streams. A new item can only append
 * to the last segment or open one after it.
 */
export function segmentTurnBody<T extends { kind: TurnItemKind }>(
  items: readonly T[]
): TurnSegment<T>[] {
  const segments: TurnSegment<T>[] = [];
  for (const item of items) {
    const kind = turnItemPlacement(item.kind);
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.items.push(item);
    else segments.push({ kind, items: [item] });
  }
  return segments;
}

/**
 * ⚠️ RETIRED (2026-08-25, user decision): `collapsedLeavesNothing`,
 * `TurnProcessOpenInput`, `defaultTurnProcessOpen`, `hasUnresolvedPermission`
 * and `turnHasFailure` all went with the turn-level collapse itself.
 *
 * The turn no longer has a shell to open or close. Every tool row already
 * carries its own expander, and once FB4 stopped folding prose into the process
 * segment there was little left for a second, turn-wide control to hide — so
 * the chevron in the bottom meta row was removed and process segments are
 * simply always rendered. The meta row keeps its text (`Worked for 24s · 2
 * tools`, plus model and time); it is now purely a summary.
 *
 * What this does to the authorization red line: it satisfies it BY
 * CONSTRUCTION. `defaultTurnProcessOpen`'s first return existed to force the
 * shell open while a `permission_request` was unresolved, because a collapsed
 * shell could bury the only Allow/Deny surface in the app (round-2 point-check
 * #5). With no shell, a permission card cannot be hidden at all — the guarantee
 * is structural now, not conditional, and `messageTimelineWiring.test.ts`
 * asserts it as such: the process panel has no visibility binding and is never
 * rendered conditionally.
 *
 * The other four retired because they existed solely to feed that one decision.
 * An exported predicate nothing consumes is a shell waiting to be mistaken for
 * a live rule (§13 ①), so they are deleted rather than left standing.
 */
