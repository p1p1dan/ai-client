import { paginatePiSessionHistory } from '../../../agent-host/piSessionTimeline';
import type {
  NativeIndexedRunRequest,
  NativeSessionIndexClient,
} from '../../../shared/types/nativeSession';
import type { RuntimeEvent, RuntimeEventDraft } from '../../../shared/types/runtimeEvents';
import type { SessionIndexService } from './SessionIndexService';

/** Main-side adapter; the runtime never imports Electron or owns session-index.json. */
export class NativeSessionIndexAdapter {
  private readonly runtime: NativeSessionIndexClient;
  private readonly index: SessionIndexService;
  private readonly sessionId: string;
  private readonly emit: (event: RuntimeEvent) => void;
  private readonly nextSequence: () => number;
  private unsubscribe?: () => void;
  private running = false;
  private operationActive = false;
  private pendingTerminal: RuntimeEventDraft[] = [];
  constructor(options: {
    runtime: NativeSessionIndexClient;
    index: SessionIndexService;
    sessionId: string;
    emit: (event: RuntimeEvent) => void;
    /** Shared host counter, not a counter per WorkerSlot. */
    nextSequence: () => number;
  }) {
    this.runtime = options.runtime;
    this.index = options.index;
    this.sessionId = options.sessionId;
    this.emit = options.emit;
    this.nextSequence = options.nextSequence;
  }
  private get session() {
    const session = this.runtime.session;
    if (!session) throw new Error('native session indexing requires persistent session storage');
    return session;
  }
  private publish(draft: RuntimeEventDraft) {
    const event = {
      ...draft,
      sessionId: this.sessionId,
      seq: this.nextSequence(),
      timestamp: Date.now(),
    } as RuntimeEvent;
    this.index.handleRuntimeEvent(event);
    this.emit(event);
  }
  private async operate<T>(work: () => Promise<T>, needsConnection = true): Promise<T> {
    if (needsConnection && !this.unsubscribe)
      throw new Error('native index adapter is not connected');
    if (this.operationActive) throw new Error('native indexed session is busy');
    this.operationActive = true;
    try {
      return await work();
    } finally {
      this.operationActive = false;
    }
  }
  async connect(mode: 'create' | 'resume' | 'fork' | 'import'): Promise<void> {
    return this.operate(async () => {
      if (this.unsubscribe) throw new Error('native index adapter is already connected');
      const metadata = this.session.metadata();
      const existing = await this.index.get(this.sessionId);
      if (mode === 'resume') {
        if (!existing) throw new Error('resume requires an indexed logical session');
        const migrated =
          typeof metadata.sourceFile === 'string' &&
          metadata.sourceFile === existing.runtimeIdentity;
        if (existing.runtimeIdentity !== metadata.file && !migrated)
          throw new Error('native resume identity mismatch');
        if (migrated) await this.index.bindRuntimeIdentity(this.sessionId, metadata.file);
        try {
          await this.index.commitResumed({
            sessionId: this.sessionId,
            workspacePath: metadata.cwd,
            runtimeIdentity: metadata.file,
            piLeaf: metadata.leaf,
          });
        } catch (error) {
          if (migrated && existing.runtimeIdentity)
            await this.index.bindRuntimeIdentity(this.sessionId, existing.runtimeIdentity);
          throw error;
        }
      } else {
        if (existing) throw new Error('logical session already exists');
        const entry = {
          sessionId: this.sessionId,
          runtimeIdentity: metadata.file,
          workspacePath: metadata.cwd,
          agent: 'pi',
          title: metadata.title,
          model: metadata.model,
          updatedAt: Date.now(),
          archived: false,
          piLeaf: metadata.leaf,
        };
        if (mode === 'fork') await this.index.createForked(entry);
        else await this.index.createImported(entry);
      }
      this.unsubscribe = this.runtime.events.subscribe((event) => {
        if (event.sessionId !== this.sessionId && event.sessionId !== metadata.id) return;
        if (
          this.running &&
          (['session.completed', 'session.failed', 'session.stopped'].includes(event.type) ||
            (event.type === 'session.status' && event.payload.status === 'idle'))
        )
          this.pendingTerminal.push(event);
        else this.publish(event);
      });
      this.publish({
        type: mode === 'resume' ? 'session.resumed' : 'session.created',
        sessionId: this.sessionId,
        payload: { agent: 'pi', runtimeIdentity: metadata.file },
      });
      if (mode === 'resume' || mode === 'fork' || mode === 'import')
        this.history(`history-${metadata.id}`);
      this.publish({
        type: 'session.status',
        sessionId: this.sessionId,
        payload: { status: 'idle' },
      });
    }, false);
  }
  history(requestId: string, offset?: number, limit?: number) {
    if (!this.unsubscribe) throw new Error('native index adapter is not connected');
    const metadata = this.session.metadata();
    const page = paginatePiSessionHistory(this.session.history(), offset, limit);
    this.publish({
      type: 'session.history',
      sessionId: this.sessionId,
      requestId,
      payload: {
        runtimeIdentity: metadata.file,
        workspacePath: metadata.cwd,
        agent: 'pi',
        ...page,
        truncated: page.hasMore,
        omittedCount: Math.max(0, page.totalCount - page.offset - page.messages.length),
      },
    });
    return page;
  }
  async run(request: NativeIndexedRunRequest) {
    return this.operate(async () => {
      this.running = true;
      try {
        const result = await this.runtime.run({ ...request, logicalSessionId: this.sessionId });
        const metadata = this.session.metadata();
        await this.index.commitResumed({
          sessionId: this.sessionId,
          workspacePath: metadata.cwd,
          model: metadata.model,
          runtimeIdentity: metadata.file,
          piLeaf: metadata.leaf,
        });
        for (const event of this.pendingTerminal.splice(0)) this.publish(event);
        return result;
      } catch (error) {
        this.pendingTerminal = [];
        this.publish({
          type: 'session.failed',
          sessionId: this.sessionId,
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
        this.publish({
          type: 'session.status',
          sessionId: this.sessionId,
          payload: { status: 'idle' },
        });
        throw error;
      } finally {
        this.running = false;
      }
    });
  }
  async rewind(entryId: string, confirmed: boolean) {
    return this.operate(async () => {
      const before = this.session.metadata();
      const result = await this.session.rewind(entryId, confirmed);
      try {
        await this.index.commitPiLeaf({
          sessionId: this.sessionId,
          runtimeIdentity: result.file,
          piLeaf: result.leaf,
        });
      } catch (error) {
        await this.session.navigate(before.leaf.activeEntryId);
        throw error;
      }
      return result;
    });
  }
  async navigate(entryId: string | null): Promise<void> {
    return this.operate(async () => {
      const before = this.session.metadata();
      await this.session.navigate(entryId);
      try {
        await this.index.commitPiLeaf({
          sessionId: this.sessionId,
          runtimeIdentity: before.file,
          piLeaf: this.session.metadata().leaf,
        });
      } catch (error) {
        await this.session.navigate(before.leaf.activeEntryId);
        throw error;
      }
    });
  }
  async fork(file: string, entryId: string, logicalSessionId?: string) {
    return this.operate(async () => {
      const fork = await this.session.fork(file, entryId);
      try {
        const row = await this.index.createForked({
          sessionId: logicalSessionId ?? fork.id,
          runtimeIdentity: fork.file,
          workspacePath: fork.cwd,
          piLeaf: fork.leaf,
          model: fork.model,
          agent: 'pi',
          title: fork.title,
          updatedAt: Date.now(),
          archived: false,
        });
        this.session.acceptFork(fork.file);
        return row;
      } catch (error) {
        await this.session.discardFork(fork.file, fork.id);
        throw error;
      }
    });
  }
  async rename(title: string): Promise<void> {
    return this.operate(async () => {
      const before = this.session.metadata().title;
      await this.session.rename(title);
      try {
        if (!(await this.index.rename(this.sessionId, title)))
          throw new Error('session index row missing');
      } catch (error) {
        await this.session.rename(before);
        throw error;
      }
    });
  }
  disconnect(): void {
    if (this.operationActive) throw new Error('native indexed session is busy');
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
