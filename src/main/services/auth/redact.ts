/**
 * D47 S1 §2.5 — redaction for CredentialVault / OnboardingService console
 * diagnostics before they leave the process. Same paradigm as
 * `agent-host/stderrRedaction.ts` (shape rules first, then a generic
 * sensitive-assignment rule that keeps the field NAME and destroys the
 * VALUE), but this list is widened for HTTP/cookie-shaped leaks that never
 * show up in CLI stderr (`cookie`, `set-cookie`, `authorization`) and drops
 * the bare `key` name — too many false positives in this subsystem's own
 * log lines (`key=cache`, `public key=ed25519`) — in favor of
 * semantic-boundary names (`api[_-]?key`, `auth[_-]?token`, …).
 *
 * `tokenPreview` (the first-six-chars preview OnboardingService used to log)
 * is deliberately NOT special-cased here: it is deleted at the call site
 * instead (a preview is still a secret, per B-track 1.6), so the redactor
 * never has to reconstruct which six characters were "safe".
 */

/** Sensitive field/variable names, shared by the object-key check and the in-string assignment rule below. */
const SENSITIVE_NAMES = [
  'ANTHROPIC_[A-Z0-9_]+',
  'AICLIENT_CODEX_API_KEY',
  'OPENAI_API_KEY',
  '[A-Z][A-Z0-9_]*_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|SECRET|TOKEN|PASSWORD)',
  'api[_-]?key',
  'auth[_-]?token',
  'access[_-]?token',
  'refresh[_-]?token',
  'client[_-]?secret',
  'set-cookie',
  'cookie',
  'authorization',
  'password',
  'token',
];

/** Anchored — tests a bare object KEY (`{ authToken: '...' }`), independent of any string pattern. */
const SENSITIVE_KEY_NAME = new RegExp(`^(?:${SENSITIVE_NAMES.join('|')})$`, 'i');

/**
 * Provider key shapes with no field name to hook, plus HTTP auth schemes —
 * same catch-all family as `stderrRedaction.ts`. Runs BEFORE the
 * name+value rule below so `authorization: Bearer <token>` keeps the
 * scheme word (matching stderrRedaction's own convention) instead of being
 * redacted twice.
 */
const KEY_SHAPE_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-ant-[A-Za-z0-9_-]+/g, replacement: '[REDACTED]' },
  { pattern: /\bsk-proj-[A-Za-z0-9_-]+/g, replacement: '[REDACTED]' },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: '[REDACTED]' },
  { pattern: /((?:bearer|basic)\s+)[^\s"']+/gi, replacement: '$1[REDACTED]' },
  // `authorization` WITHOUT a recognized scheme — the bearer/basic rule above
  // already handled the scheme-prefixed case, so skip it here to avoid
  // redacting the same value twice.
  {
    pattern: /(authorization["':\s=]+)(?!(?:bearer|basic)\s)[^\s"']+/gi,
    replacement: '$1[REDACTED]',
  },
];

/**
 * Values assigned to sensitive-named variables/fields inside a STRING — env
 * dumps, config echoes, JSON fragments. `authorization` is deliberately
 * excluded here (see `KEY_SHAPE_RULES` above) — it is the one name that
 * collides with the bearer/basic scheme rule.
 */
const SENSITIVE_ASSIGNMENT = new RegExp(
  '(["\']?)(' +
    SENSITIVE_NAMES.filter((name) => name !== 'authorization').join('|') +
    ')\\1(\\s*[=:]\\s*)("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|[^\\s"\']+)',
  'gi'
);

function redactSensitiveAssignments(text: string): string {
  return text.replace(SENSITIVE_ASSIGNMENT, (_match, quote, name, separator, value) => {
    const valueQuote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
    return `${quote}${name}${quote}${separator}${valueQuote}[REDACTED]${valueQuote}`;
  });
}

function redactString(value: string): string {
  let redacted = value;
  for (const rule of KEY_SHAPE_RULES) {
    redacted = redacted.replace(rule.pattern, rule.replacement);
  }
  return redactSensitiveAssignments(redacted);
}

function redactValue(value: unknown, seen: Set<unknown>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value instanceof Error) {
    const redactedError = new Error(redactString(value.message));
    redactedError.name = value.name;
    redactedError.stack = value.stack ? redactString(value.stack) : value.stack;
    return redactedError;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
    return value.map((entry) => redactValue(entry, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // A sensitive KEY name redacts the whole value outright — a nested
      // `{ authToken: { raw: '...' } }` must not survive just because the
      // secret itself isn't a string.
      out[key] = SENSITIVE_KEY_NAME.test(key) ? '[REDACTED]' : redactValue(entry, seen);
    }
    return out;
  }
  return value;
}

/**
 * Redact every log argument before it reaches `console.*`. Strings and Error
 * messages/stacks are scrubbed by pattern; plain objects/arrays are walked
 * recursively (cycle-safe, key-name aware) so a nested
 * `{ config: { claude: { authToken } } }` cannot leak a sentinel secret
 * through JSON.stringify downstream.
 */
export function redactLogArgs(args: unknown[]): unknown[] {
  return args.map((arg) => redactValue(arg, new Set()));
}
