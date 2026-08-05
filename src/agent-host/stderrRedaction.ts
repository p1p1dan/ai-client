/**
 * T-35: redaction for CLI stderr lines BEFORE they cross IPC to the renderer
 * (`session.stderr` events). The Main-process bridge is a content-agnostic
 * passthrough, so this module is the only gate between a leaked credential in
 * stderr and the UI (and anything that screenshots it).
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
const REDACTION_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // Key material by shape, wherever it appears: Anthropic's sk-ant-* at any
  // length, plus generic sk-* (sk-proj-…, sk-live-…) long enough to be
  // unambiguous.
  { pattern: /sk-ant-[A-Za-z0-9_-]+/g, replacement: '[redacted]' },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: '[redacted]' },
  // HTTP auth schemes, case-insensitive, whole token destroyed.
  { pattern: /((?:bearer|basic)\s+)[^\s"']+/gi, replacement: '$1[redacted]' },
  { pattern: /(x-api-key["':\s=]+)[^\s"']+/gi, replacement: '$1[redacted]' },
  // URL authority userinfo (proxy errors, base-URL echoes):
  // `scheme://user:pass@host` / `scheme://token@host` → `scheme://[redacted]@host`.
  { pattern: /([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/gi, replacement: '$1[redacted]@' },
];

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

function redactSensitiveAssignments(line: string): string {
  return line.replace(SENSITIVE_ASSIGNMENT, (_match, quote, name, separator, value) => {
    const valueQuote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
    return `${quote}${name}${quote}${separator}${valueQuote}[redacted]${valueQuote}`;
  });
}

/**
 * User-directory prefixes → `~` (username collapsed, path tail kept). Non-user
 * absolute paths (`/usr/lib/…`) reveal nothing personal and pass through.
 */
const PATH_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // Windows drive, both separator styles (C:\Users\Alice, C:/Users/Alice).
  // MUST run before the POSIX rule, which would otherwise eat the
  // `/Users/Alice` substring of `C:/Users/Alice` and leave `C:~`.
  { pattern: /[A-Za-z]:[\\/]Users[\\/][^\\/\s"':]+/g, replacement: '~' },
  // WSL-mapped Windows home (/mnt/c/Users/Alice) — same ordering reason.
  { pattern: /\/mnt\/[a-z]\/Users\/[^/\s"':]+/gi, replacement: '~' },
  // UNC shares incl. \\wsl.localhost\<distro>\home\<user>.
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
 * Per-turn forwarding cap: the endless `api_retry` loop this repo has already
 * fought (see `claudeRuntime.ts`'s TTFT watchdog) streams stderr forever, and
 * the renderer must not pay one IPC event per line for it. The Host log keeps
 * every line regardless — the cap only bounds the UI excerpt.
 */
export const STDERR_FORWARD_MAX_LINES_PER_TURN = 50;

/** Redaction only — exported separately so tests can pin rules without the clamp. */
export function redactStderrLine(line: string): string {
  let redacted = line;
  for (const rule of REDACTION_RULES) {
    redacted = redacted.replace(rule.pattern, rule.replacement);
  }
  redacted = redactSensitiveAssignments(redacted);
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
