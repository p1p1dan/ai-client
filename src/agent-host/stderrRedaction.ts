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
 * path). Credential rules run before the path rule so a secret inside a path
 * (`/home/dan/.keys/sk-ant-xxx`) is destroyed, not merely relocated.
 */
const REDACTION_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // Anthropic key material by shape, wherever it appears.
  { pattern: /sk-ant-[A-Za-z0-9_-]+/g, replacement: '[redacted]' },
  // Values assigned to ANY ANTHROPIC_* variable (env dumps, error echoes):
  // `ANTHROPIC_AUTH_TOKEN=…`, `ANTHROPIC_BASE_URL: "…"`. The name survives —
  // WHICH variable was involved is exactly the diagnostic fact.
  {
    pattern: /(ANTHROPIC_[A-Z0-9_]+\s*[=:]\s*)("?)[^\s"']+/g,
    replacement: '$1$2[redacted]',
  },
  // HTTP auth headers echoed into errors.
  { pattern: /(Bearer\s+)[^\s"']+/g, replacement: '$1[redacted]' },
  { pattern: /(x-api-key["':\s=]+)[^\s"']+/gi, replacement: '$1[redacted]' },
  // User-directory prefixes, all three OS shapes → `~` (username collapsed,
  // path tail kept).
  { pattern: /(?:\/home|\/Users)\/[^/\\\s"':]+/g, replacement: '~' },
  { pattern: /[A-Za-z]:\\Users\\[^\\/\s"':]+/g, replacement: '~' },
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
  return redacted;
}

/** What the Host actually emits: redacted, then clamped. */
export function sanitizeStderrLine(line: string): string {
  const redacted = redactStderrLine(line);
  return redacted.length > STDERR_LINE_MAX_CHARS
    ? `${redacted.slice(0, STDERR_LINE_MAX_CHARS)}…`
    : redacted;
}
