/**
 * Session Index Service — Main-side persistence of chat session metadata.
 * Load/flush pattern mirrors RemoteConnectionManager's profile persistence
 * (see src/main/services/remote/RemoteConnectionManager.ts).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeEvent, SessionPermissionPreference } from '@shared/types/runtimeEvents';
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
   */
  async recordCreated(input: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    /** Loose `string` on purpose — this is the disk side (SessionIndexEntry). */
    agent?: string;
    /**
     * D48 S3 §5.5-2 — the posture this session starts under. Merged
     * FIRST-WRITE-WINS below, not last-write-wins like `model`.
     */
    permissionPreference?: SessionPermissionPreference;
  }): Promise<void> {
    await this.ensureLoaded();
    await this.queueMutation(async () => {
      const existing = this.entries.get(input.sessionId);
      this.entries.set(input.sessionId, {
        sessionId: input.sessionId,
        runtimeIdentity: existing?.runtimeIdentity,
        piLeaf: existing?.piLeaf,
        agent: input.agent ?? existing?.agent,
        workspacePath: input.workspacePath,
        title: existing?.title ?? '',
        model: input.model ?? existing?.model,
        // "The posture captured when they were FIRST sent" (§5.4 copy), so the
        // persisted value wins over the incoming one — the opposite direction
        // from `model` right above, and deliberately so. `chat:createSession`
        // runs again whenever the Host registry entry was dropped (a restart, a
        // crash, an unbind), and by then the global template may say something
        // else; re-capturing it there would let a Settings edit silently retune
        // an existing chat through the back door. S4's mid-session change is the
        // one thing allowed to overwrite this, and it does so through
        // `setPermissionPreference` below rather than through here.
        permissionPreference: existing?.permissionPreference ?? input.permissionPreference,
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
    await this.ensureLoaded();
    return this.queueMutation(async () => {
      if (this.entries.has(input.sessionId)) {
        throw new Error(`Fork session id already exists: ${input.sessionId}`);
      }
      if (
        input.runtimeIdentity &&
        [...this.entries.values()].some((entry) => entry.runtimeIdentity === input.runtimeIdentity)
      ) {
        throw new Error(`Fork runtime identity is already indexed: ${input.runtimeIdentity}`);
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
   * D48 S4 §6.3 / D10 — the ONE writer allowed to move a captured posture, and
   * the reason `recordCreated`'s first-write-wins is safe.
   *
   * Every other path into this field is a CAPTURE (a template read at first
   * send) and must never overwrite one that already exists, or a Settings edit
   * would retune an existing chat behind the user's back. This one is not a
   * capture: it records a change the user made to THIS session, on purpose, and
   * it is the value the next resume replays — which is the whole point of
   * storing the posture per session rather than reading the template again.
   *
   * Called only after the Host confirmed the change (Main awaits
   * `session.permissionUpdated`), so a refused or failed update never reaches
   * here and the row stays byte-identical.
   *
   * `false` for a session this index has never heard of, rather than creating a
   * row: a posture with no session is a row with no workspace, and the callers
   * that create rows (`recordCreated` / `recordResumed`) are the ones that know
   * what else belongs in one.
   */
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

  async setPermissionPreference(
    sessionId: string,
    permissionPreference: SessionPermissionPreference
  ): Promise<boolean> {
    await this.ensureLoaded();
    return this.queueMutation(async () => {
      const existing = this.entries.get(sessionId);
      if (!existing) return false;
      this.entries.set(sessionId, { ...existing, permissionPreference, updatedAt: now() });
      await this.flush();
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
          // A NEW Claude session reports no runtimeIdentity — the SDK issues one
          // on the first turn — so the old `if (!runtimeIdentity) return` dropped
          // its whole payload. That was invisible while the payload held nothing
          // else; now it would silently discard the binding on the one event that
          // carries it, and the row would never learn which agent owns it.
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
