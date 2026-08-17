/**
 * Session Index Service — Main-side persistence of chat session metadata.
 * Load/flush pattern mirrors RemoteConnectionManager's profile persistence
 * (see src/main/services/remote/RemoteConnectionManager.ts).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeEvent, SessionPermissionPreference } from '@shared/types/runtimeEvents';
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

export class SessionIndexService {
  private entries = new Map<string, SessionIndexEntry>();
  private loaded = false;
  private loadingEntries: Promise<void> | null = null;
  private flushQueue: Promise<void> = Promise.resolve();

  async list(): Promise<SessionIndexEntry[]> {
    await this.ensureLoaded();
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
    const existing = this.entries.get(input.sessionId);
    this.entries.set(input.sessionId, {
      sessionId: input.sessionId,
      runtimeIdentity: existing?.runtimeIdentity,
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
  }

  async recordResumed(input: {
    sessionId: string;
    workspacePath: string;
    runtimeIdentity: string;
    model?: string;
    /** Loose `string` on purpose — this is the disk side (SessionIndexEntry). */
    agent?: string;
  }): Promise<void> {
    await this.ensureLoaded();
    const existing = this.entries.get(input.sessionId);
    this.entries.set(input.sessionId, {
      sessionId: input.sessionId,
      runtimeIdentity: input.runtimeIdentity,
      agent: input.agent ?? existing?.agent,
      workspacePath: input.workspacePath,
      title: existing?.title ?? '',
      model: input.model ?? existing?.model,
      // Resume never re-captures: it replays what the row already holds. The
      // field is listed only because this method rebuilds the entry field by
      // field (see the class note above) and omitting it would DELETE the
      // snapshot on the first resume — the exact shape of the `agent` bug the
      // `?? existing` chain next to it exists to prevent.
      permissionPreference: existing?.permissionPreference,
      updatedAt: now(),
      archived: existing?.archived ?? false,
    });
    await this.flush();
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
  async setPermissionPreference(
    sessionId: string,
    permissionPreference: SessionPermissionPreference
  ): Promise<boolean> {
    await this.ensureLoaded();
    const existing = this.entries.get(sessionId);
    if (!existing) {
      return false;
    }
    this.entries.set(sessionId, { ...existing, permissionPreference, updatedAt: now() });
    await this.flush();
    return true;
  }

  async rename(sessionId: string, title: string): Promise<boolean> {
    await this.ensureLoaded();
    const existing = this.entries.get(sessionId);
    if (!existing) {
      return false;
    }
    this.entries.set(sessionId, { ...existing, title, updatedAt: now() });
    await this.flush();
    return true;
  }

  async setArchived(sessionId: string, archived: boolean): Promise<boolean> {
    await this.ensureLoaded();
    const existing = this.entries.get(sessionId);
    if (!existing) {
      return false;
    }
    this.entries.set(sessionId, { ...existing, archived, updatedAt: now() });
    await this.flush();
    return true;
  }

  /** Fire-and-forget: the Host event bridge broadcasts every RuntimeEvent, so failures here must never throw. */
  handleRuntimeEvent(event: RuntimeEvent): void {
    switch (event.type) {
      case 'session.created':
      case 'session.resumed':
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
    const existing = this.entries.get(event.sessionId);
    if (!existing) {
      // Normal ordering has recordCreated/recordResumed land first via the IPC entry point.
      return;
    }

    switch (event.type) {
      case 'session.created':
      case 'session.resumed': {
        const runtimeIdentity = event.payload?.runtimeIdentity;
        const agent = event.payload?.agent;
        // A NEW Claude session reports no runtimeIdentity — the SDK issues one
        // on the first turn — so the old `if (!runtimeIdentity) return` dropped
        // its whole payload. That was invisible while the payload held nothing
        // else; now it would silently discard the binding on the one event that
        // carries it, and the row would never learn which agent owns it.
        if (!runtimeIdentity && !agent) {
          return;
        }
        this.entries.set(event.sessionId, {
          ...existing,
          // Merged one optional field at a time: whichever the event omits
          // keeps its persisted value instead of being overwritten with
          // undefined.
          ...(runtimeIdentity ? { runtimeIdentity } : {}),
          ...(agent ? { agent } : {}),
          updatedAt: now(),
        });
        await this.flush();
        return;
      }
      case 'session.updated': {
        const runtimeIdentity = event.payload.runtimeIdentity;
        this.entries.set(event.sessionId, { ...existing, runtimeIdentity, updatedAt: now() });
        await this.flush();
        return;
      }
      case 'session.completed':
      case 'session.failed':
      case 'session.stopped':
        this.entries.set(event.sessionId, { ...existing, updatedAt: now() });
        await this.flush();
        return;
      default:
        return;
    }
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

  private async flush(): Promise<void> {
    const path = getSessionIndexPath();
    const entries = [...this.entries.values()];
    const flushTask = this.flushQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(app.getPath('userData'), { recursive: true });
        await writeJsonAtomically(path, entries);
      });
    this.flushQueue = flushTask;
    await flushTask;
  }
}

/** Singleton used by IPC handlers. */
export const sessionIndexService = new SessionIndexService();
