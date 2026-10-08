import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 1.0.4 field report (2026-10-08): "Appearance has to be set again on every
 * launch" on a Windows machine with a transparent-encryption driver.
 *
 * Two of the ways that can happen leave nothing behind in 1.0.4: a save whose
 * temp-file rename is refused (the error was swallowed, and the memo already
 * held the new object, so the session looked saved), and a settings.json Main
 * cannot parse (read as `{}`, i.e. every setting at its default). These cases
 * pin the log lines a field report is read against, and that those lines carry
 * neither the path nor the content.
 */

const fsControl = vi.hoisted(() => ({ failRename: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (fsControl.failRename) {
        // Shaped like the Windows error: message and `path` both carry the path.
        throw Object.assign(
          new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`),
          { code: 'EPERM', syscall: 'rename', path: from, dest: to }
        );
      }
      return actual.renameSync(from, to);
    },
  };
});

const state = { userDataPath: '' };
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'userData' ? state.userDataPath : tmpdir())),
    on: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

let homeDir: string;
const originalHome = process.env.HOME;

function stateRoot(): string {
  return join(homeDir, '.pilab', 'jyw-ai-client');
}

function settingsFilePath(): string {
  return join(stateRoot(), 'settings.json');
}

function putSettingsFile(bytes: Buffer | string): void {
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(settingsFilePath(), bytes);
}

function loggedLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((call) => call.map(String).join(' '))
    .filter((line) => line.includes('[settings]'));
}

beforeEach(() => {
  vi.resetModules();
  handlers.clear();
  fsControl.failRename = false;
  homeDir = mkdtempSync(join(tmpdir(), 'aiclient-settings-diag-'));
  process.env.HOME = homeDir;
  state.userDataPath = join(homeDir, 'appdata', 'jyw-ai-client');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(homeDir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

async function boot() {
  const mod = await import('../settings');
  // `init()` reads the file before the logger exists, then registers handlers.
  mod.readSettings();
  mod.registerSettingsHandlers();
  return mod;
}

const SAVED = {
  credentialMode: 'managed',
  'aiclient-settings': { state: { theme: 'dark', chatFontFamily: 'Fira Sans' }, version: 0 },
};

describe('settings.json — startup read', () => {
  it('reports a normal file in one info line, with shape only', async () => {
    putSettingsFile(JSON.stringify(SAVED));
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await boot();

    const lines = loggedLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[settings\] settings\.json at startup: outcome=ok bytes=\d+ head=brace renderer-state=present persist-version=0 legacy-marker=(present|absent)$/
    );
    expect(lines[0]).not.toContain(homeDir);
  });

  it('reads a file an editor saved with a UTF-8 BOM instead of dropping every setting', async () => {
    putSettingsFile(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(SAVED))])
    );
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const settings = await boot();

    expect(settings.readSettingsState()).toMatchObject({
      theme: 'dark',
      chatFontFamily: 'Fira Sans',
    });
    expect(loggedLines(info)[0]).toContain('outcome=ok');
    expect(loggedLines(info)[0]).toContain('head=bom');
  });

  it('warns, without content, when the file Main read is ciphertext', async () => {
    putSettingsFile(
      Buffer.concat([Buffer.from('%TSD-Header-###%'), Buffer.from([0x00, 0x9f, 0x13, 0x7b])])
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const settings = await boot();

    expect(settings.readSettingsState()).toEqual({});
    const lines = loggedLines(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('outcome=invalid-json');
    expect(lines[0]).toContain('head=tsd-header');
    expect(lines[0]).toContain('renderer-state=absent');
    expect(lines[0]).not.toContain(homeDir);
    expect(lines[0]).not.toContain('TSD-Header');
  });
});

describe('settings.json — a save that does not land', () => {
  it('logs the errno and syscall, never the path, and says when saving recovers', async () => {
    vi.useFakeTimers();
    putSettingsFile(JSON.stringify(SAVED));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await boot();
    const write = handlers.get(IPC_CHANNELS.SETTINGS_WRITE);
    if (!write) throw new Error('settings handlers not registered');

    fsControl.failRename = true;
    await write({}, { ...SAVED, 'aiclient-settings': { state: { theme: 'system' }, version: 0 } });
    await vi.advanceTimersByTimeAsync(600);

    const failures = loggedLines(warn);
    expect(failures).toEqual([
      '[settings] Failed to save settings.json: code=EPERM syscall=rename consecutive=1',
    ]);
    // The file on disk is still the old one — this is the symptom.
    expect(
      JSON.parse(readFileSync(settingsFilePath(), 'utf-8'))['aiclient-settings'].state.theme
    ).toBe('dark');

    fsControl.failRename = false;
    await write({}, { ...SAVED, 'aiclient-settings': { state: { theme: 'system' }, version: 0 } });
    await vi.advanceTimersByTimeAsync(600);

    expect(loggedLines(info)).toContain('[settings] Saved after 1 failed attempt(s).');
    expect(
      JSON.parse(readFileSync(settingsFilePath(), 'utf-8'))['aiclient-settings'].state.theme
    ).toBe('system');
    for (const line of [...loggedLines(warn), ...loggedLines(info)]) {
      expect(line).not.toContain(homeDir);
    }
  });
});
