import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginManifest } from '@shared/plugins/manifest';
import type { HostApiMethod } from '@shared/plugins/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProcess, resolvePluginLaunch } from '../pluginProcess';

/**
 * The real plugin host (`src/plugin-host/pluginHost.ts`) on the Node running
 * the tests, with a sample plugin written to a temp dir.
 */

let dir: string;

const manifest: PluginManifest = {
  schemaVersion: 1,
  id: 'pilab.sample',
  name: 'Sample',
  version: '0.1.0',
  apiVersion: 1,
  main: 'main.mjs',
  permissions: ['chat.read'],
  contributes: { settings: [], services: [{ id: 'worker' }] },
};

const SAMPLE = `
let api;
export async function activate(pilab) {
  api = pilab;
  const settings = await pilab.settings.get();
  pilab.log.info('activated with ' + JSON.stringify(settings));
  pilab.services.register('worker', {
    start: async () => { await pilab.status.set({ state: 'ok', text: 'started' }); },
    stop: () => {},
  });
  pilab.chat.onEvent((entry) => { void pilab.status.set({ state: 'ok', text: 'saw ' + entry.event.type }); });
  pilab.sessionControl.onChange(() => { process.exit(3); });
}
export async function deactivate() {
  await api.status.set({ state: 'idle', text: 'bye' });
}
`;

function launchFor(main = SAMPLE) {
  writeFileSync(path.join(dir, 'main.mjs'), main);
  return resolvePluginLaunch({
    isPackaged: false,
    appPath: process.cwd(),
    resourcesPath: '',
    pluginId: manifest.id,
    dataDir: dir,
    env: { ...process.env, AICLIENT_DSH_NODE: process.execPath },
  });
}

function handlers() {
  const calls: Array<[HostApiMethod, unknown[]]> = [];
  const exits: Array<{ expected: boolean; code: number | null }> = [];
  const logs: string[] = [];
  return {
    calls,
    exits,
    logs,
    value: {
      onHostCall: vi.fn(async (method: HostApiMethod, args: unknown[]) => {
        calls.push([method, args]);
        return method === 'settings.get' ? { url: 'x' } : null;
      }),
      onLog: (_level: string, message: string) => logs.push(message),
      onExit: (info: { expected: boolean; code: number | null }) => exits.push(info),
    },
  };
}

const init = () => ({
  t: 'init' as const,
  pluginId: manifest.id,
  manifest,
  pluginDir: dir,
  dataDir: dir,
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plugin-proc-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('PluginProcess with the real plugin host', () => {
  it('[PLG-PROC] activates, runs a service, receives events, and deactivates on stop', async () => {
    const h = handlers();
    const plugin = await PluginProcess.start(launchFor(), init(), h.value);
    expect(h.calls[0]).toEqual(['settings.get', []]);
    await until(() => h.logs.some((line) => line.includes('activated with {"url":"x"}')));
    // onEvent's first listener subscribes.
    await until(() => h.calls.some(([method]) => method === 'chat.subscribe'));

    await plugin.call('service.start', ['worker'], 5000);
    expect(h.calls).toContainEqual(['status.set', [{ state: 'ok', text: 'started' }]]);

    plugin.emit('chat.event', { cursor: 1, event: { type: 'session.status' } });
    await until(() =>
      h.calls.some(([, args]) => (args[0] as { text?: string })?.text === 'saw session.status')
    );

    await plugin.stop();
    expect(h.calls).toContainEqual(['status.set', [{ state: 'idle', text: 'bye' }]]);
    expect(h.exits).toEqual([expect.objectContaining({ expected: true })]);
  }, 20_000);

  it('[PLG-PROC] a plugin that dies is reported as unexpected, and its calls fail', async () => {
    const h = handlers();
    const plugin = await PluginProcess.start(launchFor(), init(), h.value);
    plugin.emit('sessionControl.changed', {});
    await until(() => h.exits.length === 1);
    expect(h.exits[0]).toMatchObject({ expected: false, code: 3 });
    await expect(plugin.call('service.start', ['worker'], 1000)).rejects.toThrow(/PLUGIN_CRASHED/);
  }, 20_000);

  it('[PLG-PROC] activation that throws fails the start with its message', async () => {
    const h = handlers();
    await expect(
      PluginProcess.start(
        launchFor('export function activate() { throw new Error("no relay configured"); }'),
        init(),
        h.value
      )
    ).rejects.toThrow(/no relay configured/);
  }, 20_000);

  it('[PLG-PROC] a module without activate is refused', async () => {
    const h = handlers();
    await expect(
      PluginProcess.start(launchFor('export const x = 1;'), init(), h.value)
    ).rejects.toThrow(/does not export activate/);
  }, 20_000);

  it('[PLG-PROC] the plugin gets only allowlisted environment variables', () => {
    const launch = resolvePluginLaunch({
      isPackaged: true,
      appPath: '',
      resourcesPath: '/res',
      pluginId: 'p.x',
      dataDir: '/data',
      platform: 'linux',
      env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-secret', HOME: '/home/u' },
      exists: () => true,
    });
    expect(launch).toEqual({
      command: '/res/node-runtime/node',
      args: ['/res/plugin-host/pluginHost.mjs'],
      cwd: '/data',
      env: { PILAB_PLUGIN_ID: 'p.x', PATH: '/bin', HOME: '/home/u' },
    });
  });
});
