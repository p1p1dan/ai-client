import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, payload?: unknown) => unknown;
const handlers = new Map<string, Handler>();
const state = {
  managed: true,
  root: '',
  openError: '',
};

const openPath = vi.fn(async () => state.openError);

function snapshot() {
  return {
    managed: state.managed,
    paths: {
      sharedSkills: join(state.root, '.agents', 'skills'),
      appSkills: join(state.root, '.pilab', 'test', 'pi-agent', 'skills'),
    },
  };
}

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  shell: { openPath },
}));

vi.mock('../../services/piModelConfig', () => ({
  getPiResourceSettings: () => snapshot(),
}));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  handlers.clear();
  state.managed = true;
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

  // dsh-rebase P1-16e: the Resources page's other skill root, `<agentDir>/skills`.
  it('creates and opens this app’s own skill folder', async () => {
    await handler(IPC_CHANNELS.PI_RESOURCES_OPEN_APP_SKILLS)({});
    expect(existsSync(snapshot().paths.appSkills)).toBe(true);
    expect(openPath).toHaveBeenCalledWith(snapshot().paths.appSkills);
    expect(openPath).not.toHaveBeenCalledWith(snapshot().paths.sharedSkills);
  });

  it('reports a failed open of this app’s skill folder', async () => {
    state.openError = 'no file manager';
    await expect(handler(IPC_CHANNELS.PI_RESOURCES_OPEN_APP_SKILLS)({})).rejects.toThrow(
      'no file manager'
    );
  });

  it('returns exact Main-resolved installation paths', async () => {
    await expect(handler(IPC_CHANNELS.PI_RESOURCES_GET_SETTINGS)({})).resolves.toEqual(snapshot());
  });

  /**
   * dsh-rebase P1-12 step 1 (decision 147): the delegation switch (decision
   * 105) and the prompt-template folder (decision 103) had no page left, and
   * their channels went with the native worker. Registering them again would
   * be a setting nothing reads.
   */
  it('registers exactly the read and the two open-folder channels', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.PI_RESOURCES_GET_SETTINGS,
        IPC_CHANNELS.PI_RESOURCES_OPEN_SKILLS,
        IPC_CHANNELS.PI_RESOURCES_OPEN_APP_SKILLS,
      ].sort()
    );
    expect(IPC_CHANNELS).not.toHaveProperty('PI_RESOURCES_UPDATE_SETTINGS');
    expect(IPC_CHANNELS).not.toHaveProperty('PI_RESOURCES_OPEN_PROMPTS');
  });
});
