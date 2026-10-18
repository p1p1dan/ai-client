/**
 * Decision 196: the product proxy on the DSH host.
 *
 * Main hands the setting over IPC: inside `configure`, then as
 * `{ host: 'proxy', proxy }` whenever it changes. The installer applies it
 * with DSH's own `installProxyFromEnvironment` (decision 090), which puts one
 * policy behind undici's global dispatcher — every model request, one-shot
 * completion, MCP over HTTP and web fetch of this process — and publishes it
 * to every child `dsh-subprocess` spawns. A change takes effect at once:
 * the previous installation is disposed (requests already sent finish on
 * it) and the new one installed; no restart.
 *
 * The policy is read from the setting alone, never from the launch
 * environment's `HTTP(S)_PROXY` (decision 157 option C), except that the
 * launch environment's own `NO_PROXY` stays a bypass (rule 8). A SOCKS or
 * unusable URL is refused by DSH with a diagnostic naming only the variable;
 * this module adds its own line, also without the URL.
 *
 * Loaded by Node type stripping in a source checkout: erasable syntax only.
 */

import {
  describeHostProxy,
  effectiveNoProxy,
  type HostProxySetting,
  readHostProxySetting,
  sameHostProxy,
} from '../../shared/hostProxy.ts';

/** The one thing DSH's resolver needs from an environment (`EnvLookup` in dsh-http-proxy). */
export interface ProxyEnvLookup {
  get(name: string): { readonly value: string } | undefined;
}

export type InstallProxy = (
  env: ProxyEnvLookup,
  report: (message: string) => void
) => Promise<() => Promise<void>>;

/** Main's control message carrying a changed setting. */
export function isHostProxyMessage(message: unknown): message is { host: 'proxy'; proxy: unknown } {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { host?: unknown }).host === 'proxy'
  );
}

/**
 * The environment DSH's resolver reads for `setting`: both schemes through
 * its URL, and the effective bypass list. Nothing else: an `all_proxy` or
 * upper-case name from the launch environment is not consulted.
 */
export function proxyLookupFor(
  setting: HostProxySetting,
  inheritedNoProxy: string | undefined
): ProxyEnvLookup {
  const values: Record<string, string> = {
    http_proxy: setting.url,
    https_proxy: setting.url,
    no_proxy: effectiveNoProxy(setting, inheritedNoProxy),
  };
  return {
    get: (name) => (Object.hasOwn(values, name) ? { value: values[name] } : undefined),
  };
}

export interface HostProxyInstallerOptions {
  /** Loads `installProxyFromEnvironment` on first use. */
  install: () => Promise<InstallProxy>;
  /** The launch environment's `NO_PROXY`, read before the first install rewrites it. */
  inheritedNoProxy: string | undefined;
  log: (line: string) => void;
  warn: (line: string) => void;
}

/**
 * Applies the latest setting, one installation at a time. `update` may be
 * called any number of times; each queued run installs whatever is latest
 * then, so a burst of changes ends on the last one and an unchanged setting
 * is never reinstalled.
 */
export class HostProxyInstaller {
  private latest: HostProxySetting | null = null;
  private applied: HostProxySetting | null = null;
  private dispose: (() => Promise<void>) | undefined;
  /** The first run always reports, so the log says "off" too. */
  private reported = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly options: HostProxyInstallerOptions;

  constructor(options: HostProxyInstallerOptions) {
    this.options = options;
  }

  /** Takes a raw `proxy` value from Main; a malformed one counts as off. */
  update(raw: unknown): Promise<void> {
    const setting = readHostProxySetting(raw);
    if (setting === undefined) {
      this.options.warn(
        'a malformed outbound proxy setting was ignored; model requests connect directly'
      );
    }
    this.latest = setting ?? null;
    this.chain = this.chain.then(() => this.applyLatest());
    return this.chain;
  }

  /** Resolves once every update so far has been applied. */
  settled(): Promise<void> {
    return this.chain;
  }

  private async applyLatest(): Promise<void> {
    const next = this.latest;
    if (this.reported && sameHostProxy(next, this.applied)) return;
    this.reported = true;
    try {
      if (this.dispose) {
        const dispose = this.dispose;
        this.dispose = undefined;
        this.applied = null;
        await dispose();
      }
      if (next) {
        const install = await this.options.install();
        this.dispose = await install(
          proxyLookupFor(next, this.options.inheritedNoProxy),
          (message) => this.options.warn(`outbound proxy: ${message}`)
        );
        this.applied = next;
      }
      this.options.log(`outbound proxy: ${describeHostProxy(next, this.options.inheritedNoProxy)}`);
    } catch (error) {
      // The name and code only: a message may quote the URL.
      const code = (error as { code?: unknown } | null)?.code;
      this.options.warn(
        `outbound proxy could not be applied; model requests connect directly (${error instanceof Error ? error.name : 'error'}${typeof code === 'string' ? ` ${code}` : ''})`
      );
    }
  }
}
