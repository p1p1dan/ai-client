import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

/**
 * U26 (D13) and U27 — two layout facts from the 2026-09-06 point-check that
 * have no pure function to test them.
 *
 * Both are the same kind of bug: a rule written when the shell was arranged
 * differently, still enforced after the arrangement changed. U03-a's `!isTui`
 * meant "give the terminal the width" until D08 made the right column the only
 * place files open, at which point it meant "you cannot read a file right now".
 * The rail running full height was fine until every other column grew an `h-9`
 * bar it did not share.
 *
 * dsh-rebase P1-11 (decision 127) removed the pi TUI and the GUI / TUI switch,
 * so the TUI-only half of U26 (chat kept visible under a fullscreen diff while
 * the terminal lived in the chat column) went with it. What stays is the rule
 * that the editor column is allocated whenever a file or the review is open.
 */
const SHELL_DIR = join(process.cwd(), 'src/renderer/components/workspace-shell');
const code = (file: string) => stripComments(readFileSync(file, 'utf8'), file);

describe('U26 (D13) the editor column is allocated whenever a file is open', () => {
  it('nothing suppresses the editor column', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    expect(shell).toContain('const editorAllocated = editorOpen || reviewOpen;');
    expect(shell).not.toContain('isTui');
    expect(shell).not.toContain('{!isTui && (editorOpen || fileIntentPending) && (');
  });

  it('the chat column gets the whole row when no file is open', () => {
    // `editorOpen` is keyed off `tabs.length`, so no file means no editor column.
    const model = code(join(SHELL_DIR, 'centerLayoutModel.ts'));
    expect(model).toContain('export function deriveEditorOpen(openTabCount: number)');
    expect(model).toMatch(/deriveEditorOpen[\s\S]{0,120}openTabCount > 0/);
  });

  it('chat visibility and the fullscreen-diff hide come from the shell chrome alone', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    expect(shell).toContain('const chatVisible = chrome.chatVisible;');
    expect(shell).toContain('diffTabActive: !reviewOpen && diffTabActive,');
  });
});

describe('U27 the rail starts below the title row', () => {
  it('opens with a title-row-height spacer instead of running to the top edge', () => {
    const dock = code(join(SHELL_DIR, 'LeftDock.tsx'));
    expect(dock).toContain('<div aria-hidden className="h-9 shrink-0" />');
    // The spacer replaces the old top padding rather than adding to it: 4px of
    // `pt-1` under a 36px spacer is 4px of misalignment, which is the whole
    // thing this was meant to fix.
    expect(dock).not.toContain('bg-card pt-1 pb-2');
  });

  it('tracks the same h-9 the panel title row uses', () => {
    // If `DockTitle` ever stops being h-9 these two must move together, and
    // reading them from one token is what makes that visible.
    const dock = code(join(SHELL_DIR, 'LeftDock.tsx'));
    expect(dock).toContain('<div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">');
  });
});
