/**
 * Main <-> shared DSH host protocol (dsh-rebase P1-3, decisions 019 and 020).
 *
 * One DSH host per app instance serves every chat session over one Node IPC
 * channel (default JSON serialization). Three families share that channel:
 *
 *   session RPC    {ch, rpc}           both directions; `rpc` is a worker RPC
 *                                      message (workerRpc.ts), `ch` names the
 *                                      virtual slot it belongs to
 *   host control   {host: <kind>, ...} ping / pong, close / closed,
 *                                      gc / gc-result (P1-3d, decision 024)
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
 *   seedSession                                  P1-9
 *
 * Shared with the host bridge (P1-3a, `src/dsh-host/bridge/channelMux.ts`),
 * which a source checkout loads under Node's type stripping and the packaged
 * host gets bundled in: erasable syntax only, and no value imports.
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

/**
 * Decision 024: delete the `aiclient-*` sessions nobody can reach and nothing
 * was ever said in — not claimed (nor descended from a claimed session through
 * `parentSession`), past `graceMs` since their header was created, and holding
 * no event but the setup ones DSH writes when an agent is created. Each is
 * write-locked first, then its whole directory and its identity stub go; a
 * lock file is never removed on its own. Stubs whose session is gone, claimed
 * by nobody and past `graceMs`, go too. Answered with `gc-result`.
 */
export interface DshHostGcRequest {
  host: 'gc';
  id: number;
  /** DSH session ids the session index references, lineage included. */
  claimed: string[];
  graceMs: number;
}

export type DshMainToHostMessage =
  | DshChannelEnvelope<WorkerRpcRequest>
  | DshHostPing
  | DshHostCloseChannel
  | DshHostShutdown
  | DshHostGcRequest;

// ---- host -> Main -----------------------------------------------------------

/** Boot handshake; Main accepts it only when `pid` is the pid it spawned. */
export interface DshHostReady {
  type: 'ready';
  pid: number;
  /**
   * Plugin bundles the profile lists but the host could not load; each only
   * warned (decision 025 rule 5). A product bundle that fails refuses the boot.
   */
  skippedPlugins?: Array<{ packageName: string; reason: string }>;
  /** Boot diagnostics (versions, composition, marks, later plan revision). */
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

/**
 * The channel's runtime is disposed and its session lock released. Sent after
 * a `close`, and after the ACK of the channel's own `worker.dispose`; nothing
 * more is sent for the channel afterwards.
 */
export interface DshHostChannelClosed {
  host: 'closed';
  ch: DshChannelId;
}

/** Why `gc` left a session (or a stub) alone. */
export type DshHostGcSkipReason =
  /** Not an `aiclient-*` session: never ours to delete. */
  | 'foreign'
  /** Claimed by the index, or a descendant of a claimed session. */
  | 'claimed'
  /** Created less than `graceMs` ago. */
  | 'recent'
  /** Something was said in it (or it is too large to hold only setup events). */
  | 'content'
  /** A writer holds its lock. */
  | 'locked'
  /** Created in the host but not on disk yet. */
  | 'unmaterialized'
  /** Its directory is not where, or not what, a session directory should be. */
  | 'unexpected'
  /** An error while checking or deleting it. */
  | 'failed';

export const DSH_HOST_GC_SKIP_REASONS: readonly DshHostGcSkipReason[] = [
  'foreign',
  'claimed',
  'recent',
  'content',
  'locked',
  'unmaterialized',
  'unexpected',
  'failed',
];

/** Answer to `gc`, echoing its id. `ok: false` when it could not run at all. */
export interface DshHostGcResult {
  host: 'gc-result';
  id: number;
  ok: boolean;
  /** Session ids whose directory was deleted. */
  deleted: string[];
  /** Identity stubs deleted: those of the deleted sessions and orphaned ones. */
  stubsDeleted: number;
  /** Sessions and stubs left alone, per reason. */
  skipped: Partial<Record<DshHostGcSkipReason, number>>;
  ms: number;
  error?: string;
}

export type DshHostToMainMessage =
  | DshHostReady
  | DshHostFatal
  | DshHostStopped
  | DshChannelEnvelope<WorkerRpcMessage>
  | DshHostPong
  | DshHostChannelClosed
  | DshHostGcResult;

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

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isDshHostGcRequest(value: unknown): value is DshHostGcRequest {
  return (
    isRecord(value) &&
    value.host === 'gc' &&
    isPositiveSafeInteger(value.id) &&
    isStringList(value.claimed) &&
    isNonNegativeFinite(value.graceMs)
  );
}

export function isDshHostGcResult(value: unknown): value is DshHostGcResult {
  if (
    !isRecord(value) ||
    value.host !== 'gc-result' ||
    !isPositiveSafeInteger(value.id) ||
    typeof value.ok !== 'boolean' ||
    !isStringList(value.deleted) ||
    !isNonNegativeFinite(value.stubsDeleted) ||
    !isNonNegativeFinite(value.ms) ||
    (value.error !== undefined && typeof value.error !== 'string') ||
    !isRecord(value.skipped)
  ) {
    return false;
  }
  const skipped = value.skipped;
  return Object.keys(skipped).every(
    (reason) =>
      (DSH_HOST_GC_SKIP_REASONS as readonly string[]).includes(reason) &&
      isNonNegativeFinite(skipped[reason])
  );
}
