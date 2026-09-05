import { unlink } from 'node:fs/promises';
import { parsePiModelRef } from '../shared/piModelConfig.ts';
import type { SessionAttachment, SessionEffortLevel } from '../shared/types/agentHost.ts';
import type { ExtensionUiResponse, RuntimeEventDraft } from '../shared/types/runtimeEvents.ts';
import type { SessionPermissionTier } from '../shared/types/sessionPermissionTier.ts';
import type {
  WorkerBootstrapPayload,
  WorkerBootstrapResult,
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
} from '../shared/types/workerRpc.ts';
import {
  createPortableExtensionUiBridge,
  type PortableExtensionUiBridge,
} from './extensionUiBridge.ts';
import type { PermissionPluginDecision } from './permissionPlugin.ts';
import {
  bootstrapPiAgentSession,
  type PiModel,
  type PiRuntimeHandle,
  type PiSdkModule,
  type PiSession,
  type PiSessionManager,
} from './piAgentSessionBootstrap.ts';
import { preflightPiSessionFile, samePiSessionPath } from './piSessionPreflight.ts';
import { readPiSessionHistoryPage } from './piSessionTimeline.ts';
import { buildPiSessionTreeSnapshot, readPiLeafCheckpoint } from './piSessionTree.ts';
import { PiWorkerSessionError } from './piWorkerErrors.ts';
import {
  createSessionTierAuthorizer,
  type SessionTierAuthorizerState,
} from './sessionTierAuthorizer.ts';

interface PiImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

interface PiPromptOptions {
  images?: PiImageContent[];
}

export interface PiAgentEvent {
  type: string;
  [key: string]: unknown;
}

interface TurnProjection {
  assistantMessageId: string | null;
  textBlockId: string | null;
  thinkingBlockId: string | null;
  textSnapshot: string;
  thinkingSnapshot: string;
  thinkingStarted: boolean;
  thinkingCompleted: boolean;
  proseClosed: boolean;
}

interface ActiveTurn {
  token: number;
  requestId: string;
  attemptId: string;
  userText: string;
  attachmentMetadata: Array<{ kind: 'image' | 'text'; mediaType: string; name?: string }>;
  stopRequested: boolean;
  terminal: boolean;
  pendingError: string | null;
  projection: TurnProjection;
}

export interface PiWorkerSessionOptions extends WorkerBootstrapPayload {
  projectTrusted: boolean;
  emit: (event: RuntimeEventDraft) => void;
  loadSdk?: () => Promise<unknown>;
  decidePermissionGate?: (packages: unknown[]) => PermissionPluginDecision;
  log?: (...args: unknown[]) => void;
}

export { PiWorkerSessionError } from './piWorkerErrors.ts';

function selectedModel(handle: PiRuntimeHandle): string | undefined {
  const model = handle.session.model;
  return model ? `${model.provider}/${model.id}` : undefined;
}

function newProjection(): TurnProjection {
  return {
    assistantMessageId: null,
    textBlockId: null,
    thinkingBlockId: null,
    textSnapshot: '',
    thinkingSnapshot: '',
    thinkingStarted: false,
    thinkingCompleted: false,
    proseClosed: false,
  };
}

function readToolOutput(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'content' in result) {
    const content = (result as { content: unknown }).content;
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
  return result === undefined ? '' : JSON.stringify(result);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (typeof part === 'object' && part !== null && 'type' in part) {
      const typed = part as { type: string; text?: string };
      if (typed.type === 'text' && typed.text) return typed.text;
    }
  }
  return undefined;
}

function extractAllTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part !== 'object' || part === null || !('type' in part)) return '';
      const typed = part as { type: unknown; text?: unknown };
      return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

type StreamUpdateSource = 'delta' | 'snapshot';

function takeStreamUpdate(
  previous: string,
  update: string,
  source: StreamUpdateSource
): { chunk: string; cumulative: string } {
  if (!update) return { chunk: '', cumulative: previous };
  if (source === 'delta') return { chunk: update, cumulative: previous + update };
  if (!previous) return { chunk: update, cumulative: update };
  if (update === previous || previous.startsWith(update)) {
    return { chunk: '', cumulative: previous };
  }
  if (update.startsWith(previous)) {
    return { chunk: update.slice(previous.length), cumulative: update };
  }

  const maxOverlap = Math.min(previous.length, Math.max(0, update.length - 1), 64);
  for (let length = maxOverlap; length >= 2; length -= 1) {
    if (previous.endsWith(update.slice(0, length))) {
      return { chunk: update.slice(length), cumulative: previous + update.slice(length) };
    }
  }
  return { chunk: update, cumulative: previous + update };
}

const CUSTOM_TIMELINE_CONTENT_MAX = 16_000;

function sanitizeCustomValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>()
): unknown {
  if (depth > 8) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeCustomValue(item, depth + 1, seen))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = sanitizeCustomValue(item, depth + 1, seen);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
}

function serializeCustomValue(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(sanitizeCustomValue(value), null, 2) ?? '';
  } catch {
    return '[unserializable value]';
  }
}

function customTimelineContent(content: unknown, details: unknown): string {
  const text = extractAllTextContent(content);
  const serialized = serializeCustomValue(details);
  const combined = serialized
    ? `${text ? `${text}\n\n` : ''}\`\`\`json\n${serialized}\n\`\`\``
    : text;
  if (combined.length <= CUSTOM_TIMELINE_CONTENT_MAX) return combined;
  return `${combined.slice(0, CUSTOM_TIMELINE_CONTENT_MAX)}\n[truncated]`;
}

export function buildPiWorkerPrompt(
  text: string,
  attachments: SessionAttachment[] | undefined
): { text: string; options?: PiPromptOptions } {
  if (!attachments?.length) return { text };
  const images: PiImageContent[] = [];
  const documents: string[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      images.push({
        type: 'image',
        data: attachment.data,
        mimeType: attachment.mediaType || 'image/png',
      });
    } else if (attachment.kind === 'text') {
      documents.push(`--- ${attachment.name ?? 'attachment'} ---\n${attachment.data}`);
    } else {
      throw new PiWorkerSessionError(
        'WORKER_UNSUPPORTED_ATTACHMENT',
        `Unsupported attachment kind for Pi: ${String((attachment as { kind: unknown }).kind)}`
      );
    }
  }
  return {
    text: documents.length ? [text, ...documents].filter(Boolean).join('\n\n') : text,
    ...(images.length ? { options: { images } } : {}),
  };
}

/** One utility worker owns one Pi AgentSession and at most one active turn. */
export class PiWorkerSession {
  readonly logicalSessionId: string;
  readonly cwd: string;

  private readonly options: PiWorkerSessionOptions;
  private readonly extensionUi: PortableExtensionUiBridge;
  private bootstrapPromise: Promise<WorkerBootstrapResult> | null = null;
  private handle: PiRuntimeHandle | null = null;
  private sessionManager: PiSessionManager | null = null;
  private sdk: PiSdkModule | null = null;
  private readonly stagedForkFiles = new Set<string>();
  private tierState: SessionTierAuthorizerState | null = null;
  private unsubscribe: (() => void) | null = null;
  private activeTurn: ActiveTurn | null = null;
  private turnSequence = 0;
  private assistantSequence = 0;
  private customSequence = 0;
  private disposed = false;

  constructor(options: PiWorkerSessionOptions) {
    this.options = options;
    this.logicalSessionId = options.logicalSessionId;
    this.cwd = options.cwd;
    this.extensionUi = createPortableExtensionUiBridge({
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
    });
  }

  bootstrap(): Promise<WorkerBootstrapResult> {
    if (this.disposed) {
      return Promise.reject(
        new PiWorkerSessionError('WORKER_SESSION_DISPOSED', 'Pi worker session is disposed')
      );
    }
    if (!this.bootstrapPromise) this.bootstrapPromise = this.bootstrapInternal();
    return this.bootstrapPromise;
  }

  async tree(input: {
    logicalSessionId: string;
  }): Promise<{ snapshot: ReturnType<typeof buildPiSessionTreeSnapshot> }> {
    this.assertLogicalSession(input.logicalSessionId);
    this.assertIdle('load the session tree');
    await this.bootstrap();
    const manager = this.sessionManager;
    const sessionFile = this.handle?.session.sessionFile;
    if (!manager || !sessionFile) {
      throw new PiWorkerSessionError('WORKER_TREE_UNAVAILABLE', 'Pi session tree is unavailable');
    }
    return {
      snapshot: buildPiSessionTreeSnapshot({
        manager,
        logicalSessionId: this.logicalSessionId,
        sessionFile,
        workspacePath: this.cwd,
      }),
    };
  }

  async rewind(input: WorkerRewindPayload): Promise<WorkerRewindResult> {
    this.assertLogicalSession(input.logicalSessionId);
    if (input.confirmed !== true) {
      throw new PiWorkerSessionError(
        'WORKER_REWIND_CONFIRMATION_REQUIRED',
        'Rewind requires explicit confirmation'
      );
    }
    this.assertIdle('rewind the session');
    await this.bootstrap();
    const manager = this.sessionManager;
    const handle = this.requireHandle();
    const sessionFile = handle.session.sessionFile;
    if (!manager?.getEntry?.(input.targetEntryId) || !sessionFile) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_ENTRY_NOT_FOUND',
        `Pi session entry ${input.targetEntryId} was not found`
      );
    }
    if (!handle.session.navigateTree) {
      throw new PiWorkerSessionError(
        'WORKER_REWIND_UNAVAILABLE',
        'Pi session does not expose native tree navigation'
      );
    }
    this.extensionUi.cancelAll('aborted');
    const navigated = await handle.session.navigateTree(input.targetEntryId, { summarize: false });
    if (navigated.cancelled) {
      throw new PiWorkerSessionError('WORKER_REWIND_CANCELLED', 'Pi session rewind was cancelled');
    }
    const history = await this.historyFromOpenedSession(manager, sessionFile);
    const tree = await this.tree({ logicalSessionId: this.logicalSessionId });
    return {
      logicalSessionId: this.logicalSessionId,
      sessionFile,
      workspacePath: this.cwd,
      targetEntryId: input.targetEntryId,
      ...(navigated.editorText !== undefined ? { editorText: navigated.editorText } : {}),
      leaf: readPiLeafCheckpoint(manager),
      history,
      tree,
    };
  }

  /**
   * Re-open this worker's own session file so the worker sees what another
   * writer appended (the Pi TUI drives the same JSONL through `pi --session`).
   *
   * pi's SessionManager reads the whole file once at open and never looks at
   * disk again, so without this the worker keeps projecting the history it
   * started with AND keeps its leaf on the pre-handover entry — the next turn
   * would branch there and strand the terminal's messages on a dead path.
   *
   * `switchSession` is pi's own primitive for this (its RPC mode uses it for
   * resume): it tears the current session down and rebuilds the runtime through
   * the same factory with a manager freshly read from disk, whose leaf lands on
   * the file's last entry. That is the whole leaf-alignment story — no
   * checkpoint restore is involved, and none should be: the file tail is the
   * authority precisely because someone else was writing.
   *
   * Failure is not recoverable in place: `switchSession` disposes the outgoing
   * session before it builds the new one, so a throw leaves this worker without
   * a usable session. It is reported retryable so Main retires the slot and the
   * next request spawns a clean one.
   */
  async reload(input: WorkerReloadPayload): Promise<WorkerReloadResult> {
    this.assertLogicalSession(input.logicalSessionId);
    this.assertIdle('reload the session');
    await this.bootstrap();
    const handle = this.requireHandle();
    const currentFile = handle.session.sessionFile;
    if (!currentFile || !samePiSessionPath(currentFile, input.sessionFile)) {
      throw new PiWorkerSessionError(
        'WORKER_RELOAD_IDENTITY_MISMATCH',
        `Worker owns Pi session file ${currentFile ?? 'none'}, not ${input.sessionFile}`
      );
    }
    if (!handle.switchSession) {
      throw new PiWorkerSessionError(
        'WORKER_RELOAD_UNAVAILABLE',
        'Pi runtime does not expose in-place session switching'
      );
    }
    // Any approval dialog still open belongs to the session being torn down.
    this.extensionUi.cancelAll('aborted');
    // The subscription installed by the last turn is bound to the outgoing
    // session object; the next send re-subscribes on the replacement.
    this.unsubscribe?.();
    this.unsubscribe = null;

    let switched: { cancelled: boolean };
    try {
      switched = await handle.switchSession(currentFile);
    } catch (error) {
      throw new PiWorkerSessionError(
        'WORKER_RELOAD_FAILED',
        `Failed to re-open Pi session ${currentFile}: ${error instanceof Error ? error.message : String(error)}`,
        true
      );
    }
    if (switched.cancelled) {
      throw new PiWorkerSessionError(
        'WORKER_RELOAD_CANCELLED',
        'Pi cancelled the session re-open',
        true
      );
    }

    const manager = handle.session.sessionManager;
    const sessionFile = handle.session.sessionFile;
    if (!manager || !sessionFile || !samePiSessionPath(sessionFile, currentFile)) {
      throw new PiWorkerSessionError(
        'WORKER_RELOAD_IDENTITY_MISMATCH',
        'Pi re-opened a different session file than the one this worker owns',
        true
      );
    }
    if (!samePiSessionPath(manager.getCwd?.() ?? '', this.cwd)) {
      throw new PiWorkerSessionError(
        'WORKER_RELOAD_CWD_MISMATCH',
        `Re-opened Pi session workspace mismatch: expected ${this.cwd}, opened ${manager.getCwd?.() ?? 'unknown'}`,
        true
      );
    }
    this.sessionManager = manager;

    return {
      logicalSessionId: this.logicalSessionId,
      sessionFile,
      workspacePath: this.cwd,
      leaf: readPiLeafCheckpoint(manager),
      history: await this.historyFromOpenedSession(manager, sessionFile),
    };
  }

  async fork(input: WorkerForkPayload): Promise<WorkerForkResult> {
    this.assertLogicalSession(input.logicalSessionId);
    this.assertIdle('fork the session');
    await this.bootstrap();
    const sourceManager = this.sessionManager;
    const sdk = this.sdk;
    const sourceSessionFile = this.handle?.session.sessionFile;
    if (!sourceManager?.getEntry?.(input.entryId) || !sdk || !sourceSessionFile) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_ENTRY_NOT_FOUND',
        `Pi session entry ${input.entryId} was not found`
      );
    }
    const forkPath = sourceManager.getBranch?.(input.entryId) ?? [];
    const hasAssistant = forkPath.some((entry) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const value = entry as { type?: unknown; message?: unknown };
      if (value.type !== 'message' || typeof value.message !== 'object' || value.message === null) {
        return false;
      }
      return (value.message as { role?: unknown }).role === 'assistant';
    });
    if (!hasAssistant) {
      throw new PiWorkerSessionError(
        'WORKER_FORK_PATH_NOT_MATERIALIZED',
        'Fork from an entry after the first assistant response so Pi can materialize an independent session file'
      );
    }
    const sourceLeaf = sourceManager.getLeafId?.() ?? null;
    const sourceSessionId = sourceManager.getSessionId?.();
    const stagingManager = sdk.SessionManager.open(sourceSessionFile);
    if (
      !samePiSessionPath(stagingManager.getSessionFile?.() ?? '', sourceSessionFile) ||
      !samePiSessionPath(stagingManager.getCwd?.() ?? '', this.cwd) ||
      stagingManager.getSessionId?.() !== sourceSessionId
    ) {
      throw new PiWorkerSessionError(
        'WORKER_FORK_SOURCE_MISMATCH',
        'Separate Pi fork manager did not reopen the authoritative source session'
      );
    }
    if (!stagingManager.createBranchedSession) {
      throw new PiWorkerSessionError(
        'WORKER_FORK_UNAVAILABLE',
        'Pi session does not expose native branched-session creation'
      );
    }
    const sessionFile = stagingManager.createBranchedSession(input.entryId);
    if (!sessionFile || samePiSessionPath(sessionFile, sourceSessionFile)) {
      throw new PiWorkerSessionError(
        'WORKER_FORK_FILE_MISSING',
        'Pi did not create an independent fork session file'
      );
    }
    try {
      const header = await preflightPiSessionFile(sessionFile, this.cwd);
      const forkManager = sdk.SessionManager.open(sessionFile);
      if (
        !samePiSessionPath(forkManager.getSessionFile?.() ?? '', sessionFile) ||
        forkManager.getSessionId?.() !== header.sessionId
      ) {
        throw new PiWorkerSessionError(
          'WORKER_FORK_IDENTITY_MISMATCH',
          'Pi fork file identity did not survive exact reopen'
        );
      }
      const history = await this.historyFromOpenedSession(forkManager, sessionFile);
      if (
        sourceManager.getLeafId?.() !== sourceLeaf ||
        sourceManager.getSessionId?.() !== sourceSessionId ||
        !samePiSessionPath(sourceManager.getSessionFile?.() ?? '', sourceSessionFile)
      ) {
        throw new PiWorkerSessionError(
          'WORKER_FORK_MUTATED_SOURCE',
          'Pi fork creation changed the live source session'
        );
      }
      this.stagedForkFiles.add(sessionFile);
      return {
        logicalSessionId: this.logicalSessionId,
        sourceSessionFile,
        sessionFile,
        piSessionId: header.sessionId,
        workspacePath: this.cwd,
        leaf: readPiLeafCheckpoint(forkManager),
        history,
      };
    } catch (error) {
      try {
        await unlink(sessionFile);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          throw new PiWorkerSessionError(
            'WORKER_FORK_CLEANUP_FAILED',
            `Fork creation failed (${error instanceof Error ? error.message : String(error)}) and the staged Pi file could not be removed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            true
          );
        }
      }
      throw error;
    }
  }

  async discardFork(input: WorkerDiscardForkPayload): Promise<WorkerDiscardForkResult> {
    this.assertLogicalSession(input.logicalSessionId);
    const staged = this.stagedForkFiles.delete(input.sessionFile);
    const owned = samePiSessionPath(this.handle?.session.sessionFile ?? '', input.sessionFile);
    if (!staged && !owned) return { discarded: false };
    if (owned) await this.dispose();
    try {
      await unlink(input.sessionFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw new PiWorkerSessionError(
          'WORKER_FORK_DISCARD_FAILED',
          `Failed to remove uncommitted Pi fork ${input.sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
          true
        );
      }
    }
    return { discarded: true };
  }

  async history(input: WorkerHistoryPayload): Promise<WorkerHistoryResult> {
    this.assertLogicalSession(input.logicalSessionId);
    await this.bootstrap();
    const manager = this.sessionManager;
    const sessionFile = this.handle?.session.sessionFile;
    if (!manager?.getBranch || !sessionFile) {
      throw new PiWorkerSessionError(
        'WORKER_HISTORY_UNAVAILABLE',
        'Pi session does not expose branch history'
      );
    }
    return {
      logicalSessionId: this.logicalSessionId,
      sessionFile,
      workspacePath: this.cwd,
      page: readPiSessionHistoryPage(
        { getBranch: () => manager.getBranch?.() ?? [] },
        input.offset,
        input.limit
      ),
    };
  }

  async startSend(input: WorkerSendPayload): Promise<WorkerSendResult> {
    this.assertLogicalSession(input.logicalSessionId);
    if (this.disposed) {
      throw new PiWorkerSessionError('WORKER_SESSION_DISPOSED', 'Pi worker session is disposed');
    }
    if (this.activeTurn && !this.activeTurn.terminal) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_BUSY',
        'Session already has an active turn',
        true
      );
    }

    await this.bootstrap();
    const handle = this.requireHandle();
    const prompt = buildPiWorkerPrompt(input.text, input.attachments);
    await this.applySelectedModel(handle, input.model);
    this.applyEffort(handle.session, input.effort);

    const turn: ActiveTurn = {
      token: ++this.turnSequence,
      requestId: input.requestId,
      attemptId: input.attemptId,
      userText: input.text,
      attachmentMetadata: (input.attachments ?? []).map((attachment) => ({
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        ...(attachment.name ? { name: attachment.name } : {}),
      })),
      stopRequested: false,
      terminal: false,
      pendingError: null,
      projection: newProjection(),
    };
    this.activeTurn = turn;
    this.unsubscribe?.();
    this.unsubscribe =
      handle.session.subscribe?.((event: PiAgentEvent) => {
        if (this.activeTurn !== turn || turn.terminal || this.disposed) return;
        this.projectEvent(turn, event);
      }) ?? null;

    this.emitStatus(turn, 'running');
    void this.runPrompt(turn, prompt).catch((error) => {
      this.options.log?.('Pi worker prompt failed:', error);
    });
    return { accepted: true, requestId: input.requestId };
  }

  async stop(input: WorkerStopPayload): Promise<WorkerStopResult> {
    this.assertLogicalSession(input.logicalSessionId);
    const turn = this.activeTurn;
    if (!turn || turn.terminal) return { stopped: false };

    turn.stopRequested = true;
    this.emitStatus(turn, 'stopping');
    this.extensionUi.cancelAll('aborted');
    const session = this.handle?.session;
    try {
      session?.clearQueue?.();
      session?.abortCompaction?.();
      session?.abortBranchSummary?.();
      session?.abortBash?.();
    } catch {
      // Helper aborts are best effort; AgentSession.abort remains authoritative.
    }
    try {
      await session?.abort();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finishTurn(turn, 'failed', `Failed to stop Pi session: ${message}`);
      throw new PiWorkerSessionError('WORKER_STOP_FAILED', `Failed to stop Pi session: ${message}`);
    }
    this.finishTurn(turn, 'stopped');
    return { stopped: true };
  }

  respondExtensionUi(response: ExtensionUiResponse): boolean {
    return this.extensionUi.respond(response);
  }

  setPermissionTier(tier: SessionPermissionTier): void {
    this.tierState?.setTier(tier);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    const turn = this.activeTurn;
    if (turn && !turn.terminal) {
      try {
        await this.stop({ logicalSessionId: this.logicalSessionId, reason: 'dispose' });
      } catch {
        // Continue process teardown even when abort itself reports a failure.
      }
    }
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.extensionUi.dispose('host_shutdown');

    let handle = this.handle;
    if (!handle && this.bootstrapPromise) {
      try {
        await this.bootstrapPromise;
        handle = this.handle;
      } catch {
        // Failed bootstrap already disposed any partial runtime.
      }
    }
    this.handle = null;
    this.sessionManager = null;
    this.sdk = null;
    // Staged fork files are Main-owned after worker.fork returns. Only the
    // explicit discard RPC may delete one; source-worker teardown must not
    // race a successful index commit in another slot.
    this.stagedForkFiles.clear();
    if (handle?.dispose) await handle.dispose();
    else handle?.session.dispose?.();
  }

  private async runPrompt(
    turn: ActiveTurn,
    prompt: { text: string; options?: PiPromptOptions }
  ): Promise<void> {
    try {
      await this.requireHandle().session.prompt?.(prompt.text, prompt.options);
    } catch (error) {
      if (turn.terminal || this.activeTurn !== turn) return;
      if (turn.stopRequested) this.finishTurn(turn, 'stopped');
      else this.finishTurn(turn, 'failed', error instanceof Error ? error.message : String(error));
    }
  }

  private projectEvent(turn: ActiveTurn, event: PiAgentEvent): void {
    const sessionId = this.logicalSessionId;
    const requestId = turn.requestId;
    const projection = turn.projection;

    switch (event.type) {
      case 'agent_start':
        projection.textSnapshot = '';
        projection.thinkingSnapshot = '';
        break;
      case 'agent_end': {
        const messages = Array.isArray(event.messages) ? event.messages : [];
        const last = [...messages].reverse().find((message) => {
          return (
            typeof message === 'object' &&
            message !== null &&
            'role' in message &&
            message.role === 'assistant'
          );
        }) as { stopReason?: string; errorMessage?: string } | undefined;
        if (
          !event.willRetry &&
          last &&
          (last.stopReason === 'error' || last.stopReason === 'aborted')
        ) {
          turn.pendingError = last.errorMessage ?? `Model response ${last.stopReason}`;
        }
        break;
      }
      case 'agent_settled':
        if (turn.stopRequested) this.finishTurn(turn, 'stopped');
        else if (turn.pendingError) this.finishTurn(turn, 'failed', turn.pendingError);
        else this.finishTurn(turn, 'completed');
        break;
      case 'message_start': {
        const message = event.message as { role?: string; content?: unknown } | undefined;
        if (message?.role === 'user') {
          const messageId = `user-${sessionId}-${turn.token}`;
          this.emit({
            type: 'message.started',
            sessionId,
            requestId,
            payload: {
              messageId,
              role: 'user',
              attemptId: turn.attemptId,
              ...(turn.attachmentMetadata.length > 0
                ? { attachments: turn.attachmentMetadata }
                : {}),
            },
          });
          const text = turn.userText || extractTextContent(message.content) || '';
          if (text) {
            this.emit({
              type: 'message.delta',
              sessionId,
              requestId,
              payload: { messageId, blockId: `${messageId}-text`, text },
            });
          }
          this.emit({ type: 'message.completed', sessionId, requestId, payload: { messageId } });
        } else if (message?.role === 'assistant') {
          this.ensureAssistant(turn);
        }
        break;
      }
      case 'message_update': {
        const message = event.message as
          | { role?: string; content?: Array<{ type: string; text?: string; thinking?: string }> }
          | undefined;
        const update = event.assistantMessageEvent as
          | { type?: string; delta?: string; content?: string }
          | undefined;
        const fullText =
          message?.role === 'assistant' && Array.isArray(message.content)
            ? message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text ?? '')
                .join('')
            : '';
        const fullThinking =
          message?.role === 'assistant' && Array.isArray(message.content)
            ? message.content
                .filter((part) => part.type === 'thinking')
                .map((part) => part.thinking ?? '')
                .join('')
            : '';

        let textUpdate: { value: string; source: StreamUpdateSource } | null = null;
        if (fullText) textUpdate = { value: fullText, source: 'snapshot' };
        else if (update?.type === 'text_delta' && update.delta) {
          textUpdate = { value: update.delta, source: 'delta' };
        } else if (update?.type === 'text_end' && update.content) {
          textUpdate = { value: update.content, source: 'snapshot' };
        }
        if (textUpdate) {
          const next = takeStreamUpdate(
            projection.textSnapshot,
            textUpdate.value,
            textUpdate.source
          );
          projection.textSnapshot = next.cumulative;
          this.emitTextDelta(turn, next.chunk);
        }

        let thinkingUpdate: { value: string; source: StreamUpdateSource } | null = null;
        if (fullThinking) thinkingUpdate = { value: fullThinking, source: 'snapshot' };
        else if (update?.type === 'thinking_delta' && update.delta) {
          thinkingUpdate = { value: update.delta, source: 'delta' };
        } else if (update?.type === 'thinking_end' && update.content) {
          thinkingUpdate = { value: update.content, source: 'snapshot' };
        }
        if (thinkingUpdate) {
          const next = takeStreamUpdate(
            projection.thinkingSnapshot,
            thinkingUpdate.value,
            thinkingUpdate.source
          );
          projection.thinkingSnapshot = next.cumulative;
          this.emitThinkingDelta(turn, next.chunk);
        }
        break;
      }
      case 'message_end': {
        const message = event.message as
          | {
              role?: string;
              stopReason?: string;
              errorMessage?: string;
              customType?: string;
              content?: unknown;
              display?: boolean;
              details?: unknown;
            }
          | undefined;
        if (message?.role === 'custom') {
          if (message.display === false || !message.customType) break;
          this.closeProseStream(turn);
          this.emit({
            type: 'custom.message',
            sessionId,
            requestId,
            payload: {
              messageId: this.nextCustomMessageId(turn),
              customType: message.customType,
              content: customTimelineContent(message.content, message.details),
            },
          });
          break;
        }
        if (message?.role !== 'assistant') break;
        const messageId = projection.proseClosed ? null : projection.assistantMessageId;
        if (messageId && ['stop', 'length', 'toolUse'].includes(message.stopReason ?? '')) {
          this.emit({
            type: 'message.completed',
            sessionId,
            requestId,
            payload: { messageId },
          });
        }
        if (
          !turn.stopRequested &&
          (message.stopReason === 'error' || message.stopReason === 'aborted')
        ) {
          turn.pendingError = message.errorMessage ?? `Model response ${message.stopReason}`;
        }
        this.closeProseStream(turn);
        break;
      }
      case 'entry_appended': {
        const entry = event.entry as
          | { type?: string; customType?: string; data?: unknown }
          | undefined;
        if (entry?.type !== 'custom' || !entry.customType) break;
        this.closeProseStream(turn);
        this.emit({
          type: 'custom.entry',
          sessionId,
          requestId,
          payload: {
            messageId: this.nextCustomMessageId(turn),
            customType: entry.customType,
            content: customTimelineContent(undefined, entry.data),
          },
        });
        break;
      }
      case 'tool_execution_start': {
        this.closeProseStream(turn);
        const messageId = this.ensureAssistant(turn);
        this.emit({
          type: 'tool.started',
          sessionId,
          requestId,
          payload: {
            messageId,
            toolCallId: String(event.toolCallId ?? ''),
            name: String(event.toolName ?? ''),
            input: event.args ?? {},
          },
        });
        break;
      }
      case 'tool_execution_update': {
        const messageId = projection.assistantMessageId ?? this.ensureAssistant(turn);
        this.emit({
          type: 'tool.updated',
          sessionId,
          requestId,
          payload: {
            messageId,
            toolCallId: String(event.toolCallId ?? ''),
            ...(event.args !== undefined ? { input: event.args } : {}),
          },
        });
        break;
      }
      case 'tool_execution_end': {
        const failed = event.isError === true;
        const output = readToolOutput(event.result);
        const messageId = projection.assistantMessageId ?? this.ensureAssistant(turn);
        this.emit({
          type: 'tool.completed',
          sessionId,
          requestId,
          payload: {
            messageId,
            toolCallId: String(event.toolCallId ?? ''),
            ok: !failed,
            output,
            ...(failed ? { error: output || 'Tool call failed' } : {}),
          },
        });
        break;
      }
      case 'auto_retry_start':
        this.emit({
          type: 'session.status',
          sessionId,
          requestId,
          payload: {
            status: 'running',
            retry: {
              attempt: numberOr(event.attempt, 0),
              maxRetries: numberOr(event.maxAttempts, 0),
              delayMs: numberOr(event.delayMs, 0),
              error: stringOr(event.errorMessage, ''),
              errorStatus: stringOrNull(event.errorStatus),
            },
          },
        });
        break;
      default:
        break;
    }
  }

  private ensureAssistant(turn: ActiveTurn): string {
    const projection = turn.projection;
    if (!projection.assistantMessageId) {
      const messageId = `asst-${this.logicalSessionId}-${Date.now()}-${++this.assistantSequence}`;
      projection.assistantMessageId = messageId;
      projection.textBlockId = `${messageId}-text`;
      projection.thinkingBlockId = `${messageId}-thinking`;
      projection.thinkingStarted = false;
      projection.thinkingCompleted = false;
      const model = this.handle?.session.model;
      this.emit({
        type: 'message.started',
        sessionId: this.logicalSessionId,
        requestId: turn.requestId,
        payload: {
          messageId,
          role: 'assistant',
          ...(model ? { model: `${model.provider}/${model.id}` } : {}),
        },
      });
    }
    return projection.assistantMessageId;
  }

  private openProseMessage(turn: ActiveTurn): string {
    const projection = turn.projection;
    if (projection.proseClosed) {
      projection.proseClosed = false;
      projection.assistantMessageId = null;
      projection.textBlockId = null;
      projection.thinkingBlockId = null;
      projection.thinkingStarted = false;
      projection.thinkingCompleted = false;
    }
    return this.ensureAssistant(turn);
  }

  private completeThinking(turn: ActiveTurn): void {
    const projection = turn.projection;
    if (!projection.thinkingStarted || projection.thinkingCompleted) return;
    if (!projection.assistantMessageId || !projection.thinkingBlockId) return;
    projection.thinkingCompleted = true;
    this.emit({
      type: 'thinking.completed',
      sessionId: this.logicalSessionId,
      requestId: turn.requestId,
      payload: {
        messageId: projection.assistantMessageId,
        blockId: projection.thinkingBlockId,
      },
    });
  }

  private closeProseStream(turn: ActiveTurn): void {
    this.completeThinking(turn);
    turn.projection.proseClosed = true;
    turn.projection.textSnapshot = '';
    turn.projection.thinkingSnapshot = '';
  }

  private emitTextDelta(turn: ActiveTurn, text: string): void {
    if (!text) return;
    this.completeThinking(turn);
    const messageId = this.openProseMessage(turn);
    this.emit({
      type: 'message.delta',
      sessionId: this.logicalSessionId,
      requestId: turn.requestId,
      payload: {
        messageId,
        blockId: turn.projection.textBlockId ?? `${messageId}-text`,
        text,
      },
    });
  }

  private emitThinkingDelta(turn: ActiveTurn, text: string): void {
    if (!text) return;
    const messageId = this.openProseMessage(turn);
    const blockId = turn.projection.thinkingBlockId ?? `${messageId}-thinking`;
    if (!turn.projection.thinkingStarted) {
      turn.projection.thinkingStarted = true;
      this.emit({
        type: 'thinking.started',
        sessionId: this.logicalSessionId,
        requestId: turn.requestId,
        payload: { messageId, blockId },
      });
    }
    this.emit({
      type: 'thinking.delta',
      sessionId: this.logicalSessionId,
      requestId: turn.requestId,
      payload: { messageId, blockId, text },
    });
  }

  private nextCustomMessageId(turn: ActiveTurn): string {
    this.customSequence += 1;
    return `custom-${this.logicalSessionId}-${turn.token}-${this.customSequence}`;
  }

  private finishTurn(
    turn: ActiveTurn,
    outcome: 'completed' | 'failed' | 'stopped',
    error?: string
  ): void {
    if (turn.terminal || this.activeTurn !== turn) return;
    turn.terminal = true;
    this.completeThinking(turn);
    this.emit({
      type: `session.${outcome}`,
      sessionId: this.logicalSessionId,
      requestId: turn.requestId,
      payload: outcome === 'failed' ? { error: error ?? 'Agent request failed' } : {},
    });
    this.emitStatus(turn, 'idle');
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.activeTurn = null;
  }

  private emitStatus(turn: ActiveTurn, status: 'running' | 'stopping' | 'idle'): void {
    this.emit({
      type: 'session.status',
      sessionId: this.logicalSessionId,
      requestId: turn.requestId,
      payload: { status },
    });
  }

  private async applySelectedModel(
    handle: PiRuntimeHandle,
    requestedModel: string | undefined
  ): Promise<void> {
    const selected = requestedModel?.trim();
    if (!selected) return;
    const ref = parsePiModelRef(selected);
    if (!ref)
      throw new PiWorkerSessionError('WORKER_INVALID_MODEL', `Invalid Pi model: ${selected}`);
    const model: PiModel | undefined = handle.services.modelRuntime.getModel(
      ref.provider,
      ref.modelId
    );
    if (!model)
      throw new PiWorkerSessionError('WORKER_MODEL_NOT_FOUND', `Pi model not found: ${selected}`);
    if (
      handle.session.model?.provider !== ref.provider ||
      handle.session.model?.id !== ref.modelId
    ) {
      if (!handle.session.setModel) {
        throw new PiWorkerSessionError(
          'WORKER_MODEL_UNSUPPORTED',
          'Pi session cannot change model'
        );
      }
      await handle.session.setModel(model, { persist: false });
    }
  }

  private applyEffort(session: PiSession, effort: SessionEffortLevel | undefined): void {
    if (!effort) return;
    if (!session.setThinkingLevel) {
      throw new PiWorkerSessionError(
        'WORKER_EFFORT_UNSUPPORTED',
        `This Pi SDK cannot apply reasoning effort "${effort}"`
      );
    }
    session.setThinkingLevel(effort, { persist: false });
  }

  private assertIdle(action: string): void {
    if (this.disposed) {
      throw new PiWorkerSessionError('WORKER_SESSION_DISPOSED', 'Pi worker session is disposed');
    }
    if (this.activeTurn && !this.activeTurn.terminal) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_BUSY',
        `Session cannot ${action} while a turn is active`,
        true
      );
    }
    if (this.handle?.session.isStreaming === true) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_BUSY',
        `Session cannot ${action} while Pi is streaming`,
        true
      );
    }
  }

  private assertLogicalSession(sessionId: string): void {
    if (sessionId !== this.logicalSessionId) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_MISMATCH',
        `Worker owns ${this.logicalSessionId}, not ${sessionId}`
      );
    }
  }

  private requireHandle(): PiRuntimeHandle {
    if (!this.handle)
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    return this.handle;
  }

  private async bootstrapInternal(): Promise<WorkerBootstrapResult> {
    const sdk = (
      this.options.loadSdk
        ? await this.options.loadSdk()
        : await import('@earendil-works/pi-coding-agent')
    ) as PiSdkModule;
    this.sdk = sdk;
    const { factory: tierFactory, state: tierState } = createSessionTierAuthorizer({
      log: this.options.log,
      // Seeded, not left on the default: a bootstrap that ignored this would
      // reopen the window where the runtime enforces a laxer tier than the one
      // the user picked. `undefined` here still means the default tier.
      ...(this.options.tier ? { initialTier: this.options.tier } : {}),
    });
    this.tierState = tierState;

    const bootstrapped = await bootstrapPiAgentSession({
      sdk,
      cwd: this.cwd,
      projectTrusted: this.options.projectTrusted,
      extensionUi: this.extensionUi,
      sessionFile: this.options.sessionFile,
      model: this.options.model,
      effort: this.options.effort,
      leafCheckpoint: this.options.leafCheckpoint,
      decidePermissionGate: this.options.decidePermissionGate,
      additionalExtensionFactories: [
        { name: 'aiclient-session-tier', factory: tierFactory, hidden: true },
      ],
      log: this.options.log,
      onPermissionActivity: (payload) =>
        this.emit({ type: 'permission.activity', sessionId: this.logicalSessionId, payload }),
    });
    if (this.disposed) {
      if (bootstrapped.handle.dispose) await bootstrapped.handle.dispose();
      else bootstrapped.handle.session.dispose?.();
      throw new PiWorkerSessionError(
        'WORKER_SESSION_DISPOSED',
        'Pi worker session was disposed during bootstrap'
      );
    }
    this.handle = bootstrapped.handle;
    this.sessionManager = bootstrapped.sessionManager;
    const model = selectedModel(bootstrapped.handle) ?? this.options.model;
    const sessionFile = bootstrapped.handle.session.sessionFile;
    let initialHistory: WorkerHistoryResult | undefined;
    try {
      initialHistory = this.options.sessionFile
        ? await this.historyFromOpenedSession(bootstrapped.sessionManager, sessionFile)
        : undefined;
    } catch (error) {
      this.handle = null;
      this.sessionManager = null;
      if (bootstrapped.handle.dispose) await bootstrapped.handle.dispose().catch(() => undefined);
      else bootstrapped.handle.session.dispose?.();
      throw error;
    }
    return {
      bootstrapped: true,
      logicalSessionId: this.logicalSessionId,
      piSessionId: bootstrapped.handle.session.sessionId,
      cwd: this.cwd,
      agentDir: bootstrapped.agentDir,
      ...(sessionFile ? { sessionFile } : {}),
      ...(initialHistory ? { initialHistory } : {}),
      leaf: readPiLeafCheckpoint(bootstrapped.sessionManager),
      ...(model ? { model } : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      projectTrusted: bootstrapped.projectTrusted,
      permissionGate: bootstrapped.permissionGate,
      // U04 — omitted when empty so "reported nothing" and "reported an empty
      // list" stay distinguishable downstream.
      ...(bootstrapped.extensions.length > 0 ? { extensions: bootstrapped.extensions } : {}),
    };
  }

  private async historyFromOpenedSession(
    manager: PiSessionManager,
    sessionFile: string | undefined
  ): Promise<WorkerHistoryResult> {
    if (!sessionFile || !manager.getBranch) {
      throw new PiWorkerSessionError(
        'WORKER_HISTORY_UNAVAILABLE',
        'Opened Pi session does not expose durable branch history'
      );
    }
    try {
      return {
        logicalSessionId: this.logicalSessionId,
        sessionFile,
        workspacePath: this.cwd,
        page: readPiSessionHistoryPage({ getBranch: () => manager.getBranch?.() ?? [] }),
      };
    } catch (error) {
      throw error instanceof PiWorkerSessionError
        ? error
        : new PiWorkerSessionError(
            'WORKER_SESSION_READ_FAILED',
            `Failed to project Pi session history: ${error instanceof Error ? error.message : String(error)}`,
            true
          );
    }
  }

  private emit(event: RuntimeEventDraft): void {
    if (!this.disposed) this.options.emit(event);
  }
}
