import { existsSync } from 'node:fs';
import {
  isWorkerBootstrapResult,
  type WorkerBootstrapPayload,
  type WorkerBootstrapResult,
} from '@shared/types/workerRpc';
import { dshHostSupervisor } from './DshHostSupervisor';
import { WorkerSlot, type WorkerSlotOptions } from './WorkerSlot';
import type { WorkerTransport } from './WorkerTransport';

/**
 * dsh-rebase P1-1: a chat slot's bootstrap never carries a model catalog. Its
 * `auth` half held plaintext provider keys, the DSH host never read it, and
 * the host's RPC server keeps the whole bootstrap payload in memory for the
 * life of the session. The key reaches the host per request instead (P1-5,
 * decision 034). P1-1 omitted the field here; P1-12 step 3 (decision 147)
 * deleted it from `WorkerBootstrapPayload` itself, so the payload type is the
 * protocol's own.
 */
export type ChatSlotBootstrapPayload = WorkerBootstrapPayload;

export interface CreatePiWorkerSlotOptions
  extends Omit<
      WorkerSlotOptions,
      | 'transport'
      | 'generation'
      | 'slotKey'
      | 'cwd'
      | 'onEvent'
      | 'onDiagnostic'
      | 'onLifecycle'
      | 'onStderr'
    >,
    ChatSlotBootstrapPayload {
  slotKey: string;
  generation?: number;
  /** Cold-start budget for `worker.bootstrap` only; warm RPCs keep `requestTimeoutMs`. */
  bootstrapTimeoutMs?: number;
  /**
   * A user's create / resume / retry, as opposed to a crash restart: the one
   * kind of spawn allowed to try the shared host again once it has failed
   * (decision 020 rule 6).
   */
  userInitiated?: boolean;
  createTransport?: (input: {
    generation: number;
    cwd: string;
  }) => WorkerTransport | Promise<WorkerTransport>;
  /** Exposes process ownership before bootstrap awaits, for app-close force kill. */
  onSlotCreated?: (slot: WorkerSlot) => void;
  onEvent?: WorkerSlotOptions['onEvent'];
  onDiagnostic?: WorkerSlotOptions['onDiagnostic'];
  onLifecycle?: WorkerSlotOptions['onLifecycle'];
  onStderr?: WorkerSlotOptions['onStderr'];
}

export interface CreatedPiWorkerSlot {
  slot: WorkerSlot;
  bootstrap: WorkerBootstrapResult;
}

/**
 * Bootstrap gets its own, much larger budget than a warm RPC.
 *
 * `WorkerSlot`'s 10s default is sized for requests answered by a process that
 * is already up. `worker.bootstrap` is the opposite: it is the cold start, and
 * everything that only happens once is inside it — forking the utility process,
 * loading the agent-host module graph (type-stripped from source in dev),
 * parsing the session file, loading pi's extensions and binding the approval UI.
 *
 * Reusing the warm budget here made a slow-but-healthy cold start indis-
 * tinguishable from a wedged worker: on a busy machine `chat:resumeSession`
 * failed with `worker.bootstrap timed out after 10000ms` and left the session
 * unopenable until the user retried. Losing a healthy session to a 10s cutoff
 * is worse than waiting longer for a genuinely stuck one, which still fails —
 * just later.
 */
export const BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The default transport: a fresh channel on the shared host, which starts the
 * host first when none is running. The workspace is checked before anything
 * starts: DSH would otherwise open a session whose every tool fails in a
 * directory that is gone, where the renderer knows this code (`historyError`).
 */
async function openDshChannel(cwd: string, userInitiated: boolean): Promise<WorkerTransport> {
  if (!existsSync(cwd)) {
    throw new Error(`WORKER_WORKSPACE_MISSING: DSH session working directory is missing: ${cwd}`);
  }
  return dshHostSupervisor.openChannel({ userInitiated });
}

/**
 * Open and bootstrap one chat session on the DSH engine: a channel of the
 * app's one shared DSH host (decision 019).
 *
 * dsh-rebase P1-1 (decisions 004, 009): every chat session runs on DSH, in
 * packaged and unpackaged builds alike, with no switch and no native fallback.
 * The name stays until P1-12 renames the whole seam at once (decision 010).
 *
 * A bootstrap failure tears the slot down before the error escapes, so callers
 * never receive a running channel without an authoritative session.
 */
export async function createPiWorkerSlot(
  options: CreatePiWorkerSlotOptions
): Promise<CreatedPiWorkerSlot> {
  const generation = options.generation ?? 1;
  const transport = options.createTransport
    ? await options.createTransport({ generation, cwd: options.cwd })
    : await openDshChannel(options.cwd, options.userInitiated === true);
  const slot = new WorkerSlot({
    slotKey: options.slotKey,
    cwd: options.cwd,
    transport,
    generation,
    requestTimeoutMs: options.requestTimeoutMs,
    disposeTimeoutMs: options.disposeTimeoutMs,
    exitTimeoutMs: options.exitTimeoutMs,
    onEvent: options.onEvent,
    onDiagnostic: options.onDiagnostic,
    onLifecycle: options.onLifecycle,
    onStderr: options.onStderr,
  });
  options.onSlotCreated?.(slot);

  try {
    // Built field by field on purpose: spreading `options` would forward
    // whatever else a caller put on it, `modelCatalog` included.
    const result = await slot.request<WorkerBootstrapResult, ChatSlotBootstrapPayload>(
      'worker.bootstrap',
      {
        logicalSessionId: options.logicalSessionId,
        cwd: options.cwd,
        ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        // U05-c: only ever sent as `true`. Omitting it for a normal session
        // keeps `sameBootstrap`'s undefined === undefined comparison intact.
        ...(options.unbound ? { unbound: true } : {}),
        // concurrency-02: same "only ever `true`" rule as `unbound`. An
        // untouched spawn's payload is byte-identical to what it was before
        // forced takeover existed, so `sameBootstrap` keeps comparing
        // undefined === undefined.
        ...(options.forceTakeover ? { forceTakeover: true } : {}),
        // U12 fix: the tier the worker must come up on. Omitted when the
        // session is on the default, so an untouched session's bootstrap
        // payload is byte-identical to what it was before this fix.
        ...(options.tier ? { tier: options.tier } : {}),
        ...(options.permissions ? { permissions: options.permissions } : {}),
        // No delegation switch, prompt-cache TTLs, provider idle timeout or
        // model catalog: the bootstrap lost them with the native runtime
        // (dsh-rebase P1-12, decision 147). The main TTL and the timeout reach
        // the host through the model plan (decision 040); keys travel per
        // request (decision 034). See `ChatSlotBootstrapPayload`.
      },
      { timeoutMs: options.bootstrapTimeoutMs ?? BOOTSTRAP_REQUEST_TIMEOUT_MS }
    );
    if (!isWorkerBootstrapResult(result)) {
      throw new Error('Pi worker returned an invalid bootstrap acknowledgement');
    }
    return { slot, bootstrap: result };
  } catch (error) {
    try {
      await slot.dispose('slot-dispose');
    } catch {
      // The original bootstrap error is the actionable failure. WorkerSlot has
      // already killed the transport and attempted to confirm process exit.
    }
    throw error;
  }
}
