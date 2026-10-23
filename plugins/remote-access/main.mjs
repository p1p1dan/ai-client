// @ts-check
/**
 * PiLab plugin: remote access (issue #25). Connects out to a pilab-relay and
 * serves the chats of this machine to the web page there. The socket lives
 * here; what each request does is in `core.mjs`.
 *
 * @typedef {import('../../src/shared/plugins/api.ts').PilabPluginApi} PilabPluginApi
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { createRemoteCore, machineSocketUrl } from './core.mjs';

const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** @param {string} dataDir */
function machineId(dataDir) {
  const file = path.join(dataDir, 'machine-id');
  try {
    const id = readFileSync(file, 'utf8').trim();
    if (id) return id;
  } catch {}
  const id = randomUUID();
  writeFileSync(file, id);
  return id;
}

/** @param {PilabPluginApi} pilab */
export function activate(pilab) {
  /** @type {WebSocket | undefined} */
  let socket;
  let running = false;
  let failures = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retryTimer;
  /** @type {(() => void)[]} */
  let unsubscribe = [];

  const send = (/** @type {any} */ frame) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };
  const core = createRemoteCore(pilab, send);

  const status = (/** @type {'idle'|'ok'|'warning'|'error'} */ state, /** @type {string} */ text) =>
    void pilab.status.set({ state, text }).catch(() => undefined);

  const scheduleRetry = (/** @type {string} */ why) => {
    if (!running) return;
    const delay = RECONNECT_MS[Math.min(failures, RECONNECT_MS.length - 1)] ?? 30_000;
    failures += 1;
    status('warning', `${why}，${Math.round(delay / 1000)} 秒后重连`);
    retryTimer = setTimeout(() => void connect(), delay);
  };

  async function connect() {
    if (!running) return;
    const settings = await pilab.settings.get();
    let url;
    try {
      url = machineSocketUrl(settings.relayUrl);
    } catch {
      url = null;
    }
    if (!url) return status('idle', '还没填中转地址');
    if (!settings.accessToken) return status('idle', '还没填接入口令');
    const name = String(settings.machineName || '').trim() || hostname();
    status('warning', `正在连接 ${url.replace(/^wss?:\/\//, '').replace(/\/ws\/machine$/, '')}`);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      return scheduleRetry(`地址无效：${String(/** @type {any} */ (error)?.message ?? error)}`);
    }
    socket = ws;
    let welcomed = false;
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          t: 'hello',
          token: String(settings.accessToken),
          machineId: machineId(pilab.dataDir),
          name,
          version: 1,
        })
      );
    });
    ws.addEventListener('message', (message) => {
      let frame;
      try {
        frame = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (frame.t === 'welcome') {
        welcomed = true;
        failures = 0;
        status('ok', `已连上中转 · ${name}`);
        return;
      }
      void core.onFrame(frame).then(() => {
        if (welcomed && (frame.t === 'client.open' || frame.t === 'client.close')) {
          status(
            'ok',
            core.clientCount
              ? `已连上中转 · ${core.clientCount} 台设备在用`
              : `已连上中转 · ${name}`
          );
        }
      });
    });
    ws.addEventListener('close', (event) => {
      if (socket !== ws) return;
      socket = undefined;
      void core.onDisconnected();
      if (event.code === 4401) {
        status('error', '接入口令不对，请到设置里改');
        return;
      }
      scheduleRetry(welcomed ? '和中转断开了' : '连不上中转');
    });
    ws.addEventListener('error', () => {
      // `close` follows and reports.
    });
  }

  function stopConnection() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    const ws = socket;
    socket = undefined;
    ws?.close();
    void core.onDisconnected();
  }

  pilab.services.register('connector', {
    start: () => {
      running = true;
      failures = 0;
      unsubscribe = [
        pilab.chat.onEvent((entry) => core.onChatEvent(entry)),
        pilab.sessionControl.onChange((change) => core.onControlChange(change)),
        pilab.settings.onChange(() => {
          stopConnection();
          failures = 0;
          void connect();
        }),
      ];
      void connect();
    },
    stop: () => {
      running = false;
      for (const off of unsubscribe) off();
      unsubscribe = [];
      stopConnection();
    },
  });
}
