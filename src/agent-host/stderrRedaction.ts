/**
 * T-35: redaction for CLI stderr lines BEFORE they cross IPC to the renderer
 * (`session.stderr` events). The Main-process bridge is a content-agnostic
 * passthrough, so this module is the only gate between a leaked credential in
 * stderr and the UI (and anything that screenshots it).
 *
 * T042 widened that job: `redactCredentials` below is now the ONE credential
 * rule set in the repo, and every exit a worker's stderr or a provider's error
 * body can take runs through it — the IPC event, the `log` sink, the crash
 * replay that reaches main.log at error level, the run trace, and the session
 * JSONL. Before that, redaction sat on the IPC exit alone and the runtime kept
 * a second, weaker copy of the rules for the other exits.
 *
 * Nothing like this existed in the repo before (the closest prior art,
 * `claudeSettings.ts`'s diagnostics, sidesteps the problem by deriving
 * booleans and never carrying raw values) — these rules are new and their
 * scope is deliberate:
 *
 *  - credential-shaped substrings are DESTROYED (`[redacted]`);
 *  - user-directory prefixes are COLLAPSED to `~` — the sensitive part of a
 *    path is the username, and wiping the whole path would gut the diagnostic
 *    value stderr exists to deliver (`ENOENT …/claude` with the tail intact
 *    is the difference between a useful line and noise). Non-user absolute
 *    paths (`/usr/lib/…`) reveal nothing personal and pass through.
 *
 * Pure string → string, no imports — assertable in vitest's node environment.
 */

/**
 * Stand-in for the caller's placeholder inside the rule templates below.
 * Substituted with `split`/`join`, never with `replace`, so a placeholder can
 * never be read as a `$1`-style replacement pattern.
 */
const MASK = '<mask>';

/** What the stderr exits write in place of a destroyed value. */
export const STDERR_REDACTION_PLACEHOLDER = '[redacted]';

/**
 * Ordered rules; every rule runs on every line (a line can hold a token AND a
 * path). Credential rules run before the path rules so a secret inside a path
 * (`/home/dan/.keys/sk-ant-xxx`) is destroyed, not merely relocated.
 *
 * Review-hardened set (Codex adversarial pass, 2026-08-05): provider-generic
 * key shapes, case-insensitive auth schemes, Basic blobs (base64 is
 * reversible — the whole token dies), URL authority userinfo, and a generic
 * sensitive-assignment rule with real value-shape handling (JSON keys, quoted
 * values with spaces, escaped quotes). Over-masking is the safe direction;
 * every rule keeps the NAME of what was masked, because "which credential was
 * involved" is itself the diagnostic fact.
 */
const CREDENTIAL_RULES: ReadonlyArray<{ pattern: RegExp; template: string }> = [
  // Key material by shape, wherever it appears. The set is enumerable
  // provider prefixes plus a generic long-sk catchall — bare keys carry no
  // sensitive-field name for the assignment rule to hook, so shape is the
  // only handle (review F2, two rounds).
  { pattern: /sk-ant-[A-Za-z0-9_-]+/g, template: MASK },
  { pattern: /\bsk-proj-[A-Za-z0-9_-]+/g, template: MASK },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, template: MASK },
  { pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g, template: MASK },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, template: MASK },
  { pattern: /\bAIza[A-Za-z0-9_-]{16,}/g, template: MASK },
  // AWS access key ids: AKIA = long-lived, ASIA = temporary/STS (round 3).
  { pattern: /\bA(?:KIA|SIA)[A-Z0-9]{12,}/g, template: MASK },
  // HTTP auth schemes, case-insensitive, whole token destroyed.
  { pattern: /((?:bearer|basic)\s+)[^\s"']+/gi, template: `$1${MASK}` },
  { pattern: /(x-api-key["':\s=]+)[^\s"']+/gi, template: `$1${MASK}` },
  // URL authority userinfo (proxy errors, base-URL echoes):
  // `scheme://user:pass@host` / `scheme://token@host` → `scheme://[redacted]@host`.
  { pattern: /([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/gi, template: `$1${MASK}@` },
];

/**
 * Rules with the placeholder already baked in, one set per placeholder. Two
 * casings are in the wild (see `redactCredentials`) and both are on a hot
 * path — every worker stderr line goes through this — so the substitution is
 * done once rather than per line.
 */
const COMPILED_RULES = new Map<string, ReadonlyArray<{ pattern: RegExp; replacement: string }>>();

function rulesFor(placeholder: string): ReadonlyArray<{ pattern: RegExp; replacement: string }> {
  const cached = COMPILED_RULES.get(placeholder);
  if (cached) return cached;
  const compiled = CREDENTIAL_RULES.map((rule) => ({
    pattern: rule.pattern,
    replacement: rule.template.split(MASK).join(placeholder),
  }));
  COMPILED_RULES.set(placeholder, compiled);
  return compiled;
}

/**
 * Values assigned to sensitive-named variables/fields — env dumps, config
 * echoes, JSON fragments. Three value shapes are consumed whole (double- or
 * single-quoted incl. escapes and inner spaces, or a bare token), and the
 * name may itself be JSON-quoted. The name survives; the value dies.
 */
const SENSITIVE_ASSIGNMENT = new RegExp(
  '(["\']?)(' +
    [
      'ANTHROPIC_[A-Z0-9_]+',
      '[A-Z][A-Z0-9_]*_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|SECRET|TOKEN|PASSWORD)',
      'api[_-]?key',
      'access[_-]?token',
      'auth[_-]?token',
      'refresh[_-]?token',
      'client[_-]?secret',
      'password',
    ].join('|') +
    ')\\1(\\s*[=:]\\s*)("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|[^\\s"\']+)',
  'gi'
);

function redactSensitiveAssignments(line: string, placeholder: string): string {
  return line.replace(SENSITIVE_ASSIGNMENT, (_match, quote, name, separator, value) => {
    const valueQuote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
    return `${quote}${name}${quote}${separator}${valueQuote}${placeholder}${valueQuote}`;
  });
}

/**
 * The repository's one credential-redaction rule set.
 *
 * T042 (main-aux-06 / ah-lib-01 / ah-lib-02) merged the second copy into this
 * one. That copy — `src/runtime/plugins/agent-loop/providerErrors.ts`, written
 * for T011 — knew `authorization: bearer …` and three `name = value` shapes
 * and nothing else, so a bare `sk-proj-…` in a gateway's error prose died on
 * the way to the stderr panel and survived into `runs.jsonl` and the session
 * file. `providerErrors.ts` now calls this function; the runtime already
 * depends on this package (`piSessionTimeline`, `permissionPolicy.mjs`), so
 * the shared rule lives in the depended-on layer and nothing new crosses the
 * boundary in the other direction.
 *
 * Credentials only — the user-directory rules stay with `redactStderrLine`,
 * because collapsing `/home/dan` to `~` is about a username, not a secret, and
 * a provider error body has no reason to be rewritten that way.
 *
 * The placeholder is a parameter because two casings already ship and both are
 * pinned by tests: stderr writes `[redacted]`, the provider/trace path writes
 * `[REDACTED]`. Unifying the casing would change output that readers already
 * match on, for no security gain. The placeholder must not contain `$`.
 */
export function redactCredentials(
  text: string,
  placeholder: string = STDERR_REDACTION_PLACEHOLDER
): string {
  let redacted = text;
  for (const rule of rulesFor(placeholder)) {
    redacted = redacted.replace(rule.pattern, rule.replacement);
  }
  return redactSensitiveAssignments(redacted, placeholder);
}

/**
 * User-directory prefixes → `~` (username collapsed, path tail kept). Non-user
 * absolute paths (`/usr/lib/…`) reveal nothing personal and pass through.
 */
/**
 * The three Windows-origin families get TWO rules each (review F5, round 2):
 * a primary that allows spaces and apostrophes in the username — real
 * Windows profiles have them (`Alice Smith`, `O'Neil`) — bounded to 40 chars
 * and anchored by a lookahead for a following separator so it cannot run off
 * into prose, plus a conservative space-excluding fallback for a path-final
 * username. POSIX/macOS keeps the conservative rule only: spaces are not
 * legal in practice there, and a space-tolerant forward-slash rule would eat
 * the prose between two paths on the same line. Ordering: drive rules before
 * POSIX, or the POSIX rule eats the `/Users/Alice` substring of
 * `C:/Users/Alice` and leaves `C:~`.
 */
const PATH_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // Windows drive, both separator styles (C:\Users\Alice, C:/Users/Alice).
  { pattern: /[A-Za-z]:[\\/]Users[\\/][^\\/":]{1,40}(?=[\\/])/g, replacement: '~' },
  { pattern: /[A-Za-z]:[\\/]Users[\\/][^\\/\s"':]+/g, replacement: '~' },
  // WSL-mapped Windows home (/mnt/c/Users/Alice).
  { pattern: /\/mnt\/[a-z]\/Users\/[^/\\":]{1,40}(?=\/)/gi, replacement: '~' },
  { pattern: /\/mnt\/[a-z]\/Users\/[^/\s"':]+/gi, replacement: '~' },
  // UNC shares incl. \\wsl.localhost\<distro>\home\<user>.
  {
    pattern: /\\\\[^\\\s"']+(?:\\[^\\\s"']+)*?\\(?:Users|home)\\[^\\":]{1,40}(?=\\)/gi,
    replacement: '~',
  },
  { pattern: /\\\\[^\\\s"']+(?:\\[^\\\s"']+)*?\\(?:Users|home)\\[^\\\s"':]+/gi, replacement: '~' },
  // POSIX / macOS home.
  { pattern: /(?:\/home|\/Users)\/[^/\\\s"':]+/g, replacement: '~' },
];

/**
 * IPC payload cap. Generous for real diagnostics (multi-line stack traces
 * arrive as separate callback lines anyway); what it bounds is a pathological
 * single line.
 */
export const STDERR_LINE_MAX_CHARS = 2000;

/**
 * Per-turn forwarding cap: a subprocess stuck in a retry loop streams stderr
 * for as long as it runs, and the renderer must not pay one IPC event per line
 * for it. The log keeps every line regardless — the cap only bounds the UI
 * excerpt. Enforced by `WorkerManager.forwardStderr`, which is this module's
 * caller since T017 gave `session.stderr` a producer again.
 */
export const STDERR_FORWARD_MAX_LINES_PER_TURN = 50;

/** Redaction only — exported separately so tests can pin rules without the clamp. */
export function redactStderrLine(line: string): string {
  let redacted = redactCredentials(line, STDERR_REDACTION_PLACEHOLDER);
  for (const rule of PATH_RULES) {
    redacted = redacted.replace(rule.pattern, rule.replacement);
  }
  return redacted;
}

/** What the Host actually emits: redacted, then clamped. */
export function sanitizeStderrLine(line: string): string {
  const redacted = redactStderrLine(line);
  return redacted.length > STDERR_LINE_MAX_CHARS
    ? `${redacted.slice(0, STDERR_LINE_MAX_CHARS)}…`
    : redacted;
}
