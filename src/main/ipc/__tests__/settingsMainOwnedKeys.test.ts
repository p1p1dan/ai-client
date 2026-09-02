import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIAL_MODE_SETTING_KEY } from '@shared/credentialMode';
import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The renderer persists settings by writing the WHOLE object back
 * (`renderer/stores/settings/storage.ts`: read, patch one key, write it all).
 * `credentialMode` is written on the OTHER side of that object, straight
 * through `SharedSessionState` by `services/auth/credentialMode.ts`, and the
 * renderer never models it.
 *
 * On 2026-08-28 that combination erased the key on a real machine: `ipc/
 * settings.ts` kept its own snapshot of the file, filled by the first read and
 * never refreshed, so a save issued after the welcome screen wrote `local` put
 * the pre-click value back. Both reported symptoms came out of that one write
 * — `auth_required` for a user who had picked `Use my own setup`, and the
 * company credential never being injected for a user who then signed in.
 */

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

function settingsFilePath(): string {
  return join(homeDir, '.pilab', 'jyw-ai-client', 'settings.json');
}

function readSettingsFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsFilePath(), 'utf-8')) as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetModules();
  handlers.clear();
  homeDir = mkdtempSync(join(tmpdir(), 'aiclient-settings-owned-'));
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

async function loadSettingsModule() {
  const mod = await import('../settings');
  mod.registerSettingsHandlers();
  return mod;
}

/** What the renderer does: read the whole object, change one key, write it all back. */
async function rendererSave(patch: Record<string, unknown>): Promise<void> {
  const write = handlers.get(IPC_CHANNELS.SETTINGS_WRITE);
  const read = handlers.get(IPC_CHANNELS.SETTINGS_READ);
  if (!write || !read) throw new Error('settings handlers not registered');
  const current = ((await read({})) ?? {}) as Record<string, unknown>;
  await write({}, { ...current, ...patch });
}

describe('settings.json — Main-owned keys survive a renderer whole-object save', () => {
  it('a credentialMode written AFTER the renderer read is not erased by its save', async () => {
    vi.useFakeTimers();
    const settings = await loadSettingsModule();
    const { setCredentialMode } = await import('../../services/auth/credentialMode');

    // The renderer reads once at boot — this is the snapshot that used to be
    // frozen for the life of the process.
    const read = handlers.get(IPC_CHANNELS.SETTINGS_READ);
    if (!read) throw new Error('settings handlers not registered');
    await read({});

    // Then the user clicks `Use my own setup`.
    setCredentialMode('local');

    // Then anything at all changes a setting.
    await rendererSave({ 'aiclient-settings': { state: { theme: 'dark' } } });
    await vi.advanceTimersByTimeAsync(600);

    expect(readSettingsFile()[CREDENTIAL_MODE_SETTING_KEY]).toBe('local');
    expect(settings.readSettings()?.[CREDENTIAL_MODE_SETTING_KEY]).toBe('local');
  });

  it('a mode change DURING the debounce window still wins over the queued payload', async () => {
    vi.useFakeTimers();
    await loadSettingsModule();
    const { setCredentialMode } = await import('../../services/auth/credentialMode');

    setCredentialMode('local');
    await rendererSave({ 'aiclient-settings': { state: { theme: 'dark' } } });
    // Signing in records `managed` while the renderer's save is still queued.
    setCredentialMode('managed');
    await vi.advanceTimersByTimeAsync(600);

    expect(readSettingsFile()[CREDENTIAL_MODE_SETTING_KEY]).toBe('managed');
  });

  it('a renderer payload cannot INVENT a Main-owned key either', async () => {
    vi.useFakeTimers();
    await loadSettingsModule();
    const write = handlers.get(IPC_CHANNELS.SETTINGS_WRITE);
    if (!write) throw new Error('settings handlers not registered');

    // Nothing has recorded a mode: absence is meaningful (first run must sign
    // in), so a renderer-supplied value must not become the answer.
    await write({}, { [CREDENTIAL_MODE_SETTING_KEY]: 'local', theme: 'dark' });
    await vi.advanceTimersByTimeAsync(600);

    expect(CREDENTIAL_MODE_SETTING_KEY in readSettingsFile()).toBe(false);
  });

  it('mergeSettingsPatch still sets Main-owned keys — the guard is for renderer writes only', async () => {
    const settings = await loadSettingsModule();
    settings.mergeSettingsPatch({ onboarding: { registered: true, email: 'a@jcdz.cc' } });

    expect(readSettingsFile().onboarding).toEqual({ registered: true, email: 'a@jcdz.cc' });
  });
});
