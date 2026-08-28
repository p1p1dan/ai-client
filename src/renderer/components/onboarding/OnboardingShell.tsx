import type { AuthGateOnboardingReason } from '@shared/authGate';
import { DevToolsOverlay } from '@/components/DevToolsOverlay';
import { BackgroundLayer } from '@/components/layout/BackgroundLayer';
import { WindowTitleBar } from '@/components/layout/WindowTitleBar';
import { OnboardingView, type OnboardingViewProps } from './OnboardingView';

export interface OnboardingShellProps {
  onComplete: () => void;
  /** Forwarded to OnboardingView — override the starting step. */
  initialStep?: OnboardingViewProps['initialStep'];
  /** Forwarded to OnboardingView — return to the welcome screen. */
  onBack?: OnboardingViewProps['onBack'];
  /**
   * D47 S5: why the gate routed here — `deriveOnboardingEntry` (@shared/authGate)
   * output, passed straight through to OnboardingView for copy selection
   * (`reason === 'expired'` gets its own message and hides the CLI-check
   * escape hatch, a dead end once a login has expired).
   */
  reason?: AuthGateOnboardingReason;
  /** Forwarded to OnboardingView — prefill for the email step (`lastEmail`). */
  initialEmail?: string | null;
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
  initialStep,
  onBack,
  reason,
  initialEmail,
}: OnboardingShellProps) {
  return (
    <div className="relative z-0 flex h-screen flex-col overflow-hidden">
      <BackgroundLayer />
      <WindowTitleBar />
      <DevToolsOverlay />
      <div className="relative flex flex-1 items-center justify-center overflow-auto p-4">
        <OnboardingView
          initialEmail={initialEmail}
          initialStep={initialStep}
          onBack={onBack}
          onComplete={onComplete}
          reason={reason}
        />
      </div>
    </div>
  );
}
