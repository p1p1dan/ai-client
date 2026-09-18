import { zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import {
  buildPiTuiArgs,
  inspectPiTuiSessionSupport,
  normalizeSessionKey,
  PI_TUI_NATIVE_SESSION_REASON,
  PI_TUI_SESSION_BUSY_REASON,
  PiTuiExclusiveGuard,
  PiTuiWindowSessionGuard,
} from '../piTuiSession';

const CLI = '/app/pi/cli.js';

/**
 * T025 removed a `sessionKeysMatch(a, b)` export that had no caller: `owns()`
 * and `release()` both compare normalized keys themselves. The cases it used to
 * carry are asserted here on the normalizer and on the guard, which is what
 * production actually runs.
 */
describe('normalizeSessionKey', () => {
  it('collapses the macOS firmlink prefix so /var and /private/var match', () => {
    expect(normalizeSessionKey('/private/var/folders/s.jsonl')).toBe('/var/folders/s.jsonl');
    expect(normalizeSessionKey('/private/var/a.jsonl')).toBe(normalizeSessionKey('/var/a.jsonl'));
  });

  it('ignores case, trailing slashes and backslash separators', () => {
    expect(normalizeSessionKey('/Repo/S.JSONL')).toBe(normalizeSessionKey('/repo/s.jsonl'));
    expect(normalizeSessionKey('/repo/s.jsonl/')).toBe(normalizeSessionKey('/repo/s.jsonl'));
    expect(normalizeSessionKey('C:\\repo\\s.jsonl')).toBe(normalizeSessionKey('C:/repo/s.jsonl'));
  });

  it('never lets a blank path own or match anything, including another blank', () => {
    expect(normalizeSessionKey('   ')).toBe('');
    const guard = new PiTuiExclusiveGuard();
    expect(guard.owns('')).toBe(false);
    expect(guard.transferTo('   ')).toEqual({ ok: false, reason: 'Invalid session key' });
    guard.transferTo('/repo/s.jsonl');
    expect(guard.owns('   ')).toBe(false);
  });
});

describe('buildPiTuiArgs', () => {
  it('binds the TUI to an existing session file', () => {
    expect(buildPiTuiArgs(CLI, '/repo/sessions/s.jsonl')).toEqual([
      CLI,
      '--session',
      '/repo/sessions/s.jsonl',
      // Where `/new` writes. Left implicit, pi would take it from its settings
      // first — a `sessionDir` in a repo's `.pi/settings.json` then sends
      // terminal-created chats somewhere the stranded-session sweep, which
      // watches THIS directory, never looks.
      '--session-dir',
      '/repo/sessions',
    ]);
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

  // cutover-04: leaving terminal mode SUSPENDS the terminal, so ownership is
  // still held while the user works in another chat. Asked about that other
  // chat, the gate has to let the write through — the file it names is not the
  // one a terminal is holding.
  it('answers about the chat being written, not about the app as a whole', () => {
    const guard = new PiTuiExclusiveGuard();
    guard.transferTo('/repo/warm.jsonl');

    expect(() => guard.assertHostPromptAllowed('/repo/warm.jsonl')).toThrow(
      /close the Pi terminal/
    );
    expect(() => guard.assertHostPromptAllowed('/repo/other.jsonl')).not.toThrow();
    // The same file under the spellings `normalizeSessionKey` exists to collapse
    // still counts as owned; a gate fooled by a firmlink is not a gate.
    expect(() => guard.assertHostPromptAllowed('/private/repo/warm.jsonl')).toThrow(
      /close the Pi terminal/
    );
    expect(() => guard.assertHostPromptAllowed('/REPO/WARM.JSONL')).toThrow(
      /close the Pi terminal/
    );
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

/**
 * D18 (real-machine point check DEV-16) — two windows both opened the same chat
 * in a terminal. Both `pi --session` processes read the tree once at open and
 * then hung their own turn off the same parent entry, so one JSONL ended up
 * with two parallel branches; the UI said nothing at any point.
 */
describe('PiTuiWindowSessionGuard', () => {
  const CHAT = '/chats/a.jsonl';
  const OTHER = '/chats/b.jsonl';

  it('refuses a second window asking for a chat the first one has open', () => {
    const guard = new PiTuiWindowSessionGuard();
    expect(guard.claim(CHAT, 1, 'terminal-1')).toEqual({ ok: true });

    expect(guard.claim(CHAT, 2, 'terminal-2')).toEqual({
      ok: false,
      reason: PI_TUI_SESSION_BUSY_REASON,
    });
    expect(guard.ownerWindowId(CHAT)).toBe(1);
  });

  it('leaves the same window and other chats alone', () => {
    // Reverse check: the refusal has to be narrow, or it takes away chat
    // switching inside one window (every chat has its own terminal id) and the
    // second window's OTHER chats with it.
    const guard = new PiTuiWindowSessionGuard();
    guard.claim(CHAT, 1, 'terminal-1');

    expect(guard.claim(CHAT, 1, 'terminal-1')).toEqual({ ok: true });
    expect(guard.claim(CHAT, 1, 'terminal-1b')).toEqual({ ok: true });
    expect(guard.claim(OTHER, 2, 'terminal-2')).toEqual({ ok: true });
  });

  it('claims nothing for a terminal with no chat behind it', () => {
    // A TUI opened from a repo starts its own conversation; there is no
    // existing JSONL for it to contest.
    const guard = new PiTuiWindowSessionGuard();
    expect(guard.claim('', 1, 'terminal-1')).toEqual({ ok: true });
    expect(guard.claim('', 2, 'terminal-2')).toEqual({ ok: true });
    expect(guard.ownerWindowId('')).toBeNull();
  });

  it('matches through path drift, so /private/var cannot slip a second pi past it', () => {
    const guard = new PiTuiWindowSessionGuard();
    guard.claim('/private/var/chats/a.jsonl', 1, 'terminal-1');

    expect(guard.claim('/VAR/CHATS/A.JSONL', 2, 'terminal-2').ok).toBe(false);
  });

  it('frees the chat again once that terminal is gone', () => {
    const guard = new PiTuiWindowSessionGuard();
    guard.claim(CHAT, 1, 'terminal-1');
    guard.releaseTerminal(1, 'terminal-1');

    expect(guard.claim(CHAT, 2, 'terminal-2')).toEqual({ ok: true });
    expect(guard.ownerWindowId(CHAT)).toBe(2);
  });

  it('keeps the claim while the window still has another terminal on that chat', () => {
    const guard = new PiTuiWindowSessionGuard();
    guard.claim(CHAT, 1, 'terminal-1');
    guard.claim(CHAT, 1, 'terminal-1b');
    guard.releaseTerminal(1, 'terminal-1');

    expect(guard.claim(CHAT, 2, 'terminal-2').ok).toBe(false);
  });

  /**
   * T065 回炉 — the rollback path, and the reason it needs its own release.
   *
   * The first landing rolled a failed claim back with `releaseTerminal`, which
   * means "this PTY is gone" and walks every chat the window holds. A warm
   * terminal refused a second chat (terminal-03) therefore lost the claim on the
   * chat its pi was STILL RUNNING on, and the next window asking for that chat
   * would have been waved through — D18 again, from inside the fix for it.
   */
  it('takes back only the chat whose open failed, not the one the same terminal is serving', () => {
    const guard = new PiTuiWindowSessionGuard();
    guard.claim(CHAT, 1, 'terminal-1');
    // The same terminal id is asked for a second chat; the controller refuses
    // and the handler rolls that one claim back.
    guard.claim(OTHER, 1, 'terminal-1');
    guard.releaseClaim(OTHER, 1, 'terminal-1');

    expect(guard.ownerWindowId(OTHER)).toBeNull();
    // The live one survives — this is the assertion the defect fails.
    expect(guard.ownerWindowId(CHAT)).toBe(1);
    expect(guard.claim(CHAT, 2, 'terminal-2').ok).toBe(false);
  });

  it('is a release, not a lock: the rolled-back chat opens again, in either window', () => {
    // Reverse check. Undoing the claim has to leave the chat genuinely free,
    // or a spawn that never happened would lock it out for the rest of the run.
    const guard = new PiTuiWindowSessionGuard();
    guard.claim(CHAT, 1, 'terminal-1');
    guard.releaseClaim(`/private${CHAT}`, 1, 'terminal-1');

    expect(guard.claim(CHAT, 2, 'terminal-2')).toEqual({ ok: true });
  });

  it('ignores a rollback from a window that does not hold the chat', () => {
    const guard = new PiTuiWindowSessionGuard();
    guard.claim(CHAT, 1, 'terminal-1');

    guard.releaseClaim(CHAT, 2, 'terminal-1');
    guard.releaseClaim('', 1, 'terminal-1');
    guard.releaseClaim(OTHER, 1, 'terminal-1');

    expect(guard.ownerWindowId(CHAT)).toBe(1);
  });

  it("ignores a release naming another window, so one window cannot free another's chat", () => {
    const guard = new PiTuiWindowSessionGuard();
    guard.claim(CHAT, 1, 'terminal-1');
    guard.releaseTerminal(2, 'terminal-1');

    expect(guard.claim(CHAT, 2, 'terminal-2').ok).toBe(false);
  });

  it('frees everything a closing window held, and everything on a reclaimed chat', () => {
    const guard = new PiTuiWindowSessionGuard();
    guard.claim(CHAT, 1, 'terminal-1');
    guard.claim(OTHER, 1, 'terminal-2');
    guard.releaseWindow(1);
    expect(guard.ownerWindowId(CHAT)).toBeNull();
    expect(guard.ownerWindowId(OTHER)).toBeNull();

    guard.claim(CHAT, 3, 'terminal-3');
    guard.releaseSession(`/private${CHAT}`);
    expect(guard.ownerWindowId(CHAT)).toBeNull();
  });

  /**
   * The i18n coverage scan (`src/shared/__tests__/i18nCoverage.test.ts`) only
   * sees `t('literal')` call sites under `src/renderer`. These two sentences
   * are chosen HERE and travel across IPC as a `reason`, so the renderer calls
   * `t(support.reason)` on a variable and the scan cannot see them at all —
   * this is the guard that keeps them out of an otherwise Chinese UI.
   */
  it('ships a Chinese entry for every reason this module sends to the renderer', () => {
    expect(zhTranslations[PI_TUI_SESSION_BUSY_REASON]).toBeTruthy();
    expect(zhTranslations[PI_TUI_NATIVE_SESSION_REASON]).toBeTruthy();
  });

  it('answers the pre-flight without taking the chat', () => {
    const guard = new PiTuiWindowSessionGuard();
    expect(guard.check(CHAT, 1)).toEqual({ ok: true });
    // Asking did not claim it, so the window that actually opens still wins.
    expect(guard.ownerWindowId(CHAT)).toBeNull();

    guard.claim(CHAT, 1, 'terminal-1');
    expect(guard.check(CHAT, 1)).toEqual({ ok: true });
    expect(guard.check(CHAT, 2)).toEqual({ ok: false, reason: PI_TUI_SESSION_BUSY_REASON });
  });
});

describe('inspectPiTuiSessionSupport', () => {
  const v4 = JSON.stringify({ kind: 'header', version: 4, id: 'a', cwd: '/repo', createdAt: 1 });
  const legacy = JSON.stringify({ type: 'session', id: 'a', version: 3 });

  it('refuses a v4 session saved before the dual header, which the pi CLI cannot parse', async () => {
    await expect(
      inspectPiTuiSessionSupport('/s.jsonl', async () => `${v4}\n{"id":"e1"}\n`)
    ).resolves.toEqual({
      supported: false,
      reason: PI_TUI_NATIVE_SESSION_REASON,
    });
  });

  it('allows a v4 session whose header also states the v3 shape (H/20)', async () => {
    // One file, two formats: `type:"session"` is the field the CLI keys on, and
    // the session keeps every v4 field next to it.
    const interop = JSON.stringify({
      kind: 'header',
      version: 4,
      id: 'a',
      cwd: '/repo',
      createdAt: 1,
      type: 'session',
      timestamp: '2026-09-12T00:00:00.000Z',
    });
    await expect(
      inspectPiTuiSessionSupport('/s.jsonl', async () => `${interop}\n{"id":"e1"}\n`)
    ).resolves.toEqual({ supported: true });
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
