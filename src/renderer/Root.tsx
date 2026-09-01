import {
  AUTH_GATE_SNAPSHOT_QUERY_KEY,
  AUTH_OPEN_ONBOARDING_EVENT,
  deriveOnboardingEntry,
  parseInitialAuthGateArg,
  resolveGateDecision,
} from '@shared/authGate';
import type { AuthState } from '@shared/types/auth';
import type { PiRuntimeStatus } from '@shared/types/piRuntime';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import { DevToolsOverlay } from './components/DevToolsOverlay';
import { BackgroundLayer } from './components/layout/BackgroundLayer';
import { WindowTitleBar } from './components/layout/WindowTitleBar';
import { OnboardingShell } from './components/onboarding/OnboardingShell';
import { WelcomeShell } from './components/onboarding/WelcomeShell';
import { Button } from './components/ui/button';

// Lazy-load the main App so its heavy hooks (session restore, worktree
// hydration, etc.) do not run until the user is registered.
const App = lazy(() => import('./App'));

// D47 S5 (rev.2 §1.3): parsed once, at module load — before first paint,
// same timing as `windowTheme.ts`'s `initialThemeIsDark`. Only `skipAuthGate`
// is used from this payload (see the comment on `RootWithOnboardingGate`'s
// gate query for why the accompanying `state` snapshot isn't): a
// missing/malformed argv entry (older Main build mid-rollout, or a renderer
// reload without a fresh `additionalArguments` payload) falls back to
// `false` — it must never silently bypass the gate.
const argvGatePayload = parseInitialAuthGateArg(
  typeof window !== 'undefined' ? (window.electronAPI?.auth?.initialArgv ?? []) : []
);
const skipAuthGate = argvGatePayload?.skipAuthGate ?? false;

function LoadingShell() {
  return (
    <div className="relative z-0 flex h-screen flex-col overflow-hidden">
      <BackgroundLayer />
      <WindowTitleBar />
      <DevToolsOverlay />
      <div className="flex-1" />
    </div>
  );
}

function AppShell({ banner }: { banner?: ReactNode }) {
  return (
    <Suspense fallback={<LoadingShell />}>
      <div className="relative z-0 flex h-screen flex-col overflow-hidden">
        {banner}
        <div className="min-h-0 flex-1 overflow-hidden">
          <App />
        </div>
      </div>
    </Suspense>
  );
}

/**
 * Team-track bypass: mount App immediately, skipping detection/login.
 *
 * T-16: this used to also force `useOpenChamberShell` on — writing the
 * persisted setting on every launch and re-applying it after rehydration, so
 * the Appearance switch could never stay off. Skipping the onboarding gate and
 * choosing a shell are unrelated concerns; the shell is now read from settings
 * alone (default on, see `stores/settings/index.ts`).
 *
 * D47 S5: the bypass signal itself moved from a hardcoded renderer constant
 * (`SKIP_ONBOARDING_GATE`, retired) to `skipAuthGate` — Main-computed via
 * `resolveSkipAuthGate({env, isPackaged})` (always false when packaged) and
 * delivered through the argv snapshot. Same silent-skip behavior, different
 * — and now reversible without a rebuild — trigger. `resolveGateDecision`
 * also special-cases `skipAuthGate` (returns `shell:'app'`) for its other
 * consumers (MainWindow.isAppMountedFor, the spawn gate); Root keeps this
 * standalone check ahead of any query, exactly like the pre-S5
 * `if (SKIP_ONBOARDING_GATE) return <SkippedOnboardingApp/>` it replaces.
 */
function SkippedOnboardingApp() {
  // No banner: it stole layout height and clipped the shell. Gate skip is silent.
  return (
    <Suspense fallback={<LoadingShell />}>
      <App />
    </Suspense>
  );
}

interface RuntimeDetectionFailedShellProps {
  error?: string;
  retrying: boolean;
  onRetry: () => void;
}

function RuntimeDetectionFailedShell({
  error,
  retrying,
  onRetry,
}: RuntimeDetectionFailedShellProps) {
  return (
    <div className="relative z-0 flex h-screen flex-col overflow-hidden">
      <BackgroundLayer />
      <WindowTitleBar />
      <DevToolsOverlay />
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <AlertTriangle className="h-8 w-8 text-yellow-500" />
          <h2 className="text-base font-medium text-foreground">无法检测 Claude Code 运行时</h2>
          <p className="text-xs text-muted-foreground">
            探测过程出错，可能是
            IPC、权限或环境问题。请重试；如果反复失败，请查看开发者工具中的错误日志。
          </p>
          {error ? (
            <pre className="max-w-full overflow-x-auto rounded bg-muted px-3 py-2 text-left text-[11px] text-muted-foreground">
              {error}
            </pre>
          ) : null}
          <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
            {retrying ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
            )}
            重试
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Application gate that mounts the full App only after onboarding is
 * complete. While the user is going through CLI detection / registration,
 * only the window title bar and onboarding view are rendered.
 *
 * D47 S5 (rev.2): every branch decision below is delegated to
 * `resolveGateDecision` (@shared/authGate) — the same pure function
 * `MainWindow.isAppMountedFor` uses to decide whether App is allowed to be
 * mounted for close-confirm/spawn-gate purposes. Root only supplies inputs
 * (AuthState + the recorded credential mode from `auth.getGateSnapshot()`,
 * runtime status) and renders whatever shell comes back; it does not re-derive
 * any of the old registered/cliInstalled/credentialsHealth branching locally,
 * and `decision.onboarding` / `decision.welcome` (populated by
 * `resolveGateDecision` itself) are used as-is rather than re-derived here.
 *
 * The gate snapshot query intentionally does NOT seed from the argv payload's
 * `state` field: the gate also needs the recorded credential mode, which argv
 * does not carry (only `skipAuthGate` + `state`), and guessing it would risk a
 * wrong-then-corrected flash — worse than the plain "Loading -> single correct
 * terminal state" this renders instead.
 */
function RootWithOnboardingGate() {
  const queryClient = useQueryClient();

  const gateQuery = useQuery({
    queryKey: AUTH_GATE_SNAPSHOT_QUERY_KEY,
    queryFn: () => window.electronAPI.auth.getGateSnapshot(),
    staleTime: Infinity, // kept live by `auth.stateChanged`, not polling.
  });

  useEffect(() => {
    return window.electronAPI.auth.onStateChanged((state: AuthState) => {
      queryClient.setQueryData(AUTH_GATE_SNAPSHOT_QUERY_KEY, (prev) =>
        prev ? { ...prev, state } : prev
      );
    });
  }, [queryClient]);

  const runtime = useQuery({
    queryKey: ['piRuntimeStatus'],
    queryFn: async () => window.electronAPI.piRuntime.check(false),
    staleTime: 1000 * 30,
    retry: 1,
  });
  const [runtimeOverride, setRuntimeOverride] = useState<PiRuntimeStatus | null>(null);
  // A2 — the welcome screen's `Sign in` opens the email/code sub-flow in place.
  // Session-local intent, not gate state: the gate keeps saying `welcome` until
  // a mode is actually recorded, and this is only which of the two screens that
  // branch renders right now.
  const [signInFlow, setSignInFlow] = useState(false);
  // The main process now wraps detection in try/catch and returns
  // `{ kind: 'detection-failed', error }` instead of throwing. We still defend
  // against raw IPC rejections (process crash, channel teardown) by mapping
  // `runtime.isError` to a detection-failed status so the renderer always has
  // something explicit to show — never an indefinite LoadingShell.
  const runtimeStatus: PiRuntimeStatus | null =
    runtimeOverride ??
    runtime.data ??
    (runtime.isError
      ? {
          kind: 'detection-failed',
          error: runtime.error instanceof Error ? runtime.error.message : String(runtime.error),
        }
      : null);

  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: ['piRuntimeStatus'] });
      queryClient.invalidateQueries({ queryKey: AUTH_GATE_SNAPSHOT_QUERY_KEY });
    };
    window.addEventListener(AUTH_OPEN_ONBOARDING_EVENT, handler);
    return () => window.removeEventListener(AUTH_OPEN_ONBOARDING_EVENT, handler);
  }, [queryClient]);

  // Runtime probe failed for a non-"missing CLI" reason (IPC crash, fs
  // permission, transient PATH lookup, etc.). Show an explicit retry surface
  // instead of routing the user into onboarding — that would suggest "Claude
  // is not installed" and hide the real problem. This still short-circuits
  // ahead of `resolveGateDecision`: it is a Root-local retry affordance, not
  // an auth-gate branch (`resolveGateDecision` folds `detection-failed` into
  // its own `shell` output too, but has no retry-button concept to offer).
  if (runtimeStatus?.kind === 'detection-failed') {
    return (
      <RuntimeDetectionFailedShell
        error={runtimeStatus.error}
        retrying={runtime.isFetching}
        onRetry={() => {
          setRuntimeOverride(null);
          void runtime.refetch();
        }}
      />
    );
  }

  if (gateQuery.isLoading || !gateQuery.data) {
    return <LoadingShell />;
  }

  const decision = resolveGateDecision({
    state: gateQuery.data.state,
    entered: gateQuery.data.entered,
    skipAuthGate: false, // Root() already branched on the argv value above.
    runtimeStatus,
  });

  if (decision.shell === 'loading') {
    return <LoadingShell />;
  }

  if (decision.shell === 'runtime-unavailable') {
    return (
      <RuntimeDetectionFailedShell
        error="没有找到随包的 Pi worker 运行时。"
        onRetry={() => {
          setRuntimeOverride(null);
          void runtime.refetch();
        }}
        retrying={runtime.isFetching}
      />
    );
  }

  if (decision.shell === 'welcome' && decision.welcome) {
    const welcome = decision.welcome;
    const invalidateGate = () => {
      queryClient.invalidateQueries({ queryKey: ['piRuntimeStatus'] });
      queryClient.invalidateQueries({ queryKey: ['usageStats'] });
      queryClient.invalidateQueries({ queryKey: AUTH_GATE_SNAPSHOT_QUERY_KEY });
    };
    if (signInFlow) {
      const entry = deriveOnboardingEntry(gateQuery.data.state);
      return (
        <OnboardingShell
          initialEmail={entry?.initialEmail ?? ''}
          initialStep="register-email"
          onBack={() => setSignInFlow(false)}
          onComplete={async () => {
            // Signing in IS choosing `managed`, and it is also the third way
            // through the welcome screen — so it goes through the same single
            // call rather than relying on `verifyAndRegister`'s own write plus
            // a separate entry latch that could disagree with it.
            await window.electronAPI.auth.enterApp('managed');
            setSignInFlow(false);
            invalidateGate();
          }}
          reason={entry?.reason}
        />
      );
    }
    return (
      <WelcomeShell
        entry={welcome}
        // All three ways in go through `enterApp`: it records the mode AND
        // latches "entered this run". Nothing touches the vault, so a user who
        // tries their own setup and comes back is still signed in (D64).
        onContinue={async () => {
          await window.electronAPI.auth.enterApp('managed');
          invalidateGate();
        }}
        onSignIn={() => setSignInFlow(true)}
        onUseOwnSetup={async () => {
          await window.electronAPI.auth.enterApp('local');
          invalidateGate();
        }}
      />
    );
  }

  if (decision.shell === 'onboarding' && decision.onboarding) {
    const entry = decision.onboarding;
    return (
      <OnboardingShell
        // B5-3: re-key on (reason, initialEmail) so a stale-mounted
        // OnboardingShell can't silently keep showing yesterday's copy/prefill
        // when AuthState changes underneath it (e.g. signed_out -> expired).
        key={`${entry.reason}:${entry.initialEmail}`}
        initialStep={entry.initialStep}
        reason={entry.reason}
        initialEmail={entry.initialEmail}
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ['piRuntimeStatus'] });
          queryClient.invalidateQueries({ queryKey: ['usageStats'] });
          queryClient.invalidateQueries({ queryKey: AUTH_GATE_SNAPSHOT_QUERY_KEY });
        }}
      />
    );
  }

  // decision.shell === 'app'
  return (
    <AppShell
      // The Bun-incompatibility banner was retired here (2026-08-26): its
      // version threshold was stale, and a warning nobody has re-checked is
      // worse than none. No replacement — the ruling was "retire, no detection".
      banner={undefined}
    />
  );
}

export default function Root() {
  // Temporary: OpenChamber chat-refactor team track — skip detection/login/env rewrite.
  if (skipAuthGate) {
    return <SkippedOnboardingApp />;
  }
  return <RootWithOnboardingGate />;
}
