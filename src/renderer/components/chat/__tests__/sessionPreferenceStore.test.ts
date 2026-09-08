import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PERMISSIONS_STORAGE_KEY,
  DEFAULT_TIER_STORAGE_KEY,
  readDefaultPermissions,
  readSessionEffort,
  readSessionModel,
  readSessionPermissions,
  removeSessionEffort,
  removeSessionModel,
  removeSessionTier,
  SESSION_EFFORT_STORAGE_KEY,
  SESSION_MODEL_STORAGE_KEY,
  SESSION_PERMISSIONS_STORAGE_KEY,
  SESSION_TIER_STORAGE_KEY,
  writeDefaultPermissions,
  writeSessionEffort,
  writeSessionModel,
  writeSessionPermissions,
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

describe('D14 permission preferences', () => {
  it.each([
    ['readonly', 'plan', 'ask'],
    ['pragmatic', 'agent', 'ask'],
    ['handsoff', 'agent', 'accept-edits'],
    ['fullopen', 'agent', 'auto'],
  ] as const)('migrates %s for existing sessions and new-chat defaults', (tier, mode, gear) => {
    storage.set(SESSION_TIER_STORAGE_KEY, JSON.stringify({ s1: tier }));
    storage.set(DEFAULT_TIER_STORAGE_KEY, tier);
    expect(readSessionPermissions('s1')).toEqual({ mode, gear });
    expect(readDefaultPermissions()).toEqual({ mode, gear });
    expect(storage.has(SESSION_PERMISSIONS_STORAGE_KEY)).toBe(false);
  });
  it('keeps the two axes independent and gives new settings priority over legacy', () => {
    storage.set(SESSION_TIER_STORAGE_KEY, JSON.stringify({ s1: 'readonly' }));
    writeSessionPermissions('s1', { mode: 'plan', gear: 'auto' });
    writeDefaultPermissions({ mode: 'agent', gear: 'accept-edits' });
    expect(readSessionPermissions('s1')).toEqual({ mode: 'plan', gear: 'auto' });
    expect(readDefaultPermissions()).toEqual({ mode: 'agent', gear: 'accept-edits' });
    removeSessionTier('s1');
    expect(readSessionPermissions('s1')).toBeNull();
    expect(readDefaultPermissions()).toEqual({ mode: 'agent', gear: 'accept-edits' });
  });
  it('falls back from malformed new settings without dropping old readonly', () => {
    storage.set(DEFAULT_PERMISSIONS_STORAGE_KEY, '{broken');
    storage.set(DEFAULT_TIER_STORAGE_KEY, 'readonly');
    storage.set(
      SESSION_PERMISSIONS_STORAGE_KEY,
      JSON.stringify({ s1: { mode: 'goal', gear: 'auto' } })
    );
    storage.set(SESSION_TIER_STORAGE_KEY, JSON.stringify({ s1: { pi: 'readonly' } }));
    expect(readDefaultPermissions()).toEqual({ mode: 'plan', gear: 'ask' });
    expect(readSessionPermissions('s1')).toEqual({ mode: 'plan', gear: 'ask' });
  });
});
