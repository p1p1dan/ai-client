/**
 * N6 (2026-09-24 point-check B3) — a refused checkout read
 * 「切换分支失败: Error invoki…」: Electron's IPC wrapper filled the one-line
 * chip and git's own sentence only existed in the hover tooltip.
 *
 * `BranchColumn.tsx` cannot render in this node suite (react-query hooks, the
 * switcher popover), so the wiring is pinned by source scan and the text the
 * chip will hold is computed with the same helper and the real zh catalog.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import { unwrapIpcErrorMessage } from '@/lib/ipcError';

const SOURCE = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../BranchColumn.tsx'),
  'utf8'
);

const B3_REJECTION = new Error(
  "Error invoking remote method 'git:branch:checkout': Error: error: Your local changes to the following files would be overwritten by checkout:\n\tshared.txt\nPlease commit your changes or stash them before you switch branches.\nAborting"
);

describe('BranchColumn shows what git said', () => {
  it('[BC-01] both failure paths unwrap the IPC error before prefixing it', () => {
    const lineWith = (key: string) => SOURCE.split('\n').find((line) => line.includes(key));
    expect(lineWith("t('Failed to switch branch')")).toContain('unwrapIpcErrorMessage(cause)');
    expect(lineWith("t('Failed to create branch')")).toContain('unwrapIpcErrorMessage(cause)');
    expect(SOURCE).not.toContain('cause.message');
  });

  it('[BC-02] the chip starts with git’s sentence, not the wrapper', () => {
    const chip = `${zhTranslations['Failed to switch branch']}: ${unwrapIpcErrorMessage(B3_REJECTION)}`;
    expect(chip.startsWith('切换分支失败: error: Your local changes')).toBe(true);
    expect(chip).not.toContain('Error invoking remote method');
  });

  it('[BC-03] one truncated line of up to max-w-80, the full text wrapped in the tooltip', () => {
    expect(SOURCE).toContain('inline-flex min-w-0 max-w-80 items-center text-ui text-destructive');
    expect(SOURCE).toContain('<span className="truncate">{error}</span>');
    expect(SOURCE).toContain(
      '<TooltipPopup className="max-w-80 whitespace-pre-wrap break-words">{error}</TooltipPopup>'
    );
  });
});
