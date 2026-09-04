import { SESSION_EFFORT_LEVELS } from '@shared/types/agentHost';
import { describe, expect, it } from 'vitest';
import {
  CHAT_EFFORTS,
  EFFORT_DEFAULT_ID,
  effortLabel,
  effortsForModel,
  isEffortLevel,
  reconcileEffortForModel,
  resolveEffortSelection,
  toWireEffort,
} from '../efforts';

/**
 * T-20 effort catalog. The load-bearing behavior is `toWireEffort`: the "Default"
 * choice must send **no** `effort` field so the model default applies, which is
 * observably different from pinning `high`. Getting that wrong would silently
 * change every session's behavior versus pre-T-20 builds.
 *
 * U08-2 widened the catalog to Pi's full seven `ThinkingLevel` words. That put a
 * second thing next to the sentinel that also means "少想一点" in casual reading
 * but not on the wire: `off` is a LEVEL and is sent; `default` is the absence of
 * one and is omitted. The pair of assertions below is what keeps them apart.
 */

describe('CHAT_EFFORTS catalog', () => {
  it("lists exactly Pi's seven thinking levels, in Pi's ascending order", () => {
    expect(CHAT_EFFORTS.map((e) => e.id)).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('stays in lockstep with the wire vocabulary rather than restating it', () => {
    expect(CHAT_EFFORTS.map((e) => e.id)).toEqual([...SESSION_EFFORT_LEVELS]);
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

  it('gives off and minimal distinct labels', () => {
    // Pre-U08-2 the `low` hint read "Minimal thinking", which would now name a
    // different level than the row it sits on.
    const labels = CHAT_EFFORTS.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(effortLabel('off')).toBe('Off');
    expect(effortLabel('minimal')).toBe('Minimal');
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

  it('passes the two levels U08-2 added through unchanged', () => {
    expect(toWireEffort('off')).toBe('off');
    expect(toWireEffort('minimal')).toBe('minimal');
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
 * U08-2 acceptance ④. These two selections are adjacent in the menu and read
 * similarly in English, but they are OPPOSITE instructions: `off` pins thinking
 * off, `default` declines to pin anything and lets Pi apply its own default
 * (`medium`). A build that collapsed them would turn "no reasoning" into
 * "medium reasoning" with nothing in the UI to show for it.
 */
describe('off is a level, default is the absence of one', () => {
  it('treats off as a catalog level and default as not one', () => {
    expect(isEffortLevel('off')).toBe(true);
    expect(isEffortLevel(EFFORT_DEFAULT_ID)).toBe(false);
    expect(CHAT_EFFORTS.some((e) => e.id === 'off')).toBe(true);
  });

  it('puts off on the wire and omits the field for default', () => {
    const sendPayload = (selection: string) => {
      const effort = toWireEffort(selection);
      return { sessionId: 's1', ...(effort ? { effort } : {}) };
    };
    // The real send path spreads on truthiness, so this asserts the level
    // survives that spread rather than only that the mapper returned it.
    expect(sendPayload('off')).toEqual({ sessionId: 's1', effort: 'off' });
    expect(sendPayload(EFFORT_DEFAULT_ID)).not.toHaveProperty('effort');
  });

  it('keeps them distinct through the priority chain', () => {
    expect(toWireEffort(resolveEffortSelection('off', 'high'))).toBe('off');
    expect(toWireEffort(resolveEffortSelection(EFFORT_DEFAULT_ID, 'off'))).toBeUndefined();
    // A session that chose nothing inherits an `off` template as a real level.
    expect(toWireEffort(resolveEffortSelection(null, 'off'))).toBe('off');
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

describe('T25 model-level effort capability', () => {
  it('shows the whole catalog for a model with no metadata', () => {
    expect(effortsForModel(undefined).map((effort) => effort.id)).toEqual(
      CHAT_EFFORTS.map((effort) => effort.id)
    );
  });

  it('hides all explicit efforts when reasoning is disabled', () => {
    expect(effortsForModel({ reasoning: false })).toEqual([]);
  });

  it('uses non-null thinkingLevelMap entries as the declared supported set', () => {
    const model = {
      reasoning: true,
      thinkingLevelMap: { low: 'low', medium: null, high: 'high', max: null },
    };
    expect(effortsForModel(model).map((effort) => effort.id)).toEqual(['low', 'high']);
    expect(reconcileEffortForModel('high', model)).toBe('high');
    expect(reconcileEffortForModel('max', model)).toBe(EFFORT_DEFAULT_ID);
  });

  /**
   * U08-2 acceptance ①. The map could always carry these two keys — the
   * validator has accepted seven levels since T25. Only the UI catalog was
   * short, so a model declaring `off`/`minimal` had them silently filtered out
   * by `effortsForModel` because no catalog row matched.
   */
  it('surfaces off and minimal when the model declares them', () => {
    const model = {
      reasoning: true,
      thinkingLevelMap: { off: 'off', minimal: 'minimal', high: 'high', xhigh: null },
    };
    expect(effortsForModel(model).map((effort) => effort.id)).toEqual(['off', 'minimal', 'high']);
    expect(reconcileEffortForModel('off', model)).toBe('off');
    expect(reconcileEffortForModel('minimal', model)).toBe('minimal');
  });

  it('reconciles off away when the model does not declare it', () => {
    const model = { reasoning: true, thinkingLevelMap: { low: 'low', high: 'high' } };
    expect(reconcileEffortForModel('off', model)).toBe(EFFORT_DEFAULT_ID);
  });
});

/**
 * U08-2 acceptance ②/③, per evidence-q06: the two vocabularies overlap on
 * `low..max`, so widening is a pure superset and every stored preference keeps
 * its exact meaning. There is nothing to translate and therefore nothing that
 * may be rewritten — the failure this guards against is a future "migration"
 * that maps old words onto new ones and changes a user's setting behind them.
 */
describe('widening is a superset, not a migration', () => {
  it('leaves every pre-U08-2 level identical', () => {
    for (const stored of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(isEffortLevel(stored)).toBe(true);
      expect(toWireEffort(stored)).toBe(stored);
      expect(resolveEffortSelection(stored, 'high')).toBe(stored);
    }
  });

  it('still lands unknown values on the sentinel, never on off', () => {
    for (const junk of ['ultra', 'none', 'OFF', '']) {
      expect(reconcileEffortForModel(junk, undefined)).toBe(EFFORT_DEFAULT_ID);
      expect(toWireEffort(junk)).toBeUndefined();
    }
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
