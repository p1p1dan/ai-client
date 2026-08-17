/**
 * In-memory Host session registry — AiClient sessionId ↔ Claude runtime identity.
 */

import type { SessionEffortLevel } from '../shared/types/agentHost.ts';
import type { AgentWireName } from '../shared/types/agentWire.ts';
import type {
  SessionPermissionPreference,
  SessionRuntimeStatus,
} from '../shared/types/runtimeEvents.ts';

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
  /**
   * D48 S3 §5.5 — the posture this session was ASKED to run under, as it came
   * off `session.create` / `session.resume`. Absent = the runtime's own safe
   * constant, i.e. every session that existed before this field did.
   *
   * It lives here, next to `model` and `effort`, because the same three
   * questions are asked of it: it must survive a runtime's internal state being
   * torn down and rebuilt (the Codex idle-revive drops its session state and
   * reopens a connection, and the reopened one has to come back under the SAME
   * posture, not under the constant), it must be readable by the send path, and
   * it must be one value rather than a copy per call site. `agent` is NOT
   * merged on resume for the same reason it is not here: a session's binding is
   * fixed for life, and a preference for the other agent is refused upstream.
   */
  permissionPreference?: SessionPermissionPreference;
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
    permissionPreference?: SessionPermissionPreference;
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
      permissionPreference: input.permissionPreference,
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
    permissionPreference?: SessionPermissionPreference;
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
      // Same merge rule as model/effort: an omitted preference keeps the one
      // this session already runs under instead of silently resetting it to the
      // runtime constant (§5.5: create/resume merge like model and effort).
      existing.permissionPreference = input.permissionPreference ?? existing.permissionPreference;
      return existing;
    }
    const session: HostSession = {
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      agent: input.agent,
      model: input.model,
      effort: input.effort,
      permissionPreference: input.permissionPreference,
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
