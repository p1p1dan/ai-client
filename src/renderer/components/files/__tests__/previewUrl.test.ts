import { describe, expect, it } from 'vitest';
import { buildPreviewUrl, isAbsoluteFilePath } from '../previewUrl';

/**
 * The expected strings are the ones the Electron renderer produced in the
 * 2026-09-24 probe (see `shared/utils/__tests__/fileUrl.test.ts` for why Node's
 * URL parser cannot be used to check them).
 */
describe('buildPreviewUrl (T4)', () => {
  it('builds a Windows drive path in both separator styles', () => {
    const expected = 'local-file://localhost/C:/Users/a/Desktop/x.png?retry=0';
    expect(buildPreviewUrl('C:\\Users\\a\\Desktop\\x.png', 0)).toEqual({ ok: true, url: expected });
    expect(buildPreviewUrl('C:/Users/a/Desktop/x.png', 0)).toEqual({ ok: true, url: expected });
  });

  it('builds UNC and WSL paths with the server in the path, not the host', () => {
    expect(buildPreviewUrl('\\\\wsl.localhost\\Ubuntu\\home\\u\\x.png', 2)).toEqual({
      ok: true,
      url: 'local-file://localhost//wsl.localhost/Ubuntu/home/u/x.png?retry=2',
    });
    expect(buildPreviewUrl('\\\\server\\share\\x.pdf', 0)).toEqual({
      ok: true,
      url: 'local-file://localhost//server/share/x.pdf?retry=0',
    });
  });

  it('encodes characters that would otherwise start a query or fragment', () => {
    expect(buildPreviewUrl('D:\\a#b\\c%d\\截图 1.png', 1)).toEqual({
      ok: true,
      url: 'local-file://localhost/D:/a%23b/c%25d/%E6%88%AA%E5%9B%BE%201.png?retry=1',
    });
    expect(buildPreviewUrl('/home/u/a?b.png', 0)).toEqual({
      ok: true,
      url: 'local-file://localhost/home/u/a%3Fb.png?retry=0',
    });
  });

  it.each([
    'xx.png',
    '截图 1.png',
    'sub/xx 1.png',
    'C:x.png',
    '',
  ])('refuses the non-absolute path %j instead of guessing', (input) => {
    expect(buildPreviewUrl(input, 0)).toEqual({ ok: false, reason: 'not-absolute' });
  });

  it('never throws for hostile input', () => {
    for (const input of ['/\uD800.png', 'C:\\\0.png', '//', '\\\\?\\', '/%', '/#?']) {
      expect(() => buildPreviewUrl(input, 0)).not.toThrow();
    }
  });

  it('recognises absolute paths across platforms', () => {
    expect(isAbsoluteFilePath('/home/u/x.png')).toBe(true);
    expect(isAbsoluteFilePath('C:\\x.png')).toBe(true);
    expect(isAbsoluteFilePath('\\\\server\\share\\x.png')).toBe(true);
    expect(isAbsoluteFilePath('x.png')).toBe(false);
    expect(isAbsoluteFilePath('C:x.png')).toBe(false);
  });
});
