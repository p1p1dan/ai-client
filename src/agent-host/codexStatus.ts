import type { SessionRuntimeStatus } from '../shared/types/runtimeEvents.ts';

/**
 * Codex `thread/status/changed` -> `session.status` mapper (S2 design C10, rule 3).
 *
 * This notification is the ONLY source in the repo allowed to write a waiting
 * state into `session.status`. The question bridge and the approval bridge must
 * never emit `session.status` at all; keeping the whole mapping here — pure and
 * stateless — is the physical guarantee of that rule: there is exactly one place
 * that can produce `waiting_*`, and it is driven by the server's own snapshot.
 *
 * WIRE SHAPE (17 recorded frames, `__tests__/fixtures/codex/*.jsonl`):
 *   9x `{type:'active', activeFlags:[]}`                      -> running
 *   4x `{type:'active', activeFlags:['waitingOnUserInput']}`  -> waiting_question
 *   2x `{type:'active', activeFlags:['waitingOnApproval']}`   -> waiting_permission
 *   5x `{type:'idle'}`  <- NO `activeFlags` KEY AT ALL        -> idle
 *
 * The idle shape is why `status.type` is branched on BEFORE `activeFlags` is
 * touched: reading `status.activeFlags.includes(...)` first throws a TypeError
 * at the exact moment a turn ends.
 *
 * `idle` maps to `'idle'`, not to "no opinion". Returning `null` there would
 * force a second idle truth source (someone re-deriving it from `turn/completed`),
 * which is the duplication this mapper exists to remove. `null` is reserved for
 * genuinely malformed frames and unknown `status.type` values.
 */

export const CODEX_STATUS_FLAG: {
  readonly question: 'waitingOnUserInput';
  readonly approval: 'waitingOnApproval';
} = {
  question: 'waitingOnUserInput',
  approval: 'waitingOnApproval',
};

export interface CodexStatusReading {
  /** `null` = no opinion: the caller must NOT emit `session.status`. */
  status: SessionRuntimeStatus | null;
  waitingOnQuestion: boolean;
  waitingOnApproval: boolean;
  /**
   * Flags we do not recognise, verbatim and in wire order. Never thrown on,
   * never silently dropped: a new flag is the inevitable product of a codex
   * upgrade, so throwing would hang the turn, while ignoring would leave us
   * permanently unaware that a new state bit exists. The caller logs WARN.
   */
  unknownFlags: readonly string[];
  reason: 'flags' | 'idle' | 'malformed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fresh object per call so callers can never share/mutate a singleton. */
function malformed(): CodexStatusReading {
  return {
    status: null,
    waitingOnQuestion: false,
    waitingOnApproval: false,
    unknownFlags: [],
    reason: 'malformed',
  };
}

/**
 * Map an `active` status's flag list.
 *
 * Both flags at once -> `waiting_permission`. Follows the in-repo precedent
 * `claudeRuntime.ts` `resolveCompensationStatus`, which also checks permission
 * before question; an approval blocks execution and carries destructive
 * consequences, so it is the state worth showing. This mapper is stateless, so
 * it self-corrects: once the approval is answered the server sends another full
 * snapshot and the reading flips to whatever is still pending.
 *
 * (No real frame with both flags exists in the corpus — it is a contract-level
 * ruling, not a measurement.)
 */
export function mapActiveFlags(flags: readonly string[]): Omit<CodexStatusReading, 'reason'> {
  let waitingOnQuestion = false;
  let waitingOnApproval = false;
  const unknownFlags: string[] = [];

  for (const flag of flags) {
    if (flag === CODEX_STATUS_FLAG.approval) waitingOnApproval = true;
    else if (flag === CODEX_STATUS_FLAG.question) waitingOnQuestion = true;
    else unknownFlags.push(flag);
  }

  const status: SessionRuntimeStatus = waitingOnApproval
    ? 'waiting_permission'
    : waitingOnQuestion
      ? 'waiting_question'
      : 'running';

  return { status, waitingOnQuestion, waitingOnApproval, unknownFlags };
}

/**
 * Read a `thread/status/changed` `params` payload.
 *
 * `params` crosses the protocol boundary, so it is accepted as `unknown` and
 * narrowed here rather than trusted as a typed payload.
 */
export function readThreadStatus(params: unknown): CodexStatusReading {
  if (!isRecord(params)) return malformed();

  const status = params.status;
  if (!isRecord(status)) return malformed();

  // Branch on `type` first: `idle` frames carry no `activeFlags` key.
  const type = status.type;
  if (type === 'idle') {
    return {
      status: 'idle',
      waitingOnQuestion: false,
      waitingOnApproval: false,
      unknownFlags: [],
      reason: 'idle',
    };
  }
  if (type !== 'active') return malformed();

  const flags = status.activeFlags;
  // An `active` frame always carried the key in all 14 recorded samples. A
  // missing or non-array `activeFlags` is a shape we have never seen, so we
  // report "no opinion" instead of guessing `running` — guessing could overwrite
  // a live waiting state, while no opinion merely keeps the previous one.
  if (!Array.isArray(flags)) return malformed();
  // Element-level shape check: a non-string entry means the payload is not the
  // `string[]` the protocol describes. Unknown flag *names* are tolerated (they
  // land in `unknownFlags`); a wrong *type* is not guessed at.
  if (!flags.every((flag): flag is string => typeof flag === 'string')) return malformed();

  return { ...mapActiveFlags(flags), reason: 'flags' };
}
