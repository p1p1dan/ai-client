import { type HostProxySetting, sameHostProxy } from '@shared/hostProxy';
import type { ProxySettings } from '@shared/types';
import type { Session } from 'electron';
import { session } from 'electron';

let currentProxySettings: ProxySettings | null = null;
let updaterSession: Session | null = null;

/**
 * Decision 196 rule 10: `0` keeps both chat engines off the product proxy —
 * no host is handed it, which is the behaviour before decision 196. Read by
 * Main only.
 */
export const ENGINE_PROXY_SWITCH_ENV = 'AICLIENT_RUNTIME_ENGINE_PROXY';

type EngineProxyListener = (setting: HostProxySetting | null) => void;
const engineProxyListeners = new Set<EngineProxyListener>();
/**
 * The address field calls `applyProxy` per keystroke: a change reaches the
 * hosts once the setting has been still this long.
 */
export const ENGINE_PROXY_SETTLE_MS = 500;
/** What the listeners were last told (or what the saved settings said at startup). */
let announcedEngineProxy: HostProxySetting | null = null;
let announceTimer: NodeJS.Timeout | null = null;

function normalizeProxyUrl(url: string): string {
  if (/^(https?|socks5?h?|socks4a?):\/\//.test(url)) {
    return url;
  }
  return `http://${url}`;
}

function normalizeBypassList(bypassList: string): string {
  return bypassList
    .split(',')
    .map((s) => s.trim())
    .map((s) => s.replace(/^\*\./, '.')) // *.domain → .domain (Chromium format)
    .filter(Boolean)
    .join(',');
}

export function registerUpdaterSession(s: Session): void {
  updaterSession = s;
}

/**
 * Issue #10: the check for updates runs on a session of its own, and without
 * 「更新也走代理」 it follows the SYSTEM proxy (`applyProxy` above). A proxy that
 * the OS still points at but which is no longer running — the ordinary state
 * of affairs on Windows after a proxy client is closed — makes the check fail
 * with `ERR_PROXY_CONNECTION_FAILED` and retry never crosses the wire again,
 * so the user sees a permanent 「检查失败」.
 *
 * Switching that one session to `direct` for the retry is deliberately a
 * separate step: the default path must stay exactly as it was, and only the
 * failure that says "the proxy is the problem" may take it. The model-catalog
 * sync does NOT need this — with the in-app proxy switch off it is already
 * direct (issue #12's ruling).
 */
export async function applyDirectUpdaterProxy(): Promise<void> {
  await updaterSession?.setProxy({ mode: 'direct' });
}

/**
 * Whether an error says the configured/system proxy could not be reached,
 * rather than the remote being unreachable or the request failing on its own.
 *
 * Chromium reports this as `net::ERR_PROXY_CONNECTION_FAILED`; socks proxies
 * that refuse the connection surface as `ERR_SOCKS_CONNECTION_FAILED`, and
 * electron-updater wraps either in its own Error, so this reads the message
 * rather than a typed field. Matching is case-insensitive because the wrapped
 * text's casing is not ours to choose.
 */
export function isProxyConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /ERR_(PROXY|SOCKS)_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/i.test(message);
}

export function getProxyEnvVars(): Record<string, string> {
  if (!currentProxySettings?.enabled || !currentProxySettings.server) {
    return {};
  }

  const proxyUrl = normalizeProxyUrl(currentProxySettings.server);

  const noProxy = normalizeBypassList(currentProxySettings.bypassList || 'localhost,127.0.0.1');

  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

/**
 * Decision 196: what the chat engines route model requests through for
 * `settings` — the product proxy, or `null` when it is off. A pure function
 * of the settings (the switch is read by `getEngineProxySetting`).
 */
export function engineProxyFrom(
  settings: ProxySettings | null | undefined
): HostProxySetting | null {
  const server = settings?.server?.trim();
  if (!settings?.enabled || !server) return null;
  return {
    url: normalizeProxyUrl(server),
    noProxy: normalizeBypassList(settings.bypassList || 'localhost,127.0.0.1'),
  };
}

/**
 * The setting every engine host is handed now: the product proxy, `null`
 * when it is off, or `undefined` when `AICLIENT_RUNTIME_ENGINE_PROXY=0` keeps
 * the engines off it (the hosts then get no `proxy` field at all).
 */
export function getEngineProxySetting(
  env: NodeJS.ProcessEnv = process.env
): HostProxySetting | null | undefined {
  if (env[ENGINE_PROXY_SWITCH_ENV]?.trim() === '0') return undefined;
  return engineProxyFrom(currentProxySettings);
}

/**
 * Called when the engines' setting has changed and stayed put for
 * `ENGINE_PROXY_SETTLE_MS` — not on every settings write (switching
 * 「代理更新」 changes nothing the engines use). Never while the switch is off.
 */
export function onEngineProxyChange(listener: EngineProxyListener): () => void {
  engineProxyListeners.add(listener);
  return () => engineProxyListeners.delete(listener);
}

function scheduleEngineProxyAnnouncement(): void {
  if (announceTimer) clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    announceTimer = null;
    const setting = getEngineProxySetting();
    if (setting === undefined || sameHostProxy(setting, announcedEngineProxy)) return;
    announcedEngineProxy = setting;
    for (const listener of engineProxyListeners) {
      try {
        listener(setting);
      } catch (error) {
        console.error('[proxy] an engine proxy listener failed:', error);
      }
    }
  }, ENGINE_PROXY_SETTLE_MS);
  announceTimer.unref?.();
}

/**
 * Takes the saved settings before any engine host can start (decision 196
 * rule 6): the renderer applies them only once its store is restored, and a
 * host may be prewarmed earlier. Nothing is announced, and the sessions are
 * left to the renderer's own `applyProxy`.
 */
export function seedProxySettings(settings: ProxySettings | null | undefined): void {
  if (currentProxySettings !== null || !settings) return;
  currentProxySettings = settings;
  announcedEngineProxy = engineProxyFrom(settings);
}

export async function applyProxy(settings: ProxySettings): Promise<void> {
  currentProxySettings = settings;
  scheduleEngineProxyAnnouncement();

  const proxyConfig =
    settings.enabled && settings.server
      ? {
          proxyRules: normalizeProxyUrl(settings.server),
          proxyBypassRules: normalizeBypassList(settings.bypassList || 'localhost,127.0.0.1'),
        }
      : { mode: 'direct' as const };

  await session.defaultSession.setProxy(proxyConfig);

  if (updaterSession) {
    const useProxy = settings.enabled && settings.useProxyForUpdates && settings.server;
    await updaterSession.setProxy(useProxy ? proxyConfig : { mode: 'system' });
  }
}

const TEST_URLS = [
  'https://cp.cloudflare.com',
  'https://www.google.com/generate_204',
  'https://www.gstatic.com/generate_204',
];

const TEST_SESSION_PARTITION = 'proxy-test';

export async function testProxy(
  proxyUrl: string
): Promise<{ success: boolean; latency?: number; error?: string }> {
  const testSession = session.fromPartition(TEST_SESSION_PARTITION);

  try {
    await testSession.setProxy({ proxyRules: normalizeProxyUrl(proxyUrl), proxyBypassRules: '' });

    for (const testUrl of TEST_URLS) {
      try {
        const startTime = Date.now();
        const response = await testSession.fetch(testUrl, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        });
        const latency = Date.now() - startTime;

        if (response.ok || response.status === 204) {
          return { success: true, latency };
        }
      } catch {
        // Try next URL
      }
    }

    return { success: false, error: 'All test endpoints failed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  } finally {
    await testSession.clearCache();
    await testSession.clearStorageData();
  }
}
