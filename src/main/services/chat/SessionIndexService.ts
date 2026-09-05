/**
 * Session Index Service — Main-side persistence of chat session metadata.
 * Load/flush pattern mirrors RemoteConnectionManager's profile persistence
 * (see src/main/services/remote/RemoteConnectionManager.ts).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import type { PiLeafCheckpoint } from '@shared/types/sessionHistory';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { app } from 'electron';

const SESSION_INDEX_FILENAME = 'session-index.json';

function now(): number {
  return Date.now();
}

async function writeJsonAtomically(targetPath: string, data: unknown): Promise<void> {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await rename(tempPath, targetPath);
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

function getSessionIndexPath(): string {
  return join(app.getPath('userData'), SESSION_INDEX_FILENAME);
}

export interface SessionIndexServiceOptions {
  writeAtomically?: (targetPath: string, data: unknown) => Promise<void>;
}

export class SessionIndexService {
  private readonly writeAtomically: (targetPath: string, data: unknown) => Promise<void>;
  private entries = new Map<string, SessionIndexEntry>();
  private loaded = false;
  private loadingEntries: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: SessionIndexServiceOptions = {}) {
    this.writeAtomically = options.writeAtomically ?? writeJsonAtomically;
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
      this.entries.set(input.sessionId, {
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
      });
      await this.flush();
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
      await this.flush();
      return true;
    });
  }

  async setArchived(sessionId: string, archived: boolean): Promise<boolean> {
    await this.ensureLoaded();
    return this.queueMutation(async () => {
      const existing = this.entries.get(sessionId);
      if (!existing) return false;
      this.entries.set(sessionId, { ...existing, archived, updatedAt: now() });
      await this.flush();
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

      switch (event.type) {
        case 'session.created': {
          const runtimeIdentity = event.payload?.runtimeIdentity;
          const agent = event.payload?.agent;
          // A new Pi session can receive its durable runtime identity on the
          // first turn, so preserve an independently reported binding here.
          if (!runtimeIdentity && !agent) return;
          this.entries.set(event.sessionId as string, {
            ...existing,
            ...(runtimeIdentity ? { runtimeIdentity } : {}),
            ...(agent ? { agent } : {}),
            updatedAt: now(),
          });
          await this.flush();
          return;
        }
        case 'session.updated': {
          const runtimeIdentity = event.payload.runtimeIdentity;
          this.entries.set(event.sessionId as string, {
            ...existing,
            runtimeIdentity,
            updatedAt: now(),
          });
          await this.flush();
          return;
        }
        case 'session.completed':
        case 'session.failed':
        case 'session.stopped':
          this.entries.set(event.sessionId as string, { ...existing, updatedAt: now() });
          await this.flush();
          return;
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
      try {
        const content = await readFile(path, 'utf8');
        const parsed = JSON.parse(content) as SessionIndexEntry[];
        for (const entry of parsed) {
          this.entries.set(entry.sessionId, entry);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.warn('[chat] Failed to read session index, starting empty:', error);
        }
      }
      this.loaded = true;
    })().finally(() => {
      this.loadingEntries = null;
    });

    return this.loadingEntries;
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
    const path = getSessionIndexPath();
    const entries = [...this.entries.values()];
    await mkdir(app.getPath('userData'), { recursive: true });
    await this.writeAtomically(path, entries);
  }
}

/** Singleton used by IPC handlers. */
export const sessionIndexService = new SessionIndexService();
