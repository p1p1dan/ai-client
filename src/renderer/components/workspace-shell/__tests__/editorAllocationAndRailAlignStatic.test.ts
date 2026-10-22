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

describe('U26 (D13) the editor is never suppressed (design system v2 / layout 5a)', () => {
  it('nothing suppresses the editor tab while a file is open or an intent waits', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    // Layout 5d: the pane area's width is allocated whenever a pane shows,
    // and the editor pane exists whenever a file is open or an intent waits.
    expect(shell).toContain('editorOpen: paneView.columns > 0,');
    expect(shell).toContain('editorOpen: editorOpen || fileIntentPending,');
    expect(shell).not.toContain('isTui');
  });

  it('the chat column gets the whole row while the panel is closed', () => {
    // `editorOpen` is keyed off `tabs.length`; the allocator's editor term is
    // the open panel.
    const model = code(join(SHELL_DIR, 'centerLayoutModel.ts'));
    expect(model).toContain('export function deriveEditorOpen(openTabCount: number)');
    expect(model).toMatch(/deriveEditorOpen[\s\S]{0,120}openTabCount > 0/);
  });

  it('chat visibility and the fullscreen-diff hide come from the shell chrome alone', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    expect(shell).toContain('const chatVisible = chrome.chatVisible;');
    // A diff tab takes the whole center row only while the editor is the one
    // pane on screen (layout 5d); beside other panes it stays a card.
    expect(shell).toContain('diffTabActive: editorPaneAlone && diffTabActive,');
  });
});

/**
 * dsh-rebase P1-11 (decisions 109, 126, 128; prototype scene G): the folder's
 * shell terminal. Design system v2 / layout 5a made it the work panel's 终端
 * tab (ruling L4). Layout facts no pure function can reach: which width it
 * takes, how it hides, and what the title bar looks like.
 */
describe('P1-11 the terminal is a pane card (layout 5d)', () => {
  it('takes the pane area width and grip, never a width of its own', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    const area = code(join(SHELL_DIR, 'PaneArea.tsx'));
    // Decision 126 rule 3: one drag width, the pane area's.
    expect(area).toContain("{ width: 'var(--shell-editor-w)' }");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on source text that itself contains a template placeholder
    expect(area).toContain('{ width: `${parkedWidth}px` }');
    expect(shell).toContain('parkedWidth={parkedPaneWidth}');
    expect(area).toContain('<TerminalColumn');
    // One grip, on the area's left edge, for every pane.
    expect(area).toContain('side="left"');
    expect(shell).not.toContain('REVIEW_MIN_WIDTH');
    // The floor is per column count (320 a card), never per pane kind.
    expect(shell).toContain('editorMinWidth: paneAreaMinWidth(paneColumns),');
  });

  it('hides without unmounting and without collapsing to zero width', () => {
    const area = code(join(SHELL_DIR, 'PaneArea.tsx'));
    const card = code(join(SHELL_DIR, 'PaneCard.tsx'));
    // Mounted while any column shell runs: an unmount ends the shell.
    expect(area).toContain("if (kind === 'terminal') return hasColumnTerminals;");
    // Out of sight = invisible over the area's box; `hidden` (display: none)
    // would hand xterm a zero measurement and the pty two columns. The empty
    // area itself parks the same way.
    expect(card).toContain("!shown && 'pointer-events-none invisible inset-0'");
    expect(card).not.toMatch(/['"`\s]hidden['"`\s]/);
    expect(area).toContain("!open && 'pointer-events-none invisible absolute inset-y-0 right-0'");
    const column = code(join(SHELL_DIR, 'center/TerminalColumn.tsx'));
    expect(column).toContain("cn('absolute inset-2', !shown && 'pointer-events-none invisible')");
    expect(column).not.toMatch(/['"`\s]hidden['"`\s]/);
  });

  it('names the folder in the card header, with no row of its own (prototype scene G, layout 5d)', () => {
    const column = code(join(SHELL_DIR, 'center/TerminalColumn.tsx'));
    expect(column).toContain('<PaneHeaderPortal slot="context">');
    expect(column).toContain('<PaneHeaderPortal slot="actions">');
    expect(column).not.toContain('h-8');
    expect(column).not.toContain('h-10');
    expect(column).toContain("t('Close terminal')");
    expect(column).toContain("t('Session directory')");
    // Paths are mono through the D25 primitive, never a raw `font-mono`.
    expect(column).toContain('<Ident');
    expect(column).not.toContain('font-mono');
  });

  it('the title bar is one slim borderless row of icon buttons', () => {
    const bar = code(join(SHELL_DIR, 'SessionBar.tsx'));
    // Layout 5a: 36px, the canvas, no hairline; the title truncates first.
    expect(bar).toContain('flex h-9 shrink-0 items-center gap-1 overflow-hidden bg-surface-1 px-2');
    expect(bar).not.toContain('border-b');
    // Icon only: the names live in tooltips, so nothing folds any more.
    expect(bar).not.toContain('BAR_LABEL_CLASS');
    expect(bar).toContain('<TooltipPopup');
  });
});

/**
 * U27 put an `h-9` spacer at the top of the rail; decision 183 removed it.
 * Design system v2 / layout 5a removed the rail itself: the sidebar's top row
 * is h-9, level with the title bar, and carries the collapse control.
 */
describe('the sidebar opens level with the title bar (layout 5a, was U27)', () => {
  it('has no rail, and its top row is the title bar`s height', () => {
    const dock = code(join(SHELL_DIR, 'LeftDock.tsx'));
    expect(dock).not.toContain(
      'items-center gap-0.5 border-r border-border-soft bg-surface-0 pt-3.5'
    );
    // Layout 5b: the row also holds back / forward, packed tight.
    expect(dock).toContain('<div className="flex h-9 shrink-0 items-center gap-0.5 px-2">');
  });

  it('the sidebar has no h-9 title row to track', () => {
    const dock = code(join(SHELL_DIR, 'LeftDock.tsx'));
    expect(dock).not.toContain('DockTitle');
    expect(dock).not.toContain('flex h-9 shrink-0 items-center gap-2 border-b px-3');
  });
});
