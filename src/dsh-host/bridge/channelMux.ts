/**
 * The shared DSH host's channel multiplexer (dsh-rebase P1-3a, decision 019).
 *
 * One host serves every chat session over the one Node IPC channel Main's
 * DshHostSupervisor opened. Each channel is a virtual slot with its own,
 * unmodified `PiWorkerRpcServer` and session runtime — the pair the P1-1
 * one-session bridge ran. Protocol: `src/shared/types/dshHostProtocol.ts`.
 *
 *   {ch, rpc}           to the channel's server. Only a channel-opening
 *                       request (`worker.bootstrap`) creates a channel, with
 *                       the generation it carries; any other request for an
 *                       unknown or closed channel is answered
 *                       WORKER_CHANNEL_UNKNOWN with its own generation and
 *                       requestId.
 *   {host:'ping', id}   answered at once, from this handler: event-loop delay,
 *                       RSS and which channels are busy.
 *   {host:'close', ch}  disposes the channel's runtime through the channel's
 *                       own request chain, then `closed`. An unknown or closed
 *                       channel is answered `closed` at once; a disposal that
 *                       hangs is never answered (Main escalates).
 *   {host:'gc', id, …}  collects orphaned empty sessions (decision 024,
 *                       `sessionGc.ts`), one pass at a time, answered
 *                       `gc-result` with the same id; never rejects.
 *   {host:'readPage', id, …}
 *                       one page of a session's history for Main's preview
 *                       (decision 030, `readPage.ts`): no channel, no lock,
 *                       no write. Reads run side by side, each answered
 *                       `page` with its id, the page or the error's code.
 *   {host:'seedSession', id, …}
 *                       a legacy pi session file made a DSH session (decision
 *                       054, `seedSession.ts`): one migration at a time,
 *                       queued behind any still running, answered `seeded`
 *                       with the same id, what was made or where it stopped.
 *                       A request with a usable id and bad fields is answered
 *                       `seed_request_invalid`, never dropped: Main waits on it.
 *
 * A channel's own `worker.dispose` closes that channel only: its ACK goes out,
 * then `closed`, and nothing more for that channel after it. Messages that are
 * neither (host.ts's lifecycle, probe operations) are not the multiplexer's.
 */

import {
  PiWorkerRpcServer,
  type PiWorkerRuntime,
  type PiWorkerRuntimeOptions,
} from '../../agent-host/piWorkerRpcServer.ts';
import {
  DSH_CHANNEL_UNKNOWN_CODE,
  DSH_SEED_REQUEST_INVALID,
  DSH_SEED_UNAVAILABLE,
  type DshChannelId,
  type DshHostChannelStatus,
  type DshHostGcRequest,
  type DshHostGcResult,
  type DshHostPage,
  type DshHostReadPageRequest,
  type DshHostSeeded,
  type DshHostSeedSessionRequest,
  type DshHostToMainMessage,
  type DshSeedSessionResult,
  dshHostControlKind,
  isDshChannelEnvelope,
  isDshHostCloseChannel,
  isDshHostGcRequest,
  isDshHostPing,
  isDshHostReadPageRequest,
  isDshHostSeedSessionRequest,
  isDshSeedStage,
  opensDshChannel,
} from '../../shared/types/dshHostProtocol.ts';
import type { SessionHistoryPage } from '../../shared/types/sessionHistory.ts';
import {
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerRpcErrorResponse,
  type WorkerRpcMessage,
  type WorkerRpcRequest,
} from '../../shared/types/workerRpc.ts';

/** A session runtime the multiplexer can report on. */
export interface ChannelRuntime extends PiWorkerRuntime {
  /** Not idle: a turn, a goal round or other agent work is under way. */
  readonly busy?: boolean;
}

export interface DshChannelMuxOptions {
  /** Puts one message on the host's IPC channel (a no-op once it is gone). */
  send(message: DshHostToMainMessage): void;
  /** The runtime behind a channel's `worker.bootstrap`. */
  createRuntime(options: PiWorkerRuntimeOptions): ChannelRuntime;
  /** Event-loop delay since the previous call, and resident memory, for a pong. */
  sample(): { eldMaxMs: number; rssMb: number };
  /** Decision 024's orphan collection; without it a `gc` is answered `ok: false`. */
  collectSessions?(request: {
    claimed: readonly string[];
    graceMs: number;
  }): Promise<Omit<DshHostGcResult, 'host' | 'id'>>;
  /** Decision 030's read-only page; without it a `readPage` is answered `ok: false`. */
  readPage?(request: {
    stubFile: string;
    logicalSessionId: string;
    offset?: number;
    limit?: number;
  }): Promise<SessionHistoryPage>;
  /**
   * Decision 054's migration; without it a `seedSession` is answered
   * `seed_unavailable`. A rejection carrying `stage`, `code` and `retryable`
   * (`SeedSessionError`) is answered with them.
   */
  seedSession?(
    request: Omit<DshHostSeedSessionRequest, 'host' | 'id'>
  ): Promise<DshSeedSessionResult>;
  log(...args: unknown[]): void;
}

/** The code of a `page` answer whose read failed without one of its own. */
export const DSH_READ_FAILED = 'dsh_read_failed';

/** Closed channel ids remembered so a late opening request cannot revive one. */
const CLOSED_IDS_KEPT = 4096;

interface Channel {
  readonly ch: DshChannelId;
  readonly generation: number;
  readonly server: PiWorkerRpcServer;
  runtime: ChannelRuntime | null;
  closing: boolean;
  closed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function unsupported(what: string): Error {
  return Object.assign(new Error(`${what} is not bridged to the DSH engine`), {
    code: 'WORKER_DSH_UNSUPPORTED',
  });
}

function seedFailure(
  id: number,
  ms: number,
  error: NonNullable<DshHostSeeded['error']>
): DshHostSeeded {
  return { host: 'seeded', id, ok: false, error, ms };
}

/** Request id of the dispose a `close` queues; never one Main mints (`rpc-…`). */
function closeRequestId(ch: DshChannelId): string {
  return `dsh-host-close-${ch}`;
}

export class DshChannelMux {
  private readonly channels = new Map<DshChannelId, Channel>();
  private readonly closedIds = new Set<DshChannelId>();
  private readonly warned = new Set<string>();
  private readonly options: DshChannelMuxOptions;
  /** One collection pass at a time; a link that never rejects. */
  private gcChain: Promise<void> = Promise.resolve();
  /** One migration at a time (plan P1-9 §4.3); a link that never rejects. */
  private seedChain: Promise<void> = Promise.resolve();

  constructor(options: DshChannelMuxOptions) {
    this.options = options;
  }

  /** Handles a bridge message; false for anything that is not the multiplexer's. */
  receive(message: unknown): boolean {
    if (isDshHostPing(message)) {
      this.options.send({
        host: 'pong',
        id: message.id,
        ...this.options.sample(),
        channels: this.status(),
      });
      return true;
    }
    if (isDshHostCloseChannel(message)) {
      this.close(message.ch);
      return true;
    }
    if (isDshChannelEnvelope(message)) {
      this.route(message.ch, message.rpc);
      return true;
    }
    if (isDshHostGcRequest(message)) {
      this.gc(message);
      return true;
    }
    if (isDshHostReadPageRequest(message)) {
      this.readPage(message);
      return true;
    }
    if (isDshHostSeedSessionRequest(message)) {
      this.seedSession(message);
      return true;
    }
    const kind = dshHostControlKind(message);
    if (kind === 'seedSession') {
      const id = (message as { id?: unknown }).id;
      if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
        this.options.send(
          seedFailure(id, 0, {
            stage: 'request',
            code: DSH_SEED_REQUEST_INVALID,
            message: 'seedSession fields are not what the protocol says',
            retryable: false,
          })
        );
        return true;
      }
    }
    if (kind !== undefined) {
      this.warnOnce(
        `control:${kind}`,
        kind === 'gc' || kind === 'readPage' || kind === 'seedSession'
          ? `dropped a malformed ${kind} request`
          : `dropped host control message "${kind}"`
      );
      return true;
    }
    if (isRecord(message) && 'ch' in message) {
      this.warnOnce('malformed-envelope', 'dropped a malformed channel envelope');
      return true;
    }
    return false;
  }

  /** Live channels and whether each is busy. */
  status(): DshHostChannelStatus[] {
    return [...this.channels.values()].map((channel) => ({
      ch: channel.ch,
      busy: channel.runtime?.busy === true,
    }));
  }

  private route(ch: DshChannelId, rpc: unknown): void {
    const channel = this.channels.get(ch);
    if (channel) {
      channel.server.receive(rpc);
      return;
    }
    if (opensDshChannel(rpc) && !this.closedIds.has(ch)) {
      const generation = (rpc as { generation?: unknown }).generation;
      if (!isGeneration(generation)) {
        this.warnOnce(
          'bad-generation',
          `${ch}: dropped a channel-opening request without a valid generation`
        );
        return;
      }
      this.open(ch, generation).server.receive(rpc);
      return;
    }
    this.refuse(ch, rpc);
  }

  private open(ch: DshChannelId, generation: number): Channel {
    const channel: Channel = {
      ch,
      generation,
      runtime: null,
      closing: false,
      closed: false,
      server: new PiWorkerRpcServer({
        port: { postMessage: (rpc) => this.forward(channel, rpc) },
        generation,
        // Same constant the native worker entry passes (decision 009).
        projectTrusted: true,
        createRuntime: (runtimeOptions) => {
          const runtime = this.options.createRuntime(runtimeOptions);
          channel.runtime = runtime;
          return runtime;
        },
        createImportWriter: () => {
          throw unsupported('Conversation import');
        },
        createUtilityRuntime: () => {
          throw unsupported('One-shot completion');
        },
        log: (...args) => this.options.log(`[${ch}]`, ...args),
        onDisposed: () => this.onDisposed(channel),
      }),
    };
    this.channels.set(ch, channel);
    return channel;
  }

  private forward(channel: Channel, rpc: unknown): void {
    // After `closed` the channel is gone for Main; the answer to the dispose a
    // `close` queued was never Main's to begin with.
    if (channel.closed) return;
    if (isRecord(rpc) && rpc.requestId === closeRequestId(channel.ch)) return;
    this.options.send({ ch: channel.ch, rpc: rpc as WorkerRpcMessage });
  }

  private close(ch: DshChannelId): void {
    const channel = this.channels.get(ch);
    if (!channel) {
      this.options.send({ host: 'closed', ch });
      return;
    }
    if (channel.closing) return;
    channel.closing = true;
    // Through the channel's own chain: never beside a request still running,
    // and a request stuck ahead of it keeps `closed` from going out.
    const dispose: WorkerRpcRequest = {
      protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      kind: 'request',
      generation: channel.generation,
      requestId: closeRequestId(ch),
      type: 'worker.dispose',
      payload: { reason: 'slot-dispose' },
    };
    channel.server.receive(dispose);
  }

  private onDisposed(channel: Channel): void {
    if (channel.closed) return;
    channel.closed = true;
    if (this.channels.get(channel.ch) === channel) this.channels.delete(channel.ch);
    this.closedIds.add(channel.ch);
    if (this.closedIds.size > CLOSED_IDS_KEPT) {
      const oldest = this.closedIds.values().next().value;
      if (oldest !== undefined) this.closedIds.delete(oldest);
    }
    this.options.send({ host: 'closed', ch: channel.ch });
  }

  /**
   * Queued behind any pass still running. The pass itself never throws out of
   * here: an unhandled rejection would take the whole host down (installFailLoud).
   */
  private gc(request: DshHostGcRequest): void {
    const run = async (): Promise<DshHostGcResult> => {
      const started = performance.now();
      const failed = (error: string): DshHostGcResult => ({
        host: 'gc-result',
        id: request.id,
        ok: false,
        deleted: [],
        stubsDeleted: 0,
        skipped: {},
        ms: Math.round(performance.now() - started),
        error,
      });
      const collect = this.options.collectSessions;
      if (!collect) return failed('session collection is not available on this host');
      try {
        const outcome = await collect({ claimed: request.claimed, graceMs: request.graceMs });
        return { ...outcome, host: 'gc-result', id: request.id };
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }
    };
    this.gcChain = this.gcChain
      .then(run)
      .then((result) => this.options.send(result))
      .catch((error: unknown) => this.options.log('gc answer failed', error));
  }

  /**
   * Not queued behind anything: a read takes no lock and writes nothing, so
   * it may run beside a session's turn, a gc pass or another read. Never
   * rejects, for the same reason `gc` never does.
   */
  private readPage(request: DshHostReadPageRequest): void {
    const started = performance.now();
    const answer = (outcome: Pick<DshHostPage, 'ok' | 'page' | 'error'>): void =>
      this.options.send({
        host: 'page',
        id: request.id,
        ...outcome,
        ms: Math.round((performance.now() - started) * 10) / 10,
      });
    const read = this.options.readPage;
    if (!read) {
      answer({
        ok: false,
        error: { code: DSH_READ_FAILED, message: 'history reads are not available on this host' },
      });
      return;
    }
    Promise.resolve()
      .then(() =>
        read({
          stubFile: request.stubFile,
          logicalSessionId: request.logicalSessionId,
          ...(request.offset !== undefined ? { offset: request.offset } : {}),
          ...(request.limit !== undefined ? { limit: request.limit } : {}),
        })
      )
      .then(
        (page) => answer({ ok: true, page }),
        (error: unknown) => {
          const code = (error as { code?: unknown } | null)?.code;
          answer({
            ok: false,
            error: {
              code: typeof code === 'string' && code.length > 0 ? code : DSH_READ_FAILED,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      )
      .catch((error: unknown) => this.options.log('readPage answer failed', error));
  }

  /**
   * Queued behind any migration still running (they create sessions and
   * admit images; one at a time keeps the host's load bounded). Never
   * rejects, for the same reason `gc` never does.
   */
  private seedSession(request: DshHostSeedSessionRequest): void {
    const queued = performance.now();
    const elapsed = () => Math.round((performance.now() - queued) * 10) / 10;
    const run = async (): Promise<DshHostSeeded> => {
      const migrate = this.options.seedSession;
      if (!migrate) {
        return seedFailure(request.id, elapsed(), {
          stage: 'request',
          code: DSH_SEED_UNAVAILABLE,
          message: 'migration is not available on this host',
          retryable: false,
        });
      }
      const { host: _host, id: _id, ...fields } = request;
      try {
        const result = await migrate(fields);
        return { host: 'seeded', id: request.id, ok: true, result, ms: elapsed() };
      } catch (error) {
        const failure = error as { stage?: unknown; code?: unknown; retryable?: unknown } | null;
        const stage = failure?.stage;
        const code = failure?.code;
        return seedFailure(request.id, elapsed(), {
          stage: isDshSeedStage(stage) ? stage : 'create',
          code: typeof code === 'string' && code.length > 0 ? code : 'seed_failed',
          message: error instanceof Error ? error.message : String(error),
          retryable: failure?.retryable === true,
        });
      }
    };
    this.seedChain = this.seedChain
      .then(run)
      .then((answer) => this.options.send(answer))
      .catch((error: unknown) => this.options.log('seedSession answer failed', error));
  }

  /** A request for a channel this host does not serve: answered, never dropped silently. */
  private refuse(ch: DshChannelId, rpc: unknown): void {
    if (
      !isRecord(rpc) ||
      rpc.kind !== 'request' ||
      !isGeneration(rpc.generation) ||
      typeof rpc.requestId !== 'string' ||
      rpc.requestId.length === 0
    ) {
      this.warnOnce('unknown-channel', `${ch}: dropped a message for a channel that is not open`);
      return;
    }
    const response: WorkerRpcErrorResponse = {
      protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      kind: 'response',
      generation: rpc.generation,
      requestId: rpc.requestId,
      ok: false,
      error: {
        code: DSH_CHANNEL_UNKNOWN_CODE,
        message: `DSH channel ${ch} is not open on this host`,
        retryable: false,
      },
    };
    this.options.send({ ch, rpc: response });
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.options.log(message);
  }
}
