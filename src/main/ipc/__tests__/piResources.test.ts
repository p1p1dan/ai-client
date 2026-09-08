import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PI_BORROW_USER_RESOURCES_SETTING_KEY,
  PI_ENABLE_SUBAGENTS_SETTING_KEY,
  PI_OPT_IN_FEATURE_SETTINGS_KEY,
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
  featurePreferences: {} as Record<string, boolean>,
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
  if (PI_OPT_IN_FEATURE_SETTINGS_KEY in patch) {
    state.featurePreferences = patch[PI_OPT_IN_FEATURE_SETTINGS_KEY] as Record<string, boolean>;
    state.enableSubagents = state.featurePreferences.subagents ?? state.enableSubagents;
  }
  return true;
});

function snapshot() {
  return {
    managed: state.managed,
    borrowUserPiResources: state.borrowUserPiResources,
    enableSubagents: state.enableSubagents,
    bundledFeatures: [{ id: 'subagents', enabled: state.enableSubagents }],
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

vi.mock('../../services/SharedSessionState', () => ({
  readSharedSettings: () => ({ [PI_OPT_IN_FEATURE_SETTINGS_KEY]: state.featurePreferences }),
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
  state.featurePreferences = {};
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
  it.each([true, false])('opens the shared skill home in managed=%s mode', async (managed) => {
    state.managed = managed;
    await handler(IPC_CHANNELS.PI_RESOURCES_OPEN_SKILLS)({});
    expect(existsSync(snapshot().paths.sharedSkills)).toBe(true);
    expect(openPath).toHaveBeenCalledWith(snapshot().paths.sharedSkills);
  });

  it('reports a failed skills folder open', async () => {
    state.openError = 'no file manager';
    await expect(handler(IPC_CHANNELS.PI_RESOURCES_OPEN_SKILLS)({})).rejects.toThrow(
      'no file manager'
    );
  });

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
  it('repeated generic updates do not write or restart the worker again', async () => {
    const update = handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS);
    await update({}, { optInFeatures: { subagents: true } });
    expect(state.enableSubagents).toBe(true);
    await update({}, { optInFeatures: { subagents: true } });
    expect(mergeSettingsPatch).toHaveBeenCalledOnce();
    expect(invalidateAll).toHaveBeenCalledOnce();
  });

  it('preserves other stored feature preferences when updating a single switch', async () => {
    state.featurePreferences = { futureFeature: true };
    await handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)(
      {},
      { optInFeatures: { subagents: true } }
    );
    expect(state.featurePreferences).toEqual({ futureFeature: true, subagents: true });
  });

  it('saves the registry toggle through the generic setting and ignores unknown ids', async () => {
    await handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)(
      {},
      { optInFeatures: { subagents: true, unknown: true } }
    );
    expect(mergeSettingsPatch).toHaveBeenCalledWith({
      [PI_OPT_IN_FEATURE_SETTINGS_KEY]: { subagents: true },
    });
    expect(invalidateAll).toHaveBeenCalledOnce();
  });

  it('ignores an unknown-only update and rejects malformed known values', async () => {
    await handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)(
      {},
      { optInFeatures: { unknown: true } }
    );
    expect(mergeSettingsPatch).not.toHaveBeenCalled();
    await expect(
      handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)(
        {},
        { optInFeatures: { subagents: 'yes' } }
      )
    ).rejects.toThrow('Invalid');
  });

  it('saves it and restarts workers in managed mode', async () => {
    await expect(
      handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)({}, { enableSubagents: true })
    ).resolves.toMatchObject({ enableSubagents: true });

    expect(mergeSettingsPatch).toHaveBeenCalledWith({
      [PI_ENABLE_SUBAGENTS_SETTING_KEY]: true,
      [PI_OPT_IN_FEATURE_SETTINGS_KEY]: { subagents: true },
    });
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
    expect(mergeSettingsPatch).toHaveBeenCalledWith({
      [PI_ENABLE_SUBAGENTS_SETTING_KEY]: true,
      [PI_OPT_IN_FEATURE_SETTINGS_KEY]: { subagents: true },
    });
  });

  it('does nothing when the value is already what was asked for', async () => {
    await handler(IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS)({}, { enableSubagents: false });
    expect(mergeSettingsPatch).not.toHaveBeenCalled();
    expect(invalidateAll).not.toHaveBeenCalled();
  });
});
