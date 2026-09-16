import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PtyManager pulls node-pty (a native binding) through its module graph; the
// registry readers under test are plain functions and need none of it.
vi.mock('node-pty', () => ({ spawn: () => ({}) }));

import { clearPathCache, getWindowsRegistryEnvVars, getWindowsRegistryPath } from '../PtyManager';

/**
 * windows-07 — `reg query` writes the console code page (936 on a Chinese
 * Windows), and the reader asked `execSync` for `utf8`, which turns every
 * non-ASCII byte into U+FFFD without failing. A PATH entry under a Chinese user
 * directory therefore pointed nowhere and every tool behind it vanished from
 * the embedded terminal.
 *
 * The query is injected, so this runs on Linux. The stub honours the `encoding`
 * option the way `execSync` does — ask for `utf8` and you get the mangled
 * string, which is exactly the regression being guarded.
 */
// "张三" in GBK.
const GBK_NAME = Buffer.from([0xd5, 0xc5, 0xc8, 0xfd]);
const gbk = (text: string) =>
  Buffer.concat(
    text
      .split('<name>')
      .flatMap((part, index) =>
        index === 0 ? [Buffer.from(part, 'latin1')] : [GBK_NAME, Buffer.from(part, 'latin1')]
      )
  );

function registryStub(output: Buffer) {
  const calls: string[] = [];
  const query = (command: string, options: { encoding: 'buffer' | 'utf8' }) => {
    calls.push(command);
    return options.encoding === 'buffer' ? output : output.toString('utf8');
  };
  return { calls, query };
}

describe('windows registry reads decode the console code page', () => {
  beforeEach(() => {
    clearPathCache();
    process.env.AICLIENT_CONSOLE_CODEPAGE = '936';
  });
  afterEach(() => {
    delete process.env.AICLIENT_CONSOLE_CODEPAGE;
    clearPathCache();
  });

  it('keeps a PATH entry under a Chinese user directory intact', () => {
    const stub = registryStub(
      gbk(
        'HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Users\\<name>\\scoop\\shims\r\n'
      )
    );
    const path = getWindowsRegistryPath(stub.query);
    expect(path).toContain('C:\\Users\\张三\\scoop\\shims');
    expect(path).not.toContain('\ufffd');
    expect(stub.calls.length).toBeGreaterThan(0);
  });

  it('keeps a registry environment value intact for %VAR% expansion', () => {
    const stub = registryStub(
      gbk('HKEY_CURRENT_USER\\Environment\r\n    SCOOP    REG_SZ    C:\\Users\\<name>\\scoop\r\n')
    );
    expect(getWindowsRegistryEnvVars(stub.query).SCOOP).toBe('C:\\Users\\张三\\scoop');
  });

  it('leaves an ASCII registry read exactly as it was', () => {
    const stub = registryStub(
      Buffer.from(
        'HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\tools\\bin\r\n',
        'latin1'
      )
    );
    expect(getWindowsRegistryPath(stub.query)).toContain('C:\\tools\\bin');
  });
});
