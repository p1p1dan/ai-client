import { describe, expect, it } from 'vitest';
import {
  codePageLabel,
  consoleCodePage,
  decodeConsoleOutput,
  resetConsoleCodePageCache,
} from '../windowsCodePage';

/**
 * windows-07 / windows-09 — console output is not UTF-8 on a localized Windows,
 * and `toString('utf8')` says so by silently producing U+FFFD. These cases pin
 * the decoder on a Linux box: the bytes below are what a cp936 console writes.
 */
// "张三" (a common Chinese name) in GBK, and the same two characters in UTF-8.
const GBK_NAME = Uint8Array.from([0xd5, 0xc5, 0xc8, 0xfd]);
const UTF8_NAME = new TextEncoder().encode('张三');

describe('windows console decoding', () => {
  it('decodes GBK bytes with the code page instead of mangling them', () => {
    const path = Uint8Array.from([
      ...new TextEncoder().encode('C:\\Users\\'),
      ...GBK_NAME,
      ...new TextEncoder().encode('\\scoop\\shims'),
    ]);
    expect(decodeConsoleOutput(path, { codePage: 936 })).toBe('C:\\Users\\张三\\scoop\\shims');
    // What the old `encoding: 'utf8'` read produced, for contrast.
    expect(Buffer.from(path).toString('utf8')).toContain('\ufffd');
  });

  it('keeps ASCII and real UTF-8 exactly as written, whatever the code page says', () => {
    expect(decodeConsoleOutput(new TextEncoder().encode('C:\\Windows\\System32'))).toBe(
      'C:\\Windows\\System32'
    );
    // Git Bash writes UTF-8 even on a cp936 console: the bytes decide.
    expect(decodeConsoleOutput(UTF8_NAME, { codePage: 936 })).toBe('张三');
  });

  it('ignores a multi-byte character an output budget cut in half', () => {
    const cut = UTF8_NAME.subarray(0, UTF8_NAME.length - 1);
    expect(decodeConsoleOutput(cut, { truncated: true, codePage: 936 })).toBe('张');
    // Without the truncation flag the tail makes it look like another encoding.
    expect(decodeConsoleOutput(cut, { codePage: 936 })).not.toBe('张');
  });

  it('falls back to the lossy UTF-8 read for a page TextDecoder cannot honour', () => {
    // 437 is a DOS page with no WHATWG label; the answer must still be a string.
    expect(decodeConsoleOutput(GBK_NAME, { codePage: 437 })).toContain('\ufffd');
    expect(codePageLabel(437)).toBeUndefined();
    expect(codePageLabel(936)).toBe('gbk');
  });

  it('returns a string argument untouched', () => {
    expect(decodeConsoleOutput('already decoded')).toBe('already decoded');
  });

  it('prefers the explicit override and never probes off Windows', () => {
    resetConsoleCodePageCache();
    let probes = 0;
    const run = () => {
      probes++;
      return 'Active code page: 936\r\n';
    };
    expect(consoleCodePage({ platform: 'linux', env: {}, run })).toBeUndefined();
    expect(probes).toBe(0);
    expect(consoleCodePage({ platform: 'linux', env: { AICLIENT_CONSOLE_CODEPAGE: '936' } })).toBe(
      936
    );
    expect(consoleCodePage({ platform: 'win32', env: {}, run })).toBe(936);
    // Probed once per process; the console page cannot change underneath us.
    expect(consoleCodePage({ platform: 'win32', env: {}, run })).toBe(936);
    expect(probes).toBe(1);
    resetConsoleCodePageCache();
    expect(
      consoleCodePage({
        platform: 'win32',
        env: {},
        run: () => {
          throw new Error('no console');
        },
      })
    ).toBeUndefined();
    resetConsoleCodePageCache();
  });
});
