import { CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  SESSION_PERMISSION_MODES,
  type SessionPermissionPolicy,
  type SessionPermissionPreference,
} from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import { decidePermissionTemplateAction } from '@/components/settings/chatPermissionDefaults';
import {
  type ComposerPermissionInput,
  decideLivePermissionAction,
  deriveComposerPermission,
  LIVE_DANGEROUS_CONFIRM_BODY,
  LIVE_DANGEROUS_TIER_WARNING,
  NON_USER_CHOSEN_LIVE_ARMS,
  nextLivePreference,
  PERMISSION_SCOPE_HINT_CLAUDE,
  PERMISSION_SCOPE_HINT_CODEX,
  PERMISSION_TIER_JOINER,
  permissionChangeSettled,
  permissionScopeHint,
  permissionTierLabelKeys,
  projectEchoedPreference,
  samePermissionPreference,
} from '../composerPermissionModel';

/**
 * D48 S4 §6.5 — the renderer half of the D series (D2 · D7 · D12 · D13 · D15),
 * plus the idle gate's UI half (D8).
 *
 * The failures this suite exists for are all one shape: a control that says a
 * chat is more constrained than it is. A chip that paints its own request before
 * the runtime confirmed it, a dangerous tier that reaches the wire without the
 * dialog, a change that silently rewrites the template for every future chat, a
 * control that goes dead the moment a chat is established — each one either
 * misreports a security posture or removes the feature the whole slice exists
 * for.
 */

/**
 * The component's own composition, mirrored: translate every part, THEN join.
 * `t()` is identity here because this suite runs the English table — what is
 * being pinned is the assembled reading, which is what a user sees.
 */
function tierText(keys: readonly string[]): string {
  return keys.join(PERMISSION_TIER_JOINER);
}

function pendingText(
  pending: { template: string; tierKeys: readonly string[] } | null
): string | null {
  return pending ? pending.template.replace('{{tier}}', tierText(pending.tierKeys)) : null;
}

const CLAUDE_DEFAULT: SessionPermissionPreference = {
  agent: 'claude-code',
  permissionMode: 'default',
};
const CLAUDE_PLAN: SessionPermissionPreference = { agent: 'claude-code', permissionMode: 'plan' };
const CLAUDE_BYPASS: SessionPermissionPreference = {
  agent: 'claude-code',
  permissionMode: 'bypassPermissions',
};
const CODEX_PAIR: SessionPermissionPreference = {
  agent: 'codex',
  approvalPolicy: 'on-request',
  sandboxMode: 'workspace-write',
};
const CODEX_DANGER: SessionPermissionPreference = {
  agent: 'codex',
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
};

const CLAUDE_POLICY: SessionPermissionPolicy = { agent: 'claude-code', permissionMode: 'plan' };
const CODEX_POLICY: SessionPermissionPolicy = {
  agent: 'codex',
  approvalPolicy: 'on-request',
  sandboxMode: 'workspace-write',
  networkAccess: true,
};

/** An established, idle Claude session on a Host that reports the capability. */
function input(overrides: Partial<ComposerPermissionInput> = {}): ComposerPermissionInput {
  return {
    sessionId: 's1',
    agent: CLAUDE_CODE_AGENT,
    capabilityPermissionPolicy: true,
    hostState: 'ready',
    facts: { permissionMode: 'default' },
    pending: null,
    inFlight: false,
    busy: false,
    sending: false,
    disabled: false,
    ...overrides,
  };
}

/** Every tier this build can express, both arms — the vocabulary the gates walk. */
function everyPreference(): SessionPermissionPreference[] {
  const claude = SESSION_PERMISSION_MODES.map(
    (permissionMode) => ({ agent: 'claude-code', permissionMode }) as SessionPermissionPreference
  );
  const codex = CODEX_APPROVAL_POLICIES.flatMap((approvalPolicy) =>
    CODEX_SANDBOX_MODES.map(
      (sandboxMode) =>
        ({ agent: 'codex', approvalPolicy, sandboxMode }) as SessionPermissionPreference
    )
  );
  return [...claude, ...codex];
}

describe('D2 — the two axes get two sentences, and neither may be softened', () => {
  it('the Claude copy promises the NEXT message and the Codex copy promises now', () => {
    expect(PERMISSION_SCOPE_HINT_CLAUDE).toContain('next message');
    expect(PERMISSION_SCOPE_HINT_CODEX).toContain('immediately');
    // The failure this pins is a shared constant: one sentence for both axes
    // means one of the two axes is being lied to about when its tier applies.
    expect(PERMISSION_SCOPE_HINT_CLAUDE).not.toBe(PERMISSION_SCOPE_HINT_CODEX);
    // And the Claude half must not have acquired the Codex promise.
    expect(PERMISSION_SCOPE_HINT_CLAUDE).not.toContain('immediately');
  });

  it('the hint is routed per agent, not per anything else', () => {
    expect(permissionScopeHint(CODEX_AGENT)).toBe(PERMISSION_SCOPE_HINT_CODEX);
    expect(permissionScopeHint(CLAUDE_CODE_AGENT)).toBe(PERMISSION_SCOPE_HINT_CLAUDE);
  });

  it('the view carries its own axis copy on both arms', () => {
    expect(deriveComposerPermission(input()).scopeHint).toBe(PERMISSION_SCOPE_HINT_CLAUDE);
    expect(
      deriveComposerPermission(
        input({ agent: CODEX_AGENT, facts: { permissionPolicy: CODEX_POLICY } })
      ).scopeHint
    ).toBe(PERMISSION_SCOPE_HINT_CODEX);
  });
});

describe('D15 — the capability gate hides the control, it does not grey it out', () => {
  it('an old Host that never reports permissionPolicy gets NO control', () => {
    for (const capabilityPermissionPolicy of [undefined, false]) {
      const view = deriveComposerPermission(input({ capabilityPermissionPolicy }));
      expect(view.rendered).toBe(false);
      expect(view.hiddenReason).toBe('capability_absent');
      // Not "rendered and disabled": there is no tier to show and no menu to
      // open, so nothing about the control can be reached.
      expect(view.sections).toEqual([]);
      expect(view.current).toBeNull();
    }
  });

  it('the same session on a Host that DOES report it gets the control', () => {
    const view = deriveComposerPermission(input());
    expect(view.rendered).toBe(true);
    expect(view.hiddenReason).toBeNull();
  });
});

describe('D7 — the chip shows the echo, never the request', () => {
  it('no echo, no control: an unsent draft has no posture to change', () => {
    for (const facts of [undefined, {}, { permissionPolicy: undefined }]) {
      const view = deriveComposerPermission(input({ facts }));
      expect(view.rendered).toBe(false);
      expect(view.hiddenReason).toBe('no_echo');
    }
  });

  it('the label is the echoed tier on both axes', () => {
    expect(
      tierText(deriveComposerPermission(input({ facts: { permissionMode: 'plan' } })).labelKeys)
    ).toBe('Plan');
    expect(
      tierText(
        deriveComposerPermission(
          input({ agent: CODEX_AGENT, facts: { permissionPolicy: CODEX_POLICY } })
        ).labelKeys
      )
    ).toBe('on-request · workspace-write');
  });

  it('an ACCEPTED change that the facts have not confirmed is a marker BESIDE the tier, never instead of it', () => {
    const view = deriveComposerPermission(
      input({
        facts: { permissionMode: 'default' },
        pending: { sessionId: 's1', preference: CLAUDE_PLAN, effective: 'next_turn' },
      })
    );
    // The failure: painting `Plan` here. The runtime has not said `Plan` yet —
    // on the Claude axis it will not until the next turn's created/resumed
    // echo — and a chip that reads `Plan` is a chip claiming a constraint that
    // is not in force.
    expect(tierText(view.labelKeys)).toBe('Default');
    expect(view.current).toEqual(CLAUDE_DEFAULT);
    expect(pendingText(view.pendingLabel)).toBe('Plan from your next message');
  });

  it('the Codex marker says pending, not next message — the thread takes it without one', () => {
    const view = deriveComposerPermission(
      input({
        agent: CODEX_AGENT,
        facts: { permissionPolicy: CODEX_POLICY },
        pending: { sessionId: 's1', preference: CODEX_DANGER, effective: 'immediately' },
      })
    );
    expect(tierText(view.labelKeys)).toBe('on-request · workspace-write');
    expect(pendingText(view.pendingLabel)).toBe('never · danger-full-access pending');
  });

  it('an in-flight request shows as applying, and the tier still does not move', () => {
    const view = deriveComposerPermission(input({ inFlight: true }));
    expect(tierText(view.labelKeys)).toBe('Default');
    expect(pendingText(view.pendingLabel)).toBe('applying…');
  });

  it("a pending marker for ANOTHER session is not this session's", () => {
    const view = deriveComposerPermission(
      input({ pending: { sessionId: 'other', preference: CLAUDE_PLAN, effective: 'next_turn' } })
    );
    expect(view.pendingLabel).toBeNull();
  });

  it('permissionChangeSettled flips on the FACTS, which is when the marker is dropped', () => {
    const pending = { sessionId: 's1', preference: CLAUDE_PLAN, effective: 'next_turn' } as const;
    expect(permissionChangeSettled(CLAUDE_CODE_AGENT, { permissionMode: 'default' }, pending)).toBe(
      false
    );
    expect(permissionChangeSettled(CLAUDE_CODE_AGENT, { permissionMode: 'plan' }, pending)).toBe(
      true
    );
    // A settled change stops being a marker even though `pending` is still set —
    // the view compares against the facts rather than trusting the flag.
    const view = deriveComposerPermission(input({ facts: { permissionMode: 'plan' }, pending }));
    expect(view.pendingLabel).toBeNull();
  });

  it('the Claude marker settles on the axis own echo, not only on a created/resumed payload', () => {
    // The producer half is `session.settingsEcho` from `claudeRuntime.send()`
    // (created/resumed fire once per Host session and cannot restate a later
    // change), and the fold writes it into `permissionPolicy` rather than the
    // legacy `permissionMode`. So the settle check has to see it THERE, or the
    // chip keeps a pending marker no event will ever clear.
    const pending = { sessionId: 's1', preference: CLAUDE_PLAN, effective: 'next_turn' } as const;
    const echoedFacts = {
      permissionMode: 'default' as const,
      permissionPolicy: { agent: 'claude-code', permissionMode: 'plan' } as SessionPermissionPolicy,
    };
    expect(permissionChangeSettled(CLAUDE_CODE_AGENT, echoedFacts, pending)).toBe(true);
    const view = deriveComposerPermission(input({ facts: echoedFacts, pending }));
    expect(view.pendingLabel).toBeNull();
    expect(tierText(view.labelKeys)).toBe('Plan');
  });

  it('the projection targets the REQUEST type, so networkAccess cannot survive it (C8, live half)', () => {
    const projected = projectEchoedPreference(CODEX_AGENT, { permissionPolicy: CODEX_POLICY });
    expect(projected).toEqual({
      agent: 'codex',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
    });
    expect(projected && 'networkAccess' in projected).toBe(false);
  });

  it('a policy for the OTHER agent is not a posture for this session', () => {
    expect(
      projectEchoedPreference(CODEX_AGENT, { permissionPolicy: CLAUDE_POLICY })
    ).toBeUndefined();
    // The Claude arm has a second, legacy carrier and prefers the policy when
    // both are there — the same precedence S3 pinned on the wire.
    expect(
      projectEchoedPreference(CLAUDE_CODE_AGENT, {
        permissionMode: 'default',
        permissionPolicy: CLAUDE_POLICY,
      })
    ).toEqual(CLAUDE_PLAN);
    expect(
      projectEchoedPreference(CLAUDE_CODE_AGENT, { permissionPolicy: CODEX_POLICY })
    ).toBeUndefined();
  });
});

describe('D8 (UI half) — the idle gate, and what it says when it closes', () => {
  it('an idle, established session on a ready Host is editable', () => {
    const view = deriveComposerPermission(input());
    expect(view.disabled).toBe(false);
    expect(view.disabledReason).toBeNull();
  });

  it.each([
    ['busy', { busy: true }, 'A turn is running'],
    ['sending', { sending: true }, 'A turn is running'],
    ['host not ready', { hostState: 'starting' as const }, 'Agent Host is not ready'],
    ['composer kill switch', { disabled: true }, 'nowhere to run'],
    ['a change already in flight', { inFlight: true }, 'already on its way'],
  ])('%s closes the gate and says why', (_name, overrides, reason) => {
    const view = deriveComposerPermission(input(overrides));
    expect(view.rendered).toBe(true);
    expect(view.disabled).toBe(true);
    expect(view.disabledReason).toContain(reason);
    // The title is a TEMPLATE now; the reason reaches it through `{{reason}}`,
    // which is what keeps the tooltip translatable (D-i18n).
    expect(view.titleTemplate).toContain('{{reason}}');
    expect(
      view.titleTemplate
        .replace('{{tier}}', tierText(view.labelKeys))
        .replace('{{reason}}', view.disabledReason ?? '')
    ).toContain(reason);
  });
});

describe('D13 — the permission gate is NOT the agent-binding lock', () => {
  it('a session that is long since bound (the case the picker locks) is still editable', () => {
    // The picker's lock is `sendAttempted || hostBound || runtimeIdentity != null`;
    // an established session is true on all three. It is also the ONLY kind of
    // session this control renders for — there is no echo before the first send —
    // so "locked" and "editable" is not an edge case here, it is the norm.
    const view = deriveComposerPermission(
      input({ facts: { permissionMode: 'acceptEdits' }, busy: false, sending: false })
    );
    expect(view.rendered).toBe(true);
    expect(view.disabled).toBe(false);
  });

  it('no binding-lock symbol is reachable from this model at all', () => {
    // A structural half to go with the behavioural one above: the derivation
    // takes no lock-shaped input, so a future edit cannot quietly consult one
    // without changing the signature. Mutation ⑬ is exactly that edit.
    const keys = Object.keys(input());
    for (const forbidden of [
      'locked',
      'agentBindingLocked',
      'sendAttempted',
      'hostBound',
      'hasRuntimeIdentity',
      'runtimeIdentity',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('D12 — the dangerous-tier gate, and the two layers agreeing on it', () => {
  it('both dangerous tiers are held for confirmation, every other tier applies', () => {
    for (const preference of everyPreference()) {
      const dangerous =
        ('permissionMode' in preference && preference.permissionMode === 'bypassPermissions') ||
        (!('permissionMode' in preference) && preference.sandboxMode === 'danger-full-access');
      expect(decideLivePermissionAction(preference).kind).toBe(dangerous ? 'confirm' : 'apply');
    }
  });

  it('the LIVE gate and the TEMPLATE gate reach the same verdict for every tier', () => {
    // 两层同口径, as an assertion rather than as a review habit: the two layers
    // are separate functions (the live one may not import the settings module at
    // all — see `pureModuleImports`), and a build where a tier is dangerous in
    // Settings and plain in the Composer is a build where the second
    // confirmation depends on which control the user happened to open.
    for (const preference of everyPreference()) {
      expect(decideLivePermissionAction(preference).kind).toBe(
        decidePermissionTemplateAction(preference).kind
      );
    }
  });

  it('the held value is the requested one, unmodified — no softening on the way to the dialog', () => {
    expect(decideLivePermissionAction(CLAUDE_BYPASS)).toEqual({
      kind: 'confirm',
      preference: CLAUDE_BYPASS,
    });
    expect(decideLivePermissionAction(CODEX_DANGER)).toEqual({
      kind: 'confirm',
      preference: CODEX_DANGER,
    });
  });

  it('every value this layer can produce without a user pick is enumerated, and none is dangerous', () => {
    expect(NON_USER_CHOSEN_LIVE_ARMS.length).toBeGreaterThan(0);
    for (const arm of NON_USER_CHOSEN_LIVE_ARMS) {
      // They are all `undefined` on purpose: the live layer has no default tier
      // to get wrong. An edit that introduced one would have to add an entry
      // here, and the check below would meet it.
      expect(arm.preference, arm.arm).toBeUndefined();
    }
  });

  it('the permanent warning names both tiers and promises no way back', () => {
    expect(LIVE_DANGEROUS_TIER_WARNING).toContain('Bypass permissions');
    expect(LIVE_DANGEROUS_TIER_WARNING).toContain('danger-full-access');
    expect(LIVE_DANGEROUS_TIER_WARNING).not.toMatch(/revert|undo|any time|reversib/i);
  });

  it('the confirmation body states the D11 boundary out loud', () => {
    // The user is told, at the moment of confirming, that this does NOT become
    // the default for future chats — which is the behaviour D11 pins in code.
    expect(LIVE_DANGEROUS_CONFIRM_BODY).toMatch(/only this chat/i);
  });

  it('a dangerous tier is dangerous no matter which dimension the finger moved', () => {
    // Changing the approval policy of a chat already on `danger-full-access`
    // produces a dangerous posture, so it asks again. The gate reads the posture
    // being requested, not the dimension that changed.
    const next = nextLivePreference(CODEX_DANGER, { approvalPolicy: 'untrusted' });
    expect(next).toEqual({
      agent: 'codex',
      approvalPolicy: 'untrusted',
      sandboxMode: 'danger-full-access',
    });
    expect(next && decideLivePermissionAction(next).kind).toBe('confirm');
  });
});

describe('nextLivePreference — one pick, against the tier the runtime reports', () => {
  it('a Claude pick replaces the mode', () => {
    expect(nextLivePreference(CLAUDE_DEFAULT, { permissionMode: 'plan' })).toEqual(CLAUDE_PLAN);
  });

  it('a Codex pick keeps the companion dimension from the ECHO, not from a constant', () => {
    expect(nextLivePreference(CODEX_PAIR, { approvalPolicy: 'never' })).toEqual({
      agent: 'codex',
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
    });
    expect(nextLivePreference(CODEX_PAIR, { sandboxMode: 'read-only' })).toEqual({
      agent: 'codex',
      approvalPolicy: 'on-request',
      sandboxMode: 'read-only',
    });
  });

  it('an unrecognized value is refused, never coerced', () => {
    expect(nextLivePreference(CLAUDE_DEFAULT, { permissionMode: 'auto' })).toBeUndefined();
    expect(nextLivePreference(CODEX_PAIR, { approvalPolicy: 'yolo' })).toBeUndefined();
    expect(nextLivePreference(CODEX_PAIR, { sandboxMode: 'full-access' })).toBeUndefined();
  });

  it('a cross-arm pick is refused on both sides', () => {
    expect(nextLivePreference(CLAUDE_DEFAULT, { sandboxMode: 'read-only' })).toBeUndefined();
    expect(nextLivePreference(CODEX_PAIR, { permissionMode: 'plan' })).toBeUndefined();
  });

  it('an empty patch changes nothing and stays comparable to the current tier', () => {
    const next = nextLivePreference(CODEX_PAIR, {});
    expect(samePermissionPreference(next, CODEX_PAIR)).toBe(true);
  });
});

describe('permissionTierLabelKeys / samePermissionPreference', () => {
  it('labels come from the shared tier table, and Codex shows the pair', () => {
    expect(tierText(permissionTierLabelKeys(CLAUDE_BYPASS))).toBe('Bypass permissions');
    expect(tierText(permissionTierLabelKeys(CODEX_DANGER))).toBe('never · danger-full-access');
    // Keys, not a sentence: the join happens after `t()` in the component, so a
    // Chinese UI gets a Chinese chip rather than an English one (D-i18n).
    expect(permissionTierLabelKeys(CODEX_DANGER)).toEqual(['never', 'danger-full-access']);
  });

  it('equality is by value and never crosses arms', () => {
    expect(
      samePermissionPreference(CLAUDE_PLAN, { agent: 'claude-code', permissionMode: 'plan' })
    ).toBe(true);
    expect(samePermissionPreference(CLAUDE_PLAN, CLAUDE_DEFAULT)).toBe(false);
    expect(samePermissionPreference(CODEX_PAIR, CLAUDE_PLAN)).toBe(false);
    expect(samePermissionPreference(undefined, undefined)).toBe(true);
    expect(samePermissionPreference(CODEX_PAIR, undefined)).toBe(false);
  });
});

describe('the dangerous tier is visible in the menu before it is picked', () => {
  it('the menu marks exactly the two dangerous tiers, on the arm that has them', () => {
    const claude = deriveComposerPermission(input());
    const claudeItems = claude.sections.flatMap((section) => section.items);
    expect(claudeItems.filter((item) => item.dangerous).map((item) => item.id)).toEqual([
      'bypassPermissions',
    ]);

    const codex = deriveComposerPermission(
      input({ agent: CODEX_AGENT, facts: { permissionPolicy: CODEX_POLICY } })
    );
    expect(codex.sections.map((section) => section.id)).toEqual(['approvalPolicy', 'sandboxMode']);
    expect(
      codex.sections
        .flatMap((section) => section.items.filter((item) => item.dangerous))
        .map((item) => item.id)
    ).toEqual(['danger-full-access']);
  });

  it('a dangerous tier that has been ACCEPTED flags the chip before the echo lands', () => {
    // The label still says `Default` — the runtime has not reported the new
    // tier and D7 forbids painting it. But the chip must already read as
    // dangerous: between the confirmation and the echo the chat is on its way
    // to having no sandbox, and on the Claude axis that window is at least a
    // whole turn. Under-reporting danger is the one direction this control must
    // never be wrong in.
    const view = deriveComposerPermission(
      input({
        facts: { permissionMode: 'default' },
        pending: { sessionId: 's1', preference: CLAUDE_BYPASS, effective: 'next_turn' },
      })
    );
    expect(tierText(view.labelKeys)).toBe('Default');
    expect(view.dangerousActive).toBe(true);
    // A pending SAFE tier does not flag anything, and neither does another
    // session's pending change.
    expect(
      deriveComposerPermission(
        input({ pending: { sessionId: 's1', preference: CLAUDE_PLAN, effective: 'next_turn' } })
      ).dangerousActive
    ).toBe(false);
    expect(
      deriveComposerPermission(
        input({
          pending: { sessionId: 'other', preference: CLAUDE_BYPASS, effective: 'next_turn' },
        })
      ).dangerousActive
    ).toBe(false);
  });

  it('the currently-echoed tier is the selected one, and a dangerous current tier is flagged', () => {
    const view = deriveComposerPermission(
      input({ facts: { permissionMode: 'bypassPermissions' } })
    );
    expect(view.dangerousActive).toBe(true);
    expect(view.sections[0].items.filter((item) => item.selected).map((item) => item.id)).toEqual([
      'bypassPermissions',
    ]);
    expect(deriveComposerPermission(input()).dangerousActive).toBe(false);
  });
});
