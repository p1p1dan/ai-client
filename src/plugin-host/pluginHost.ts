/**
 * The plugin host: the program each plugin process runs (plugin-system README
 * §3). PiLab starts it on the bundled Node with an IPC channel; it loads the
 * plugin's `main`, hands it the `pilab` API and turns every API call into a
 * `call` frame that PiLab checks and answers. The plugin holds no PiLab object
 * and imports no PiLab module.
 *
 * Runs as source in development (Node strips the types), bundled when packaged:
 * value imports spell `.ts`, no enums, no path aliases.
 */

import { pathToFileURL } from 'node:url';
import type { PilabPluginApi, PluginModule, PluginService } from '../shared/plugins/api.ts';
import {
  type HostApiMethod,
  type HostToPluginFrame,
  PLUGIN_ERRORS,
  PLUGIN_EVENTS,
  PLUGIN_TIMEOUTS_MS,
  type PluginToHostFrame,
  type WireError,
} from '../shared/plugins/protocol.ts';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

class PluginCallError extends Error {
  code: string;
  constructor(error: WireError) {
    super(error.message);
    this.name = 'PluginCallError';
    this.code = error.code;
  }
}

function send(frame: PluginToHostFrame): void {
  process.send?.(frame);
}

function toWireError(error: unknown): WireError {
  if (error instanceof PluginCallError) return { code: error.code, message: error.message };
  return {
    code: PLUGIN_ERRORS.failed,
    message: error instanceof Error ? error.message : String(error),
  };
}

let nextCallId = 1;
const pending = new Map<number, Pending>();
const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
const services = new Map<string, PluginService>();
let pluginModule: PluginModule | undefined;

function callHost(method: HostApiMethod, ...args: unknown[]): Promise<unknown> {
  const id = nextCallId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ t: 'call', id, method, args });
  });
}

function listen(name: string, listener: (payload: unknown) => void): () => void {
  let set = eventListeners.get(name);
  if (!set) {
    set = new Set();
    eventListeners.set(name, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  send({ t: 'log', level, message: String(message) });
}

function buildApi(init: Extract<HostToPluginFrame, { t: 'init' }>): PilabPluginApi {
  const declaredServices = new Set(init.manifest.contributes.services.map((s) => s.id));
  let chatSubscribers = 0;
  return {
    pluginId: init.pluginId,
    pluginDir: init.pluginDir,
    dataDir: init.dataDir,
    chat: {
      invoke: (clientId, channel, payload) =>
        callHost('chat.invoke', clientId, channel, payload) as Promise<never>,
      releaseClient: async (clientId) => {
        await callHost('chat.releaseClient', clientId);
      },
      onEvent: (listener) => {
        const stop = listen(PLUGIN_EVENTS.chatEvent, listener as (payload: unknown) => void);
        chatSubscribers += 1;
        if (chatSubscribers === 1) void callHost('chat.subscribe').catch(() => undefined);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          stop();
          chatSubscribers -= 1;
          if (chatSubscribers === 0) void callHost('chat.unsubscribe').catch(() => undefined);
        };
      },
      snapshot: (sessionId) => callHost('chat.snapshot', sessionId) as Promise<never>,
      since: (cursor) => callHost('chat.since', cursor) as Promise<never>,
    },
    sessionControl: {
      get: (sessionId) => callHost('sessionControl.get', sessionId) as Promise<never>,
      acquire: async (sessionId, clientId, label) => {
        await callHost('sessionControl.acquire', sessionId, clientId, label);
      },
      onChange: (listener) =>
        listen(PLUGIN_EVENTS.sessionControlChanged, listener as (payload: unknown) => void),
    },
    settings: {
      get: () => callHost('settings.get') as Promise<Record<string, unknown>>,
      set: async (key, value) => {
        await callHost('settings.set', key, value);
      },
      onChange: (listener) =>
        listen(PLUGIN_EVENTS.settingsChanged, listener as (payload: unknown) => void),
    },
    services: {
      register: (id, service) => {
        if (!declaredServices.has(id)) {
          throw new Error(`service ${id} is not declared in contributes.services`);
        }
        services.set(id, service);
      },
    },
    status: {
      set: async (status) => {
        await callHost('status.set', status);
      },
    },
    log: {
      info: (message) => log('info', message),
      warn: (message) => log('warn', message),
      error: (message) => log('error', message),
    },
  };
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new PluginCallError({ code: PLUGIN_ERRORS.timeout, message: `${what} timed out` })),
      ms
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function activate(init: Extract<HostToPluginFrame, { t: 'init' }>): Promise<void> {
  const entry = pathToFileURL(`${init.pluginDir}/${init.manifest.main}`).href;
  const loaded = (await import(entry)) as Partial<PluginModule> & {
    default?: Partial<PluginModule>;
  };
  const candidate = typeof loaded.activate === 'function' ? loaded : loaded.default;
  if (!candidate || typeof candidate.activate !== 'function') {
    throw new Error(`${init.manifest.main} does not export activate()`);
  }
  pluginModule = candidate as PluginModule;
  await withTimeout(
    Promise.resolve(pluginModule.activate(buildApi(init))),
    PLUGIN_TIMEOUTS_MS.activate,
    'activate'
  );
}

async function answerHostCall(frame: Extract<HostToPluginFrame, { t: 'call' }>): Promise<unknown> {
  switch (frame.method) {
    case 'service.start':
    case 'service.stop': {
      const id = String(frame.args[0]);
      const service = services.get(id);
      if (!service) throw new Error(`service ${id} was never registered`);
      const run = frame.method === 'service.start' ? service.start() : service.stop();
      return withTimeout(Promise.resolve(run), PLUGIN_TIMEOUTS_MS.service, frame.method);
    }
    case 'deactivate':
      return withTimeout(
        Promise.resolve(pluginModule?.deactivate?.()),
        PLUGIN_TIMEOUTS_MS.deactivate,
        'deactivate'
      );
    default:
      throw new PluginCallError({
        code: PLUGIN_ERRORS.methodUnknown,
        message: `unknown method ${String((frame as { method: unknown }).method)}`,
      });
  }
}

process.on('message', (raw: unknown) => {
  const frame = raw as HostToPluginFrame;
  switch (frame?.t) {
    case 'init':
      activate(frame).then(
        () => send({ t: 'ready' }),
        (error: unknown) => send({ t: 'fail', error: toWireError(error) })
      );
      break;
    case 'call':
      answerHostCall(frame).then(
        (value) => send({ t: 'res', id: frame.id, ok: true, value: value ?? null }),
        (error: unknown) => send({ t: 'res', id: frame.id, ok: false, error: toWireError(error) })
      );
      break;
    case 'res': {
      const waiting = pending.get(frame.id);
      if (!waiting) break;
      pending.delete(frame.id);
      if (frame.ok) waiting.resolve(frame.value);
      else waiting.reject(new PluginCallError(frame.error));
      break;
    }
    case 'event':
      for (const listener of eventListeners.get(frame.name) ?? []) {
        try {
          listener(frame.payload);
        } catch (error) {
          log('error', `event listener for ${frame.name} threw: ${toWireError(error).message}`);
        }
      }
      break;
    default:
      break;
  }
});

// PiLab went away: nothing is left to serve.
process.on('disconnect', () => process.exit(0));

process.on('unhandledRejection', (reason) => {
  log('error', `unhandled rejection: ${toWireError(reason).message}`);
});
