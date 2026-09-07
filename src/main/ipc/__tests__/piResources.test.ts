import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PI_BORROW_USER_RESOURCES_SETTING_KEY,
  PI_ENABLE_SUBAGENTS_SETTING_KEY,
} from '@shared/piModelConfig';
import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, payload?: unknown) => unknown;
const handlers = new Map<string, Handler>();
const state = {
  managed: true,
  borrowUserPiResources: true,
  enableSubagents: false,
  root: '',
  saveOk: true,
  openError: '',
};

const invalidateAll = vi.fn(async () => undefined);
const openPath = vi.fn(async () => state.openError);
// Applies only the keys the patch actually carries. The handler sends a
// PARTIAL patch, so a mock that read both keys unconditionally would write
// `undefined` over whichever switch the user did not touch — and the test would
// pass while the real bug (one toggle clearing the other) went unmodelled.
const mergeSettingsPatch = vi.fn((patch: Record<string, unknown>) => {
  if (!state.saveOk) return false;
  if (PI_BORROW_USER_RESOURCES_SETTING_KEY in patch) {
    state.borrowUserPiResources = patch[PI_BORROW_USER_RESOURCES_SETTING_KEY] as boolean;
  }
  if (PI_ENABLE_SUBAGENTS_SETTING_KEY in patch) {
    state.enableSubagents = patch[PI_ENABLE_SUBAGENTS_SETTING_KEY] as boolean;
  }
  return true;
});

function snapshot() {
  return {
    managed: state.managed,
    borrowUserPiResources: state.borrowUserPiResources,
    enableSubagents: state.enableSubagents,
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
  state.enableSubagents = false;
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
    for (const payload of [
      null,
      {},
      { borrowUserPiResources: 'yes' },
      { enableSubagents: 'yes' },
      // Named nothing this handler knows: a caller that meant to change
      // something and misspelled the field must hear about it, not get a
      // silent no-op back that looks like a saved setting.
      { subagents: true },
    ]) {
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

/**
 * The sub-agent switch — one settings surface, two independent switches.
 *
 * Default OFF and, unlike borrowing, it matters in BOTH credential modes: the
 * bundled copy is injected on the local route too, so the workers have to come
 * back either way.
 */
describe('Pi resource settings IPC — sub-agents', () => {
  it('saves it and restarts workers in managed mode', async () => {
    await expect(
      handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)({}, { enableSubagents: true })
    ).resolves.toMatchObject({ enableSubagents: true });

    expect(mergeSettingsPatch).toHaveBeenCalledWith({ [PI_ENABLE_SUBAGENTS_SETTING_KEY]: true });
    expect(invalidateAll).toHaveBeenCalledOnce();
  });

  it('restarts workers in local mode too, where the borrow switch would not', async () => {
    state.managed = false;
    await handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)({}, { enableSubagents: true });
    expect(invalidateAll).toHaveBeenCalledOnce();
  });

  it('leaves the other switch alone', async () => {
    // The renderer sends one field per toggle. If either end ever sent the pair
    // from a stale snapshot, this is the assertion that would catch it.
    const after = (await handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)(
      {},
      { enableSubagents: true }
    )) as { borrowUserPiResources: boolean; enableSubagents: boolean };
    expect(after).toMatchObject({ borrowUserPiResources: true, enableSubagents: true });
    expect(mergeSettingsPatch).toHaveBeenCalledWith({ [PI_ENABLE_SUBAGENTS_SETTING_KEY]: true });
  });

  it('does nothing when the value is already what was asked for', async () => {
    await handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)({}, { enableSubagents: false });
    expect(mergeSettingsPatch).not.toHaveBeenCalled();
    expect(invalidateAll).not.toHaveBeenCalled();
  });
});
