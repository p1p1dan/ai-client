import { existsSync, readFileSync } from 'node:fs';
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

/**
 * A3 (D65) — static wiring for the retirement of the startup agent probes and
 * the git check's new home.
 *
 * Same method as the suite above (source scan with comments stripped), and for
 * the same reason: these are wiring facts — which module reads which signal —
 * that no unit test of a pure function can reach, and there is no DOM harness
 * in this repo to render the component against.
 */
describe('A3/D65 startup-probe retirement + git notice (static)', () => {
  it('[A3-01] Root.tsx no longer runs a system-CLI detection query for the gate', () => {
    const root = code('Root.tsx').replace(/\s+/g, ' ');
    // Positive half first, so a rename of the gate call cannot let the negative
    // halves below pass against a file that no longer gates anything.
    expect(root).toContain('resolveGateDecision(');
    expect(root).not.toContain('onboardingCliStatus');
    expect(root).not.toContain('detectCli()');
    expect(root).not.toContain('cliStatus');
  });

  it('[A3-02] the git check survives as a mounted notice, not as a gate input', () => {
    const app = code('App.tsx').replace(/\s+/g, ' ');
    expect(app).toContain('<GitMissingNotice />');
    expect(app).toContain("from './components/layout/GitMissingNotice'");
  });

  it('[A3-03] the notice never blocks: no dialog, no modal, no gate return', () => {
    // D65 says keep the check and, on non-Windows, "just give a hint". A modal
    // on launch would be the old blocking behaviour wearing a new component
    // name, so the ban is asserted rather than trusted to review.
    const notice = code('components/layout/GitMissingNotice.tsx').replace(/\s+/g, ' ');
    expect(notice).toContain('checkPrerequisites()');
    expect(notice).not.toContain('Dialog');
    expect(notice).not.toContain('AlertDialog');
  });

  it('[A3-04] the install action is offered ONLY where it can actually work', () => {
    // `AgentInstaller.installGit` is guarded by `ensureWindowsOnly`, so offering
    // the button anywhere else would be a control that throws. This is the
    // concrete gap D65 asked to close — mac/Linux used to get detection and
    // then silence — so both halves are pinned: the platform test, and the
    // fallback that replaces the button.
    const notice = code('components/layout/GitMissingNotice.tsx').replace(/\s+/g, ' ');
    expect(notice).toContain("env.platform === 'win32'");
    expect(notice).toContain('installGit()');
    expect(notice).toContain('openExternal(');
    expect(notice).toContain('https://git-scm.com/downloads');
  });

  it('[A3-05] a failed detection is not reported as "git is missing"', () => {
    // The false-positive direction is the one that matters: telling a user who
    // has git that they do not is worse than staying quiet, because the notice
    // then contradicts a machine they can check in one command.
    const notice = code('components/layout/GitMissingNotice.tsx').replace(/\s+/g, ' ');
    expect(notice).toContain('catch { setMissing(false); }');
  });

  it('[A3-06] Main installs git ALONE — installAll would drag in a Node we already bundle', () => {
    const handler = readFileSync(join(process.cwd(), 'src/main/ipc/onboarding.ts'), 'utf8');
    const stripped = stripComments(
      handler,
      join(process.cwd(), 'src/main/ipc/onboarding.ts')
    ).replace(/\s+/g, ' ');
    expect(stripped).toContain('ONBOARDING_INSTALL_GIT');
    expect(stripped).toContain('installer.installGit()');
    // The tempting shortcut (`installAll([])` skips both agents and still runs
    // the git prerequisite) drags the Node install along with it, and Node
    // ships in `resources/node-runtime` — installing a second one satisfies
    // nothing. D70 later ruled that a Node install would be ACCEPTABLE if it
    // ever became necessary, provided it is silent and in the background; the
    // pin stays because "acceptable" is not "needed", and the narrow path is
    // already built and tested.
    expect(stripped).not.toContain('installAll([])');
  });
});

/**
 * A2 — static wiring for the two-button welcome screen.
 *
 * Same method and same reason as the suites above: these are wiring and policy
 * facts (which module renders what, which copy is banned) that a pure-function
 * test cannot reach and this repo has no DOM harness to render.
 */
describe('A2 two-button welcome screen (static)', () => {
  it('[A2-01] Root renders the welcome shell for the welcome decision', () => {
    const root = code('Root.tsx').replace(/\s+/g, ' ');
    expect(root).toContain("decision.shell === 'welcome'");
    expect(root).toContain('<WelcomeShell');
    expect(root).toContain('decision.welcome');
  });

  it('[A2-02] all three ways in go through enterApp, and the two buttons record DIFFERENT modes', () => {
    // Recording the same value from both buttons would make the second one a
    // slower way of choosing the first. And every way in must latch entry
    // through the same call: a recorded mode with no entry leaves the user
    // staring at the screen they just answered.
    const root = code('Root.tsx').replace(/\s+/g, ' ');
    expect(root).toContain("enterApp('managed')");
    expect(root).toContain("enterApp('local')");
    // Three call sites: Continue, Use-my-own-setup, and sign-in completion.
    expect(root.match(/enterApp\(/g) ?? []).toHaveLength(3);
  });

  it('[A2-02b] the welcome screen is the STARTUP screen — no stored value can skip it', () => {
    // User ruling 2026-08-27:「就是启动首屏，每次都出现」. The gate's only
    // non-runtime route into App is the per-run entry latch, so nothing
    // persisted — signed-in state, a recorded credential mode — can retire the
    // screen. This also removes the need for a separate switch-source control.
    const gatePath = join(process.cwd(), 'src/shared/authGate.ts');
    const gate = stripComments(readFileSync(gatePath, 'utf8'), gatePath);
    // Scoped to `resolveGateDecision`'s own body: `resolveSpawnGateDecision`
    // lives in the same file and legitimately keeps a `managed` input — it
    // answers a different question ("does starting a session need an account"),
    // and a whole-file ban would fail on correct code.
    const start = gate.indexOf('export function resolveGateDecision');
    const body = gate.slice(start, gate.indexOf('\nfunction welcomeShell', start));
    expect(body).toContain('input.entered');
    for (const term of ['CredentialMode', 'credentialMode', 'legacyRegistered', 'managed']) {
      expect(body).not.toContain(term);
    }
    // Guard the guard: an index that missed would leave an empty slice, and
    // every ban above would pass on nothing.
    expect(body).toContain('runtimeStatus');
  });

  it('[A2-03] recording a mode never touches the vault — switching costs no re-verification', () => {
    // D64 keeps the choice and the credentials in separate files precisely so
    // that a user who tries their own setup and comes back is still signed in.
    const handler = readFileSync(join(process.cwd(), 'src/main/ipc/auth.ts'), 'utf8');
    const stripped = stripComments(handler, join(process.cwd(), 'src/main/ipc/auth.ts'));
    const body = stripped.slice(stripped.indexOf('AUTH_ENTER_APP'));
    const handlerBody = body.slice(0, body.indexOf('});'));
    expect(handlerBody).toContain('setCredentialMode(mode)');
    expect(handlerBody).toContain('markAppEntered()');
    for (const term of ['Vault', 'signOut', 'markRejected']) {
      expect(handlerBody).not.toContain(term);
    }
  });

  it('[A2-04] the welcome screen reports no availability — D68', () => {
    // D68: no detection, no greying out, no "found your subscription". The
    // buttons describe what they DO; E1 measured that a static probe of what
    // is on the machine is wrong in both directions.
    const view = code('components/onboarding/WelcomeView.tsx');
    for (const term of ['checkPrerequisites', 'detectCli', 'credentials.json', 'disabled={!']) {
      expect(view).not.toContain(term);
    }
  });

  it('[A2-05b] the login button names no single email domain — two are accepted', () => {
    // `@jcdz.cc` and `@wuhanjingce.com` both pass `isValidEmailFormat`, so a
    // button naming one would read as excluding the other, and adding a third
    // later would mean editing a label.
    const view = code('components/onboarding/WelcomeView.tsx');
    expect(view).not.toContain('jcdz.cc');
    expect(view).not.toContain('wuhanjingce');
  });

  it('[A2-05] the second button is not labelled BYOK — the route is wider than that', () => {
    // E1 §L1 measured a plain Claude subscription login authenticating on its
    // own, no API key involved. "Bring your own key" would tell every
    // subscription user this button is not for them.
    const view = code('components/onboarding/WelcomeView.tsx');
    expect(view).toContain("t('Use my own setup')");
    expect(view.toLowerCase()).not.toContain('bring your own key');
  });

  it('[A2-06] the primary button names the account when there is one to continue with', () => {
    const view = code('components/onboarding/WelcomeView.tsx').replace(/\s+/g, ' ');
    expect(view).toContain("entry.primary === 'continue'");
    expect(view).toContain('entry.email');
    expect(view).toContain("t('Log in with work email')");
  });

  it('[A2-07] the retired onboarding steps and the VSCode-only shell are gone', () => {
    const view = code('components/onboarding/OnboardingView.tsx');
    for (const term of ["'cli-check'", "'cli-install'", 'installAgents', 'detectCli']) {
      expect(view).not.toContain(term);
    }
    expect(existsSync(join(RENDERER_DIR, 'components/onboarding/ClaudeVsCodeOnlyShell.tsx'))).toBe(
      false
    );
  });

  it('[A2-08] the logo ships no external asset', () => {
    // `scripts/assert-no-webfonts.mjs` guards the packaged build; this pins the
    // same rule at the source so a later edit fails here first.
    const mark = code('components/onboarding/AiClientMark.tsx');
    // The SVG namespace URI and same-document `url(#id)` gradient references
    // are not fetches — the CSP and the packaging gate both care about
    // requests to another HOST. Banning the literal strings instead would fail
    // on a correct file, which is the vacuous-red twin of a vacuous green.
    const externalRefs = mark.match(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/g) ?? [];
    expect(externalRefs).toEqual([]);
    expect(mark).not.toContain('<img');
    expect(mark).not.toMatch(/url\(\s*['"]?[^#'")]/);
    expect(mark).toContain('var(--primary)');
  });
});
