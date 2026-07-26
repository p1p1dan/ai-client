import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EFFORT_DEFAULT_ID, toWireEffort } from '../efforts';
import {
  readSessionEffort,
  removeSessionEffort,
  SESSION_EFFORT_STORAGE_KEY,
  writeSessionEffort,
} from '../sessionEffortStore';

/**
 * T-20 persistence. Two behaviors are load-bearing: selections must be
 * per-session (switching sessions must not leak the other's effort), and a
 * corrupt or unavailable store must degrade to "unset" rather than throwing —
 * the Composer reads this on every Send, so a throw would break sending.
 */

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeMemoryStorage());
});

describe('sessionEffortStore', () => {
  it('returns null for a session with no stored selection', () => {
    expect(readSessionEffort('s1')).toBeNull();
  });

  it('round-trips a selection through storage', () => {
    writeSessionEffort('s1', 'xhigh');
    expect(readSessionEffort('s1')).toBe('xhigh');
    expect(JSON.parse(localStorage.getItem(SESSION_EFFORT_STORAGE_KEY) ?? '{}')).toEqual({
      s1: 'xhigh',
    });
  });

  it('keeps selections independent per session', () => {
    writeSessionEffort('s1', 'low');
    writeSessionEffort('s2', 'max');
    expect(readSessionEffort('s1')).toBe('low');
    expect(readSessionEffort('s2')).toBe('max');
  });

  it('overwrites a prior selection for the same session', () => {
    writeSessionEffort('s1', 'low');
    writeSessionEffort('s1', 'high');
    expect(readSessionEffort('s1')).toBe('high');
  });

  it('clears one session without touching the others', () => {
    writeSessionEffort('s1', 'low');
    writeSessionEffort('s2', 'max');
    removeSessionEffort('s1');
    expect(readSessionEffort('s1')).toBeNull();
    expect(readSessionEffort('s2')).toBe('max');
  });

  it('treats clearing an unset session as a no-op', () => {
    expect(() => removeSessionEffort('missing')).not.toThrow();
    expect(readSessionEffort('missing')).toBeNull();
  });

  it('persists the Default sentinel, which then omits the wire field', () => {
    // An explicit Default choice must survive a restart — otherwise the selector
    // would silently drift back to whatever the initial state was.
    writeSessionEffort('s1', EFFORT_DEFAULT_ID);
    expect(readSessionEffort('s1')).toBe(EFFORT_DEFAULT_ID);
    expect(toWireEffort(readSessionEffort('s1'))).toBeUndefined();
  });

  it('degrades to unset when the stored blob is corrupt', () => {
    localStorage.setItem(SESSION_EFFORT_STORAGE_KEY, '{not json');
    expect(readSessionEffort('s1')).toBeNull();
  });

  it('degrades to unset when the stored blob is not an object', () => {
    localStorage.setItem(SESSION_EFFORT_STORAGE_KEY, '["high"]');
    expect(readSessionEffort('s1')).toBeNull();
  });

  it('does not throw when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    } as unknown as Storage);
    expect(() => writeSessionEffort('s1', 'high')).not.toThrow();
    expect(readSessionEffort('s1')).toBeNull();
  });
});
