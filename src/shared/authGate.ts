/**
 * D47 S5 §1.4 — shared, Electron-free gate-decision pure functions. Root
 * (renderer) and `MainWindow.isAppMountedFor` (Main, close-confirm) call the
 * SAME `resolveGateDecision` — "换服务两处同变" goes from a comment to a
 * static/runtime-testable fact. The spawn gate (`main/ipc/chat.ts` /
 * `SessionManager.create`) uses `resolveSpawnGateDecision`, built on the same
 * `AuthState` DTO. `deriveOnboardingEntry` / `deriveUserProfilePresentation`
 * are the smaller sibling pure functions §1.4 calls out by name — consumed by
 * OnboardingShell/OnboardingView (pre-fill + reason) and
 * WindowTitleBar/UserProfileCard (the three-state chip) respectively.
 */

import type { AuthState } from './types/auth';
import type { ClaudeRuntimeStatus } from './types/claudeRuntime';

// ---------------------------------------------------------------------------
// resolveGateDecision
// ---------------------------------------------------------------------------

export type AuthGateShell = 'loading' | 'app' | 'onboarding' | 'vscode-only' | 'detection-failed';

/** Mirrors `OnboardingView.tsx`'s local `Step` union structurally — shared code cannot import a renderer-local type, so this is the shared vocabulary S5b's OnboardingView maps 1:1 onto. */
export type AuthGateOnboardingStep =
  | 'cli-check'
  | 'cli-install'
  | 'register-email'
  | 'register-code'
  | 'result';

export type AuthGateOnboardingReason = 'first_run' | 'expired' | 'signed_out';

export interface AuthGateOnboardingEntry {
  initialStep: AuthGateOnboardingStep;
  reason: AuthGateOnboardingReason;
  initialEmail: string;
}

/** Minimal slice of `OnboardingCliStatus` this module actually reads. */
export interface AuthGateCliStatus {
  claudeInstalled: boolean;
}

export interface ResolveGateDecisionInput {
  /** Current `AuthState` (from `AuthStateService`, or the argv-delivered initial snapshot). Ignored when `managed` is false — see `legacyRegistered`. */
  state: AuthState;
  /** `resolveManagedCredentialsEnabled()`. */
  managed: boolean;
  /** `resolveSkipAuthGate({env, isPackaged})` — the dev/team-track escape hatch. */
  skipAuthGate: boolean;
  /** `null` while still detecting. Only `claudeInstalled` is read. */
  cliStatus: AuthGateCliStatus | null;
  /** `null` while still detecting. */
  runtimeStatus: ClaudeRuntimeStatus | null;
  /**
   * Flag-off legacy gate signal — folds `onboardingService.checkRegistration().registered`
   * AND a healthy `checkCredentialsHealth()` into one boolean (computed by the
   * `auth.getGateSnapshot` IPC handler; S5 spec §1.2 "折算只在 IPC handler
   * 层，不改 OnboardingService 方法体"). Ignored when `managed` is true.
   */
  legacyRegistered: boolean;
}

export interface GateDecision {
  shell: AuthGateShell;
  /** Present only when `shell === 'onboarding'`. */
  onboarding?: AuthGateOnboardingEntry;
}

/**
 * D47 S5 §1.1/§4 / D47 S6 §1.4 — `credentials_invalid`'s four sub-reasons
 * (`rejected` / `corrupt` / `decrypt_failed` / `migration_incomplete`) all
 * read as onboarding reason `'expired'`: the user-facing distinction that
 * matters is "your session needs re-verifying", not which internal failure
 * mode produced it. `migration_incomplete`'s `lastEmail` (legacy-email
 * prefill, S6 §1.4) flows through the existing `state.lastEmail ?? ''` below
 * unchanged — no separate branch needed.
 */
export function deriveOnboardingEntry(state: AuthState): AuthGateOnboardingEntry | null {
  switch (state.status) {
    case 'signed_out':
      return state.lastEmail
        ? { initialStep: 'register-email', reason: 'signed_out', initialEmail: state.lastEmail }
        : { initialStep: 'cli-check', reason: 'first_run', initialEmail: '' };
    case 'credentials_invalid':
      return {
        initialStep: 'register-email',
        reason: 'expired',
        initialEmail: state.lastEmail ?? '',
      };
    case 'authenticated':
    case 'locked':
    case 'unknown':
      return null;
  }
}

/**
 * D47 S5 §1.4 — priority order, top to bottom:
 *  1. `skipAuthGate` — the escape hatch bypasses EVERYTHING unconditionally,
 *     including runtime detection (matches the pre-S5 `SKIP_ONBOARDING_GATE`
 *     literal behavior: `if (SKIP_ONBOARDING_GATE) return <SkippedOnboardingApp/>`
 *     ran before any query in `Root.tsx`).
 *  2. Runtime detection state (`loading` / `detection-failed` / `vscode-only`)
 *     — a hard blocker regardless of managed/legacy auth state, both flows
 *     need the CLI runtime to exist before App can mount.
 *  3. `managed` ? `state`-driven five-arm branch : `legacyRegistered`-driven
 *     two-branch (S5 §4: "flag-off 首帧 ⇒ argv 快照走旧链折算，无
 *     useManagedMode 参与").
 */
export function resolveGateDecision(input: ResolveGateDecisionInput): GateDecision {
  if (input.skipAuthGate) {
    return { shell: 'app' };
  }
  if (input.runtimeStatus === null) {
    return { shell: 'loading' };
  }
  if (input.runtimeStatus.kind === 'detection-failed') {
    return { shell: 'detection-failed' };
  }
  if (input.runtimeStatus.kind === 'vscode-extension-only') {
    return { shell: 'vscode-only' };
  }

  // `runtimeStatus.kind === 'not-installed'` is the authoritative "no usable
  // Claude Code" signal (matches the pre-S5 `MainWindow.ts`
  // `APP_MOUNTABLE_RUNTIME_KINDS` set, which excluded it from "mounted" —
  // only `node-compatible`/`bun-incompatible` counted). `cliStatus` is a
  // SECOND, purely ADDITIVE check on top of that: `null` (not yet detected,
  // or a caller — e.g. `MainWindow.isAppMountedFor`, which has no cheap
  // synchronous way to obtain it — that never supplies one at all) means
  // "skip this extra check", not "still loading". This is the A-track M4
  // "cliStatus 分叉...一并收敛" fix: `cliStatus.claudeInstalled` only adds the
  // narrower self-heal case of "was registered, CLI got removed since" when a
  // caller has that signal on hand.
  const cliMissing =
    input.runtimeStatus.kind === 'not-installed' ||
    (input.cliStatus !== null && !input.cliStatus.claudeInstalled);
  const cliCheckEntry: AuthGateOnboardingEntry = {
    initialStep: 'cli-check',
    reason: 'first_run',
    initialEmail: '',
  };

  if (!input.managed) {
    if (!input.legacyRegistered || cliMissing) {
      return { shell: 'onboarding', onboarding: cliCheckEntry };
    }
    return { shell: 'app' };
  }

  switch (input.state.status) {
    case 'unknown':
    case 'locked':
      // `locked` (D47 S5 §1.1 rev.2 self-correction): a merely-locked keyring
      // is not "signed out" — Root shows LoadingShell and waits for the next
      // `auth.stateChanged` to promote once unlocked, never routes to
      // onboarding.
      return { shell: 'loading' };
    case 'authenticated':
      return cliMissing ? { shell: 'onboarding', onboarding: cliCheckEntry } : { shell: 'app' };
    case 'signed_out':
    case 'credentials_invalid': {
      const onboarding = deriveOnboardingEntry(input.state);
      // Unreachable in practice (both arms always produce an entry), kept
      // for exhaustiveness rather than a non-null assertion.
      return onboarding ? { shell: 'onboarding', onboarding } : { shell: 'loading' };
    }
  }
}

// ---------------------------------------------------------------------------
// deriveUserProfilePresentation — the three-state chip
// ---------------------------------------------------------------------------

export type UserProfileChipTone = 'signed-in' | 'attention' | 'signed-out';

export interface UserProfilePresentation {
  tone: UserProfileChipTone;
  /** `authenticated`'s own email, or a prior session's `lastEmail`. `null` only for `unknown`. */
  email: string | null;
}

/**
 * D47 S5 §1.4 (B-track B6/M3) — deliberately returns NO display copy: the
 * consuming component (WindowTitleBar / UserProfileCard, S5b) owns i18n
 * lookup keyed off `tone`, matching this repo's `src/shared/i18n.ts`
 * convention of keeping literal UI strings out of shared/Main code.
 */
export function deriveUserProfilePresentation(state: AuthState): UserProfilePresentation {
  switch (state.status) {
    case 'authenticated':
      return { tone: 'signed-in', email: state.email };
    case 'credentials_invalid':
      return { tone: 'attention', email: state.lastEmail };
    case 'locked':
      return { tone: 'attention', email: state.lastEmail };
    case 'signed_out':
      return { tone: 'signed-out', email: state.lastEmail };
    case 'unknown':
      return { tone: 'signed-out', email: null };
  }
}

// ---------------------------------------------------------------------------
// resolveSpawnGateDecision — D47 S5 §3, agent-session-only spawn gate
// ---------------------------------------------------------------------------

export interface SpawnGateInput {
  /** `resolveManagedCredentialsEnabled()` — the gate only ever applies when managed credentials are on; legacy (flag-off) spawning is always allowed. */
  managed: boolean;
  skipAuthGate: boolean;
  /** `AuthStateService.isAuthenticatedForSpawn()` — already folds in the I9 checkpoint-① logout latch. */
  authenticatedForSpawn: boolean;
  /** Current `AuthState`, read only to vary the diagnostic message (locked vs. everything else). */
  state: AuthState;
}

export interface SpawnGateAllowed {
  ok: true;
}

export interface SpawnGateRejected {
  ok: false;
  error: { code: 'auth_required'; message: string };
}

export type SpawnGateDecision = SpawnGateAllowed | SpawnGateRejected;

export function resolveSpawnGateDecision(input: SpawnGateInput): SpawnGateDecision {
  if (!input.managed) return { ok: true };
  if (input.skipAuthGate) return { ok: true };
  if (input.authenticatedForSpawn) return { ok: true };

  const message =
    input.state.status === 'locked'
      ? 'Credentials are still unlocking — try again in a moment.'
      : 'Sign-in required before starting an agent session.';
  return { ok: false, error: { code: 'auth_required', message } };
}

// ---------------------------------------------------------------------------
// Cross-process event / query-key constants
// ---------------------------------------------------------------------------

/** Dispatched by any renderer surface (the spawn-gate error card's "重新登录" action, a `credentials_invalid` chip, etc.) — Root listens and re-enters onboarding. Replaces the pre-S5 Root-local `aiclient:onboarding:open` constant. */
export const AUTH_OPEN_ONBOARDING_EVENT = 'aiclient:auth:open-onboarding';

/** react-query key for the single `auth.getGateSnapshot()` query that replaces S1-era Root's four separate queries (onboardingState/onboardingCliStatus/onboardingCredentialsHealth/claudeRuntimeStatus one-shot gate portion). */
export const AUTH_GATE_SNAPSHOT_QUERY_KEY = ['authGateSnapshot'] as const;

// ---------------------------------------------------------------------------
// Initial-snapshot argv delivery (D47 S5 §1.3, windowTheme.ts precedent)
// ---------------------------------------------------------------------------

export const INITIAL_AUTH_GATE_ARG_PREFIX = '--aiclient-initial-auth-gate=';

export interface InitialAuthGatePayload {
  /** `resolveSkipAuthGate({env, isPackaged})`, resolved once at `BrowserWindow` construction time. */
  skipAuthGate: boolean;
  /** The `AuthState` snapshot at the moment the window was constructed — may be stale relative to the post-`regenerateFromVault()` refresh; Root reconciles via the first `auth.stateChanged` (S5 §1.3: "argv 快照允许 locked"). Already secret-free by construction (`AuthState` never carries a token/key — see `@shared/types/auth`'s module header), so no extra redaction step is needed here. */
  state: AuthState;
}

function isValidAuthState(value: unknown): value is AuthState {
  if (!value || typeof value !== 'object') return false;
  const status = (value as { status?: unknown }).status;
  switch (status) {
    case 'unknown':
      return true;
    case 'signed_out':
    case 'locked': {
      const lastEmail = (value as { lastEmail?: unknown }).lastEmail;
      return lastEmail === null || typeof lastEmail === 'string';
    }
    case 'authenticated': {
      const v = value as { email?: unknown; remoteHealth?: unknown };
      return (
        typeof v.email === 'string' && (v.remoteHealth === 'unknown' || v.remoteHealth === 'valid')
      );
    }
    case 'credentials_invalid': {
      const v = value as { reason?: unknown; lastEmail?: unknown };
      return (
        (v.reason === 'rejected' ||
          v.reason === 'corrupt' ||
          v.reason === 'decrypt_failed' ||
          v.reason === 'migration_incomplete') &&
        (v.lastEmail === null || typeof v.lastEmail === 'string')
      );
    }
    default:
      return false;
  }
}

/** Writer — `MainWindow.ts` calls this to build the `additionalArguments` entry. */
export function buildInitialAuthGateArg(payload: InitialAuthGatePayload): string {
  return `${INITIAL_AUTH_GATE_ARG_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`;
}

/** Reader — same shape as `windowTheme.ts`'s `parseInitialThemeArg`: `undefined` on missing/unparsable/invalid, never throws. */
export function parseInitialAuthGateArg(
  argv: readonly string[]
): InitialAuthGatePayload | undefined {
  const arg = argv.find((entry) => entry.startsWith(INITIAL_AUTH_GATE_ARG_PREFIX));
  if (!arg) return undefined;
  try {
    const raw = decodeURIComponent(arg.slice(INITIAL_AUTH_GATE_ARG_PREFIX.length));
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const { skipAuthGate, state } = parsed as Record<string, unknown>;
    if (typeof skipAuthGate !== 'boolean') return undefined;
    if (!isValidAuthState(state)) return undefined;
    return { skipAuthGate, state };
  } catch {
    return undefined;
  }
}
