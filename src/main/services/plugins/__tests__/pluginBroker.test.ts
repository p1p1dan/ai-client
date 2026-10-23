import type { PluginManifest } from '@shared/plugins/manifest';
import { describe, expect, it, vi } from 'vitest';
import { PluginBroker, type PluginBrokerDeps } from '../pluginBroker';

function manifest(permissions: PluginManifest['permissions']): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'pilab.sample',
    name: 'Sample',
    version: '0.1.0',
    apiVersion: 1,
    main: 'main.js',
    permissions,
    contributes: { settings: [], services: [] },
  };
}

function deps(): PluginBrokerDeps & { audits: unknown[] } {
  let owner = 0;
  const audits: unknown[] = [];
  return {
    audits,
    invokeChat: vi.fn(async (channel: string) => ({ channel })),
    snapshot: vi.fn(() => ({
      status: undefined,
      pendingPermissions: [],
      pendingQuestions: [],
      turn: [],
      turnTruncated: false,
    })),
    since: vi.fn(() => ({ entries: [] })),
    getController: vi.fn(() => ({ kind: 'desktop' as const })),
    acquireForClient: vi.fn(),
    releaseOwner: vi.fn(),
    allocateOwnerId: () => {
      owner -= 1;
      return owner;
    },
    readSettings: vi.fn(() => ({ a: 1 })),
    writeSetting: vi.fn(),
    setStatus: vi.fn(),
    setChatSubscribed: vi.fn(),
    audit: (entry) => audits.push(entry),
    now: () => 42,
  };
}

describe('PluginBroker', () => {
  it('[PLG-BROKER] runs chat calls per client, each client with its own owner id', async () => {
    const d = deps();
    const broker = new PluginBroker(manifest(['chat.read', 'chat.control']), d);
    await broker.handle('chat.invoke', ['phone', 'chat:listSessions']);
    await broker.handle('chat.invoke', ['phone', 'chat:send', { sessionId: 's1', text: 'hi' }]);
    await broker.handle('chat.invoke', ['tablet', 'chat:stop', { sessionId: 's1' }]);
    const owners = vi.mocked(d.invokeChat).mock.calls.map(([, caller]) => caller.ownerId);
    expect(owners).toEqual([-1, -1, -2]);
    expect(vi.mocked(d.invokeChat).mock.calls[0]?.[2]).toEqual([]);
    expect(vi.mocked(d.invokeChat).mock.calls[1]?.[2]).toEqual([{ sessionId: 's1', text: 'hi' }]);
    // Changes are audited, reads are not.
    expect(d.audits).toEqual([
      {
        at: 42,
        pluginId: 'pilab.sample',
        method: 'chat.invoke',
        channel: 'chat:send',
        clientId: 'phone',
        sessionId: 's1',
        ok: true,
      },
      {
        at: 42,
        pluginId: 'pilab.sample',
        method: 'chat.invoke',
        channel: 'chat:stop',
        clientId: 'tablet',
        sessionId: 's1',
        ok: true,
      },
    ]);
  });

  it('[PLG-BROKER] refuses what the manifest did not declare, and channels closed to plugins', async () => {
    const readOnly = new PluginBroker(manifest(['chat.read']), deps());
    await expect(
      readOnly.handle('chat.invoke', ['phone', 'chat:send', { sessionId: 's1' }])
    ).rejects.toThrow(/^PLUGIN_PERMISSION_DENIED/);
    await expect(
      readOnly.handle('sessionControl.acquire', ['s1', 'phone', '网页'])
    ).rejects.toThrow(/^PLUGIN_PERMISSION_DENIED/);
    await expect(
      readOnly.handle('chat.invoke', ['phone', 'chat:rewindSession', {}])
    ).rejects.toThrow(/^PLUGIN_CHANNEL_NOT_ALLOWED/);
    const none = new PluginBroker(manifest([]), deps());
    await expect(none.handle('chat.snapshot', ['s1'])).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(none.handle('chat.subscribe', [])).rejects.toThrow(/PERMISSION_DENIED/);
    // Its own settings and status need nothing.
    await expect(none.handle('settings.get', [])).resolves.toEqual({ a: 1 });
    await expect(none.handle('status.set', [{ state: 'ok' }])).resolves.toBeNull();
  });

  it('[PLG-BROKER] a failed change is audited with its error', async () => {
    const d = deps();
    vi.mocked(d.invokeChat).mockRejectedValueOnce(new Error('session_controlled_elsewhere: no'));
    const broker = new PluginBroker(manifest(['chat.control']), d);
    await expect(
      broker.handle('chat.invoke', ['phone', 'chat:send', { sessionId: 's1' }])
    ).rejects.toThrow(/session_controlled_elsewhere/);
    expect(d.audits).toEqual([
      expect.objectContaining({ ok: false, error: 'session_controlled_elsewhere: no' }),
    ]);
  });

  it('[PLG-BROKER] acquire takes control under the client owner id; releasing a client ends it all', async () => {
    const d = deps();
    const broker = new PluginBroker(manifest(['chat.read', 'chat.control']), d);
    await broker.handle('sessionControl.acquire', ['s1', 'phone', '网页 · iPhone']);
    expect(d.acquireForClient).toHaveBeenCalledWith('s1', {
      ownerId: -1,
      pluginId: 'pilab.sample',
      label: '网页 · iPhone',
    });
    const gone = vi.fn();
    await broker.handle('chat.invoke', ['phone', 'chat:send', { sessionId: 's1' }]);
    vi.mocked(d.invokeChat).mock.calls[0]?.[1].onGone?.(gone);
    await broker.handle('chat.releaseClient', ['phone']);
    expect(d.releaseOwner).toHaveBeenCalledWith(-1);
    expect(gone).toHaveBeenCalledTimes(1);
    // A new connection under the same name is a new client.
    await broker.handle('chat.invoke', ['phone', 'chat:listSessions']);
    expect(vi.mocked(d.invokeChat).mock.calls.at(-1)?.[1].ownerId).toBe(-2);
    broker.releaseAllClients();
    expect(d.releaseOwner).toHaveBeenLastCalledWith(-2);
  });

  it('[PLG-BROKER] checks arguments', async () => {
    const broker = new PluginBroker(manifest(['chat.read', 'chat.control']), deps());
    await expect(broker.handle('chat.since', [-1])).rejects.toThrow(/PLUGIN_INVALID_ARGS/);
    await expect(broker.handle('chat.since', [1.5])).rejects.toThrow(/PLUGIN_INVALID_ARGS/);
    await expect(broker.handle('chat.invoke', ['', 'chat:listSessions'])).rejects.toThrow(
      /PLUGIN_INVALID_ARGS/
    );
    await expect(broker.handle('status.set', [{ state: 'great' }])).rejects.toThrow(
      /PLUGIN_INVALID_ARGS/
    );
    await expect(
      broker.handle('sessionControl.acquire', ['s1', 'phone', 'x'.repeat(65)])
    ).rejects.toThrow(/PLUGIN_INVALID_ARGS/);
  });
});
