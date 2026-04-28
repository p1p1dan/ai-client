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

  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: ['onboardingState'] });
      queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
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
  if (runtimeStatus.kind === 'vscode-extension-only') {
    return (
      <ClaudeVsCodeOnlyShell
        status={runtimeStatus}
        registered={registered}
        onStartRegister={() => {
          // Force the standard onboarding flow to render below.
          setRuntimeOverride({ ...runtimeStatus, kind: 'not-installed' });
        }}
        onRecheck={async () => {
          setRuntimeOverride(null);
          const refreshed = await window.electronAPI.claudeRuntime.check(true);
          queryClient.setQueryData(['claudeRuntimeStatus'], refreshed);
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
