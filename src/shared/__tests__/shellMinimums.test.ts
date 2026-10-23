import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHELL_MIN_HEIGHT, SHELL_MIN_WIDTH } from '../shellMinimums';

/**
 * U25: the window minimum and the layout floors must not drift apart.
 *
 * `shellMinimums.ts` states a number Main enforces, derived from three constants
 * the renderer owns. Nothing in the type system connects the two — so this does,
 * by reading the renderer's own source. If someone widens `EDITOR_MIN_WIDTH` and
 * the window minimum stays put, the overflow this whole task removed comes back,
 * and the only symptom is buttons off-screen at some window sizes.
 */
const REPO = process.cwd();
const centerModel = readFileSync(
  join(REPO, 'src/renderer/components/workspace-shell/centerLayoutModel.ts'),
  'utf8'
);
const shellModel = readFileSync(
  join(REPO, 'src/renderer/components/workspace-shell/shellLayoutModel.ts'),
  'utf8'
);

/**
 * Reads `export const NAME = <number>;` or a sum of numbers, which is every
 * form these constants are written in. Summing the terms by hand rather than
 * evaluating the expression: this file only needs to understand the shapes
 * that exist, and a general evaluator here would be a second place that has
 * to be right about arithmetic. (Layout 5a removed the `DOCK_RAIL_WIDTH` term
 * the sidebar minimum used to carry.)
 */
function readConst(source: string, name: string): number {
  const match = new RegExp(`export const ${name} = ([^;]+);`).exec(source);
  if (!match) throw new Error(`${name} not found in source`);
  return (match[1] as string)
    .split('+')
    .map((term) => term.trim())
    .reduce((sum, term) => {
      if (/^\d+$/.test(term)) return sum + Number(term);
      throw new Error(`${name} has a term this test cannot read: ${term}`);
    }, 0);
}

describe('U25 shell minimums', () => {
  it('SHELL_MIN_WIDTH equals the widest layout floor the shell can demand', () => {
    const chatMin = readConst(centerModel, 'CHAT_MIN_WIDTH');
    const editorMin = readConst(centerModel, 'EDITOR_MIN_WIDTH');
    const sidebarMin = readConst(shellModel, 'SIDEBAR_MIN_WIDTH');

    // The EXPANDED sidebar minimum, not the collapsed rail: sizing to the rail
    // would put the overflow back the moment the user opens a panel.
    expect(SHELL_MIN_WIDTH).toBe(sidebarMin + chatMin + editorMin);
  });

  it('is wide enough for the collapsed-sidebar case with room to spare', () => {
    // Layout 5a: a collapsed sidebar reserves nothing (no rail any more).
    const collapsed = readConst(centerModel, 'SIDEBAR_COLLAPSED_RESERVE');
    const chatMin = readConst(centerModel, 'CHAT_MIN_WIDTH');
    const editorMin = readConst(centerModel, 'EDITOR_MIN_WIDTH');

    expect(collapsed).toBe(0);
    expect(SHELL_MIN_WIDTH).toBeGreaterThan(collapsed + chatMin + editorMin);
  });

  it('the window actually asks for these, not its own numbers', () => {
    const window = readFileSync(join(REPO, 'src/main/windows/MainWindow.ts'), 'utf8');
    expect(window).toContain('minWidth: SHELL_MIN_WIDTH');
    expect(window).toContain('minHeight: SHELL_MIN_HEIGHT');
    // The literal it replaced — small enough to overflow the center row.
    expect(window).not.toContain('minWidth: 685');
    expect(SHELL_MIN_HEIGHT).toBe(600);
  });
});
