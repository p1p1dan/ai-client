/**
 * `/compact` as the composer runs it locally — and what happens when it cannot.
 *
 * 2026-09-24 point-check A6/N1: typing `/compact` while a turn ran went to Main,
 * Main refused (`cannot compact the conversation while active` — compaction
 * aborts the running turn in pi, so the guard is right), the rejection escaped
 * `handleSend` as an unhandled promise, and the screen showed nothing at all
 * with `/compact ` still sitting in the input box.
 *
 * Two fixes, one module so both are testable without mounting the composer:
 *
 *  - a turn that is visibly running is answered HERE, before any IPC: the
 *    outcome is known, and asking Main only to be told no was the silent path;
 *  - any other refusal (a race with the turn's own end, no ready worker, a
 *    summary request that failed) comes back as a reason the caller shows.
 *
 * The caller keeps the typed command in the input box on every outcome except
 * success, so the user can press Enter again once the turn ends — including any
 * instructions typed after `/compact`, which clearing would have thrown away.
 *
 * dsh-rebase decision 176: a conversation the engine is not running (reopened
 * after a restart, reclaimed when idle, let go by an engine rebuild) is started
 * the way a send starts it first (`sessionStart.ts`); the composer's status
 * line says 「正在启动对话…」 for that, then 「正在压缩上下文…」. Every outcome
 * is said in words (`compactOutcomeToast`): Main's and the engine's codes go to
 * the log, not on screen.
 *
 * dsh-rebase decision 179: `/compact <instructions>` passes the instructions
 * on; ones longer than the engine takes are refused here, before anything is
 * sent, and the engine's own refusals (too long, or an engine whose
 * compaction cannot carry them) are said in words too.
 *
 * dsh-rebase decision 180: a `/compact` that ran shows in the timeline — its
 * command line, then its row — and its outcome is said there
 * (`compactOutcomeSettle`): the summary, or a note why there is none
 * (cancelled, past its time limit, no useful summary, DSH's own reason). Only
 * a `/compact` that never ran (refused, nothing to compact, the conversation
 * could not be started) is said in a toast, with its line back in the box.
 */

import { COMPACT_INSTRUCTIONS_MAX_CHARS } from '@shared/compactInstructions';
import {
  DSH_COMPACT_CANCELLED_KEY,
  DSH_COMPACT_NO_SUMMARY_KEY,
  DSH_COMPACT_TIMEOUT_KEY,
  type DshCompactNote,
  dshCompactNote,
} from '@shared/dshHistory/types';
import type { Translate } from '@shared/i18n';
import type { HistoryMessage } from '@shared/types/sessionHistory';
import type { ChatCompactCancelled } from '@shared/types/workerRpc';
import { unwrapIpcErrorMessage } from '@/lib/ipcError';
import {
  isSessionNotRunningError,
  type SessionStartFailure,
  type StartedOperationResult,
  sessionStartFailureKey,
} from './sessionStart';

/**
 * dsh-rebase decision 179: the worker's refusals of `/compact <text>` — an
 * engine whose compaction cannot carry instructions (a DSH upgrade changed
 * what the bridge extends), and instructions longer than taken. Spelled here
 * rather than imported, as `SessionTreeDialog` spells its own worker code: the
 * renderer imports only types from `workerRpc`. `compactCommand.test.ts` pins
 * them to the worker's.
 */
export const COMPACT_INSTRUCTIONS_UNSUPPORTED = 'WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED';
export const COMPACT_INSTRUCTIONS_TOO_LONG = 'WORKER_COMPACT_INSTRUCTIONS_TOO_LONG';

/**
 * Decision 176: the bridge's other `worker.compact` codes (`commands.ts`) and
 * Main's, spelled here for the same reason; `compactCommand.test.ts` pins the
 * bridge's to its own.
 */
export const COMPACT_TIMEOUT = 'WORKER_COMPACT_TIMEOUT';
export const COMPACT_UNAVAILABLE = 'WORKER_COMPACT_UNAVAILABLE';
export const COMPACT_FAILED = 'WORKER_COMPACT_FAILED';
/** Decision 180: Esc or Stop cut it short before its summary was written. */
export const COMPACT_CANCELLED = 'WORKER_COMPACT_CANCELLED';

/** The running row while it compacts (decisions 176, 180); dictionary keys. */
export const COMPACTING_LINE = 'Compacting the context…';

export type CompactCommandOutcome =
  /**
   * dsh-rebase P1-7e (problem 10, decision 140): with the summary row the
   * worker read back, when it could — the caller shows it right away.
   */
  | {
      kind: 'compacted';
      summary?: HistoryMessage;
      /**
       * Decision 179: instructions were given and the summary was written
       * without them (`WorkerCompactResult.instructionsApplied: false`).
       */
      instructionsIgnored?: true;
    }
  /** A turn is running; nothing was sent to Main (or Main and the engine said so). */
  | { kind: 'turn-running' }
  /**
   * Decision 179: this engine's compaction cannot carry instructions; nothing
   * ran, and the typed text is still there.
   */
  | { kind: 'instructions-unsupported' }
  /**
   * Decision 179: longer than taken — found here before anything was sent
   * (`length` known), or by the engine.
   */
  | { kind: 'instructions-too-long'; max: number; length?: number }
  /** Decision 176: one is with the worker already (this window's, or another's). */
  | { kind: 'already-compacting' }
  /** Decision 176: the conversation could not be started for it. */
  | { kind: 'not-started'; start: SessionStartFailure }
  /**
   * Decision 176: the conversation stopped running before the compaction
   * reached it — ended while it was being started, or let go again — so
   * nothing was compacted.
   */
  | { kind: 'stopped-running' }
  /**
   * Decision 176: it stopped running while the worker summarized (ended, or the
   * engine restarted): no answer came, so whether the summary was written is
   * not known.
   */
  | { kind: 'interrupted' }
  /** The engine had nothing to compact (DSH's "No compactable history yet."). */
  | { kind: 'nothing-to-compact' }
  /** Decision 180: Esc or Stop cut it short; nothing was compacted. */
  | { kind: 'cancelled' }
  /**
   * Main or the engine refused for any other reason. `note` is what the row
   * says (the history's note for the same outcome, `dshCompactNote`).
   * `detail` is the whole text, for the log.
   */
  | { kind: 'failed'; note: DshCompactNote; detail: string };

/**
 * Dictionary keys for the failures said in words (decision 176); since
 * decision 180 the notes the row and the history share.
 */
export const COMPACT_TIMEOUT_TEXT = DSH_COMPACT_TIMEOUT_KEY;
export const COMPACT_NO_SUMMARY_TEXT = DSH_COMPACT_NO_SUMMARY_KEY;
export const COMPACT_INTERRUPTED_TEXT =
  'The conversation stopped running while it was being compacted (it was ended, or the engine restarted). Reopen it to see whether the summary was written.';
export const COMPACT_STOPPED_TEXT =
  'The conversation stopped running before compaction began, so nothing was compacted.';

/**
 * DA-4 (decision 180, 2026-10-11 acceptance): Main's answer to a `/compact`
 * the user cancelled. Spelled here, as the codes above are: the renderer
 * imports only types from `workerRpc`.
 */
function isCompactCancelledAnswer(value: unknown): value is ChatCompactCancelled {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { cancelled?: unknown }).cancelled === true &&
    (value as { compacted?: unknown }).compacted === false
  );
}

function has(text: string, code: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_])${code}(?![A-Za-z0-9_])`).test(text);
}

/**
 * The engine's sentence without the codes it was given on the way
 * (`WORKER_COMPACT_FAILED: `, `worker_compact_failed: `): an all-caps or a
 * snake_case word with an underscore in it, so a sentence's own `Usage: ` stays.
 */
function withoutCode(text: string): string {
  const stripped = text
    .replace(/^(?:(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+): )+/u, '')
    .trim();
  return stripped || text;
}

/** What a refusal means, read off its text (the codes are all that crosses IPC). */
export function classifyCompactFailure(error: unknown): CompactCommandOutcome {
  const reason = unwrapIpcErrorMessage(error);
  if (reason.includes(COMPACT_INSTRUCTIONS_UNSUPPORTED)) {
    return { kind: 'instructions-unsupported' };
  }
  if (has(reason, COMPACT_INSTRUCTIONS_TOO_LONG)) {
    return { kind: 'instructions-too-long', max: COMPACT_INSTRUCTIONS_MAX_CHARS };
  }
  if (has(reason, 'compact_in_progress')) return { kind: 'already-compacting' };
  // Main's guard (`assertIdleEntry`) and the bridge's (`assertIdle`): a turn,
  // or a goal round the engine started by itself.
  if (has(reason, 'session_busy') || has(reason, 'WORKER_SESSION_BUSY')) {
    return { kind: 'turn-running' };
  }
  if (isSessionNotRunningError(error)) return { kind: 'stopped-running' };
  if (has(reason, 'worker_compact_interrupted')) return { kind: 'interrupted' };
  if (has(reason, COMPACT_CANCELLED)) return { kind: 'cancelled' };
  if (has(reason, COMPACT_TIMEOUT)) {
    return { kind: 'failed', note: { key: COMPACT_TIMEOUT_TEXT }, detail: reason };
  }
  if (
    has(reason, COMPACT_UNAVAILABLE) &&
    /no compactable history|nothing to compact/iu.test(reason)
  ) {
    return { kind: 'nothing-to-compact' };
  }
  // DSH's sentence, worded as the history words the same `command/done`.
  return { kind: 'failed', note: dshCompactNote(withoutCode(reason)), detail: reason };
}

/**
 * Decision 180: what the timeline does with the run's rows. `summary` and
 * `note`: it ran, and its row says how it ended (where the bridge has not
 * said so already). `remove`: it never ran — refused, nothing to compact, the
 * conversation could not be started — and a toast says why instead.
 */
export type CompactOutcomeSettle =
  | { kind: 'summary'; summary?: HistoryMessage }
  | { kind: 'note'; note: DshCompactNote }
  | { kind: 'remove' };

export function compactOutcomeSettle(outcome: CompactCommandOutcome): CompactOutcomeSettle {
  switch (outcome.kind) {
    case 'compacted':
      return { kind: 'summary', ...(outcome.summary ? { summary: outcome.summary } : {}) };
    case 'cancelled':
      return { kind: 'note', note: { key: DSH_COMPACT_CANCELLED_KEY } };
    case 'interrupted':
      return { kind: 'note', note: { key: COMPACT_INTERRUPTED_TEXT } };
    case 'failed':
      return { kind: 'note', note: outcome.note };
    default:
      return { kind: 'remove' };
  }
}

export async function runCompactCommand(input: {
  /** A turn is running or stopping in this session, as the composer sees it. */
  turnRunning: boolean;
  compact: () => Promise<unknown>;
  /**
   * Decision 176: run `compact` once the engine runs the conversation,
   * starting it the way a send does first (`runWithSessionStarted`). Absent:
   * `compact` is asked as it is.
   */
  whenRunning?: (
    operation: () => Promise<unknown>
  ) => Promise<StartedOperationResult<unknown> & { cancelRequested?: true }>;
}): Promise<CompactCommandOutcome> {
  if (input.turnRunning) return { kind: 'turn-running' };
  try {
    const result = input.whenRunning
      ? await input.whenRunning(input.compact)
      : { kind: 'done' as const, value: await input.compact() };
    if (result.kind === 'not-started') {
      if (result.start.kind === 'refused' && result.start.reason === 'busy') {
        return { kind: 'turn-running' };
      }
      if (result.start.kind === 'refused' && result.start.reason === 'no-transcript') {
        return { kind: 'nothing-to-compact' };
      }
      return { kind: 'not-started', start: result.start };
    }
    // Decision 180: not asked for at all, because Esc or Stop came first.
    if (result.kind === 'cancelled') {
      return 'cancelRequested' in result && result.cancelRequested
        ? { kind: 'cancelled' }
        : { kind: 'stopped-running' };
    }
    // DA-4: Main answers a cancel rather than rejecting (a rejection is still read below).
    if (isCompactCancelledAnswer(result.value)) return { kind: 'cancelled' };
    const summary = compactionSummaryOf(result.value);
    return {
      kind: 'compacted',
      ...(summary ? { summary } : {}),
      ...(instructionsIgnored(result.value) ? { instructionsIgnored: true as const } : {}),
    };
  } catch (error) {
    return classifyCompactFailure(error);
  }
}

export interface CompactToast {
  type: 'info' | 'error';
  title: string;
  description?: string;
}

/**
 * The toast for a `/compact` that never ran. `null` for one that ran: its row
 * in the timeline says how it ended (decision 180). Every text is in words; a
 * failure's full text is logged by the caller (`detail`).
 */
export function compactOutcomeToast(
  outcome: CompactCommandOutcome,
  t: Translate
): CompactToast | null {
  switch (outcome.kind) {
    case 'compacted':
    case 'cancelled':
    case 'interrupted':
    case 'failed':
      return null;
    case 'turn-running':
      return {
        type: 'info',
        title: t('Wait for this turn to finish before compacting'),
        description: t('/compact stays in the input box — press Enter again once the turn ends.'),
      };
    // Decision 179: an engine whose compaction cannot carry instructions; the
    // typed text stays so the user can remove it and press Enter again.
    case 'instructions-unsupported':
      return {
        type: 'info',
        title: t('This engine version cannot add instructions to /compact'),
        description: t('Remove the text after /compact, then press Enter again.'),
      };
    case 'instructions-too-long':
      return {
        type: 'info',
        title: t('The instructions after /compact are too long'),
        description:
          outcome.length !== undefined
            ? t('Keep them to {{max}} characters (now {{length}}).', {
                max: outcome.max,
                length: outcome.length,
              })
            : t('Keep them to {{max}} characters.', { max: outcome.max }),
      };
    case 'already-compacting':
      return { type: 'info', title: t('This conversation is already being compacted') };
    case 'nothing-to-compact':
      return {
        type: 'info',
        title: t('Nothing to compact yet'),
        description: t('This conversation has no earlier history that compaction could shorten.'),
      };
    case 'not-started':
      return {
        type: 'error',
        title: t('Could not compact the conversation'),
        description: t(sessionStartFailureKey(outcome.start)),
      };
    case 'stopped-running':
      return {
        type: 'error',
        title: t('Could not compact the conversation'),
        description: t(COMPACT_STOPPED_TEXT),
      };
  }
}

/**
 * Decision 179: the toast of a compaction whose summary was written without
 * the instructions given (`instructionsIgnored`); `null` otherwise.
 */
export function compactInstructionsIgnoredToast(
  outcome: CompactCommandOutcome,
  t: Translate
): CompactToast | null {
  if (outcome.kind !== 'compacted' || !outcome.instructionsIgnored) return null;
  return {
    type: 'info',
    title: t('Compacted without your instructions'),
    description: t('This engine version did not pass them to the summary.'),
  };
}

/** Decision 179: `WorkerCompactResult.instructionsApplied` is `false`. */
function instructionsIgnored(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { instructionsApplied?: unknown }).instructionsApplied === false
  );
}

/**
 * The summary row a `worker.compact` answer carries (`WorkerCompactResult.summary`),
 * read defensively: an older worker sends none, and anything that is not a
 * history row with an `h:` id and blocks is no row at all.
 */
export function compactionSummaryOf(result: unknown): HistoryMessage | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const summary = (result as { summary?: unknown }).summary;
  if (typeof summary !== 'object' || summary === null) return undefined;
  const row = summary as Partial<HistoryMessage>;
  return typeof row.id === 'string' && row.id.startsWith('h:') && Array.isArray(row.blocks)
    ? (summary as HistoryMessage)
    : undefined;
}
