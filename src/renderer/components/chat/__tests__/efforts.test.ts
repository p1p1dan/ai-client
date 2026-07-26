import { describe, expect, it } from 'vitest';
import {
  CHAT_EFFORTS,
  EFFORT_DEFAULT_ID,
  effortLabel,
  isEffortLevel,
  toWireEffort,
} from '../efforts';

/**
 * T-20 effort catalog. The load-bearing behavior is `toWireEffort`: the "Default"
 * choice must send **no** `effort` field so the model default applies, which is
 * observably different from pinning `high`. Getting that wrong would silently
 * change every session's behavior versus pre-T-20 builds.
 */

describe('CHAT_EFFORTS catalog', () => {
  it('lists exactly the levels the SDK declares, in ascending order', () => {
    expect(CHAT_EFFORTS.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('does not include the default sentinel as a real level', () => {
    expect(CHAT_EFFORTS.some((e) => (e.id as string) === EFFORT_DEFAULT_ID)).toBe(false);
  });

  it('gives every level a label and a hint', () => {
    for (const effort of CHAT_EFFORTS) {
      expect(effort.label.length).toBeGreaterThan(0);
      expect(effort.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('isEffortLevel', () => {
  it('accepts every catalog level', () => {
    for (const effort of CHAT_EFFORTS) {
      expect(isEffortLevel(effort.id)).toBe(true);
    }
  });

  it('rejects the sentinel, unknown strings and non-strings', () => {
    for (const bad of [EFFORT_DEFAULT_ID, '', 'HIGH', 'ultra', 0, null, undefined, {}, ['high']]) {
      expect(isEffortLevel(bad)).toBe(false);
    }
  });
});

describe('toWireEffort', () => {
  it('passes a real level through unchanged', () => {
    expect(toWireEffort('xhigh')).toBe('xhigh');
    expect(toWireEffort('low')).toBe('low');
  });

  it('omits the field for the default sentinel', () => {
    // undefined (not null / not "default") so the spread drops the key entirely.
    expect(toWireEffort(EFFORT_DEFAULT_ID)).toBeUndefined();
  });

  it('omits the field for unset or unknown stored values', () => {
    for (const bad of [null, undefined, '', 'turbo']) {
      expect(toWireEffort(bad)).toBeUndefined();
    }
  });

  it('drops the key when spread into a payload', () => {
    const payload = {
      sessionId: 's1',
      ...(toWireEffort(EFFORT_DEFAULT_ID) ? { effort: 'x' } : {}),
    };
    expect(payload).not.toHaveProperty('effort');
  });
});

describe('effortLabel', () => {
  it('labels each real level', () => {
    expect(effortLabel('low')).toBe('Low');
    expect(effortLabel('xhigh')).toBe('X-High');
    expect(effortLabel('max')).toBe('Max');
  });

  it('falls back to Default for the sentinel and unknown values', () => {
    expect(effortLabel(EFFORT_DEFAULT_ID)).toBe('Default');
    expect(effortLabel('nonsense')).toBe('Default');
  });
});
