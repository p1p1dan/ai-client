import type { ProxySettings } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Decision 196: what Main hands the chat engines from Settings · Network, and
 * when it tells them about a change. Electron's sessions are stubbed; the
 * module keeps state, so each test loads it afresh.
 */

const setProxy = vi.fn(async () => undefined);
vi.mock('electron', () => ({ session: { defaultSession: { setProxy } } }));

const OFF: ProxySettings = {
  enabled: false,
  server: '',
  bypassList: 'localhost,127.0.0.1',
  useProxyForUpdates: false,
};
const ON: ProxySettings = { ...OFF, enabled: true, server: '127.0.0.1:7897' };

async function load() {
  vi.resetModules();
  return import('../ProxyConfig');
}

beforeEach(() => {
  vi.useFakeTimers();
  setProxy.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('engineProxyFrom', () => {
  it('is null while the product proxy is off or has no server', async () => {
    const { engineProxyFrom } = await load();
    expect(engineProxyFrom(null)).toBeNull();
    expect(engineProxyFrom(OFF)).toBeNull();
    expect(engineProxyFrom({ ...OFF, server: 'http://p:1' })).toBeNull();
    expect(engineProxyFrom({ ...ON, server: '   ' })).toBeNull();
  });

  it('gives a bare host:port a scheme and keeps the rest as the user wrote it', async () => {
    const { engineProxyFrom } = await load();
    expect(engineProxyFrom(ON)).toEqual({
      url: 'http://127.0.0.1:7897',
      noProxy: 'localhost,127.0.0.1',
    });
    expect(engineProxyFrom({ ...ON, server: ' socks5://127.0.0.1:1080 ' })?.url).toBe(
      'socks5://127.0.0.1:1080'
    );
    expect(engineProxyFrom({ ...ON, server: 'http://u:p@proxy:8080' })?.url).toBe(
      'http://u:p@proxy:8080'
    );
    expect(engineProxyFrom({ ...ON, bypassList: ' *.corp , ,intra ' })?.noProxy).toBe(
      '.corp,intra'
    );
    expect(engineProxyFrom({ ...ON, bypassList: '' })?.noProxy).toBe('localhost,127.0.0.1');
  });
});

describe('getEngineProxySetting', () => {
  it('follows the settings, and is undefined while AICLIENT_RUNTIME_ENGINE_PROXY=0', async () => {
    const { applyProxy, getEngineProxySetting } = await load();
    expect(getEngineProxySetting()).toBeNull();
    await applyProxy(ON);
    expect(getEngineProxySetting()).toEqual({
      url: 'http://127.0.0.1:7897',
      noProxy: 'localhost,127.0.0.1',
    });
    expect(getEngineProxySetting({ AICLIENT_RUNTIME_ENGINE_PROXY: '0' })).toBeUndefined();
    expect(getEngineProxySetting({ AICLIENT_RUNTIME_ENGINE_PROXY: '1' })).not.toBeUndefined();
  });

  it('reads the saved settings before the renderer applies them', async () => {
    const { getEngineProxySetting, seedProxySettings } = await load();
    seedProxySettings(ON);
    expect(getEngineProxySetting()?.url).toBe('http://127.0.0.1:7897');
    // Only the first seed counts, and never over what the renderer applied.
    seedProxySettings(OFF);
    expect(getEngineProxySetting()?.url).toBe('http://127.0.0.1:7897');
    expect(setProxy).not.toHaveBeenCalled();
  });
});

describe('onEngineProxyChange', () => {
  it('announces a change once it has settled, with the latest value', async () => {
    const { applyProxy, ENGINE_PROXY_SETTLE_MS, onEngineProxyChange } = await load();
    const seen: unknown[] = [];
    onEngineProxyChange((setting) => seen.push(setting));
    // Typing the address: one call per keystroke.
    for (const server of ['1', '12', '127.0.0.1:7897']) await applyProxy({ ...ON, server });
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(ENGINE_PROXY_SETTLE_MS);
    expect(seen).toEqual([{ url: 'http://127.0.0.1:7897', noProxy: 'localhost,127.0.0.1' }]);
    await applyProxy(OFF);
    vi.advanceTimersByTime(ENGINE_PROXY_SETTLE_MS);
    expect(seen.at(-1)).toBeNull();
    expect(seen).toHaveLength(2);
  });

  it('stays quiet when nothing the engines use changed', async () => {
    const { applyProxy, ENGINE_PROXY_SETTLE_MS, onEngineProxyChange, seedProxySettings } =
      await load();
    seedProxySettings(ON);
    const seen: unknown[] = [];
    onEngineProxyChange((setting) => seen.push(setting));
    // The renderer restoring the same settings, then 「代理更新」 flipped.
    await applyProxy(ON);
    await applyProxy({ ...ON, useProxyForUpdates: true });
    // Off stays off whatever the address says.
    await applyProxy({ ...OFF, server: 'proxy:1' });
    await applyProxy({ ...OFF, server: 'proxy:2' });
    vi.advanceTimersByTime(ENGINE_PROXY_SETTLE_MS);
    expect(seen).toEqual([null]);
  });

  it('never announces while AICLIENT_RUNTIME_ENGINE_PROXY=0', async () => {
    vi.stubEnv('AICLIENT_RUNTIME_ENGINE_PROXY', '0');
    const { applyProxy, ENGINE_PROXY_SETTLE_MS, onEngineProxyChange } = await load();
    const listener = vi.fn();
    onEngineProxyChange(listener);
    await applyProxy(ON);
    vi.advanceTimersByTime(ENGINE_PROXY_SETTLE_MS);
    expect(listener).not.toHaveBeenCalled();
  });

  it('a failing listener does not stop the others', async () => {
    const { applyProxy, ENGINE_PROXY_SETTLE_MS, onEngineProxyChange } = await load();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const after = vi.fn();
    onEngineProxyChange(() => {
      throw new Error('boom');
    });
    const off = onEngineProxyChange(after);
    await applyProxy(ON);
    vi.advanceTimersByTime(ENGINE_PROXY_SETTLE_MS);
    expect(after).toHaveBeenCalledTimes(1);
    off();
    await applyProxy(OFF);
    vi.advanceTimersByTime(ENGINE_PROXY_SETTLE_MS);
    expect(after).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
