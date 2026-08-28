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

/**
 * A2 — `welcome` is the two-button first screen; `runtime-unavailable` replaces
 * the former `vscode-only` shell and absorbs `not-installed` with it (see
 * `resolveGateDecision`).
 */
export type AuthGateShell =
  | 'loading'
  | 'app'
  | 'welcome'
  | 'onboarding'
  | 'runtime-unavailable'
  | 'detection-failed';

/**
 * Mirrors `OnboardingView.tsx`'s local `Step` union structurally — shared code
 * cannot import a renderer-local type, so this is the shared vocabulary
 * OnboardingView maps 1:1 onto.
 *
 * A2 dropped `cli-check` / `cli-install`: the probes they ran were retired by
 * A3/D65 (nothing they detect decides anything — Claude Code, Codex and Node
 * all ship inside this app), and the screen they lived on is replaced by
 * `welcome`. What remains is the sign-in sub-flow the welcome screen's primary
 * button opens.
 */
export type AuthGateOnboardingStep = 'register-email' | 'register-code' | 'result';

export type AuthGateOnboardingReason = 'first_run' | 'expired' | 'signed_out';

export interface AuthGateOnboardingEntry {
  initialStep: AuthGateOnboardingStep;
  reason: AuthGateOnboardingReason;
  initialEmail: string;
}

/**
 * A2 — which half of the welcome screen's first button to render.
 *
 * `sign-in` is state A (nobody is signed in). `continue` is state B: someone
 * IS signed in and must not be asked to do it again — the primary button just
 * says "use that account", which is the user's 「进入公司配置」.
 */
export interface AuthGateWelcomeEntry {
  primary: 'sign-in' | 'continue';
  /** The account `continue` would use. `null` for `sign-in`. */
  email: string | null;
  /** A one-line reason to show above the buttons; `null` for an ordinary first run. */
  notice: 'expired' | null;
}

export interface ResolveGateDecisionInput {
  /** Current `AuthState` (from `AuthStateService`, or the argv-delivered initial snapshot). */
  state: AuthState;
  /**
   * A2 rev.2 — has the user already come through the welcome screen in THIS
   * process (`hasEnteredApp()`).
   *
   * This is the only thing besides runtime health that can put App on screen,
   * and it is deliberately the whole story. Earlier drafts fed the gate the
   * recorded credential mode instead, so that a returning user could skip the
   * screen; the ruling was the opposite (「就是启动首屏，每次都出现」), which
   * takes the credential mode out of routing altogether and leaves it doing
   * only the job D64 gave it — deciding which credentials a spawn injects.
   */
  entered: boolean;
  /** `resolveSkipAuthGate({env, isPackaged})` — the dev/team-track escape hatch. */
  skipAuthGate: boolean;
  /** `null` while still detecting. */
  runtimeStatus: ClaudeRuntimeStatus | null;
}

export interface GateDecision {
  shell: AuthGateShell;
  /** Present only when `shell === 'onboarding'`. */
  onboarding?: AuthGateOnboardingEntry;
  /** Present only when `shell === 'welcome'`. */
  welcome?: AuthGateWelcomeEntry;
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
        : { initialStep: 'register-email', reason: 'first_run', initialEmail: '' };
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
 * A2 — the welcome screen's own derivation, kept as a separate exported pure
 * function for the same reason `deriveOnboardingEntry` is one: the screen needs
 * it to render, and a test needs it without a DOM.
 *
 * `locked` and `unknown` return `null` because they are not answers yet — the
 * gate holds `loading` for both rather than guessing which button to show and
 * then swapping it under the user a moment later.
 */
export function deriveWelcomeEntry(state: AuthState): AuthGateWelcomeEntry | null {
  switch (state.status) {
    case 'authenticated':
      return { primary: 'continue', email: state.email, notice: null };
    case 'signed_out':
      return { primary: 'sign-in', email: null, notice: null };
    case 'credentials_invalid':
      // Same folding as `deriveOnboardingEntry`: all four sub-reasons read as
      // "your session needs re-verifying". The button is `sign-in`, not
      // `continue` — there is nothing to continue with.
      return { primary: 'sign-in', email: null, notice: 'expired' };
    case 'locked':
    case 'unknown':
      return null;
  }
}

/**
 * Priority order, top to bottom:
 *
 *  1. `skipAuthGate` — the escape hatch bypasses EVERYTHING unconditionally,
 *     including runtime detection (matches the pre-S5 `SKIP_ONBOARDING_GATE`
 *     literal behavior: `if (SKIP_ONBOARDING_GATE) return <SkippedOnboardingApp/>`
 *     ran before any query in `Root.tsx`).
 *  2. Runtime availability — a hard blocker regardless of credential mode or
 *     auth state: nothing runs without the bundled runtime.
 *  3. `entered` — the user has already picked a way in this run.
 *  4. Otherwise: the welcome screen, whose primary button the ACCOUNT decides
 *     (`deriveWelcomeEntry`) and nothing else.
 *
 * ## A2 — what replaced the old two-branch shape, and why
 *
 * The gate used to fork on `managed`: true took a five-arm `AuthState` branch,
 * false took a `legacyRegistered` two-arm branch. That shape came from
 * `AICLIENT_MANAGED_CREDENTIALS` being a BUILD-TIME flag, where "flag off"
 * meant an older product with its own registration chain.
 *
 * D64 turned the flag into a stored user choice, and that quietly broke the
 * fork: `resolveManagedCredentialsEnabled()` returns false for `local` too, so
 * a user who deliberately picked their own API key was sent down the legacy
 * branch and told to register — the exact opposite of what they chose. Both
 * inputs are gone; nothing about credentials reaches this function any more.
 *
 * ## The credential mode is NOT an input here, and that is the design
 *
 * An intermediate draft fed it in, so that a user with a recorded choice could
 * skip the welcome screen. The ruling went the other way
 * (「就是启动首屏，每次都出现」), and the result is simpler than the thing it
 * replaced: routing depends on the account and on whether the user has picked
 * yet, while the credential mode goes back to doing only what D64 named it for
 * — deciding which credentials a spawn injects. Two questions that were briefly
 * entangled are separate again.
 *
 * It also removes the need for a separate "switch credential source" entry
 * point: quitting and reopening puts the same two buttons back on screen.
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

  // A2 — `not-installed` and `vscode-extension-only` are ONE outcome now.
  //
  // Since 2026-08-26 `ClaudeRuntimeChecker.detect()` answers `installed` off
  // the bundled `@cometix/claude-code` before anything else runs, so both of
  // these kinds are reachable only when that bundle is missing: a broken
  // installation, or a dev tree with no `agent-host/node_modules`. They are
  // therefore the same fact wearing two names, and the old `vscode-only`
  // shell's offer — "install the Claude CLI and come back" — was not merely
  // dead but WRONG: a system CLI is never what we execute, so installing one
  // would not have fixed the user's problem.
  if (
    input.runtimeStatus.kind === 'not-installed' ||
    input.runtimeStatus.kind === 'vscode-extension-only'
  ) {
    return { shell: 'runtime-unavailable' };
  }

  // The user has already picked a way in this run. Checked BEFORE the account
  // state below on purpose: a keyring that locks after they are inside must not
  // pull a working App back to a spinner.
  if (input.entered) {
    return { shell: 'app' };
  }

  // `locked` / `unknown` are not answers yet, so there is no honest primary
  // button to draw. Root holds LoadingShell and the next `auth.stateChanged`
  // resolves it — never a screen that swaps its own button a moment later.
  return welcomeShell(deriveWelcomeEntry(input.state));
}

/**
 * `deriveWelcomeEntry` returns `null` only for `locked`/`unknown`, which the
 * switch above has already routed to `loading` — so this is an exhaustiveness
 * guard, not a reachable fallback. It degrades to `loading` rather than
 * asserting: a welcome screen with no primary button is worse than a spinner.
 */
function welcomeShell(entry: AuthGateWelcomeEntry | null): GateDecision {
  return entry ? { shell: 'welcome', welcome: entry } : { shell: 'loading' };
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
