import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_ASSET_NOTICE_SETTING_KEY } from '@shared/legacyAssets';
import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-16e (decision 104) — the three legacy-asset channels. The
 * detection itself is covered by `services/legacyAssets/__tests__`; this pins
 * what the IPC layer adds: which workspace reaches it, and that "seen" is a
 * settings key and nothing else.
 */

type Handler = (event: unknown, payload?: unknown) => unknown;
const handlers = new Map<string, Handler>();
const state = { agentDir: '', saveOk: true, openError: '' };

const inspectLegacyAssets = vi.fn(async (_cwd?: unknown) => ({ report: {}, seen: false }));
const mergeSettingsPatch = vi.fn((_patch: Record<string, unknown>) => state.saveOk);
const openPath = vi.fn(async (_path: string) => state.openError);

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  shell: { openPath },
}));
vi.mock('../../services/legacyAssets', () => ({ inspectLegacyAssets }));
vi.mock('../../services/piModelConfig', () => ({ getAppPiAgentDir: () => state.agentDir }));
vi.mock('../settings', () => ({ mergeSettingsPatch }));

function handler(channel: string): Handler {
  const registered = handlers.get(channel);
  if (!registered) throw new Error(`Missing handler: ${channel}`);
  return registered;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  handlers.clear();
  state.saveOk = true;
  state.openError = '';
  state.agentDir = join(mkdtempSync(join(tmpdir(), 'aiclient-legacy-ipc-')), 'pi-agent');
  const { registerLegacyAssetHandlers } = await import('../legacyAssets');
  registerLegacyAssetHandlers();
});

afterEach(() => {
  rmSync(join(state.agentDir, '..'), { recursive: true, force: true });
});

describe('legacy-asset IPC', () => {
  it('passes the workspace the renderer named, and nothing when it named none', async () => {
    await handler(IPC_CHANNELS.LEGACY_ASSETS_INSPECT)({}, { cwd: '/work/repo' });
    await handler(IPC_CHANNELS.LEGACY_ASSETS_INSPECT)({}, {});
    await handler(IPC_CHANNELS.LEGACY_ASSETS_INSPECT)({}, undefined);
    expect(inspectLegacyAssets.mock.calls).toEqual([['/work/repo'], [undefined], [undefined]]);
  });

  it('records "seen" as the Main-owned settings key and nothing else', async () => {
    await handler(IPC_CHANNELS.LEGACY_ASSETS_MARK_SEEN)({});
    expect(mergeSettingsPatch).toHaveBeenCalledExactlyOnceWith({
      [LEGACY_ASSET_NOTICE_SETTING_KEY]: true,
    });
  });

  it('says so when "seen" could not be saved', async () => {
    state.saveOk = false;
    await expect(handler(IPC_CHANNELS.LEGACY_ASSETS_MARK_SEEN)({})).rejects.toThrow(
      'Failed to save the legacy asset notice state'
    );
  });

  it('opens the agent directory, creating it when missing', async () => {
    await handler(IPC_CHANNELS.LEGACY_ASSETS_OPEN_AGENT_DIR)({});
    expect(existsSync(state.agentDir)).toBe(true);
    expect(openPath).toHaveBeenCalledExactlyOnceWith(state.agentDir);
  });

  it('surfaces an OS failure to open it', async () => {
    state.openError = 'no file manager';
    await expect(handler(IPC_CHANNELS.LEGACY_ASSETS_OPEN_AGENT_DIR)({})).rejects.toThrow(
      'no file manager'
    );
  });
});
