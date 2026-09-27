import type { Translate } from '@shared/i18n';
import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import type { HistoryReadErrorCode } from '@shared/types/sessionHistory';
import { isModelMissingError, MODEL_MISSING_ERROR_VIEW } from './modelMissingError';
import { isSessionBusy } from './sessionIndex/resumeIntent';

/**
 * View model for the non-fatal per-session history read error (C-06 / T-03).
 *
 * The store keeps `historyErrors[sessionId]` as a flat `${code}: ${message}`
 * string (chatSessions.ts — red-line file, not ours to change). Parsing, copy
 * selection and the "error vs genuinely empty" decision live here as pure
 * functions: the repo's vitest environment is `node` and only collects `.ts`,
 * so anything left inside a `.tsx` cannot be asserted.
 */

/**
 * Contract codes, plus a forward-compatible fallback and one code this app
 * derives itself. `model_missing` is not a history-read outcome the Host
 * reports — resume simply never got far enough to read anything — but it
 * arrives through the same failed-resume channel and needs its own copy, so it
 * rides here rather than in a second parallel notice (see `modelMissingError`).
 */
export type HistoryErrorCode =
  | HistoryReadErrorCode
  | 'unknown'
  | 'model_missing'
  | 'session_locked'
  | 'session_too_large'
  | 'legacy_session_readonly'
  | 'engine_unavailable';

/**
 * ah-lib-03 — what a failed resume can carry, and which card each one gets.
 *
 * This used to be four `WORKER_SESSION_*` strings searched for in the message
 * text, and three of them stopped having a producer when the runtime took over
 * opening sessions: it throws its own lowercase codes, or lets Node's `ENOENT`
 * through untouched. Every one of them therefore landed on the `read_failed`
 * fallback, whose copy promises the chat is fine and offers a Retry — about a
 * session whose worker never started — while `session_file_corrupt` and
 * `session_cwd_mismatch`, written for exactly these failures, became
 * unreachable branches.
 *
 * A plain table rather than a chain of ternaries so the next code is one line:
 * both halves (this map and `CODE_COPY`) are keyed, and `toCode` derives from
 * `CODE_COPY` rather than restating it.
 */
const RESUME_ERROR_CODES: Readonly<Record<string, HistoryErrorCode>> = {
  // `src/runtime/plugins/session/` — the session store's own vocabulary. Note
  // `session_cwd_mismatch` is spelled identically on both sides; that is a
  // coincidence worth keeping, not a rule the table relies on.
  session_cwd_mismatch: 'session_cwd_mismatch',
  session_invalid: 'session_file_corrupt',
  // concurrency-02: another process holds this session's writer lock. Landing
  // on `read_failed` offered a Retry that can only fail the same way, and hid
  // the one thing that resolves it — the forced takeover.
  session_locked: 'session_locked',
  session_size_limit: 'session_too_large',
  // The file is gone: `JsonlSessionStore.open` lets a missing path through
  // `realpath` and the read throws Node's own error, with no code of ours on it.
  ENOENT: 'jsonl_not_found',
  // Main's own index lookup (`src/main/ipc/chat.ts`), for a row whose session
  // file was never recorded.
  pi_session_not_found: 'jsonl_not_found',
  // The only `WORKER_*` code left with a producer (`PiWorkerProcess.ts`,
  // `DshHostProcess.ts`).
  WORKER_WORKSPACE_MISSING: 'workspace_missing',
  // dsh-rebase P1-1. The DSH bridge found neither its identity stub nor the
  // session log it names: the same dead-session card as a missing JSONL.
  dsh_session_missing: 'jsonl_not_found',
  // dsh-rebase decision 005: Main refuses to resume a chat the previous engine
  // wrote. Spelled the same on both sides, like `session_locked`.
  legacy_session_readonly: 'legacy_session_readonly',
  // dsh-rebase P1-3c (decision 020 rule 6): the shared DSH engine could not be
  // brought up for this open. Main's code for it (`WorkerManager.ts`).
  dsh_host_unavailable: 'engine_unavailable',
};

/**
 * `\b` on both ends so `session_invalid_signature` is not read as
 * `session_invalid`: underscore is a word character, so the boundary only
 * matches where the code really ends.
 */
const RESUME_ERROR_PATTERNS: ReadonlyArray<readonly [RegExp, HistoryErrorCode]> = Object.entries(
  RESUME_ERROR_CODES
).map(([wire, code]) => [new RegExp(`\\b${wire}\\b`), code] as const);

/**
 * The code the error object CARRIES, when it carries one.
 *
 * Preferred over reading the message, because it is exact: `WorkerSlotError`
 * keeps `remoteError.code` and a Node errno error has `code` too, whereas the
 * message is somebody else's sentence with our code pasted on the front.
 */
function carriedCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function encodePiResumeError(error: unknown): {
  code: HistoryErrorCode;
  message: string;
  encoded: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const carried = carriedCode(error);
  const byField = carried ? RESUME_ERROR_CODES[carried] : undefined;
  const byText = RESUME_ERROR_PATTERNS.find(([pattern]) => pattern.test(message))?.[1];
  const code =
    byField ??
    byText ??
    // Checked after the session codes (they are disjoint) and before the
    // fallback, which would otherwise call this a failed history read — it is
    // not, and the fix is nowhere near retrying.
    (isModelMissingError(message) ? 'model_missing' : 'read_failed');
  return { code, message, encoded: `${code}: ${message}` };
}

/**
 * dsh-rebase P1-1 (GUI point-check D1) — Main refused the resume because the
 * chat is read-only until it is migrated (decision 005).
 *
 * Not a fault, and every resume call site treats it the same two ways:
 *  - the history card is the whole report. It says, translated, that the chat
 *    can be viewed and how to carry on, and keeps Main's English sentence under
 *    Details; copying that sentence into `lastError` as well put a second, raw
 *    box above the composer;
 *  - a send it cut short was refused by rule, so its payload goes back to the
 *    composer instead of behind a Retry that can only be refused again
 *    (`refusedByRule` in `queueRelease.ts`).
 *
 * Every other code keeps its old route.
 */
export function isReadOnlyResumeRefusal(code: HistoryErrorCode): boolean {
  return code === 'legacy_session_readonly';
}

/**
 * dsh-rebase P1-3c — a failure that is the shared DSH engine being down
 * (Main's `dsh_host_unavailable`), whichever surface it reached: a resume, a
 * create, or a send that fell back to one. The composer's status strip shows
 * {@link ENGINE_UNAVAILABLE_HINT} for it instead of Main's English sentence;
 * the `engine_unavailable` card keeps that sentence under Details.
 */
export function isEngineUnavailableError(message: string | null | undefined): boolean {
  return typeof message === 'string' && /\bdsh_host_unavailable\b/.test(message);
}

/** The status strip's one line for it; a dictionary key. */
export const ENGINE_UNAVAILABLE_HINT =
  'The chat engine is not running. Retry, or send a message: either one starts the engine again.';

export interface HistoryErrorView {
  code: HistoryErrorCode;
  /** Alert variant. Warning = nothing on disk; error = history exists but is unreadable. */
  severity: 'warning' | 'error';
  /** Short English label, matching the timeline's other chrome. */
  title: string;
  /**
   * Explanation — must keep "read failed" distinguishable from "empty". The
   * notice outlives the failed read (it survives new messages), so guidance
   * describes the read attempt, never what the timeline currently shows.
   *
   * A DICTIONARY KEY, like `title`: this module is a plain `.ts` with no
   * translator in scope, so `MessageTimeline` calls `t()` on it.
   */
  guidance: string;
  /** Raw Host message (paths / errno). Empty when the Host sent none. */
  message: string;
  /** Only transient IO failures are worth re-reading. */
  retryable: boolean;
  /**
   * What continuing to use the session actually means for this code. Most
   * codes are non-fatal; `jsonl_not_found` is not (see
   * `HISTORY_ERROR_DEAD_SESSION_HINT`) — a per-code field, rather than one
   * hint shared by every variant, is what keeps that distinction honest (#30).
   */
  continuationHint: string;
  /**
   * H/21 P0: a settings pane that can actually fix this code. Only
   * `model_missing` has one. Every other code is fixed outside the app or not
   * at all, and a settings button there would send the user looking for a
   * control that does not exist.
   */
  recovery?: { settingsCategory: 'pi'; label: string };
  /**
   * concurrency-02 — who the refusal says holds the writer lock.
   *
   * Parsed out of `message`, because that is all there is: `WorkerSlot`
   * flattens the remote error to `<code>: <message>` and Electron's `invoke`
   * keeps only `message` on the way out, so the structured `owner` the runtime
   * threw never reaches this process. Every part is optional — a lock written
   * by an older build carries no timestamp, and a lock file too damaged to
   * parse carries no owner at all.
   */
  lock?: { pid?: number; host?: string; heldFor?: string };
  /**
   * concurrency-02 — the action that resolves this code, when one exists.
   *
   * Kept out of `recovery`, which opens a settings pane: this one re-runs the
   * resume with `forceTakeover`, which is a different kind of button and needs
   * the warning that rides with it. On DSH (P1-3c) Main answers that flag by
   * restarting the shared engine before it opens the chat, so the label is
   * "Restart engine" and the warning is what the restart costs the others.
   */
  forceTakeover?: { label: string; warning: string };
}

/** Shown under most variants: a history read failure never kills the session. */
export const HISTORY_ERROR_NON_FATAL_HINT =
  'The chat is not interrupted; you can keep sending messages.';

/**
 * `jsonl_not_found` only, and only it: once the agent's record is gone, resume
 * has nothing to hand it and the very next send fails, so promising
 * continuation here would be a lie the user discovers mid-message (#30 / D32).
 *
 * The exact failure text is NOT quoted any more (S3 slice 5a): "No conversation
 * found" is the Claude CLI's own wording, and this code now reaches whichever
 * agent lost its record — quoting one agent's error string would send the user
 * looking for a message the other never prints.
 */
export const HISTORY_ERROR_DEAD_SESSION_HINT =
  'This chat cannot continue: with its history gone, the next send will fail. Start a new chat to carry on.';

/**
 * `history_unsupported` only (P2). This build never read anything for the
 * session's agent, so it also never verified that the session is still live:
 * "可以继续发送" would be a promise nothing here checked. States the fallback
 * instead, which holds either way.
 */
export const HISTORY_ERROR_UNSUPPORTED_HINT =
  'Sending may or may not still work; if it fails, start a new chat to carry on.';

type HistoryErrorCopy = Omit<HistoryErrorView, 'code' | 'message'>;

const CODE_COPY: Record<HistoryErrorCode, HistoryErrorCopy> = {
  // The wire code keeps its Claude-era spelling, but its meaning is
  // agent-neutral (`sessionHistory.ts`): nothing on disk for this session,
  // whichever store the agent uses. The copy says that, and names no file
  // format — a Codex row has no JSONL to look for.
  jsonl_not_found: {
    severity: 'error',
    title: 'History not found',
    guidance:
      'No history was found for this chat when resuming it, so no past messages were loaded.',
    retryable: false,
    continuationHint: HISTORY_ERROR_DEAD_SESSION_HINT,
  },
  encrypted_unreadable: {
    severity: 'error',
    title: 'History is encrypted — unreadable here',
    guidance:
      'The history file is encrypted and this process cannot read it as plain text. That does not mean the chat has no history — the record is still on disk, it just cannot be shown here.',
    retryable: false,
    continuationHint: 'Sending may still work; if it fails the same way, start a new chat.',
  },
  read_failed: {
    severity: 'error',
    title: 'Failed to read history',
    guidance:
      'Reading or parsing the history file failed, so the history below may be missing or incomplete.',
    retryable: true,
    continuationHint: HISTORY_ERROR_NON_FATAL_HINT,
  },
  // S2 (d): the session's agent has no history reader in this build. Not a
  // failure — nothing is broken and nothing is lost, so it reads as a warning
  // and offers no retry. Reachable: `toCode()` recognises this code.
  history_unsupported: {
    severity: 'warning',
    title: 'History unavailable for this agent',
    guidance:
      'This build cannot read history for that agent yet, so earlier messages were not loaded. The record is still on disk.',
    retryable: false,
    continuationHint: HISTORY_ERROR_UNSUPPORTED_HINT,
  },
  session_file_corrupt: {
    severity: 'error',
    title: 'Session history is damaged',
    guidance:
      'The Pi session file is not a valid session. The app has not modified or replaced the original file.',
    retryable: false,
    continuationHint: 'Keep the original file for recovery; start a new chat to carry on.',
  },
  session_cwd_mismatch: {
    severity: 'error',
    title: 'Session belongs to another workspace',
    guidance:
      'The Pi session record belongs to a different workspace than this repository, so a silent rebind was refused.',
    retryable: false,
    continuationHint: 'Open it from the workspace it belongs to, or start a new chat.',
  },
  // concurrency-02. Retryable as well as forceable, and both on purpose: the
  // holder may simply be about to let go, in which case a plain Retry is the
  // correct, harmless answer and the takeover is the one to avoid. The card
  // offers the safe button first.
  //
  // dsh-rebase P1-3c: on DSH the lock is a kernel lock nothing can force, and
  // the holder this app can reach is its own shared engine, keeping an agent
  // that never let go (a Stop or a close it could not finish). So the second
  // button restarts the engine — the same host restart as Stop ladder B
  // (decision 021) — which releases every lock the engine holds and then
  // opens the chat. It is always offered rather than only while no other chat
  // runs: the restart interrupts those replies, but they reconnect by
  // themselves, and a button that vanished whenever any chat was busy would
  // leave this one locked with nothing to press. The warning says what it
  // costs.
  session_locked: {
    severity: 'error',
    title: 'Session is locked by another writer',
    guidance:
      "This chat's write lock is still held — usually by a reply in this app's chat engine that never finished stopping — so it was not opened. Nothing on disk was changed.",
    retryable: true,
    continuationHint:
      'Retrying works once the lock is released. Restarting the engine releases any lock the engine itself holds.',
    forceTakeover: {
      label: 'Restart engine',
      warning:
        'Restarting the engine stops the replies running in your other chats; they reconnect by themselves and can be continued. It cannot release a lock held by a program outside this app.',
    },
  },
  // dsh-rebase P1-3c (decision 020 rule 6). The engine went down more often
  // than it may be restarted automatically, or could not start at all.
  // Nothing about this chat is wrong, and a user's retry is exactly what may
  // start the engine again — so, unlike most codes here, it is retryable.
  engine_unavailable: {
    severity: 'error',
    title: 'The chat engine is not running',
    guidance:
      'The engine that runs your chats stopped several times in a short while, or could not start, so it is no longer restarted by itself. Nothing is wrong with this chat.',
    retryable: true,
    continuationHint: 'Retry, or send a message: either one starts the engine again.',
  },
  workspace_missing: {
    severity: 'error',
    title: 'Workspace folder is gone',
    guidance:
      'The working directory this chat is bound to is no longer on disk, so its worker cannot start. The app will not recreate a directory it did not create.',
    retryable: false,
    continuationHint:
      'Restore the directory at its original path and retry, or archive this chat and start a new one.',
  },
  // ah-lib-03. The record is intact and this build simply refuses to load it,
  // so the copy must not say "missing" or "damaged" — both would send the user
  // looking for a problem with the file itself. Not retryable: the file will
  // not have shrunk between one press and the next.
  session_too_large: {
    severity: 'error',
    title: 'Session history is too large to open',
    guidance:
      'This chat’s record is larger than this build will load in one piece, so it was not opened. The file itself is intact and untouched on disk.',
    retryable: false,
    continuationHint: 'Start a new chat to carry on; the original record stays where it is.',
  },
  // dsh-rebase decision 005. Nothing is missing or damaged: chats now run on
  // DSH, and one the previous engine wrote stays viewable until P1-9 migrates
  // it. A warning rather than an error, and nothing a retry could change.
  legacy_session_readonly: {
    severity: 'warning',
    title: 'Read-only until migration',
    guidance:
      'This chat was created with the previous chat engine. Until it is migrated it can be viewed here, but not continued.',
    retryable: false,
    continuationHint: 'Start a new chat to carry on; this one stays as it is.',
  },
  // H/21 P0. Not retryable: the model directory will not have grown between
  // one press and the next, so a Retry button here could only fail again.
  // Copy and action both come from `modelMissingError`, which the session-failed
  // card also reads — one failure, one wording, two surfaces.
  model_missing: {
    severity: 'error',
    title: MODEL_MISSING_ERROR_VIEW.title,
    guidance: MODEL_MISSING_ERROR_VIEW.message,
    retryable: false,
    continuationHint: MODEL_MISSING_ERROR_VIEW.hint,
    recovery: {
      settingsCategory: MODEL_MISSING_ERROR_VIEW.settingsCategory,
      label: MODEL_MISSING_ERROR_VIEW.actionLabel,
    },
  },
  unknown: {
    severity: 'error',
    title: 'Failed to read history',
    guidance:
      'The history read returned an unknown error, so the history below may be missing or incomplete.',
    retryable: true,
    continuationHint: HISTORY_ERROR_NON_FATAL_HINT,
  },
};

/**
 * `CODE_COPY` is the list — a code with a card is a code this module knows, and
 * a second hand-written enumeration is one more place to forget a new one.
 *
 * `Object.hasOwn`, not `in`: `'constructor' in CODE_COPY` is true through the
 * prototype, which would file a nonsense head as a real code and then index
 * `CODE_COPY` with it.
 */
function toCode(value: string): HistoryErrorCode {
  return Object.hasOwn(CODE_COPY, value) ? (value as HistoryErrorCode) : 'unknown';
}

/**
 * concurrency-02 — pull the holder out of the refusal's own sentence.
 *
 * The runtime throws a `SessionLockedError` carrying a structured `owner`, but
 * only its `message` survives the trip: the worker RPC flattens the error and
 * Electron's `invoke` drops every field but the text. So the format built in
 * `writerLock.ts` (`locked()` / `heldFor()`) is a contract, pinned from the
 * other side by `sessionWriterLock.test.ts`.
 *
 * Anchored on `(pid <digits>`, which no session path can accidentally produce,
 * and every tail is optional: a lock written before the timestamp field existed
 * has no age, a same-host lock has no host, and a lock file too damaged to
 * parse has no owner at all — in which case the card simply shows no holder
 * line rather than an invented one.
 */
const SESSION_LOCK_OWNER = /\(pid (\d+)(?: on ([^,()]+))?(?:, held for ([^)]+))?\)/;

export function parseSessionLockOwner(message: string): HistoryErrorView['lock'] | undefined {
  const match = SESSION_LOCK_OWNER.exec(message);
  if (!match) return undefined;
  return {
    pid: Number(match[1]),
    ...(match[2] ? { host: match[2].trim() } : {}),
    ...(match[3] ? { heldFor: match[3].trim() } : {}),
  };
}

/**
 * concurrency-02 — the holder line, already translated.
 *
 * Four whole sentences rather than one with optional slots: a lock with no
 * recorded host or age must not render as "on , for .", and a language that
 * orders those clauses differently needs the sentence to translate, not its
 * fragments. Takes `t` as a parameter for the reason stated at the top of this
 * file — this is a plain `.ts` with no hook in scope, and keeping the choice
 * here is what makes it assertable.
 *
 * Returns null when the refusal named no holder, which is what an unreadable
 * lock file leaves behind; the card then says only that the session is held.
 */
export function describeSessionLockOwner(
  lock: HistoryErrorView['lock'],
  t: Translate
): string | null {
  if (lock?.pid === undefined) return null;
  // The age is the runtime's own wording (`writerLock.ts`'s `heldFor`). `2h5m`
  // passes through `t` unchanged, which is right; only the "no measurable age"
  // phrase is a fixed sentence the dictionary can carry.
  const duration = lock.heldFor === undefined ? undefined : t(lock.heldFor);
  if (lock.host !== undefined && duration !== undefined) {
    return t('Held by process {{pid}} on {{host}}, for {{duration}}.', {
      pid: lock.pid,
      host: lock.host,
      duration,
    });
  }
  if (duration !== undefined) {
    return t('Held by process {{pid}}, for {{duration}}.', { pid: lock.pid, duration });
  }
  if (lock.host !== undefined) {
    return t('Held by process {{pid}} on {{host}}.', { pid: lock.pid, host: lock.host });
  }
  return t('Held by process {{pid}}.', { pid: lock.pid });
}

/** Parse `historyErrors[sessionId]`. Returns null when the session has no error. */
export function parseHistoryError(raw: string | null | undefined): HistoryErrorView | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const separatorIndex = trimmed.indexOf(':');
  const code = toCode(separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex).trim());
  // An unrecognised head is payload, not a prefix — keep the whole string so no
  // information is lost. A bare code (no separator) has no message at all;
  // slicing regardless would eat its first character.
  const message =
    code === 'unknown'
      ? trimmed
      : separatorIndex === -1
        ? ''
        : trimmed.slice(separatorIndex + 1).trim();

  const lock = code === 'session_locked' ? parseSessionLockOwner(message) : undefined;
  return { code, message, ...CODE_COPY[code], ...(lock ? { lock } : {}) };
}

export type TimelineHistoryNotice =
  | { kind: 'none'; error: null }
  | { kind: 'empty'; error: null }
  | { kind: 'error'; error: HistoryErrorView };

export interface TimelineHistoryNoticeInput {
  sessionId: string | null;
  messageCount: number;
  /** Raw `historyErrors[sessionId]`, as returned by selectHistoryError. */
  error: string | undefined;
}

/**
 * Read one session's entry out of the store record.
 *
 * Kept separate so the timeline can subscribe to a plain string instead of the
 * whole record: the store rebuilds `historyErrors` on every `session.history`
 * ingest, so subscribing to the record would re-render this timeline whenever
 * any background session replays its history.
 */
export function selectHistoryError(
  historyErrors: Record<string, string>,
  sessionId: string | null
): string | undefined {
  return sessionId ? historyErrors[sessionId] : undefined;
}

/**
 * Decide what the timeline says about missing history.
 *
 * This is the bug surface T-03 fixes: an empty timeline previously read as
 * "no messages yet" whether the history was absent or unreadable. `error`
 * outranks `empty` and survives new messages — once history failed to load,
 * that stays true for the session.
 */
export function deriveHistoryNotice(input: TimelineHistoryNoticeInput): TimelineHistoryNotice {
  const { sessionId, messageCount } = input;
  if (!sessionId) return { kind: 'none', error: null };

  const error = parseHistoryError(input.error);
  if (error) return { kind: 'error', error };

  return messageCount === 0 ? { kind: 'empty', error: null } : { kind: 'none', error: null };
}

/** Shown when the session is mid-turn, explaining the disabled Retry button. */
export const HISTORY_RETRY_BUSY_HINT =
  'The chat is mid-turn; you can retry reading history once this turn ends.';
/** Shown when a retry resolved without re-reading history (rejected or IPC error). */
export const HISTORY_RETRY_FAILED_HINT =
  'The retry did not take; history still could not be read. You can try again later.';

export interface HistoryRetryControl {
  /** Only transient failures offer a retry at all. */
  visible: boolean;
  disabled: boolean;
  hint: string | null;
  /** Lets the view pick a tone without owning copy decisions. */
  hintKind: 'none' | 'busy' | 'failed';
}

export interface HistoryRetryControlInput {
  retryable: boolean;
  status: SessionRuntimeStatus;
  /** A retry request is in flight. */
  retrying: boolean;
  /** The last retry resolved without re-reading history. */
  failed: boolean;
}

/**
 * Retry button state for the history error notice.
 *
 * Retry is backed by resume, which the Host rejects while a turn is running —
 * so a mid-turn button would be a silent no-op. Disable it instead and say why;
 * a resolved-but-failed retry must also leave a visible trace, otherwise the
 * user cannot tell "refused" from "retried and failed again".
 */
export function deriveRetryControl(input: HistoryRetryControlInput): HistoryRetryControl {
  if (!input.retryable) return { visible: false, disabled: true, hint: null, hintKind: 'none' };

  const busy = isSessionBusy(input.status);
  if (input.failed) {
    return {
      visible: true,
      disabled: input.retrying || busy,
      hint: HISTORY_RETRY_FAILED_HINT,
      hintKind: 'failed',
    };
  }
  return {
    visible: true,
    disabled: input.retrying || busy,
    hint: busy ? HISTORY_RETRY_BUSY_HINT : null,
    hintKind: busy ? 'busy' : 'none',
  };
}

/**
 * concurrency-02 — the takeover's own mid-turn and failed-attempt copy. On DSH
 * the takeover is an engine restart (dsh-rebase P1-3c), so a lock that
 * survives it belongs to something outside the app.
 */
export const HISTORY_TAKEOVER_BUSY_HINT =
  'The chat is mid-turn; you can restart the engine once this turn ends.';
export const HISTORY_TAKEOVER_FAILED_HINT =
  'The engine restarted, but the chat is still locked: a program outside this app may be holding it.';

export interface HistoryTakeoverControlInput {
  /** The code offers a takeover at all — i.e. `view.forceTakeover` exists. */
  available: boolean;
  status: SessionRuntimeStatus;
  /** A takeover request is in flight. */
  taking: boolean;
  /** The last takeover resolved without opening the session. */
  failed: boolean;
}

/**
 * Force-takeover button state, deliberately the same shape as the Retry one.
 *
 * Both buttons are backed by the same resume call, so they share every reason
 * to be disabled: the Host refuses a resume mid-turn, and a request already in
 * flight must not be sent twice. Written as its own function rather than a
 * second call to `deriveRetryControl` because the two are gated on different
 * facts — `retryable` versus "this code has a takeover" — and a resolved-but-
 * failed takeover has to say something a failed re-read never would.
 */
export function deriveTakeoverControl(input: HistoryTakeoverControlInput): HistoryRetryControl {
  if (!input.available) return { visible: false, disabled: true, hint: null, hintKind: 'none' };

  const busy = isSessionBusy(input.status);
  if (input.failed) {
    return {
      visible: true,
      disabled: input.taking || busy,
      hint: HISTORY_TAKEOVER_FAILED_HINT,
      hintKind: 'failed',
    };
  }
  return {
    visible: true,
    disabled: input.taking || busy,
    hint: busy ? HISTORY_TAKEOVER_BUSY_HINT : null,
    hintKind: busy ? 'busy' : 'none',
  };
}
