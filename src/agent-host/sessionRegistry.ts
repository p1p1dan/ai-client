/**
 * In-memory Host session registry — AiClient sessionId ↔ Claude runtime identity.
 */

import type { SessionRuntimeStatus } from '../shared/types/runtimeEvents.ts';

export interface HostSession {
  sessionId: string;
  workspacePath: string;
  model?: string;
  /** Claude Code session / resume id (from SDK session_id). */
  runtimeIdentity?: string;
  status: SessionRuntimeStatus;
  abort?: AbortController;
  /** True while a query() iterator is active. */
  running: boolean;
}

export class SessionRegistry {
  private sessions = new Map<string, HostSession>();

  get(sessionId: string): HostSession | undefined {
    return this.sessions.get(sessionId);
  }

  create(input: { sessionId: string; workspacePath: string; model?: string }): HostSession {
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      throw new Error(`Session already exists: ${input.sessionId}`);
    }
    const session: HostSession = {
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      model: input.model,
      status: 'idle',
      running: false,
    };
    this.sessions.set(input.sessionId, session);
    return session;
  }

  resume(input: {
    sessionId: string;
    workspacePath: string;
    runtimeIdentity: string;
    model?: string;
  }): HostSession {
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      // Merge semantics (CP4 F-1): never replace the live object — a swap
      // would orphan an active turn's abort/running state. Callers must
      // reject resume for running sessions before reaching here.
      existing.workspacePath = input.workspacePath;
      existing.runtimeIdentity = input.runtimeIdentity;
      existing.model = input.model ?? existing.model;
      return existing;
    }
    const session: HostSession = {
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      model: input.model,
      runtimeIdentity: input.runtimeIdentity,
      status: 'idle',
      running: false,
    };
    this.sessions.set(input.sessionId, session);
    return session;
  }

  setStatus(sessionId: string, status: SessionRuntimeStatus): void {
    const session = this.sessions.get(sessionId);
    if (session) session.status = status;
  }

  delete(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.abort && !session.abort.signal.aborted) {
      session.abort.abort();
    }
    this.sessions.delete(sessionId);
  }

  /** Abort every running session (Host shutdown). */
  abortAll(): void {
    for (const session of this.sessions.values()) {
      if (session.abort && !session.abort.signal.aborted) {
        session.abort.abort();
      }
      session.running = false;
      session.status = 'disconnected';
    }
  }
}
