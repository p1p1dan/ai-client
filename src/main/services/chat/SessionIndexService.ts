/**
 * Session Index Service — Main-side persistence of chat session metadata.
 * Load/flush pattern mirrors RemoteConnectionManager's profile persistence
 * (see src/main/services/remote/RemoteConnectionManager.ts).
 */

import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import type { PiLeafCheckpoint } from '@shared/types/sessionHistory';
import type { SessionIndexEntry, SessionIndexHealth } from '@shared/types/sessionIndex';
import { app } from 'electron';
import { redactStderrLine } from '../../../agent-host/stderrRedaction';

const SESSION_INDEX_FILENAME = 'session-index.json';

/**
 * Upper bound on persisted rows (session-index-11).
 *
 * Nothing removes rows in normal use — archiving only flips a flag and closing
 * a chat does not touch the index at all — so the file grew with every chat
 * ever created on the machine, and every write re-serialized all of it on the
 * main thread. The bound is deliberately generous: it is a backstop against
 * unbounded growth, not a retention policy.
 */
const MAX_SESSION_INDEX_ENTRIES = 2000;

/**
 * Minimum gap between writes that carry nothing but a new `updatedAt`.
 *
 * Turn end (`session.completed|failed|stopped`) fires at least once per turn
 * and only bumps recency, which made it the dominant source of full-table
 * rewrites. Coalescing them costs at most one turn's worth of staleness in the
 * sidebar's ordering: the row itself, its identity and its flags are all
 * already on disk, and the next real mutation persists the pending bump for
 * free because a flush always writes the whole table.
 */
const TIMESTAMP_FLUSH_INTERVAL_MS = 10_000;

function now(): number {
  return Date.now();
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Best effort directory fsync: a renamed file is only durable once the
 * DIRECTORY entry is synced too, otherwise a power cut can leave the target
 * missing even though its contents reached the platter. Windows cannot open a
 * directory handle at all, and some filesystems reject the sync, so failure
 * here is not an error — it just means this platform does not offer the
 * guarantee.
 */
async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directoryPath, 'r');
    await handle.sync();
  } catch {
    // Not available on this platform/filesystem.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeJsonAtomically(targetPath: string, data: unknown): Promise<void> {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    // fsync BEFORE the rename. `writeFile` + `rename` alone makes the swap
    // atomic against a concurrent reader but not against a power cut: the
    // rename can land while the bytes are still in the page cache, which is
    // exactly how the truncated/empty index the loader now has to recover from
    // gets made. No indentation — this file is machine-read only, and it is
    // rewritten in full on every mutation.
    const handle = await open(tempPath, 'w');
    try {
      await handle.writeFile(JSON.stringify(data), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, targetPath);
    await syncDirectory(dirname(targetPath));
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

function getSessionIndexPath(): string {
  return join(app.getPath('userData'), SESSION_INDEX_FILENAME);
}

interface SessionIndexParseOutcome {
  entries: SessionIndexEntry[];
  droppedRows: number;
  /** Why the file could not be used as-is; `undefined` means a clean load. */
  reason?: string;
}

/** A row is usable if it can be keyed. Everything else is deliberately NOT validated: rows written by a newer build must survive being read by an older one. */
function isUsableRow(row: unknown): row is SessionIndexEntry {
  if (!row || typeof row !== 'object') return false;
  const sessionId = (row as Partial<SessionIndexEntry>).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0;
}

/**
 * `session-index.json` is a BARE JSON ARRAY (see SessionIndexEntry's header).
 * Anything else used to take the entire file down with it: an envelope or a
 * truncated file threw out of `JSON.parse`, and a single `null` row threw on
 * `entry.sessionId`, so one bad byte cost every session on the machine.
 * Throws only for unparseable content; a parsed-but-wrong shape is reported.
 */
function parseSessionIndexRows(content: string): SessionIndexParseOutcome {
  const parsed = JSON.parse(content) as SessionIndexEntry[];
  if (!Array.isArray(parsed)) {
    return { entries: [], droppedRows: 0, reason: 'the top level is not a JSON array' };
  }
  const entries: SessionIndexEntry[] = [];
  let droppedRows = 0;
  for (const entry of parsed) {
    if (isUsableRow(entry)) {
      entries.push(entry);
    } else {
      droppedRows += 1;
    }
  }
  return {
    entries,
    droppedRows,
    reason: droppedRows > 0 ? `${droppedRows} row(s) had no usable sessionId` : undefined,
  };
}

export interface SessionIndexServiceOptions {
  writeAtomically?: (targetPath: string, data: unknown) => Promise<void>;
  /** Row cap override; production uses MAX_SESSION_INDEX_ENTRIES. */
  maxEntries?: number;
}

export class SessionIndexService {
  private readonly writeAtomically: (targetPath: string, data: unknown) => Promise<void>;
  private readonly maxEntries: number;
  private entries = new Map<string, SessionIndexEntry>();
  private loaded = false;
  private loadingEntries: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private health: SessionIndexHealth = { status: 'ok' };
  /** Epoch ms of the last successful write; gates timestamp-only flushes. */
  private lastFlushAt = 0;

  constructor(options: SessionIndexServiceOptions = {}) {
    this.writeAtomically = options.writeAtomically ?? writeJsonAtomically;
    this.maxEntries = options.maxEntries ?? MAX_SESSION_INDEX_ENTRIES;
  }

  /**
   * What the loader made of `session-index.json` (session-index-01).
   *
   * Main has no generic "tell the user something went wrong" channel today, so
   * the degraded states currently reach a human through the log lines in
   * `ensureLoaded` only. This accessor is the seam an IPC can read once that
   * channel exists — the renderer has to be able to say "your chat list was
   * rebuilt, the old file is at …" rather than silently showing an empty
   * sidebar.
   */
  getHealth(): SessionIndexHealth {
    return this.health;
  }

  async list(): Promise<SessionIndexEntry[]> {
    await this.ensureLoaded();
    await this.mutationQueue;
    return [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * One row, or `undefined` when this process has never heard of the session.
   *
   * Added for D48 §4.3's dispatch guard: `chat:send` carries no `agent` (the
   * binding is a property of the session, not of the message), so the only
   * Main-side answer to "which runtime is this model going to" is the index row.
   * Deliberately NOT `list().find(…)`, which sorts the whole map to answer a
   * point lookup on every keystroke-driven send.
   */
  async get(sessionId: string): Promise<SessionIndexEntry | undefined> {
    await this.ensureLoaded();
    await this.mutationQueue;
    return this.entries.get(sessionId);
  }

  /**
   * Both record* methods rebuild the entry FIELD BY FIELD rather than
   * spreading `existing`, so any persisted key not named here is dropped on
   * the next call. `agent` therefore has to carry `?? existing?.agent`: a
   * first send re-records with the binding, but a later one that happens not
   * to know it (an older caller, a path that never resolved it) would
   * otherwise erase the row's agent every time.
   *
   * U13 gives `unbound` the same treatment for the same reason, with one
   * difference: an explicit `false` CLEARS it (`??` only falls back on
   * undefined). A caller that knows the answer — both IPC entry points derive
   * it from the path they are about to record — must be able to say "this row
   * is not scratch any more" when a chat is re-recorded against a real folder.
   */
  async recordCreated(input: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    /** Loose `string` on purpose — this is the disk side (SessionIndexEntry). */
    agent?: string;
    /** U13 — `workspacePath` is a scratch directory. Omit when unknown. */
    unbound?: boolean;
  }): Promise<void> {
    await this.ensureLoaded();
    await this.queueMutation(async () => {
      const existing = this.entries.get(input.sessionId);
      const unbound = input.unbound ?? existing?.unbound;
      await this.mutateAndFlush(
        input.sessionId,
        {
          sessionId: input.sessionId,
          runtimeIdentity: existing?.runtimeIdentity,
          piLeaf: existing?.piLeaf,
          legacyImport: existing?.legacyImport,
          agent: input.agent ?? existing?.agent,
          // Written only when true so a bound row never grows the field: the
          // file is read by older builds too, and `undefined` is not serialized.
          ...(unbound ? { unbound: true } : {}),
          workspacePath: input.workspacePath,
          title: existing?.title ?? '',
          model: input.model ?? existing?.model,
          updatedAt: now(),
          archived: existing?.archived ?? false,
        },
        existing
      );
    });
  }

  /**
   * D15 — take back a `recordCreated` row whose worker never came up.
   *
   * The row has to be written before the spawn (WorkerManager's identity commit
   * and the runtime-event branches both refuse a session with no row), so a
   * bootstrap that fails — a protocol mismatch, in the 2026-09-17 field run —
   * used to leave a `title: ''` shell behind that came back as "Session xxxxxx"
   * in the sidebar after a restart.
   *
   * Deliberately narrow, in the shape of `removeImported` above: it deletes
   * ONLY a row that is still exactly the shell this create wrote. Anything that
   * makes the row worth keeping — a durable Pi file, a leaf checkpoint, a
   * title, an archive bit, an import record, or a workspace that has since
   * moved — vetoes the delete and returns false. A caller that did not create
   * the row must not call this at all; the guards are the second line, not the
   * first.
   */
  async removeUncommittedCreated(sessionId: string, workspacePath: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.queueMutation(async () => {
      const existing = this.entries.get(sessionId);
      if (
        !existing ||
        existing.workspacePath !== workspacePath ||
        existing.runtimeIdentity ||
        existing.piLeaf ||
        existing.legacyImport ||
        existing.archived ||
        (existing.title ?? '') !== ''
      ) {
        return false;
      }
      this.entries.delete(sessionId);
      try {
        await this.flush();
      } catch (error) {
        this.entries.set(sessionId, existing);
        throw error;
      }
      return true;
    });
  }

  /**
   * Awaited resume commit. The exact Pi file has already been opened and
   * validated by its WorkerSlot; this method refuses to manufacture or retarget
   * an index row and rolls back memory if the atomic flush fails.
   */
  async commitResumed(input: {
    sessionId: string;
    workspacePath: string;
    runtimeIdentity: string;
    model?: string;
    piLeaf?: PiLeafCheckpoint;
  }): Promise<void> {
    await this.ensureLoaded();
    await this.queueMutation(async () => {
      const existing = this.entries.get(input.sessionId);
      if (!existing) {
        throw new Error(`Session index row not found for resume: ${input.sessionId}`);
      }
      if (!existing.runtimeIdentity || existing.runtimeIdentity !== input.runtimeIdentity) {
        throw new Error(
          `Session index identity mismatch for ${input.sessionId}: expected ${existing.runtimeIdentity ?? 'none'}, got ${input.runtimeIdentity}`
        );
      }
      const next: SessionIndexEntry = {
        ...existing,
        workspacePath: input.workspacePath,
        runtimeIdentity: input.runtimeIdentity,
        agent: 'pi',
        model: input.model ?? existing.model,
        piLeaf: input.piLeaf ?? existing.piLeaf,
        updatedAt: now(),
      };
      this.entries.set(input.sessionId, next);
      try {
        await this.flush();
      } catch (error) {
        this.entries.set(input.sessionId, existing);
        throw error;
      }
    });
  }

  /** Atomically move the active Pi branch checkpoint for an exact indexed session. */
  async commitPiLeaf(input: {
    sessionId: string;
    runtimeIdentity: string;
    piLeaf: PiLeafCheckpoint;
  }): Promise<void> {
    await this.ensureLoaded();
    await this.queueMutation(async () => {
      const existing = this.entries.get(input.sessionId);
      if (
        !existing ||
        existing.runtimeIdentity !== input.runtimeIdentity ||
        existing.agent !== 'pi'
      ) {
        throw new Error(`Session index Pi identity mismatch for leaf commit: ${input.sessionId}`);
      }
      this.entries.set(input.sessionId, {
        ...existing,
        piLeaf: input.piLeaf,
        updatedAt: now(),
      });
      try {
        await this.flush();
      } catch (error) {
        this.entries.set(input.sessionId, existing);
        throw error;
      }
    });
  }

  /** Insert one complete independent fork row with a single atomic flush. */
  async createForked(input: SessionIndexEntry): Promise<SessionIndexEntry> {
    return this.createIndependent(input, 'Fork');
  }

  /** Insert one complete imported Pi session row with a single atomic flush. */
  async createImported(input: SessionIndexEntry): Promise<SessionIndexEntry> {
    return this.createIndependent(input, 'Imported');
  }

  /** Remove only the exact uncommitted/failed import row; never retarget another session. */
  async removeImported(
    sessionId: string,
    runtimeIdentity: string,
    targetPiSessionId: string
  ): Promise<boolean> {
    await this.ensureLoaded();
    return this.queueMutation(async () => {
      const existing = this.entries.get(sessionId);
      if (
        !existing ||
        existing.runtimeIdentity !== runtimeIdentity ||
        existing.agent !== 'pi' ||
        existing.legacyImport?.targetPiSessionId !== targetPiSessionId
      ) {
        return false;
      }
      this.entries.delete(sessionId);
      try {
        await this.flush();
      } catch (error) {
        this.entries.set(sessionId, existing);
        throw error;
      }
      return true;
    });
  }

  private async createIndependent(
    input: SessionIndexEntry,
    label: 'Fork' | 'Imported'
  ): Promise<SessionIndexEntry> {
    await this.ensureLoaded();
    return this.queueMutation(async () => {
      if (this.entries.has(input.sessionId)) {
        throw new Error(`${label} session id already exists: ${input.sessionId}`);
      }
      if (
        input.runtimeIdentity &&
        [...this.entries.values()].some((entry) => entry.runtimeIdentity === input.runtimeIdentity)
      ) {
        throw new Error(`${label} runtime identity is already indexed: ${input.runtimeIdentity}`);
      }
      const next: SessionIndexEntry = { ...input };
      this.entries.set(input.sessionId, next);
      try {
        await this.flush();
      } catch (error) {
        this.entries.delete(input.sessionId);
        throw error;
      }
      return { ...next };
    });
  }

  /**
   * Awaited durable-identity commit used by WorkerManager's remap transaction.
   * A failed atomic flush restores the in-memory row so Main never advertises a
   * runtime identity that the session index did not persist.
   */
  async bindRuntimeIdentity(sessionId: string, runtimeIdentity: string): Promise<void> {
    await this.ensureLoaded();
    await this.queueMutation(async () => {
      const existing = this.entries.get(sessionId);
      if (!existing) {
        throw new Error(`Session index row not found for runtime binding: ${sessionId}`);
      }
      this.entries.set(sessionId, { ...existing, runtimeIdentity, updatedAt: now() });
      try {
        await this.flush();
      } catch (error) {
        this.entries.set(sessionId, existing);
        throw error;
      }
    });
  }

  /**
   * Forget a runtime identity that never named a real file.
   *
   * Builds before this method existed indexed the JSONL path Pi *reserved* at
   * session creation, but Pi writes nothing until the first assistant message —
   * so a session that never got one left behind a row pointing at a file that
   * never existed, and every later resume failed on it forever. Clearing the
   * identity returns the row to "created but never run", which is what it
   * always was; the next send mints a real Pi session for it.
   *
   * Refuses if the row now names a different identity, so a repair racing a
   * live binding cannot unbind the winner.
   */
  async clearUnwrittenRuntimeIdentity(
    sessionId: string,
    runtimeIdentity: string
  ): Promise<boolean> {
    await this.ensureLoaded();
    return this.queueMutation(async () => {
      const existing = this.entries.get(sessionId);
      if (!existing || existing.runtimeIdentity !== runtimeIdentity) return false;
      const { runtimeIdentity: _dropped, ...rest } = existing;
      this.entries.set(sessionId, { ...rest, updatedAt: now() });
      try {
        await this.flush();
      } catch (error) {
        this.entries.set(sessionId, existing);
        throw error;
      }
      return true;
    });
  }

  async rename(sessionId: string, title: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.queueMutation(async () => {
      const existing = this.entries.get(sessionId);
      if (!existing) return false;
      this.entries.set(sessionId, { ...existing, title, updatedAt: now() });
      try {
        await this.flush();
      } catch (error) {
        this.entries.set(sessionId, existing);
        throw error;
      }
      return true;
    });
  }

  async setArchived(sessionId: string, archived: boolean): Promise<boolean> {
    await this.ensureLoaded();
    return this.queueMutation(async () => {
      const existing = this.entries.get(sessionId);
      if (!existing) return false;
      await this.mutateAndFlush(sessionId, { ...existing, archived, updatedAt: now() }, existing);
      return true;
    });
  }

  /** Fire-and-forget: the Host event bridge broadcasts every RuntimeEvent, so failures here must never throw. */
  handleRuntimeEvent(event: RuntimeEvent): void {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
      case 'session.completed':
      case 'session.failed':
      case 'session.stopped':
        void this.applyRuntimeEvent(event).catch((error) => {
          console.warn('[chat] Failed to apply runtime event to session index:', error);
        });
        return;
      default:
        return;
    }
  }

  private async applyRuntimeEvent(event: RuntimeEvent): Promise<void> {
    if (!event.sessionId) {
      return;
    }

    await this.ensureLoaded();
    await this.queueMutation(async () => {
      const existing = this.entries.get(event.sessionId as string);
      if (!existing) {
        // Normal ordering has recordCreated/recordResumed land first via the IPC entry point.
        return;
      }

      const sessionId = event.sessionId as string;
      switch (event.type) {
        case 'session.created': {
          const runtimeIdentity = event.payload?.runtimeIdentity;
          const agent = event.payload?.agent;
          // A new Pi session can receive its durable runtime identity on the
          // first turn, so preserve an independently reported binding here.
          if (!runtimeIdentity && !agent) return;
          await this.mutateAndFlush(
            sessionId,
            {
              ...existing,
              ...(runtimeIdentity ? { runtimeIdentity } : {}),
              ...(agent ? { agent } : {}),
              updatedAt: now(),
            },
            existing
          );
          return;
        }
        case 'session.updated': {
          const runtimeIdentity = event.payload.runtimeIdentity;
          await this.mutateAndFlush(
            sessionId,
            { ...existing, runtimeIdentity, updatedAt: now() },
            existing
          );
          return;
        }
        case 'session.completed':
        case 'session.failed':
        case 'session.stopped': {
          // Turn end carries no new data, only recency (session-index-11).
          // Keep the bump in memory and let the next real mutation — or the
          // next turn end past the coalescing window — carry it to disk,
          // instead of re-serializing the whole table once per turn forever.
          const next = { ...existing, updatedAt: now() };
          if (now() - this.lastFlushAt < TIMESTAMP_FLUSH_INTERVAL_MS) {
            this.entries.set(sessionId, next);
            return;
          }
          await this.mutateAndFlush(sessionId, next, existing);
          return;
        }
        default:
          return;
      }
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (this.loadingEntries) {
      return this.loadingEntries;
    }

    this.loadingEntries = (async () => {
      const path = getSessionIndexPath();
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          // First run. Here — and only here — an empty table IS the truth, so
          // the first write may create the file.
          this.health = { status: 'ok' };
          this.loaded = true;
          return;
        }
        // Read failure, not absence: EACCES/EIO/EBUSY, or on Windows an
        // antivirus or backup tool holding the file open. The rows are
        // presumed intact on disk, and `flush()` writes the WHOLE table, so
        // taking this process's empty view live would destroy them. Refuse to
        // write, and leave `loaded` false so a later call retries once the
        // file frees up.
        this.health = { status: 'unreadable', reason: describeError(error) };
        console.error(
          '[chat] Session index could not be read; refusing to write over it until it can be:',
          error
        );
        return;
      }

      let outcome: SessionIndexParseOutcome;
      try {
        outcome = parseSessionIndexRows(content);
      } catch (error) {
        outcome = { entries: [], droppedRows: 0, reason: describeError(error) };
      }
      for (const entry of outcome.entries) {
        this.entries.set(entry.sessionId, entry);
      }
      this.health = outcome.reason
        ? await this.preserveCorruptIndex(path, outcome.reason, outcome.droppedRows)
        : { status: 'ok' };
      this.loaded = true;
    })().finally(() => {
      this.loadingEntries = null;
    });

    return this.loadingEntries;
  }

  /**
   * Keep the unusable file before the next flush replaces it (session-index-01).
   *
   * `session-index.json` is the ONLY map from a chat to its JSONL file — there
   * is no scanner that can rebuild it — so losing it silently is unrecoverable
   * and even post-mortem diagnosis is impossible once it has been overwritten.
   *
   * Two shapes, because they want opposite things. When nothing parsed the
   * file is worthless to the app, so it is MOVED aside: a crash before the
   * first flush then looks like a first run rather than piling up another
   * backup on every restart. When some rows survived, the file still holds
   * live data, so it is COPIED and left in place for the next atomic flush to
   * replace. If the backup itself fails there is no evidence to lose twice
   * over, so the process falls back to refusing writes.
   */
  private async preserveCorruptIndex(
    path: string,
    reason: string,
    droppedRows: number
  ): Promise<SessionIndexHealth> {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const backupPath = `${path}.corrupt-${stamp}`;
    try {
      if (this.entries.size === 0) {
        await rename(path, backupPath);
      } else {
        await copyFile(path, backupPath);
      }
    } catch (error) {
      const blocked = `${reason}; the file could not be backed up (${describeError(error)})`;
      console.error('[chat] Session index is damaged and cannot be preserved:', blocked);
      return { status: 'unreadable', reason: blocked };
    }
    // T066 (D4): this line is the only durable trace of a repair, and the
    // field pass could not find it anywhere — not because `console.warn` is
    // the wrong call (it IS electron-log once `initLogger` hijacks console)
    // but because both transports sat at `error` while the logging switch was
    // off. The floor moved (main/utils/logger.ts); the path is redacted here
    // because a log line naming a file under the user's home is exactly what
    // T042's rules exist for.
    console.warn(
      `[chat] Session index was damaged (${reason}); the original is kept at ${redactStderrLine(backupPath)} and the list was rebuilt from ${this.entries.size} readable row(s).`
    );
    return { status: 'repaired', backupPath, droppedRows, reason };
  }

  /**
   * Set one row and persist, restoring the previous state when the write
   * fails (session-index-05).
   *
   * Rollback is not a nicety here: `flush()` writes the WHOLE table, so a
   * mutation left in memory after a failed write does not merely "not happen".
   * It rides along on the next unrelated successful write — minutes later, in
   * another session — long after the user was told it failed.
   */
  private async mutateAndFlush(
    sessionId: string,
    next: SessionIndexEntry,
    previous: SessionIndexEntry | undefined
  ): Promise<void> {
    this.entries.set(sessionId, next);
    try {
      await this.flush();
    } catch (error) {
      if (previous) {
        this.entries.set(sessionId, previous);
      } else {
        this.entries.delete(sessionId);
      }
      throw error;
    }
  }

  private queueMutation<TResult>(work: () => Promise<TResult>): Promise<TResult> {
    const run = this.mutationQueue.then(work);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async flush(): Promise<void> {
    if (this.health.status === 'unreadable') {
      // session-index-01: the rows this process could not read are still the
      // user's chat list. Failing loudly beats replacing them with this
      // process's empty view.
      throw new Error(
        `Refusing to write the session index because it could not be read (${this.health.reason})`
      );
    }
    const path = getSessionIndexPath();
    this.trimToCapacity();
    const entries = [...this.entries.values()];
    await mkdir(app.getPath('userData'), { recursive: true });
    await this.writeAtomically(path, entries);
    this.lastFlushAt = now();
  }

  /**
   * Enforce the row bound before writing (session-index-11).
   *
   * Trimming happens against the in-memory map, not a copy, so memory and disk
   * cannot disagree — a trimmed-on-write-only table would put the rows back on
   * the next flush. Least recently touched first, ARCHIVED rows before live
   * ones: archiving is how this product retires a chat, so those are the rows
   * the user has already said they are done with. The chat's JSONL file is
   * untouched either way; only the row that makes it visible in the sidebar
   * goes.
   */
  private trimToCapacity(): void {
    if (this.entries.size <= this.maxEntries) return;
    const oldestFirst = [...this.entries.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    const dropOrder = [
      ...oldestFirst.filter((entry) => entry.archived),
      ...oldestFirst.filter((entry) => !entry.archived),
    ];
    const excess = this.entries.size - this.maxEntries;
    for (const entry of dropOrder.slice(0, excess)) {
      this.entries.delete(entry.sessionId);
    }
    console.warn(
      `[chat] Session index exceeded ${this.maxEntries} rows; dropped the ${excess} least recently updated row(s), archived ones first.`
    );
  }
}

/** Singleton used by IPC handlers. */
export const sessionIndexService = new SessionIndexService();
