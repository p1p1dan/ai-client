/**
 * Decision 195: a minimal HTTP proxy on loopback, for tests and probes.
 *
 * It forwards absolute-URI requests (`GET http://host:port/path`, what both
 * Node's built-in proxy support and undici's `ProxyAgent` send for an `http:`
 * target) and tunnels `CONNECT` (an `https:` target). Every host goes through
 * `resolve`, by default `*.invalid` -> 127.0.0.1: a gateway given a
 * `.invalid` name (RFC 2606: never resolvable) is reachable through this
 * proxy and through nothing else, so a request that arrives proves it was
 * proxied, whatever the machine's own network does with a direct one.
 *
 * With `credentials`, a request without the matching
 * `Proxy-Authorization: Basic` is answered 407. Each request is recorded
 * (kind, target, whether it was authorised, the status given) — never a
 * credential.
 *
 * Loaded by Node type stripping: erasable syntax only.
 */

import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

export interface TestProxyRecord {
  kind: 'forward' | 'connect';
  /** `host:port` as the client asked for it. */
  target: string;
  authorized: boolean;
  status: number;
}

export interface TestProxy {
  /** `http://127.0.0.1:<port>`, credentials not included. */
  readonly url: string;
  /** The same with the credentials in it, when the proxy has any. */
  readonly urlWithCredentials: string;
  readonly port: number;
  readonly records: TestProxyRecord[];
  close(): Promise<void>;
}

export interface TestProxyOptions {
  credentials?: { username: string; password: string };
  /** Where a requested host is really reached. Default: `*.invalid` -> 127.0.0.1. */
  resolve?: (host: string) => string;
}

export function resolveInvalidToLoopback(host: string): string {
  return /\.invalid$/i.test(host) ? '127.0.0.1' : host;
}

function expectedAuth(credentials: TestProxyOptions['credentials']): string | undefined {
  if (!credentials) return undefined;
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
}

export async function startTestProxy(options: TestProxyOptions = {}): Promise<TestProxy> {
  const resolve = options.resolve ?? resolveInvalidToLoopback;
  const wanted = expectedAuth(options.credentials);
  const records: TestProxyRecord[] = [];
  const sockets = new Set<Duplex>();
  const authorized = (req: http.IncomingMessage) =>
    wanted === undefined || req.headers['proxy-authorization'] === wanted;

  const server = http.createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      records.push({ kind: 'forward', target: String(req.url), authorized: false, status: 400 });
      res.writeHead(400).end();
      return;
    }
    const port = Number(target.port || 80);
    const record: TestProxyRecord = {
      kind: 'forward',
      target: `${target.hostname}:${port}`,
      authorized: authorized(req),
      status: 0,
    };
    records.push(record);
    if (!record.authorized) {
      record.status = 407;
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' }).end();
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = http.request(
      {
        host: resolve(target.hostname),
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (answer) => {
        record.status = answer.statusCode ?? 0;
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      }
    );
    upstream.on('error', () => {
      record.status = 502;
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on('connect', (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined);
    const target = req.url ?? '';
    const split = target.lastIndexOf(':');
    const host = target.slice(0, split).replace(/^\[|\]$/g, '');
    const port = Number(target.slice(split + 1));
    const record: TestProxyRecord = {
      kind: 'connect',
      target,
      authorized: authorized(req),
      status: 0,
    };
    records.push(record);
    if (!record.authorized) {
      record.status = 407;
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n'
      );
      return;
    }
    const upstream = net.connect(port, resolve(host), () => {
      record.status = 200;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => {
      if (record.status === 0) {
        record.status = 502;
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } else client.destroy();
    });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as net.AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const credentials = options.credentials;
  return {
    url,
    urlWithCredentials: credentials
      ? `http://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}`
      : url,
    port,
    records,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
