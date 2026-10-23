/**
 * The PiLab plugin API, v1 — what a plugin's `activate(pilab)` receives.
 *
 * This file is the plugin SDK: a plugin imports these types and exports a
 * `PluginModule`. Everything here runs in the plugin's own process; each call
 * crosses to PiLab over RPC and passes the API allowlist, the plugin's
 * declared permissions and the audit log there.
 */

import type { RuntimeEvent } from '../types/runtimeEvents.ts';
import type { SessionControlChange, SessionController } from '../types/sessionControl.ts';
import type { JournalCatchUp, SessionLiveSnapshot } from '../types/sessionLive.ts';

export interface PluginStatus {
  state: 'idle' | 'ok' | 'warning' | 'error';
  /** One line for the Plugins page. */
  text?: string;
}

export interface PluginChatEvent {
  /** Journal cursor; absent for events that are not journalled (history pages). */
  cursor: number | undefined;
  event: RuntimeEvent;
}

export interface PluginService {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface PilabPluginApi {
  readonly pluginId: string;
  /** Read-only: where the plugin's files were installed. */
  readonly pluginDir: string;
  /** The plugin's own writable directory; survives updates, removed on uninstall. */
  readonly dataDir: string;

  chat: {
    /**
     * Run a chat call for one of the plugin's clients. `clientId` is the
     * plugin's own name for a client (one per connected device, say); the
     * host gives each its own owner id. Channels are listed in
     * `chatChannels.ts`; reads need `chat.read`, changes `chat.control`.
     */
    invoke<T = unknown>(clientId: string, channel: string, payload?: unknown): Promise<T>;
    /** The client went away: its claims and its control of any session end. */
    releaseClient(clientId: string): Promise<void>;
    /** Every runtime event the windows see, in order (`chat.read`). */
    onEvent(listener: (event: PluginChatEvent) => void): () => void;
    /** What a client opening a session needs to catch up (`chat.read`). */
    snapshot(sessionId: string): Promise<SessionLiveSnapshot>;
    /** What a reconnecting client missed since `cursor` (`chat.read`). */
    since(cursor: number): Promise<JournalCatchUp>;
  };

  sessionControl: {
    get(sessionId: string): Promise<SessionController>;
    /** Take a session over for a client (`chat.control`). */
    acquire(sessionId: string, clientId: string, label: string): Promise<void>;
    onChange(listener: (change: SessionControlChange) => void): () => void;
  };

  settings: {
    /** Values of the declared settings, secrets decrypted; unset ones take their default. */
    get(): Promise<Record<string, unknown>>;
    set(key: string, value: unknown): Promise<void>;
    onChange(listener: (values: Record<string, unknown>) => void): () => void;
  };

  services: {
    /** Bind the code of a service declared in `contributes.services`; PiLab decides when it runs. */
    register(id: string, service: PluginService): void;
  };

  status: {
    set(status: PluginStatus): Promise<void>;
  };

  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

/** What a plugin's `main` exports. */
export interface PluginModule {
  activate(pilab: PilabPluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
