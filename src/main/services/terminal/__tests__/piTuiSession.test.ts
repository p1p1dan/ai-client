import { describe, expect, it } from 'vitest';
import {
  buildPiTuiArgs,
  inspectPiTuiSessionSupport,
  normalizeSessionKey,
  PI_TUI_NATIVE_SESSION_REASON,
  PiTuiExclusiveGuard,
  sessionKeysMatch,
} from '../piTuiSession';

const CLI = '/app/pi/cli.js';

describe('normalizeSessionKey', () => {
  it('collapses the macOS firmlink prefix so /var and /private/var match', () => {
    expect(normalizeSessionKey('/private/var/folders/s.jsonl')).toBe('/var/folders/s.jsonl');
    expect(sessionKeysMatch('/private/var/a.jsonl', '/var/a.jsonl')).toBe(true);
  });

  it('ignores case, trailing slashes and backslash separators', () => {
    expect(sessionKeysMatch('/Repo/S.JSONL', '/repo/s.jsonl')).toBe(true);
    expect(sessionKeysMatch('/repo/s.jsonl/', '/repo/s.jsonl')).toBe(true);
    expect(sessionKeysMatch('C:\\repo\\s.jsonl', 'C:/repo/s.jsonl')).toBe(true);
  });

  it('never matches a blank path against anything, including another blank', () => {
    expect(sessionKeysMatch('', '')).toBe(false);
    expect(sessionKeysMatch('   ', '/repo/s.jsonl')).toBe(false);
    expect(sessionKeysMatch(undefined, undefined)).toBe(false);
  });
});

describe('buildPiTuiArgs', () => {
  it('binds the TUI to an existing session file', () => {
    expect(buildPiTuiArgs(CLI, '/repo/s.jsonl')).toEqual([CLI, '--session', '/repo/s.jsonl']);
  });

  it('starts a fresh session when no file is given', () => {
    expect(buildPiTuiArgs(CLI)).toEqual([CLI]);
    expect(buildPiTuiArgs(CLI, '')).toEqual([CLI]);
    expect(buildPiTuiArgs(CLI, '   ')).toEqual([CLI]);
  });
});

describe('PiTuiExclusiveGuard', () => {
  it('blocks a GUI prompt while terminal mode owns a session', () => {
    const guard = new PiTuiExclusiveGuard();
    expect(() => guard.assertHostPromptAllowed()).not.toThrow();

    guard.transferTo('/repo/s.jsonl');
    expect(() => guard.assertHostPromptAllowed()).toThrow(/close the Pi terminal/);

    guard.release('/repo/s.jsonl');
    expect(() => guard.assertHostPromptAllowed()).not.toThrow();
  });

  // The pix lesson: tryAcquire-only left a stale owner key after a key desync
  // and the UI could then never open a terminal again.
  it('transfers ownership between sessions instead of refusing the second one', () => {
    const guard = new PiTuiExclusiveGuard();
    expect(guard.transferTo('/repo/first.jsonl')).toEqual({ ok: true });
    expect(guard.transferTo('/repo/second.jsonl')).toEqual({ ok: true });

    expect(guard.owns('/repo/second.jsonl')).toBe(true);
    expect(guard.owns('/repo/first.jsonl')).toBe(false);
  });

  it('matches ownership through path drift, so the release actually lands', () => {
    const guard = new PiTuiExclusiveGuard();
    guard.transferTo('/private/var/s.jsonl');

    expect(guard.owns('/var/s.jsonl')).toBe(true);
    guard.release('/VAR/s.jsonl/');
    expect(guard.isActive()).toBe(false);
  });

  it('refuses a blank key rather than taking ownership of nothing', () => {
    const guard = new PiTuiExclusiveGuard();
    expect(guard.transferTo('  ')).toEqual({ ok: false, reason: 'Invalid session key' });
    expect(guard.isActive()).toBe(false);
    expect(guard.owns('')).toBe(false);
  });

  it('release with a different session leaves the real owner in place', () => {
    const guard = new PiTuiExclusiveGuard();
    guard.transferTo('/repo/mine.jsonl');
    guard.release('/repo/someone-else.jsonl');
    expect(guard.owns('/repo/mine.jsonl')).toBe(true);
  });
});

describe('inspectPiTuiSessionSupport', () => {
  const v4 = JSON.stringify({ kind: 'header', version: 4, id: 'a', cwd: '/repo', createdAt: 1 });
  const legacy = JSON.stringify({ type: 'session', id: 'a', version: 3 });

  it('refuses a native v4 session, which the pi CLI cannot parse', async () => {
    await expect(
      inspectPiTuiSessionSupport('/s.jsonl', async () => `${v4}\n{"id":"e1"}\n`)
    ).resolves.toEqual({
      supported: false,
      reason: PI_TUI_NATIVE_SESSION_REASON,
    });
  });

  it('allows a legacy pi session', async () => {
    await expect(
      inspectPiTuiSessionSupport('/s.jsonl', async () => `${legacy}\n`)
    ).resolves.toEqual({ supported: true });
  });

  it('allows a fresh terminal with no session file', async () => {
    await expect(inspectPiTuiSessionSupport(undefined)).resolves.toEqual({ supported: true });
    await expect(inspectPiTuiSessionSupport('   ')).resolves.toEqual({ supported: true });
  });

  it('allows what it cannot read or parse rather than guessing unsupported', async () => {
    // An encrypted container or a truncated head must not take the TUI away
    // from sessions that work today; only a positive v4 match refuses.
    await expect(
      inspectPiTuiSessionSupport('/s.jsonl', async () => {
        throw new Error('EACCES');
      })
    ).resolves.toEqual({ supported: true });
    await expect(
      inspectPiTuiSessionSupport('/s.jsonl', async () => '%TSD-Header-001%\u0000\u0000')
    ).resolves.toEqual({ supported: true });
    await expect(inspectPiTuiSessionSupport('/s.jsonl', async () => '')).resolves.toEqual({
      supported: true,
    });
  });

  it('does not refuse a v4-looking body whose header line is legacy', async () => {
    await expect(
      inspectPiTuiSessionSupport('/s.jsonl', async () => `${legacy}\n${v4}\n`)
    ).resolves.toEqual({ supported: true });
  });
});
