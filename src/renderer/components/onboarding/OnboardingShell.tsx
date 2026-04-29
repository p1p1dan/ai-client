import { DevToolsOverlay } from '@/components/DevToolsOverlay';
import { BackgroundLayer } from '@/components/layout/BackgroundLayer';
import { WindowTitleBar } from '@/components/layout/WindowTitleBar';
import { OnboardingView, type OnboardingViewProps } from './OnboardingView';

export interface OnboardingShellProps {
  onComplete: () => void;
  /**
   * True when the user has already registered in a previous session but the
   * required CLI is still missing (typical of the register-only flow). In
   * this mode the view skips the registration step — credentials are already
   * persisted — and goes straight from CLI install to completion.
   */
  alreadyRegistered?: boolean;
  /** Forwarded to OnboardingView — override the starting step. */
  initialStep?: OnboardingViewProps['initialStep'];
  /** Forwarded to OnboardingView — override the starting mode. */
  initialMode?: OnboardingViewProps['initialMode'];
}

/**
 * Full-window layout for the onboarding/detection phase.
 *
 * Renders only the window title bar and the onboarding view; the main App
 * (agent sessions, worktrees, session restore) does NOT mount until the user
 * has registered. This guarantees the environment config is known before any
 * agent/session initialization runs.
 */
export function OnboardingShell({
  onComplete,
  alreadyRegistered,
  initialStep,
  initialMode,
}: OnboardingShellProps) {
  return (
    <div className="relative z-0 flex h-screen flex-col overflow-hidden">
      <BackgroundLayer />
      <WindowTitleBar />
      <DevToolsOverlay />
      <div className="relative flex flex-1 items-center justify-center overflow-auto p-4">
        <OnboardingView
          onComplete={onComplete}
          alreadyRegistered={alreadyRegistered}
          initialStep={initialStep}
          initialMode={initialMode}
        />
      </div>
    </div>
  );
}
