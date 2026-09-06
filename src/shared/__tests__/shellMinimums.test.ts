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
 * Reads `export const NAME = <number>;` or `= <number> + DOCK_RAIL_WIDTH;`,
 * which is every form these four constants are written in. Summing the terms
 * by hand rather than evaluating the expression: this file only needs to
 * understand the shapes that exist, and a general evaluator here would be a
 * second place that has to be right about arithmetic.
 */
function readConst(source: string, name: string): number {
  const match = new RegExp(`export const ${name} = ([^;]+);`).exec(source);
  if (!match) throw new Error(`${name} not found in source`);
  const railWidth = /export const DOCK_RAIL_WIDTH = (\d+);/.exec(shellModel);
  if (!railWidth) throw new Error('DOCK_RAIL_WIDTH not found in source');

  const total = (match[1] as string)
    .split('+')
    .map((term) => term.trim())
    .reduce((sum, term) => {
      if (term === 'DOCK_RAIL_WIDTH') return sum + Number(railWidth[1]);
      if (/^\d+$/.test(term)) return sum + Number(term);
      throw new Error(`${name} has a term this test cannot read: ${term}`);
    }, 0);
  return total;
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

  it('is wide enough for the collapsed-dock case with room to spare', () => {
    const railWidth = readConst(shellModel, 'DOCK_RAIL_WIDTH');
    const chatMin = readConst(centerModel, 'CHAT_MIN_WIDTH');
    const editorMin = readConst(centerModel, 'EDITOR_MIN_WIDTH');

    expect(SHELL_MIN_WIDTH).toBeGreaterThan(railWidth + chatMin + editorMin);
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
