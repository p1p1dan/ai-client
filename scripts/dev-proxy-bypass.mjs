/**
 * Keep `pnpm dev` alive on a machine that exports a proxy.
 *
 * Chromium proxies the renderer's own `http://localhost:5173` request when
 * `HTTP_PROXY` is set, and a proxy that cannot reach the Vite dev server just
 * stalls: the window never appears, the debug port accepts connections but
 * answers nothing, and there is no error anywhere. Confirmed on unmodified
 * committed code during the T37-d probe run.
 *
 * The bypass has to be spelled `no_proxy` in LOWER CASE — Chromium reads that
 * name and ignores `NO_PROXY`, which is why an already-exported uppercase one
 * did not help. Both are written here anyway: the uppercase spelling is what
 * Node's own fetch stack looks at, and the two disagreeing is its own trap.
 *
 * Existing entries are preserved, never replaced — a developer's own bypass
 * list is theirs.
 */

const LOOPBACK_ENTRIES = ['localhost', '127.0.0.1', '::1'];

const PROXY_VARS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
];

const NO_PROXY_VARS = ['no_proxy', 'NO_PROXY'];

function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ env: Record<string, string | undefined>, proxyVars: string[], added: string[] }}
 *   `added` is empty when nothing needed changing — either no proxy is
 *   configured, or the loopback entries were already bypassed.
 */
export function withLoopbackProxyBypass(env) {
  const proxyVars = PROXY_VARS.filter((name) => String(env[name] ?? '').trim());
  if (proxyVars.length === 0) {
    return { env, proxyVars, added: [] };
  }

  const next = { ...env };
  const added = new Set();
  for (const name of NO_PROXY_VARS) {
    const existing = splitList(next[name]);
    const missing = LOOPBACK_ENTRIES.filter(
      (entry) => !existing.some((current) => current.toLowerCase() === entry)
    );
    if (missing.length === 0) continue;
    for (const entry of missing) added.add(entry);
    next[name] = [...existing, ...missing].join(',');
  }

  return { env: next, proxyVars, added: [...added] };
}
