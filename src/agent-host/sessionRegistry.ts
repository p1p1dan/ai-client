/**
 * In-memory Host session registry — AiClient sessionId ↔ Claude runtime identity.
 */

import type { SessionEffortLevel } from '../shared/types/agentHost.ts';
import type { AgentWireName } from '../shared/types/agentWire.ts';
import type { SessionRuntimeStatus } from '../shared/types/runtimeEvents.ts';

export interface HostSession {
  sessionId: string;
  workspacePath: string;
  model?: string;
  /** Session default reasoning effort; a per-send effort overrides it (#8/T-20). */
  effort?: SessionEffortLevel;
  /**
   * S2 (b): which runtime owns this session. Required — every registry entry
   * is created BY a runtime, which passes its own name, so "unknown agent" is
   * not a state the Host can be in. It is echoed on `session.created` /
   * `session.resumed` so Main persists the binding without inferring it from
   * the implementation class.
   */
  agent: AgentWireName;
  /** The runtime's own resume handle (Claude Code: the SDK session_id). */
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

  create(input: {
    sessionId: string;
    workspacePath: string;
    agent: AgentWireName;
    model?: string;
    effort?: SessionEffortLevel;
  }): HostSession {
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      throw new Error(`Session already exists: ${input.sessionId}`);
    }
    const session: HostSession = {
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      agent: input.agent,
      model: input.model,
      effort: input.effort,
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
    agent: AgentWireName;
    model?: string;
    effort?: SessionEffortLevel;
  }): HostSession {
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      // Merge semantics (CP4 F-1): never replace the live object — a swap
      // would orphan an active turn's abort/running state. Callers must
      // reject resume for running sessions before reaching here.
      // `agent` is deliberately NOT merged: a session is bound for life, and
      // only the runtime that owns the entry can reach this call anyway.
      existing.workspacePath = input.workspacePath;
      existing.runtimeIdentity = input.runtimeIdentity;
      existing.model = input.model ?? existing.model;
      existing.effort = input.effort ?? existing.effort;
      return existing;
    }
    const session: HostSession = {
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      agent: input.agent,
      model: input.model,
      effort: input.effort,
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
