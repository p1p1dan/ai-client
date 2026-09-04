import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readSessionEffort,
  readSessionModel,
  removeSessionEffort,
  removeSessionModel,
  SESSION_EFFORT_STORAGE_KEY,
  SESSION_MODEL_STORAGE_KEY,
  writeSessionEffort,
  writeSessionModel,
} from '../sessionPreferenceStore';

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});

describe('Pi-only session preferences', () => {
  it('stores one scalar model and effort per session', () => {
    writeSessionModel('s1', 'glm/glm-5');
    writeSessionEffort('s1', 'high');
    expect(readSessionModel('s1')).toBe('glm/glm-5');
    expect(readSessionEffort('s1')).toBe('high');
    expect(JSON.parse(storage.get(SESSION_MODEL_STORAGE_KEY) ?? '{}')).toEqual({
      s1: 'glm/glm-5',
    });
    expect(JSON.parse(storage.get(SESSION_EFFORT_STORAGE_KEY) ?? '{}')).toEqual({ s1: 'high' });
  });

  it('reads a legacy per-agent row and persists scalar on the next write', () => {
    storage.set(SESSION_MODEL_STORAGE_KEY, JSON.stringify({ s1: { pi: 'old/pi' } }));
    expect(readSessionModel('s1')).toBe('old/pi');
    writeSessionModel('s1', 'new/pi');
    expect(JSON.parse(storage.get(SESSION_MODEL_STORAGE_KEY) ?? '{}')).toEqual({ s1: 'new/pi' });
  });

  it('rejects invalid effort and clears values', () => {
    writeSessionEffort('s1', 'ultra');
    expect(readSessionEffort('s1')).toBeNull();
    writeSessionModel('s1', 'glm/glm-5');
    writeSessionEffort('s1', 'default');
    removeSessionModel('s1');
    removeSessionEffort('s1');
    expect(readSessionModel('s1')).toBeNull();
    expect(readSessionEffort('s1')).toBeNull();
  });

  /**
   * U08-2. `writeSessionEffort` guards on `isEffortSelection`, which is derived
   * from the catalog — so this is the assertion that the storage layer widened
   * along with the menu instead of dropping the user's pick on the floor.
   */
  it('accepts the two levels U08-2 added', () => {
    for (const level of ['off', 'minimal']) {
      writeSessionEffort('s1', level);
      expect(readSessionEffort('s1')).toBe(level);
    }
  });

  /**
   * evidence-q06's rule: read maps, it does not write back. A stored value from
   * before U08-2 must come out byte-identical and must not be rewritten on the
   * way through, or a user's `high` could silently become something else.
   */
  it('returns pre-U08-2 values unchanged and does not rewrite storage on read', () => {
    storage.set(
      SESSION_EFFORT_STORAGE_KEY,
      JSON.stringify({ s1: 'high', s2: 'xhigh', s3: 'ultra' })
    );
    const before = storage.get(SESSION_EFFORT_STORAGE_KEY);
    expect(readSessionEffort('s1')).toBe('high');
    expect(readSessionEffort('s2')).toBe('xhigh');
    // An unrecognized word is handed back as-is here; the UI layer is what
    // resolves it to the Default sentinel (see efforts.test.ts).
    expect(readSessionEffort('s3')).toBe('ultra');
    expect(storage.get(SESSION_EFFORT_STORAGE_KEY)).toBe(before);
  });
});
