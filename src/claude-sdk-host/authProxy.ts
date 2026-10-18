/**
 * Route B S-3 (plan topic s3-project-config.md K-1..K-4, user ruling 12): the
 * gateway key never enters the CLI's environment, so neither the Bash tool nor
 * a repository's hooks can read it.
 *
 * The host listens on loopback for its one chat. The CLI's base URL is this
 * proxy and its "API key" a token minted per CLI process; a request carrying
 * the token goes on to the gateway with the real key, streamed both ways. A
 * tool process that reads the token can still reach the gateway through here
 * while the chat lives (measured), so only the paths the CLI uses are open.
 *
 * Dsh-rebase decision 195: the leg to the gateway goes through the product
 * proxy (Settings · Network) when Main hands one over, directly when the
 * product proxy is off, and switches at once when it changes (`setProxy`);
 * requests already under way finish on the route they started on.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  describeHostProxy,
  type HostProxySetting,
  sameHostProxy,
  upstreamProxyEnv,
} from '../shared/hostProxy.ts';

type Log = (...args: unknown[]) => void;

export interface AuthProxyOptions {
  /** The plan route's base URL (may carry a path prefix). */
  upstream: string;
  apiKey: string;
  log?: Log;
  /** Tests only: the upstream agent, fixed (`setProxy` leaves it). Default: see `proxy`. */
  agent?: http.Agent;
  /**
   * Decision 195: the product proxy for the leg to the gateway (`null`: off,
   * direct). Undefined when Main keeps the engines off it (rule 10): the leg
   * then honours this process's HTTP(S)_PROXY / NO_PROXY, as S-3 K-3 had it.
   */
  proxy?: HostProxySetting | null;
  /** The launch environment's NO_PROXY, still a bypass under the product proxy (rule 8). */
  inheritedNoProxy?: string;
}

export interface AuthProxy {
  /** `http://127.0.0.1:<port>`, the CLI's ANTHROPIC_BASE_URL. */
  readonly url: string;
  /** What the CLI sends as its key. Never the gateway key. */
  readonly token: string;
  /** Decision 195: later requests go through `setting` (`null`: direct). */
  setProxy(setting: HostProxySetting | null): void;
  close(): Promise<void>;
}

/** The token a CLI process gets: random, recognisable in a leak, worthless off this host. */
export function mintSessionToken(): string {
  return `sk-pilab-session-${randomBytes(24).toString('hex')}`;
}

/**
 * K-2: what the CLI sends through its base URL with an API key (2.1.300): the
 * conversation, token counts and the model checks of a switch. Anything else
 * (files, batches, the first-party endpoints) is not forwarded.
 */
export function proxiedRoute(method: string | undefined, url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0] ?? '';
  if (method === 'POST') return path === '/v1/messages' || path === '/v1/messages/count_tokens';
  if (method === 'GET') return path === '/v1/models' || /^\/v1\/models\/[^/]+$/.test(path);
  return false;
}

/** Hop-by-hop headers and the credentials this proxy replaces. */
const DROPPED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'x-api-key',
  'authorization',
]);

function sameToken(sent: string | undefined, token: string): boolean {
  if (!sent) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token the CLI sent: `x-api-key`, or a Bearer token. */
function sentToken(req: http.IncomingMessage): string | undefined {
  const key = req.headers['x-api-key'];
  if (typeof key === 'string') return key;
  const auth = req.headers.authorization;
  return typeof auth === 'string' ? auth.replace(/^bearer\s+/i, '') : undefined;
}

/** An Anthropic-format error, the shape the CLI and `failureMapping` read. */
function refuse(
  res: http.ServerResponse,
  status: number,
  type: string,
  message: string,
  retry: boolean
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(retry ? {} : { 'x-should-retry': 'false' }),
  });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

/**
 * The leg's agent. `proxyEnv` undefined: direct. Node's own proxy support
 * (24+) reads HTTP(S)_PROXY / NO_PROXY from it, sends a URL's credentials as
 * `Proxy-Authorization: Basic`, and does not bypass loopback by itself
 * (measured), which `upstreamProxyEnv` adds.
 */
function upstreamAgent(target: URL, proxyEnv: NodeJS.ProcessEnv | undefined): http.Agent {
  const options = { keepAlive: true, ...(proxyEnv ? { proxyEnv } : {}) };
  return target.protocol === 'https:' ? new https.Agent(options) : new http.Agent(options);
}

/** The environment the leg reads its proxy from; undefined: direct. */
function legProxyEnv(
  setting: HostProxySetting | null | undefined,
  inheritedNoProxy: string | undefined
): NodeJS.ProcessEnv | undefined {
  // K-3: the CLI used to honour the proxy variables itself; the upstream leg is ours now.
  if (setting === undefined) return process.env;
  return upstreamProxyEnv(setting, inheritedNoProxy);
}

/** Drops an agent's idle sockets; the ones carrying a response stay until it ends. */
function releaseIdle(agent: http.Agent): void {
  for (const sockets of Object.values(agent.freeSockets)) {
    for (const socket of sockets ?? []) socket.destroy();
  }
}

export async function startAuthProxy(options: AuthProxyOptions): Promise<AuthProxy> {
  const target = new URL(options.upstream);
  const base = target.pathname.replace(/\/+$/, '');
  const transport = target.protocol === 'https:' ? https : http;
  let agent =
    options.agent ?? upstreamAgent(target, legProxyEnv(options.proxy, options.inheritedNoProxy));
  /** Agents a proxy change replaced; destroyed when the proxy closes. */
  const retired: http.Agent[] = [];
  let routedBy = options.proxy;
  const token = mintSessionToken();
  const log = options.log ?? (() => undefined);

  const server = http.createServer((req, res) => {
    if (!sameToken(sentToken(req), token)) {
      refuse(res, 401, 'authentication_error', 'invalid session token', false);
      return;
    }
    if (!proxiedRoute(req.method, req.url)) {
      refuse(res, 404, 'not_found_error', 'not forwarded by PiLab', false);
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !DROPPED_HEADERS.has(name)) headers[name] = value;
    }
    headers['x-api-key'] = options.apiKey;
    const upstream = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: req.method,
        path: `${base}${req.url ?? ''}`,
        headers,
        agent,
      },
      (answer) => {
        if (answer.statusCode === 407) {
          // Decision 195: the product proxy refused its credentials. A 407 reaching the
          // CLI reads as a network error it retries; this one never fixes itself.
          answer.resume();
          log('auth proxy: the outbound proxy refused the request (407)');
          refuse(
            res,
            502,
            'api_error',
            'The proxy set in PiLab (Settings · Network) refused the request: 407 Proxy Authentication Required',
            false
          );
          return;
        }
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.headers);
        answer.pipe(res);
      }
    );
    upstream.on('error', (error) => {
      // Never the key: a request error names host and code only.
      log(
        'auth proxy: upstream request failed',
        (error as NodeJS.ErrnoException).code ?? error.message
      );
      refuse(
        res,
        502,
        'api_error',
        `PiLab could not reach the model service (${(error as NodeJS.ErrnoException).code ?? 'error'})`,
        true
      );
    });
    // The CLI hung up (Stop, an interrupt): end the upstream request with it.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    setProxy: (setting) => {
      if (routedBy !== undefined && sameHostProxy(routedBy, setting)) return;
      routedBy = setting;
      log(`auth proxy: outbound proxy ${describeHostProxy(setting, options.inheritedNoProxy)}`);
      if (options.agent !== undefined) return;
      const previous = agent;
      agent = upstreamAgent(target, legProxyEnv(setting, options.inheritedNoProxy));
      releaseIdle(previous);
      retired.push(previous);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
        if (options.agent === undefined) for (const each of [agent, ...retired]) each.destroy();
      }),
  };
}
