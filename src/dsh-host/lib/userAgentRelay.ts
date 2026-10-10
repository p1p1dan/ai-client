/**
 * dsh-rebase decision 171 (GitHub issue #7): the User-Agent relay.
 *
 * DSH owns User-Agent: `dsh-llm-pi-ai`'s `requestHeaders()` drops a route
 * header of that name and appends `deepseek-harness/<version> (+url)` last, so
 * no profile setting can change it. A route header DSH does not own reaches
 * the request untouched, so Main's plan puts the wanted value in one
 * (`X-Aiclient-User-Agent`), and this wrapper around the process's `fetch`
 * moves it into User-Agent before the request leaves:
 *
 *   relay header present  it is removed, and User-Agent becomes its value when
 *                         the value passes the shared check; otherwise DSH's
 *                         own stays (and the relay header is still removed);
 *   relay header absent   the call goes through with the very same arguments.
 *
 * Stateless: it needs neither the plan nor the provider, and an MCP server, a
 * plugin or anything else that fetches is never touched. Fetch-level, so it
 * sits above whatever undici dispatcher is installed: `dsh-http-proxy`'s
 * `setGlobalDispatcher` would replace a dispatcher interceptor (decision 157).
 *
 * host.ts installs it before the first DSH module loads. A DSH upgrade must
 * keep three things true (decision 171): route headers still reach the
 * request; pi-ai and its SDKs still read the global `fetch` for each request;
 * model requests still run on the host's main thread. When one breaks, the
 * relay header reaches the provider and DSH's User-Agent goes out — the
 * integration test's User-Agent phase fails on both.
 *
 * Loaded by Node type stripping in a source checkout: erasable syntax only.
 */

import {
  checkRequestUserAgent,
  USER_AGENT_RELAY_HEADER,
} from '../../shared/types/requestUserAgent.ts';

type Fetch = typeof globalThis.fetch;
type FetchInput = Parameters<Fetch>[0];
type FetchInit = Parameters<Fetch>[1];

/** What became of one request's relay header. */
export type UserAgentRelayOutcome = 'none' | 'relayed' | 'refused';

export interface RelayedRequest {
  /** The `init` to send: the caller's own when there was nothing to relay. */
  init: FetchInit;
  outcome: UserAgentRelayOutcome;
}

/**
 * One request's headers with the relay header moved into User-Agent. The
 * headers are `init.headers` when given, else the Request's own: Fetch lets
 * `init.headers` replace a Request's headers in the same way.
 */
export function relayUserAgent(input: FetchInput, init: FetchInit): RelayedRequest {
  const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (source === undefined) return { init, outcome: 'none' };
  let headers: Headers;
  try {
    headers = new Headers(source);
  } catch {
    // Headers Fetch would refuse anyway: let the real call report it.
    return { init, outcome: 'none' };
  }
  const wanted = headers.get(USER_AGENT_RELAY_HEADER);
  if (wanted === null) return { init, outcome: 'none' };
  headers.delete(USER_AGENT_RELAY_HEADER);
  let outcome: UserAgentRelayOutcome = 'refused';
  const checked = checkRequestUserAgent(wanted);
  if (checked.ok) {
    try {
      headers.set('user-agent', checked.value);
      outcome = 'relayed';
    } catch {
      // A value Fetch will not carry: DSH's own User-Agent stays.
    }
  }
  return { init: { ...init, headers }, outcome };
}

export interface UserAgentRelayOptions {
  /** Called once, the first time a relayed value is refused; the value is not passed. */
  onRefused?: () => void;
}

/** Marks a wrapped `fetch`, so a second install cannot wrap it twice. */
const RELAY_MARK = Symbol.for('aiclient.dsh.userAgentRelay');

/** Wraps `scope.fetch`; false when it is missing or already wrapped. */
export function installUserAgentRelay(
  scope: { fetch: Fetch } = globalThis,
  options: UserAgentRelayOptions = {}
): boolean {
  const original = scope.fetch;
  if (typeof original !== 'function' || RELAY_MARK in original) return false;
  let refusedOnce = false;
  const relayed = ((input: FetchInput, init?: FetchInit) => {
    const next = relayUserAgent(input, init);
    if (next.outcome === 'refused' && !refusedOnce) {
      refusedOnce = true;
      options.onRefused?.();
    }
    return next.outcome === 'none' ? original(input, init) : original(input, next.init);
  }) as Fetch;
  Object.defineProperty(relayed, RELAY_MARK, { value: true });
  scope.fetch = relayed;
  return true;
}
