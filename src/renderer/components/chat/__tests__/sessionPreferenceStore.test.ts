import { PI_AGENT } from '@shared/types/agentWire';
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
    writeSessionModel('s1', PI_AGENT, 'glm/glm-5');
    writeSessionEffort('s1', PI_AGENT, 'high');
    expect(readSessionModel('s1', PI_AGENT)).toBe('glm/glm-5');
    expect(readSessionEffort('s1', PI_AGENT)).toBe('high');
    expect(JSON.parse(storage.get(SESSION_MODEL_STORAGE_KEY) ?? '{}')).toEqual({
      s1: 'glm/glm-5',
    });
    expect(JSON.parse(storage.get(SESSION_EFFORT_STORAGE_KEY) ?? '{}')).toEqual({ s1: 'high' });
  });

  it('reads a legacy per-agent row and persists scalar on the next write', () => {
    storage.set(SESSION_MODEL_STORAGE_KEY, JSON.stringify({ s1: { pi: 'old/pi' } }));
    expect(readSessionModel('s1', PI_AGENT)).toBe('old/pi');
    writeSessionModel('s1', PI_AGENT, 'new/pi');
    expect(JSON.parse(storage.get(SESSION_MODEL_STORAGE_KEY) ?? '{}')).toEqual({ s1: 'new/pi' });
  });

  it('rejects invalid effort and clears values', () => {
    writeSessionEffort('s1', PI_AGENT, 'ultra');
    expect(readSessionEffort('s1', PI_AGENT)).toBeNull();
    writeSessionModel('s1', PI_AGENT, 'glm/glm-5');
    writeSessionEffort('s1', PI_AGENT, 'default');
    removeSessionModel('s1', PI_AGENT);
    removeSessionEffort('s1', PI_AGENT);
    expect(readSessionModel('s1', PI_AGENT)).toBeNull();
    expect(readSessionEffort('s1', PI_AGENT)).toBeNull();
  });
});
