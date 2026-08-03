/**
 * Round-6 Bug B (v2 after dual-track review): reconcile a `session.history`
 * replay with runtime messages already in the session bucket.
 *
 * A resume replays the entire JSONL. Turns this renderer already echoed live
 * (`user-*` / `asst-*` ids from the normalizer) come back a second time as
 * `h:*` history messages — the old "replace by `h:` prefix, keep every
 * runtime message" merge therefore rendered each recovered turn twice. That
 * is what the user read as "double send": one failed turn + its replayed
 * copy + the real manual resend.
 *
 * v1 was a bare (role, text) coverage walk. Both review tracks refuted it
 * with the same class of counterexample: without a time boundary the walk
 * can eat a message the user JUST sent (same text as an older history row,
 * history arriving late), and after a second replay the cursor restarts at
 * history row 0 and eats the tail. "Fail direction is duplication, never
 * loss" only holds with THREE guards conjoined — watermark and walk are a
 * conjunction, not alternatives:
 *
 * 1. RESUME WATERMARK (candidate set): `session.resumed` snapshots the ids
 *    present in the bucket at that moment, keyed by (sessionId, requestId).
 *    Only those candidates may ever be folded by the matching
 *    `session.history`; a message that arrived after the resume is by
 *    definition not covered by that replay and is always kept. No snapshot
 *    or a requestId mismatch (stale replay, contract violation) → no
 *    folding at all.
 * 2. MATCH-REQUIRED: a candidate is dropped only when the walk finds a
 *    same-role, same-text history row at/after the cursor. An unmatched
 *    candidate (JSONL tail not flushed yet, truncated read, text drift) is
 *    kept — the watermark alone would delete it, which is silent loss.
 * 3. TAIL ANCHOR: the cursor starts after the last `h:*` row that was in
 *    the bucket AT SNAPSHOT TIME and still exists in the fresh replay
 *    (`h:<jsonl-uuid>` ids are stable across re-reads by contract). After a
 *    second replay the remaining runtime messages represent the session
 *    TAIL; without the anchor they would be matched against same-text rows
 *    from much earlier turns. The anchor is frozen WITH the candidate set —
 *    reading it from the current bucket instead would let an interleaved
 *    stale replay (prefix-replace only) push unfolded pre-resume echoes
 *    behind fresh `h:*` rows and exempt them from folding forever. And when
 *    the anchor row is missing from the fresh replay (truncated read window
 *    / rewritten JSONL), the replay folds NOTHING — falling back to row 0
 *    would be v1 again (round-6 verify blocker).
 *
 * Fold eligibility is further restricted to what a history row can actually
 * express: user/assistant role, text/thinking blocks only, no attachments
 * (`HistoryMessage` has no attachment field), no permission_request /
 * question / tool blocks (their live cards and `pendingPermissions` links
 * would be destroyed). Empty coverage text opts out entirely. Ineligible or
 * unmatched → kept: the residual fail direction is a duplicated bubble,
 * never a lost one.
 *
 * The walk stays a one-way cursor: a user may legally send the same text
 * twice; forward-only matching conserves count and order.
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
  /** Runtime-only attachment metadata; history rows can never carry it. */
  attachments?: readonly unknown[];
}

export interface ResumeSnapshot {
  candidateIds: ReadonlySet<string>;
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
  return { candidateIds: snapshot.candidateIds, anchorHistoryId: snapshot.anchorHistoryId };
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
  const { candidateIds, anchorHistoryId } = snapshot;

  // Guard 3: start the cursor after the snapshot-time hydration tail. When
  // the anchor row is GONE from this replay (head eviction under the read
  // caps — a protocol-legal success with `truncated: true` — or a rewritten
  // JSONL), there is no trustworthy cursor: restarting at row 0 would
  // re-open v1's failure, matching tail candidates against unrelated early
  // same-text rows, which is loss. No anchor position → no folding at all;
  // only a snapshot that never had an anchor (first resume) starts at 0.
  let cursor = 0;
  if (anchorHistoryId) {
    const anchor = historyMessages.findIndex((history) => history.id === anchorHistoryId);
    if (anchor < 0) {
      return [...historyMessages, ...runtime];
    }
    cursor = anchor + 1;
  }

  const kept: T[] = [];
  for (const message of runtime) {
    if (!candidateIds.has(message.id) || !isFoldable(message)) {
      kept.push(message);
      continue;
    }
    const text = coverageText(message);
    if (text.length === 0) {
      kept.push(message);
      continue;
    }
    let matchedAt = -1;
    for (let i = cursor; i < historyMessages.length; i++) {
      const candidate = historyMessages[i];
      if (candidate && candidate.role === message.role && coverageText(candidate) === text) {
        matchedAt = i;
        break;
      }
    }
    if (matchedAt === -1) {
      kept.push(message);
    } else {
      cursor = matchedAt + 1;
    }
  }

  return [...historyMessages, ...kept];
}
