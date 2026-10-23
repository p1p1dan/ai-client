import type { PluginStatus } from '@shared/plugins/api';
import {
  PLUGIN_CHAT_CONTROL_CHANNELS,
  PLUGIN_CHAT_READ_CHANNELS,
} from '@shared/plugins/chatChannels';
import type { PluginManifest, PluginPermission } from '@shared/plugins/manifest';
import { type HostApiMethod, PLUGIN_ERRORS } from '@shared/plugins/protocol';
import type { SessionController } from '@shared/types/sessionControl';
import type { JournalCatchUp, SessionLiveSnapshot } from '@shared/types/sessionLive';
import type { ChatCaller } from '../chat/chatCaller';

/**
 * The host API, for one plugin (plugin-system README §3, after PI-Desktop ADR
 * 0008): every call passes the method allowlist (`PluginProcess`), then the
 * permission the plugin declared, then argument checks, and changes are
 * written to the audit log. The plugin's clients live here: each gets its own
 * owner id, and all of them are released when the plugin stops.
 */

export interface PluginAuditEntry {
  at: number;
  pluginId: string;
  method: HostApiMethod;
  channel?: string;
  sessionId?: string;
  clientId?: string;
  ok: boolean;
  error?: string;
}

export interface PluginBrokerDeps {
  invokeChat(channel: string, caller: ChatCaller, args: unknown[]): Promise<unknown>;
  snapshot(sessionId: string): SessionLiveSnapshot;
  since(cursor: number): JournalCatchUp;
  getController(sessionId: string): SessionController;
  acquireForClient(
    sessionId: string,
    client: { ownerId: number; pluginId: string; label: string }
  ): void;
  releaseOwner(ownerId: number): void;
  allocateOwnerId(): number;
  readSettings(): Record<string, unknown>;
  writeSetting(key: string, value: unknown): void;
  setStatus(status: PluginStatus): void;
  setChatSubscribed(subscribed: boolean): void;
  audit(entry: PluginAuditEntry): void;
  now?: () => number;
}

export class PluginBrokerError extends Error {
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PluginBrokerError';
  }
}

interface Client {
  ownerId: number;
  caller: ChatCaller;
  goneListeners: Set<() => void>;
}

const MAX_CLIENTS = 64;
const STATUS_STATES = new Set(['idle', 'ok', 'warning', 'error']);

function text(value: unknown, what: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new PluginBrokerError(PLUGIN_ERRORS.invalidArgs, `${what} must be a string of 1-${max}`);
  }
  return value;
}

export class PluginBroker {
  private readonly clients = new Map<string, Client>();
  private readonly permissions: ReadonlySet<PluginPermission>;
  private readonly now: () => number;

  constructor(
    private readonly manifest: PluginManifest,
    private readonly deps: PluginBrokerDeps
  ) {
    this.permissions = new Set(manifest.permissions);
    this.now = deps.now ?? Date.now;
  }

  get pluginId(): string {
    return this.manifest.id;
  }

  async handle(method: HostApiMethod, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'chat.invoke':
        return this.invoke(args);
      case 'chat.releaseClient': {
        this.requireAny('chat.read', 'chat.control');
        const clientId = text(args[0], 'clientId', 128);
        this.releaseClient(clientId);
        this.audit({ method, clientId, ok: true });
        return null;
      }
      case 'chat.subscribe':
      case 'chat.unsubscribe':
        this.require('chat.read');
        this.deps.setChatSubscribed(method === 'chat.subscribe');
        return null;
      case 'chat.snapshot':
        this.require('chat.read');
        return this.deps.snapshot(text(args[0], 'sessionId'));
      case 'chat.since': {
        this.require('chat.read');
        const cursor = args[0];
        if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) {
          throw new PluginBrokerError(PLUGIN_ERRORS.invalidArgs, 'cursor must be a whole number');
        }
        return this.deps.since(cursor);
      }
      case 'sessionControl.get':
        this.requireAny('chat.read', 'chat.control');
        return this.deps.getController(text(args[0], 'sessionId'));
      case 'sessionControl.acquire': {
        this.require('chat.control');
        const sessionId = text(args[0], 'sessionId');
        const clientId = text(args[1], 'clientId', 128);
        const label = text(args[2], 'label', 64);
        const client = this.client(clientId);
        this.deps.acquireForClient(sessionId, {
          ownerId: client.ownerId,
          pluginId: this.manifest.id,
          label,
        });
        this.audit({ method, sessionId, clientId, ok: true });
        return null;
      }
      case 'settings.get':
        return this.deps.readSettings();
      case 'settings.set':
        this.deps.writeSetting(text(args[0], 'key', 64), args[1]);
        return null;
      case 'status.set': {
        const status = args[0] as Partial<PluginStatus> | undefined;
        if (!status || !STATUS_STATES.has(String(status.state))) {
          throw new PluginBrokerError(PLUGIN_ERRORS.invalidArgs, 'status.state is not valid');
        }
        this.deps.setStatus({
          state: status.state as PluginStatus['state'],
          ...(typeof status.text === 'string' ? { text: status.text.slice(0, 200) } : {}),
        });
        return null;
      }
      default:
        throw new PluginBrokerError(PLUGIN_ERRORS.methodUnknown, `unknown method ${method}`);
    }
  }

  /** The plugin stopped or crashed: every client it had is gone. */
  releaseAllClients(): void {
    for (const clientId of [...this.clients.keys()]) this.releaseClient(clientId);
  }

  private async invoke(args: unknown[]): Promise<unknown> {
    const clientId = text(args[0], 'clientId', 128);
    const channel = text(args[1], 'channel', 64);
    const payload = args[2];
    const isControl = PLUGIN_CHAT_CONTROL_CHANNELS.has(channel);
    if (!isControl && !PLUGIN_CHAT_READ_CHANNELS.has(channel)) {
      throw new PluginBrokerError(
        PLUGIN_ERRORS.channelNotAllowed,
        `${channel} is not open to plugins`
      );
    }
    this.require(isControl ? 'chat.control' : 'chat.read');
    const client = this.client(clientId);
    const sessionId = (payload as { sessionId?: unknown } | undefined)?.sessionId;
    try {
      const result = await this.deps.invokeChat(
        channel,
        client.caller,
        payload === undefined ? [] : [payload]
      );
      if (isControl) {
        this.audit({
          method: 'chat.invoke',
          channel,
          clientId,
          ...(typeof sessionId === 'string' ? { sessionId } : {}),
          ok: true,
        });
      }
      return result;
    } catch (error) {
      if (isControl) {
        this.audit({
          method: 'chat.invoke',
          channel,
          clientId,
          ...(typeof sessionId === 'string' ? { sessionId } : {}),
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private client(clientId: string): Client {
    const existing = this.clients.get(clientId);
    if (existing) return existing;
    if (this.clients.size >= MAX_CLIENTS) {
      throw new PluginBrokerError(PLUGIN_ERRORS.invalidArgs, `more than ${MAX_CLIENTS} clients`);
    }
    const ownerId = this.deps.allocateOwnerId();
    const goneListeners = new Set<() => void>();
    const client: Client = {
      ownerId,
      goneListeners,
      caller: {
        ownerId,
        onGone: (listener) => {
          goneListeners.add(listener);
        },
      },
    };
    this.clients.set(clientId, client);
    return client;
  }

  private releaseClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    this.deps.releaseOwner(client.ownerId);
    for (const listener of client.goneListeners) {
      try {
        listener();
      } catch (error) {
        console.warn(`[plugins] ${this.manifest.id}: a client release listener threw:`, error);
      }
    }
  }

  private require(permission: PluginPermission): void {
    if (this.permissions.has(permission)) return;
    throw new PluginBrokerError(
      PLUGIN_ERRORS.permissionDenied,
      `${this.manifest.id} did not declare ${permission}`
    );
  }

  private requireAny(...permissions: PluginPermission[]): void {
    if (permissions.some((permission) => this.permissions.has(permission))) return;
    throw new PluginBrokerError(
      PLUGIN_ERRORS.permissionDenied,
      `${this.manifest.id} declared none of ${permissions.join(', ')}`
    );
  }

  private audit(entry: Omit<PluginAuditEntry, 'at' | 'pluginId'>): void {
    try {
      this.deps.audit({ at: this.now(), pluginId: this.manifest.id, ...entry });
    } catch (error) {
      console.warn('[plugins] audit write failed:', error);
    }
  }
}
