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
    expect(view).toContain('Your sign-in has expired. Verify your email again.');
    // D47 S5: the initialEmail prefill this mutation guards.
    expect(view).toContain('useState(initialEmail');
  });

  it('[AGW-05] the account chip drives its three states off deriveUserProfilePresentation', () => {
    // D07 moved the chip from `WindowTitleBar` (now identity + window buttons
    // only) down to the left column's footer; D08 gave it its own file,
    // `UserFooterPill.tsx`, so it survives a dock surface switch. The assertion
    // follows the code rather than the filename — what matters is that whichever
    // component renders it branches on `presentation.tone` instead of an "is
    // registered" boolean, so `invalid` / `signed_out` keep their own clickable
    // affordance.
    const nav = code('components/workspace-shell/UserFooterPill.tsx').replace(/\s+/g, ' ');
    expect(nav).toContain("from '@shared/authGate'");
    expect(nav).toContain('deriveUserProfilePresentation(');
    expect(nav).toContain('presentation.tone');
    // Retired: it never reads its own `onboardingState` query — the gate
    // snapshot is the single source of truth.
    expect(nav).not.toMatch(/queryKey:\s*\['onboardingState'\]/);
    // And the title bar must not grow a second copy of it.
    const titleBar = code('components/layout/WindowTitleBar.tsx').replace(/\s+/g, ' ');
    expect(titleBar).not.toContain('deriveUserProfilePresentation(');
  });

  it('[AGW-06] UserProfileCard.tsx consumes the presentation prop, not a raw email string', () => {
    const card = code('components/user/UserProfileCard.tsx').replace(/\s+/g, ' ');
    expect(card).toContain('UserProfilePresentation');
    expect(card).toContain('presentation.tone');
    // The clickable affordance the `attention`/`signed-out` tones exist for.
    // It used to be a bare `AUTH_OPEN_ONBOARDING_EVENT` dispatch, which could
    // never route anywhere — see the sign-in route suite below.
    expect(card).toContain('useSignInRequest()');
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
    expect(handlerBody).toContain('markAppEntered(mode)');
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

  it('[A2-09] the local-setup button is closed by a named switch, not by a probe', () => {
    // A-round testing shuts the `Use my own setup` route. The switch must be
    // the thing the button reads, so nobody can "fix" a stuck screen by
    // hardcoding the disabled state and leaving the constant behind as a lie.
    //
    // This is NOT the D68 ban above being broken: [A2-04] forbids REPORTING
    // AVAILABILITY — greying a button out because a probe judged the machine
    // unready — and the terms it bans (`checkPrerequisites`, `detectCli`,
    // `credentials.json`) are still absent. Nothing here asks the machine
    // anything; it would look the same on a perfectly configured one.
    const view = code('components/onboarding/WelcomeView.tsx').replace(/\s+/g, ' ');
    expect(view).toContain('LOCAL_SETUP_ENTRY_DISABLED = ');
    expect(view).toContain('disabled={LOCAL_SETUP_ENTRY_DISABLED ||');
    // Still rendered — closed, not deleted.
    expect(view).toContain("t('Use my own setup')");
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

/**
 * The in-app sign-in route — every 登录 / 重新登录 affordance that is not the
 * welcome screen itself.
 *
 * ## The defect
 *
 * All of them did the same two lines inline: close the surface, dispatch
 * `AUTH_OPEN_ONBOARDING_EVENT`. Root listened and invalidated two queries,
 * trusting the gate to route. It cannot — `resolveGateDecision` returns `app`
 * for as long as Main's entry latch is set, and the latch is set for as long as
 * the user is inside the app, so the refreshed snapshot produced the identical
 * decision every time. A machine on `Use my own setup` could not even fail
 * loudly: `resolveSpawnGateDecision` short-circuits `local` to "allowed", so
 * nothing was rejected and nothing was logged. The button did nothing.
 *
 * Behaviour lives in `authRequestSignIn.test.ts` (Main) and
 * `userProfileSignIn.test.ts` (a real click). What only a source scan can reach
 * is the CENSUS: that no surface kept its own copy of the broken two lines.
 */
describe('in-app sign-in route (static)', () => {
  const SURFACES: readonly [string, number][] = [
    // Each entry is [file, number of sign-in affordances in it].
    ['components/user/UserProfileCard.tsx', 1],
    // The session-failed card and the notice/alert card — two separate
    // components in one file, both offering 重新登录 on a spawn-gate rejection.
    ['components/chat/MessageTimeline.tsx', 2],
    ['components/chat/AgentTerminal.tsx', 1],
    // Not a button: the automatic `credentials_invalid` push. It can only
    // reach a run that is already `managed` (the probe scheduler runs during
    // `authenticated` only, and `local` never gets there), so it is safe on
    // the same request — and it was broken in exactly the same way.
    ['App.tsx', 1],
  ];

  it('[SIR-01] every surface goes through the shared hook, and none dispatches the event itself', () => {
    for (const [file, expected] of SURFACES) {
      const source = code(file).replace(/\s+/g, ' ');
      // Either spelling of the same module — `App.tsx` imports its siblings
      // relatively, everything under `components/` uses the alias.
      expect(source, file).toMatch(/from '(@\/|\.\/)hooks\/useSignInRequest'/);
      expect(source.match(/useSignInRequest\(\)/g) ?? [], file).toHaveLength(expected);
      // The two lines that never worked. A surface that grows them back is a
      // button that silently does nothing again.
      expect(source, file).not.toContain('AUTH_OPEN_ONBOARDING_EVENT');
    }
  });

  it('[SIR-02] the hook changes Main state FIRST and only then routes', () => {
    const hook = code('hooks/useSignInRequest.ts').replace(/\s+/g, ' ');
    const request = hook.indexOf('auth.requestSignIn()');
    const dispatch = hook.indexOf('AUTH_OPEN_ONBOARDING_EVENT)');
    expect(request).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(-1);
    // Order is the whole fix: the event is only meaningful once the gate has
    // something different to decide on.
    expect(request).toBeLessThan(dispatch);
    // A refused request must not route, and must not be silent either.
    expect(hook).toContain('if (!result.ok)');
    expect(hook).toContain('toastManager.add(');
  });

  it('[SIR-03] Main leaves the local mode AND drops the entry latch — neither alone works', () => {
    const path = join(process.cwd(), 'src/main/ipc/auth.ts');
    const stripped = stripComments(readFileSync(path, 'utf8'), path);
    const body = stripped.slice(stripped.indexOf('AUTH_REQUEST_SIGN_IN'));
    const handler = body.slice(0, body.indexOf('});'));
    // Leaving `local` is what stops the spawn gate answering "nothing to sign
    // in to"; clearing the latch is what lets the gate route off `app`.
    expect(handler).toContain("setCredentialMode('managed')");
    expect(handler).toContain('clearAppEntry()');
    // Not a logout: an account that is still valid has to come back as
    // `Continue as …` rather than a fresh code form (D64 keeps the recorded
    // choice and the credentials in separate files precisely for this).
    for (const term of ['Vault', 'logout', 'clear()', 'markRejected']) {
      expect(handler).not.toContain(term);
    }
  });

  /**
   * The safety net the route needed the moment it started working.
   *
   * Making the buttons work gave the app its first way to unmount `<App/>`
   * while somebody is using it, and that unmount kills every terminal in the
   * tree (a shell gets SIGKILL across its process group; a Pi TUI is disposed).
   * User ruling, 2026-09-18: 「这个肯定是不行的。需要安全的退出」 → 「先弹确认框，
   * 列明会丢什么」. Behaviour lives in `signInConfirmFlow.test.ts`; what only a
   * source scan can reach is that no surface bypasses it.
   */
  it('[SIR-05] the confirmation host is mounted, or every button fails closed', () => {
    // `requestSignInConfirmation` refuses (and the caller toasts) when no host
    // is registered — deliberately, since fail-open would route away with no
    // warning at all. That makes this mount the difference between a working
    // route and a route that always refuses.
    const app = code('App.tsx').replace(/\s+/g, ' ');
    expect(app).toContain('<SignInConfirmHost />');
    expect(app).toContain("from './components/auth/SignInConfirmHost'");
  });

  it('[SIR-06] the hook asks the user BEFORE it asks Main', () => {
    const hook = code('hooks/useSignInRequest.ts').replace(/\s+/g, ' ');
    const confirm = hook.indexOf('requestSignInConfirmation(');
    const ipc = hook.indexOf('auth.requestSignIn()');
    expect(confirm).toBeGreaterThan(-1);
    // Order is the whole guarantee: a cancel must leave the credential mode and
    // the entry latch exactly as they were.
    expect(confirm).toBeLessThan(ipc);
    expect(hook).toContain("if (outcome === 'declined') return false;");
    // Nothing to lose → no dialog. An empty confirmation is friction with no
    // content, and it teaches the user to click through the one that matters.
    expect(hook).toContain('hasSignInLosses(losses)');
  });

  it('[SIR-07] logout asks ONCE — its own dialog carries the losses', () => {
    const card = code('components/user/UserProfileCard.tsx').replace(/\s+/g, ' ');
    // Two boxes in a row for one decision, and the second one would arrive
    // after the vault was already cleared — a "cancel" that cannot undo
    // anything.
    expect(card).toContain("requestSignIn({ prompt: 'skip' })");
    // So the losses have to be IN the dialog it does show, with the logout
    // wording: `performLogoutSequence` stops every turn, where a plain
    // re-login leaves them running.
    expect(card).toContain('signInLossLines(logoutLosses, { terminatesTurns: true })');
    expect(card).toContain('readSignInLosses()');
  });

  it('[SIR-08] the automatic push gets the informational prompt, and it is the only one that does', () => {
    // Nobody pressed anything, so "are you sure?" would ask the user to confirm
    // a decision that was made for them. `session-expired` states the fact and
    // still lists the losses, with a defer instead of a cancel.
    const app = code('App.tsx').replace(/\s+/g, ' ');
    expect(app).toContain("requestSignIn({ prompt: 'session-expired' })");
    for (const [file] of SURFACES) {
      if (file === 'App.tsx') continue;
      expect(code(file), file).not.toContain('session-expired');
    }
  });

  it('[SIR-04] Root re-decides the sub-flow from the refreshed snapshot', () => {
    // Landing on the welcome screen and making the user press one more button
    // is the same defect one click shorter. Root asks `deriveWelcomeEntry` —
    // the function the screen itself renders from, so the two cannot disagree
    // — and opens the email/code form only when nobody is signed in.
    const root = code('Root.tsx').replace(/\s+/g, ' ');
    expect(root).toContain('deriveWelcomeEntry(');
    expect(root).toContain("primary === 'sign-in'");
    expect(root).toContain('setSignInFlow(');
  });
});
