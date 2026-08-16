import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../components/chat/__tests__/stripComments';

/**
 * D47 S5b — static wiring assertions for the shared gate-decision pure
 * functions (`@shared/authGate`).
 *
 * Mirrors `shellSwitchStatic.test.ts`'s method: a source-text scan, not a
 * runtime import — `@shared/authGate`'s implementation belongs to a parallel
 * S5a work stream and this suite must stay meaningful (and green/red on the
 * right things) whether or not that module happens to be present/complete at
 * any given moment during the two streams' integration. Each assertion below
 * is a literal, non-empty substring match: a renamed/removed call site fails
 * loudly instead of a scan silently matching nothing (S5 spec §1.3 A-M10
 * "防 vacuous green").
 *
 * §1.4: "Root 与 MainWindow.isAppMountedFor 同吃此函数" — Root's half of that
 * claim is asserted here; `deriveOnboardingEntry`/`deriveUserProfilePresentation`
 * consumption is asserted per their listed consumers (OnboardingShell/View,
 * WindowTitleBar/UserProfileCard — the B-track M3 "漏项" the spec calls out
 * by name).
 */

const RENDERER_DIR = join(process.cwd(), 'src/renderer');

function code(relativePath: string): string {
  const full = join(RENDERER_DIR, relativePath);
  return stripComments(readFileSync(full, 'utf8'), full);
}

describe('D47 S5b auth-gate helper wiring (static)', () => {
  it('[AGW-01] Root.tsx routes every shell decision through resolveGateDecision', () => {
    const root = code('Root.tsx').replace(/\s+/g, ' ');
    expect(root).toContain("from '@shared/authGate'");
    expect(root).toContain('resolveGateDecision(');
    expect(root).toContain('decision.shell');
    // No leftover ad-hoc branch re-deriving the old registered/cliInstalled/
    // credentialsHealth chain locally — that logic now lives in the shared
    // pure function, not duplicated here.
    expect(root).not.toContain('credentialsHealth');
  });

  it('[AGW-02] Root.tsx reads the skip-gate flag from the argv snapshot, not a hardcoded constant', () => {
    const root = code('Root.tsx').replace(/\s+/g, ' ');
    expect(root).toContain('parseInitialAuthGateArg(');
    expect(root).not.toContain('SKIP_ONBOARDING_GATE');
  });

  it('[AGW-03] OnboardingShell.tsx threads reason/initialEmail through to OnboardingView', () => {
    const shell = code('components/onboarding/OnboardingShell.tsx').replace(/\s+/g, ' ');
    expect(shell).toContain('reason={reason}');
    expect(shell).toContain('initialEmail={initialEmail}');
  });

  it('[AGW-03b] Root.tsx re-keys the mounted OnboardingShell on (reason, initialEmail)', () => {
    // React `key` is set by the PARENT rendering the element, not the
    // component itself — B5-3's re-mount guard against a stale-mounted
    // instance silently keeping yesterday's copy/prefill therefore has to
    // live at Root's call site, not inside OnboardingShell.tsx.
    const root = code('Root.tsx').replace(/\s+/g, ' ');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on source text that itself contains a template placeholder
    expect(root).toContain('key={`${entry.reason}:${entry.initialEmail}`}');
  });

  it('[AGW-04] OnboardingView.tsx branches register-email copy/CTA on reason === expired (mutation ⑥ surface)', () => {
    const view = code('components/onboarding/OnboardingView.tsx').replace(/\s+/g, ' ');
    expect(view).toContain("reason === 'expired'");
    expect(view).toContain('登录已失效，请重新验证邮箱');
    // D47 S5: the initialEmail prefill this mutation guards.
    expect(view).toContain('useState(initialEmail');
  });

  it('[AGW-05] WindowTitleBar.tsx drives the three-state chip off deriveUserProfilePresentation', () => {
    const titleBar = code('components/layout/WindowTitleBar.tsx').replace(/\s+/g, ' ');
    expect(titleBar).toContain("from '@shared/authGate'");
    expect(titleBar).toContain('deriveUserProfilePresentation(');
    expect(titleBar).toContain('presentation.tone');
    // Retired: WindowTitleBar no longer reads its own `onboardingState` query.
    expect(titleBar).not.toMatch(/queryKey:\s*\['onboardingState'\]/);
  });

  it('[AGW-06] UserProfileCard.tsx consumes the presentation prop, not a raw email string', () => {
    const card = code('components/user/UserProfileCard.tsx').replace(/\s+/g, ' ');
    expect(card).toContain('UserProfilePresentation');
    expect(card).toContain('presentation.tone');
    expect(card).toContain('AUTH_OPEN_ONBOARDING_EVENT');
  });

  it('[AGW-07] App.tsx routes credentials_invalid back to onboarding via auth.stateChanged, not the retired live-credentials push', () => {
    const app = code('App.tsx').replace(/\s+/g, ' ');
    expect(app).toContain('auth.onStateChanged(');
    expect(app).toContain("'credentials_invalid'");
    expect(app).not.toContain('onLiveCredentialsStatus');
    expect(app).not.toContain('ONBOARDING_LIVE_CREDENTIALS_STATUS');
  });
});
