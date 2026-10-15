import { resolveOptions } from './config.js';

/** Turns arbitrary text into a URL-safe slug. */
export function slugify(text, options) {
  const { separator, lowercase } = resolveOptions(options);
  const base = lowercase ? text.toLowerCase() : text;
  const slug = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, separator);
  return trimSeparator(slug, separator);
}

/** Drops leading and trailing separators. */
function trimSeparator(slug, separator) {
  let start = 0;
  let end = slug.length;
  while (slug.startsWith(separator, start)) start += separator.length;
  while (end > start && slug.endsWith(separator, end)) end -= separator.length;
  return slug.slice(start, end);
}
