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
import { zhTranslations } from '@shared/i18n';
import { describe, expect, it, vi } from 'vitest';
import { runCompactCommand } from '../compactCommand';

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
    });
  });

  it('[CC-03] success is success', async () => {
    const compact = vi.fn(async () => ({ compacted: true }));
    await expect(runCompactCommand({ turnRunning: false, compact })).resolves.toEqual({
      kind: 'compacted',
    });
    expect(compact).toHaveBeenCalledTimes(1);
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

  it('[CC-05] toasts both refusals and returns before the input box is cleared', () => {
    expect(compactCase).toContain("outcome.kind === 'turn-running'");
    expect(compactCase).toContain("t('Wait for this turn to finish before compacting')");
    expect(compactCase).toContain("outcome.kind === 'failed'");
    expect(compactCase).toContain("t('Could not compact the conversation')");
    expect(compactCase).toContain('description: outcome.reason');
    // Two early `return true`s: consumed, but the draft survives.
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

  it('[CC-07] the new copy is translated', () => {
    for (const key of [
      'Wait for this turn to finish before compacting',
      '/compact stays in the input box — press Enter again once the turn ends.',
      'Could not compact the conversation',
      'Could not archive this conversation',
    ]) {
      expect(zhTranslations[key]).toBeTruthy();
    }
  });
});
