import type { ClaudeRuntimeStatus } from '@shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { DevToolsOverlay } from './components/DevToolsOverlay';
import { BackgroundLayer } from './components/layout/BackgroundLayer';
import { WindowTitleBar } from './components/layout/WindowTitleBar';
import { ClaudeRuntimeBanner } from './components/onboarding/ClaudeRuntimeBanner';
import { ClaudeVsCodeOnlyShell } from './components/onboarding/ClaudeVsCodeOnlyShell';
import { OnboardingShell } from './components/onboarding/OnboardingShell';

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
  });
  const [runtimeOverride, setRuntimeOverride] = useState<ClaudeRuntimeStatus | null>(null);
  const runtimeStatus = runtimeOverride ?? runtime.data ?? null;

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

  if (onboarding.isLoading || !onboarding.data || runtime.isLoading || !runtimeStatus) {
    return <LoadingShell />;
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
