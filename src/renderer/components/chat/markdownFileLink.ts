import type { FileOpenIntent } from '@/stores/fileOpenIntent';

export function parseMarkdownFileLink(
  href: string | undefined
): Omit<FileOpenIntent, 'requestId'> | null {
  if (!href || href.startsWith('#')) return null;
  let path = href;
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      path = (url.hostname ? `//${url.hostname}` : '') + url.pathname + url.hash;
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) {
    return null;
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  const location = path.match(/(?:#L?(\d+)(?:-L?(\d+))?|:(\d+)(?::(\d+))?)$/i);
  if (location) path = path.slice(0, location.index);
  if (!path || /[?#]/.test(path) || Array.from(path).some((char) => char.charCodeAt(0) < 32))
    return null;
  // A filename, path, or absolute location. Bare fragments and arbitrary schemes stay inert.
  if (!/[\\/.]/.test(path)) return null;
  return {
    path,
    source: 'markdown',
    ...(location ? { line: Number(location[1] ?? location[3]) } : {}),
    ...(location?.[2] ? { endLine: Number(location[2]) } : {}),
  };
}
