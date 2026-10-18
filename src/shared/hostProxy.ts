/**
 * Decision 195: the product proxy (Settings · Network) as Main hands it to an
 * engine host, and the pure rules both hosts apply to it.
 *
 * Main sends it over IPC only — inside the DSH host's `configure` and the SDK
 * host's `host.secret`, then once per change — never as a launch variable or
 * a command-line argument: the URL may carry credentials
 * (`http://user:pass@proxy:8080`). Nothing below ever puts the URL into a
 * description.
 *
 * Shared by Main, the DSH host (loaded under Node's type stripping in a
 * checkout, bundled when packaged) and the SDK host: erasable syntax only, and
 * no imports.
 */

export interface HostProxySetting {
  /** The proxy URL, scheme included (Main writes a bare `host:port` as `http://host:port`). */
  url: string;
  /** The settings page's bypass list, comma-separated, `*.example.com` already written `.example.com`. */
  noProxy: string;
}

/** What a host can do with a proxy URL: route through it (`http:` / `https:`), or not. */
export type HostProxyKind = 'http' | 'socks' | 'invalid';

/**
 * Hosts that never go through the proxy. DSH bypasses loopback on its own;
 * Node's `http.Agent({ proxyEnv })` does not (measured), so the SDK host adds
 * these itself. `::1` and `[::1]` both, as DSH lists them.
 */
export const LOOPBACK_NO_PROXY: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** The proxy names whose values a child reads, lower-case first (curl and undici read that one first). */
const SCHEME_NAMES = {
  http: ['http_proxy', 'HTTP_PROXY'],
  https: ['https_proxy', 'HTTPS_PROXY'],
} as const;
const NO_PROXY_NAMES = ['no_proxy', 'NO_PROXY'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The setting a message carries: the setting, `null` (the product proxy is
 * off), or `undefined` when the value is malformed (the host treats that as
 * off and says so).
 */
export function readHostProxySetting(value: unknown): HostProxySetting | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { url, noProxy } = value;
  if (typeof url !== 'string' || url.trim() === '' || typeof noProxy !== 'string') return undefined;
  return { url: url.trim(), noProxy };
}

export function hostProxyKind(url: string): HostProxyKind {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid';
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return parsed.hostname ? 'http' : 'invalid';
  }
  return parsed.protocol.startsWith('socks') ? 'socks' : 'invalid';
}

/** Whether two settings route alike (both off counts as alike). */
export function sameHostProxy(
  a: HostProxySetting | null | undefined,
  b: HostProxySetting | null | undefined
): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null);
  return a.url === b.url && a.noProxy === b.noProxy;
}

/** Comma lists joined, entries trimmed, empties and case-insensitive repeats dropped, first spelling kept. */
export function mergeNoProxy(
  ...lists: ReadonlyArray<string | readonly string[] | undefined>
): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    if (list === undefined) continue;
    const entries = typeof list === 'string' ? list.split(',') : list;
    for (const raw of entries) {
      const entry = raw.trim();
      const key = entry.toLowerCase();
      if (!entry || seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged.join(',');
}

/**
 * Decision 195 rule 8: the settings page's list, then the launch
 * environment's own `NO_PROXY` (an exception IT wrote stays one), then
 * loopback.
 */
export function effectiveNoProxy(setting: HostProxySetting, inheritedNoProxy?: string): string {
  return mergeNoProxy(setting.noProxy, inheritedNoProxy, LOOPBACK_NO_PROXY);
}

/** `name`'s value in `env`, the exact spelling first, then any case (Windows names are case-insensitive). */
export function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && value !== undefined) return value;
  }
  return undefined;
}

/** The launch environment's `NO_PROXY`, lower-case spelling first; blank counts as unset. */
export function inheritedNoProxy(
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  for (const name of NO_PROXY_NAMES) {
    const value = envValue(env, name);
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}

/**
 * One log line for a setting: on or off, the scheme and how many bypass
 * entries — never the address, never a credential.
 */
export function describeHostProxy(setting: HostProxySetting | null, inherited?: string): string {
  if (!setting) return 'off';
  const kind = hostProxyKind(setting.url);
  if (kind === 'socks') {
    return 'not used: the product proxy is a SOCKS proxy, which model requests cannot use; they connect directly';
  }
  if (kind === 'invalid') {
    return 'not used: the product proxy is not a valid http(s) URL; model requests connect directly';
  }
  const scheme = setting.url.trim().toLowerCase().startsWith('https:') ? 'https' : 'http';
  const bypass = effectiveNoProxy(setting, inherited).split(',').filter(Boolean).length;
  return `on (${scheme} proxy; ${bypass} bypass entries)`;
}

/**
 * The SDK host's upstream leg (decision 195 rule 1): Node's
 * `http.Agent({ proxyEnv })` for this setting, or `undefined` for a direct
 * connection (off, SOCKS, or an address no host can use).
 */
export function upstreamProxyEnv(
  setting: HostProxySetting | null,
  inherited?: string
): Record<string, string> | undefined {
  if (!setting || hostProxyKind(setting.url) !== 'http') return undefined;
  return {
    HTTP_PROXY: setting.url,
    HTTPS_PROXY: setting.url,
    NO_PROXY: effectiveNoProxy(setting, inherited),
  };
}

/**
 * Decision 195 rule 7, for a child the host builds the environment of (the
 * SDK engine's CLI): DSH's own child rule (`proxyEnvironmentForChild`). A
 * scheme the launch environment named in either casing keeps that value; one
 * it did not gets the product proxy; the bypass list is always the effective
 * one; Node children get `NODE_USE_ENV_PROXY=1` unless a value they would
 * read is not an http(s) URL (Node refuses to start on one). Empty when the
 * product proxy is off or unusable: the child keeps what it inherited.
 */
export function childProxyOverlay(
  inherited: Readonly<Record<string, string | undefined>>,
  setting: HostProxySetting | null
): Record<string, string> {
  if (!setting || hostProxyKind(setting.url) !== 'http') return {};
  const overlay: Record<string, string> = {};
  const seen: string[] = [];
  for (const names of Object.values(SCHEME_NAMES)) {
    const own = names
      .map((name) => envValue(inherited, name))
      .find((value) => value !== undefined && value.trim() !== '');
    for (const name of names) overlay[name] = own ?? setting.url;
    seen.push(own ?? setting.url);
  }
  const noProxy = effectiveNoProxy(setting, inheritedNoProxy(inherited));
  for (const name of NO_PROXY_NAMES) overlay[name] = noProxy;
  if (seen.every((value) => hostProxyKind(value) === 'http')) overlay.NODE_USE_ENV_PROXY = '1';
  return overlay;
}

/**
 * Strings a host blanks out of its log lines on top of the shared
 * redaction (which already removes `user:pass@` from URLs): the whole URL,
 * and the password as written and decoded when it is long enough not to
 * blank out ordinary words.
 */
export function hostProxySecrets(setting: HostProxySetting | null | undefined): string[] {
  if (!setting) return [];
  let parsed: URL;
  try {
    parsed = new URL(setting.url);
  } catch {
    return [setting.url];
  }
  if (!parsed.username && !parsed.password) return [];
  const secrets = new Set<string>([setting.url]);
  for (const value of [parsed.password, safeDecode(parsed.password)]) {
    if (value.length >= 6) secrets.add(value);
  }
  return [...secrets];
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
