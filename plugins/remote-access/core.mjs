// @ts-check
/**
 * Remote access core (mobile-remote README §4): everything except the socket.
 * `main.mjs` feeds it relay frames and gives it a `send`; tests do the same
 * with fakes.
 *
 * @typedef {import('../../src/shared/plugins/api.ts').PilabPluginApi} PilabPluginApi
 * @typedef {{ t: string; [key: string]: any }} Frame
 */

const RESUME_NEEDED = /session_not_found|session_not_ready|not running|legacy_migration_required/;
/** @param {any} error */
const errorText = (error) => `${error?.code ?? ''}: ${String(error?.message ?? error)}`;

/**
 * @param {PilabPluginApi} pilab
 * @param {(frame: Frame) => void} send  frame to the relay
 */
export function createRemoteCore(pilab, send) {
  /** @type {Map<string, { label: string }>} */
  const clients = new Map();
  /** Sessions each client took over: sessionId -> clientId. */
  /** @type {Map<string, string>} */
  const heldBy = new Map();
  let lastCursor = 0;
  let attempt = 0;

  /** @param {string} sessionId @param {string} clientId */
  const holderFor = (sessionId, clientId) => {
    const holder = heldBy.get(sessionId);
    return holder === clientId ? 'me' : holder ? 'other' : undefined;
  };

  /** What `clientId` should show for a session: who may change it. */
  async function controlView(sessionId, clientId) {
    const controller = await pilab.sessionControl.get(sessionId);
    if (controller.kind === 'desktop') return { sessionId, holder: 'desktop', label: '桌面' };
    const mine = holderFor(sessionId, clientId);
    return { sessionId, holder: mine ?? 'other', label: controller.label };
  }

  /** @param {string} sessionId */
  async function sessionRow(sessionId) {
    /** @type {any[]} */
    const rows = await pilab.chat.invoke('_core', 'chat:listSessions');
    const row = rows.find((candidate) => candidate.sessionId === sessionId);
    if (!row) throw new Error(`session_not_found: no chat ${sessionId}`);
    return row;
  }

  /** Start a chat that is not running, for this client. */
  async function resume(clientId, sessionId) {
    const row = await sessionRow(sessionId);
    if (!row.runtimeIdentity) return; // never ran: the first send creates it
    await pilab.chat.invoke(clientId, 'chat:resumeSession', {
      sessionId,
      runtimeIdentity: row.runtimeIdentity,
      workspacePath: row.workspacePath,
      ...(row.model ? { model: row.model } : {}),
    });
  }

  /** @param {string} clientId @param {string} channel @param {any} payload */
  async function withResume(clientId, channel, payload) {
    try {
      return await pilab.chat.invoke(clientId, channel, payload);
    } catch (error) {
      if (!RESUME_NEEDED.test(errorText(error))) throw error;
      await resume(clientId, payload.sessionId);
      return pilab.chat.invoke(clientId, channel, payload);
    }
  }

  /** @type {Record<string, (clientId: string, params: any) => Promise<unknown>>} */
  const methods = {
    async listSessions() {
      /** @type {any[]} */
      const rows = await pilab.chat.invoke('_core', 'chat:listSessions');
      return rows
        .filter((row) => !row.archived)
        .map((row) => ({
          sessionId: row.sessionId,
          title: row.title,
          workspacePath: row.workspacePath,
          updatedAt: row.updatedAt,
          unbound: row.unbound === true,
        }));
    },

    /** Everything a client needs to show a chat at the point the desktop sees it. */
    async openSession(clientId, { sessionId }) {
      /** @type {any} */
      let history = null;
      let needsResume = false;
      try {
        history = await pilab.chat.invoke(clientId, 'chat:peekHistory', { sessionId, limit: 120 });
      } catch (error) {
        if (!/session_replay_unavailable/i.test(errorText(error))) throw error;
        needsResume = true;
      }
      const snapshot = await pilab.chat.snapshot(sessionId);
      return {
        history,
        needsResume,
        snapshot,
        cursor: lastCursor,
        control: await controlView(sessionId, clientId),
      };
    },

    async olderHistory(clientId, { sessionId, offset }) {
      return pilab.chat.invoke(clientId, 'chat:peekHistory', { sessionId, offset, limit: 120 });
    },

    async resumeSession(clientId, { sessionId }) {
      await resume(clientId, sessionId);
      return null;
    },

    async takeOver(clientId, { sessionId }) {
      const client = clients.get(clientId);
      await pilab.sessionControl.acquire(sessionId, clientId, client?.label ?? '网页');
      heldBy.set(sessionId, clientId);
      return controlView(sessionId, clientId);
    },

    async send(clientId, { sessionId, text, attachments }) {
      attempt += 1;
      const payload = {
        sessionId,
        attemptId: `remote-${Date.now().toString(36)}-${attempt}`,
        text: String(text ?? ''),
        ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
      };
      return withResume(clientId, 'chat:send', payload);
    },

    async interject(clientId, { sessionId, text }) {
      attempt += 1;
      return pilab.chat.invoke(clientId, 'chat:interject', {
        sessionId,
        attemptId: `remote-${Date.now().toString(36)}-${attempt}`,
        text: String(text ?? ''),
      });
    },

    async stop(clientId, { sessionId }) {
      return pilab.chat.invoke(clientId, 'chat:stop', { sessionId });
    },

    async respondPermission(clientId, { sessionId, permissionId, decision }) {
      return pilab.chat.invoke(clientId, 'chat:respondPermission', {
        sessionId,
        permissionId,
        decision,
      });
    },

    async respondQuestion(clientId, params) {
      const { sessionId, questionId, answers, response, cancel } = params;
      return pilab.chat.invoke(clientId, 'chat:respondQuestion', {
        sessionId,
        questionId,
        ...(answers ? { answers } : {}),
        ...(typeof response === 'string' ? { response } : {}),
        ...(cancel === true ? { cancel: true } : {}),
      });
    },

    /** A new chat in a folder this machine already has chats in; taken over at once. */
    async createSession(clientId, { workspacePath }) {
      const sessionId = globalThis.crypto.randomUUID();
      await pilab.chat.invoke(clientId, 'chat:registerSession', { sessionId, workspacePath });
      await methods.takeOver(clientId, { sessionId });
      await pilab.chat.invoke(clientId, 'chat:createSession', { sessionId, workspacePath });
      return { sessionId };
    },

    async since(_clientId, { cursor }) {
      return pilab.chat.since(Number(cursor) || 0);
    },
  };

  /** @param {Frame} frame */
  async function onFrame(frame) {
    switch (frame.t) {
      case 'client.open':
        clients.set(frame.clientId, { label: String(frame.label || '网页') });
        return;
      case 'client.close': {
        clients.delete(frame.clientId);
        for (const [sessionId, clientId] of heldBy)
          if (clientId === frame.clientId) heldBy.delete(sessionId);
        await pilab.chat.releaseClient(frame.clientId).catch(() => undefined);
        return;
      }
      case 'rpc': {
        const method = methods[frame.method];
        try {
          if (!method) throw new Error(`unknown_method: ${frame.method}`);
          const value = await method(frame.clientId, frame.params ?? {});
          send({
            t: 'rpc.res',
            clientId: frame.clientId,
            id: frame.id,
            ok: true,
            value: value ?? null,
          });
        } catch (error) {
          const message = String(error?.message ?? error);
          // Host API failures carry their code on `code`; others spell it `code: message`.
          const match =
            typeof error?.code === 'string' && error.code !== 'PLUGIN_CALL_FAILED'
              ? [message, error.code, message]
              : /^([A-Za-z_][A-Za-z0-9_]*): ([\s\S]*)$/.exec(message);
          send({
            t: 'rpc.res',
            clientId: frame.clientId,
            id: frame.id,
            ok: false,
            error: match ? { code: match[1], message: match[2] } : { code: 'failed', message },
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /** @param {{ cursor: number | undefined; event: any }} entry */
  function onChatEvent(entry) {
    if (typeof entry.cursor === 'number') lastCursor = entry.cursor;
    if (clients.size === 0) return;
    send({ t: 'push', event: 'chat', data: entry });
  }

  /** @param {{ sessionId: string; controller: any }} change */
  function onControlChange(change) {
    if (change.controller.kind !== 'client' || change.controller.pluginId !== pilab.pluginId) {
      heldBy.delete(change.sessionId);
    }
    for (const clientId of clients.keys()) {
      const holder =
        change.controller.kind === 'desktop'
          ? 'desktop'
          : (holderFor(change.sessionId, clientId) ?? 'other');
      send({
        t: 'push',
        clientId,
        event: 'control',
        data: {
          sessionId: change.sessionId,
          holder,
          label: change.controller.kind === 'desktop' ? '桌面' : change.controller.label,
        },
      });
    }
  }

  /** The relay connection dropped: every client went with it. */
  async function onDisconnected() {
    const gone = [...clients.keys()];
    clients.clear();
    heldBy.clear();
    for (const clientId of gone) await pilab.chat.releaseClient(clientId).catch(() => undefined);
  }

  return {
    onFrame,
    onChatEvent,
    onControlChange,
    onDisconnected,
    methods,
    get clientCount() {
      return clients.size;
    },
  };
}

/** `IP:port`, `http://IP:port` or `https://...` → the machine socket URL. */
export function machineSocketUrl(relayUrl) {
  const text = String(relayUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!text) return null;
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `http://${text}`;
  const url = new URL(withScheme);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.pathname = '/ws/machine';
  return url.toString();
}
