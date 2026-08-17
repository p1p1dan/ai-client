import {
  agentDefaultEffort,
  agentDefaultModel,
  canPersistLastAgent,
  EMPTY_CHAT_AGENT_DEFAULTS,
  resolveInitialDraftAgent,
  sanitizeChatAgentDefaults,
  withAgentPreference,
} from '@shared/models/chatAgentDefaults';
import { AGENT_WIRE_NAMES, CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import { describe, expect, it } from 'vitest';

/**
 * D48 S2 §4.3 / B15 — `lastAgent` × capabilities intersection, plus both
 * hydration arms.
 *
 * The intersection is the whole point: `lastAgent` is a memory of a PAST Host.
 * Adopting it verbatim on a build where the Codex flag is off binds every new
 * draft to an agent the Host cannot run, and the failure lands at the first send
 * (`agent_unsupported`) — after the draft has been consumed and the picker
 * locked.
 */

describe('resolveInitialDraftAgent (B15 truth table)', () => {
  const LEGACY = CLAUDE_CODE_AGENT;

  it('adopts lastAgent when the Host can actually run it', () => {
    expect(
      resolveInitialDraftAgent({
        lastAgent: CODEX_AGENT,
        capabilitiesAgents: [CLAUDE_CODE_AGENT, CODEX_AGENT],
        settingsHydrated: true,
      })
    ).toBe(CODEX_AGENT);
  });

  it('falls back when lastAgent is not in the available set', () => {
    expect(
      resolveInitialDraftAgent({
        lastAgent: CODEX_AGENT,
        capabilitiesAgents: [CLAUDE_CODE_AGENT],
        settingsHydrated: true,
      })
    ).toBe(LEGACY);
  });

  // `undefined` (a Host build predating the capability) is "cannot confirm
  // anything", not "everything is available" — the same distinction the picker's
  // own truth table draws.
  it('falls back on an old Host that reports no agent list at all', () => {
    expect(
      resolveInitialDraftAgent({
        lastAgent: CODEX_AGENT,
        capabilitiesAgents: undefined,
        settingsHydrated: true,
      })
    ).toBe(LEGACY);
  });

  it('falls back when the Host reports an EMPTY set', () => {
    expect(
      resolveInitialDraftAgent({
        lastAgent: CODEX_AGENT,
        capabilitiesAgents: [],
        settingsHydrated: true,
      })
    ).toBe(LEGACY);
  });

  it('falls back when nothing was ever remembered', () => {
    expect(
      resolveInitialDraftAgent({
        lastAgent: undefined,
        capabilitiesAgents: [CLAUDE_CODE_AGENT, CODEX_AGENT],
        settingsHydrated: true,
      })
    ).toBe(LEGACY);
  });

  // Hydration arm 1 (READ): app settings arrive over an async IPC round trip, so
  // there is a window on every launch where the store holds `defaults.ts` values
  // nobody chose. Reading `lastAgent` in it must not be believed.
  it('B15 hydration: ignores lastAgent entirely until settings have hydrated', () => {
    expect(
      resolveInitialDraftAgent({
        lastAgent: CODEX_AGENT,
        capabilitiesAgents: [CLAUDE_CODE_AGENT, CODEX_AGENT],
        settingsHydrated: false,
      })
    ).toBe(LEGACY);
  });

  // Hydration arm 2 (WRITE), split out on purpose: a build that gated only the
  // read would overwrite the user's real stored value with the empty default the
  // first time the picker was touched, and arm 1 would stay green while it did.
  it('B15 hydration: refuses to persist lastAgent until settings have hydrated', () => {
    expect(canPersistLastAgent(false)).toBe(false);
    expect(canPersistLastAgent(true)).toBe(true);
  });

  it('the fallback is the legacy binding, not a literal invented here', () => {
    expect(AGENT_WIRE_NAMES).toContain(LEGACY);
  });
});

describe('sanitizeChatAgentDefaults', () => {
  it('treats anything that is not an object as no memory at all', () => {
    for (const value of [undefined, null, 42, 'codex', ['codex']]) {
      expect(sanitizeChatAgentDefaults(value)).toEqual(EMPTY_CHAT_AGENT_DEFAULTS);
    }
  });

  it('keeps a well-formed record verbatim', () => {
    expect(
      sanitizeChatAgentDefaults({
        lastAgent: CODEX_AGENT,
        byAgent: { codex: { model: 'gpt-5.6-sol', effort: 'high' } },
      })
    ).toEqual({
      lastAgent: CODEX_AGENT,
      byAgent: { codex: { model: 'gpt-5.6-sol', effort: 'high' } },
    });
  });

  // A slug from a NEWER build would otherwise flow into `resolveInitialDraftAgent`
  // as a binding no runtime here can serve. The blob on disk is untouched.
  it('drops agent slugs this build does not know, in both positions', () => {
    const sanitized = sanitizeChatAgentDefaults({
      lastAgent: 'fable-code',
      byAgent: { 'fable-code': { model: 'x' }, codex: { model: 'gpt-5.6-sol' } },
    });
    expect(sanitized.lastAgent).toBeUndefined();
    expect(sanitized.byAgent).toEqual({ codex: { model: 'gpt-5.6-sol' } });
  });

  it('drops blank and non-string preference fields rather than storing them', () => {
    expect(
      sanitizeChatAgentDefaults({
        byAgent: { codex: { model: '   ', effort: 7 }, 'claude-code': { model: ' opus ' } },
      })
    ).toEqual({ byAgent: { 'claude-code': { model: 'opus' } } });
  });
});

describe('agentDefaultModel / agentDefaultEffort / withAgentPreference', () => {
  it('reads per agent and never leaks across the axis', () => {
    const defaults = sanitizeChatAgentDefaults({
      byAgent: { codex: { model: 'gpt-5.6-sol', effort: 'high' } },
    });
    expect(agentDefaultModel(defaults, CODEX_AGENT)).toBe('gpt-5.6-sol');
    expect(agentDefaultModel(defaults, CLAUDE_CODE_AGENT)).toBeUndefined();
    expect(agentDefaultEffort(defaults, CODEX_AGENT)).toBe('high');
    expect(agentDefaultEffort(defaults, CLAUDE_CODE_AGENT)).toBeUndefined();
    expect(agentDefaultModel(undefined, CODEX_AGENT)).toBeUndefined();
  });

  it('patches one field of one agent without disturbing the rest', () => {
    const before = sanitizeChatAgentDefaults({
      lastAgent: CODEX_AGENT,
      byAgent: {
        codex: { model: 'gpt-5.6-sol', effort: 'high' },
        'claude-code': { model: 'claude-opus-5' },
      },
    });
    const after = withAgentPreference(before, CODEX_AGENT, { model: 'gpt-5.6-luna' });
    expect(after.byAgent?.codex).toEqual({ model: 'gpt-5.6-luna', effort: 'high' });
    expect(after.byAgent?.['claude-code']).toEqual({ model: 'claude-opus-5' });
    expect(after.lastAgent).toBe(CODEX_AGENT);
    // Immutable: the input is still what it was.
    expect(before.byAgent?.codex).toEqual({ model: 'gpt-5.6-sol', effort: 'high' });
  });

  // `Automatic` is an ABSENCE at every layer, template included — storing a
  // sentinel here would make "the user picked Automatic" indistinguishable from
  // a model id nobody can route.
  it('an explicit undefined clears that field, and an emptied agent drops out', () => {
    const before = sanitizeChatAgentDefaults({ byAgent: { codex: { model: 'gpt-5.6-sol' } } });
    const after = withAgentPreference(before, CODEX_AGENT, { model: undefined });
    expect(agentDefaultModel(after, CODEX_AGENT)).toBeUndefined();
    expect(after.byAgent?.codex).toBeUndefined();
  });

  it('creates the record from nothing', () => {
    const created = withAgentPreference(undefined, CLAUDE_CODE_AGENT, { effort: 'max' });
    expect(agentDefaultEffort(created, CLAUDE_CODE_AGENT)).toBe('max');
  });
});
