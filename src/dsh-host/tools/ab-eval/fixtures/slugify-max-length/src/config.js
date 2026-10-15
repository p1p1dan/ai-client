/** Defaults shared by every text helper; callers override them per call. */
export const DEFAULTS = Object.freeze({
  separator: '-',
  lowercase: true,
});

/** The caller's options over the defaults, validated. */
export function resolveOptions(options = {}) {
  const resolved = { ...DEFAULTS, ...options };
  if (typeof resolved.separator !== 'string' || resolved.separator.length === 0) {
    throw new TypeError('separator must be a non-empty string');
  }
  if (typeof resolved.lowercase !== 'boolean') {
    throw new TypeError('lowercase must be a boolean');
  }
  return resolved;
}
