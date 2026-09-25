import { toLocalFileUrl } from '@/lib/localFileUrl';

/**
 * The `local-file://` URL an image / PDF preview loads, or why there is none.
 *
 * Built during render, so it must never throw: the 2026-09-24 field crash was
 * exactly this step (`new URL('local-file://')` is invalid under Chromium's
 * standard-scheme rules, see `shared/utils/fileUrl.ts`), and a throw here is
 * caught by nothing closer than an error boundary. A failure becomes the
 * preview's own error state instead.
 */
export type PreviewUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'not-absolute' | 'invalid' };

/** POSIX root, drive letter, or UNC — separator-agnostic. */
export function isAbsoluteFilePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
}

export function buildPreviewUrl(path: string, retryKey: number): PreviewUrlResult {
  // A relative path has no meaning to the protocol handler (it would be read as
  // rooted at `/`). Every opener resolves before a tab exists, so this is a
  // guard, not a resolver.
  if (!isAbsoluteFilePath(path)) return { ok: false, reason: 'not-absolute' };
  try {
    // `toLocalFileUrl` percent-encodes every segment, so the result carries no
    // `?` or `#` of its own and the cache-buster can be appended as text.
    return { ok: true, url: `${toLocalFileUrl(path)}?retry=${retryKey}` };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
