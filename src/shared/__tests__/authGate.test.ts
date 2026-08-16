import { describe, expect, it } from 'vitest';
import {
  AUTH_GATE_SNAPSHOT_QUERY_KEY,
  AUTH_OPEN_ONBOARDING_EVENT,
  buildInitialAuthGateArg,
  deriveOnboardingEntry,
  deriveUserProfilePresentation,
  INITIAL_AUTH_GATE_ARG_PREFIX,
  parseInitialAuthGateArg,
  resolveGateDecision,
  resolveSpawnGateDecision,
} from '../authGate';
import type { AuthState } from '../types/auth';
import type { ClaudeRuntimeStatus } from '../types/claudeRuntime';

const HEALTHY_CLI = { claudeInstalled: true };
const NODE_COMPATIBLE: ClaudeRuntimeStatus = { kind: 'node-compatible' };

/** D47 S5 §1.1 — same vault -> AuthState mapping as `AuthStateService`'s (kept in lockstep by construction, verified independently by `AuthStateService.test.ts`'s own derivation table). */
function stateForVault(vault: 'ok' | 'cleared' | 'rejected' | 'locked' | 'invalid'): AuthState {
  switch (vault) {
    case 'ok':
      return { status: 'authenticated', email: 'user@jcdz.cc', remoteHealth: 'unknown' };
    case 'cleared':
      return { status: 'signed_out', lastEmail: 'user@jcdz.cc' };
    case 'rejected':
      return { status: 'credentials_invalid', reason: 'rejected', lastEmail: 'user@jcdz.cc' };
    case 'locked':
      return { status: 'locked', lastEmail: 'user@jcdz.cc' };
    case 'invalid':
      return { status: 'credentials_invalid', reason: 'corrupt', lastEmail: 'user@jcdz.cc' };
  }
}

describe('resolveGateDecision — 20-cell matrix (D47 S5 §4: flag × gate × vault)', () => {
  const VAULTS = ['ok', 'cleared', 'rejected', 'locked', 'invalid'] as const;

  type Row = {
    flag: boolean;
    gate: boolean;
    vault: (typeof VAULTS)[number];
    shell: 'loading' | 'app' | 'onboarding' | 'vscode-only' | 'detection-failed';
    onboardingReason?: 'first_run' | 'expired' | 'signed_out';
  };

  const rows: Row[] = [];
  for (const flag of [true, false]) {
    for (const gate of [true, false]) {
      for (const vault of VAULTS) {
        if (gate) {
          // Adjudicated dead corner (S5 §4): flag-on+gate-on ⇒ shell=app
          // regardless of vault. Extended here to flag-off+gate-on too — the
          // escape hatch is unconditional (matches the pre-S5
          // `SKIP_ONBOARDING_GATE` literal early-return behavior).
          rows.push({ flag, gate, vault, shell: 'app' });
          continue;
        }
        if (!flag) {
          // Adjudicated dead corner: flag-off first frame ⇒ legacy chain
          // folding, no `useManagedMode` participation. Convention for this
          // table: `legacyRegistered = (vault === 'ok')`.
          rows.push(
            vault === 'ok'
              ? { flag, gate, vault, shell: 'app' }
              : { flag, gate, vault, shell: 'onboarding', onboardingReason: 'first_run' }
          );
          continue;
        }
        // flag-on, gate-off: state-driven.
        switch (vault) {
          case 'ok':
            rows.push({ flag, gate, vault, shell: 'app' });
            break;
          case 'cleared':
            rows.push({ flag, gate, vault, shell: 'onboarding', onboardingReason: 'signed_out' });
            break;
          case 'rejected':
          case 'invalid':
            rows.push({ flag, gate, vault, shell: 'onboarding', onboardingReason: 'expired' });
            break;
          case 'locked':
            // Adjudicated dead corner: flag-on+locked ⇒ LoadingShell, never
            // the login page.
            rows.push({ flag, gate, vault, shell: 'loading' });
            break;
        }
      }
    }
  }

  it('the constructed table has exactly 20 rows', () => {
    expect(rows).toHaveLength(20);
  });

  it.each(rows)('flag=$flag gate=$gate vault=$vault -> shell=$shell', ({
    flag,
    gate,
    vault,
    shell,
    onboardingReason,
  }) => {
    const decision = resolveGateDecision({
      state: stateForVault(vault),
      managed: flag,
      skipAuthGate: gate,
      cliStatus: HEALTHY_CLI,
      runtimeStatus: NODE_COMPATIBLE,
      legacyRegistered: vault === 'ok',
    });
    expect(decision.shell).toBe(shell);
    if (onboardingReason) {
      expect(decision.onboarding?.reason).toBe(onboardingReason);
    }
  });
});

describe('resolveGateDecision — runtime detection precedence', () => {
  it('skipAuthGate short-circuits even when runtimeStatus is null (matches the pre-S5 unconditional early return)', () => {
    const decision = resolveGateDecision({
      state: { status: 'unknown' },
      managed: true,
      skipAuthGate: true,
      cliStatus: null,
      runtimeStatus: null,
      legacyRegistered: false,
    });
    expect(decision.shell).toBe('app');
  });

  it('runtimeStatus null (still detecting) -> loading', () => {
    const decision = resolveGateDecision({
      state: { status: 'authenticated', email: 'a@jcdz.cc', remoteHealth: 'unknown' },
      managed: true,
      skipAuthGate: false,
      cliStatus: null,
      runtimeStatus: null,
      legacyRegistered: true,
    });
    expect(decision.shell).toBe('loading');
  });

  it('detection-failed -> detection-failed, regardless of managed/state', () => {
    const decision = resolveGateDecision({
      state: { status: 'authenticated', email: 'a@jcdz.cc', remoteHealth: 'unknown' },
      managed: true,
      skipAuthGate: false,
      cliStatus: null,
      runtimeStatus: { kind: 'detection-failed', error: 'boom' },
      legacyRegistered: true,
    });
    expect(decision.shell).toBe('detection-failed');
  });

  it('vscode-extension-only -> vscode-only', () => {
    const decision = resolveGateDecision({
      state: { status: 'signed_out', lastEmail: null },
      managed: true,
      skipAuthGate: false,
      cliStatus: null,
      runtimeStatus: { kind: 'vscode-extension-only' },
      legacyRegistered: false,
    });
    expect(decision.shell).toBe('vscode-only');
  });

  it('mutation target ④ analogue — a null cliStatus never blocks (skip, not loading)', () => {
    const decision = resolveGateDecision({
      state: { status: 'authenticated', email: 'a@jcdz.cc', remoteHealth: 'unknown' },
      managed: true,
      skipAuthGate: false,
      cliStatus: null,
      runtimeStatus: NODE_COMPATIBLE,
      legacyRegistered: true,
    });
    expect(decision.shell).toBe('app');
  });

  it('runtimeStatus.kind "not-installed" forces onboarding even with no cliStatus at all (MainWindow.isAppMountedFor precedent — APP_MOUNTABLE_RUNTIME_KINDS excluded it)', () => {
    const decision = resolveGateDecision({
      state: { status: 'authenticated', email: 'a@jcdz.cc', remoteHealth: 'unknown' },
      managed: true,
      skipAuthGate: false,
      cliStatus: null,
      runtimeStatus: { kind: 'not-installed' },
      legacyRegistered: true,
    });
    expect(decision.shell).toBe('onboarding');
  });

  it('D47 S5 cross-check — managed+authenticated+legacyRegistered:false does not stall on Loading (Root.tsx cliStatus enablement fix)', () => {
    // Outside the 20-cell matrix on purpose: that table always ties
    // `legacyRegistered` to `vault === 'ok'` (true when authenticated). This
    // deliberately decouples them to pin the exact shape of the LoadingShell
    // deadlock Root.tsx used to hit — its `cliStatus` react-query was gated
    // `enabled: legacyRegistered` (a flag-off-only signal), so a managed +
    // authenticated user with `legacyRegistered:false` never fired the CLI
    // detection query at all, leaving `cliStatus` permanently `null` and the
    // gate stuck. The fix (`enabled: Boolean(gateQuery.data)`) lives in
    // Root.tsx, but the contract it depends on is right here:
    // `resolveGateDecision`'s managed branch must never read `legacyRegistered`
    // and must treat a null `cliStatus` as "skip the extra check", not "still
    // loading" — so this combination resolves straight to `app`.
    const decision = resolveGateDecision({
      state: { status: 'authenticated', email: 'a@jcdz.cc', remoteHealth: 'unknown' },
      managed: true,
      skipAuthGate: false,
      cliStatus: null,
      runtimeStatus: NODE_COMPATIBLE,
      legacyRegistered: false,
    });
    expect(decision.shell).toBe('app');
  });

  it('a present cliStatus with claudeInstalled:false forces onboarding even when authenticated', () => {
    const decision = resolveGateDecision({
      state: { status: 'authenticated', email: 'a@jcdz.cc', remoteHealth: 'unknown' },
      managed: true,
      skipAuthGate: false,
      cliStatus: { claudeInstalled: false },
      runtimeStatus: NODE_COMPATIBLE,
      legacyRegistered: true,
    });
    expect(decision.shell).toBe('onboarding');
    expect(decision.onboarding?.initialStep).toBe('cli-check');
  });
});

describe('deriveOnboardingEntry (D47 S5 §1.4, mutation target ⑥ — lastEmail pre-fill)', () => {
  it('signed_out with a lastEmail pre-fills register-email/signed_out', () => {
    expect(deriveOnboardingEntry({ status: 'signed_out', lastEmail: 'a@jcdz.cc' })).toEqual({
      initialStep: 'register-email',
      reason: 'signed_out',
      initialEmail: 'a@jcdz.cc',
    });
  });

  it('signed_out with lastEmail null is first_run/cli-check with an empty pre-fill', () => {
    expect(deriveOnboardingEntry({ status: 'signed_out', lastEmail: null })).toEqual({
      initialStep: 'cli-check',
      reason: 'first_run',
      initialEmail: '',
    });
  });

  it('credentials_invalid (any sub-reason) is expired/register-email, pre-filled from lastEmail', () => {
    for (const reason of ['rejected', 'corrupt', 'decrypt_failed'] as const) {
      expect(
        deriveOnboardingEntry({ status: 'credentials_invalid', reason, lastEmail: 'b@jcdz.cc' })
      ).toEqual({ initialStep: 'register-email', reason: 'expired', initialEmail: 'b@jcdz.cc' });
    }
  });

  it('credentials_invalid with lastEmail null still pre-fills an empty string, never undefined', () => {
    const entry = deriveOnboardingEntry({
      status: 'credentials_invalid',
      reason: 'corrupt',
      lastEmail: null,
    });
    expect(entry?.initialEmail).toBe('');
  });

  it('authenticated/locked/unknown never produce an onboarding entry', () => {
    expect(
      deriveOnboardingEntry({
        status: 'authenticated',
        email: 'a@jcdz.cc',
        remoteHealth: 'unknown',
      })
    ).toBeNull();
    expect(deriveOnboardingEntry({ status: 'locked', lastEmail: 'a@jcdz.cc' })).toBeNull();
    expect(deriveOnboardingEntry({ status: 'unknown' })).toBeNull();
  });
});

describe('deriveUserProfilePresentation (D47 S5 §1.4 — three-state chip)', () => {
  it('authenticated -> signed-in with its own email', () => {
    expect(
      deriveUserProfilePresentation({
        status: 'authenticated',
        email: 'a@jcdz.cc',
        remoteHealth: 'valid',
      })
    ).toEqual({ tone: 'signed-in', email: 'a@jcdz.cc' });
  });

  it('credentials_invalid and locked -> attention, carrying lastEmail', () => {
    expect(
      deriveUserProfilePresentation({
        status: 'credentials_invalid',
        reason: 'rejected',
        lastEmail: 'a@jcdz.cc',
      })
    ).toEqual({ tone: 'attention', email: 'a@jcdz.cc' });
    expect(deriveUserProfilePresentation({ status: 'locked', lastEmail: 'a@jcdz.cc' })).toEqual({
      tone: 'attention',
      email: 'a@jcdz.cc',
    });
  });

  it('signed_out -> signed-out, carrying lastEmail; unknown -> signed-out, email null', () => {
    expect(deriveUserProfilePresentation({ status: 'signed_out', lastEmail: 'a@jcdz.cc' })).toEqual(
      {
        tone: 'signed-out',
        email: 'a@jcdz.cc',
      }
    );
    expect(deriveUserProfilePresentation({ status: 'unknown' })).toEqual({
      tone: 'signed-out',
      email: null,
    });
  });
});

describe('resolveSpawnGateDecision (D47 S5 §3)', () => {
  const AUTHENTICATED: AuthState = {
    status: 'authenticated',
    email: 'a@jcdz.cc',
    remoteHealth: 'unknown',
  };
  const SIGNED_OUT: AuthState = { status: 'signed_out', lastEmail: null };
  const LOCKED: AuthState = { status: 'locked', lastEmail: 'a@jcdz.cc' };

  it('flag off always allows, regardless of state', () => {
    expect(
      resolveSpawnGateDecision({
        managed: false,
        skipAuthGate: false,
        authenticatedForSpawn: false,
        state: SIGNED_OUT,
      })
    ).toEqual({ ok: true });
  });

  it('skipAuthGate always allows even when not authenticated', () => {
    expect(
      resolveSpawnGateDecision({
        managed: true,
        skipAuthGate: true,
        authenticatedForSpawn: false,
        state: SIGNED_OUT,
      })
    ).toEqual({ ok: true });
  });

  it('managed + authenticatedForSpawn allows', () => {
    expect(
      resolveSpawnGateDecision({
        managed: true,
        skipAuthGate: false,
        authenticatedForSpawn: true,
        state: AUTHENTICATED,
      })
    ).toEqual({ ok: true });
  });

  it('managed + not authenticated rejects with a structured auth_required envelope', () => {
    const decision = resolveSpawnGateDecision({
      managed: true,
      skipAuthGate: false,
      authenticatedForSpawn: false,
      state: SIGNED_OUT,
    });
    expect(decision).toEqual({
      ok: false,
      error: { code: 'auth_required', message: expect.any(String) },
    });
  });

  it('locked gets a distinguishable message from a plain signed_out rejection', () => {
    const lockedDecision = resolveSpawnGateDecision({
      managed: true,
      skipAuthGate: false,
      authenticatedForSpawn: false,
      state: LOCKED,
    });
    const signedOutDecision = resolveSpawnGateDecision({
      managed: true,
      skipAuthGate: false,
      authenticatedForSpawn: false,
      state: SIGNED_OUT,
    });
    expect(lockedDecision.ok).toBe(false);
    expect(signedOutDecision.ok).toBe(false);
    if (!lockedDecision.ok && !signedOutDecision.ok) {
      expect(lockedDecision.error.message).not.toBe(signedOutDecision.error.message);
    }
  });
});

describe('argv build/parse pair (D47 S5 §1.3, windowTheme.ts precedent)', () => {
  it('round-trips every AuthState arm', () => {
    const states: AuthState[] = [
      { status: 'unknown' },
      { status: 'signed_out', lastEmail: null },
      { status: 'signed_out', lastEmail: 'a@jcdz.cc' },
      { status: 'authenticated', email: 'a@jcdz.cc', remoteHealth: 'unknown' },
      { status: 'authenticated', email: 'a@jcdz.cc', remoteHealth: 'valid' },
      { status: 'credentials_invalid', reason: 'rejected', lastEmail: 'a@jcdz.cc' },
      { status: 'credentials_invalid', reason: 'corrupt', lastEmail: null },
      { status: 'credentials_invalid', reason: 'decrypt_failed', lastEmail: 'a@jcdz.cc' },
      { status: 'locked', lastEmail: 'a@jcdz.cc' },
      { status: 'locked', lastEmail: null },
    ];
    for (const state of states) {
      for (const skipAuthGate of [true, false]) {
        const arg = buildInitialAuthGateArg({ skipAuthGate, state });
        expect(arg.startsWith(INITIAL_AUTH_GATE_ARG_PREFIX)).toBe(true);
        const parsed = parseInitialAuthGateArg([arg]);
        expect(parsed).toEqual({ skipAuthGate, state });
      }
    }
  });

  it('returns undefined when the arg is missing', () => {
    expect(parseInitialAuthGateArg(['--some-other-flag'])).toBeUndefined();
  });

  it('returns undefined (never throws) on a malformed/tampered arg', () => {
    expect(
      parseInitialAuthGateArg([`${INITIAL_AUTH_GATE_ARG_PREFIX}not-json-or-encoded`])
    ).toBeUndefined();
    expect(
      parseInitialAuthGateArg([`${INITIAL_AUTH_GATE_ARG_PREFIX}${encodeURIComponent('{}')}`])
    ).toBeUndefined();
    expect(
      parseInitialAuthGateArg([
        `${INITIAL_AUTH_GATE_ARG_PREFIX}${encodeURIComponent(JSON.stringify({ skipAuthGate: 'yes', state: { status: 'unknown' } }))}`,
      ])
    ).toBeUndefined();
  });

  it('finds the arg among unrelated argv entries (same-source assertion: prefix is unique and stable)', () => {
    const arg = buildInitialAuthGateArg({ skipAuthGate: false, state: { status: 'unknown' } });
    const parsed = parseInitialAuthGateArg(['/path/to/electron', '--foo=bar', arg, '--baz']);
    expect(parsed).toEqual({ skipAuthGate: false, state: { status: 'unknown' } });
  });
});

describe('cross-process constants (D47 S5 §1.4)', () => {
  it('AUTH_OPEN_ONBOARDING_EVENT and AUTH_GATE_SNAPSHOT_QUERY_KEY are stable, non-empty', () => {
    expect(AUTH_OPEN_ONBOARDING_EVENT.length).toBeGreaterThan(0);
    expect(AUTH_GATE_SNAPSHOT_QUERY_KEY.length).toBeGreaterThan(0);
  });
});
