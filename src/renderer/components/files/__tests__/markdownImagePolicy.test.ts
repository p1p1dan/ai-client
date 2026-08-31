import { describe, expect, it } from 'vitest';
import { resolveMarkdownImageSrc } from '../markdownImagePolicy';

const base = {
  markdownFilePath: '/repo/docs/readme.md',
  rootPath: '/repo',
  platform: 'linux' as const,
};

describe('resolveMarkdownImageSrc', () => {
  it('resolves file-relative and workspace-root-relative images', () => {
    expect(resolveMarkdownImageSrc({ ...base, src: './img/a.png' })).toBe(
      'local-file:///repo/docs/img/a.png'
    );
    expect(resolveMarkdownImageSrc({ ...base, src: '/assets/a.png' })).toBe(
      'local-file:///repo/assets/a.png'
    );
  });

  it('rejects lexical traversal and prefix-sibling escapes', () => {
    expect(resolveMarkdownImageSrc({ ...base, src: '../../outside.png' })).toBeUndefined();
    expect(
      resolveMarkdownImageSrc({
        ...base,
        markdownFilePath: '/repo-backup/readme.md',
        src: './outside.png',
      })
    ).toBeUndefined();
  });

  it('rejects dangerous or application-owned schemes', () => {
    for (const src of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'local-file:///etc/passwd',
      'blob:https://example.test/id',
      'custom:payload',
    ]) {
      expect(resolveMarkdownImageSrc({ ...base, src }), src).toBeUndefined();
    }
  });

  it('allows http(s), protocol-relative URLs and narrowly-scoped raster data images', () => {
    expect(resolveMarkdownImageSrc({ ...base, src: 'https://example.test/a.png' })).toBe(
      'https://example.test/a.png'
    );
    expect(resolveMarkdownImageSrc({ ...base, src: '//example.test/a.png' })).toBe(
      'https://example.test/a.png'
    );
    expect(resolveMarkdownImageSrc({ ...base, src: 'data:image/png;base64,aGVsbG8=' })).toBe(
      'data:image/png;base64,aGVsbG8='
    );
    expect(
      resolveMarkdownImageSrc({ ...base, src: 'data:image/svg+xml,<svg onload=alert(1) />' })
    ).toBeUndefined();
  });

  it('uses case-insensitive containment on Windows and macOS only', () => {
    const input = {
      src: './A.png',
      markdownFilePath: 'C:/Repo/docs/readme.md',
      rootPath: 'c:/repo',
    };
    expect(resolveMarkdownImageSrc({ ...input, platform: 'win32' })).toBeDefined();
    expect(resolveMarkdownImageSrc({ ...input, platform: 'linux' })).toBeUndefined();
  });
});
