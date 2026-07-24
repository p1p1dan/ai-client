/**
 * Session Index Service — Main-side persistence of chat session metadata.
 * Load/flush pattern mirrors RemoteConnectionManager's profile persistence
 * (see src/main/services/remote/RemoteConnectionManager.ts).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
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

  async recordCreated(input: {
    sessionId: string;
    workspacePath: string;
    model?: string;
  }): Promise<void> {
    await this.ensureLoaded();
    const existing = this.entries.get(input.sessionId);
    this.entries.set(input.sessionId, {
      sessionId: input.sessionId,
      runtimeIdentity: existing?.runtimeIdentity,
      workspacePath: input.workspacePath,
      title: existing?.title ?? '',
      model: input.model ?? existing?.model,
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
  }): Promise<void> {
    await this.ensureLoaded();
    const existing = this.entries.get(input.sessionId);
    this.entries.set(input.sessionId, {
      sessionId: input.sessionId,
      runtimeIdentity: input.runtimeIdentity,
      workspacePath: input.workspacePath,
      title: existing?.title ?? '',
      model: input.model ?? existing?.model,
      updatedAt: now(),
      archived: existing?.archived ?? false,
    });
    await this.flush();
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
        if (!runtimeIdentity) {
          return;
        }
        this.entries.set(event.sessionId, { ...existing, runtimeIdentity, updatedAt: now() });
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
