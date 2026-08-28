import { DevToolsOverlay } from '@/components/DevToolsOverlay';
import { BackgroundLayer } from '@/components/layout/BackgroundLayer';
import { WindowTitleBar } from '@/components/layout/WindowTitleBar';
import { WelcomeView, type WelcomeViewProps } from './WelcomeView';

/**
 * A2 — full-window chrome for the welcome screen.
 *
 * Deliberately the same three-part chrome as `OnboardingShell`
 * (background / title bar / dev overlay): pressing `Sign in` swaps the body
 * from `WelcomeView` to `OnboardingView`, and anything that differed between
 * the two shells would read as the window changing shape mid-flow.
 */
export function WelcomeShell(props: WelcomeViewProps) {
  return (
    <div className="relative z-0 flex h-screen flex-col overflow-hidden">
      <BackgroundLayer />
      <WindowTitleBar />
      <DevToolsOverlay />
      <div className="relative flex flex-1 items-center justify-center overflow-auto p-4">
        <WelcomeView {...props} />
      </div>
    </div>
  );
}
