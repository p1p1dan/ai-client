import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { groupTimeline, type TimelineItem } from './toolCard';

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
 *  3. split/state — `splitTurnBody` (§4.4) plus the three predicates the
 *     collapsible shell's default state is derived from (§4.3).
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
 * **A `notice` therefore terminates the answer tail** (§4.4's rule is literal:
 * `answer` = the trailing run of `text` items). A turn that ends with an error
 * notice has `answer === []`, which sends the whole body into `process` — and
 * §4.3's `answerEmpty` rule then forces that shell open, so nothing is hidden.
 * The alternative (making notices transparent to the tail scan) was rejected:
 * it would render the notice *before* prose that arrived after it, breaking
 * T-05 D-5's "block order, position unchanged" ruling.
 *
 * **`turnHasFailure` means `toolOk === false`**, not "the turn contains an
 * `error` message" — §4.3 names failed tool calls, and D26 ②'s row-level
 * cluster rule keys off the same fact (spec §7.2 nests the two levels).
 *
 * There is no separate "collapsing is disabled" export: §4.3's "expanded and
 * not collapsible" case is exactly `hasUnresolvedPermission(turn)`, which the
 * `.tsx` wiring calls directly for the trigger's disabled state.
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
 * never holds and each token re-runs `flattenTurnItems` + `splitTurnBody` +
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
  return items;
}

/**
 * Split a flattened turn body into the collapsible process segment and the
 * always-visible answer (§4.4): `answer` is the trailing run of `text` items,
 * `process` is everything before it.
 *
 * Streaming stability (F-B6): the criterion is a *tail* one and streaming appends
 * inside the last `text` block, so the split cannot oscillate while tokens
 * arrive — it only moves once, when a new non-text item pushes the old answer
 * into the process segment.
 */
export function splitTurnBody<T extends { kind: TurnItemKind }>(
  items: readonly T[]
): { process: T[]; answer: T[] } {
  let start = items.length;
  while (start > 0 && items[start - 1].kind === 'text') {
    start -= 1;
  }
  return { process: items.slice(0, start), answer: items.slice(start) };
}

export interface TurnProcessOpenInput {
  /** The turn is still in flight. */
  isActive?: boolean;
  /** The turn holds an unresolved `permission_request` (see `hasUnresolvedPermission`). */
  hasUnresolvedPermission?: boolean;
  /** The turn holds a failed tool call (see `turnHasFailure`). */
  hasFailure?: boolean;
  /** `splitTurnBody(...).answer` is empty — collapsing would leave the turn as one bare row. */
  answerEmpty?: boolean;
}

/**
 * Default open state of a turn's process shell (§4.3 decision table).
 *
 * The unresolved-permission branch is a **separate, first return on purpose**:
 * it is the safety red line (burying an authorization card inside a collapsed
 * shell re-opens round-2 point-check #5, "the permission card does not
 * render"), and it must stay un-overridable by any rule added below it — even
 * one that would return `false`. The remaining three are plain disjuncts.
 *
 * Not represented here (and deliberately needing no state): a turn that
 * completes while mounted stays open, because `<Collapsible defaultOpen>` is
 * only evaluated at mount and an active→complete transition does not remount
 * the turn (same mechanism as `ToolRows.tsx`'s per-row `defaultOpen`).
 */
export function defaultTurnProcessOpen(input: TurnProcessOpenInput): boolean {
  if (input.hasUnresolvedPermission) return true;
  return Boolean(input.isActive || input.hasFailure || input.answerEmpty);
}

/** A `permission_request` block still awaiting an Allow/Deny answer. */
function isUnresolvedPermissionBlock(block: ChatBlock): boolean {
  return block.type === 'permission_request' && block.resolved !== true;
}

/** Whether the turn holds an unresolved permission card (§4.3 safety red line, F-B4). */
export function hasUnresolvedPermission(turn: Turn): boolean {
  return turn.body.some((message) => message.blocks.some(isUnresolvedPermissionBlock));
}

/**
 * Whether the turn holds a failed tool call (`tool_result.toolOk === false`).
 * Shared judgement with D26 ②'s row-level cluster rule (spec §7.2): the turn
 * level force-opens the shell, the row level still decides which failed rows
 * expand their output body.
 */
export function turnHasFailure(turn: Turn): boolean {
  return turn.body.some((message) =>
    message.blocks.some((block) => block.type === 'tool_result' && block.toolOk === false)
  );
}
