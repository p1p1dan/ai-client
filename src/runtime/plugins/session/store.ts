import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import {
  type AgentMessage,
  buildSessionContext,
  type CompactionEntry,
  type CompactResult,
  type Entry,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import { projectPiSessionHistory } from '../../../agent-host/piSessionTimeline.ts';
import { buildPiSessionTreeSnapshot } from '../../../agent-host/piSessionTree.ts';
import type { RuntimePermissionSettings } from '../../../shared/types/runtimePermission.ts';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { errorCode, positiveInteger, RuntimeHostError } from '../../host/errors.ts';
import {
  branchEntries,
  cliBookkeeping,
  decodeSession,
  interopHeader,
  isInteropHeader,
  isSuccessfulMessage,
  SESSION_MAX_BYTES,
  type SessionDocument,
  type SessionSkippedRow,
} from './codec.ts';
import { sessionPermissions } from './legacy.ts';
import { acquireWriterLock, releaseWriterLock, type WriterLock } from './writerLock.ts';

export interface SessionConfig {
  file: string;
  cwd: string;
  mode: 'create' | 'resume' | 'import';
  /**
   * P5-4 — the header id a NEW session must carry, instead of a fresh uuid.
   *
   * Only the conversation importer passes one: Main allocates the id before the
   * worker exists (it is what the manifest, the session index row and any later
   * reconcile all key on), so a session created with an id of its own choosing
   * would be unreachable by every one of them. Ignored outside `create`, where
   * the id is whatever the file already states.
   */
  id?: string;
  sourceFile?: string;
  allowWorkspaceRelocation?: boolean;
  /** Bound the in-memory transcript on this host; oversized files fail explicitly. */
  maxBytes?: number;
  /**
   * Where this store reports what it could not fail on.
   *
   * There is exactly one such thing today (see `close`): a writer lock that was
   * taken over while we held it. It is not an error — nothing the caller does
   * differs — but it is the only evidence that two processes disagreed about
   * who owns this file, so it must not vanish. Defaults to `console.warn`,
   * which on a worker is stderr and reaches Main's forwarder.
   */
  log?: (message: string, ...args: unknown[]) => void;
  /**
   * concurrency-02 — open the session even though its writer lock still looks
   * held.
   *
   * The remedy for a lock stranded under a pid the system has since handed to
   * an unrelated process: nothing can tell that apart from a running writer, so
   * the refusal explains itself and this is what an explicit "open it anyway"
   * sets. Never set on its own — the default open is the one that refuses.
   */
  forceTakeover?: boolean;
}
export type NewSessionEntry<T extends Entry = Entry> = T extends Entry
  ? Omit<T, 'id' | 'seq' | 'parentId' | 'timestamp'>
  : never;
export interface SessionMetadata {
  id: string;
  file: string;
  cwd: string;
  title: string;
  model?: string;
  sourceFile?: string;
  createdAt: number;
  leaf: { activeEntryId: string | null; fileTailEntryId: string | null };
}
/**
 * session-02 — what opening this file had to drop to make it readable.
 *
 * Present only when the file was actually rewritten, so `recovery !== undefined`
 * is itself the statement "this session healed on this open". Deliberately NOT
 * folded into `metadata()`: metadata is a value the worker copies into its
 * bootstrap result and Main persists into the session index, and a one-time
 * repair note has no business being stored as a property of the session.
 */
export interface SessionRecovery {
  skipped: readonly SessionSkippedRow[];
}

export interface SessionSnapshot {
  id: string;
  entries: Entry[];
  messages: AgentMessage[];
  checkpoint?: CompactionEntry;
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  permissions?: RuntimePermissionSettings;
}

/**
 * capacity-04 — the most bytes ONE line of the session file may carry.
 *
 * The aggregate budget answers "does the file still fit"; it says nothing about
 * how big a single write may be, so on a nearly empty file one entry could
 * legally approach the whole 32 MiB. Every known writer already has its own
 * ceiling (tool output 50 KiB, review patch 64 KiB, MCP text and images,
 * attachments), which is exactly why this exists: it is the net under the
 * writer that gets added later and forgets to bring one, and it converts that
 * omission into a refused write with a name instead of a conversation that
 * silently becomes read-only.
 *
 * A quarter of the budget matches the per-send attachment share
 * (`plugins/agent-loop/attachments.ts`), so the largest legitimate entry — a
 * user message carrying pictures — stays comfortably under it.
 */
export const SESSION_MAX_ENTRY_BYTES = Math.floor(SESSION_MAX_BYTES / 4);

/**
 * What the stored line adds to the payload it carries: `kind`, `lane`, a uuid
 * `id`, `seq`, a uuid `parentId` and `timestamp`. Counted in the pre-flight
 * check so an oversized payload is refused BEFORE it enters the write queue —
 * a rejection inside the queue is permanent by design (`enqueue`), so a net
 * that tripped there would turn one refused message into a dead session, which
 * is the outcome the net exists to prevent.
 */
const ENTRY_OVERHEAD_BYTES = 256;

export class JsonlSessionStore {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private running = false;
  private navigating = false;
  private navigationWork?: Promise<unknown>;
  private readonly stagedForks = new Map<string, string>();
  private closing: Promise<void> | undefined;
  private failure: unknown;
  readonly file: string;
  private readonly io: RuntimeHostIoService;
  private readonly document: SessionDocument;
  private readonly lock: WriterLock;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly log: (message: string, ...args: unknown[]) => void;
  private bytes: number;
  private constructor(
    file: string,
    io: RuntimeHostIoService,
    document: SessionDocument,
    lock: WriterLock,
    maxBytes: number,
    bytes: number,
    log?: (message: string, ...args: unknown[]) => void
  ) {
    this.file = file;
    this.io = io;
    this.document = document;
    this.lock = lock;
    this.maxBytes = maxBytes;
    // Never above the whole budget: a host that configured a small session gets
    // the aggregate refusal it asked for, not a second limit larger than it.
    this.maxEntryBytes = Math.min(SESSION_MAX_ENTRY_BYTES, maxBytes);
    this.log = log ?? ((message, ...args) => console.warn(message, ...args));
    this.bytes = bytes;
  }

  static async open(io: RuntimeHostIoService, config: SessionConfig): Promise<JsonlSessionStore> {
    const maxBytes = config.maxBytes ?? SESSION_MAX_BYTES;
    positiveInteger(maxBytes, 'session.maxBytes');
    const requested = resolve(config.file);
    if (config.mode === 'create')
      await io.mkdir(dirname(requested), { recursive: true, mode: 0o700 });
    const parent = await io.realpath(dirname(requested));
    let file = join(parent, basename(requested));
    try {
      file = await io.realpath(file);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const lock = await acquireWriterLock(io, file, { force: config.forceTakeover === true });
    try {
      let document: SessionDocument;
      let bytes: number;
      if (config.mode === 'create') {
        document = {
          header: interopHeader({
            kind: 'header',
            version: 4,
            id: config.id ?? randomUUID(),
            createdAt: Date.now(),
            cwd: await io.realpath(config.cwd),
          }),
          entries: [],
          leafId: null,
          seq: 0,
        };
        const content = `${JSON.stringify(document.header)}\n`;
        bytes = Buffer.byteLength(content);
        if (bytes > maxBytes)
          throw new RuntimeHostError(
            'session_size_limit',
            'session header exceeds the size budget'
          );
        await io.writeFile(file, Buffer.from(content), { createOnly: true, mode: 0o600 });
      } else {
        const result = await io.readFile(file, { maxBytes, overflow: 'error' });
        const content = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes, {
          stream: result.bytes.at(-1) !== 10,
        });
        document = decodeSession(content);
        if (Buffer.byteLength(content) !== result.bytes.length && document.repair === undefined)
          document.repair = content;
        if (document.header.cwd !== (await io.realpath(config.cwd)))
          throw new RuntimeHostError(
            'session_cwd_mismatch',
            'resume cwd differs from the session workspace'
          );
        bytes = result.bytes.length;
        // H/20 — sessions written before the dual header still declare v4 only,
        // and `pi --session` refuses those outright. Upgrading the one line here
        // (atomically, under the writer lock we already hold) is what makes the
        // interop apply to a user's existing conversations instead of only to
        // the ones created from now on. Nothing else in the file is touched.
        if (!isInteropHeader(document.header)) {
          document.header = interopHeader(document.header);
          const body = document.repair ?? content;
          document.repair = `${JSON.stringify(document.header)}\n${body.slice(body.indexOf('\n') + 1)}`;
        }
        // session-02 — the same atomic rewrite now also lands the decoder's
        // drop of unparseable middle rows (decision 006). It has to happen here
        // and nowhere else: we hold the writer lock, so this is the only moment
        // at which the file can be replaced without racing our own appends, and
        // leaving the rows in place would mean re-deciding to drop them on
        // every future open, with `pi --session` silently doing the same.
        if (document.repair !== undefined) {
          const temporary = `${file}.${randomUUID()}.tmp`;
          try {
            await io.writeFile(temporary, Buffer.from(document.repair), {
              createOnly: true,
              mode: 0o600,
            });
            await io.rename(temporary, file);
          } catch (error) {
            await io.unlink(temporary).catch(() => {});
            throw error;
          }
          bytes = Buffer.byteLength(document.repair);
          delete document.repair;
        }
      }
      return new JsonlSessionStore(file, io, document, lock, maxBytes, bytes, config.log);
    } catch (error) {
      await releaseWriterLock(io, lock);
      throw error;
    }
  }

  snapshot(): SessionSnapshot {
    const entries = structuredClone(branchEntries(this.document));
    const clean = entries.filter(
      (item) => item.type !== 'message' || isSuccessfulMessage(item.message)
    );
    const checkpoint = clean.findLast(
      (item): item is CompactionEntry => item.type === 'compaction'
    );
    const context = buildSessionContext(clean);
    const messages = context.messages.filter(isSuccessfulMessage);
    return {
      id: this.document.header.id,
      entries,
      messages,
      checkpoint,
      ...(context.model ? { model: context.model } : {}),
      ...(entries.some((entry) => entry.type === 'thinking_level_change')
        ? { thinkingLevel: context.thinkingLevel as ThinkingLevel }
        : {}),
      permissions: sessionPermissions(entries, this.document.header.metadata?.permissions),
    };
  }

  appendMessage(message: AgentMessage): Promise<void> {
    return this.appendEntry({ type: 'message', message: structuredClone(message) }).then(() => {});
  }

  appendCompaction(result: CompactResult): Promise<CompactionEntry> {
    const payload = structuredClone({ type: 'compaction', ...result });
    // Resolved inside the queue rather than here: an append still waiting to be
    // written would move the branch the anchor is looked up in.
    return this.appendEntry(() => {
      const anchor = this.compactionAnchor(result.retainedTail);
      return (
        anchor === undefined ? payload : { ...payload, firstKeptEntryId: anchor }
      ) as NewSessionEntry;
    }) as Promise<CompactionEntry>;
  }

  /**
   * v3's way of saying where a compaction's kept tail begins.
   *
   * v4 stores the kept messages inside the entry itself, so this is written for
   * the CLI only: without it `pi --session` shows the summary and everything
   * after it, silently dropping the tail we deliberately retained.
   *
   * session-03 — found by identity, not by counting back N entries. This runtime
   * does not keep pi's tail: `context/compaction.ts` rebuilds it from the latest
   * user message, so the kept messages are NOT the last N on the branch, and
   * counting landed on whatever ended the turn — after a tool call, a toolResult.
   * The CLI would then open the conversation on a tool result whose tool call it
   * never sees, which providers reject as a malformed request. The timestamp
   * survives the rebuild (a truncated copy keeps it), so it is what identifies
   * the message; no single match means no anchor, and the CLI shows the summary
   * alone — a smaller context, not a broken one.
   */
  private compactionAnchor(retainedTail: readonly AgentMessage[]): string | undefined {
    const first = retainedTail[0];
    if (!first) return undefined;
    const matches = branchEntries(this.document).filter(
      (item) =>
        item.type === 'message' &&
        item.message.role === first.role &&
        item.message.timestamp === first.timestamp
    );
    return matches.length === 1 ? matches[0]?.id : undefined;
  }

  appendEntry(payload: NewSessionEntry | (() => NewSessionEntry)): Promise<Entry> {
    // Copied now so a caller cannot mutate what is about to be written. A
    // function instead of a value defers that to the queue, for a payload whose
    // content depends on the branch the write will extend.
    const entry = typeof payload === 'function' ? payload : structuredClone(payload);
    // capacity-04 — outside the queue, so refusing this one write leaves the
    // session writable. The queue's own check below is the exact one.
    // A deferred payload cannot be measured until the queue builds it, so it is
    // covered by the in-queue check alone — and a rejection there is permanent.
    // The only deferred writer today is `appendCompaction`, whose summary is
    // capped far below this ceiling upstream (capacity-03, 256 KiB); a new
    // deferred caller with an unbounded payload needs its own limit first.
    const oversize =
      typeof entry === 'function'
        ? undefined
        : this.entrySizeError(Buffer.byteLength(JSON.stringify(entry)) + ENTRY_OVERHEAD_BYTES);
    if (oversize) return Promise.reject(oversize);
    return this.enqueue(async () => {
      const item: Entry = {
        ...(typeof entry === 'function' ? entry() : entry),
        id: randomUUID(),
        seq: this.document.seq + 1,
        parentId: this.document.leafId,
        timestamp: Date.now(),
      };
      const line = `${JSON.stringify({ kind: 'entry', lane: 'main', ...item })}\n`;
      const bytes = Buffer.byteLength(line);
      if (this.bytes + bytes > this.maxBytes)
        throw new RuntimeHostError(
          'session_size_limit',
          'session exceeds the configured size budget'
        );
      const tooLarge = this.entrySizeError(bytes);
      if (tooLarge) throw tooLarge;
      await this.io.appendFile(this.file, Buffer.from(line), { mode: 0o600 });
      this.bytes += bytes;
      const {
        kind: _kind,
        lane: _lane,
        ...stored
      } = JSON.parse(line) as Entry & { kind: string; lane: string };
      this.document.entries.push(stored);
      this.document.leafId = item.id;
      this.document.seq = item.seq;
      return stored;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new RuntimeHostError('session_closed', 'session is closed'));
    const work = this.tail.then(operation);
    this.tail = work.then(() => {});
    void this.tail.catch((error) => {
      // session-06 — the queue keeps its failed state to refuse further writes,
      // but close() no longer reports it, so the first failure is kept here for
      // the host to read back.
      if (this.failure === undefined) this.failure = error;
    });
    return work;
  }

  get busy(): boolean {
    return this.running || this.navigating;
  }
  /**
   * session-02 — the rows `open` dropped, for whoever can show or log them.
   *
   * Read off the document rather than stored separately: the decoder is the one
   * place that knows what it could not parse, and the rewrite that removed the
   * rows happened under the writer lock this store still holds, so there is no
   * window in which this answer and the file disagree.
   */
  get recovery(): SessionRecovery | undefined {
    const skipped = this.document.skipped;
    return skipped?.length ? { skipped } : undefined;
  }
  /** The first write rejection, if any; see `close`. Also still thrown by `flush`. */
  get writeFailure(): unknown {
    return this.failure;
  }
  setRunning(running: boolean): void {
    this.running = running;
  }
  private assertIdle(): void {
    if (this.closed) throw new RuntimeHostError('session_closed', 'session is closed');
    if (this.busy)
      throw new RuntimeHostError('runtime_busy', 'session navigation requires an idle runtime');
  }

  metadata(): SessionMetadata {
    const model = buildSessionContext(branchEntries(this.document)).model;
    return {
      ...(model ? { model: `${model.provider}/${model.modelId}` } : {}),
      id: this.document.header.id,
      file: this.file,
      cwd: this.document.header.cwd,
      title: this.document.name ?? '',
      ...(typeof this.document.header.metadata?.importedFrom === 'string'
        ? { sourceFile: this.document.header.metadata.importedFrom }
        : {}),
      createdAt: this.document.header.createdAt,
      leaf: {
        activeEntryId: this.document.leafId,
        fileTailEntryId: this.document.entries.at(-1)?.id ?? null,
      },
    };
  }

  private projection() {
    const project = (items: Entry[]) =>
      items.map((entry) => ({ ...entry, timestamp: new Date(entry.timestamp).toISOString() }));
    return {
      getEntries: () => project(this.document.entries),
      getBranch: () => project(branchEntries(this.document)),
      getLeafId: () => this.document.leafId,
      getLabel: (id: string) => this.document.labels?.[id],
    };
  }

  tree(logicalSessionId = this.document.header.id) {
    return buildPiSessionTreeSnapshot({
      manager: this.projection(),
      logicalSessionId,
      sessionFile: this.file,
      workspacePath: this.document.header.cwd,
    });
  }

  history() {
    return projectPiSessionHistory(this.projection());
  }

  async navigate(entryId: string | null): Promise<SessionSnapshot> {
    return this.withNavigation(async () => {
      await this.flush();
      if (entryId !== null && !this.document.entries.some((entry) => entry.id === entryId))
        throw new RuntimeHostError('session_entry_not_found', `entry not found: ${entryId}`);
      await this.mutate({ kind: 'lane', lane: 'main', leafId: entryId }, () => {
        this.document.leafId = entryId;
      });
      return this.snapshot();
    });
  }

  async rewind(entryId: string, confirmed: boolean) {
    this.assertIdle();
    if (confirmed !== true)
      throw new RuntimeHostError(
        'session_confirmation_required',
        'rewind requires explicit confirmation'
      );
    await this.flush();
    const target = this.document.entries.find((entry) => entry.id === entryId);
    if (!target)
      throw new RuntimeHostError('session_entry_not_found', `entry not found: ${entryId}`);
    const user =
      target.type === 'message' &&
      (target.message.role === 'user' || target.message.role === 'custom')
        ? target.message
        : undefined;
    const editorText = user
      ? typeof user.content === 'string'
        ? user.content
        : user.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
      : undefined;
    await this.navigate(user ? target.parentId : target.id);
    return { ...this.metadata(), editorText, snapshot: this.snapshot() };
  }

  async rename(name: string | undefined): Promise<void> {
    await this.mutate({ kind: 'fact', fact: 'name', name }, () => {
      this.document.name = name;
    });
  }

  async label(entryId: string, label: string | undefined): Promise<void> {
    await this.flush();
    if (!this.document.entries.some((entry) => entry.id === entryId))
      throw new RuntimeHostError('session_entry_not_found', entryId);
    await this.mutate({ kind: 'fact', fact: 'label', targetId: entryId, label }, () => {
      this.document.labels ??= {};
      if (label === undefined) delete this.document.labels[entryId];
      else this.document.labels[entryId] = label;
    });
  }

  async fork(file: string, entryId: string): Promise<SessionMetadata> {
    return this.withNavigation(() => this.createFork(file, entryId));
  }

  private withNavigation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertIdle();
    this.navigating = true;
    const work = operation().finally(() => {
      this.navigating = false;
    });
    this.navigationWork = work;
    return work;
  }

  private async createFork(file: string, entryId: string): Promise<SessionMetadata> {
    await this.flush();
    if (!this.document.entries.some((entry) => entry.id === entryId))
      throw new RuntimeHostError('session_entry_not_found', entryId);
    const branch = branchEntries(this.document, entryId);
    if (!branch.some((entry) => entry.type === 'message' && entry.message.role === 'assistant'))
      throw new RuntimeHostError(
        'session_fork_unmaterialized',
        'fork requires an assistant on the selected path'
      );
    const fork = await JsonlSessionStore.open(this.io, {
      file,
      cwd: this.document.header.cwd,
      mode: 'create',
      maxBytes: this.maxBytes,
    });
    try {
      fork.document.header.parentSessionId = this.document.header.id;
      if (this.document.header.metadata?.permissions)
        fork.document.header.metadata = {
          permissions: structuredClone(this.document.header.metadata.permissions),
        };
      fork.document.entries = structuredClone(branch).map((entry, index) => ({
        ...entry,
        seq: index + 1,
      }));
      fork.document.leafId = entryId;
      fork.document.seq = branch.length;
      const data = `${[
        JSON.stringify(fork.document.header),
        ...fork.document.entries.map((entry) =>
          JSON.stringify({ kind: 'entry', lane: 'main', ...entry })
        ),
      ].join('\n')}\n`;
      if (Buffer.byteLength(data) > this.maxBytes)
        throw new RuntimeHostError('session_size_limit', 'fork exceeds size budget');
      await this.io.writeFile(fork.file, Buffer.from(data), { mode: 0o600 });
      fork.bytes = Buffer.byteLength(data);
      if (this.document.name) await fork.rename(this.document.name);
      for (const entry of branch)
        if (this.document.labels?.[entry.id])
          await fork.label(entry.id, this.document.labels[entry.id]);
      const metadata = fork.metadata();
      this.stagedForks.set(metadata.file, metadata.id);
      return metadata;
    } catch (error) {
      await this.io.unlink(fork.file).catch(() => {});
      throw error;
    } finally {
      await fork.close();
    }
  }

  async discardFork(file: string, id: string): Promise<void> {
    return this.withNavigation(() => this.removeFork(file, id));
  }

  private async removeFork(file: string, id: string): Promise<void> {
    if (this.stagedForks.get(file) !== id)
      throw new RuntimeHostError(
        'session_fork_identity_mismatch',
        'fork is not an uncommitted artifact of this runtime'
      );
    const fork = await JsonlSessionStore.open(this.io, {
      file,
      cwd: this.document.header.cwd,
      mode: 'resume',
      maxBytes: this.maxBytes,
    });
    try {
      if (
        fork.document.header.id !== id ||
        fork.document.header.parentSessionId !== this.document.header.id
      )
        throw new RuntimeHostError('session_fork_identity_mismatch', 'fork file identity changed');
      await this.io.unlink(fork.file);
      this.stagedForks.delete(file);
    } finally {
      await fork.close();
    }
  }
  acceptFork(file: string): void {
    this.stagedForks.delete(file);
  }

  private mutate(row: Record<string, unknown>, apply: () => void): Promise<void> {
    const oversize = this.entrySizeError(
      Buffer.byteLength(JSON.stringify(row)) + ENTRY_OVERHEAD_BYTES
    );
    if (oversize) return Promise.reject(oversize);
    return this.enqueue(async () => {
      // A lane row states the new tip; a fact row hangs off the current one.
      const parentId =
        row.kind === 'lane' ? ((row.leafId as string | null) ?? null) : this.document.leafId;
      const line = `${JSON.stringify({
        ...row,
        seq: this.document.seq + 1,
        ...cliBookkeeping(randomUUID(), parentId, Date.now()),
      })}\n`;
      const bytes = Buffer.byteLength(line);
      if (this.bytes + bytes > this.maxBytes)
        throw new RuntimeHostError('session_size_limit', 'session exceeds size budget');
      const tooLarge = this.entrySizeError(bytes);
      if (tooLarge) throw tooLarge;
      await this.io.appendFile(this.file, Buffer.from(line), { mode: 0o600 });
      this.bytes += bytes;
      this.document.seq++;
      apply();
    });
  }

  /** capacity-04 — the per-line net, judged after the aggregate budget. */
  private entrySizeError(bytes: number): RuntimeHostError | undefined {
    return bytes > this.maxEntryBytes
      ? new RuntimeHostError(
          'session_entry_size_limit',
          `one session entry may be at most ${this.maxEntryBytes} bytes; this one is ${bytes}`
        )
      : undefined;
  }

  flush(): Promise<void> {
    return this.tail;
  }

  /**
   * Drain the queue and release the lock.
   *
   * session-06 — settled, not awaited for success. A write that failed (a full
   * disk, a size budget) leaves the queue permanently rejected, which is how
   * further writes are refused; making close() rethrow it turned every later
   * shutdown into a failure the host reported as if closing had gone wrong,
   * while the lock and the file handles had in fact been released cleanly. The
   * failure stays visible through `writeFailure` and `flush`.
   */
  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      await Promise.allSettled([this.navigationWork, this.tail]);
      // T045 follow-up. `false` means the sidecar under our path is no longer
      // the one we created — someone took this session over while we were
      // writing it. Closing still succeeded and there is nothing for the caller
      // to do differently, so this is not an error; but it is the only place in
      // the process that can say two writers overlapped on one file, and
      // dropping the value left that unobservable.
      if (!(await releaseWriterLock(this.io, this.lock)))
        this.log(
          `session writer lock was taken over by another process before close: ${this.lock.path}`
        );
    })();
    return this.closing;
  }
}
