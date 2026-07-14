import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { DevToolsOverlay } from './components/DevToolsOverlay';
import { BackgroundLayer } from './components/layout/BackgroundLayer';
import { WindowTitleBar } from './components/layout/WindowTitleBar';
import { OnboardingShell } from './components/onboarding/OnboardingShell';
import { Button } from './components/ui/button';
import { useGateStatus } from './hooks/useGateStatus';

// Lazy-load the main App so its heavy hooks (session restore, worktree
// hydration, etc.) do not run until the user is registered.
const App = lazy(() => import('./App'));

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
 *
 * All query orchestration and gate derivation now live in useGateStatus; this
 * component is a pure stage → shell mapping to eliminate startup jitter (single
 * state source, background refetch never regresses to LoadingShell).
 */
export default function Root() {
  const { gateStatus, runtime, setRuntimeOverride, invalidateAll } = useGateStatus();

  switch (gateStatus.stage) {
    case 'loading':
      return <LoadingShell />;

    // Runtime probe failed for a non-"missing CLI" reason (IPC crash, fs
    // permission, transient PATH lookup, etc.). Show an explicit retry surface
    // instead of routing the user into onboarding — that would suggest "Claude
    // is not installed" and hide the real problem.
    case 'runtime-failed':
      return (
        <RuntimeDetectionFailedShell
          error={gateStatus.error}
          retrying={gateStatus.retrying}
          onRetry={() => {
            setRuntimeOverride(null);
            void runtime.refetch();
          }}
        />
      );

    // Registration is the mandatory trunk; whether the CLI exists (and thus
    // whether AiClient can run) is surfaced afterwards on the completion screen.
    case 'onboarding':
      switch (gateStatus.variant) {
        // User never registered — full onboarding from the welcome screen.
        // vscodeExtension (when set) surfaces the "return to VSCode" hint on
        // the completion screen right after registering, same as cli-missing.
        case 'register':
          return (
            <OnboardingShell
              vscodeExtension={gateStatus.vscodeExtension}
              onComplete={invalidateAll}
            />
          );
        // Registered but Claude CLI is missing (register-only flow, or the
        // machine only has the VSCode extension). Re-enter onboarding at the
        // completion screen; registration is done, credentials are persisted.
        // vscodeExtension (when set) lets the screen add a "return to VSCode"
        // hint since the extension reads the same ~/.claude credentials.
        case 'cli-missing':
          return (
            <OnboardingShell
              alreadyRegistered
              initialStep="result"
              vscodeExtension={gateStatus.vscodeExtension}
              onComplete={invalidateAll}
            />
          );
        // Self-heal: registered + CLI present, but ~/.claude/settings.json lost
        // its env (or codex auth.json lost its key). Drop back into the
        // registration step so the user can re-mint tokens. Skip the CLI install
        // gate by forcing initialStep='register-email' — they already have the
        // tools.
        case 'credentials-unhealthy':
          return <OnboardingShell initialStep="register-email" onComplete={invalidateAll} />;
      }
      break;

    case 'ready':
      return (
        <Suspense fallback={<LoadingShell />}>
          <div className="relative z-0 flex h-screen flex-col overflow-hidden">
            {/* bun-incompatible runtime warning now lives in the title bar
                (ClaudeRuntimeIndicator) instead of a full-width banner. */}
            <div className="flex-1 overflow-hidden">
              <App />
            </div>
          </div>
        </Suspense>
      );
  }

  // Unreachable: switch is exhaustive over GateStatus stages/variants.
  return <LoadingShell />;
}
