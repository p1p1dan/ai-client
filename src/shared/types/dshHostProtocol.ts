/**
 * Main <-> shared DSH host protocol (dsh-rebase P1-3, decisions 019 and 020).
 *
 * One DSH host per app instance serves every chat session over one Node IPC
 * channel (default JSON serialization). Three families share that channel:
 *
 *   session RPC    {ch, rpc}           both directions; `rpc` is a worker RPC
 *                                      message (workerRpc.ts), `ch` names the
 *                                      virtual slot it belongs to
 *   host control   {host: <kind>, ...} ping / pong, close / closed
 *   lifecycle      {type: <kind>, ...} host.ts's own boot and stop messages
 *
 * Channel ids are minted by Main, one per virtual slot, and never reused. Only
 * a channel-opening request (`worker.bootstrap`) may create a channel on the
 * host; any other request addressed to an unknown channel is answered with a
 * worker RPC error `WORKER_CHANNEL_UNKNOWN`.
 *
 * Reserved control kinds, added by the tasks that need them and dropped with a
 * diagnostic by whichever side does not know them yet:
 *   configure / credential / credential-result   P1-5 (decisions 033, 034)
 *   readPage / page                              P1-4 (decision 030)
 *   gc                                           P1-3d (decision 024)
 *   seedSession                                  P1-9
 *
 * Shared with the host bridge (P1-3a), which loads this file as source under
 * Node's type stripping: erasable syntax only, and no value imports.
 */

import type { WorkerRpcMessage, WorkerRpcRequest } from './workerRpc';

/** `c<host generation>-<sequence>`; the sequence never restarts, so an id is never reused. */
export type DshChannelId = string;

const CHANNEL_ID_PATTERN = /^c[1-9][0-9]*-[1-9][0-9]*$/;

/**
 * Worker RPC methods allowed to open a channel on the host. P1-15 adds
 * `utility.start` for one-shot completions (decision 039).
 */
export const DSH_CHANNEL_OPENING_METHODS: readonly string[] = ['worker.bootstrap'];

/** Error code the host answers for a non-opening request on an unknown channel. */
export const DSH_CHANNEL_UNKNOWN_CODE = 'WORKER_CHANNEL_UNKNOWN';

/** Session RPC for one channel, in either direction. */
export interface DshChannelEnvelope<TRpc = unknown> {
  ch: DshChannelId;
  rpc: TRpc;
}

// ---- Main -> host -----------------------------------------------------------

/** Heartbeat. The host answers straight from its IPC handler, never behind session work. */
export interface DshHostPing {
  host: 'ping';
  id: number;
}

/**
 * Close one channel: dispose its runtime if it is still live, then answer
 * `closed`. A channel the host does not know (never bootstrapped, or already
 * closed) is answered with `closed` at once. A disposal that hangs is never
 * answered; Main escalates to a host restart.
 */
export interface DshHostCloseChannel {
  host: 'close';
  ch: DshChannelId;
}

/** Host-wide graceful stop, as host.ts already understands it. */
export interface DshHostShutdown {
  type: 'shutdown';
}

export type DshMainToHostMessage =
  | DshChannelEnvelope<WorkerRpcRequest>
  | DshHostPing
  | DshHostCloseChannel
  | DshHostShutdown;

// ---- host -> Main -----------------------------------------------------------

/** Boot handshake; Main accepts it only when `pid` is the pid it spawned. */
export interface DshHostReady {
  type: 'ready';
  pid: number;
  /** Boot diagnostics (versions, composition, marks, later plan revision and skipped plugins). */
  [detail: string]: unknown;
}

/** Boot refused; the host exits right after sending it. */
export interface DshHostFatal {
  type: 'fatal';
  message?: string;
}

/** Sent after the host disposed everything, just before it disconnects and exits. */
export interface DshHostStopped {
  type: 'stopped';
  ms?: number;
  reason?: string;
}

export interface DshHostChannelStatus {
  ch: DshChannelId;
  /** The channel's agent is not idle (a turn, goal auto-continuation, or background work). */
  busy: boolean;
}

/** Answer to `ping`, echoing its id. */
export interface DshHostPong {
  host: 'pong';
  id: number;
  /** Worst event-loop delay since the previous pong. */
  eldMaxMs: number;
  /** Resident set size. */
  rssMb: number;
  channels: DshHostChannelStatus[];
}

/** The channel's runtime is disposed and its session lock released. */
export interface DshHostChannelClosed {
  host: 'closed';
  ch: DshChannelId;
}

export type DshHostToMainMessage =
  | DshHostReady
  | DshHostFatal
  | DshHostStopped
  | DshChannelEnvelope<WorkerRpcMessage>
  | DshHostPong
  | DshHostChannelClosed;

// ---- guards -------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isDshChannelId(value: unknown): value is DshChannelId {
  return typeof value === 'string' && CHANNEL_ID_PATTERN.test(value);
}

export function formatDshChannelId(hostGeneration: number, sequence: number): DshChannelId {
  if (!isPositiveSafeInteger(hostGeneration) || !isPositiveSafeInteger(sequence)) {
    throw new Error(`Invalid DSH channel id parts: ${hostGeneration}, ${sequence}`);
  }
  return `c${hostGeneration}-${sequence}`;
}

/** `{ch, rpc}` in either direction; the RPC itself is validated by the slot that owns it. */
export function isDshChannelEnvelope(value: unknown): value is DshChannelEnvelope {
  return isRecord(value) && isDshChannelId(value.ch) && isRecord(value.rpc);
}

/** Whether `rpc` may create a channel on the host (see DSH_CHANNEL_OPENING_METHODS). */
export function opensDshChannel(rpc: unknown): boolean {
  return (
    isRecord(rpc) &&
    rpc.kind === 'request' &&
    typeof rpc.type === 'string' &&
    DSH_CHANNEL_OPENING_METHODS.includes(rpc.type)
  );
}

/** The `host` kind of a control message, known or not; undefined for anything else. */
export function dshHostControlKind(value: unknown): string | undefined {
  return isRecord(value) && typeof value.host === 'string' ? value.host : undefined;
}

export function isDshHostPing(value: unknown): value is DshHostPing {
  return isRecord(value) && value.host === 'ping' && isPositiveSafeInteger(value.id);
}

export function isDshHostCloseChannel(value: unknown): value is DshHostCloseChannel {
  return isRecord(value) && value.host === 'close' && isDshChannelId(value.ch);
}

export function isDshHostShutdown(value: unknown): value is DshHostShutdown {
  return isRecord(value) && value.type === 'shutdown';
}

export function isDshHostReady(value: unknown): value is DshHostReady {
  return isRecord(value) && value.type === 'ready' && isPositiveSafeInteger(value.pid);
}

export function isDshHostFatal(value: unknown): value is DshHostFatal {
  return (
    isRecord(value) &&
    value.type === 'fatal' &&
    (value.message === undefined || typeof value.message === 'string')
  );
}

export function isDshHostStopped(value: unknown): value is DshHostStopped {
  return isRecord(value) && value.type === 'stopped';
}

export function isDshHostPong(value: unknown): value is DshHostPong {
  return (
    isRecord(value) &&
    value.host === 'pong' &&
    isPositiveSafeInteger(value.id) &&
    isNonNegativeFinite(value.eldMaxMs) &&
    isNonNegativeFinite(value.rssMb) &&
    Array.isArray(value.channels) &&
    value.channels.every(
      (channel) =>
        isRecord(channel) && isDshChannelId(channel.ch) && typeof channel.busy === 'boolean'
    )
  );
}

export function isDshHostChannelClosed(value: unknown): value is DshHostChannelClosed {
  return isRecord(value) && value.host === 'closed' && isDshChannelId(value.ch);
}
