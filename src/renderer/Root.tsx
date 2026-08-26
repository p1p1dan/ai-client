import {
  AUTH_GATE_SNAPSHOT_QUERY_KEY,
  AUTH_OPEN_ONBOARDING_EVENT,
  parseInitialAuthGateArg,
  resolveGateDecision,
} from '@shared/authGate';
import type { ClaudeRuntimeStatus } from '@shared/types';
import type { AuthState } from '@shared/types/auth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import { DevToolsOverlay } from './components/DevToolsOverlay';
import { BackgroundLayer } from './components/layout/BackgroundLayer';
import { WindowTitleBar } from './components/layout/WindowTitleBar';
import { ClaudeVsCodeOnlyShell } from './components/onboarding/ClaudeVsCodeOnlyShell';
import { OnboardingShell } from './components/onboarding/OnboardingShell';
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
 * (AuthState + managed + legacyRegistered from `auth.getGateSnapshot()`, CLI
 * status, runtime status) and renders whatever shell comes back; it does not
 * re-derive any of the old registered/cliInstalled/credentialsHealth
 * branching locally, and `decision.onboarding` (populated by
 * `resolveGateDecision` itself, via `deriveOnboardingEntry` internally) is
 * used as-is rather than re-derived here.
 *
 * The gate snapshot query intentionally does NOT seed from the argv payload's
 * `state` field: `resolveGateDecision`'s flag-off branch needs `managed` +
 * `legacyRegistered`, neither of which argv carries (only `skipAuthGate` +
 * `state`), and guessing them would risk a wrong-then-corrected flash — worse
 * than the plain "Loading -> single correct terminal state" this renders
 * instead (still exactly the flicker guarantee rev.2 §1.3 asks for; it just
 * doesn't try to skip the first Loading frame for the non-skip-gate path).
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

  const legacyRegistered = gateQuery.data?.legacyRegistered ?? false;

  // Gated on the gate snapshot having resolved at all — NOT on
  // `legacyRegistered`. `resolveGateDecision` also reads `cliStatus` in its
  // `managed && state.status === 'authenticated'` arm, which has nothing to
  // do with the flag-off `legacyRegistered` signal; gating on that alone
  // would deadlock a managed/authenticated user in `shell:'loading'` forever
  // (cliStatus never fetched -> `resolveGateDecision` never sees a non-null
  // cliStatus -> never returns 'app').
  const cliStatus = useQuery({
    queryKey: ['onboardingCliStatus'],
    queryFn: async () => window.electronAPI.onboarding.detectCli(),
    enabled: Boolean(gateQuery.data),
    staleTime: 1000 * 60,
  });

  // Runtime gate: detect CLI version + VSCode extension presence on every
  // launch. We always run this (even before registration) so we can route
  // VSCode-only users through the right onboarding path without forcing them
  // to install the CLI first.
  const runtime = useQuery({
    queryKey: ['claudeRuntimeStatus'],
    queryFn: async () => window.electronAPI.claudeRuntime.check(false),
    staleTime: 1000 * 30,
    retry: 1,
  });
  const [runtimeOverride, setRuntimeOverride] = useState<ClaudeRuntimeStatus | null>(null);
  // VSCode-extension-only users who click "start register" should go straight
  // into the email step instead of being funneled back through CLI detection.
  // We track this as a separate flag so the runtime query can stay truthful —
  // the extension is still the only Claude install on the machine, we just
  // want a different UI for this session.
  const [vscodeRegisterFlow, setVscodeRegisterFlow] = useState(false);
  // Same idea but for "install CLI": render the standard OnboardingShell at
  // cli-check so the user can run the one-click installer. Once Claude Code
  // appears, the runtime query flips off vscode-extension-only and the gate
  // proceeds to the registered/main App flow normally.
  const [vscodeInstallFlow, setVscodeInstallFlow] = useState(false);
  // Recheck button on the VSCode-only shell. We track pending state in the
  // gate (not the shell) so reentrant clicks can be ignored and stale results
  // can't overwrite a newer detection — only the most recent recheck wins.
  const [vscodeRecheckPending, setVscodeRecheckPending] = useState(false);
  const [vscodeRecheckError, setVscodeRecheckError] = useState<string | null>(null);
  // The main process now wraps detection in try/catch and returns
  // `{ kind: 'detection-failed', error }` instead of throwing. We still defend
  // against raw IPC rejections (process crash, channel teardown) by mapping
  // `runtime.isError` to a detection-failed status so the renderer always has
  // something explicit to show — never an indefinite LoadingShell.
  const runtimeStatus: ClaudeRuntimeStatus | null =
    runtimeOverride ??
    runtime.data ??
    (runtime.isError
      ? {
          kind: 'detection-failed',
          error: runtime.error instanceof Error ? runtime.error.message : String(runtime.error),
        }
      : null);

  // Once a CLI is present, eagerly disable Claude's bundled auto-updater: the
  // installs this app performs are pinned (`LAST_NODE_CLAUDE_VERSION`), and an
  // updater that silently moves off that pin defeats the pin.
  useEffect(() => {
    if (runtimeStatus?.kind === 'installed') {
      void window.electronAPI.claudeRuntime.disableAutoUpdates();
    }
  }, [runtimeStatus?.kind]);

  // Clear the vscode-register/install intents whenever we leave the
  // vscode-extension-only branch. Otherwise the flags would persist across
  // re-detection and a later return to vscode-extension-only (e.g. user
  // uninstalled CLI) would skip the shell entry page and jump straight into a
  // sub-flow.
  useEffect(() => {
    if (runtimeStatus?.kind && runtimeStatus.kind !== 'vscode-extension-only') {
      setVscodeRegisterFlow(false);
      setVscodeInstallFlow(false);
      setVscodeRecheckError(null);
    }
  }, [runtimeStatus?.kind]);

  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
      queryClient.invalidateQueries({ queryKey: ['claudeRuntimeStatus'] });
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
    managed: gateQuery.data.managed,
    skipAuthGate: false, // Root() already branched on the argv value above.
    cliStatus: cliStatus.data ?? null,
    runtimeStatus,
    legacyRegistered,
  });

  if (decision.shell === 'loading') {
    return <LoadingShell />;
  }

  // VSCode extension is present but CLI is not installed: AiClient main view
  // can't run (everything goes through the CLI), so we render a dedicated
  // shell. The user can still finish account registration here — credentials
  // go straight into ~/.claude/settings.json so the VSCode extension picks
  // them up.
  //
  // If the user is still unregistered AND has clicked "start register", we
  // render OnboardingShell directly at the email step with mode='vscode-extension'
  // so they don't get bounced back through CLI detection/install (the whole
  // point of the VSCode path is to skip the CLI). Registered users always see
  // the shell — they're done, just need to go back to VSCode.
  if (decision.shell === 'vscode-only' && runtimeStatus?.kind === 'vscode-extension-only') {
    if (!legacyRegistered && vscodeRegisterFlow) {
      return (
        <OnboardingShell
          initialStep="register-email"
          initialMode="vscode-extension"
          onComplete={() => {
            setVscodeRegisterFlow(false);
            queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
            queryClient.invalidateQueries({ queryKey: ['claudeRuntimeStatus'] });
            queryClient.invalidateQueries({ queryKey: ['usageStats'] });
            queryClient.invalidateQueries({ queryKey: AUTH_GATE_SNAPSHOT_QUERY_KEY });
          }}
        />
      );
    }
    if (vscodeInstallFlow) {
      return (
        <OnboardingShell
          alreadyRegistered={legacyRegistered}
          initialStep="cli-check"
          onComplete={() => {
            setVscodeInstallFlow(false);
            queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
            queryClient.invalidateQueries({ queryKey: ['claudeRuntimeStatus'] });
            queryClient.invalidateQueries({ queryKey: ['usageStats'] });
            queryClient.invalidateQueries({ queryKey: AUTH_GATE_SNAPSHOT_QUERY_KEY });
          }}
        />
      );
    }
    return (
      <ClaudeVsCodeOnlyShell
        status={runtimeStatus}
        registered={legacyRegistered}
        rechecking={vscodeRecheckPending}
        recheckError={vscodeRecheckError}
        onStartRegister={() => {
          setVscodeRegisterFlow(true);
        }}
        onStartInstall={() => {
          setVscodeInstallFlow(true);
        }}
        onRecheck={async () => {
          // Guard against reentrant clicks — the Promise from a previous
          // detection might still be in flight; ignore the new click instead
          // of letting an older result race in and overwrite the newer one.
          if (vscodeRecheckPending) return;
          setVscodeRecheckPending(true);
          setVscodeRecheckError(null);
          setVscodeRegisterFlow(false);
          setVscodeInstallFlow(false);
          setRuntimeOverride(null);
          try {
            const refreshed = await window.electronAPI.claudeRuntime.check(true);
            queryClient.setQueryData(['claudeRuntimeStatus'], refreshed);
          } catch (error) {
            // IPC reject (channel teardown, main-process crash, etc.) — show
            // the error inline rather than letting the promise rejection
            // bubble silently. The user can retry the button.
            setVscodeRecheckError(error instanceof Error ? error.message : String(error));
          } finally {
            setVscodeRecheckPending(false);
          }
        }}
        onQuit={() => {
          void window.electronAPI.app.quit();
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
        alreadyRegistered={legacyRegistered}
        initialStep={entry.initialStep}
        reason={entry.reason}
        initialEmail={entry.initialEmail}
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
          queryClient.invalidateQueries({ queryKey: ['claudeRuntimeStatus'] });
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
