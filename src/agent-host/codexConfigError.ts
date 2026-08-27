/**
 * "Your codex config is broken, and here is which line" — as a wire error a
 * person can act on.
 *
 * S0'-b. It exists because S0' (**[D60](../../docs/plans/openchamber-chat-refactor-ledger.md)**)
 * made the user's own `~/.codex/config.toml` load-bearing. Before that we
 * pointed `CODEX_HOME` at a directory we owned and generated the config
 * ourselves, so a defect in the user's file could not reach us — it was
 * shielded, not handled. Taking the shield away hands us a failure mode we
 * never had to report before, which makes reporting it part of the same change
 * rather than a nicety after it.
 *
 * It is also what makes **[D63](../../docs/plans/openchamber-chat-refactor-ledger.md)**
 * honest. That ruling was "when we cannot tell whether the machine is usable,
 * let the user through anyway" — and letting someone through is only defensible
 * if the failure they walk into says what is wrong. Otherwise the ruling just
 * moves the cost onto them, which is the opposite of what it decided.
 *
 * ## The two failures, measured
 *
 * [E2 D 组](../../docs/plans/2026-08-26-s0-spikes/e2-codex-resume-and-inherited-keys.md)
 * measured the blast radius, and it is narrower than it sounds. Unknown keys,
 * wrong types, and an unreferenced `[profiles.x]` table are all HARMLESS —
 * codex loads the file and carries on. Exactly two things are fatal:
 *
 *  1. **A TOML syntax error.** Real messages, verbatim from the probe:
 *     `failed to load configuration: /home/u/.codex/config.toml:2:10: extra \`=\`, expected nothing`
 *     `failed to load configuration: /home/u/.codex/config.toml:1:6: key with no value, expected \`=\``
 *  2. **A legacy `profile = "x"` root line.**
 *     `failed to load configuration: legacy \`profile = "userprof"\` config is no longer supported; use \`--profile userprof\` with \`userprof.config.toml\` instead`
 *
 * Note the asymmetry, because it drives the code below: the syntax-error form
 * carries `<path>:<line>:<column>`, and the legacy-profile form carries NO path
 * at all. For the second one the file has to be named from elsewhere — codex
 * echoes its `codexHome` at `initialize`, which is where the caller gets it.
 *
 * ## Why `-c` cannot rescue either
 *
 * `-c` overrides are MERGED INTO a config that has already been loaded. When
 * loading itself fails there is nothing to merge into, so every override we
 * pass — including the posture — is irrelevant. This is not a gap to close; it
 * is why the failure has to surface instead of being worked around.
 *
 * ## Why the legacy-profile case deserves its own wording
 *
 * It is the one that will actually happen, and the one that looks like our bug.
 * `profile = "x"` was the supported spelling until codex replaced it with
 * per-profile files (`--profile x` + `<x>.config.toml`; the flag's type is
 * literally named `CONFIG_PROFILE_V2`). A user who configured codex before that
 * change did nothing wrong — and if the `codex` on their PATH is older, it
 * still works there. The symptom they experience is "codex is fine in my
 * terminal, but AiClient will not start", which is unactionable unless we say
 * which line and which spelling.
 *
 * ## Pure
 *
 * No fs, no env, no clock. It parses a string codex produced and returns a
 * description; the caller decides what to do with it.
 */

/** Prefix codex puts on every config-load failure [实测 E2 D 组, all three arms]. */
const CONFIG_LOAD_PREFIX = 'failed to load configuration:';

/**
 * `<path>:<line>:<column>: <reason>`.
 *
 * The comment here has been wrong twice, both times caught by a mutation that
 * could not be killed, so this version states what each piece actually does:
 *
 *  - **The `:(\d+):(\d+): ` requirement is what protects a Windows path.**
 *    `C:\Users\…` cannot be read as `file:line:column` because the character
 *    after `C:` is a backslash, not a digit. Earlier drafts credited first the
 *    greedy path group and then the end anchor; neither is doing that work.
 *  - **The path group is LAZY, and that is load-bearing.** When the message
 *    carries more than one `:<line>:<column>: ` — a reason that quotes a
 *    location of its own — the FIRST is the file that failed to load and the
 *    later one belongs to the reason text. A greedy group takes the last, and
 *    then names the wrong file with the wrong line: worse than saying nothing,
 *    because the user goes and edits a file that was fine. Killed by a mutation.
 *  - **The end anchor is redundant**, and honestly so: `(.*)` is greedy, so the
 *    reason runs to the end with or without it, and removing it kills no test.
 *    Kept because it states the intent — the whole message is consumed — but it
 *    is not a defence, and should not be described as one.
 */
const LOCATION_RE = /^(.*?):(\d+):(\d+): (.*)$/s;

/** `legacy \`profile = "<name>"\` config is no longer supported` [实测]. */
const LEGACY_PROFILE_RE = /^legacy `profile = "([^"]*)"` config is no longer supported/;

export type CodexConfigFailureKind = 'legacy_profile' | 'syntax_error' | 'unknown';

export interface CodexConfigLoadFailure {
  kind: CodexConfigFailureKind;
  /** Absolute path codex named, when it named one. `null` for `legacy_profile`, which carries no path. */
  file: string | null;
  /** 1-based, as codex reports it. `null` when the message carried no location. */
  line: number | null;
  column: number | null;
  /** The profile name from a `legacy_profile` message — what the user has to move into its own file. */
  profileName: string | null;
  /** Codex's own words, with its `failed to load configuration:` prefix stripped. Never paraphrased. */
  detail: string;
}

/**
 * Recognise a config-load failure in whatever codex said. `null` means "this is
 * some other error" — the caller must then leave it alone rather than dress an
 * unrelated failure in config-shaped wording.
 *
 * Accepts the `thread/start` rejection message AND the `configWarning`
 * notification's `details` field, because [实测 E2 D 组] the two carry the same
 * text with only the prefix differing — the notification arrives first (at
 * `initialize`) and the rejection follows.
 */
export function classifyCodexConfigLoadFailure(message: unknown): CodexConfigLoadFailure | null {
  if (typeof message !== 'string') return null;

  const prefixAt = message.indexOf(CONFIG_LOAD_PREFIX);
  // The `configWarning` notification carries the same text WITHOUT the prefix,
  // so a bare location or legacy-profile line is accepted on its own shape.
  const body =
    prefixAt >= 0 ? message.slice(prefixAt + CONFIG_LOAD_PREFIX.length).trim() : message.trim();
  if (!body) return null;

  const legacy = LEGACY_PROFILE_RE.exec(body);
  if (legacy) {
    return {
      kind: 'legacy_profile',
      file: null,
      line: null,
      column: null,
      profileName: legacy[1],
      detail: body,
    };
  }

  const located = LOCATION_RE.exec(body);
  if (located) {
    return {
      kind: 'syntax_error',
      file: located[1],
      line: Number.parseInt(located[2], 10),
      column: Number.parseInt(located[3], 10),
      profileName: null,
      detail: body,
    };
  }

  // Only a message that actually announced itself as a config-load failure may
  // fall through to `unknown`. Anything else is a different error entirely.
  return prefixAt >= 0
    ? { kind: 'unknown', file: null, line: null, column: null, profileName: null, detail: body }
    : null;
}

/**
 * The sentence a user reads.
 *
 * Three parts, in this order, and the order is the point: WHERE the problem is,
 * WHAT codex said about it, and WHAT to do. Codex's own text is quoted rather
 * than reworded — it is more precise than anything written here could be, and a
 * user searching the web for it will find codex's own issue tracker.
 *
 * `codexHome` is the directory codex reported at `initialize`. It is used only
 * to name the file for `legacy_profile`, whose message carries no path; passing
 * `null` degrades to naming the file generically rather than guessing a path.
 */
export function describeCodexConfigLoadFailure(
  failure: CodexConfigLoadFailure,
  codexHome: string | null
): string {
  const configFile =
    failure.file ?? (codexHome ? `${codexHome}/config.toml` : 'your codex config.toml');

  if (failure.kind === 'legacy_profile') {
    const name = failure.profileName ?? '<name>';
    return (
      `Codex refused to start because ${configFile} still uses the old profile syntax. ` +
      `Codex says: ${failure.detail}. ` +
      `Fix: remove the \`profile = "${name}"\` line and move that profile's settings into ` +
      `their own file next to it, named \`${name}.config.toml\`. ` +
      `This spelling was valid in older Codex releases, so an older \`codex\` on your PATH may still accept it.`
    );
  }

  if (failure.kind === 'syntax_error') {
    return (
      `Codex could not read ${configFile} (line ${failure.line}, column ${failure.column}). ` +
      `Codex says: ${failure.detail}. ` +
      `Fix: correct that line. No Codex session can start until the file parses.`
    );
  }

  return `Codex could not load its configuration. Codex says: ${failure.detail}.`;
}
