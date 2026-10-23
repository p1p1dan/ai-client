/**
 * Wire frames between PiLab (the host) and one plugin process, over the Node
 * IPC channel of a process started on the bundled Node (plugin-system README
 * §3). Symmetric request/response (`call` / `res`) plus one-way `event` from
 * host to plugin, after PI-Desktop ADR 0008 / 0040.
 *
 * Loaded as source by the plugin host process: type-only imports, `.ts`
 * suffixes, no enums.
 */

import type { PluginManifest } from './manifest.ts';

/** Methods the plugin calls on the host (the host API, v1). */
export const HOST_API_METHODS = [
  'chat.invoke',
  'chat.releaseClient',
  'chat.subscribe',
  'chat.unsubscribe',
  'chat.snapshot',
  'chat.since',
  'sessionControl.get',
  'sessionControl.acquire',
  'settings.get',
  'settings.set',
  'status.set',
] as const;
export type HostApiMethod = (typeof HOST_API_METHODS)[number];

/** Methods the host calls on the plugin. */
export type PluginCallMethod = 'service.start' | 'service.stop' | 'deactivate';

/** Events the host pushes to the plugin. */
export const PLUGIN_EVENTS = {
  chatEvent: 'chat.event',
  sessionControlChanged: 'sessionControl.changed',
  settingsChanged: 'settings.changed',
} as const;

export interface WireError {
  code: string;
  message: string;
}

export const PLUGIN_ERRORS = {
  crashed: 'PLUGIN_CRASHED',
  permissionDenied: 'PLUGIN_PERMISSION_DENIED',
  methodUnknown: 'PLUGIN_METHOD_UNKNOWN',
  channelNotAllowed: 'PLUGIN_CHANNEL_NOT_ALLOWED',
  timeout: 'PLUGIN_CALL_TIMEOUT',
  invalidArgs: 'PLUGIN_INVALID_ARGS',
  failed: 'PLUGIN_CALL_FAILED',
} as const;

export type ResponseFrame =
  | { t: 'res'; id: number; ok: true; value: unknown }
  | { t: 'res'; id: number; ok: false; error: WireError };

export type HostToPluginFrame =
  | { t: 'init'; pluginId: string; manifest: PluginManifest; pluginDir: string; dataDir: string }
  | { t: 'call'; id: number; method: PluginCallMethod; args: unknown[] }
  | { t: 'event'; name: string; payload: unknown }
  | ResponseFrame;

export type PluginToHostFrame =
  | { t: 'ready' }
  | { t: 'fail'; error: WireError }
  | { t: 'call'; id: number; method: HostApiMethod; args: unknown[] }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | ResponseFrame;

/** Budgets, after PI-Desktop ADR 0008. */
export const PLUGIN_TIMEOUTS_MS = {
  activate: 15_000,
  service: 5_000,
  deactivate: 5_000,
  hostCall: 120_000,
} as const;
