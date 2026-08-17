import { describe, expect, it } from 'vitest';
import {
  CHAT_EFFORTS,
  EFFORT_DEFAULT_ID,
  effortLabel,
  isEffortLevel,
  resolveEffortSelection,
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

/**
 * D48 S2 §4.3 — the effort priority chain, extracted because it had already
 * split in two: the send path and the composer trigger consulted the agent
 * template, the Context surface did not, so a session running on a template
 * `high` displayed "no effort configured" while the wire carried `high`.
 */
describe('resolveEffortSelection (§4.3 priority chain)', () => {
  it("prefers this (session, agent)'s own selection over the template", () => {
    expect(resolveEffortSelection('low', 'high')).toBe('low');
    // Including the sentinel: an explicit `Default` is a CHOICE, and it must
    // out-rank the template rather than falling through to it.
    expect(resolveEffortSelection(EFFORT_DEFAULT_ID, 'high')).toBe(EFFORT_DEFAULT_ID);
  });

  it('falls back to the agent template when the session chose nothing', () => {
    expect(resolveEffortSelection(null, 'high')).toBe('high');
    expect(resolveEffortSelection(undefined, 'high')).toBe('high');
    expect(resolveEffortSelection('', 'high')).toBe('high');
  });

  it('answers null — never the sentinel — when neither rung has a value', () => {
    expect(resolveEffortSelection(null, null)).toBeNull();
    expect(resolveEffortSelection(undefined, undefined)).toBeNull();
    expect(resolveEffortSelection('  ', '')).toBeNull();
  });

  // The mirror and the wire are resolved from the same call, so this is the
  // pairing that keeps them from disagreeing.
  it('feeds toWireEffort the same value the UI shows', () => {
    expect(toWireEffort(resolveEffortSelection(null, 'high'))).toBe('high');
    expect(toWireEffort(resolveEffortSelection(EFFORT_DEFAULT_ID, 'high'))).toBeUndefined();
    expect(toWireEffort(resolveEffortSelection(null, null))).toBeUndefined();
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
