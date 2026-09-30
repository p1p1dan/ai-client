import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENCRYPTED_READ_ENV, ENCRYPTED_READ_ROW } from '../constants.ts';
import { apply, isEncryptedReadEnabled } from '../plugin.ts';

// The row only hands `FsError` to the installer; the switch never builds one.
vi.mock('@deepseek-ai/dsh-fs', () => ({ FsError: class FsError extends Error {} }));

/**
 * The row's start-up switch (dsh-rebase P1-13d; decision 136, rule 12): a
 * pure function of the platform and the environment, so every platform
 * checks it. Only the exact value `0` turns the row off, and only win32 ever
 * turns it on.
 */

describe('isEncryptedReadEnabled (P1-13d, decision 136)', () => {
  it('is on for win32 when the switch is unset, empty, 1 or anything but the exact 0', () => {
    expect(isEncryptedReadEnabled('win32', {})).toBe(true);
    for (const value of [undefined, '', '1', 'true', 'false', 'off', 'no', ' 0', '0 ', '00']) {
      expect(isEncryptedReadEnabled('win32', { [ENCRYPTED_READ_ENV]: value })).toBe(true);
    }
  });

  it('is off for win32 when the switch is exactly 0', () => {
    expect(isEncryptedReadEnabled('win32', { [ENCRYPTED_READ_ENV]: '0' })).toBe(false);
  });

  it('is off on every other platform, whatever the switch says', () => {
    for (const platform of ['linux', 'darwin', 'freebsd']) {
      for (const value of [undefined, '', '1', '0']) {
        expect(isEncryptedReadEnabled(platform, { [ENCRYPTED_READ_ENV]: value })).toBe(false);
      }
    }
  });

  it('reads its own variable only', () => {
    expect(isEncryptedReadEnabled('win32', { AICLIENT_RUNTIME_LOOP_GUARD: '0' })).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('apply off win32 (P1-13d, decision 136)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const run = (switchValue: string) => {
    vi.stubEnv(ENCRYPTED_READ_ENV, switchValue);
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const get = vi.fn();
    apply({ get });
    return { lines, get };
  };

  it('never takes the fs service and logs exactly one stderr line saying why', () => {
    const inert = run('1');
    expect(inert.get).not.toHaveBeenCalled();
    expect(inert.lines).toEqual([`[${ENCRYPTED_READ_ROW}] not on win32: nothing to wrap`]);

    vi.restoreAllMocks();
    const disabled = run('0');
    expect(disabled.get).not.toHaveBeenCalled();
    expect(disabled.lines).toEqual([
      `[${ENCRYPTED_READ_ROW}] disabled by ${ENCRYPTED_READ_ENV}=0: encrypted files read as ciphertext`,
    ]);
  });
});
