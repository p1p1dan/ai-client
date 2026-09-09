import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { samePiSessionPath } from '../../agent-host/piSessionPreflight.ts';
import { paginatePiSessionHistory } from '../../agent-host/piSessionTimeline.ts';
import type { ExtensionUiResponse, RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import {
  migratePermissionTier,
  type RuntimePermissionSettings,
} from '../../shared/types/runtimePermission.ts';
import type { SessionPermissionTier } from '../../shared/types/sessionPermissionTier.ts';
import type {
  WorkerBootstrapPayload,
  WorkerBootstrapResult,
  WorkerCommandsPayload,
  WorkerCommandsResult,
  WorkerCompactPayload,
  WorkerCompactResult,
  WorkerDiscardForkPayload,
  WorkerDiscardForkResult,
  WorkerForkPayload,
  WorkerForkResult,
  WorkerHistoryPayload,
  WorkerHistoryResult,
  WorkerReloadPayload,
  WorkerReloadResult,
  WorkerRewindPayload,
  WorkerRewindResult,
  WorkerSendPayload,
  WorkerSendResult,
  WorkerStopPayload,
  WorkerStopResult,
  WorkerTreePayload,
} from '../../shared/types/workerRpc.ts';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import type { RuntimeHostConfig } from '../contracts.ts';
import { RuntimeHostError } from '../host/errors.ts';
import { resolveWorkerShell } from '../host/shell.ts';
import { JsonlSessionStore, type SessionConfig } from '../plugins/session/store.ts';

/**
 * The self-owned runtime behind the existing worker RPC surface (ARD P4-1).
 *
 * `PiWorkerRpcServer` already takes its engine as an injected factory, so the
 * backend switch (D8 / P4-2) is a choice of factory rather than a fork of the
 * dispatcher: correlation, generation binding, serialization and the event
 * envelope stay in one implementation for both backends.
 *
 * Deliberately structural: this file never imports `piWorkerRpcServer.ts`, so
 * choosing `native` does not load `pi-coding-agent`. The worker entry checks the
 * shape at the assignment instead.
 *
 * Still absent: `commands`, which answers an empty list because slash commands
 * come from skills and plugins (P5-1). Everything else on `PiWorkerRuntime` is
 * implemented.
 */

export class NativeWorkerRuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'NativeWorkerRuntimeError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface NativeWorkerRuntimeOptions extends WorkerBootstrapPayload {
  host: RuntimeHostConfig;
  /** Already reduced by `unbound` in the RPC server; never widened here. */
  projectTrusted: boolean;
  emit: (event: RuntimeEventDraft) => void;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  log?: (...args: unknown[]) => void;
  /** Injectable for tests; defaults to the real Cordis bootstrap. */
  create?: typeof createRuntime;
}

interface ActiveTurn {
  requestId: string;
  controller: AbortController;
  done: Promise<void>;
}

export class NativeWorkerRuntime {
  private readonly options: NativeWorkerRuntimeOptions;
  private readonly logicalSessionId: string;
  private readonly cwd: string;
  private handle: RuntimeHandle | null = null;
  private booting: Promise<WorkerBootstrapResult> | null = null;
  private result: WorkerBootstrapResult | null = null;
  private turn: ActiveTurn | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  /** Forks this worker created and Main has not adopted: file -> session id. */
  private readonly stagedForks = new Map<string, string>();

  constructor(options: NativeWorkerRuntimeOptions) {
    this.options = options;
    this.logicalSessionId = options.logicalSessionId;
    this.cwd = options.cwd;
  }

  async bootstrap(): Promise<WorkerBootstrapResult> {
    if (this.result) return this.result;
    this.booting ??= this.bootstrapOnce();
    try {
      return await this.booting;
    } catch (error) {
      // A failed bootstrap must not poison the slot: Main retries by resending
      // worker.bootstrap, and a cached rejection would make every retry fail
      // with the first error rather than the current one.
      this.booting = null;
      throw error;
    }
  }

  /**
   * Build the plugin graph over one session file.
   *
   * Shared by bootstrap and reload: a reload that constructed the graph
   * differently from a bootstrap would give the same session two behaviours
   * depending on how it was last opened.
   */
  private async openGraph(agentDir: string, session: SessionConfig): Promise<RuntimeHandle> {
    const create = this.options.create ?? createRuntime;
    const handle = await create({
      ...(this.options.env ? { env: this.options.env } : {}),
      host: this.options.host,
      agentDir,
      // Without this the loop registers no tools and `bootstrap.ts` pins it to
      // singleTurn — a worker that can only ever answer once. The workspace is
      // the session's cwd, which bootstrap also cross-checks against the
      // session config, so the two can never drift apart.
      tools: { cwd: this.cwd, shellPath: resolveWorkerShell(this.options.host.childEnv) },
      session,
      permissions: {
        ...(this.options.permissions?.mode ? { mode: this.options.permissions.mode } : {}),
        ...(this.options.permissions?.gear ? { gear: this.options.permissions.gear } : {}),
        // D14 old-value migration lives in the permissions plugin, so a worker
        // seeded only with a legacy tier still lands on the right two axes.
        ...(this.options.tier ? { tier: this.options.tier } : {}),
        projectTrusted: this.options.projectTrusted,
      },
      approvalUi: {
        onRequest: (request) =>
          this.emit({
            type: 'extensionUi.request',
            sessionId: this.logicalSessionId,
            payload: {
              runtimeId: request.runtimeId,
              uiRequestId: request.uiRequestId,
              method: request.method,
              args: request.args,
              ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
            },
          }),
        onCancel: (cancel) =>
          this.emit({
            type: 'extensionUi.cancelled',
            sessionId: this.logicalSessionId,
            payload: {
              runtimeId: cancel.runtimeId,
              uiRequestIds: cancel.uiRequestIds,
              reason: cancel.reason,
            },
          }),
        onReset: (reset) =>
          this.emit({
            type: 'extensionUi.reset',
            sessionId: this.logicalSessionId,
            payload: { runtimeId: reset.runtimeId, reason: reset.reason },
          }),
      },
    });

    if (this.disposed) {
      await handle.dispose().catch(() => undefined);
      throw new NativeWorkerRuntimeError('WORKER_SESSION_DISPOSED', 'Worker session is disposed');
    }

    this.handle = handle;
    // P4-3: the runtime's own event union never leaves this process. What goes
    // on the wire is the RuntimeEvent the renderer already reduces (D5); the
    // RPC server adds `seq` and `timestamp`.
    this.unsubscribe = handle.events.subscribe((event) => this.emit(event));
    return handle;
  }

  private async bootstrapOnce(): Promise<WorkerBootstrapResult> {
    if (this.disposed) {
      throw new NativeWorkerRuntimeError('WORKER_SESSION_DISPOSED', 'Worker session is disposed');
    }
    const agentDir = this.options.agentDir ?? this.resolveAgentDir();
    await this.openGraph(
      agentDir,
      this.options.sessionFile
        ? { file: this.options.sessionFile, cwd: this.cwd, mode: 'resume' }
        : { file: this.sessionFilePath(agentDir), cwd: this.cwd, mode: 'create' }
    );

    const session = this.requireSession();
    const metadata = session.metadata();
    const history = this.options.sessionFile
      ? {
          logicalSessionId: this.logicalSessionId,
          sessionFile: metadata.file,
          workspacePath: this.cwd,
          page: paginatePiSessionHistory(session.history()),
        }
      : undefined;

    this.result = {
      bootstrapped: true,
      logicalSessionId: this.logicalSessionId,
      piSessionId: metadata.id,
      cwd: this.cwd,
      agentDir,
      sessionFile: metadata.file,
      // A legacy resume opens the converted copy, not the requested file. Main
      // needs the source to accept that redirect and migrate the index onto the
      // copy; without it every resume of the same legacy file mismatches again.
      ...(metadata.sourceFile ? { sessionSourceFile: metadata.sourceFile } : {}),
      ...(history ? { initialHistory: history } : {}),
      leaf: metadata.leaf,
      ...(metadata.model
        ? { model: metadata.model }
        : this.options.model
          ? { model: this.options.model }
          : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      projectTrusted: this.options.projectTrusted,
      // The native runtime enforces D14 in its own permissions plugin; there is
      // no pi permission extension to be replaced by a user-configured one.
      permissionGate: 'bundled',
    };
    return this.result;
  }

  async startSend(input: WorkerSendPayload): Promise<WorkerSendResult> {
    this.assertLogicalSession(input.logicalSessionId);
    if (this.disposed) {
      throw new NativeWorkerRuntimeError('WORKER_SESSION_DISPOSED', 'Worker session is disposed');
    }
    if (this.turn) {
      throw new NativeWorkerRuntimeError(
        'WORKER_SESSION_BUSY',
        'Session already has an active turn',
        true
      );
    }
    await this.bootstrap();
    const handle = this.requireHandle();
    const controller = new AbortController();
    // startSend only admits the turn. Awaiting the run here would hold the
    // server's serialized RPC chain for the whole prompt and make worker.stop
    // unreachable — the same reason the legacy backend starts it out of band.
    const done = handle
      .run({
        prompt: input.text,
        runId: input.requestId,
        // Round-tripped so the composer can retire its optimistic bubble when
        // the authoritative user echo lands; without it the prompt shows twice.
        attemptId: input.attemptId,
        logicalSessionId: this.logicalSessionId,
        signal: controller.signal,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.model ? { model: parseModelRef(input.model) } : {}),
        // The composer's effort chip is the turn's thinking level. Dropping it
        // here is invisible: the loop falls back to its own default and the run
        // reports `thinking_level: off` no matter what the user picked. The
        // per-turn value wins over the one the session bootstrapped with.
        ...((input.effort ?? this.options.effort)
          ? { thinkingLevel: input.effort ?? this.options.effort }
          : {}),
      })
      .then(
        () => undefined,
        (error) => {
          // The loop already emitted session.failed + idle for this run; losing
          // the rejection here would only produce an unhandled rejection that
          // kills the worker.
          this.options.log?.('[native-runtime] run failed', error);
        }
      )
      .finally(() => {
        if (this.turn?.requestId === input.requestId) this.turn = null;
      });
    this.turn = { requestId: input.requestId, controller, done };
    return { accepted: true, requestId: input.requestId };
  }

  async stop(input: WorkerStopPayload): Promise<WorkerStopResult> {
    this.assertLogicalSession(input.logicalSessionId);
    const turn = this.turn;
    if (!turn) return { stopped: false };
    this.emit({
      type: 'session.status',
      sessionId: this.logicalSessionId,
      requestId: turn.requestId,
      payload: { status: 'stopping' },
    });
    // Cancel parked approval dialogs too: aborting the model loop unblocks the
    // provider call, but a tool waiting on a permission answer is waiting on a
    // promise the bridge owns, not on the loop.
    this.handle?.approval?.bridge.cancelAll('aborted');
    turn.controller.abort();
    // Deliberately NOT awaiting the turn. The RPC chain is serialized, so a stop
    // that waited would hold it for however long the provider takes to notice
    // the abort — and a second stop, or the dispose behind it, could not get
    // through. `stopped` reports that the stop was issued; the turn's own
    // terminal event reports that it finished. `dispose` still waits, because
    // there the session lock has to be released before the call returns.
    return { stopped: true };
  }

  async history(input: WorkerHistoryPayload): Promise<WorkerHistoryResult> {
    this.assertLogicalSession(input.logicalSessionId);
    await this.bootstrap();
    const session = this.requireSession();
    return {
      logicalSessionId: this.logicalSessionId,
      sessionFile: session.file,
      workspacePath: this.cwd,
      page: paginatePiSessionHistory(session.history(), input.offset, input.limit),
    };
  }

  async tree(input: WorkerTreePayload) {
    this.assertLogicalSession(input.logicalSessionId);
    await this.bootstrap();
    return { snapshot: this.requireSession().tree(this.logicalSessionId) };
  }

  /**
   * `/compact` — R02-c, manual context compaction.
   *
   * Runs the compaction NOW rather than recording an intent for the next turn.
   * The intent path (`requestNewWindow`, what the model's `new_context` tool
   * uses) is run-local: `beginRun` clears it, so a request made between runs —
   * which is exactly what `/compact` is — would be wiped before any turn could
   * honour it. Forcing it here also matches what the user asked for: the
   * transcript is summarized when they click, not on their next message.
   *
   * The summary and its retained tail are appended to the session as a
   * compaction entry, so the next run rebuilds the shortened window from disk.
   */
  async compact(input: WorkerCompactPayload): Promise<WorkerCompactResult> {
    this.assertLogicalSession(input.logicalSessionId);
    this.assertIdle('compact the conversation');
    await this.bootstrap();
    const handle = this.requireHandle();
    const context = handle.context;
    if (!context?.enabled) {
      throw new NativeWorkerRuntimeError(
        'WORKER_COMPACT_UNAVAILABLE',
        'This runtime was built without compaction'
      );
    }
    const session = this.requireSession();
    await session.flush();
    const snapshot = session.snapshot();
    const resolved = handle.model.resolve(this.compactionModelRef(snapshot.model));
    // Restores the persisted checkpoint identity first, so a second /compact
    // updates the previous summary instead of summarizing the summary.
    context.beginRun(snapshot);
    const prepared = await context.prepareTurn({
      messages: snapshot.messages,
      model: resolved.model,
      models: resolved.models,
      retention: 'completed_turn',
      force: true,
      ...(input.instructions ? { instructions: input.instructions } : {}),
    });
    if (!prepared.compaction) {
      throw new NativeWorkerRuntimeError(
        'WORKER_COMPACT_UNAVAILABLE',
        prepared.skipped?.message ?? 'there is nothing to compact yet'
      );
    }
    return { compacted: true };
  }

  private compactionModelRef(saved: { provider: string; modelId: string } | undefined) {
    if (saved) return { provider: saved.provider, id: saved.modelId };
    if (this.options.model) return parseModelRef(this.options.model);
    const fallback = this.requireHandle().model.defaultRef();
    if (!fallback) {
      throw new NativeWorkerRuntimeError(
        'WORKER_COMPACT_UNAVAILABLE',
        'No model is available to summarize the conversation'
      );
    }
    return fallback;
  }

  /**
   * Slash commands come from skills and plugins, which are P5. An empty list is
   * the truthful answer for this backend and the one the composer already
   * handles; an error would make the caller translate it back into "none".
   */
  async commands(input: WorkerCommandsPayload): Promise<WorkerCommandsResult> {
    this.assertLogicalSession(input.logicalSessionId);
    return { commands: [], truncated: false };
  }

  async rewind(input: WorkerRewindPayload): Promise<WorkerRewindResult> {
    this.assertLogicalSession(input.logicalSessionId);
    this.assertIdle('rewind the session');
    await this.bootstrap();
    const session = this.requireSession();
    const rewound = await session.rewind(input.targetEntryId, input.confirmed);
    return {
      logicalSessionId: this.logicalSessionId,
      sessionFile: session.file,
      workspacePath: this.cwd,
      targetEntryId: input.targetEntryId,
      ...(rewound.editorText !== undefined ? { editorText: rewound.editorText } : {}),
      leaf: rewound.leaf,
      history: {
        logicalSessionId: this.logicalSessionId,
        sessionFile: session.file,
        workspacePath: this.cwd,
        page: paginatePiSessionHistory(session.history()),
      },
      tree: { snapshot: session.tree(this.logicalSessionId) },
    };
  }

  /**
   * Re-read this worker's own session file (R02 / `worker.reload`).
   *
   * Not a convenience. `CHAT_SEND` calls this whenever a Pi TUI terminal on the
   * same session was just released (`src/main/ipc/chat.ts`): the terminal
   * appended to the same JSONL, and this worker still holds the tree it read
   * before that. Sending without re-reading would branch the next turn off the
   * pre-handover leaf and strand everything typed in the terminal on an
   * abandoned path. Our own writer lock does not prevent this — it is an
   * advisory lock file, and the bundled pi TUI is a different program that
   * never looks at it.
   *
   * Implemented as tear-down-and-reopen because the store's document IS the
   * file it holds a lock on; there is no in-place re-read. That is the same
   * shape as the legacy backend, whose `switchSession` also destroys the old
   * session before building the new one.
   */
  async reload(input: WorkerReloadPayload): Promise<WorkerReloadResult> {
    this.assertLogicalSession(input.logicalSessionId);
    this.assertIdle('reload the session');
    await this.bootstrap();
    const handle = this.requireHandle();
    const current = this.requireSession().file;
    if (!samePiSessionPath(current, input.sessionFile)) {
      throw new NativeWorkerRuntimeError(
        'WORKER_RELOAD_IDENTITY_MISMATCH',
        `Worker owns session file ${current}, not ${input.sessionFile}`
      );
    }
    const agentDir = this.result?.agentDir ?? this.options.agentDir ?? this.resolveAgentDir();

    // Any approval dialog still open belongs to the graph being torn down, and
    // the event subscription is bound to its events service.
    handle.approval?.bridge.cancelAll('aborted');
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handle = null;
    await handle.dispose();

    try {
      await this.openGraph(agentDir, { file: current, cwd: this.cwd, mode: 'resume' });
    } catch (error) {
      // The old graph is gone and the new one did not come up, so this slot
      // owns nothing. Clearing the cached bootstrap lets Main's respawn — or a
      // resent worker.bootstrap — rebuild instead of answering from a result
      // that no longer has a runtime behind it.
      this.result = null;
      this.booting = null;
      throw new NativeWorkerRuntimeError(
        'WORKER_RELOAD_FAILED',
        `Failed to re-open session ${current}: ${error instanceof Error ? error.message : String(error)}`,
        true
      );
    }

    const session = this.requireSession();
    const metadata = session.metadata();
    const history = {
      logicalSessionId: this.logicalSessionId,
      sessionFile: metadata.file,
      workspacePath: this.cwd,
      page: paginatePiSessionHistory(session.history()),
    };
    // The cached bootstrap result is what Main reads back on a later reconnect;
    // leaving the pre-reload leaf in it would reintroduce the exact staleness
    // this call exists to clear.
    if (this.result) {
      this.result = {
        ...this.result,
        piSessionId: metadata.id,
        sessionFile: metadata.file,
        leaf: metadata.leaf,
        initialHistory: history,
      };
    }
    return {
      logicalSessionId: this.logicalSessionId,
      sessionFile: metadata.file,
      workspacePath: this.cwd,
      leaf: metadata.leaf,
      history,
    };
  }

  async fork(input: WorkerForkPayload): Promise<WorkerForkResult> {
    this.assertLogicalSession(input.logicalSessionId);
    this.assertIdle('fork the session');
    await this.bootstrap();
    const session = this.requireSession();
    const sourceSessionFile = session.file;
    const file = join(dirname(sourceSessionFile), `${randomUUID()}.jsonl`);
    const metadata = await session.fork(file, input.entryId);
    // The fork is staged, not adopted: Main decides whether it becomes a
    // session, and `worker.fork.discard` must be able to prove the file it is
    // asked to delete is one we made rather than an unrelated transcript.
    this.stagedForks.set(metadata.file, metadata.id);
    return {
      logicalSessionId: this.logicalSessionId,
      sourceSessionFile,
      sessionFile: metadata.file,
      piSessionId: metadata.id,
      workspacePath: this.cwd,
      leaf: metadata.leaf,
      history: {
        logicalSessionId: this.logicalSessionId,
        sessionFile: metadata.file,
        workspacePath: this.cwd,
        // Read back rather than projected from the source: the fork is a
        // separate document from here on, and a history assembled from the
        // parent would silently disagree with the file the next slot opens.
        page: paginatePiSessionHistory(await this.readForkHistory(metadata.file)),
      },
    };
  }

  async discardFork(input: WorkerDiscardForkPayload): Promise<WorkerDiscardForkResult> {
    this.assertLogicalSession(input.logicalSessionId);
    const staged = this.stagedForks.get(input.sessionFile);
    const owned = this.handle?.session?.file === input.sessionFile;
    if (staged === undefined && !owned) return { discarded: false };
    if (staged !== undefined) {
      this.stagedForks.delete(input.sessionFile);
      await this.requireSession().discardFork(input.sessionFile, staged);
      return { discarded: true };
    }
    // Discarding the file this worker holds open: the lock has to go before the
    // file can, so the slot ends here either way.
    const io = this.requireHandle().hostIo;
    await this.dispose();
    await io.unlink(input.sessionFile).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    });
    return { discarded: true };
  }

  private async readForkHistory(file: string) {
    const store = await JsonlSessionStore.open(this.requireHandle().hostIo, {
      file,
      cwd: this.cwd,
      mode: 'resume',
    });
    try {
      return store.history();
    } finally {
      await store.close();
    }
  }

  setPermissionTier(tier: SessionPermissionTier): void {
    // D14: the old four-tier value is migrated, never carried through. A worker
    // that stored the tier would be enforcing an axis pair nobody chose.
    this.setPermissions(migratePermissionTier(tier));
  }

  respondExtensionUi(response: ExtensionUiResponse): boolean {
    return this.handle?.approval?.bridge.respond(response) ?? false;
  }

  setPermissions(permissions: RuntimePermissionSettings): void {
    this.assertIdle('change permissions');
    const service = this.handle?.permissions;
    if (!service) {
      throw new NativeWorkerRuntimeError(
        'WORKER_PERMISSIONS_UNAVAILABLE',
        'Native runtime has no permissions service'
      );
    }
    service.configure(permissions);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const turn = this.turn;
    if (turn) {
      turn.controller.abort();
      await turn.done.catch(() => undefined);
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    const handle = this.handle;
    this.handle = null;
    await handle?.dispose();
  }

  private emit(event: RuntimeEventDraft): void {
    if (!this.disposed) this.options.emit(event);
  }

  private assertIdle(action: string): void {
    if (!this.turn) return;
    throw new NativeWorkerRuntimeError(
      'WORKER_SESSION_BUSY',
      `Cannot ${action} while a turn is active`,
      true
    );
  }

  private assertLogicalSession(id: string): void {
    if (id === this.logicalSessionId) return;
    throw new NativeWorkerRuntimeError(
      'WORKER_SESSION_MISMATCH',
      `This worker owns ${this.logicalSessionId}, not ${id}`
    );
  }

  private requireHandle(): RuntimeHandle {
    if (!this.handle) {
      throw new NativeWorkerRuntimeError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    return this.handle;
  }

  private requireSession() {
    const session = this.requireHandle().session;
    if (!session) {
      throw new NativeWorkerRuntimeError(
        'WORKER_HISTORY_UNAVAILABLE',
        'Native runtime started without persistent session storage'
      );
    }
    return session;
  }

  private resolveAgentDir(): string {
    const env = this.options.env ?? process.env;
    const dir = env.AICLIENT_RUNTIME_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
    if (!dir) {
      throw new RuntimeHostError(
        'invalid_host_config',
        'Native backend needs AICLIENT_RUNTIME_AGENT_DIR or PI_CODING_AGENT_DIR'
      );
    }
    return dir;
  }

  /**
   * Where a NEW native session lands.
   *
   * The host picks the path rather than letting the SDK infer a session
   * directory (P3-1 contract), so the file a slot writes is decided by the same
   * process that reports it back to Main in `WorkerBootstrapResult.sessionFile`.
   */
  private sessionFilePath(agentDir: string): string {
    return join(agentDir, 'sessions', `${this.logicalSessionId}.jsonl`);
  }
}

function parseModelRef(model: string): { provider: string; id: string } {
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) {
    throw new NativeWorkerRuntimeError(
      'WORKER_INVALID_MODEL',
      `Model must be "provider/id": ${model}`
    );
  }
  return { provider: model.slice(0, separator), id: model.slice(separator + 1) };
}
