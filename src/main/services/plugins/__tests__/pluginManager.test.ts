import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginView } from '@shared/plugins/view';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionControlRegistry } from '../../chat/sessionControl';
import type { PluginAuditEntry } from '../pluginBroker';
import { PluginManager } from '../pluginManager';
import { resolvePluginLaunch } from '../pluginProcess';
import { PluginStore } from '../pluginStore';
import { writeZip } from '../zipWriter';

/** The manager over the real store and real plugin processes (Node running the tests). */

let root: string;
let manager: PluginManager;
let views: PluginView[];
let chatListeners: Array<(event: RuntimeEvent) => void>;
let timers: Array<{ run: () => void; ms: number }>;
let audits: PluginAuditEntry[];
const invokeChat = vi.fn(async (channel: string) => ({ channel }));

const MANIFEST = {
  schemaVersion: 1,
  id: 'pilab.sample',
  name: 'Sample',
  version: '0.1.0',
  apiVersion: 1,
  main: 'main.mjs',
  permissions: ['chat.read', 'chat.control'],
  contributes: {
    settings: [{ key: 'greeting', title: 'Greeting', type: 'string', default: 'hi' }],
    services: [{ id: 'worker' }],
  },
};

/** Reports what it sees through its status; dies on request. */
const MAIN = `
export async function activate(pilab) {
  pilab.services.register('worker', {
    start: async () => {
      const s = await pilab.settings.get();
      await pilab.status.set({ state: 'ok', text: 'greeting=' + s.greeting });
    },
    stop: () => {},
  });
  pilab.chat.onEvent(async (entry) => {
    if (entry.event.type === 'custom.message') process.exit(9);
    const snap = await pilab.chat.snapshot(entry.event.sessionId);
    await pilab.status.set({ state: 'ok', text: entry.cursor + ':' + snap.status });
  });
  pilab.settings.onChange((values) => { void pilab.status.set({ state: 'ok', text: 'now ' + values.greeting }); });
  pilab.sessionControl.onChange(async (change) => {
    await pilab.chat.invoke('phone', 'chat:send', { sessionId: change.sessionId, text: 'x' });
  });
}
`;

function pack(): string {
  const file = path.join(root, 'sample.pilabplug');
  writeFileSync(
    file,
    writeZip([
      { path: 'manifest.json', data: Buffer.from(JSON.stringify(MANIFEST)) },
      { path: 'main.mjs', data: Buffer.from(MAIN) },
    ])
  );
  return file;
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not met: ${JSON.stringify(views)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const sample = () => views.find((view) => view.id === 'pilab.sample');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'plugin-mgr-'));
  views = [];
  chatListeners = [];
  timers = [];
  audits = [];
  invokeChat.mockClear();
  let owner = 0;
  const store = new PluginStore(path.join(root, 'plugins'), {
    available: () => false,
    encrypt: (t) => t,
    decrypt: (t) => t,
  });
  manager = new PluginManager({
    store,
    launch: (plugin) =>
      resolvePluginLaunch({
        isPackaged: false,
        appPath: process.cwd(),
        resourcesPath: '',
        pluginId: plugin.manifest.id,
        dataDir: plugin.dataDir,
        env: { ...process.env, AICLIENT_DSH_NODE: process.execPath },
      }),
    invokeChat,
    onChatRuntimeEvent: (listener) => {
      chatListeners.push(listener);
      return () => {
        chatListeners = chatListeners.filter((l) => l !== listener);
      };
    },
    sessionControl: new SessionControlRegistry(),
    allocateOwnerId: () => {
      owner -= 1;
      return owner;
    },
    appendAudit: (entry) => audits.push(entry),
    log: () => undefined,
    notify: (next) => {
      views = next;
    },
    setTimer: (run, ms) => {
      timers.push({ run, ms });
      return setTimeout(() => undefined, 0);
    },
  });
});

afterEach(async () => {
  await manager.stopAll();
  rmSync(root, { recursive: true, force: true });
});

const event = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, sessionId: 's1', seq: 1, timestamp: 1, ...extra }) as unknown as RuntimeEvent;

describe('PluginManager', () => {
  it('[PLG-MGR] installs disabled; enabling runs it, its service and its settings', async () => {
    const result = await manager.install(pack());
    expect(result).toMatchObject({ ok: true, plugin: { enabled: false, state: 'stopped' } });
    expect(chatListeners).toHaveLength(0);

    await manager.setEnabled('pilab.sample', true);
    expect(sample()).toMatchObject({
      state: 'running',
      services: [{ id: 'worker', state: 'running' }],
    });
    await until(() => sample()?.status?.text === 'greeting=hi');

    manager.setSetting('pilab.sample', 'greeting', 'hello');
    await until(() => sample()?.status?.text === 'now hello');
  }, 30_000);

  it('[PLG-MGR] chat events reach the plugin with journal cursors, and the journal answers it', async () => {
    await manager.install(pack());
    await manager.setEnabled('pilab.sample', true);
    // Recording started because a running plugin holds chat.read.
    expect(chatListeners).toHaveLength(1);
    await until(() => sample()?.status?.text === 'greeting=hi');
    for (const listener of chatListeners)
      listener(event('session.status', { payload: { status: 'running' } }));
    await until(() => sample()?.status?.text === '1:running');
  }, 30_000);

  it('[PLG-MGR] plugin clients are subject to session control and audited', async () => {
    await manager.install(pack());
    await manager.setEnabled('pilab.sample', true);
    await until(() => sample()?.status?.text === 'greeting=hi');
    const registry = (manager as unknown as { deps: { sessionControl: SessionControlRegistry } })
      .deps.sessionControl;
    registry.acquireForClient('s9', { ownerId: -99, pluginId: 'other', label: 'x' });
    await until(() => audits.length === 1);
    expect(audits[0]).toMatchObject({
      pluginId: 'pilab.sample',
      channel: 'chat:send',
      sessionId: 's9',
      ok: true,
    });
    expect(invokeChat).toHaveBeenCalledWith('chat:send', expect.objectContaining({ ownerId: -1 }), [
      { sessionId: 's9', text: 'x' },
    ]);
  }, 30_000);

  it('[PLG-MGR] a crash is reported and a restart scheduled with backoff; disabling stops recording', async () => {
    await manager.install(pack());
    await manager.setEnabled('pilab.sample', true);
    await until(() => sample()?.status?.text === 'greeting=hi');
    for (const listener of chatListeners) listener(event('custom.message'));
    await until(() => sample()?.state === 'failed');
    expect(sample()?.lastError).toMatch(/PLUGIN_CRASHED/);
    expect(timers.map((t) => t.ms)).toEqual([1000]);
    // The scheduled restart brings it back.
    timers[0]?.run();
    await until(() => sample()?.state === 'running');
    expect(sample()?.restartCount).toBe(1);

    await manager.setEnabled('pilab.sample', false);
    expect(sample()).toMatchObject({ enabled: false, state: 'stopped' });
    expect(chatListeners).toHaveLength(0);
  }, 30_000);

  it('[PLG-MGR] a bad package is refused with the reason; uninstall removes the plugin', async () => {
    const bad = path.join(root, 'bad.pilabplug');
    writeFileSync(bad, 'not a zip');
    await expect(manager.install(bad)).resolves.toMatchObject({ ok: false, error: /not a zip/ });
    await manager.install(pack());
    await manager.setEnabled('pilab.sample', true);
    await manager.uninstall('pilab.sample');
    expect(manager.list()).toEqual([]);
  }, 30_000);

  it('[PLG-MGR] the example plugin in plugins/example-hello installs and runs', async () => {
    const exampleDir = path.join(process.cwd(), 'plugins', 'example-hello');
    const file = path.join(root, 'example.pilabplug');
    writeFileSync(
      file,
      writeZip(
        ['manifest.json', 'main.mjs'].map((name) => ({
          path: name,
          data: readFileSync(path.join(exampleDir, name)),
        }))
      )
    );
    await expect(manager.install(file)).resolves.toMatchObject({ ok: true });
    await manager.setEnabled('pilab.example-hello', true);
    const example = () => views.find((view) => view.id === 'pilab.example-hello');
    await until(() => example()?.status?.text === '示例: 0 个对话事件');
    for (const listener of chatListeners)
      listener(event('session.status', { payload: { status: 'idle' } }));
    await until(() => example()?.status?.text === '示例: 1 个对话事件');
  }, 30_000);
});
