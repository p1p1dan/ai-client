import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  customProtocolUriToPath,
  LOCAL_PATH_URL_HOST,
  toCustomProtocolFileBaseUrl,
  toCustomProtocolFileUrl,
} from '../fileUrl';

/**
 * Why these are exact strings and not a round trip through `new URL`.
 *
 * `local-file:` / `local-image:` are registered as STANDARD schemes, and in the
 * Electron renderer Chromium parses them like `http:`. Node's WHATWG `URL`
 * (what vitest runs on) treats them as non-special. The two disagree exactly
 * where it hurt: on Electron 39.2.7 / Chrome 142, `new URL('local-file://')`
 * throws `Failed to construct 'URL': Invalid URL`, while Node returns a valid
 * URL. The old builder started from that string, so every image/PDF preview
 * threw during render in the real app (field report 2026-09-24, Windows) and
 * every test here stayed green.
 *
 * Every expected value below was observed in that renderer by a throwaway
 * probe (2026-09-24): the builder's string, `new URL(string)` in Blink
 * (unchanged), and the `request.url` the main-process `protocol.handle`
 * received (unchanged, plus the preview's `?retry=0`). The table is the
 * record; do not "fix" an expectation by re-running it through Node.
 */
const CHROMIUM_OBSERVED: ReadonlyArray<{
  input: string;
  url: string;
  win32: string;
  posix: string;
}> = [
  {
    input: 'C:\\Users\\a\\Desktop\\x.png',
    url: 'local-file://localhost/C:/Users/a/Desktop/x.png',
    win32: 'C:\\Users\\a\\Desktop\\x.png',
    posix: '/C:/Users/a/Desktop/x.png',
  },
  {
    input: 'D:\\proj\\img\\a b.png',
    url: 'local-file://localhost/D:/proj/img/a%20b.png',
    win32: 'D:\\proj\\img\\a b.png',
    posix: '/D:/proj/img/a b.png',
  },
  {
    // `resolveIntentPath` hands the editor forward slashes; same URL.
    input: 'C:/Users/a/Desktop/x.png',
    url: 'local-file://localhost/C:/Users/a/Desktop/x.png',
    win32: 'C:\\Users\\a\\Desktop\\x.png',
    posix: '/C:/Users/a/Desktop/x.png',
  },
  {
    input: '\\\\wsl.localhost\\Ubuntu\\home\\u\\x.png',
    url: 'local-file://localhost//wsl.localhost/Ubuntu/home/u/x.png',
    win32: '\\\\wsl.localhost\\Ubuntu\\home\\u\\x.png',
    posix: '//wsl.localhost/Ubuntu/home/u/x.png',
  },
  {
    input: '//wsl.localhost/Ubuntu/home/u/x.png',
    url: 'local-file://localhost//wsl.localhost/Ubuntu/home/u/x.png',
    win32: '\\\\wsl.localhost\\Ubuntu\\home\\u\\x.png',
    posix: '//wsl.localhost/Ubuntu/home/u/x.png',
  },
  {
    input: '\\\\server\\share\\dir\\x.png',
    url: 'local-file://localhost//server/share/dir/x.png',
    win32: '\\\\server\\share\\dir\\x.png',
    posix: '//server/share/dir/x.png',
  },
  {
    input: '\\\\?\\C:\\long\\x.png',
    url: 'local-file://localhost/C:/long/x.png',
    win32: 'C:\\long\\x.png',
    posix: '/C:/long/x.png',
  },
  {
    input: '\\\\?\\UNC\\server\\share\\x.png',
    url: 'local-file://localhost//server/share/x.png',
    win32: '\\\\server\\share\\x.png',
    posix: '//server/share/x.png',
  },
  {
    input: '/home/u/x.png',
    url: 'local-file://localhost/home/u/x.png',
    win32: '/home/u/x.png',
    posix: '/home/u/x.png',
  },
  {
    // Case survives: the old form made `Users` the host, which Chromium lowercases.
    input: '/Users/Dan/Pictures/x.png',
    url: 'local-file://localhost/Users/Dan/Pictures/x.png',
    win32: '/Users/Dan/Pictures/x.png',
    posix: '/Users/Dan/Pictures/x.png',
  },
  {
    input: '/my docs/x.png',
    url: 'local-file://localhost/my%20docs/x.png',
    win32: '/my docs/x.png',
    posix: '/my docs/x.png',
  },
  {
    input: '/home/u/a#b.png',
    url: 'local-file://localhost/home/u/a%23b.png',
    win32: '/home/u/a#b.png',
    posix: '/home/u/a#b.png',
  },
  {
    input: '/home/u/100%.png',
    url: 'local-file://localhost/home/u/100%25.png',
    win32: '/home/u/100%.png',
    posix: '/home/u/100%.png',
  },
  {
    input: '/home/u/a?b.png',
    url: 'local-file://localhost/home/u/a%3Fb.png',
    win32: '/home/u/a?b.png',
    posix: '/home/u/a?b.png',
  },
  {
    // A literal `%20` in a file name is not a space.
    input: '/home/u/a%20b.png',
    url: 'local-file://localhost/home/u/a%2520b.png',
    win32: '/home/u/a%20b.png',
    posix: '/home/u/a%20b.png',
  },
  {
    input: 'C:\\Users\\张三\\桌面\\截图 1.png',
    url: 'local-file://localhost/C:/Users/%E5%BC%A0%E4%B8%89/%E6%A1%8C%E9%9D%A2/%E6%88%AA%E5%9B%BE%201.png',
    win32: 'C:\\Users\\张三\\桌面\\截图 1.png',
    posix: '/C:/Users/张三/桌面/截图 1.png',
  },
  {
    input: 'D:\\a#b\\c%d\\e f.png',
    url: 'local-file://localhost/D:/a%23b/c%25d/e%20f.png',
    win32: 'D:\\a#b\\c%d\\e f.png',
    posix: '/D:/a#b/c%d/e f.png',
  },
  {
    input: "/home/u/a'b(c)!.png",
    url: "local-file://localhost/home/u/a'b(c)!.png",
    win32: "/home/u/a'b(c)!.png",
    posix: "/home/u/a'b(c)!.png",
  },
];

describe('toCustomProtocolFileUrl — Chromium standard-scheme form', () => {
  it.each(CHROMIUM_OBSERVED)('builds the observed URL for $input', ({ input, url }) => {
    expect(toCustomProtocolFileUrl(input, 'local-file')).toBe(url);
  });

  it('always carries the fixed host, so Chromium never has to invent one', () => {
    for (const { input } of CHROMIUM_OBSERVED) {
      expect(toCustomProtocolFileUrl(input, 'local-file')).toMatch(
        new RegExp(`^local-file://${LOCAL_PATH_URL_HOST}/`)
      );
    }
  });

  it('emits no character a URL parser could reinterpret', () => {
    for (const { input } of CHROMIUM_OBSERVED) {
      const pathPart = toCustomProtocolFileUrl(input, 'local-file').slice(
        `local-file://${LOCAL_PATH_URL_HOST}`.length
      );
      // No raw space, `#`, `?`, backslash, or non-ASCII; `%` only as an escape.
      expect(pathPart, input).toMatch(/^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/);
      expect(pathPart.replace(/%[0-9A-F]{2}/g, ''), input).not.toContain('%');
    }
  });

  it('does not throw on a lone surrogate', () => {
    expect(() => toCustomProtocolFileUrl('/tmp/\uD800.png', 'local-file')).not.toThrow();
    expect(toCustomProtocolFileUrl('/tmp/\uD800.png', 'local-file')).toBe(
      'local-file://localhost/tmp/%EF%BF%BD.png'
    );
  });

  it('builds local-image URLs the same way', () => {
    expect(toCustomProtocolFileUrl('C:\\bg\\wall paper.jpg', 'local-image')).toBe(
      'local-image://localhost/C:/bg/wall%20paper.jpg'
    );
  });

  it('never starts from an authority-less URL again', () => {
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fileUrl.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/new URL\(`\$\{scheme\}:\/\/`\)/);
  });
});

describe('toCustomProtocolFileBaseUrl', () => {
  it.each([
    ['C:\\proj\\docs', 'local-file://localhost/C:/proj/docs/'],
    ['/home/u/proj/docs/', 'local-file://localhost/home/u/proj/docs/'],
    [
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj',
      'local-file://localhost//wsl.localhost/Ubuntu/home/u/proj/',
    ],
    ['/', 'local-file://localhost/'],
  ])('%s → %s (observed in Chromium)', (dir, href) => {
    expect(toCustomProtocolFileBaseUrl(dir, 'local-file').href).toBe(href);
  });

  it('resolves a relative Markdown image under the base (observed in Chromium)', () => {
    const base = toCustomProtocolFileBaseUrl('C:\\proj\\docs', 'local-file');
    expect(new URL('img/a b.png', base).href).toBe(
      'local-file://localhost/C:/proj/docs/img/a%20b.png'
    );
  });
});

describe('customProtocolUriToPath — what the main-process handler receives', () => {
  it.each(CHROMIUM_OBSERVED)('maps the observed request URL for $input back to the file', ({
    url,
    win32,
    posix,
  }) => {
    // The preview appends `?retry=N`; the handler must ignore it.
    const requestUrl = `${url}?retry=0`;
    expect(customProtocolUriToPath(requestUrl, 'local-file', 'win32')).toBe(win32);
    expect(customProtocolUriToPath(requestUrl, 'local-file', 'linux')).toBe(posix);
    expect(customProtocolUriToPath(requestUrl, 'local-file', 'darwin')).toBe(posix);
  });

  it('still reads the legacy host-carrying forms (settings may hold old local-image URLs)', () => {
    expect(customProtocolUriToPath('local-image://c/Users/x.png', 'local-image', 'win32')).toBe(
      'c:\\Users\\x.png'
    );
    expect(
      customProtocolUriToPath('local-file://wsl.localhost/Ubuntu/x.png', 'local-file', 'win32')
    ).toBe('\\\\wsl.localhost\\Ubuntu\\x.png');
    expect(customProtocolUriToPath('local-file:///C:/x.png', 'local-file', 'win32')).toBe(
      'C:\\x.png'
    );
    expect(customProtocolUriToPath('local-file:///home/u/x.png', 'local-file', 'linux')).toBe(
      '/home/u/x.png'
    );
  });

  it('rejects another scheme and malformed escapes instead of throwing', () => {
    expect(customProtocolUriToPath('local-image://localhost/x.png', 'local-file', 'linux')).toBe(
      null
    );
    expect(
      customProtocolUriToPath('local-file://localhost/a%E0%A4%A.png', 'local-file', 'linux')
    ).toBe(null);
  });
});
