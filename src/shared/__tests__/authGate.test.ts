import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Reused, not re-implemented: this repo already owns ONE comment stripper, and
// its doc comment enumerates five shapes in which the two-regex version people
// keep writing deletes CODE — always in the direction that makes a negative
// assertion pass. Test-only import, hence reaching across into the renderer
// tree; the helper's own header lists suites outside its directory as intended
// callers.
import { stripComments } from '../../renderer/components/chat/__tests__/stripComments';
import {
  AUTH_GATE_SNAPSHOT_QUERY_KEY,
  AUTH_OPEN_ONBOARDING_EVENT,
  buildInitialAuthGateArg,
  deriveOnboardingEntry,
  deriveUserProfilePresentation,
  deriveWelcomeEntry,
  INITIAL_AUTH_GATE_ARG_PREFIX,
  parseInitialAuthGateArg,
  resolveGateDecision,
  resolveSpawnCredentialMode,
  resolveSpawnGateDecision,
} from '../authGate';
import type { AuthState } from '../types/auth';
import type { ClaudeRuntimeStatus } from '../types/claudeRuntime';

const NODE_COMPATIBLE: ClaudeRuntimeStatus = { kind: 'installed' };

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

describe('resolveGateDecision — 20-cell matrix (A2 rev.2: entered × gate × vault)', () => {
  const VAULTS = ['ok', 'cleared', 'rejected', 'locked', 'invalid'] as const;
  /**
   * The axis that replaced `flag`/`mode`. The welcome screen is the startup
   * screen (user ruling 2026-08-27:「就是启动首屏，每次都出现」), so what decides
   * routing is not a stored preference but a session fact: has the person
   * picked a way in yet, in THIS process.
   *
   * The credential mode is absent from this table on purpose — it no longer
   * reaches the gate at all, and re-introducing it would be the very entangling
   * the ruling undid.
   */
  type Row = {
    entered: boolean;
    gate: boolean;
    vault: (typeof VAULTS)[number];
    shell:
      | 'loading'
      | 'app'
      | 'welcome'
      | 'onboarding'
      | 'runtime-unavailable'
      | 'detection-failed';
    welcomePrimary?: 'sign-in' | 'continue';
  };

  const rows: Row[] = [];
  for (const entered of [true, false]) {
    for (const gate of [true, false]) {
      for (const vault of VAULTS) {
        if (gate || entered) {
          // `gate` is the unconditional dev escape hatch; `entered` is the
          // person having already answered the screen this run. Both mean
          // "App", for every account state — including `locked`, so a keyring
          // that locks after someone is inside never yanks them back out.
          rows.push({ entered, gate, vault, shell: 'app' });
          continue;
        }
        switch (vault) {
          case 'ok':
            rows.push({ entered, gate, vault, shell: 'welcome', welcomePrimary: 'continue' });
            break;
          case 'locked':
            rows.push({ entered, gate, vault, shell: 'loading' });
            break;
          default:
            rows.push({ entered, gate, vault, shell: 'welcome', welcomePrimary: 'sign-in' });
            break;
        }
      }
    }
  }

  it('the constructed table has exactly 20 rows', () => {
    expect(rows).toHaveLength(20);
  });

  it.each(rows)('entered=$entered gate=$gate vault=$vault -> shell=$shell', ({
    entered,
    gate,
    vault,
    shell,
    welcomePrimary,
  }) => {
    const decision = resolveGateDecision({
      state: stateForVault(vault),
      entered,
      skipAuthGate: gate,
      runtimeStatus: NODE_COMPATIBLE,
    });
    expect(decision.shell).toBe(shell);
    if (welcomePrimary) {
      expect(decision.welcome?.primary).toBe(welcomePrimary);
    }
  });

  it('A2 rev.2 — a fresh run always lands on the welcome screen, whatever the account says', () => {
    // The ruling stated as one assertion: nothing about being signed in, or
    // having used the app before, may skip the screen. Only `entered` (this
    // run) and the dev escape hatch do.
    for (const vault of VAULTS) {
      if (vault === 'locked') continue; // still resolving; covered above
      const decision = resolveGateDecision({
        state: stateForVault(vault),
        entered: false,
        skipAuthGate: false,
        runtimeStatus: NODE_COMPATIBLE,
      });
      expect(decision.shell).toBe('welcome');
    }
  });
});

describe('resolveGateDecision — runtime detection precedence', () => {
  it('skipAuthGate short-circuits even when runtimeStatus is null (matches the pre-S5 unconditional early return)', () => {
    const decision = resolveGateDecision({
      state: { status: 'unknown' },
      entered: false,
      skipAuthGate: true,
      runtimeStatus: null,
    });
    expect(decision.shell).toBe('app');
  });

  it('runtimeStatus null (still detecting) -> loading', () => {
    const decision = resolveGateDecision({
      state: { status: 'authenticated', email: 'a@jcdz.cc', remoteHealth: 'unknown' },
      entered: false,
      skipAuthGate: false,
      runtimeStatus: null,
    });
    expect(decision.shell).toBe('loading');
  });

  it('detection-failed -> detection-failed, regardless of managed/state', () => {
    const decision = resolveGateDecision({
      state: { status: 'authenticated', email: 'a@jcdz.cc', remoteHealth: 'unknown' },
      entered: false,
      skipAuthGate: false,
      runtimeStatus: { kind: 'detection-failed', error: 'boom' },
    });
    expect(decision.shell).toBe('detection-failed');
  });

  it('A2 — vscode-extension-only and not-installed are ONE outcome: runtime-unavailable', () => {
    // They stopped being different facts on 2026-08-26, when
    // `ClaudeRuntimeChecker.detect()` began answering `installed` off the
    // bundled cometix cli.js first: after that, BOTH kinds are reachable only
    // when our own bundle is missing. The old `vscode-only` shell offered to
    // install a system Claude CLI, which this build never executes — an offer
    // that could not have fixed the problem it was shown for.
    for (const kind of ['vscode-extension-only', 'not-installed'] as const) {
      const decision = resolveGateDecision({
        state: { status: 'signed_out', lastEmail: null },
        entered: false,
        skipAuthGate: false,
        runtimeStatus: { kind },
      });
      expect(decision.shell).toBe('runtime-unavailable');
    }
  });

  it('A3/D65 — a healthy bundled runtime never blocks; no input can say the user lacks a system CLI', () => {
    // This replaces the retired `cliStatus` arm. It used to read "a null
    // cliStatus never blocks (skip, not loading)"; the input is gone, so the
    // property worth pinning is the one that took its place: with a healthy
    // runtime there is NO field on `ResolveGateDecisionInput` capable of
    // expressing "the user has no `claude` on their PATH", so nothing can route
    // to a CLI-install dead end. `welcome` (not `app`) is the A2 rev.2 landing
    // for a fresh run — the point here is that it is not `runtime-unavailable`.
    const decision = resolveGateDecision({
      state: { status: 'authenticated', email: 'a@jcdz.cc', remoteHealth: 'unknown' },
      entered: false,
      skipAuthGate: false,
      runtimeStatus: NODE_COMPATIBLE,
    });
    expect(decision.shell).toBe('welcome');

    // And once they are through it, the same healthy runtime mounts App.
    expect(
      resolveGateDecision({
        state: { status: 'authenticated', email: 'a@jcdz.cc', remoteHealth: 'unknown' },
        entered: true,
        skipAuthGate: false,
        runtimeStatus: NODE_COMPATIBLE,
      }).shell
    ).toBe('app');
  });

  it('runtime availability outranks a perfectly good account', () => {
    // Nothing runs without the bundled runtime, so this must beat even an
    // authenticated user with a recorded mode — otherwise App mounts onto a
    // runtime that cannot start a session.
    const decision = resolveGateDecision({
      state: { status: 'authenticated', email: 'a@jcdz.cc', remoteHealth: 'unknown' },
      entered: false,
      skipAuthGate: false,
      runtimeStatus: { kind: 'not-installed' },
    });
    expect(decision.shell).toBe('runtime-unavailable');
  });

  it('A3/D65 negative control — authGate.ts carries no system-CLI probe term anywhere in its CODE', () => {
    // The behavioural arms above can only prove that the term is not reachable
    // through the inputs they happen to pass. This one proves it is not in the
    // module at all, so re-introducing `cliStatus` (or reading `claudeInstalled`
    // off some other carrier) fails here rather than silently restoring the
    // defect D65 retired.
    //
    // ⚠️ Comments are stripped FIRST, and that is load-bearing, not tidiness:
    // `resolveGateDecision`'s own doc block explains the retirement by naming
    // `cliStatus.claudeInstalled` and `CliDetector` in prose. Scanning the raw
    // file would match that explanation and fail on a correct implementation —
    // the self-inflicted red this repo has hit three times before (0820 batch
    // §16: "负向源码断言必须剥注释").
    const path = fileURLToPath(new URL('../authGate.ts', import.meta.url));
    const code = stripComments(readFileSync(path, 'utf8'), path);

    // Guard the guard: the strip BLANKS rather than deletes, so length never
    // changes and cannot be used to ask "did this do anything". Pin a token
    // that must survive instead, or an over-reaching strip would make every
    // assertion below pass vacuously.
    expect(code).toContain('resolveGateDecision');

    for (const term of ['cliStatus', 'claudeInstalled', 'CliDetector', 'detectOne']) {
      expect(code).not.toContain(term);
    }
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

  it('A2 — signed_out with no lastEmail is first_run/register-email with an empty pre-fill', () => {
    // Was `cli-check` until A2 retired that step: the sign-in sub-flow now
    // starts at the email field, and the welcome screen is what sits in front
    // of it.
    expect(deriveOnboardingEntry({ status: 'signed_out', lastEmail: null })).toEqual({
      initialStep: 'register-email',
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

describe('deriveWelcomeEntry (A2) — which primary button the welcome screen shows', () => {
  it('authenticated offers Continue, carrying the account it would continue with', () => {
    // The user's own words: 「如果用户登录过，则理应无需 log in」. The email is
    // part of the contract, not decoration — `Continue as <email>` is what
    // makes it obvious WHICH account is about to be used.
    expect(
      deriveWelcomeEntry({ status: 'authenticated', email: 'a@jcdz.cc', remoteHealth: 'unknown' })
    ).toEqual({ primary: 'continue', email: 'a@jcdz.cc', notice: null });
  });

  it('signed_out offers Sign in and carries no email', () => {
    expect(deriveWelcomeEntry({ status: 'signed_out', lastEmail: 'a@jcdz.cc' })).toEqual({
      primary: 'sign-in',
      email: null,
      notice: null,
    });
  });

  it('credentials_invalid offers Sign in with an expired notice — NOT Continue', () => {
    // All four sub-reasons fold into one user-facing fact, matching
    // `deriveOnboardingEntry`. `continue` would be a lie here: there is
    // nothing usable to continue with, which is exactly why the email is
    // dropped even though `lastEmail` is known.
    for (const reason of [
      'rejected',
      'corrupt',
      'decrypt_failed',
      'migration_incomplete',
    ] as const) {
      expect(
        deriveWelcomeEntry({ status: 'credentials_invalid', reason, lastEmail: 'a@jcdz.cc' })
      ).toEqual({
        primary: 'sign-in',
        email: null,
        notice: 'expired',
      });
    }
  });

  it('locked and unknown are not answers yet, so they produce no entry', () => {
    // Returning an entry here would put a button on screen and then swap it
    // when the keyring unlocks. The gate holds `loading` for both instead.
    expect(deriveWelcomeEntry({ status: 'locked', lastEmail: 'a@jcdz.cc' })).toBeNull();
    expect(deriveWelcomeEntry({ status: 'unknown' })).toBeNull();
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

  it('local mode always allows, regardless of state', () => {
    // `managed:false` is `credentialMode === 'local'` since D64 (it was the
    // build-time flag being off before that). The meaning here is unchanged
    // and is the point of the second welcome button: we inject nothing, so
    // there is no account for a spawn to require.
    expect(
      resolveSpawnGateDecision({
        entryMode: null,
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
        entryMode: null,
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
        entryMode: null,
        managed: true,
        skipAuthGate: false,
        authenticatedForSpawn: true,
        state: AUTHENTICATED,
      })
    ).toEqual({ ok: true });
  });

  it('managed + not authenticated rejects with a structured auth_required envelope', () => {
    const decision = resolveSpawnGateDecision({
      entryMode: null,
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
      entryMode: null,
      managed: true,
      skipAuthGate: false,
      authenticatedForSpawn: false,
      state: LOCKED,
    });
    const signedOutDecision = resolveSpawnGateDecision({
      entryMode: null,
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
  // T-A2b — the entry, not the stored mode, decides. Every case above leaves
  // `entryMode: null` (a spawn racing the welcome screen), which is the only
  // situation where `managed` still answers.
  it('a run entered on `Use my own setup` allows, even while the file still says managed', () => {
    // The exact shape that broke on a real machine: the welcome screen wrote
    // `local`, a renderer settings save put `managed` back, and every action
    // answered "sign-in required" with nothing to click.
    expect(
      resolveSpawnGateDecision({
        entryMode: 'local',
        managed: true,
        skipAuthGate: false,
        authenticatedForSpawn: false,
        state: SIGNED_OUT,
      })
    ).toEqual({ ok: true });
  });

  it('a run entered on the company account still requires that account', () => {
    // The boundary the change must NOT dissolve: signing out mid-run has to go
    // on rejecting spawns, or a logged-out user silently keeps working on
    // whatever credentials their own machine happens to hold.
    const decision = resolveSpawnGateDecision({
      entryMode: 'managed',
      managed: false,
      skipAuthGate: false,
      authenticatedForSpawn: false,
      state: SIGNED_OUT,
    });
    expect(decision).toEqual({
      ok: false,
      error: { code: 'auth_required', message: expect.any(String) },
    });
  });

  it('resolveSpawnCredentialMode: the entry wins, the recorded mode only stands in', () => {
    expect(resolveSpawnCredentialMode({ entryMode: 'local', managed: true })).toBe('local');
    expect(resolveSpawnCredentialMode({ entryMode: 'managed', managed: false })).toBe('managed');
    expect(resolveSpawnCredentialMode({ entryMode: null, managed: true })).toBe('managed');
    expect(resolveSpawnCredentialMode({ entryMode: null, managed: false })).toBe('local');
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
