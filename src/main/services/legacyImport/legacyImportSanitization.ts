import { LEGACY_IMPORT_MAX_TOOL_CHARS } from '@shared/types';

function boundedText(text: string, max: number): { text: string; truncated?: true } {
  if (text.length <= max) return { text };
  return { text: text.slice(0, max), truncated: true };
}

const SENSITIVE_KEY = /(token|secret|password|api[_-]?key|authorization|cookie|credential)/i;
const SECRET_TEXT =
  /(bearer\s+)[^\s]+|(sk-[A-Za-z0-9_-]{8,})|((?:api[_-]?key|token|password)\s*[:=]\s*)[^\s,;]+/gi;
const BASE64_LIKE = /^[A-Za-z0-9+/=_-]{512,}$/;

function sanitizeString(value: string): string {
  if (BASE64_LIKE.test(value)) return '[binary payload omitted]';
  return boundedText(
    value.replace(SECRET_TEXT, (_match, bearer, sk, assignment) => {
      if (bearer) return `${bearer}[redacted]`;
      if (sk) return '[redacted token]';
      return `${assignment ?? ''}[redacted]`;
    }),
    LEGACY_IMPORT_MAX_TOOL_CHARS
  ).text;
}

function sanitizeLegacyValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeLegacyValue(item, depth + 1));
  }
  if (typeof value !== 'object') return String(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeLegacyValue(item, depth + 1);
  }
  return output;
}

export function boundedSanitizedValue(value: unknown): unknown {
  const sanitized = sanitizeLegacyValue(value);
  try {
    const serialized = JSON.stringify(sanitized) ?? '';
    return serialized.length <= LEGACY_IMPORT_MAX_TOOL_CHARS
      ? sanitized
      : '[sanitized payload truncated]';
  } catch {
    return '[unserializable payload omitted]';
  }
}

export function sanitizedToolOutput(value: unknown): string {
  if (typeof value === 'string') return sanitizeString(value);
  try {
    return sanitizeString(JSON.stringify(sanitizeLegacyValue(value), null, 2) ?? '');
  } catch {
    return '[unserializable payload omitted]';
  }
}
