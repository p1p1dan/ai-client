/**
 * D47 S5 §1.3 — `SKIP_ONBOARDING_GATE` (a bare hardcoded `true` constant) is
 * retired in favor of `resolveSkipAuthGate`, a pure function of `env` +
 * `isPackaged`. Renderer no longer imports a constant; it reads the
 * `skipAuthGate` boolean off the argv-delivered initial snapshot
 * (`@shared/authGate`'s `parseInitialAuthGateArg`), computed by Main via this
 * same function so the two processes can never disagree.
 *
 * `AICLIENT_SKIP_AUTH_GATE=1` bypasses the onboarding/login gate — team-track
 * point-checks use test gateway tokens, never real onboarding creds. Forced
 * off in a packaged build regardless of the env var: the escape hatch is a
 * dev/CI convenience, never a production behavior.
 */
export function resolveSkipAuthGate(options: {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
}): boolean {
  if (options.isPackaged) return false;
  return options.env.AICLIENT_SKIP_AUTH_GATE === '1';
}
