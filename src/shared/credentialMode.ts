/**
 * Which credentials a run uses — and, since D64, a persisted CHOICE rather than
 * a build-time switch.
 *
 * ## What changed, and why the old shape had to go
 *
 * It used to be `AICLIENT_MANAGED_CREDENTIALS=1`, an environment variable. That
 * is the same defect [D58](../../docs/plans/openchamber-chat-refactor-ledger.md)
 * retired `AICLIENT_AGENT_CODEX` for: **a packaged user physically cannot set
 * it.** Nothing in the app injects it, the desktop launcher does not read a
 * shell profile, and there is no settings toggle — so on every machine that is
 * not a developer's, its value was decided by us at build time and could never
 * be anything else. A switch the product's users cannot reach is not a control.
 *
 * [D64](../../docs/plans/openchamber-chat-refactor-ledger.md) makes it a real
 * choice, stored in `~/.pilab/<profile>/settings.json`. The two-button login
 * page (plan `entry-and-environment`) is what will let a person set it; this
 * module is the rule both that page and every existing reader agree on.
 *
 * ## Deliberately NOT in the vault
 *
 * The vault holds credentials. This is a preference ABOUT credentials, and the
 * two have different lifetimes: logging out clears the vault and must not clear
 * the choice, or a logout would silently reroute the next session to whatever
 * the user's own config happens to say. Keeping them apart also means reading
 * the mode never needs the keyring unlocked.
 *
 * ## The default is `managed`, and it is a decision, not a fallback
 *
 * A settings file with no `credentialMode` key is treated as a FIRST RUN, and a
 * first run must sign in (user ruling, 2026-08-27: 「首次必须登录」). The
 * consequence is deliberate and worth stating where the rule lives: someone who
 * upgrades having never signed in — including a person who has been working
 * happily with their own API key — meets the login page once. That is the price
 * of "first run means sign in"; the alternative (infer the mode from whatever
 * credentials happen to be lying around) was considered and rejected.
 *
 * Existing users who HAVE signed in are unaffected: `adoption.ts` promotes
 * their credentials into the vault at boot, so they resolve to `managed` and
 * land signed-in without being asked for anything.
 *
 * ## Pure
 *
 * No fs, no electron. The caller supplies the settings object it already has.
 */

export const CREDENTIAL_MODE_SETTING_KEY = 'credentialMode';

/**
 * `managed` — credentials come from our vault, injected as env at spawn.
 * `local` — we supply nothing; the agent authenticates from the user's own
 * configuration, exactly as it did before managed credentials existed.
 */
export type CredentialMode = 'managed' | 'local';

export const CREDENTIAL_MODES: readonly CredentialMode[] = ['managed', 'local'];

/**
 * The dev-only override.
 *
 * Kept, unlike the flag it replaces, because a developer CAN reach it — and
 * because testing the `local` path otherwise means hand-editing a settings
 * file. Forced off in a packaged build for the same reason the flag had to go:
 * a control real users cannot reach must not be able to decide their behaviour.
 * Same shape as `resolveSkipAuthGate` (`shared/devFlags.ts`).
 */
export const CREDENTIAL_MODE_ENV = 'AICLIENT_MANAGED_CREDENTIALS';

/** The stored value, or `null` when the key is absent or is not one of the two modes. */
export function readCredentialModeSetting(settings: unknown): CredentialMode | null {
  if (typeof settings !== 'object' || settings === null) return null;
  const raw = (settings as Record<string, unknown>)[CREDENTIAL_MODE_SETTING_KEY];
  return CREDENTIAL_MODES.includes(raw as CredentialMode) ? (raw as CredentialMode) : null;
}

export interface ResolveCredentialModeInput {
  /**
   * The parsed `~/.pilab/<profile>/settings.json` — a THUNK, so it is only read
   * when it is actually consulted. The dev override below decides without it,
   * and making that short-circuit real means a `pnpm dev` run forcing local
   * never touches the file at all. A malformed value reads as "no choice
   * recorded".
   */
  settings: () => unknown;
  /** Defaults to `process.env`; only consulted when `isPackaged` is false. */
  env?: NodeJS.ProcessEnv;
  /** `app.isPackaged`. True forces the env override off. */
  isPackaged: boolean;
}

/**
 * Precedence, highest first:
 *
 *  1. the dev-only env override (`'1'` → managed, `'0'` → local), unpackaged only
 *  2. the recorded choice in settings
 *  3. `managed` — no choice recorded means first run, and a first run signs in
 *
 * `'0'` is honoured as an explicit LOCAL, not merely "not 1". Under the old
 * flag every non-`'1'` spelling meant off, so "off" and "unset" were the same
 * thing; now they are not, and a developer needs to be able to say the
 * difference between "force local" and "use whatever is recorded".
 */
export function resolveCredentialMode(input: ResolveCredentialModeInput): CredentialMode {
  if (!input.isPackaged) {
    const override = (input.env ?? process.env)[CREDENTIAL_MODE_ENV];
    if (override === '1') return 'managed';
    if (override === '0') return 'local';
  }
  return readCredentialModeSetting(input.settings()) ?? 'managed';
}
