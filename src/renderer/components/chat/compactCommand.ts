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
 */

import type { Translate } from '@shared/i18n';
import type { HistoryMessage } from '@shared/types/sessionHistory';
import { unwrapIpcErrorMessage } from '@/lib/ipcError';
import {
  isSessionNotRunningError,
  type SessionStartFailure,
  type StartedOperationResult,
  sessionStartFailureKey,
} from './sessionStart';

/**
 * dsh-rebase P1-4d2 (decision 113): the worker's refusal of `/compact <text>`
 * — DSH's `/compact` takes no instructions. Spelled here rather than imported,
 * as `SessionTreeDialog` spells its own worker code: the renderer imports only
 * types from `workerRpc`. `compactCommand.test.ts` pins it to the worker's.
 */
export const COMPACT_INSTRUCTIONS_UNSUPPORTED = 'WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED';

/**
 * Decision 176: the bridge's other `worker.compact` codes (`commands.ts`) and
 * Main's, spelled here for the same reason; `compactCommand.test.ts` pins the
 * bridge's to its own.
 */
export const COMPACT_TIMEOUT = 'WORKER_COMPACT_TIMEOUT';
export const COMPACT_UNAVAILABLE = 'WORKER_COMPACT_UNAVAILABLE';
export const COMPACT_FAILED = 'WORKER_COMPACT_FAILED';

/** The status line while it runs (decision 176); dictionary keys. */
export const COMPACTING_LINE = 'Compacting the context…';

export type CompactCommandOutcome =
  /**
   * dsh-rebase P1-7e (problem 10, decision 140): with the summary row the
   * worker read back, when it could — the caller shows it right away.
   */
  | { kind: 'compacted'; summary?: HistoryMessage }
  /** A turn is running; nothing was sent to Main (or Main and the engine said so). */
  | { kind: 'turn-running' }
  /** The engine takes `/compact` alone; nothing ran, and the typed text is still there. */
  | { kind: 'instructions-unsupported' }
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
  /**
   * Main or the engine refused for any other reason. `key` is a dictionary key
   * for the known ones; otherwise `reason` is the engine's sentence with the
   * code taken off. `detail` is the whole text, for the log.
   */
  | { kind: 'failed'; key?: string; reason: string; detail: string };

/** Dictionary keys for the failures said in words (decision 176). */
export const COMPACT_TIMEOUT_TEXT =
  'Summarizing took too long, so the compaction was cancelled. Nothing was compacted.';
export const COMPACT_NO_SUMMARY_TEXT =
  'No useful summary could be written, so nothing was compacted. The attempt is recorded in the session log.';
export const COMPACT_INTERRUPTED_TEXT =
  'The conversation stopped running while it was being compacted (it was ended, or the engine restarted). Reopen it to see whether the summary was written.';
export const COMPACT_STOPPED_TEXT =
  'The conversation stopped running before compaction began, so nothing was compacted.';

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
  if (has(reason, 'compact_in_progress')) return { kind: 'already-compacting' };
  // Main's guard (`assertIdleEntry`) and the bridge's (`assertIdle`): a turn,
  // or a goal round the engine started by itself.
  if (has(reason, 'session_busy') || has(reason, 'WORKER_SESSION_BUSY')) {
    return { kind: 'turn-running' };
  }
  if (isSessionNotRunningError(error)) return { kind: 'stopped-running' };
  if (has(reason, 'worker_compact_interrupted')) return { kind: 'interrupted' };
  if (has(reason, COMPACT_TIMEOUT)) {
    return { kind: 'failed', key: COMPACT_TIMEOUT_TEXT, reason, detail: reason };
  }
  if (
    has(reason, COMPACT_UNAVAILABLE) &&
    /no compactable history|nothing to compact/iu.test(reason)
  ) {
    return { kind: 'nothing-to-compact' };
  }
  if (has(reason, COMPACT_FAILED) && /useful summary/iu.test(reason)) {
    return { kind: 'failed', key: COMPACT_NO_SUMMARY_TEXT, reason, detail: reason };
  }
  return { kind: 'failed', reason: withoutCode(reason), detail: reason };
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
  whenRunning?: (operation: () => Promise<unknown>) => Promise<StartedOperationResult<unknown>>;
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
    if (result.kind === 'cancelled') return { kind: 'stopped-running' };
    const summary = compactionSummaryOf(result.value);
    return summary ? { kind: 'compacted', summary } : { kind: 'compacted' };
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
 * The toast for every outcome but success (which shows the summary row, or
 * says so itself). `null` for success. Every text is in words; a failure's
 * full text is logged by the caller (`detail`).
 */
export function compactOutcomeToast(
  outcome: CompactCommandOutcome,
  t: Translate
): CompactToast | null {
  switch (outcome.kind) {
    case 'compacted':
      return null;
    case 'turn-running':
      return {
        type: 'info',
        title: t('Wait for this turn to finish before compacting'),
        description: t('/compact stays in the input box — press Enter again once the turn ends.'),
      };
    // dsh-rebase decision 113: DSH's /compact takes no instructions; the typed
    // text stays so the user can remove it and press Enter again.
    case 'instructions-unsupported':
      return {
        type: 'info',
        title: t('/compact takes no instructions'),
        description: t('Remove the text after /compact, then press Enter again.'),
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
    case 'interrupted':
      return {
        type: 'error',
        title: t('Could not compact the conversation'),
        description: t(COMPACT_INTERRUPTED_TEXT),
      };
    case 'failed':
      return {
        type: 'error',
        title: t('Could not compact the conversation'),
        description: outcome.key ? t(outcome.key) : outcome.reason,
      };
  }
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
