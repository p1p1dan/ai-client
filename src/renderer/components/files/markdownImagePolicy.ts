import type { SupportedFileUrlPlatform } from '@shared/utils/fileUrl';
import { toLocalFileBaseUrl } from '@/lib/localFileUrl';

const URL_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const SAFE_DATA_IMAGE_REGEX = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-zA-Z0-9+/=\s]+$/;

function getDirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  if (index === -1) return '';
  return index === 0 ? '/' : normalized.slice(0, index);
}

function normalizePathnameForCompare(pathname: string, platform: SupportedFileUrlPlatform): string {
  const normalized = pathname.replace(/\/+$/, '');
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

export interface MarkdownImagePolicyInput {
  src: string | undefined;
  markdownFilePath: string;
  rootPath?: string;
  platform: SupportedFileUrlPlatform;
}

/**
 * Resolve a Markdown image without granting new schemes or escaping the open
 * workspace. Main's realpath-based local-file guard remains the authoritative
 * physical containment boundary; this is the early lexical/scheme filter.
 */
export function resolveMarkdownImageSrc(input: MarkdownImagePolicyInput): string | undefined {
  const { src, markdownFilePath, rootPath, platform } = input;
  if (!src) return undefined;
  const raw = src.trim();
  if (!raw) return undefined;

  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('data:')) return SAFE_DATA_IMAGE_REGEX.test(raw) ? raw : undefined;

  // blob:, file:, local-file:, javascript: and custom schemes are never
  // accepted from repository-authored Markdown.
  if (URL_SCHEME_REGEX.test(raw)) return undefined;
  if (!rootPath) return undefined;

  const rootBaseUrl = toLocalFileBaseUrl(rootPath);
  const fileDirBaseUrl = toLocalFileBaseUrl(getDirname(markdownFilePath));
  const normalizedSrc = raw.replace(/\\/g, '/');
  const resolvedUrl = normalizedSrc.startsWith('/')
    ? new URL(normalizedSrc.slice(1), rootBaseUrl)
    : new URL(normalizedSrc, fileDirBaseUrl);

  const rootPathname = normalizePathnameForCompare(rootBaseUrl.pathname, platform);
  const resolvedPathname = normalizePathnameForCompare(resolvedUrl.pathname, platform);
  if (resolvedPathname !== rootPathname && !resolvedPathname.startsWith(`${rootPathname}/`)) {
    return undefined;
  }

  return resolvedUrl.toString();
}
