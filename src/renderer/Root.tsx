import type { ClaudeRuntimeStatus } from '@shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { DevToolsOverlay } from './components/DevToolsOverlay';
import { BackgroundLayer } from './components/layout/BackgroundLayer';
import { WindowTitleBar } from './components/layout/WindowTitleBar';
import { ClaudeRuntimeBanner } from './components/onboarding/ClaudeRuntimeBanner';
import { ClaudeVsCodeOnlyShell } from './components/onboarding/ClaudeVsCodeOnlyShell';
import { OnboardingShell } from './components/onboarding/OnboardingShell';
import { Button } from './components/ui/button';

// Lazy-load the main App so its heavy hooks (session restore, worktree
// hydration, etc.) do not run until the user is registered.
const App = lazy(() => import('./App'));

const ONBOARDING_OPEN_EVENT = 'aiclient:onboarding:open';

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
          <h2 className="text-base font-medium text-primary">无法检测 Claude Code 运行时</h2>
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
 * Two separate conditions must hold before App mounts:
 *  1. The user has registered (credentials written to ~/.claude and ~/.codex).
 *  2. The required CLI (Claude Code) is actually installed on this machine.
 *
 * Register-only flow persists `registered: true` even though CLI is missing,
 * so we must re-check CLI status on every launch — otherwise the user would
 * bypass the install step forever.
 *
 * On TEC OCular Agent (TSD) encrypted machines, the Claude Code CLI must be
 * pinned to the last Node release (2.1.112) — Bun-based 2.1.113+ falls outside
 * the whitelist and can't read encrypted files. The runtime gate below
 * branches on the detection result:
 *   - bun-incompatible: mount App but show a yellow banner offering downgrade
 *   - vscode-extension-only: render a dedicated shell (no main App)
 *   - node-compatible: also opportunistically disable Claude's auto-updater
 *     so a future launch doesn't silently pull a Bun build
 */
export default function Root() {
  const queryClient = useQueryClient();

  const onboarding = useQuery({
    queryKey: ['onboardingState'],
    queryFn: async () => window.electronAPI.onboarding.check(),
    staleTime: 1000 * 60 * 5,
  });

  const registered = onboarding.data?.registered === true;

  const cliStatus = useQuery({
    queryKey: ['onboardingCliStatus'],
    queryFn: async () => window.electronAPI.onboarding.detectCli(),
    enabled: registered,
    staleTime: 1000 * 60,
  });

  // Credential-content sanity check. checkRegistration() only reads the
  // ~/.aiclient/settings.json "registered" flag, and the legacy file-existence
  // probe in main/index.ts is also true-on-existence. Neither catches the
  // failure mode users reported in 0.2.56 where ~/.claude/settings.json exists
  // but no longer carries ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN (only
  // hooks). When that happens the gate must fall back to re-registration
  // instead of mounting App and letting Claude error out inside the terminal.
  const credentialsHealth = useQuery({
    queryKey: ['onboardingCredentialsHealth'],
    queryFn: async () => window.electronAPI.onboarding.checkCredentialsHealth(),
    enabled: registered,
    staleTime: 1000 * 30,
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

  // Once we know the CLI is on a Node-compatible build, eagerly disable
  // Claude's bundled auto-updater so the next launch can't silently pull a
  // Bun build that breaks on encrypted devices.
  useEffect(() => {
    if (runtimeStatus?.kind === 'node-compatible') {
      void window.electronAPI.claudeRuntime.disableAutoUpdates();
    }
  }, [runtimeStatus?.kind]);

  // Clear the vscode-register/install intents whenever we leave the
  // vscode-extension-only branch. Otherwise the flags would persist across
  // re-detection and a later return to vscode-extension-only (e.g. user
  // uninstalled CLI) would skip the shell entry page and jump straight into a
  // sub-flow.
  useEffect(() => {
    if (runtimeStatus && runtimeStatus.kind !== 'vscode-extension-only') {
      setVscodeRegisterFlow(false);
      setVscodeInstallFlow(false);
      setVscodeRecheckError(null);
    }
  }, [runtimeStatus?.kind]);

  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: ['onboardingState'] });
      queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
      queryClient.invalidateQueries({ queryKey: ['onboardingCredentialsHealth'] });
      queryClient.invalidateQueries({ queryKey: ['claudeRuntimeStatus'] });
    };
    window.addEventListener(ONBOARDING_OPEN_EVENT, handler);
    return () => window.removeEventListener(ONBOARDING_OPEN_EVENT, handler);
  }, [queryClient]);

  if (
    onboarding.isLoading ||
    !onboarding.data ||
    (runtime.isLoading && !runtime.isError) ||
    !runtimeStatus
  ) {
    return <LoadingShell />;
  }

  // Runtime probe failed for a non-"missing CLI" reason (IPC crash, fs
  // permission, transient PATH lookup, etc.). Show an explicit retry surface
  // instead of routing the user into onboarding — that would suggest "Claude
  // is not installed" and hide the real problem.
  if (runtimeStatus.kind === 'detection-failed') {
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
  if (runtimeStatus.kind === 'vscode-extension-only') {
    if (!registered && vscodeRegisterFlow) {
      return (
        <OnboardingShell
          initialStep="register-email"
          initialMode="vscode-extension"
          onComplete={() => {
            setVscodeRegisterFlow(false);
            queryClient.invalidateQueries({ queryKey: ['onboardingState'] });
            queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
            queryClient.invalidateQueries({ queryKey: ['onboardingCredentialsHealth'] });
            queryClient.invalidateQueries({ queryKey: ['claudeRuntimeStatus'] });
            queryClient.invalidateQueries({ queryKey: ['usageStats'] });
          }}
        />
      );
    }
    if (vscodeInstallFlow) {
      return (
        <OnboardingShell
          alreadyRegistered={registered}
          initialStep="cli-check"
          onComplete={() => {
            setVscodeInstallFlow(false);
            queryClient.invalidateQueries({ queryKey: ['onboardingState'] });
            queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
            queryClient.invalidateQueries({ queryKey: ['onboardingCredentialsHealth'] });
            queryClient.invalidateQueries({ queryKey: ['claudeRuntimeStatus'] });
            queryClient.invalidateQueries({ queryKey: ['usageStats'] });
          }}
        />
      );
    }
    return (
      <ClaudeVsCodeOnlyShell
        status={runtimeStatus}
        registered={registered}
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

  if (!registered) {
    return (
      <OnboardingShell
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ['onboardingState'] });
          queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
          queryClient.invalidateQueries({ queryKey: ['onboardingCredentialsHealth'] });
          queryClient.invalidateQueries({ queryKey: ['claudeRuntimeStatus'] });
          queryClient.invalidateQueries({ queryKey: ['usageStats'] });
        }}
      />
    );
  }

  // Registered but CLI status still loading — show a neutral loading shell
  // so we do not mount App prematurely with a missing CLI.
  if (cliStatus.isLoading || !cliStatus.data) {
    return <LoadingShell />;
  }

  // Registered but Claude CLI is still missing (typical of the register-only
  // flow). Re-enter onboarding at the CLI check step; skip registration since
  // credentials are already persisted.
  if (!cliStatus.data.claudeInstalled) {
    return (
      <OnboardingShell
        alreadyRegistered
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ['onboardingState'] });
          queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
          queryClient.invalidateQueries({ queryKey: ['onboardingCredentialsHealth'] });
          queryClient.invalidateQueries({ queryKey: ['claudeRuntimeStatus'] });
          queryClient.invalidateQueries({ queryKey: ['usageStats'] });
        }}
      />
    );
  }

  // Wait for the credential health probe before deciding whether the env in
  // ~/.claude/settings.json is intact. Mounting App on an unhealthy probe
  // would surface as "无法调用 API" inside the terminal — worse UX than a
  // brief loading shell.
  if (credentialsHealth.isLoading || !credentialsHealth.data) {
    return <LoadingShell />;
  }

  // Self-heal: registered + CLI present, but ~/.claude/settings.json lost its
  // env (or codex auth.json lost its key). Drop back into the registration
  // step so the user can re-mint tokens. Skip the CLI install gate by
  // forcing initialStep='register-email' — they already have the tools.
  if (!credentialsHealth.data.claudeEnvOk || !credentialsHealth.data.codexAuthOk) {
    return (
      <OnboardingShell
        initialStep="register-email"
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ['onboardingState'] });
          queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
          queryClient.invalidateQueries({ queryKey: ['onboardingCredentialsHealth'] });
          queryClient.invalidateQueries({ queryKey: ['claudeRuntimeStatus'] });
          queryClient.invalidateQueries({ queryKey: ['usageStats'] });
        }}
      />
    );
  }

  return (
    <Suspense fallback={<LoadingShell />}>
      <div className="relative z-0 flex h-screen flex-col overflow-hidden">
        <ClaudeRuntimeBanner
          status={runtimeStatus}
          onStatusChange={(next) => {
            queryClient.setQueryData(['claudeRuntimeStatus'], next);
          }}
        />
        <div className="flex-1 overflow-hidden">
          <App />
        </div>
      </div>
    </Suspense>
  );
}
