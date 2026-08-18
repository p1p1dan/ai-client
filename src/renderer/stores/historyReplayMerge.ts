/**
 * Round-6 Bug B, v3 (F11 fix): reconcile a `session.history` replay with
 * runtime messages already in the session bucket.
 *
 * A resume replays the entire JSONL. Turns this renderer already echoed live
 * (`user-*` / `asst-*` ids from the normalizer) come back a second time as
 * `h:*` history messages — the old "replace by `h:` prefix, keep every
 * runtime message" merge therefore rendered each recovered turn twice. That
 * is what the user read as "double send": one failed turn + its replayed
 * copy + the real manual resend.
 *
 * WHY THE GUARDS ARE A CONJUNCTION (v1's refuted history, kept as the design
 * constraint). v1 was a bare (role, text) coverage walk. Both review tracks
 * refuted it with the same class of counterexample: without a time boundary
 * the walk eats a message the user JUST sent (same text as an older history
 * row, history arriving late), and after a second replay the cursor restarts
 * at history row 0 and eats the tail. A later revision proposed replacing the
 * cursor lower bound with a per-row freshness test (`id not in candidateIds`);
 * that was refuted on a bench too — a renumbered old row looks "new", so the
 * walk ate a real resend (3 bubbles -> 2, real loss). Hence: the lower bound
 * NEVER yields, and per-row freshness is only defence in depth.
 *
 * FIVE GUARDS:
 *
 * 1. RESUME WATERMARK (candidate set): `session.resumed` snapshots the ids
 *    present in the bucket at that moment, keyed by (sessionId, requestId).
 *    Only those candidates may ever be folded by the matching
 *    `session.history`; a message that arrived after the resume is by
 *    definition not covered by that replay and is always kept. No snapshot
 *    or a requestId mismatch (stale replay, contract violation) → no
 *    folding at all. The same set has a SECOND use as a reverse index on the
 *    history side (guards 3b and 3e): a row that was already in the bucket at
 *    snapshot time is settled and absorbs nothing.
 * 2. MATCH-REQUIRED: a candidate is dropped only when a same-role,
 *    same-identity history row is found. An unmatched candidate (JSONL tail
 *    not flushed yet, truncated read, text drift) is kept — the watermark
 *    alone would delete it, which is silent loss.
 * 3a. ANCHOR PRESENCE: the anchor is the last `h:*` row that was in the bucket
 *    AT SNAPSHOT TIME; its presence in the fresh replay is the PROOF that
 *    `h:<jsonl-uuid>` ids stayed continuous across re-reads. When it is gone
 *    (head eviction under the read caps — a protocol-legal success with
 *    `truncated: true` — or a rewritten JSONL) every id is suspect and the
 *    replay folds NOTHING (round-6 verify blocker). The anchor is frozen WITH
 *    the candidate set — reading it from the current bucket instead would let
 *    an interleaved stale replay (prefix-replace only) push unfolded
 *    pre-resume echoes behind fresh `h:*` rows and exempt them forever.
 *    The forward cursor starts at `anchorIndex + 1`: pre-anchor rows are
 *    unreachable to the scan, which is what kills both counterexamples above.
 * 3b. SETTLED-ROW ADMISSION (defence in depth, NOT load-bearing): a history
 *    row already in the candidate set never absorbs an echo. P1 is stopped by
 *    the cursor bound, drift by 3d/3e — 3b only covers the case where one of
 *    those miscomputes.
 * 3d. ALIGNMENT PROBE: `orderedIds` (the bucket order at snapshot time) IS the
 *    previous merge's output order, so up to the anchor it is also the history
 *    file order. `orderedIds.indexOf(anchor) === anchorIndex` must hold before
 *    ANY positional claim: a mismatch proves the read window moved, rows were
 *    renumbered, the JSONL was rewritten, or a row was inserted mid-file, so
 *    index `i` no longer names the same row on both sides.
 * 3e. POSITIONAL HOLE CLAIM (the only channel into the pre-anchor region, one
 *    exact index at a time). F11 hole A: a successful replacement fold removes
 *    the folded row's id from the bucket, so the NEXT snapshot's anchor (last
 *    `h:*` in the bucket) jumps PAST that row and the runtime copy is stranded
 *    before the cursor forever — the fold is self-defeating and the turn
 *    duplicates on every later resume. Index `i <= anchorIndex` may be claimed
 *    by echo X iff (1) `orderedIds[i] === X.id` — that slot was X itself last
 *    round, so the hole is X's own; (2) `historyMessages[i]` is not in the
 *    candidate set; (3) roles are equal; (4) fold identities match; (5) the
 *    index is unclaimed. Condition (1) is what makes this NOT a universal
 *    predicate: it does not rest on any "ids are forever stable" belief, since
 *    a drifted id simply fails it.
 *
 * FOLD IDENTITY IS TIERED, NOT CONJOINED. Eligibility is still restricted to
 * what a history row can express: user/assistant role, text/thinking blocks
 * only, no permission_request / question / tool blocks (their live cards and
 * `pendingPermissions` links would be destroyed). On top of that:
 *   - a message WITH coverage text matches on text alone, exactly as before —
 *     its history row need not have recovered any attachment metadata;
 *   - only a message with NO coverage text falls back to the ordered
 *     `(kind, mediaType)` attachment identity. F11 hole B: an image-only turn
 *     has empty coverage text on BOTH sides, so it never matched at all and
 *     duplicated forever. `name` is excluded from the identity because an
 *     Anthropic image block has nowhere to put a filename — the replayed copy
 *     never has one while the runtime echo does;
 *   - a message with neither text nor attachments opts out entirely.
 *
 * THE ATTACHMENT TIER CARRIES THREE PRECONDITIONS, because `(kind,
 * mediaType)` collapses to one value for this app's screenshots (all
 * `image/png`), so an unattributable hit DELETES a real turn (measured: 2
 * bubbles -> 1): (1) the snapshot must have an anchor; (2) the row must be in
 * the post-anchor fresh tail or be this echo's own positional hole; (3) the
 * row's attachments must ALL be unnamed — that is the signature of a row this
 * app itself wrote (the other carrier, foreign control/tool rows, always names
 * its attachments).
 *
 * Attachment-bearing messages with otherwise foldable blocks get a
 * "replacement fold": the runtime copy (which carries attachment metadata)
 * REPLACES the matching history row at its position, so the user sees one
 * message with correct attachment chips instead of two, in file order.
 *
 * The walk stays a one-way cursor: a user may legally send the same text
 * twice; forward-only matching conserves count and order. The positional and
 * scan regions are disjoint and share one claimed-index set, so the
 * replacement map can never get two writers for one key.
 *
 * RESIDUAL FAIL DIRECTION is a duplicated bubble, never a lost one, EXCEPT
 * for two registered holes: (R6, pre-existing) with no anchor at all the text
 * tier can match an echo against an EARLIER same-text row; (R7, introduced
 * with the attachment tier) an unnamed, echo-less image row landing after the
 * anchor can absorb our echo — the same exposure the text tier already had.
 * Both are owned by the follow-up ticket that keys folds on canonical uuids.
 *
 * ROLLBACK SAFETY (ordered, not independent): the only safe states are
 * {both holes reverted} and {hole A in place, hole B reverted}. Reverting
 * hole A while hole B is live is FORBIDDEN and strictly worse than doing
 * nothing: hole B makes an image-only turn fold once, which digs exactly the
 * pre-anchor hole that hole A exists to reclaim, degrading "stable
 * duplication" into "duplication plus positional drift".
 *
 * Zero store imports on purpose (same leaf-module rule as
 * `sessionIndex/dismissedSessions.ts`): `chatSessions.ts` calls this from
 * its reducer, so this file must never import back into store/hook land.
 * The snapshot registry below is module state for the same reason.
 */

import { HISTORY_MESSAGE_ID_PREFIX } from '@shared/types/sessionHistory';

/** Minimal structural shape so `ChatMessage` flows through a generic unchanged. */
export interface ReplayMergeMessage {
  id: string;
  role: string;
  blocks: readonly { type: string; text?: string }[];
  /** Attachment metadata; carried by runtime messages and, since the C-06
   * attachments widening, by history rows too. Fold checks only read it off
   * runtime copies. */
  attachments?: readonly unknown[];
}

export interface ResumeSnapshot {
  candidateIds: ReadonlySet<string>;
  /**
   * Bucket ids IN ORDER at snapshot time = the PREVIOUS merge's output order.
   * Read only by the alignment probe (guard 3d) and the positional hole claim
   * (guard 3e); never used as a membership test.
   */
  orderedIds: readonly string[];
  /**
   * Last `h:*` id in the bucket at snapshot time — the fold cursor starts
   * after this row in the fresh replay. Null on a first resume (nothing
   * hydrated yet).
   */
  anchorHistoryId: string | null;
}

/** sessionId → latest resume snapshot; overwritten by each new resume. */
const resumeSnapshots = new Map<string, ResumeSnapshot & { requestId: string }>();

/**
 * Called by the `session.resumed` reducer with the bucket's message ids IN
 * ORDER: records which messages already existed before this resume — the
 * only ones its replay may fold — and where the previous hydration ended.
 */
export function snapshotResumeCandidates(
  sessionId: string,
  requestId: string,
  orderedMessageIds: readonly string[]
): void {
  let anchorHistoryId: string | null = null;
  for (let i = orderedMessageIds.length - 1; i >= 0; i--) {
    const id = orderedMessageIds[i];
    if (id?.startsWith(HISTORY_MESSAGE_ID_PREFIX)) {
      anchorHistoryId = id;
      break;
    }
  }
  resumeSnapshots.set(sessionId, {
    requestId,
    candidateIds: new Set(orderedMessageIds),
    orderedIds: [...orderedMessageIds],
    anchorHistoryId,
  });
}

/**
 * Called by the `session.history` reducer. Consumes the snapshot only on a
 * requestId match (a stale replay from an older resume must neither fold
 * anything nor destroy the snapshot the in-flight resume still owns).
 */
export function takeResumeSnapshot(
  sessionId: string,
  requestId: string | undefined
): ResumeSnapshot | null {
  const snapshot = resumeSnapshots.get(sessionId);
  if (!snapshot || !requestId || snapshot.requestId !== requestId) {
    return null;
  }
  resumeSnapshots.delete(sessionId);
  return {
    candidateIds: snapshot.candidateIds,
    orderedIds: snapshot.orderedIds,
    anchorHistoryId: snapshot.anchorHistoryId,
  };
}

/** Test-only: module state must not leak between vitest cases. */
export function resetResumeCandidatesForTests(): void {
  resumeSnapshots.clear();
}

const FOLDABLE_BLOCK_TYPES = new Set(['text', 'thinking']);

/**
 * Text identity used for coverage: concatenated `text` blocks only. An empty
 * result opts the message out of matching entirely.
 */
function coverageText(message: ReplayMergeMessage): string {
  return message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
}

type FoldIdentity = { mode: 'text' | 'attachment'; key: string };

/**
 * Where the candidate row sits relative to the anchor. `'no-anchor'` is a
 * replay whose snapshot never had an anchor at all (a first resume).
 */
type MatchSite = 'tail' | 'hole' | 'no-anchor';

/**
 * The identity a message is matched by. TEXT WINS whenever there is text: an
 * attachment-bearing message with prose keeps folding exactly as it did
 * before, and its history row does NOT have to have recovered any attachment
 * metadata (a foreign Host, a carrier this reader cannot see, an older JSONL
 * — all still fold). Only a message with NO coverage text falls back to
 * attachment identity: the image-only turn that used to opt out of matching
 * entirely and duplicate forever. Null = opts out, unchanged.
 */
function foldIdentity(message: ReplayMergeMessage): FoldIdentity | null {
  const text = coverageText(message);
  if (text.length > 0) {
    return { mode: 'text', key: text };
  }
  const attachments = attachmentIdentity(message);
  if (attachments.length > 0) {
    return { mode: 'attachment', key: attachments };
  }
  return null;
}

/**
 * Ordered `(kind, mediaType)` pairs, JSON-encoded so no separator can ever be
 * forged by a media type. `name` is DELIBERATELY excluded: an Anthropic image
 * block has nowhere to put a filename, so the replayed copy of an image turn
 * never has a name while the runtime echo does. Including `name` would make
 * every image turn unmatchable — the bug itself. Order and count ARE part of
 * the identity: two images and one image are not the same turn. Reads
 * defensively: `attachments` is `readonly unknown[]` here.
 */
function attachmentIdentity(message: ReplayMergeMessage): string {
  const attachments = message.attachments;
  if (!attachments || attachments.length === 0) {
    return '';
  }
  return JSON.stringify(
    attachments.map((raw) => {
      const meta = (raw ?? {}) as { kind?: unknown; mediaType?: unknown };
      return [
        typeof meta.kind === 'string' ? meta.kind : '',
        typeof meta.mediaType === 'string' ? meta.mediaType : '',
      ];
    })
  );
}

/**
 * Carrier-A signature. `historyReader` writes this app's own image rows
 * through `extractContentAttachments`, where the image block has nowhere to
 * put a filename, so such a row NEVER has a name. A name can only come from
 * Carrier B (`extractControlAttachment`, which reads `name` / `filename` /
 * `path`) — a foreign writer whose row must not absorb our echo.
 */
function attachmentsAreUnnamed(row: ReplayMergeMessage): boolean {
  const attachments = row.attachments;
  if (!attachments || attachments.length === 0) {
    return false;
  }
  return attachments.every((raw) => {
    const meta = (raw ?? {}) as { name?: unknown };
    return meta.name === undefined || meta.name === null || meta.name === '';
  });
}

/**
 * May `row` absorb an echo carrying `identity`? Role is checked by the caller.
 * TEXT tier: mode + key, exactly the pre-F11 rule.
 * ATTACHMENT tier adds three preconditions, because `(kind, mediaType)` fully
 * COLLAPSES for the screenshots this app takes (every one is `image/png`), so
 * an unattributable hit must always yield (measured: without them a real turn
 * is deleted, 2 bubbles -> 1):
 *   1. the replay must HAVE an anchor (`site !== 'no-anchor'`);
 *   2. the row must be in the post-anchor fresh tail, or be this echo's own
 *      positional hole — `site` carries exactly that distinction;
 *   3. the row's attachments must ALL be unnamed (Carrier-A signature).
 */
function identityMatches(
  identity: FoldIdentity,
  row: ReplayMergeMessage,
  site: MatchSite
): boolean {
  const rowIdentity = foldIdentity(row);
  if (!rowIdentity) {
    return false;
  }
  if (rowIdentity.mode !== identity.mode || rowIdentity.key !== identity.key) {
    return false;
  }
  if (identity.mode === 'text') {
    return true;
  }
  if (site === 'no-anchor') {
    return false;
  }
  return attachmentsAreUnnamed(row);
}

/** True when dropping this message loses nothing a history row cannot restate. */
function isFoldable(message: ReplayMergeMessage): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return false;
  }
  if (message.attachments && message.attachments.length > 0) {
    return false;
  }
  return message.blocks.every((block) => FOLDABLE_BLOCK_TYPES.has(block.type));
}

/**
 * True when the message would be foldable except for attachments. These are
 * "replacement foldable": when matched against a history row, the history
 * copy is REPLACED by the runtime copy (preserving attachment metadata)
 * instead of both surviving. Without this, a user message with an image
 * appears twice after resume — once from history (no attachment chip) and
 * once as the unfoldable runtime echo.
 */
function isReplacementFoldable(message: ReplayMergeMessage): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return false;
  }
  if (!message.attachments || message.attachments.length === 0) {
    return false;
  }
  return message.blocks.every((block) => FOLDABLE_BLOCK_TYPES.has(block.type));
}

export function mergeReplayedHistory<T extends ReplayMergeMessage>(
  bucket: readonly T[],
  historyMessages: readonly T[],
  options: { historyReadFailed: boolean; snapshot: ResumeSnapshot | null }
): T[] {
  // Prefix replace semantics unchanged: previously hydrated `h:*` rows are
  // always superseded by the fresh replay.
  const runtime = bucket.filter((message) => !message.id.startsWith(HISTORY_MESSAGE_ID_PREFIX));

  // A failed or empty read carries no authority over runtime messages —
  // byte-identical to the old merge, nothing is ever dropped on this path.
  if (options.historyReadFailed || historyMessages.length === 0) {
    return [...historyMessages, ...runtime];
  }

  const snapshot = options.snapshot;
  if (!snapshot) {
    // No matching resume snapshot: this replay has no watermark to bound the
    // fold, so fold nothing (guard 1). Duplication beats loss.
    return [...historyMessages, ...runtime];
  }
  const { candidateIds, anchorHistoryId, orderedIds } = snapshot;

  // Guard 3a: the anchor's PRESENCE proves `h:<jsonl-uuid>` id continuity
  // across re-reads. When the anchor row is GONE from this replay (head
  // eviction under the read caps — a protocol-legal success with
  // `truncated: true` — or a rewritten JSONL) every id is suspect. No
  // continuity proof → no folding at all. A snapshot that never had an anchor
  // (first resume) is exempt: nothing was hydrated, nothing drifted.
  const anchorIndex = anchorHistoryId
    ? historyMessages.findIndex((history) => history.id === anchorHistoryId)
    : -1;
  if (anchorHistoryId && anchorIndex < 0) {
    return [...historyMessages, ...runtime];
  }

  // Guard 3d (alignment probe): the snapshot's bucket order IS the previous
  // merge's output order, so up to the anchor it is also the history file
  // order. If the anchor sits at a different index on the two sides, the read
  // window moved, rows were renumbered, the JSONL was rewritten, or a row was
  // inserted mid-file — index `i` no longer names the same row on both sides,
  // so NO positional claim is trustworthy. One comparison closes synthetic
  // drift, head eviction and file rewrites at once, without ever knowing the
  // string `synthetic-`.
  const aligned = anchorHistoryId === null || orderedIds.indexOf(anchorHistoryId) === anchorIndex;

  // The forward cursor keeps the anchor lower bound: rows before the anchor
  // stay unreachable to the scan, which is what stops v1's P1 counterexample
  // AND the id-drift counterexample. The only way into the pre-anchor region
  // is guard 3e below, one exact index at a time.
  let cursor = anchorIndex + 1;
  // Every index claimed by either channel, so the replacement map can never
  // receive two writers for one key (INV-P1).
  const claimed = new Set<number>();
  // Attachment-tier precondition 1, hoisted: an anchorless replay must never
  // fold the attachment tier (identity collapses and the scan covers the whole
  // file, so an unattributable hit would DELETE a real turn).
  const tailSite: MatchSite = anchorHistoryId === null ? 'no-anchor' : 'tail';

  const kept: T[] = [];
  // Replacement folds: runtime messages with attachments that matched a
  // history row. The history row is swapped for the runtime copy so the
  // attachment metadata (thumbnails, names) survives the merge.
  const historyReplacements = new Map<number, T>();

  for (const message of runtime) {
    if (!candidateIds.has(message.id)) {
      kept.push(message);
      continue;
    }
    const replaceFold = isReplacementFoldable(message);
    if (!isFoldable(message) && !replaceFold) {
      kept.push(message);
      continue;
    }
    const identity = foldIdentity(message);
    if (!identity) {
      kept.push(message);
      continue;
    }

    let matchedAt = -1;

    // Guard 3e: claim the hole THIS echo dug last round. `orderedIds[hole]`
    // is whoever occupied that slot in the previous output; requiring it to be
    // this very message id is what turns INV-P4 from an assumption into a
    // checked condition — an echo can only ever claim its own hole, and a
    // drifted row can never be mistaken for one.
    if (aligned) {
      const hole = orderedIds.indexOf(message.id);
      if (hole >= 0 && hole <= anchorIndex && !claimed.has(hole)) {
        const row = historyMessages[hole];
        if (
          row &&
          row.role === message.role &&
          !candidateIds.has(row.id) &&
          identityMatches(identity, row, 'hole')
        ) {
          matchedAt = hole;
        }
      }
    }

    if (matchedAt < 0) {
      for (let i = cursor; i < historyMessages.length; i++) {
        const candidate = historyMessages[i];
        if (!candidate || candidate.role !== message.role) continue;
        if (claimed.has(i)) continue;
        // Guard 3b (defence in depth): a settled history row never absorbs an
        // echo. The bound that actually stops P1 is `cursor` above.
        if (candidateIds.has(candidate.id)) continue;
        if (!identityMatches(identity, candidate, tailSite)) continue;
        matchedAt = i;
        break;
      }
      if (matchedAt >= 0) {
        cursor = matchedAt + 1;
      }
    }

    if (matchedAt < 0) {
      kept.push(message);
      continue;
    }
    claimed.add(matchedAt);
    if (replaceFold) {
      historyReplacements.set(matchedAt, message);
    }
  }

  const mergedHistory =
    historyReplacements.size > 0
      ? historyMessages.map((h, i) => historyReplacements.get(i) ?? h)
      : historyMessages;

  return [...mergedHistory, ...kept];
}
