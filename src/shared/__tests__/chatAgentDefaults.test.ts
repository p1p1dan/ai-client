import {
  agentDefaultEffort,
  agentDefaultModel,
  agentDefaultPermission,
  canPersistLastAgent,
  EMPTY_CHAT_AGENT_DEFAULTS,
  resolveDraftPermissionPreference,
  resolveInitialDraftAgent,
  sanitizeChatAgentDefaults,
  withAgentPreference,
} from '@shared/models/chatAgentDefaults';
import { AGENT_WIRE_NAMES, CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import {
  DANGEROUS_CODEX_SANDBOX_MODE,
  DANGEROUS_PERMISSION_MODE,
  isDangerousPermissionPreference,
  type SessionPermissionPreference,
} from '@shared/types/runtimeEvents';
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

/**
 * D48 S3 §5.4/§5.5 — the permission TEMPLATE layer.
 *
 * Three separate failures are pinned here, and none of them is "the getter
 * returns what the setter stored":
 *   - C13: no default, no fallback and no not-yet-hydrated placeholder is ever a
 *     dangerous tier. The enumeration is explicit because "dangerous by
 *     accident" is always a path nobody listed.
 *   - C15: a first send that lands before app settings finish rehydrating must
 *     materialise NOTHING, because what it would materialise is `defaults.ts`
 *     factory values — pinned permanently into the session snapshot, which
 *     resume reads and never revisits.
 *   - C8/C10 at rest: a preference cannot be stored under the wrong agent's key,
 *     and cannot claim `networkAccess`.
 */
describe('chat agent defaults — permission template (§5.4)', () => {
  // Cast, because `CLAUDE_CODE_AGENT` / `CODEX_AGENT` are deliberately typed as
  // the WIDE `AgentWireName` (agentWire.ts) while the preference union needs the
  // literal discriminant — the same reason the runtimes narrow by key.
  const CLAUDE_PLAN = {
    agent: CLAUDE_CODE_AGENT,
    permissionMode: 'plan',
  } as SessionPermissionPreference;
  const CODEX_UNTRUSTED = {
    agent: CODEX_AGENT,
    approvalPolicy: 'untrusted',
    sandboxMode: 'read-only',
  } as SessionPermissionPreference;

  it('stores and reads one agent’s tier without leaking across the axis', () => {
    const defaults = sanitizeChatAgentDefaults({
      byAgent: {
        'claude-code': { permission: CLAUDE_PLAN },
        codex: { permission: CODEX_UNTRUSTED },
      },
    });
    expect(agentDefaultPermission(defaults, CLAUDE_CODE_AGENT)).toEqual(CLAUDE_PLAN);
    expect(agentDefaultPermission(defaults, CODEX_AGENT)).toEqual(CODEX_UNTRUSTED);
  });

  it('C10 at rest — refuses a preference filed under the OTHER agent’s key', () => {
    // The record is keyed by agent AND the value carries its own discriminant.
    // A blob where the two disagree would hand `session.create` a Codex posture
    // for a Claude session; the Host refuses that at dispatch, and it cannot
    // even be stored here.
    const sanitized = sanitizeChatAgentDefaults({
      byAgent: { 'claude-code': { permission: CODEX_UNTRUSTED, model: 'claude-opus-5' } },
    });
    expect(sanitized.byAgent?.['claude-code']).toEqual({ model: 'claude-opus-5' });
    expect(agentDefaultPermission(sanitized, CLAUDE_CODE_AGENT)).toBeUndefined();

    const written = withAgentPreference(undefined, CLAUDE_CODE_AGENT, {
      permission: CODEX_UNTRUSTED,
    });
    expect(agentDefaultPermission(written, CLAUDE_CODE_AGENT)).toBeUndefined();
  });

  it('C8 at rest — a stored networkAccess claim is dropped, not honoured', () => {
    const sanitized = sanitizeChatAgentDefaults({
      byAgent: {
        codex: {
          permission: { ...CODEX_UNTRUSTED, networkAccess: true },
        },
      },
    });
    expect(agentDefaultPermission(sanitized, CODEX_AGENT)).toBeUndefined();
  });

  it('re-validates on READ, because this record round-trips through disk', () => {
    // Hand-built (not sanitized) — exactly what an edited settings file or an
    // older/newer build can hand us.
    const hostile = {
      byAgent: { codex: { permission: { agent: CODEX_AGENT, approvalPolicy: 'yolo' } } },
    } as unknown as Parameters<typeof agentDefaultPermission>[0];
    expect(agentDefaultPermission(hostile, CODEX_AGENT)).toBeUndefined();
  });

  it('an explicit undefined clears the tier back to the runtime constant', () => {
    const before = withAgentPreference(undefined, CODEX_AGENT, { permission: CODEX_UNTRUSTED });
    const after = withAgentPreference(before, CODEX_AGENT, { permission: undefined });
    expect(agentDefaultPermission(after, CODEX_AGENT)).toBeUndefined();
    // Absence, not a synthesized "safe" object: the safe value lives in the
    // Host constants, and a second copy here could drift from them.
    expect(after.byAgent?.codex).toBeUndefined();
  });

  it('accepts a dangerous tier the user explicitly picked', () => {
    // The never-a-default rule is about defaults and fallbacks; it must not
    // become "the control does not work", which is what the §8.0-Q3 decision
    // rejected.
    const stored = withAgentPreference(undefined, CLAUDE_CODE_AGENT, {
      permission: {
        agent: CLAUDE_CODE_AGENT,
        permissionMode: DANGEROUS_PERMISSION_MODE,
      } as SessionPermissionPreference,
    });
    expect(isDangerousPermissionPreference(agentDefaultPermission(stored, CLAUDE_CODE_AGENT))).toBe(
      true
    );
  });

  it('C15 — an unhydrated first send materialises nothing at all', () => {
    const defaults = withAgentPreference(undefined, CODEX_AGENT, { permission: CODEX_UNTRUSTED });
    expect(
      resolveDraftPermissionPreference({ defaults, agent: CODEX_AGENT, settingsHydrated: false })
    ).toBeUndefined();
    expect(
      resolveDraftPermissionPreference({ defaults, agent: CODEX_AGENT, settingsHydrated: true })
    ).toEqual(CODEX_UNTRUSTED);
  });

  it('C13 — every default, fallback and placeholder arm is enumerated and none is dangerous', () => {
    const arms: Array<[string, unknown]> = [
      ['factory defaults', EMPTY_CHAT_AGENT_DEFAULTS.byAgent],
      ...AGENT_WIRE_NAMES.flatMap((agent) => [
        // 1. fresh install
        [`${agent}: factory`, agentDefaultPermission(EMPTY_CHAT_AGENT_DEFAULTS, agent)] as [
          string,
          unknown,
        ],
        // 2. hydration not finished
        [
          `${agent}: unhydrated`,
          resolveDraftPermissionPreference({
            defaults: EMPTY_CHAT_AGENT_DEFAULTS,
            agent,
            settingsHydrated: false,
          }),
        ] as [string, unknown],
        // 3. hydrated but nothing stored
        [
          `${agent}: hydrated + empty`,
          resolveDraftPermissionPreference({
            defaults: EMPTY_CHAT_AGENT_DEFAULTS,
            agent,
            settingsHydrated: true,
          }),
        ] as [string, unknown],
        // 4. stored blob is corrupt (the degradation arm)
        [
          `${agent}: corrupt blob`,
          agentDefaultPermission(
            sanitizeChatAgentDefaults({ byAgent: { [agent]: { permission: { agent } } } }),
            agent
          ),
        ] as [string, unknown],
        // 5. stored under the wrong agent (the mis-addressed arm)
        [
          `${agent}: cross-agent`,
          agentDefaultPermission(
            sanitizeChatAgentDefaults({
              byAgent: {
                [agent]: {
                  permission:
                    agent === CODEX_AGENT
                      ? { agent: CLAUDE_CODE_AGENT, permissionMode: DANGEROUS_PERMISSION_MODE }
                      : {
                          agent: CODEX_AGENT,
                          approvalPolicy: 'never',
                          sandboxMode: DANGEROUS_CODEX_SANDBOX_MODE,
                        },
                },
              },
            }),
            agent
          ),
        ] as [string, unknown],
      ]),
    ];
    for (const [name, value] of arms) {
      // Every arm is an ABSENCE. Not "a safe value" — absence, which is what the
      // wire reads as "use the runtime constant". A future arm that returns a
      // real preference has to opt into being named here.
      expect([name, value]).toEqual([name, undefined]);
      expect(isDangerousPermissionPreference(value as undefined)).toBe(false);
    }
  });
});

/**
 * The draft intent layer (2026-08-25). Before it, a chat could only START under
 * the per-agent template: to open ONE chat under bypass you changed what every
 * future chat opens under, or you sent a turn under the wrong posture and
 * switched afterwards.
 */
describe('resolveDraftPermissionPreference — the draft intent outranks the template', () => {
  const template = {
    byAgent: { 'claude-code': { permission: { agent: 'claude-code', permissionMode: 'plan' } } },
  } as const;

  it('a draft pick wins over the template', () => {
    expect(
      resolveDraftPermissionPreference({
        defaults: template,
        agent: CLAUDE_CODE_AGENT,
        settingsHydrated: true,
        draft: { agent: 'claude-code', permissionMode: 'acceptEdits' },
      })
    ).toEqual({ agent: 'claude-code', permissionMode: 'acceptEdits' });
  });

  /**
   * The hydration gate guards the TEMPLATE, not the draft: the template can hold
   * factory values nobody chose, while a draft intent is by construction
   * something the user picked in this window. Waiting on settings would only
   * discard it — and on a cold-start send that is precisely when it matters.
   */
  it('a draft pick is not gated on settings hydration', () => {
    expect(
      resolveDraftPermissionPreference({
        defaults: undefined,
        agent: CLAUDE_CODE_AGENT,
        settingsHydrated: false,
        draft: { agent: 'claude-code', permissionMode: 'bypassPermissions' },
      })
    ).toEqual({ agent: 'claude-code', permissionMode: 'bypassPermissions' });
  });

  it('a draft addressed to the OTHER agent is ignored, not cross-applied', () => {
    expect(
      resolveDraftPermissionPreference({
        defaults: template,
        agent: CLAUDE_CODE_AGENT,
        settingsHydrated: true,
        draft: { agent: 'codex', approvalPolicy: 'never', sandboxMode: 'danger-full-access' },
      })
    ).toEqual({ agent: 'claude-code', permissionMode: 'plan' });
  });

  /**
   * C13 restated for the new layer: nothing here SYNTHESIZES a posture, so a
   * dangerous tier can still only arrive by having been explicitly stored — by
   * the chip's handler, which routes through the same confirmation gate as the
   * live control.
   */
  it('with no draft and no template it still emits nothing, dangerous or otherwise', () => {
    expect(
      resolveDraftPermissionPreference({
        defaults: undefined,
        agent: CLAUDE_CODE_AGENT,
        settingsHydrated: true,
        draft: undefined,
      })
    ).toBeUndefined();
  });
});
