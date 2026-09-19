/**
 * The process-wide HTTP idle timeouts every provider request runs under
 * (decision 029, T093).
 *
 * ## Why a global dispatcher and not a per-request option
 *
 * "No first byte for two minutes" and "the stream stopped mid-answer" are
 * transport facts. No SDK option expresses them: the Anthropic and OpenAI SDKs
 * take one `timeout` that bounds the WHOLE request, which is the wrong shape for
 * streaming — a long, healthy answer and a socket that died look identical to
 * it. Node's `fetch` is undici underneath, and undici does have the two knobs:
 * `headersTimeout` (nothing came back at all) and `bodyTimeout` (the stream went
 * quiet). Setting them costs one global dispatcher.
 *
 * Ported from pi's own CLI (`@earendil-works/pi-coding-agent`,
 * `dist/core/http-dispatcher.js`), which is where the shape, the
 * `autoSelectFamilyAttemptTimeout` bump and the error-listener workaround below
 * all come from. Two deliberate differences:
 *
 * 1. **`Agent`, not `EnvHttpProxyAgent`.** pi's choice makes `HTTP_PROXY` /
 *    `HTTPS_PROXY` start applying to provider traffic, because Node's own
 *    `fetch` ignores those variables. That is a real feature and a real
 *    behaviour change, and T093 is about timeouts — a user whose shell exports a
 *    proxy for other tools must not silently have this app's provider traffic
 *    rerouted as a side effect of a timeout fix. Proxy support is its own
 *    decision to take on purpose.
 * 2. **Installed on demand, not at module load.** The value is a per-install
 *    setting that reaches this process in the bootstrap payload, so the call
 *    site is `createRuntime`. A graph that does not ask for a timeout leaves the
 *    process's HTTP stack alone, which is what keeps the fixed probe lanes and
 *    the unit suite free of a global side effect.
 *
 * ## The error listener is load-bearing, not defensive
 *
 * undici emits an internal `error` on the `Client` when it tears down a fetch
 * body mid-stream — which is exactly what `bodyTimeout` now does on purpose.
 * `EventEmitter` treats an unhandled `error` as a throw, so without the listener
 * the first idle stream this feature cuts would take the worker process down
 * with it. The body still rejects through its reader, which is how the failure
 * reaches `providerRetry` as a normal retriable error.
 */

import { EventEmitter } from 'node:events';
import { PROVIDER_IDLE_TIMEOUT_DISABLED } from '../../shared/types/providerTimeout.ts';

/**
 * Node's default is 250 ms, which terminates valid connection attempts on
 * high-latency routes. pi raised it for the same reason.
 */
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

/** The slice of undici this module uses, named so a test can stand it in. */
export interface UndiciModule {
  Agent: new (options: Record<string, unknown>) => unknown;
  Client: new (origin: unknown, options?: Record<string, unknown>) => unknown;
  Pool: new (origin: unknown, options?: Record<string, unknown>) => unknown;
  setGlobalDispatcher: (dispatcher: unknown) => void;
  install?: () => void;
}

export interface ConfigureHttpDispatcherOptions {
  /** Injectable for tests; production resolves the real package. */
  load?: () => Promise<UndiciModule>;
  /** Where a failure to install is reported. Silence is not an option here. */
  log?: (message: string, ...args: unknown[]) => void;
}

/** The timeout currently installed, or undefined when nothing was installed. */
let installedTimeoutMs: number | undefined;

export function installedProviderIdleTimeoutMs(): number | undefined {
  return installedTimeoutMs;
}

/** Test-only: forget what this process installed. */
export function resetProviderHttpDispatcher(): void {
  installedTimeoutMs = undefined;
}

function ignoreDispatcherError(): void {
  // See the module note: the body's own reader is what reports the failure.
}

function withErrorListener<T>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, 'error', ignoreDispatcherError);
  }
  return dispatcher;
}

/**
 * Install the global dispatcher for this process.
 *
 * `idleTimeoutMs` is the user's number in milliseconds; `0` disables both
 * timeouts, which is what undici itself means by 0. The SDK's per-request
 * timeout takes a different spelling of "off" — see
 * `PROVIDER_TIMEOUT_DISABLED_SENTINEL`.
 *
 * Returns whether a dispatcher was installed. A missing `undici` is reported
 * and survived rather than thrown: losing the idle timeout is a degradation
 * (back to the SDK wall clock this feature replaces), while refusing to boot
 * over it would cost the user the whole session.
 */
export async function configureProviderHttpDispatcher(
  idleTimeoutMs: number,
  options: ConfigureHttpDispatcherOptions = {}
): Promise<boolean> {
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 0) {
    throw new TypeError(
      `provider idle timeout must be a whole millisecond count: ${idleTimeoutMs}`
    );
  }
  // Re-installing the same value would build a second connection pool and
  // strand the first one's keep-alive sockets for no behaviour change.
  if (installedTimeoutMs === idleTimeoutMs) return true;
  let undici: UndiciModule;
  try {
    undici = options.load ? await options.load() : ((await import('undici')) as UndiciModule);
  } catch (error) {
    options.log?.(
      '[runtime] provider idle timeout is not enforced: undici could not be loaded',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
  // undici reads 0 as "disabled", which is the same thing the setting means.
  const timeout = idleTimeoutMs === PROVIDER_IDLE_TIMEOUT_DISABLED ? 0 : idleTimeoutMs;
  const clientFactory = (origin: unknown, clientOptions?: Record<string, unknown>) =>
    withErrorListener(new undici.Client(origin, clientOptions));
  const dispatcher = withErrorListener(
    new undici.Agent({
      allowH2: false,
      headersTimeout: timeout,
      bodyTimeout: timeout,
      connect: { autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS },
      // Every origin pool and every client under it gets the listener, because
      // the mid-stream teardown is emitted on the CLIENT, not on the agent.
      factory: (origin: unknown, poolOptions?: Record<string, unknown>) =>
        poolOptions?.connections === 1
          ? clientFactory(origin, poolOptions)
          : withErrorListener(new undici.Pool(origin, { ...poolOptions, factory: clientFactory })),
    })
  );
  undici.setGlobalDispatcher(dispatcher);
  installedTimeoutMs = idleTimeoutMs;
  return true;
}
