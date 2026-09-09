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
  decodeSession,
  isSuccessfulMessage,
  type SessionDocument,
} from './codec.ts';
import { sessionPermissions } from './legacy.ts';

export interface SessionConfig {
  file: string;
  cwd: string;
  mode: 'create' | 'resume' | 'import';
  sourceFile?: string;
  allowWorkspaceRelocation?: boolean;
  /** Bound the in-memory transcript on this host; oversized files fail explicitly. */
  maxBytes?: number;
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
export interface SessionSnapshot {
  id: string;
  entries: Entry[];
  messages: AgentMessage[];
  checkpoint?: CompactionEntry;
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  permissions?: RuntimePermissionSettings;
}

export class JsonlSessionStore {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private running = false;
  private navigating = false;
  private navigationWork?: Promise<unknown>;
  private readonly stagedForks = new Map<string, string>();
  private closing: Promise<void> | undefined;
  readonly file: string;
  private readonly io: RuntimeHostIoService;
  private readonly document: SessionDocument;
  private readonly lock: string;
  private readonly maxBytes: number;
  private bytes: number;
  private constructor(
    file: string,
    io: RuntimeHostIoService,
    document: SessionDocument,
    lock: string,
    maxBytes: number,
    bytes: number
  ) {
    this.file = file;
    this.io = io;
    this.document = document;
    this.lock = lock;
    this.maxBytes = maxBytes;
    this.bytes = bytes;
  }

  static async open(io: RuntimeHostIoService, config: SessionConfig): Promise<JsonlSessionStore> {
    const maxBytes = config.maxBytes ?? 32 * 1024 * 1024;
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
    const lock = `${file}.writer.lock`;
    try {
      await io.writeFile(
        lock,
        Buffer.from(JSON.stringify({ pid: process.pid, token: randomUUID() })),
        { createOnly: true, mode: 0o600 }
      );
    } catch (error) {
      if (errorCode(error) === 'EEXIST')
        throw new RuntimeHostError('session_locked', `session already has a writer: ${file}`);
      throw error;
    }
    try {
      let document: SessionDocument;
      let bytes: number;
      if (config.mode === 'create') {
        document = {
          header: {
            kind: 'header',
            version: 4,
            id: randomUUID(),
            createdAt: Date.now(),
            cwd: await io.realpath(config.cwd),
          },
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
      return new JsonlSessionStore(file, io, document, lock, maxBytes, bytes);
    } catch (error) {
      await io.unlink(lock);
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
    return this.appendEntry({
      type: 'compaction',
      ...structuredClone(result),
    }) as Promise<CompactionEntry>;
  }

  appendEntry(payload: NewSessionEntry): Promise<Entry> {
    const entry = structuredClone(payload);
    return this.enqueue(async () => {
      const item: Entry = {
        ...entry,
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
    void this.tail.catch(() => {});
    return work;
  }

  get busy(): boolean {
    return this.running || this.navigating;
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
    return this.enqueue(async () => {
      const line = `${JSON.stringify({ ...row, seq: this.document.seq + 1 })}\n`;
      const bytes = Buffer.byteLength(line);
      if (this.bytes + bytes > this.maxBytes)
        throw new RuntimeHostError('session_size_limit', 'session exceeds size budget');
      await this.io.appendFile(this.file, Buffer.from(line), { mode: 0o600 });
      this.bytes += bytes;
      this.document.seq++;
      apply();
    });
  }

  flush(): Promise<void> {
    return this.tail;
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      await Promise.allSettled([this.navigationWork]);
      await this.tail.finally(() => this.io.unlink(this.lock));
    })();
    return this.closing;
  }
}
