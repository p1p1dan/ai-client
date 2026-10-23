/**
 * pilab-relay: the relay a phone opens (mobile-remote README §4.3).
 *
 * Every PiLab with the remote-access plugin connects OUT to this server
 * (`/ws/machine`, with the access token); a browser logs in once with the login
 * password and then sees every connected machine (`/api/machines`) and talks to
 * one over `/ws/client?machine=<id>`. The relay only routes frames: it never
 * reads a conversation, and each PiLab decides what its clients may do.
 *
 * Plain Node plus `ws`; bundled to one file by `scripts/build-relay.mjs`.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';

export interface RelayConfig {
  loginPassword: string;
  accessToken: string;
  cookieSecret: string;
}

export interface RelayAsset {
  type: string;
  body: string | Buffer;
}

export interface RelayOptions {
  host: string;
  port: number;
  config: RelayConfig;
  /** Served at `/<path>`; `index.html` also at `/`. */
  assets: Record<string, RelayAsset>;
  tls?: { cert: Buffer; key: Buffer };
  log?: (message: string) => void;
  now?: () => number;
}

export interface RelayHandle {
  port: number;
  close(): Promise<void>;
}

/** Frames between relay and machine (the remote-access plugin). */
export type MachineToRelay =
  | { t: 'hello'; token: string; machineId: string; name: string; version?: string }
  | { t: 'rpc.res'; clientId: string; id: number; ok: boolean; value?: unknown; error?: unknown }
  | { t: 'push'; clientId?: string; event: string; data: unknown };

export type RelayToMachine =
  | { t: 'welcome' }
  | { t: 'client.open'; clientId: string; label: string }
  | { t: 'client.close'; clientId: string }
  | { t: 'rpc'; clientId: string; id: number; method: string; params: unknown };

const COOKIE = 'pilab_relay';
const COOKIE_DAYS = 30;
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_MAX_FAILS = 10;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const PING_MS = 25_000;

interface Machine {
  id: string;
  name: string;
  socket: WebSocket;
  connectedAt: number;
  clients: Map<string, Client>;
}

interface Client {
  id: string;
  label: string;
  socket: WebSocket;
}

export function generateRelayConfig(): RelayConfig {
  const word = () => randomBytes(9).toString('base64url');
  return {
    loginPassword: word(),
    accessToken: randomBytes(24).toString('base64url'),
    cookieSecret: randomBytes(32).toString('hex'),
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sign(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function issueCookie(secret: string, now: number): string {
  const value = `${now}.${now + COOKIE_DAYS * 86_400_000}`;
  return `${value}.${sign(secret, value)}`;
}

export function cookieValid(secret: string, cookie: string | undefined, now: number): boolean {
  if (!cookie) return false;
  const parts = cookie.split('.');
  if (parts.length !== 3) return false;
  const [issued, expires, signature] = parts as [string, string, string];
  if (!safeEqual(signature, sign(secret, `${issued}.${expires}`))) return false;
  return Number(expires) > now;
}

function readCookie(request: IncomingMessage): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return undefined;
}

/** "网页 · iPhone" from a user agent: enough for a person to tell devices apart. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : '浏览器';
  return `网页 · ${device}`;
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function send(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, max = 64 * 1024): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > max) throw new Error('body too large');
  }
  return body;
}

export function startRelay(options: RelayOptions): Promise<RelayHandle> {
  const log = options.log ?? ((message: string) => console.log(`[relay] ${message}`));
  const now = options.now ?? Date.now;
  const { config } = options;
  const secure = options.tls !== undefined;
  const machines = new Map<string, Machine>();
  const loginFails = new Map<string, number[]>();

  const authed = (request: IncomingMessage) =>
    cookieValid(config.cookieSecret, readCookie(request), now());

  const handleHttp = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://relay');
    const security = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    };
    if (url.pathname === '/api/login' && request.method === 'POST') {
      if (!sameOrigin(request)) return json(response, 403, { error: 'origin' });
      const ip = request.socket.remoteAddress ?? 'unknown';
      const fails = (loginFails.get(ip) ?? []).filter((at) => now() - at < LOGIN_WINDOW_MS);
      if (fails.length >= LOGIN_MAX_FAILS)
        return json(response, 429, { error: 'too_many_attempts' });
      let password = '';
      try {
        password = String(
          (JSON.parse(await readBody(request)) as { password?: unknown }).password ?? ''
        );
      } catch {
        return json(response, 400, { error: 'bad_request' });
      }
      if (!safeEqual(password, config.loginPassword)) {
        loginFails.set(ip, [...fails, now()]);
        return json(response, 401, { error: 'wrong_password' });
      }
      loginFails.delete(ip);
      const cookie = `${COOKIE}=${issueCookie(config.cookieSecret, now())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_DAYS * 86_400}${secure ? '; Secure' : ''}`;
      return json(response, 200, { ok: true }, { 'set-cookie': cookie });
    }
    if (url.pathname === '/api/logout' && request.method === 'POST') {
      return json(
        response,
        200,
        { ok: true },
        { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` }
      );
    }
    if (url.pathname === '/api/machines' && request.method === 'GET') {
      if (!authed(request)) return json(response, 401, { error: 'login_required' });
      return json(
        response,
        200,
        [...machines.values()]
          .map((machine) => ({
            id: machine.id,
            name: machine.name,
            online: true,
            clients: machine.clients.size,
            connectedAt: machine.connectedAt,
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
    }
    if (request.method !== 'GET') return json(response, 405, { error: 'method' });
    const asset = options.assets[url.pathname === '/' ? 'index.html' : url.pathname.slice(1)];
    if (!asset) return json(response, 404, { error: 'not_found' });
    response.writeHead(200, {
      'content-type': asset.type,
      'cache-control': 'no-cache',
      ...security,
    });
    response.end(asset.body);
  };

  const server = options.tls
    ? createHttpsServer(
        { cert: options.tls.cert, key: options.tls.key },
        (req, res) => void handleHttp(req, res).catch(() => json(res, 500, { error: 'internal' }))
      )
    : createHttpServer(
        (req, res) => void handleHttp(req, res).catch(() => json(res, 500, { error: 'internal' }))
      );

  const machineServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const clientServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const alive = new WeakSet<WebSocket>();
  const keepAlive = (socket: WebSocket) => {
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
  };
  const pinger = setInterval(() => {
    for (const socket of [...machineServer.clients, ...clientServer.clients]) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, PING_MS);

  machineServer.on('connection', (socket) => {
    keepAlive(socket);
    let machine: Machine | undefined;
    const helloTimer = setTimeout(() => socket.close(4408, 'hello timeout'), HELLO_TIMEOUT_MS);
    socket.on('message', (raw) => {
      let frame: MachineToRelay;
      try {
        frame = JSON.parse(raw.toString()) as MachineToRelay;
      } catch {
        return;
      }
      if (!machine) {
        if (
          frame.t !== 'hello' ||
          typeof frame.token !== 'string' ||
          !safeEqual(frame.token, config.accessToken)
        ) {
          socket.close(4401, 'bad token');
          return;
        }
        clearTimeout(helloTimer);
        const id =
          typeof frame.machineId === 'string' && frame.machineId
            ? frame.machineId.slice(0, 64)
            : randomUUID();
        const previous = machines.get(id);
        if (previous) previous.socket.close(4409, 'replaced');
        machine = {
          id,
          name: String(frame.name || id).slice(0, 64),
          socket,
          connectedAt: now(),
          clients: previous?.clients ?? new Map(),
        };
        machines.set(id, machine);
        send(socket, { t: 'welcome' } satisfies RelayToMachine);
        for (const client of machine.clients.values()) {
          send(socket, {
            t: 'client.open',
            clientId: client.id,
            label: client.label,
          } satisfies RelayToMachine);
          send(client.socket, { t: 'machine.online' });
        }
        log(`machine connected: ${machine.name} (${id})`);
        return;
      }
      if (frame.t === 'rpc.res') {
        const client = machine.clients.get(frame.clientId);
        if (client)
          send(client.socket, {
            t: 'res',
            id: frame.id,
            ok: frame.ok,
            value: frame.value,
            error: frame.error,
          });
      } else if (frame.t === 'push') {
        const targets = frame.clientId
          ? [machine.clients.get(frame.clientId)]
          : [...machine.clients.values()];
        for (const client of targets)
          if (client) send(client.socket, { t: 'push', event: frame.event, data: frame.data });
      }
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (!machine || machines.get(machine.id)?.socket !== socket) return;
      machines.delete(machine.id);
      for (const client of machine.clients.values()) send(client.socket, { t: 'machine.offline' });
      log(`machine disconnected: ${machine.name}`);
    });
  });

  clientServer.on('connection', (socket, request: IncomingMessage) => {
    keepAlive(socket);
    const url = new URL(request.url ?? '/', 'http://relay');
    const machineId = url.searchParams.get('machine') ?? '';
    const machine = machines.get(machineId);
    if (!machine) {
      socket.close(4404, 'machine offline');
      return;
    }
    const client: Client = {
      id: randomUUID(),
      label: deviceLabel(request.headers['user-agent']),
      socket,
    };
    machine.clients.set(client.id, client);
    send(machine.socket, {
      t: 'client.open',
      clientId: client.id,
      label: client.label,
    } satisfies RelayToMachine);
    send(socket, {
      t: 'ready',
      machine: { id: machine.id, name: machine.name },
      label: client.label,
    });
    socket.on('message', (raw) => {
      let frame: { t?: string; id?: unknown; method?: unknown; params?: unknown };
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const current = machines.get(machineId);
      if (frame.t !== 'rpc' || typeof frame.id !== 'number' || typeof frame.method !== 'string')
        return;
      if (!current) {
        send(socket, {
          t: 'res',
          id: frame.id,
          ok: false,
          error: { code: 'machine_offline', message: '这台机器现在不在线' },
        });
        return;
      }
      send(current.socket, {
        t: 'rpc',
        clientId: client.id,
        id: frame.id,
        method: frame.method,
        params: frame.params,
      } satisfies RelayToMachine);
    });
    socket.on('close', () => {
      const current = machines.get(machineId) ?? machine;
      current.clients.delete(client.id);
      send(current.socket, { t: 'client.close', clientId: client.id } satisfies RelayToMachine);
    });
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay');
    if (url.pathname === '/ws/machine') {
      machineServer.handleUpgrade(request, socket, head, (ws) =>
        machineServer.emit('connection', ws, request)
      );
    } else if (url.pathname === '/ws/client' && sameOrigin(request) && authed(request)) {
      clientServer.handleUpgrade(request, socket, head, (ws) =>
        clientServer.emit('connection', ws, request)
      );
    } else {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            clearInterval(pinger);
            for (const socket of [...machineServer.clients, ...clientServer.clients])
              socket.terminate();
            server.close(() => done());
          }),
      });
    });
  });
}
