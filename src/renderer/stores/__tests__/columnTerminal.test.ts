import { beforeEach, describe, expect, it } from 'vitest';
import { columnTerminalKey, countColumnTerminals, useColumnTerminalStore } from '../columnTerminal';

/**
 * dsh-rebase P1-11 (decision 128): the right column's shells, one per folder.
 * An entry is a running shell; `front` is whether it sits above the files.
 */
const store = () => useColumnTerminalStore.getState();

beforeEach(() => {
  useColumnTerminalStore.setState({ terminals: {} });
});

describe('column terminals', () => {
  it('opens one shell per folder, and a second open only brings it back to the front', () => {
    store().show('/repo/alpha');
    const key = columnTerminalKey('/repo/alpha');
    expect(store().terminals[key]).toEqual({ key, cwd: '/repo/alpha', front: true });

    store().hide(key);
    expect(store().terminals[key]?.front).toBe(false);
    // Same folder, spelled with a trailing separator: the same shell, not a second.
    store().show('/repo/alpha/');
    expect(Object.keys(store().terminals)).toEqual([key]);
    expect(store().terminals[key]).toEqual({ key, cwd: '/repo/alpha', front: true });
  });

  it('never opens a shell without a folder (decision 126 rule 2: no $HOME fallback)', () => {
    store().show('');
    store().show('   ');
    expect(store().terminals).toEqual({});
    expect(countColumnTerminals()).toBe(0);
  });

  it('hiding keeps the shell; closing ends it', () => {
    store().show('/repo/alpha');
    store().show('/repo/beta');
    const alpha = columnTerminalKey('/repo/alpha');
    store().hide(alpha);
    expect(countColumnTerminals()).toBe(2);
    store().close(alpha);
    expect(Object.keys(store().terminals)).toEqual([columnTerminalKey('/repo/beta')]);
    expect(countColumnTerminals()).toBe(1);
  });

  it('a deleted workspace takes the shells at and under it, and nothing beside it', () => {
    store().show('/tmp/ws');
    store().show('/tmp/ws/sub');
    store().show('/tmp/ws-other');
    store().closeUnder('/tmp/ws');
    expect(Object.keys(store().terminals)).toEqual([columnTerminalKey('/tmp/ws-other')]);
  });

  it('forgets everything on reset, and no-op actions keep the same state object', () => {
    const empty = store().terminals;
    store().hide('nope');
    store().close('nope');
    store().closeUnder('/nowhere');
    store().reset();
    expect(store().terminals).toBe(empty);

    store().show('/repo/alpha');
    const shown = store().terminals;
    store().show('/repo/alpha');
    expect(store().terminals).toBe(shown);
    store().reset();
    expect(store().terminals).toEqual({});
  });
});
