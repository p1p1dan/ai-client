import type { PermissionAutoReason } from '../shared/types/runtimeEvents.ts';
import { idKey, type JsonRpcId } from './codexWire.ts';

/**
 * The ONE table of Codex server requests awaiting our JSON-RPC response
 * (S2 design C10, rule 1).
 *
 * Questions (`item/tool/requestUserInput`), all three v2 approval kinds and MCP
 * elicitation share this single table. Our OWN outbound id↔Promise table lives
 * elsewhere (`codexConnection.ts`) and is physically separate: Codex's server
 * requests use their own id space starting at 0 [实测 fixtures: an approval with
 * `"id":0` in the same session where we had already sent `initialize` as id 0],
 * so one shared map would settle the wrong entry the moment both spaces reach
 * the same number. Two tables, no arbitration needed.
 *
 * ## The invariant this file exists to hold
 *
 * Every registered request is answered EXACTLY ONCE, and the frame is written
 * by the same step that removes the entry. Both halves matter, and they fail
 * differently:
 *
 *  - cleared the table without writing a frame → `size === 0` so the naive
 *    acceptance passes, while Codex sits in `waitingOnApproval` /
 *    `waitingOnUserInput` forever and the turn never ends (arbitration doc §1
 *    convergence item 4 — both design tracks found this independently);
 *  - wrote a second frame for an id already answered → pollutes the server's
 *    own pending table with a response to nothing.
 *
 * `settle()` is therefore the only write path in the module: `drain()` calls it
 * rather than reimplementing "reply then delete", so "exactly once" is true by
 * construction and not by review.
 *
 * ## The ONE exception: `forget()`
 *
 * `forget()` removes an entry WITHOUT writing a frame, and it is the only place
 * in this file that is allowed to. It exists for `serverRequest/resolved`: the
 * server telling us it has settled its own request (auto-resolution, an
 * interrupted turn, a withdrawn ask). Replying after that notification is
 * exactly the second failure above — a response to nothing — so here the write
 * is the bug and the silence is correct.
 *
 * Note which half of the invariant still holds: the entry is still removed
 * exactly once, and nobody is left waiting on us, because the party that was
 * waiting has just announced it stopped.
 *
 * ## Scope of the key
 *
 * Keyed by `idKey(requestId)` alone, i.e. this table is PER CONNECTION — server
 * request ids are unique within one app-server connection, not globally. A
 * second connection needs a second table, never a shared one keyed by
 * `sessionId + id`.
 */

/** `absent -> pending -> settled`. There is no intermediate "replying" state. */
export type PendingKind =
  | 'question'
  | 'approval_exec'
  | 'approval_file_change'
  | 'approval_permissions'
  | 'elicitation';

/**
 * Reused verbatim from the permission vocabulary (`runtimeEvents.ts:282`) — C10
 * says the pending table must not invent a second word list for "why this was
 * settled without a human answer", because renderer copy is already keyed off
 * these four words.
 */
export type PendingAutoReason = PermissionAutoReason;

/**
 * `answered` carries whatever the bridge decided, INCLUDING a user-initiated
 * cancel: cancelling is a real answer with a clean-cancel body, not an auto
 * reason. The exact cancel body per kind belongs to slice 3/4; this file only
 * provides the channel.
 */
export type PendingOutcome =
  | { reason: 'answered'; result: unknown }
  | { reason: PendingAutoReason };

/**
 * Every way an entry can leave the table, as seen by `onSettled`.
 *
 * `'forgotten'` is deliberately NOT a member of `PendingAutoReason`: that type
 * is the shared `PermissionAutoReason` from the protocol, and "the server
 * resolved its own request" is a Host-internal fact with no renderer copy
 * behind it. Widening a protocol enum for it would put a word on the wire that
 * no card can render.
 */
export type PendingSettleReason = PendingOutcome['reason'] | 'forgotten';

/**
 * Server request methods we are allowed to register, and nothing else.
 *
 * Evidence per entry:
 *   item/tool/requestUserInput          [实测] fixtures/codex/codex-question-requests.jsonl (id 0, 1)
 *   item/commandExecution/requestApproval [实测] fixtures/codex/codex-command-approval.jsonl (id 0)
 *   item/fileChange/requestApproval     [实测] fixtures/codex/codex-filechange-approval-turn.jsonl
 *   item/permissions/requestApproval    [契约] S2 U4 — no frame exists; S2-a proved `request_permissions`
 *                                       cannot even register in the local tool table, so it is
 *                                       unreachable on this machine. It is listed ON PURPOSE
 *                                       (arbitration doc §2.2 C-f): slice 4 must be able to settle it
 *                                       `unsupported` + fail-safe deny. "Not implemented" must never
 *                                       mean "no JSON-RPC response".
 *
 * The MCP elicitation name was deliberately blank through slice 2a — neither the
 * fixtures nor the design doc spelled it, and a guess would silently never match
 * (elicitation would fall through to `method_not_found`). It is now read off the
 * generated contract (`fixtures/codex/codex-method-contract.json`, one of the 10
 * server→client requests), so it is evidence rather than a guess. Every key here
 * is pinned against that snapshot by `codexWireContract.test.ts`.
 */
export const SERVER_REQUEST_KINDS: Readonly<Record<string, PendingKind>> = {
  'item/tool/requestUserInput': 'question',
  'item/commandExecution/requestApproval': 'approval_exec',
  'item/fileChange/requestApproval': 'approval_file_change',
  'item/permissions/requestApproval': 'approval_permissions',
  'mcpServer/elicitation/request': 'elicitation',
};

/**
 * `null` = we do not know this method, so DO NOT register it: the caller replies
 * `replyError(id, JSONRPC_METHOD_NOT_FOUND, ...)`.
 *
 * Why an error rather than a permissive `{}`: an empty object fails the server's
 * schema for every approval kind, and even where it parses it risks being read
 * as "no opinion" — the one reading that could be mistaken for consent. An error
 * response is unambiguous and still ends the request, so the turn cannot hang.
 * [推测] — we have never observed how this server reacts to an error response to
 * one of its own requests; the reasoning is from the JSON-RPC contract, not from
 * a frame. Do not upgrade this note without a real observation.
 *
 * An own-property check rather than a bare lookup: `SERVER_REQUEST_KINDS['toString']`
 * would otherwise return an inherited function and a truthy result would let a
 * garbage method register as a real kind.
 */
export function kindOfServerMethod(method: string): PendingKind | null {
  if (!Object.hasOwn(SERVER_REQUEST_KINDS, method)) return null;
  return SERVER_REQUEST_KINDS[method] ?? null;
}

export interface PendingServerRequest {
  readonly requestId: JsonRpcId;
  /** OUR session id, not `threadId`: the drain filter is per our session. */
  readonly sessionId: string;
  readonly kind: PendingKind;
  /** The wire method, kept verbatim for logs and for slice 3/4 dispatch. */
  readonly method: string;
  /** Untouched wire params. This table never inspects them. */
  readonly params: unknown;
  /** Our id for the emitted question/permission card, so the settle can be projected back. */
  readonly correlationId: string;
  readonly createdAt: number;
}

export type PendingReplyFactory = (
  entry: PendingServerRequest,
  reason: PendingAutoReason
) => unknown;

/**
 * Auto-reply bodies. EVERY row is a refusal; none of them can be read as
 * "allowed". A table drain happens exactly when nobody is left to decide
 * (session closed, turn aborted, kind unsupported, request timed out), and in
 * that situation the only safe answer is the one that grants nothing.
 *
 *   kind                       session_closed / aborted   unsupported / timed_out
 *   question                   {answers:{}}               {answers:{}}
 *   approval_exec              {decision:'cancel'}        {decision:'decline'}
 *   approval_file_change       {decision:'cancel'}        {decision:'decline'}
 *   approval_permissions       {permissions:{}, scope:'turn'}   (same)
 *   elicitation                {action:'decline'}              (same)
 *
 * Evidence:
 *  - `{answers:{}}` is the clean cancel [实测: it is the shape slice 3 sends for
 *    `cancel:true`]. Note this is the OPPOSITE of the Claude bridge, which
 *    refuses empty answer payloads as a guard — C15 ruled that guard must not be
 *    copied here, because on this wire an empty answers map IS the cancel.
 *  - `cancel` and `decline` are both accepted by the server [实测]: `cancel`
 *    appears in a real `availableDecisions`, and `decline` — which does NOT
 *    appear in it — was sent by the probe and accepted, the turn continuing
 *    normally (fixtures/codex/codex-command-approval.jsonl).
 *  - The `approval_permissions` and `elicitation` bodies are [读码 契约] only:
 *    unreachable on this machine, never observed. They are fail-safe by shape
 *    (an empty permission grant, an explicit decline), so being wrong about the
 *    field names degrades to a schema error, never to a silent grant.
 *
 * Why the reason split: `cancel` abandons the pending action along with the turn
 * that owned it, which is what `session_closed` / `aborted` mean. `unsupported`
 * and `timed_out` leave the turn alive, so the narrower `decline` (refuse this
 * one action, let the model continue) is the honest answer. The placement of
 * `timed_out` is [推测] — the design table names only the other three reasons,
 * and we have no timeout sample; it is grouped with `unsupported` because both
 * describe a live turn we simply cannot answer for.
 */
export const DEFAULT_PENDING_REPLIES: PendingReplyFactory = (entry, reason) =>
  defaultReplyFor(entry.kind, reason);

/**
 * The refusal body for one kind, without needing a table entry.
 *
 * Two call sites answer a server request that was never registered (no turn is
 * running; the request carried no usable question), and both must send the same
 * refusal a drain would have sent. Sharing the lookup keeps that from becoming
 * a second, hand-written `{answers:{}}` that drifts away from this table.
 */
export function defaultReplyFor(kind: PendingKind, reason: PendingAutoReason): unknown {
  const turnIsGone = reason === 'session_closed' || reason === 'aborted';
  switch (kind) {
    case 'question':
      return { answers: {} };
    case 'approval_exec':
    case 'approval_file_change':
      return { decision: turnIsGone ? 'cancel' : 'decline' };
    case 'approval_permissions':
      return { permissions: {}, scope: 'turn' };
    case 'elicitation':
      return { action: 'decline' };
    default: {
      // Exhaustiveness: adding a PendingKind without a refusal body fails tsc
      // here rather than shipping a kind that can be registered but not settled.
      const unreachable: never = kind;
      throw new Error(`no default reply for pending kind ${String(unreachable)}`);
    }
  }
}

/**
 * How many recently settled ids to remember, purely so `forget()` can tell
 * "the routine echo of an id we just answered" from "a resolution for an id we
 * never had". Small on purpose: a server request id space that has moved 32
 * requests past ours is not a case any log line is going to rescue.
 */
export const RECENT_SETTLED_MEMORY = 32;

export interface PendingTableOptions {
  /** Writes exactly one JSON-RPC result frame. Injected, so this module stays pure of IO. */
  reply: (id: JsonRpcId, result: unknown) => void;
  /** Override for tests / future kinds. Defaults to `DEFAULT_PENDING_REPLIES`. */
  fallback?: PendingReplyFactory;
  /** Never receives payload contents — ids, methods and reasons only (T-35). */
  log?: (msg: string) => void;
  /** Observer for the runtime to project `question.resolved` / `permission.resolved`. */
  onSettled?: (entry: PendingServerRequest, reason: PendingSettleReason) => void;
}

export class PendingServerRequestTable {
  private readonly entries = new Map<string, PendingServerRequest>();
  private readonly options: PendingTableOptions;
  /** Ids that left the table recently, newest last. See `RECENT_SETTLED_MEMORY`. */
  private readonly recentlySettled: string[] = [];

  constructor(options: PendingTableOptions) {
    this.options = options;
  }

  private note(msg: string): void {
    this.options.log?.(msg);
  }

  /**
   * `reply` and `onSettled` are caller-supplied; a throw from either must not
   * abort a drain halfway, which would leave the remaining requests registered
   * AND unanswered — the exact hang this table prevents. Logged loudly instead.
   */
  private guard(what: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      this.note(
        `codex pending: ${what} threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * `false` = a request with this id is already pending; the existing entry is
   * kept and NO frame is written.
   */
  register(entry: PendingServerRequest): boolean {
    const key = idKey(entry.requestId);
    if (this.entries.has(key)) {
      // Overwriting would orphan the first request (never answered → hang), and
      // replying here would answer a request the server may still be waiting on
      // under different params. Log and let the caller decide; in practice this
      // means the server reused an id, which is a protocol violation on its side.
      this.note(
        `codex pending: duplicate server request id ${key} (${entry.method}), keeping first`
      );
      return false;
    }
    this.entries.set(key, entry);
    return true;
  }

  get(requestId: JsonRpcId): PendingServerRequest | undefined {
    return this.entries.get(idKey(requestId));
  }

  has(requestId: JsonRpcId): boolean {
    return this.entries.has(idKey(requestId));
  }

  /**
   * Answer one pending request: write exactly one frame, remove the entry,
   * notify. `false` = nothing was pending under this id, and in particular NO
   * second frame was written.
   *
   * The entry is removed BEFORE the frame is written so that a reentrant
   * `settle()` (e.g. triggered synchronously from `reply`) finds nothing and
   * returns false instead of writing a duplicate. Removal and write are one
   * step from every caller's point of view: there is no path that removes
   * without attempting the write.
   */
  settle(requestId: JsonRpcId, outcome: PendingOutcome): boolean {
    const key = idKey(requestId);
    const entry = this.entries.get(key);
    if (!entry) {
      this.note(`codex pending: settle for unknown id ${key} (${outcome.reason}), ignored`);
      return false;
    }
    this.entries.delete(key);
    this.remember(key);

    const result =
      outcome.reason === 'answered'
        ? outcome.result
        : (this.options.fallback ?? DEFAULT_PENDING_REPLIES)(entry, outcome.reason);

    this.guard('reply', () => this.options.reply(entry.requestId, result));
    this.guard('onSettled', () => this.options.onSettled?.(entry, outcome.reason));
    return true;
  }

  private remember(key: string): void {
    this.recentlySettled.push(key);
    if (this.recentlySettled.length > RECENT_SETTLED_MEMORY) this.recentlySettled.shift();
  }

  /**
   * Drop an entry because the SERVER settled its own request
   * (`serverRequest/resolved`). Removes without replying — see the module
   * header's "ONE exception".
   *
   * Returns the entry when one was pending, `undefined` otherwise. The
   * `undefined` case is the common one and is NOT an error: every request we
   * answer ourselves is followed by this notification, and `settle()` has
   * already removed the entry by then. Distinguishing the three ways to miss
   * is what `recentlySettled` is for — collapsing them into one silent return
   * would hide "the server resolved an id we never registered", which is a
   * real defect wearing the same clothes as the routine echo.
   */
  forget(requestId: JsonRpcId): PendingServerRequest | undefined {
    const key = idKey(requestId);
    const entry = this.entries.get(key);
    if (!entry) {
      if (this.recentlySettled.includes(key)) {
        this.note(`codex pending: serverRequest/resolved echo for settled id ${key}`);
      } else {
        this.note(`WARN codex pending: serverRequest/resolved for unknown id ${key}`);
      }
      return undefined;
    }
    this.entries.delete(key);
    this.remember(key);
    this.note(`codex pending: ${entry.method} id ${key} resolved by the server, forgotten`);
    this.guard('onSettled', () => this.options.onSettled?.(entry, 'forgotten'));
    return entry;
  }

  /**
   * Settle every entry matching the filter with an auto reply. Returns the
   * entries that were drained, in registration order.
   *
   * `{}` (no `sessionId`) drains everything — used on connection death, which is
   * the same failure family as a missed close: the process is gone but the cards
   * are still on screen waiting (arbitration doc §2.3 O-d).
   *
   * The snapshot is taken before settling because `settle` mutates the map.
   */
  drain(filter: { sessionId?: string }, reason: PendingAutoReason): PendingServerRequest[] {
    const targets: PendingServerRequest[] = [];
    for (const entry of this.entries.values()) {
      if (filter.sessionId !== undefined && entry.sessionId !== filter.sessionId) continue;
      targets.push(entry);
    }
    for (const entry of targets) {
      this.settle(entry.requestId, { reason });
    }
    return targets;
  }

  get size(): number {
    return this.entries.size;
  }

  sizeFor(sessionId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId) count += 1;
    }
    return count;
  }

  /** Snapshot, not a live view: callers must not be able to mutate the table through it. */
  list(): readonly PendingServerRequest[] {
    return Array.from(this.entries.values());
  }
}
