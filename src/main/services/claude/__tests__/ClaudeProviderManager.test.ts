import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initClaudeProviderWatcher,
  toggleClaudeProviderWatcher,
} from '../../../ipc/claudeProvider';
import { MANAGED_CREDENTIALS_FLAG_ENV } from '../../auth/AuthStateService';
import { trimManagedProviderExtracted, unwatchClaudeSettings } from '../ClaudeProviderManager';

function fakeWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
}

describe('trimManagedProviderExtracted — whitelist construction', () => {
  it('keeps only baseUrl + the three default-model keys, drops authToken', () => {
    const result = trimManagedProviderExtracted({
      baseUrl: 'https://a.example.com',
      authToken: 'secret-should-not-survive',
      defaultSonnetModel: 'sonnet-x',
      defaultOpusModel: 'opus-x',
      defaultHaikuModel: 'haiku-x',
    });

    expect(result).toEqual({
      baseUrl: 'https://a.example.com',
      defaultSonnetModel: 'sonnet-x',
      defaultOpusModel: 'opus-x',
      defaultHaikuModel: 'haiku-x',
    });
    expect(JSON.stringify(result)).not.toContain('secret-should-not-survive');
  });

  it('drops an unknown field — whitelist construction, not a delete-style trim', () => {
    const result = trimManagedProviderExtracted({
      baseUrl: 'https://a.example.com',
      // @ts-expect-error deliberately probing an unmodeled field
      futureField: 'should-not-leak',
    });

    expect(JSON.stringify(result)).not.toContain('futureField');
  });

  it('passes null through unchanged', () => {
    expect(trimManagedProviderExtracted(null)).toBeNull();
  });
});

/**
 * D47 S2b §1 Provider ③ four-arm matrix: user-setting × managed-flag. Only
 * "user on + managed off" actually starts `fs.watch`. Both production entry
 * points (`initClaudeProviderWatcher` on startup, `toggleClaudeProviderWatcher`
 * on settings toggle) are driven directly to prove the single choke point in
 * `watchClaudeSettings()` closes both.
 */
describe('watchClaudeSettings managed gate — four-arm matrix', () => {
  let tempDir: string;
  let originalClaudeConfigDir: string | undefined;
  let originalFlag: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const STARTED_MSG = '[ClaudeProviderManager] Started watching';
  const SKIPPED_MSG =
    '[ClaudeProviderManager] Managed credentials enabled: skipping settings watcher.';

  // `node:fs`'s ESM namespace export can't be spied on directly (Vitest:
  // "Cannot redefine property"), so this observes the real, deterministic
  // side effect instead: `watchClaudeSettings()` always logs exactly one of
  // "Started watching" (armed) or the managed-skip message (gated) — no
  // debounce/fs-event timing involved, unlike asserting via an actual
  // settings.json change notification.
  function loggedStart(): boolean {
    return logSpy.mock.calls.some((call) => String(call[0]).includes(STARTED_MSG));
  }
  function loggedSkip(): boolean {
    return logSpy.mock.calls.some((call) => String(call[0]).includes(SKIPPED_MSG));
  }

  beforeEach(async () => {
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    originalFlag = process.env[MANAGED_CREDENTIALS_FLAG_ENV];
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'claude-provider-watch-'));
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    unwatchClaudeSettings();
    logSpy.mockRestore();

    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    if (originalFlag === undefined) {
      delete process.env[MANAGED_CREDENTIALS_FLAG_ENV];
    } else {
      process.env[MANAGED_CREDENTIALS_FLAG_ENV] = originalFlag;
    }

    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it('user off + managed off: init never calls watchClaudeSettings at all', () => {
    delete process.env[MANAGED_CREDENTIALS_FLAG_ENV];
    initClaudeProviderWatcher(fakeWindow(), false);
    expect(loggedStart()).toBe(false);
    expect(loggedSkip()).toBe(false);
  });

  it('user off + managed on: init never calls watchClaudeSettings at all', () => {
    process.env[MANAGED_CREDENTIALS_FLAG_ENV] = '1';
    initClaudeProviderWatcher(fakeWindow(), false);
    expect(loggedStart()).toBe(false);
    expect(loggedSkip()).toBe(false);
  });

  it('user on + managed off: init DOES start the watcher (the only arm that starts)', () => {
    delete process.env[MANAGED_CREDENTIALS_FLAG_ENV];
    initClaudeProviderWatcher(fakeWindow(), true);
    expect(loggedStart()).toBe(true);
    expect(loggedSkip()).toBe(false);
  });

  it('user on + managed on: init calls watchClaudeSettings, which gates itself off', () => {
    process.env[MANAGED_CREDENTIALS_FLAG_ENV] = '1';
    initClaudeProviderWatcher(fakeWindow(), true);
    expect(loggedStart()).toBe(false);
    expect(loggedSkip()).toBe(true);
  });

  it('toggle entry point: user on + managed off starts the watcher', () => {
    delete process.env[MANAGED_CREDENTIALS_FLAG_ENV];
    initClaudeProviderWatcher(fakeWindow(), false); // register window, do not start yet
    toggleClaudeProviderWatcher(true);
    expect(loggedStart()).toBe(true);
    expect(loggedSkip()).toBe(false);
  });

  it('toggle entry point: user on + managed on does not start the watcher (same choke point as init)', () => {
    process.env[MANAGED_CREDENTIALS_FLAG_ENV] = '1';
    initClaudeProviderWatcher(fakeWindow(), false);
    toggleClaudeProviderWatcher(true);
    expect(loggedStart()).toBe(false);
    expect(loggedSkip()).toBe(true);
  });

  /**
   * Mutation pin (D47 S2 §3-8, s2b-mutation-plan pair 7): `resolveManagedCredentialsEnabled`
   * is a strict `=== '1'` check (S1 §2.6) — every other spelling, including a
   * shell-inherited truthy-looking value, must read as off. A loose reader
   * at this choke point (e.g. `Boolean(process.env[...])`) would still pass
   * every other arm in this matrix (they only ever set `'1'` or leave it
   * unset) but silently start gating on `'true'`, `'yes'`, etc. This case
   * exercises exactly that spelling and asserts it behaves identically to
   * "managed off" — the watcher starts.
   */
  it('user on + managed flag set to a loose truthy spelling ("true", not "1"): still starts the watcher — strict \'1\' contract (S1 §2.6)', () => {
    process.env[MANAGED_CREDENTIALS_FLAG_ENV] = 'true';
    initClaudeProviderWatcher(fakeWindow(), true);
    expect(loggedStart()).toBe(true);
    expect(loggedSkip()).toBe(false);
  });
});
