/**
 * N1 (2026-09-24 point-check A6) — `/compact` while a turn runs was refused by
 * Main and nothing on screen said so; the command sat in the input box.
 *
 * The outcome logic is executed here. The composer's side (toast per outcome,
 * the draft kept on every outcome but success) is a `.tsx`-local closure this
 * node suite cannot render, so it is pinned by source scan below, the posture
 * `composerStopStatic.test.ts` documents.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DSH_COMPACT_CANCELLED_KEY,
  DSH_COMPACT_FAILED_REASON_KEY,
  DSH_COMPACT_NO_SUMMARY_KEY,
  DSH_COMPACT_TIMEOUT_KEY,
} from '@shared/dshHistory/types';
import { englishTranslate, zhTranslations } from '@shared/i18n';
import {
  WORKER_COMPACT_CANCELLED,
  WORKER_COMPACT_INSTRUCTIONS_TOO_LONG,
  WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED,
} from '@shared/types/workerRpc';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPACT_CANCELLED,
  COMPACT_INSTRUCTIONS_TOO_LONG,
  COMPACT_INSTRUCTIONS_UNSUPPORTED,
  COMPACT_INTERRUPTED_TEXT,
  type CompactCommandOutcome,
  compactInstructionsIgnoredToast,
  compactionSummaryOf,
  compactOutcomeSettle,
  compactOutcomeToast,
  runCompactCommand,
} from '../compactCommand';

const COMPOSER_SOURCE = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ChatComposer.tsx'),
  'utf8'
);

/** Verbatim shape of the point-check's main.log line, as the renderer receives it. */
const WHILE_ACTIVE =
  "Error invoking remote method 'chat:compactSession': WorkerManagerError: Session session-1790255048446-z82ivrc cannot compact the conversation while active";

describe('runCompactCommand', () => {
  it('[CC-01] answers a running turn itself and never asks Main', async () => {
    const compact = vi.fn(async () => ({ compacted: true }));
    await expect(runCompactCommand({ turnRunning: true, compact })).resolves.toEqual({
      kind: 'turn-running',
    });
    expect(compact).not.toHaveBeenCalled();
  });

  it('[CC-02] a refusal from Main comes back as its own sentence, wrapper removed', async () => {
    const compact = vi.fn(async () => {
      throw new Error(WHILE_ACTIVE);
    });
    // Decision 180: the row's note, worded as the history words DSH's sentence.
    await expect(runCompactCommand({ turnRunning: false, compact })).resolves.toEqual({
      kind: 'failed',
      note: {
        key: DSH_COMPACT_FAILED_REASON_KEY,
        params: {
          reason:
            'Session session-1790255048446-z82ivrc cannot compact the conversation while active',
        },
      },
      detail: 'Session session-1790255048446-z82ivrc cannot compact the conversation while active',
    });
  });

  it('[CC-02b] decision 176: Main’s busy refusal, now with its code, is the turn-running outcome', async () => {
    const compact = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'chat:compactSession': Error: session_busy: Session s1 cannot compact the conversation while active"
      );
    });
    await expect(runCompactCommand({ turnRunning: false, compact })).resolves.toEqual({
      kind: 'turn-running',
    });
  });

  it('[CC-08] an engine that cannot add instructions is its own outcome, not a failure sentence', async () => {
    // dsh-rebase decision 179: the fail-safe of `/compact keep X` — the
    // engine's compaction hook is not what the bridge extends.
    const compact = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'chat:compactSession': WorkerSlotError: WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED: this engine cannot add instructions to /compact (the compaction service has no summary hook); nothing was compacted"
      );
    });
    await expect(runCompactCommand({ turnRunning: false, compact })).resolves.toEqual({
      kind: 'instructions-unsupported',
    });
    // The renderer spells the codes itself; they must stay the worker's.
    expect(COMPACT_INSTRUCTIONS_UNSUPPORTED).toBe(WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED);
    expect(COMPACT_INSTRUCTIONS_TOO_LONG).toBe(WORKER_COMPACT_INSTRUCTIONS_TOO_LONG);
  });

  it('[CC-179-01] too long, as the engine says it: its own outcome, with the limit', async () => {
    const compact = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'chat:compactSession': WorkerSlotError: WORKER_COMPACT_INSTRUCTIONS_TOO_LONG: /compact instructions are 2001 characters, more than the 2000 taken; nothing was compacted"
      );
    });
    await expect(runCompactCommand({ turnRunning: false, compact })).resolves.toEqual({
      kind: 'instructions-too-long',
      max: 2000,
    });
  });

  it('[CC-179-02] compacted without the instructions given: said, on top of the success', async () => {
    const ignored = await runCompactCommand({
      turnRunning: false,
      compact: async () => ({ compacted: true, instructionsApplied: false }),
    });
    expect(ignored).toEqual({ kind: 'compacted', instructionsIgnored: true });
    expect(compactInstructionsIgnoredToast(ignored, englishTranslate)).toEqual({
      type: 'info',
      title: 'Compacted without your instructions',
      description: 'This engine version did not pass them to the summary.',
    });
    // Applied, or none given: nothing more to say.
    for (const value of [{ compacted: true, instructionsApplied: true }, { compacted: true }]) {
      const outcome = await runCompactCommand({ turnRunning: false, compact: async () => value });
      expect(outcome).toEqual({ kind: 'compacted' });
      expect(compactInstructionsIgnoredToast(outcome, englishTranslate)).toBeNull();
    }
  });

  it('[CC-179-03] the instruction toasts, in words and translated', () => {
    expect(compactOutcomeToast({ kind: 'instructions-unsupported' }, englishTranslate)).toEqual({
      type: 'info',
      title: 'This engine version cannot add instructions to /compact',
      description: 'Remove the text after /compact, then press Enter again.',
    });
    expect(
      compactOutcomeToast(
        { kind: 'instructions-too-long', max: 2000, length: 2105 },
        englishTranslate
      )
    ).toEqual({
      type: 'info',
      title: 'The instructions after /compact are too long',
      description: 'Keep them to 2000 characters (now 2105).',
    });
    expect(
      compactOutcomeToast({ kind: 'instructions-too-long', max: 2000 }, englishTranslate)
        ?.description
    ).toBe('Keep them to 2000 characters.');
    for (const key of [
      'This engine version cannot add instructions to /compact',
      'The instructions after /compact are too long',
      'Keep them to {{max}} characters (now {{length}}).',
      'Keep them to {{max}} characters.',
      'Compacted without your instructions',
      'This engine version did not pass them to the summary.',
      'Compact the context of this conversation; instructions may follow',
      'Instructions for this summary: {{instructions}}',
    ]) {
      expect(zhTranslations[key], key).toBeTruthy();
    }
    // Decision 176's starting-phase refusal is gone with the queue (decision 179).
    expect(zhTranslations['Wait for the conversation to start']).toBeUndefined();
    expect(zhTranslations['/compact takes no instructions']).toBeUndefined();
  });

  it('[CC-03] success is success', async () => {
    const compact = vi.fn(async () => ({ compacted: true }));
    await expect(runCompactCommand({ turnRunning: false, compact })).resolves.toEqual({
      kind: 'compacted',
    });
    expect(compact).toHaveBeenCalledTimes(1);
  });
});

/**
 * dsh-rebase P1-7e (problem 10, decision 140): the worker hands back the
 * context-summary row the compaction wrote, and the outcome carries it.
 */
describe('runCompactCommand — the summary row', () => {
  const row = {
    id: 'h:c1',
    role: 'system',
    blocks: [{ type: 'text', id: 'h:c1:summary:0', text: 'Context summary\n\n- x' }],
  };

  it('[CC-09] success carries the row the worker read back', async () => {
    const compact = vi.fn(async () => ({ compacted: true, summary: row }));
    await expect(runCompactCommand({ turnRunning: false, compact })).resolves.toEqual({
      kind: 'compacted',
      summary: row,
    });
  });

  it('[CC-10] anything that is not a history row is no row: an older worker, a malformed one', () => {
    for (const result of [
      undefined,
      null,
      { compacted: true },
      { compacted: true, summary: null },
      { compacted: true, summary: 'h:c1' },
      { compacted: true, summary: { ...row, id: 'c1' } },
      { compacted: true, summary: { ...row, blocks: undefined } },
    ]) {
      expect(compactionSummaryOf(result), JSON.stringify(result)).toBeUndefined();
    }
    expect(compactionSummaryOf({ compacted: true, summary: row })).toBe(row);
  });
});

describe('the composer reports every outcome and keeps the command (source scan)', () => {
  const compactCase = COMPOSER_SOURCE.slice(
    COMPOSER_SOURCE.indexOf("case 'compact': {"),
    COMPOSER_SOURCE.indexOf("updateValue('');\n    setSlashQuery(null);")
  );

  it('[CC-04] goes through runCompactCommand, with the composer’s own running state', () => {
    expect(compactCase).toContain('runCompactCommand({');
    expect(compactCase).toMatch(/const turnRunning = canStop \|\| stoppingRef\.current/);
    // A running turn is answered before anything shows in the timeline.
    expect(compactCase.indexOf('if (turnRunning) {')).toBeLessThan(
      compactCase.indexOf('nextCompactRunId()')
    );
  });

  it('[CC-05] a /compact that never ran: a toast, no rows, its line back in the box (decision 180)', () => {
    // Decision 180: the box is cleared when it starts, as for a message, and
    // the timeline shows it; one that never ran leaves no row and a toast.
    expect(compactCase).toContain("if (valueRef.current.trim() === trimmed) updateValue('');");
    expect(compactCase).toContain('const settle = compactOutcomeSettle(outcome);');
    expect(compactCase).toContain("settleCompactRun(sessionId, runId, { kind: 'remove' });");
    expect(compactCase).toContain('restoreCommand(typedIn, trimmed);');
    expect(compactCase).toContain('const toast = compactOutcomeToast(outcome, t);');
    // A second `/compact` while one runs, instructions too long (decision
    // 179), a running turn, and the end of the run itself.
    expect(compactCase).toContain("t('This conversation is already being compacted')");
    expect(compactCase.match(/return true;/g)?.length).toBe(4);
  });

  it('[CC-179-04] instructions are read as plain text; too long is said before anything is sent', () => {
    const tooLong = compactCase.indexOf("if (instructions.kind === 'too-long') {");
    expect(compactCase).toContain(
      'const instructions = readCompactInstructions(action.instructions);'
    );
    expect(tooLong).toBeGreaterThan(-1);
    expect(tooLong).toBeLessThan(compactCase.indexOf('runCompactCommand({'));
    expect(compactCase).toContain(
      "...(instructions.kind === 'ok' ? { instructions: instructions.text } : {}),"
    );
    expect(compactCase).toContain('compactInstructionsIgnoredToast(outcome, t)');
  });

  it('[CC-06] /archive no longer clears the command when the archive was refused', () => {
    const archiveCase = COMPOSER_SOURCE.slice(
      COMPOSER_SOURCE.indexOf("case 'archive': {"),
      COMPOSER_SOURCE.indexOf("case 'compact': {")
    );
    expect(archiveCase).toContain('if (!(await archiveSessionIndexEntry(');
    expect(archiveCase).toContain("t('Could not archive this conversation')");
  });

  it('[CC-11] success shows the summary row, or says so in a toast when there is none', () => {
    expect(compactCase).toContain(
      "settleCompactRun(sessionId, runId, { kind: 'summary', summary: settle.summary })"
    );
    expect(compactCase).toContain("t('Conversation compacted')");
  });

  it('[CC-07] the new copy is translated', () => {
    for (const key of [
      'Wait for this turn to finish before compacting',
      '/compact stays in the input box — press Enter again once the turn ends.',
      'Could not compact the conversation',
      'Could not archive this conversation',
      'Remove the text after /compact, then press Enter again.',
      'Conversation compacted',
      'The summary shows as "Context summary" when this chat is reopened.',
    ]) {
      expect(zhTranslations[key]).toBeTruthy();
    }
  });
});

/**
 * dsh-rebase decision 176: a conversation the engine is not running is started
 * the way a send does first (`whenRunning`), every outcome is said in words,
 * and a second `/compact` while one runs is its own outcome.
 */
describe('runCompactCommand — a conversation the engine is not running (decision 176)', () => {
  const failing = (text: string) => async () => {
    throw new Error(`Error invoking remote method 'chat:compactSession': ${text}`);
  };

  it('[CC-176-01] each refusal is read off its code', async () => {
    const cases: Array<[string, CompactCommandOutcome]> = [
      [
        'Error: compact_in_progress: Session s1 is already being compacted',
        { kind: 'already-compacting' },
      ],
      [
        'WorkerSlotError: WORKER_SESSION_BUSY: Cannot compact the conversation while a turn is active',
        { kind: 'turn-running' },
      ],
      [
        'Error: session_not_found: Session s1 is not running on the DSH host',
        { kind: 'stopped-running' },
      ],
      [
        'Error: worker_compact_interrupted: The compaction of s1 got no answer: its engine session ended first (WORKER_SLOT_DISPOSING)',
        { kind: 'interrupted' },
      ],
      [
        'WorkerSlotError: WORKER_COMPACT_UNAVAILABLE: No compactable history yet.',
        { kind: 'nothing-to-compact' },
      ],
    ];
    for (const [text, outcome] of cases) {
      await expect(
        runCompactCommand({ turnRunning: false, compact: failing(text) }),
        text
      ).resolves.toEqual(outcome);
    }
  });

  it('[CC-176-02] the engine’s known failures in words; any other is its sentence without the code', async () => {
    const timeout = await runCompactCommand({
      turnRunning: false,
      compact: failing(
        'WorkerSlotError: WORKER_COMPACT_TIMEOUT: summarizing the conversation took longer than 45000ms; it was cancelled'
      ),
    });
    expect(timeout).toMatchObject({ kind: 'failed', note: { key: DSH_COMPACT_TIMEOUT_KEY } });
    const noSummary = await runCompactCommand({
      turnRunning: false,
      compact: failing(
        'WorkerSlotError: WORKER_COMPACT_FAILED: Compaction could not produce a useful summary. The attempt is recorded in the session log.'
      ),
    });
    expect(noSummary).toMatchObject({ kind: 'failed', note: { key: DSH_COMPACT_NO_SUMMARY_KEY } });
    const other = await runCompactCommand({
      turnRunning: false,
      compact: failing(
        'WorkerSlotError: WORKER_COMPACT_FAILED: Compaction finished, but the session could not be saved.'
      ),
    });
    expect(other).toEqual({
      kind: 'failed',
      note: {
        key: DSH_COMPACT_FAILED_REASON_KEY,
        params: { reason: 'Compaction finished, but the session could not be saved.' },
      },
      detail: 'WORKER_COMPACT_FAILED: Compaction finished, but the session could not be saved.',
    });
  });

  it('[CC-176-03] a start that did not happen is its own outcome; nothing is compacted', async () => {
    const compact = vi.fn(async () => ({ compacted: true }));
    await expect(
      runCompactCommand({
        turnRunning: false,
        compact,
        whenRunning: async () => ({
          kind: 'not-started',
          start: { kind: 'failed', code: 'session_cwd_mismatch' },
        }),
      })
    ).resolves.toEqual({
      kind: 'not-started',
      start: { kind: 'failed', code: 'session_cwd_mismatch' },
    });
    // A turn running (Main said so on the start), and a chat that never ran.
    await expect(
      runCompactCommand({
        turnRunning: false,
        compact,
        whenRunning: async () => ({
          kind: 'not-started',
          start: { kind: 'refused', reason: 'busy' },
        }),
      })
    ).resolves.toEqual({ kind: 'turn-running' });
    await expect(
      runCompactCommand({
        turnRunning: false,
        compact,
        whenRunning: async () => ({
          kind: 'not-started',
          start: { kind: 'refused', reason: 'no-transcript' },
        }),
      })
    ).resolves.toEqual({ kind: 'nothing-to-compact' });
    // Ended while it was being started.
    await expect(
      runCompactCommand({
        turnRunning: false,
        compact,
        whenRunning: async () => ({ kind: 'cancelled' }),
      })
    ).resolves.toEqual({ kind: 'stopped-running' });
    // Decision 180: not asked for at all, because Esc or Stop came first.
    await expect(
      runCompactCommand({
        turnRunning: false,
        compact,
        whenRunning: async () => ({ kind: 'cancelled', cancelRequested: true }),
      })
    ).resolves.toEqual({ kind: 'cancelled' });
    expect(compact).not.toHaveBeenCalled();
  });

  it('[CC-176-04] started, then compacted: the summary row comes back as before', async () => {
    const row = { id: 'h:c1', role: 'system', blocks: [] };
    await expect(
      runCompactCommand({
        turnRunning: false,
        compact: async () => ({ compacted: true, summary: row }),
        whenRunning: async (operation) => ({
          kind: 'done',
          value: await operation(),
          started: true,
        }),
      })
    ).resolves.toEqual({ kind: 'compacted', summary: row });
  });

  it('[CC-176-05] every outcome but success is a toast in words: no code, no internal name, translated', () => {
    const outcomes: CompactCommandOutcome[] = [
      { kind: 'turn-running' },
      { kind: 'instructions-unsupported' },
      { kind: 'already-compacting' },
      { kind: 'nothing-to-compact' },
      { kind: 'not-started', start: { kind: 'failed', code: 'session_cwd_mismatch' } },
      { kind: 'not-started', start: { kind: 'failed', code: 'legacy_migration_failed' } },
      { kind: 'not-started', start: { kind: 'refused', reason: 'restarting' } },
      { kind: 'not-started', start: { kind: 'refused', reason: 'no-workspace' } },
      { kind: 'stopped-running' },
    ];
    expect(compactOutcomeToast({ kind: 'compacted' }, englishTranslate)).toBeNull();
    // Decision 180: one that ran says how it ended in its row, not in a toast.
    for (const ran of [
      { kind: 'interrupted' },
      { kind: 'cancelled' },
      { kind: 'failed', note: { key: DSH_COMPACT_TIMEOUT_KEY }, detail: 'x' },
    ] as CompactCommandOutcome[]) {
      expect(compactOutcomeToast(ran, englishTranslate), ran.kind).toBeNull();
    }
    for (const outcome of outcomes) {
      const toast = compactOutcomeToast(outcome, englishTranslate);
      expect(toast, outcome.kind).not.toBeNull();
      const text = `${toast?.title} ${toast?.description ?? ''}`;
      expect(text, outcome.kind).not.toMatch(/[A-Za-z]+_[a-z_]+|[A-Z]+_[A-Z_]+|WorkerSlot|Pi /);
      for (const key of [toast?.title, toast?.description].filter(Boolean) as string[]) {
        expect(zhTranslations[key], key).toBeTruthy();
      }
    }
  });

  it('[CC-176-06] the bridge’s compaction codes are the ones spelled here', () => {
    const bridge = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../dsh-host/bridge/commands.ts'
      ),
      'utf8'
    );
    for (const code of [
      'WORKER_COMPACT_TIMEOUT',
      'WORKER_COMPACT_UNAVAILABLE',
      'WORKER_COMPACT_FAILED',
    ]) {
      expect(bridge).toContain(`export const ${code} = '${code}';`);
    }
    // DSH's sentence for "nothing to compact" (dsh-command-compact).
    expect(bridge).toContain("'There is nothing to compact yet'");
  });
});

/**
 * dsh-rebase decision 180: Esc or Stop cuts a `/compact` short, and how a
 * `/compact` ended is said in its row in the timeline; only one that never
 * ran is a toast.
 */
describe('runCompactCommand — cancelled, and said in the timeline (decision 180)', () => {
  it('[CC-180-01] the worker’s cancel is its own outcome, under the code spelled here', async () => {
    expect(COMPACT_CANCELLED).toBe(WORKER_COMPACT_CANCELLED);
    await expect(
      runCompactCommand({
        turnRunning: false,
        compact: async () => {
          throw new Error(
            "Error invoking remote method 'chat:compactSession': WorkerSlotError: WORKER_COMPACT_CANCELLED: the compaction was cancelled before its summary was written; nothing was compacted"
          );
        },
      })
    ).resolves.toEqual({ kind: 'cancelled' });
  });

  it('[CC-180-02] what the row does: the summary, a note, or nothing at all', () => {
    const row = { id: 'h:c1', role: 'system', blocks: [] } as never;
    expect(compactOutcomeSettle({ kind: 'compacted', summary: row })).toEqual({
      kind: 'summary',
      summary: row,
    });
    expect(compactOutcomeSettle({ kind: 'compacted' })).toEqual({ kind: 'summary' });
    expect(compactOutcomeSettle({ kind: 'cancelled' })).toEqual({
      kind: 'note',
      note: { key: DSH_COMPACT_CANCELLED_KEY },
    });
    expect(compactOutcomeSettle({ kind: 'interrupted' })).toEqual({
      kind: 'note',
      note: { key: COMPACT_INTERRUPTED_TEXT },
    });
    expect(
      compactOutcomeSettle({ kind: 'failed', note: { key: DSH_COMPACT_TIMEOUT_KEY }, detail: 'x' })
    ).toEqual({ kind: 'note', note: { key: DSH_COMPACT_TIMEOUT_KEY } });
    for (const never of [
      { kind: 'turn-running' },
      { kind: 'instructions-unsupported' },
      { kind: 'instructions-too-long', max: 2000 },
      { kind: 'already-compacting' },
      { kind: 'nothing-to-compact' },
      { kind: 'stopped-running' },
      { kind: 'not-started', start: { kind: 'refused', reason: 'restarting' } },
    ] as CompactCommandOutcome[]) {
      expect(compactOutcomeSettle(never), never.kind).toEqual({ kind: 'remove' });
    }
    for (const key of [
      DSH_COMPACT_CANCELLED_KEY,
      DSH_COMPACT_TIMEOUT_KEY,
      DSH_COMPACT_NO_SUMMARY_KEY,
      DSH_COMPACT_FAILED_REASON_KEY,
      COMPACT_INTERRUPTED_TEXT,
      'Esc to cancel',
      'Cancelling…',
      'Cancel the compaction',
      'Compacting the context… {{seconds}}s',
      'Compacting the context… {{minutes}}m {{seconds}}s',
    ]) {
      expect(zhTranslations[key], key).toBeTruthy();
    }
  });
});
