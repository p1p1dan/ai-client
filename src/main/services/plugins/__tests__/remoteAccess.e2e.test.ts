import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginView } from '@shared/plugins/view';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { generateRelayConfig, type RelayHandle, startRelay } from '../../../../../relay/server';
import type { ChatCaller } from '../../chat/chatCaller';
import { SessionControlRegistry } from '../../chat/sessionControl';
import { PluginManager } from '../pluginManager';
import { resolvePluginLaunch } from '../pluginProcess';
import { PluginStore } from '../pluginStore';
import { writeZip } from '../zipWriter';

/**
 * Issue #25 end to end: pilab-relay, the remote-access plugin in its own
 * process (plugins/remote-access), and a scripted web client. Only the chat
 * handlers are fakes.
 */

let root: string;
let relay: RelayHandle;
let manager: PluginManager;
let views: PluginView[];
let chatListeners: Array<(event: RuntimeEvent) => void>;
let control: SessionControlRegistry;
const config = generateRelayConfig();
const calls: Array<{ channel: string; ownerId: number | undefined; payload: unknown }> = [];

const SESSIONS = [
  {
    sessionId: 's1',
    title: '修复设置页',
    workspacePath: '/repo',
    updatedAt: 2,
    runtimeIdentity: '/s1.jsonl',
  },
  { sessionId: 's2', title: '已归档', workspacePath: '/repo', updatedAt: 1, archived: true },
];

const invokeChat = vi.fn(async (channel: string, caller: ChatCaller, args: unknown[]) => {
  const payload = args[0] as { sessionId?: string } | undefined;
  calls.push({ channel, ownerId: caller.ownerId, payload });
  if (channel !== 'chat:listSessions' && payload?.sessionId)
    if (['chat:send', 'chat:respondPermission'].includes(channel))
      control.assertMayChange(payload.sessionId, caller.ownerId);
  switch (channel) {
    case 'chat:listSessions':
      return SESSIONS;
    case 'chat:peekHistory':
      return {
        messages: [{ id: 'h:u1', role: 'user', blocks: [{ type: 'text', id: 'b', text: '你好' }] }],
        offset: 0,
        limit: 120,
        totalCount: 1,
        hasMore: false,
        runtimeIdentity: '/s1.jsonl',
        workspacePath: '/repo',
        live: true,
      };
    case 'chat:send':
      return { requestId: 'send-1' };
    default:
      return null;
  }
});

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(
        `condition not met: ${JSON.stringify(views.map((v) => [v.state, v.status]))}`
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

class Client {
  frames: Array<Record<string, any>> = [];
  private next = 1;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => this.frames.push(JSON.parse(raw.toString())));
  }
  async call(method: string, params: unknown = {}): Promise<Record<string, any>> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ t: 'rpc', id, method, params }));
    await until(() => this.frames.some((f) => f.t === 'res' && f.id === id));
    return this.frames.find((f) => f.t === 'res' && f.id === id) as Record<string, any>;
  }
}

async function login(port: number, password: string): Promise<{ status: number; cookie: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return {
    status: response.status,
    cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
  };
}

async function openClient(port: number, cookie: string, machineId: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/client?machine=${machineId}`, {
    headers: { cookie, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
  });
  const client = new Client(ws);
  await until(() => client.frames.some((f) => f.t === 'ready'));
  return client;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'remote-e2e-'));
  views = [];
  chatListeners = [];
  calls.length = 0;
  control = new SessionControlRegistry();
  relay = await startRelay({
    host: '127.0.0.1',
    port: 0,
    config,
    assets: { 'index.html': { type: 'text/html', body: '<p>web</p>' } },
    log: () => undefined,
  });
  let owner = 0;
  const store = new PluginStore(path.join(root, 'plugins'), {
    available: () => false,
    encrypt: (t) => t,
    decrypt: (t) => t,
  });
  manager = new PluginManager({
    store,
    launch: (plugin) =>
      resolvePluginLaunch({
        isPackaged: false,
        appPath: process.cwd(),
        resourcesPath: '',
        pluginId: plugin.manifest.id,
        dataDir: plugin.dataDir,
        env: { ...process.env, AICLIENT_DSH_NODE: process.execPath },
      }),
    invokeChat,
    onChatRuntimeEvent: (listener) => {
      chatListeners.push(listener);
      return () => {
        chatListeners = chatListeners.filter((l) => l !== listener);
      };
    },
    sessionControl: control,
    allocateOwnerId: () => {
      owner -= 1;
      return owner;
    },
    appendAudit: () => undefined,
    log: () => undefined,
    notify: (next) => {
      views = next;
    },
  });
  const dir = path.join(process.cwd(), 'plugins', 'remote-access');
  const file = path.join(root, 'remote.pilabplug');
  writeFileSync(
    file,
    writeZip(
      ['manifest.json', 'main.mjs', 'core.mjs'].map((name) => ({
        path: name,
        data: readFileSync(path.join(dir, name)),
      }))
    )
  );
  await manager.install(file);
  manager.setSetting('pilab.remote-access', 'relayUrl', `127.0.0.1:${relay.port}`);
  manager.setSetting('pilab.remote-access', 'accessToken', config.accessToken);
  manager.setSetting('pilab.remote-access', 'machineName', 'build-03');
});

afterEach(async () => {
  await manager.stopAll();
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

const remote = () => views.find((view) => view.id === 'pilab.remote-access');

describe('remote access end to end (issue #25)', () => {
  it('[M25-E2E] a phone logs in, sees the machine, opens a chat, takes it over and sends', async () => {
    await manager.setEnabled('pilab.remote-access', true);
    await until(() => remote()?.status?.text?.includes('已连上中转') === true);

    expect((await login(relay.port, 'wrong')).status).toBe(401);
    const { status, cookie } = await login(relay.port, config.loginPassword);
    expect(status).toBe(200);
    const machines = (await (
      await fetch(`http://127.0.0.1:${relay.port}/api/machines`, { headers: { cookie } })
    ).json()) as Array<{ id: string; name: string }>;
    expect(machines).toEqual([expect.objectContaining({ name: 'build-03', online: true })]);

    const phone = await openClient(relay.port, cookie, machines[0]!.id);
    const list = await phone.call('listSessions');
    expect(list.value).toEqual([
      {
        sessionId: 's1',
        title: '修复设置页',
        workspacePath: '/repo',
        updatedAt: 2,
        unbound: false,
      },
    ]);

    for (const listener of chatListeners)
      listener({
        type: 'session.status',
        sessionId: 's1',
        seq: 1,
        timestamp: 1,
        payload: { status: 'running' },
      } as RuntimeEvent);
    for (const listener of chatListeners)
      listener({
        type: 'permission.requested',
        sessionId: 's1',
        seq: 2,
        timestamp: 2,
        payload: { permissionId: 'p1', toolName: 'bash' },
      } as RuntimeEvent);
    await until(
      () => phone.frames.filter((f) => f.t === 'push' && f.event === 'chat').length === 2
    );

    const opened = await phone.call('openSession', { sessionId: 's1' });
    expect(opened.value.history.messages).toHaveLength(1);
    expect(opened.value.control).toEqual({ sessionId: 's1', holder: 'desktop', label: '桌面' });
    expect(opened.value.snapshot.status).toBe('running');
    expect(
      opened.value.snapshot.pendingPermissions.map((p: any) => p.payload.permissionId)
    ).toEqual(['p1']);

    // Not taken over yet: the desktop owns it.
    const refused = await phone.call('respondPermission', {
      sessionId: 's1',
      permissionId: 'p1',
      decision: 'allow',
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'session_controlled_elsewhere' } });

    const taken = await phone.call('takeOver', { sessionId: 's1' });
    expect(taken.value).toEqual({ sessionId: 's1', holder: 'me', label: '网页 · iPhone' });
    expect(control.get('s1')).toMatchObject({ kind: 'client', label: '网页 · iPhone' });
    expect(
      (
        await phone.call('respondPermission', {
          sessionId: 's1',
          permissionId: 'p1',
          decision: 'allow',
        })
      ).ok
    ).toBe(true);
    expect((await phone.call('send', { sessionId: 's1', text: '继续' })).value).toEqual({
      requestId: 'send-1',
    });
    const sends = calls.filter((c) => c.channel === 'chat:send');
    expect(sends[0]?.ownerId).toBeLessThan(0);

    // The desktop takes it back: the phone hears so.
    control.acquireForDesktop('s1');
    await until(() =>
      phone.frames.some((f) => f.event === 'control' && f.data.holder === 'desktop')
    );

    // The phone leaves: anything it still held goes back to the desktop.
    await phone.call('takeOver', { sessionId: 's1' });
    phone.ws.close();
    await until(() => control.get('s1').kind === 'desktop');
  }, 40_000);

  it('[M25-E2E] a wrong access token is reported, and an unauthenticated client cannot connect', async () => {
    manager.setSetting('pilab.remote-access', 'accessToken', 'nope');
    await manager.setEnabled('pilab.remote-access', true);
    await until(() => remote()?.status?.text === '接入口令不对，请到设置里改');
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ws/client?machine=x`);
    const closed = await new Promise<string>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
      ws.on('error', () => resolve('error'));
    });
    expect(closed).toBe('401');
  }, 40_000);
});

describe('relay address and cookies', () => {
  it.each([
    ['203.0.113.7:8790', 'ws://203.0.113.7:8790/ws/machine'],
    ['http://203.0.113.7:8790/', 'ws://203.0.113.7:8790/ws/machine'],
    ['https://relay.example:8443', 'wss://relay.example:8443/ws/machine'],
    ['  127.0.0.1:8790  ', 'ws://127.0.0.1:8790/ws/machine'],
    ['', null],
  ])('[M25-ADDR] %s → %s', async (input, expected) => {
    // @ts-expect-error -- plain JS plugin module, no declaration file
    const { machineSocketUrl } = await import('../../../../../plugins/remote-access/core.mjs');
    expect(machineSocketUrl(input)).toBe(expected);
  });

  it('[M25-COOKIE] a cookie is valid until it expires, and only with its own secret', async () => {
    const { cookieValid, issueCookie } = await import('../../../../../relay/server');
    const cookie = issueCookie('secret', 1000);
    expect(cookieValid('secret', cookie, 2000)).toBe(true);
    expect(cookieValid('other', cookie, 2000)).toBe(false);
    expect(cookieValid('secret', cookie, 1000 + 31 * 86_400_000)).toBe(false);
    expect(cookieValid('secret', `${cookie}x`, 2000)).toBe(false);
  });
});
