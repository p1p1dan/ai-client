/**
 * T-19 message queue — pure DATA layer only.
 *
 * Owns the shape of "messages typed while a turn is running" and the reducers
 * that mutate it. Nothing here knows about `SessionRuntimeStatus`, React, or
 * `window` — whether a turn CAN start, and whether the queue's head SHOULD be
 * released right now, is runtime-state judgment and belongs in
 * `queueRelease.ts` instead (see that file's header for the split rationale).
 *
 * Every reducer follows the existing "no-op returns the same reference"
 * convention used by `rememberSendAttempt` / `clearDrafts` elsewhere in this
 * package, so callers can feed a reducer's result straight into `setState`
 * without forcing a spurious re-render.
 *
 * §12 verification first: __tests__/messageQueue.test.ts.
 */

import { DEFAULT_ATTACHMENT_LIMITS } from './attachmentLimits';
import type { AttachmentDraft } from './attachments';
import { formatAttachmentSize, totalAttachmentBytes } from './attachments';

/** One message typed while its session could not start a new turn. */
export interface QueuedMessage {
  id: string;
  sessionId: string;
  text: string;
  /** Reuses T-18's AttachmentDraft — no new attachment type for the queue. */
  attachments: readonly AttachmentDraft[];
  queuedAt: number;
  /**
   * DORMANT (T-19 fix review R5): batch 3 used to set this once a released
   * entry's turn failed and requeue it at the head — reverted because a
   * swap-edit on that head cleared `failure` and auto-released the user's
   * half-typed draft (blocker). No production path writes this anymore;
   * Retry is a component-local snapshot instead (`ChatComposer`'s
   * `retryable`). Kept as a sleeping field — and `takeEntryIntoDraft` still
   * clears it on swap, and `decideQueueRelease` still holds on it — for a
   * future T-19b that re-introduces queue-based failure tracking.
   */
  failure?: { message: string };
}

/**
 * Reasons a queue can be paused: the user clicked Stop (decision 3.4), or
 * (S1, round-2 iteration-3 review; generalized from R4's `session_busy`-only
 * version) the release path's `runSend` attempt came back `'rejected'` — the
 * Host flatly refused to admit the head entry (busy-retry exhaustion, a
 * create/resume timeout, an `ensureHost()` rejection, a non-busy
 * pre-admission `host.error`, or a `session.failed` landing mid busy-loop —
 * every evidence-free handshake-failure class, not one specific error code).
 * Pausing here stops `decideQueueRelease` from re-firing the SAME entry
 * every render forever against a Host that keeps refusing it.
 */
export type QueuePauseReason = 'stopped' | 'send-rejected';

export interface SessionQueue {
  entries: readonly QueuedMessage[];
  paused: QueuePauseReason | null;
}

export interface MessageQueueState {
  bySession: Readonly<Record<string, SessionQueue>>;
}

/** Fresh, empty queue state — the store's initial value and a base for tests. */
export function createEmptyState(): MessageQueueState {
  return { bySession: {} };
}

// Stable references so a lookup for an unknown/empty session never breaks a
// selector's `===` check (decision 1's `selectSessionQueue` requirement).
const EMPTY_ENTRIES: readonly QueuedMessage[] = [];
const EMPTY_QUEUE: SessionQueue = { entries: EMPTY_ENTRIES, paused: null };

/** A session's queue, or the shared empty sentinel when it has none yet. */
export function selectSessionQueue(
  state: MessageQueueState,
  sessionId: string | null
): SessionQueue {
  if (sessionId == null) return EMPTY_QUEUE;
  return state.bySession[sessionId] ?? EMPTY_QUEUE;
}

// ---- enqueue ----

export interface EnqueueLimits {
  /** Per-session entry cap (decision 1: 20, aligned with openchamber). */
  maxEntries: number;
  /** RAW bytes across every attachment in the session's whole queue. */
  maxTotalBytes: number;
}

/** 20 entries/session + the existing 10 MB attachment budget — no new token, see decision 1. */
export const DEFAULT_ENQUEUE_LIMITS: EnqueueLimits = {
  maxEntries: 20,
  maxTotalBytes: DEFAULT_ATTACHMENT_LIMITS.maxTotalBytes,
};

export type EnqueueRejectReason = 'empty' | 'too-many' | 'too-large';

export type EnqueueResult =
  | { ok: true; state: MessageQueueState }
  | { ok: false; state: MessageQueueState; reason: EnqueueRejectReason; message: string };

/**
 * Admit one message onto the tail of its session's queue.
 *
 * m2 fix: a successful admission into an EMPTY bucket also clears `paused` —
 * that is decision 3.4's actual deadlock scenario (an invisible pause on a
 * bucket the strip has nothing to show a Resume link for). Admitting into a
 * non-empty bucket leaves `paused` as-is: enqueuing a follow-up while paused
 * is not "a new turn starting" (that is Send/Retry/explicit Resume — see
 * `clearPause`'s callers), and clearing it here would silently release the
 * WHOLE queue — including messages the user explicitly Stopped — the moment
 * status next settles to idle.
 * Rejections never touch state (same reference returned) — the caller keeps
 * the textarea text exactly as typed (decision 7: "队列满 ... 绝不静默丢字").
 */
export function enqueue(
  state: MessageQueueState,
  message: QueuedMessage,
  limits: EnqueueLimits = DEFAULT_ENQUEUE_LIMITS
): EnqueueResult {
  if (message.text.trim().length === 0 && message.attachments.length === 0) {
    return {
      ok: false,
      state,
      reason: 'empty',
      message: 'Type a message or attach a file before queuing.',
    };
  }

  const bucket = state.bySession[message.sessionId] ?? EMPTY_QUEUE;

  if (bucket.entries.length >= limits.maxEntries) {
    return {
      ok: false,
      state,
      reason: 'too-many',
      message: `Up to ${limits.maxEntries} queued messages per session — send or remove one first.`,
    };
  }

  const existingBytes = bucket.entries.reduce(
    (total, entry) => total + totalAttachmentBytes(entry.attachments),
    0
  );
  const nextBytes = existingBytes + totalAttachmentBytes(message.attachments);
  if (nextBytes > limits.maxTotalBytes) {
    return {
      ok: false,
      state,
      reason: 'too-large',
      message: `Queued attachments would total ${formatAttachmentSize(nextBytes)} — max ${formatAttachmentSize(limits.maxTotalBytes)} per session queue. Remove one first.`,
    };
  }

  const nextBucket: SessionQueue = {
    entries: [...bucket.entries, message],
    paused: bucket.entries.length === 0 ? null : bucket.paused,
  };
  return {
    ok: true,
    state: { bySession: { ...state.bySession, [message.sessionId]: nextBucket } },
  };
}

// ---- release plumbing (takeHead / restoreHead) ----

/** Pop the queue's head. Empty/unknown session returns `entry: null` and the same state reference. */
export function takeHead(
  state: MessageQueueState,
  sessionId: string
): { state: MessageQueueState; entry: QueuedMessage | null } {
  const bucket = state.bySession[sessionId];
  if (!bucket || bucket.entries.length === 0) {
    return { state, entry: null };
  }
  const [entry, ...rest] = bucket.entries;
  return {
    state: { bySession: { ...state.bySession, [sessionId]: { ...bucket, entries: rest } } },
    entry,
  };
}

/**
 * Put an entry back at the front of its own session's queue (`entry.sessionId`
 * — no separate sessionId argument, so a caller can never restore into the
 * wrong bucket). Used when `runSend` reports `'skipped'` or `'rejected'`
 * (round-2 P0: the Host flatly refused to admit the turn, e.g. `session_busy`)
 * after `takeHead` already popped the entry, or when `runEntry` rejects
 * outright — decision 3.3's "never swallow a message" guarantee.
 * Works even when the bucket does not exist yet (a prune could have raced it away).
 */
export function restoreHead(state: MessageQueueState, entry: QueuedMessage): MessageQueueState {
  const bucket = state.bySession[entry.sessionId] ?? EMPTY_QUEUE;
  return {
    bySession: {
      ...state.bySession,
      [entry.sessionId]: { ...bucket, entries: [entry, ...bucket.entries] },
    },
  };
}

// ---- entry-level operations ----

/** Drop one entry by id. Unknown session or id returns the same state reference. */
export function removeEntry(
  state: MessageQueueState,
  sessionId: string,
  entryId: string
): MessageQueueState {
  const bucket = state.bySession[sessionId];
  if (!bucket) return state;
  const index = bucket.entries.findIndex((entry) => entry.id === entryId);
  if (index === -1) return state;
  return {
    bySession: {
      ...state.bySession,
      [sessionId]: { ...bucket, entries: bucket.entries.filter((entry) => entry.id !== entryId) },
    },
  };
}

export interface DraftPayload {
  text: string;
  attachments: readonly AttachmentDraft[];
}

export type TakeEntryIntoDraftResult =
  | { type: 'moved'; payload: DraftPayload }
  | { type: 'swapped'; payload: DraftPayload };

/**
 * Chip "edit" affordance (decision 5.3) — one function covering both cases:
 *
 * - empty draft: the entry leaves the queue entirely and its payload becomes
 *   the new draft.
 * - non-empty draft: an in-place swap. The entry stays at the same index (it
 *   is not moved to the back of the line) and its content becomes the new
 *   draft, while the CURRENT draft becomes the new content of that slot.
 *
 * The swapped entry keeps its original `id`/`queuedAt` — only `text` and
 * `attachments` change hands. That keeps this function free of `Date.now()`/
 * id generation (both already live in the caller, mirroring how `enqueue`
 * takes a pre-built `QueuedMessage`), so it stays a pure, deterministic swap:
 * same slot, same identity, different contents. Any prior `failure` is
 * cleared — the swapped-in content has never been sent.
 *
 * Returns `result: null` (and the same state reference) for an unknown id.
 */
export function takeEntryIntoDraft(
  state: MessageQueueState,
  sessionId: string,
  entryId: string,
  currentDraft: DraftPayload
): { state: MessageQueueState; result: TakeEntryIntoDraftResult | null } {
  const bucket = state.bySession[sessionId];
  if (!bucket) return { state, result: null };
  const index = bucket.entries.findIndex((entry) => entry.id === entryId);
  if (index === -1) return { state, result: null };

  const entry = bucket.entries[index];
  const payload: DraftPayload = { text: entry.text, attachments: entry.attachments };
  const draftIsEmpty =
    currentDraft.text.trim().length === 0 && currentDraft.attachments.length === 0;

  if (draftIsEmpty) {
    const nextEntries = bucket.entries.filter((_, i) => i !== index);
    return {
      state: {
        bySession: { ...state.bySession, [sessionId]: { ...bucket, entries: nextEntries } },
      },
      result: { type: 'moved', payload },
    };
  }

  // m6 fix: trim, matching the normalization `enqueue`'s caller applies
  // (`handleSend`'s `value.trim()`) — without this, a swap can leave
  // leading/trailing whitespace in the queue that later ships verbatim via
  // `runSend(entry.text, …)`, the only queue text that skipped trimming.
  const swappedEntry: QueuedMessage = {
    ...entry,
    text: currentDraft.text.trim(),
    attachments: currentDraft.attachments,
    failure: undefined,
  };
  const nextEntries = bucket.entries.map((existing, i) => (i === index ? swappedEntry : existing));
  return {
    state: { bySession: { ...state.bySession, [sessionId]: { ...bucket, entries: nextEntries } } },
    result: { type: 'swapped', payload },
  };
}

// ---- pause ----

/** Mark a session's queue paused (decision 3.4: Stop). Idempotent — same reason returns the same reference. */
export function pauseSession(
  state: MessageQueueState,
  sessionId: string,
  reason: QueuePauseReason = 'stopped'
): MessageQueueState {
  const bucket = state.bySession[sessionId] ?? EMPTY_QUEUE;
  if (bucket.paused === reason) return state;
  return {
    bySession: { ...state.bySession, [sessionId]: { ...bucket, paused: reason } },
  };
}

/** Clear a session's pause (decision 3.4: any new turn start). Idempotent/no-op-safe. */
export function clearPause(state: MessageQueueState, sessionId: string): MessageQueueState {
  const bucket = state.bySession[sessionId];
  if (!bucket || bucket.paused === null) return state;
  return {
    bySession: { ...state.bySession, [sessionId]: { ...bucket, paused: null } },
  };
}

// ---- lifecycle ----

/**
 * Drop buckets for sessions that no longer exist (fork not followed / session
 * deleted / tree sync removal — decision 7). Mirrors `sendAttempts` pruning in
 * `ChatWorkspace.tsx`. Returns the same reference when nothing was stale.
 */
export function pruneSessions(
  state: MessageQueueState,
  liveSessionIds: readonly string[]
): MessageQueueState {
  const live = new Set(liveSessionIds);
  const keys = Object.keys(state.bySession);
  if (keys.every((id) => live.has(id))) return state;

  const nextBySession: Record<string, SessionQueue> = {};
  for (const id of keys) {
    if (live.has(id)) nextBySession[id] = state.bySession[id];
  }
  return { bySession: nextBySession };
}
