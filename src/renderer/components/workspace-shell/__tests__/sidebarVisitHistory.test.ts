/**
 * Layout 5b: the sidebar's back / forward over the conversations visited in
 * this run, and the label its 「搜索」 entry shows.
 */
import { describe, expect, it } from 'vitest';
import { keybindingLabel } from '../sidebar/keybindingLabel';
import {
  EMPTY_VISIT_HISTORY,
  recordVisit,
  stepVisit,
  VISIT_HISTORY_LIMIT,
  type VisitHistory,
} from '../sidebar/visitHistory';

const alive = () => true;

function visit(...ids: (string | null)[]): VisitHistory {
  return ids.reduce<VisitHistory>((history, id) => recordVisit(history, id), EMPTY_VISIT_HISTORY);
}

describe('recordVisit', () => {
  it('appends conversations, ignores the home page and a re-open of the current one', () => {
    expect(visit('a', null, 'a', 'b', 'b')).toEqual({ entries: ['a', 'b'], index: 1 });
  });

  it('drops the forward entries when a new conversation is opened after going back', () => {
    const back = stepVisit(visit('a', 'b', 'c'), -1, 'c', alive);
    expect(back?.sessionId).toBe('b');
    expect(recordVisit(back!.history, 'd')).toEqual({ entries: ['a', 'b', 'd'], index: 2 });
  });

  it('keeps the newest visits only', () => {
    const ids = Array.from({ length: VISIT_HISTORY_LIMIT + 5 }, (_, index) => `s${index}`);
    const history = visit(...ids);
    expect(history.entries).toHaveLength(VISIT_HISTORY_LIMIT);
    expect(history.entries[0]).toBe('s5');
    expect(history.index).toBe(VISIT_HISTORY_LIMIT - 1);
  });
});

describe('stepVisit', () => {
  it('is disabled at both ends', () => {
    expect(stepVisit(EMPTY_VISIT_HISTORY, -1, null, alive)).toBeNull();
    expect(stepVisit(visit('a'), -1, 'a', alive)).toBeNull();
    expect(stepVisit(visit('a', 'b'), 1, 'b', alive)).toBeNull();
  });

  it('walks back and forward, and the step does not record itself', () => {
    const history = visit('a', 'b', 'c');
    const back = stepVisit(history, -1, 'c', alive);
    expect(back).toEqual({ history: { entries: ['a', 'b', 'c'], index: 1 }, sessionId: 'b' });
    // The activation re-opens `b`, which is the current entry: no new entry.
    expect(recordVisit(back!.history, 'b')).toBe(back!.history);
    const forward = stepVisit(back!.history, 1, 'b', alive);
    expect(forward?.sessionId).toBe('c');
  });

  it('from the home page, back returns to the conversation last open', () => {
    const history = visit('a', 'b');
    expect(stepVisit(history, -1, null, alive)?.sessionId).toBe('b');
    expect(stepVisit(history, 1, null, alive)).toBeNull();
  });

  it('skips conversations that are gone, and the one already open', () => {
    const history = visit('a', 'gone', 'b');
    const isAlive = (id: string) => id !== 'gone';
    expect(stepVisit(history, -1, 'b', isAlive)?.sessionId).toBe('a');
    expect(stepVisit(visit('a', 'gone'), -1, 'gone', isAlive)?.sessionId).toBe('a');
    expect(stepVisit(visit('gone', 'b'), -1, 'b', isAlive)).toBeNull();
  });
});

describe('keybindingLabel', () => {
  it('names meta for what it is on each platform', () => {
    const binding = { key: 'p', meta: true };
    expect(keybindingLabel(binding, 'win32')).toBe('Win+P');
    expect(keybindingLabel(binding, 'linux')).toBe('Super+P');
    expect(keybindingLabel(binding, 'darwin')).toBe('⌘P');
  });

  it('orders modifiers Ctrl, Alt, Shift, meta', () => {
    expect(keybindingLabel({ key: 'f', ctrl: true, shift: true }, 'linux')).toBe('Ctrl+Shift+F');
    expect(keybindingLabel({ key: 'F7', alt: true }, 'win32')).toBe('Alt+F7');
  });
});
