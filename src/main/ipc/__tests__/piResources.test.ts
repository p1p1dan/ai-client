import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PI_BORROW_USER_RESOURCES_SETTING_KEY } from '@shared/piModelConfig';
import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, payload?: unknown) => unknown;
const handlers = new Map<string, Handler>();
const state = {
  managed: true,
  borrowUserPiResources: true,
  root: '',
  saveOk: true,
  openError: '',
};

const invalidateAll = vi.fn(async () => undefined);
const openPath = vi.fn(async () => state.openError);
const mergeSettingsPatch = vi.fn((patch: Record<string, unknown>) => {
  if (!state.saveOk) return false;
  state.borrowUserPiResources = patch[PI_BORROW_USER_RESOURCES_SETTING_KEY] as boolean;
  return true;
});

function snapshot() {
  return {
    managed: state.managed,
    borrowUserPiResources: state.borrowUserPiResources,
    paths: {
      sharedSkills: join(state.root, '.agents', 'skills'),
      userSkills: join(state.root, '.pi', 'agent', 'skills'),
      userPromptTemplates: join(state.root, '.pi', 'agent', 'prompts'),
      managedSkills: join(state.root, '.pilab', 'test', 'pi-agent', 'skills'),
      managedPromptTemplates: join(state.root, '.pilab', 'test', 'pi-agent', 'prompts'),
    },
  };
}

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  shell: { openPath },
}));

vi.mock('../../services/agent-host/WorkerManager', () => ({
  workerManager: { invalidateAll },
}));

vi.mock('../../services/piModelConfig', () => ({
  getActivePiPromptTemplatesDir: () =>
    state.managed ? snapshot().paths.managedPromptTemplates : snapshot().paths.userPromptTemplates,
  getPiResourceSettings: () => snapshot(),
}));

vi.mock('../settings', () => ({ mergeSettingsPatch }));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  handlers.clear();
  state.managed = true;
  state.borrowUserPiResources = true;
  state.saveOk = true;
  state.openError = '';
  state.root = mkdtempSync(join(tmpdir(), 'aiclient-pi-resources-'));
  const { registerPiResourceHandlers } = await import('../piResources');
  registerPiResourceHandlers();
});

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true });
});

function handler(channel: string): Handler {
  const registered = handlers.get(channel);
  if (!registered) throw new Error(`Missing handler: ${channel}`);
  return registered;
}

describe('Pi resource settings IPC', () => {
  it('returns exact Main-resolved installation paths', async () => {
    await expect(handler(IPC_CHANNELS.PI_RESOURCES_GET_SETTINGS)({})).resolves.toEqual(snapshot());
  });

  it('saves the borrow switch through the Main-owned settings path and reloads managed workers', async () => {
    await expect(
      handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)({}, { borrowUserPiResources: false })
    ).resolves.toMatchObject({ borrowUserPiResources: false });

    expect(mergeSettingsPatch).toHaveBeenCalledWith({
      [PI_BORROW_USER_RESOURCES_SETTING_KEY]: false,
    });
    expect(invalidateAll).toHaveBeenCalledOnce();
  });

  it('does not restart workers when the value is unchanged or local mode already owns the directory', async () => {
    await handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)(
      {},
      {
        borrowUserPiResources: true,
      }
    );
    expect(mergeSettingsPatch).not.toHaveBeenCalled();

    state.managed = false;
    await handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)(
      {},
      {
        borrowUserPiResources: false,
      }
    );
    expect(mergeSettingsPatch).toHaveBeenCalledOnce();
    expect(invalidateAll).not.toHaveBeenCalled();
  });

  it('rejects malformed settings and failed persistence', async () => {
    for (const payload of [null, {}, { borrowUserPiResources: 'yes' }]) {
      await expect(handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)({}, payload)).rejects.toThrow(
        'Invalid Pi resource settings request'
      );
    }
    expect(mergeSettingsPatch).not.toHaveBeenCalled();

    state.saveOk = false;
    await expect(
      handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)(
        {},
        {
          borrowUserPiResources: false,
        }
      )
    ).rejects.toThrow('Failed to save Pi resource settings');
    expect(invalidateAll).not.toHaveBeenCalled();
  });

  it('creates and opens the app-managed prompt templates directory', async () => {
    const path = snapshot().paths.managedPromptTemplates;
    expect(existsSync(path)).toBe(false);

    await handler(IPC_CHANNELS.PI_RESOURCES_OPEN_PROMPTS)({});

    expect(existsSync(path)).toBe(true);
    expect(openPath).toHaveBeenCalledWith(path);
  });

  it('opens the personal prompt directory when local setup is active', async () => {
    state.managed = false;
    const path = snapshot().paths.userPromptTemplates;

    await handler(IPC_CHANNELS.PI_RESOURCES_OPEN_PROMPTS)({});

    expect(existsSync(path)).toBe(true);
    expect(openPath).toHaveBeenCalledWith(path);
  });

  it('surfaces an OS failure to open the prompt templates directory', async () => {
    state.openError = 'no file manager';
    await expect(handler(IPC_CHANNELS.PI_RESOURCES_OPEN_PROMPTS)({})).rejects.toThrow(
      'Failed to open prompt templates folder: no file manager'
    );
  });
});
