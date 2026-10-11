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
import { englishTranslate, zhTranslations } from '@shared/i18n';
import { WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED } from '@shared/types/workerRpc';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPACT_INSTRUCTIONS_UNSUPPORTED,
  type CompactCommandOutcome,
  compactionSummaryOf,
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
    await expect(runCompactCommand({ turnRunning: false, compact })).resolves.toEqual({
      kind: 'failed',
      reason: 'Session session-1790255048446-z82ivrc cannot compact the conversation while active',
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

  it('[CC-08] the DSH engine refusing instructions is its own outcome, not a failure sentence', async () => {
    // dsh-rebase decision 113: `/compact keep X` reaches the worker as
    // instructions, which DSH's /compact does not take.
    const compact = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'chat:compactSession': WorkerSlotError: WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED: /compact takes no instructions on the DSH engine; nothing was compacted"
      );
    });
    await expect(runCompactCommand({ turnRunning: false, compact })).resolves.toEqual({
      kind: 'instructions-unsupported',
    });
    // The renderer spells the code itself; it must stay the worker's.
    expect(COMPACT_INSTRUCTIONS_UNSUPPORTED).toBe(WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED);
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
    expect(compactCase).toMatch(/turnRunning: canStop \|\| stoppingRef\.current/);
  });

  it('[CC-05] toasts every refusal and returns before the input box is cleared', () => {
    // Decision 176: one table says every outcome in words (`compactOutcomeToast`).
    expect(compactCase).toContain("if (outcome.kind !== 'compacted') {");
    expect(compactCase).toContain('const toast = compactOutcomeToast(outcome, t);');
    // A second `/compact` while one runs, and every refusal: consumed, but the
    // draft survives.
    expect(compactCase).toContain("t('This conversation is already being compacted')");
    expect(compactCase.match(/return true;/g)?.length).toBe(2);
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
    expect(compactCase).toContain('showCompactionSummary(sessionId, outcome.summary)');
    expect(compactCase).toContain("t('Conversation compacted')");
  });

  it('[CC-07] the new copy is translated', () => {
    for (const key of [
      'Wait for this turn to finish before compacting',
      '/compact stays in the input box — press Enter again once the turn ends.',
      'Could not compact the conversation',
      'Could not archive this conversation',
      '/compact takes no instructions',
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
    expect(timeout).toMatchObject({
      kind: 'failed',
      key: 'Summarizing took too long, so the compaction was cancelled. Nothing was compacted.',
    });
    const noSummary = await runCompactCommand({
      turnRunning: false,
      compact: failing(
        'WorkerSlotError: WORKER_COMPACT_FAILED: Compaction could not produce a useful summary. The attempt is recorded in the session log.'
      ),
    });
    expect(noSummary).toMatchObject({
      kind: 'failed',
      key: 'No useful summary could be written, so nothing was compacted. The attempt is recorded in the session log.',
    });
    const other = await runCompactCommand({
      turnRunning: false,
      compact: failing(
        'WorkerSlotError: WORKER_COMPACT_FAILED: Compaction finished, but the session could not be saved.'
      ),
    });
    expect(other).toEqual({
      kind: 'failed',
      reason: 'Compaction finished, but the session could not be saved.',
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
      { kind: 'interrupted' },
      {
        kind: 'failed',
        key: 'Summarizing took too long, so the compaction was cancelled. Nothing was compacted.',
        reason: 'x',
        detail: 'x',
      },
    ];
    expect(compactOutcomeToast({ kind: 'compacted' }, englishTranslate)).toBeNull();
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
