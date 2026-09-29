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
 * that the editor column is allocated whenever a file or the review is open —
 * and, since the P1-11 right-column terminal (decision 128), whenever the
 * folder's terminal is the one showing.
 */
const SHELL_DIR = join(process.cwd(), 'src/renderer/components/workspace-shell');
const code = (file: string) => stripComments(readFileSync(file, 'utf8'), file);

describe('U26 (D13) the editor column is allocated whenever a file is open', () => {
  it('nothing suppresses the editor column', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    expect(shell).toContain('const editorAllocated = editorOpen || reviewOpen || terminalVisible;');
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
    // A diff tab takes the whole center row only while the files are what the
    // right column shows; the review or the terminal on top of it does not.
    expect(shell).toContain('diffTabActive: !editorCovered && diffTabActive,');
  });
});

/**
 * dsh-rebase P1-11 (decisions 109, 126, 128; prototype scene G): the folder's
 * shell terminal is the right column's third occupant. Layout facts no pure
 * function can reach: which width it takes, how it hides, and that the session
 * bar ends at the chat column's edge.
 */
describe('P1-11 the terminal shares the right column with the files', () => {
  it('takes the editor column width and grip, never a width of its own', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    // Decision 126 rule 3: the editor column's drag width, not a second one.
    expect(shell).toContain("width: terminalVisible ? 'var(--shell-editor-w)' :");
    expect(shell).toContain('parkedTerminalWidth}px');
    expect(shell).toContain('<TerminalColumn');
    // The grip on the chat column shows for the terminal too (it is keyed off
    // `editorAllocated`, which the terminal joins).
    expect(shell).toContain('{editorAllocated && chatVisible && (');
    // The terminal opens at the editor's floor, so files <-> terminal never
    // moves the grip; only the review has a floor of its own.
    expect(shell).toContain('editorMinWidth: reviewOpen ? REVIEW_MIN_WIDTH : undefined,');
  });

  it('hides without unmounting and without collapsing to zero width', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    // Mounted while any column shell runs: an unmount ends the shell.
    expect(shell).toContain('{hasColumnTerminals && (');
    // Out of sight = invisible with a real box; `hidden` (display: none) would
    // hand xterm a zero measurement and the pty two columns.
    expect(shell).toContain("'pointer-events-none invisible absolute inset-y-0 right-0'");
    const column = code(join(SHELL_DIR, 'center/TerminalColumn.tsx'));
    expect(column).toContain("cn('absolute inset-2', !shown && 'pointer-events-none invisible')");
    expect(column).not.toMatch(/['"`\s]hidden['"`\s]/);
  });

  it('wears the file tab chrome and names the folder under it (prototype scene G)', () => {
    const column = code(join(SHELL_DIR, 'center/TerminalColumn.tsx'));
    expect(column).toContain('flex h-10 shrink-0 items-start border-b');
    expect(column).toContain('absolute inset-x-0 top-0 h-0.5 bg-primary');
    expect(column).toContain("t('Close terminal')");
    expect(column).toContain("t('Session directory')");
    // Paths are mono through the D25 primitive, never a raw `font-mono`.
    expect(column).toContain('<Ident');
    expect(column).not.toContain('font-mono');
  });

  it('the session bar ends at the chat column, and its labels fold on a narrow bar', () => {
    const bar = code(join(SHELL_DIR, 'SessionBar.tsx'));
    // The prototype's second round: labels ran over the right column's tab bar
    // on a wide window. The bar is a size container and clips at its edge.
    expect(bar).toContain(
      '@container flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b bg-card/40 px-2'
    );
    expect(bar).toContain("const BAR_LABEL_CLASS = 'max-xl:hidden @max-2xl:hidden';");
    // Every labelled button on the bar folds the same way.
    expect(bar.split('className={BAR_LABEL_CLASS}').length - 1).toBe(4);
    expect(bar).not.toContain('<span className="max-xl:hidden">');
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
