import { create } from 'zustand';
import type { SendPhase } from '@/components/chat/attachments';

/**
 * T-31 §3 (R4): the in-flight turn's status snapshot, published by
 * `ChatComposer` and consumed by `MessageTimeline`'s turn head.
 *
 * ## Why a store at all
 *
 * The waiting copy moved from the composer row to the turn head, but three of
 * the four facts it is built from only exist inside `ChatComposer.runSend`:
 * the send phase (`handshake` vs `awaiting`), the seconds ticker, and this
 * send's own wait budget. `chatSessions.ts` is a red-line file and carries none
 * of them; `activeSession.retry` (the fourth) is already there and is read
 * directly, so it is deliberately NOT duplicated here.
 *
 * The three candidates were: lift the state into `ChatWorkspace`, reuse an
 * existing non-red-line store, or add this one. Lifting means threading five
 * values plus their setters through a 2200-line component whose send path is
 * the most timing-sensitive code in the renderer, and it would re-render the
 * banner, the dock and the composer on every one-second tick. No existing store
 * models "the send currently in flight" (`messageQueue` models the messages
 * NOT yet in flight). This module is the smallest of the three: `ChatComposer`
 * is the only writer, `MessageTimeline` the only reader, and — importantly —
 * the composer no longer keeps its own copy of these three values, so this is a
 * MOVE, not a mirror. There is no second source to drift from.
 *
 * ## Scope
 *
 * One slot, not a per-session map: exactly one `ChatComposer` is mounted and
 * its `inFlightRef` latch already allows only one send at a time (the queue
 * releases entries strictly one after another). `sessionId` is carried so the
 * reader can tell WHICH session the snapshot belongs to — the composer's own
 * in-flight state is not per-session (see `inFlightSessionIdRef` in
 * `ChatComposer.tsx`), so a session switch mid-send must not paint another
 * session's turn head with this one's clock.
 *
 * Nothing here is persisted: a snapshot only describes a send that is happening
 * right now, and after a reload there is none.
 */
export interface TurnSendStatus {
  /** The session whose turn is in flight. */
  sessionId: string;
  phase: SendPhase;
  /** Seconds since the CURRENT phase started (the ticker resets at the phase change). */
  elapsedSeconds: number;
  /**
   * This send's wait budget in ms. F456 §7.2 retired the `(up to Ns)` clause it
   * used to feed, so no reader prints it any more; it is still carried so the
   * turn head can pass it to a parameter whose whole job is now to be ignored.
   */
  budgetMs: number;
  /** Attachments committed with THIS turn, captured at the commit point (see `begin`). */
  attachmentCount: number;
  attachmentBytes: number;
  /**
   * F456 §7.4: size of the committed prompt in CODE POINTS — what the turn head
   * shows as `↑ 428 chars`.
   *
   * Captured at the commit point for the same reason as the two attachment
   * fields above, and REQUIRED rather than optional: the pending turn head reads
   * it off a non-null snapshot, so a producer that forgets to write it should
   * fail to compile rather than silently drop the count from the one window
   * where it is the only description of what was just sent.
   */
  promptChars: number;
}

/**
 * Ownership token for one send (review batch F3).
 *
 * The slot is global and its writer is not: `runSend` is an async closure whose
 * ticker, phase switch and `finally` can all outlive the `ChatComposer`
 * instance that started them (the middle column tears down on a layout change,
 * a session switch, a workspace switch). Without a token, a dead instance's
 * `update` could patch — and its `finally`/unmount cleanup could clear — a
 * snapshot that a LIVE instance had already published for a different send. The
 * symptom is the worst kind: a turn head that either freezes on another send's
 * seconds or goes blank mid-wait.
 *
 * Opaque number rather than the existing `sendGenerationRef`: that ref is
 * per-instance, so two instances would mint the same values. The check lives
 * INSIDE the store on purpose — a caller-side `if (mine)` guard is exactly the
 * kind of check that is forgotten at one of the four call sites.
 */
export type TurnSendOwner = number;

/** The stored snapshot: the public shape plus the token that may mutate it. */
export type OwnedTurnSendStatus = TurnSendStatus & { owner: TurnSendOwner };

/**
 * Where a session's message list stood at the last send's commit point (final
 * review, F2/F4 residue).
 *
 * ## The hole this closes
 *
 * `historyReader` keeps a trailing user message that never got a reply, and
 * `groupMessagesIntoTurns` folds it into a turn with `user !== null` and
 * `body.length === 0` — structurally IDENTICAL to the turn a fresh send opens
 * when the Host echoes the user's prompt back. "Was this turn opened by the
 * send now in flight?" therefore cannot be answered from the turn's own shape,
 * and both `deriveSendStatusBinding` and `ownsSessionFailure` were answering it
 * that way: a restored user-only tail claimed the next send's clock and the
 * next send's failure.
 *
 * The baseline answers it by identity instead — a turn opened by this send has
 * a user message that did not exist when the send began, so its id differs from
 * the last id in the bucket at that moment.
 *
 * The replayed-message id prefix (`h:`) would separate history from runtime,
 * but not enough: a PREVIOUS runtime send whose turn never received a reply
 * (Stop, or the 45s abandon that deliberately leaves the turn running) leaves
 * an equally user-only turn with a runtime id. The baseline covers both, so it
 * is the single mechanism rather than one of two.
 *
 * ## Why it outlives `end()`
 *
 * `ownsSessionFailure` needs it precisely when there is no live snapshot: by
 * the time `session.failed` reaches the store, `runSend`'s `finally` has
 * usually already cleared the slot. Clearing the baseline with it would leave
 * the failure with no way to tell a just-sent turn from a restored one — the
 * same bug in a different frame. It is keyed by session, so a stale baseline
 * from another session is ignored rather than trusted.
 */
export interface TurnSendBaseline {
  sessionId: string;
  /** Last message id in the session's bucket at the commit point; `null` for a session with no messages yet. */
  messageId: string | null;
}

/**
 * F2 (2026-08-18 §4.5): a turn the Host admitted and is still running, which
 * THIS renderer has stopped waiting on. Display-only: it is what keeps the turn
 * head — and the Stop button inside it — alive after the silence ceiling
 * elapses, instead of the head vanishing while the turn is demonstrably still
 * going. Deliberately carries NO payload: the committed text/attachments stay
 * in `ChatComposer`'s own `pendingReplyRef`, so user data never enters a store
 * a devtools session would serialise, and this slot stays small enough to
 * assert whole.
 */
export interface PendingReplyWatch {
  sessionId: string;
  /** When the wait this watch replaces began, ms — the turn head recomputes its seconds from it. */
  turnStartedAtMs: number;
}

interface TurnSendStatusStore {
  status: OwnedTurnSendStatus | null;
  /** The most recent send's baseline. NOT cleared by `end` — see `TurnSendBaseline`. */
  baseline: TurnSendBaseline | null;
  /**
   * F2: the second slot. Independent of `status` on purpose — it is armed
   * exactly when `status` is being torn down (`runSend`'s `finally` clears the
   * snapshot the instant the renderer stops waiting), so sharing one slot would
   * make the two cancel each other out.
   */
  pendingReply: PendingReplyWatch | null;
  /**
   * Publish a fresh snapshot at the send's commit point, taking ownership of
   * the slot. Replaces any stale one and returns the token every later call
   * for THIS send must present.
   *
   * `baselineMessageId` is the last id in this session's message bucket as read
   * at the commit point — before `chat.send`, so before any user echo can have
   * landed.
   */
  begin: (status: TurnSendStatus, baselineMessageId: string | null) => TurnSendOwner;
  /** Patch the live snapshot (phase change / seconds tick). No-op unless `owner` still holds the slot. */
  update: (owner: TurnSendOwner, patch: Partial<Omit<TurnSendStatus, 'sessionId'>>) => void;
  /** Clear the snapshot — the send is no longer in flight, whatever its outcome. No-op unless `owner` still holds the slot. */
  end: (owner: TurnSendOwner) => void;
  /** Arm the pending-reply watch. Replaces any previous one — one composer, one send at a time. */
  armPendingReply: (watch: PendingReplyWatch) => void;
  /** Clear it, idempotently and only for the matching session (a late clear for a session the user already left must not blank the current one). */
  clearPendingReply: (sessionId: string) => void;
}

/**
 * Monotonic token source. Module-level rather than store state: it must stay
 * unique across a `setState` reset (a test helper clearing `status` must not
 * hand the next send a token a stale closure still holds).
 */
let nextOwner = 0;

export const useTurnSendStatusStore = create<TurnSendStatusStore>()((set) => ({
  status: null,
  baseline: null,
  pendingReply: null,
  begin: (status, baselineMessageId) => {
    nextOwner += 1;
    const owner = nextOwner;
    // Refreshed on EVERY begin, which is what makes a T-19 queue release —
    // one `begin` per entry, strictly one after another — advance the baseline
    // past the turn the previous entry opened.
    set({
      status: { ...status, owner },
      baseline: { sessionId: status.sessionId, messageId: baselineMessageId },
    });
    return owner;
  },
  update: (owner, patch) =>
    set((state) =>
      state.status && state.status.owner === owner
        ? { status: { ...state.status, ...patch } }
        : state
    ),
  end: (owner) => set((state) => (state.status?.owner === owner ? { status: null } : state)),
  armPendingReply: (watch) => set({ pendingReply: watch }),
  clearPendingReply: (sessionId) =>
    set((state) => (state.pendingReply?.sessionId === sessionId ? { pendingReply: null } : state)),
}));
