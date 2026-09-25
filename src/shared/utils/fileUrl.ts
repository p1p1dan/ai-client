export type SupportedFileUrlPlatform = 'darwin' | 'linux' | 'win32';

/**
 * The fixed authority every `local-file://` / `local-image://` URL is built with.
 *
 * ## Why there is a host at all
 *
 * Both schemes are registered with `standard: true` (`main/index.ts`,
 * `registerSchemesAsPrivileged`). Chromium parses a registered standard scheme
 * like `http:`: an authority is REQUIRED. Measured on Electron 39.2.7 /
 * Chrome 142 (2026-09-24 probe):
 *
 * - `new URL('local-file://')` throws `Failed to construct 'URL': Invalid URL`.
 *   The previous builder started from exactly that string, so every image and
 *   PDF preview, and every Markdown image, threw during render and took the
 *   window down to the root error card — on every platform, for every path.
 * - Without a fixed host, the first path segment is re-read as the host on the
 *   next parse (`local-file:///home/u/x.png` → host `home`), which lowercases it
 *   and rejects spaces, `#`, `%` and non-ASCII outright.
 *
 * Node's WHATWG `URL` treats `local-file:` as a NON-special scheme and accepts
 * all of the above, which is why no unit test ever saw it. So the URL is built
 * as a plain string with every path segment percent-encoded here, and the
 * result is the same under both parsers.
 *
 * `localhost` mirrors `file://localhost/…` ("this machine"). A UNC server name
 * never becomes the host: UNC paths ride in the pathname as `//server/share`.
 */
export const LOCAL_PATH_URL_HOST = 'localhost';

/** Lone surrogates make `encodeURIComponent` throw; no file on the wire can carry one. */
function toWellFormedPath(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD'
  );
}

/** `\\?\C:\…` / `\\.\C:\…` → `C:/…`, `\\?\UNC\server\share` → `//server/share`. */
function stripWin32NamespacePrefix(normalized: string): string {
  const unc = /^\/\/[?.]\/UNC\//i.exec(normalized);
  if (unc) return `//${normalized.slice(unc[0].length)}`;
  if (/^\/\/[?.]\/[a-zA-Z]:(\/|$)/.test(normalized)) return normalized.slice(4);
  return normalized;
}

/**
 * The URL pathname for an absolute filesystem path, already percent-encoded.
 *
 * - POSIX `/a/b` → `/a/b`
 * - drive `C:\a\b` → `/C:/a/b`
 * - UNC / WSL `\\server\share\a` → `//server/share/a`
 *
 * A relative input is treated as rooted (`x.png` → `/x.png`), which is what the
 * old builder did too; callers that can see a relative path must resolve it
 * first (the preview's `buildPreviewUrl` refuses one).
 */
function toLocalPathUrlPathname(absPath: string): string {
  const normalized = stripWin32NamespacePrefix(toWellFormedPath(absPath).replace(/\\/g, '/'));
  let prefix: string;
  let body: string;
  if (normalized.startsWith('//')) {
    prefix = '//';
    body = normalized.slice(2);
  } else if (/^[a-zA-Z]:(\/|$)/.test(normalized)) {
    prefix = `/${normalized.slice(0, 2)}/`;
    body = normalized.slice(3);
  } else {
    prefix = '/';
    body = normalized.replace(/^\/+/, '');
  }
  return prefix + body.split('/').map(encodeURIComponent).join('/');
}

/**
 * Convert an absolute filesystem path to a custom protocol URL string.
 * Supports Windows drive paths and UNC paths such as \\wsl.localhost\Ubuntu\home\user.
 *
 * Never throws: no URL parser is involved (see {@link LOCAL_PATH_URL_HOST}).
 */
export function toCustomProtocolFileUrl(absPath: string, scheme: string): string {
  return `${scheme}://${LOCAL_PATH_URL_HOST}${toLocalPathUrlPathname(absPath)}`;
}

/**
 * Create a base URL for resolving relative paths within a directory.
 * Ensures the resulting URL.pathname ends with a trailing slash.
 */
export function toCustomProtocolFileBaseUrl(absDirPath: string, scheme: string): URL {
  const pathname = toLocalPathUrlPathname(absDirPath).replace(/\/+$/, '');
  return new URL(`${scheme}://${LOCAL_PATH_URL_HOST}${pathname}/`);
}

/**
 * Convert a file:// URI to a filesystem path.
 * Supports Windows drive letters, UNC hosts, and legacy //host/path forms.
 */
export function fileUriToPath(uri: string, platform: SupportedFileUrlPlatform): string | null {
  if (!uri.toLowerCase().startsWith('file://')) {
    return null;
  }

  try {
    return urlToFilePath(new URL(uri), platform);
  } catch {
    return null;
  }
}

/**
 * Convert a custom protocol URI such as local-file:// or local-image:// to a filesystem path.
 *
 * Reads both the current `<scheme>://localhost/<path>` form and the legacy
 * host-carrying forms (`local-image://` URLs a user pasted into settings still
 * arrive in those).
 */
export function customProtocolUriToPath(
  uri: string,
  scheme: string,
  platform: SupportedFileUrlPlatform
): string | null {
  if (!uri.toLowerCase().startsWith(`${scheme.toLowerCase()}://`)) {
    return null;
  }

  try {
    const url = new URL(uri);
    if (url.hostname.toLowerCase() === LOCAL_PATH_URL_HOST) {
      return localPathnameToFilePath(url.pathname, platform);
    }
    return urlToFilePath(url, platform);
  } catch {
    return null;
  }
}

/** Inverse of {@link toLocalPathUrlPathname}. */
function localPathnameToFilePath(rawPathname: string, platform: SupportedFileUrlPlatform): string {
  const pathname = decodeURIComponent(rawPathname);
  if (platform === 'win32') {
    if (pathname.startsWith('//')) return pathname.replace(/\//g, '\\');
    if (/^\/[a-zA-Z]:(\/|$)/.test(pathname)) return pathname.slice(1).replace(/\//g, '\\');
  }
  return pathname;
}

function urlToFilePath(url: URL, platform: SupportedFileUrlPlatform): string {
  const pathname = decodeURIComponent(url.pathname);

  if (url.hostname) {
    if (platform === 'win32') {
      if (/^[a-zA-Z]$/.test(url.hostname)) {
        return `${url.hostname}:${pathname.replace(/\//g, '\\')}`;
      }

      return `\\\\${url.hostname}${pathname.replace(/\//g, '\\')}`;
    }

    return `//${url.hostname}${pathname}`;
  }

  if (platform === 'win32') {
    if (pathname.startsWith('//')) {
      return pathname.replace(/\//g, '\\');
    }

    if (/^\/[a-zA-Z]:/.test(pathname)) {
      return pathname.slice(1).replace(/\//g, '\\');
    }
  }

  return pathname;
}
