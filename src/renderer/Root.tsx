import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { DevToolsOverlay } from './components/DevToolsOverlay';
import { BackgroundLayer } from './components/layout/BackgroundLayer';
import { WindowTitleBar } from './components/layout/WindowTitleBar';
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

  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: ['onboardingState'] });
      queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
    };
    window.addEventListener(ONBOARDING_OPEN_EVENT, handler);
    return () => window.removeEventListener(ONBOARDING_OPEN_EVENT, handler);
  }, [queryClient]);

  if (onboarding.isLoading || !onboarding.data) {
    return <LoadingShell />;
  }

  if (!registered) {
    return (
      <OnboardingShell
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ['onboardingState'] });
          queryClient.invalidateQueries({ queryKey: ['onboardingCliStatus'] });
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
          queryClient.invalidateQueries({ queryKey: ['usageStats'] });
        }}
      />
    );
  }

  return (
    <Suspense fallback={<LoadingShell />}>
      <App />
    </Suspense>
  );
}
