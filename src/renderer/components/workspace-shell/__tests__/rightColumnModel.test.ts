import { describe, expect, it } from 'vitest';
import { deriveTerminalButtonState, resolveRightColumnOccupant } from '../rightColumnModel';

/**
 * dsh-rebase P1-11 (decisions 126, 128): the right column holds one of three
 * things. They stack — review, then the terminal when in front, then files —
 * so closing the top one reveals the next exactly as it was.
 */
describe('resolveRightColumnOccupant', () => {
  it('stacks review over terminal over files', () => {
    const all = { reviewOpen: true, terminalFront: true, editorOpen: true };
    expect(resolveRightColumnOccupant(all)).toBe('review');
    expect(resolveRightColumnOccupant({ ...all, reviewOpen: false })).toBe('terminal');
    expect(resolveRightColumnOccupant({ ...all, reviewOpen: false, terminalFront: false })).toBe(
      'editor'
    );
    expect(
      resolveRightColumnOccupant({ reviewOpen: false, terminalFront: false, editorOpen: false })
    ).toBeNull();
  });

  it('the terminal needs no open file to take the column', () => {
    expect(
      resolveRightColumnOccupant({ reviewOpen: false, terminalFront: true, editorOpen: false })
    ).toBe('terminal');
  });
});

describe('deriveTerminalButtonState', () => {
  it('is unavailable without a folder, whatever else is true', () => {
    expect(deriveTerminalButtonState({ available: false, alive: true, visible: true })).toBe(
      'unavailable'
    );
  });

  it('open while showing, hidden while running out of sight, closed otherwise', () => {
    expect(deriveTerminalButtonState({ available: true, alive: true, visible: true })).toBe('open');
    expect(deriveTerminalButtonState({ available: true, alive: true, visible: false })).toBe(
      'hidden'
    );
    expect(deriveTerminalButtonState({ available: true, alive: false, visible: false })).toBe(
      'closed'
    );
  });
});
