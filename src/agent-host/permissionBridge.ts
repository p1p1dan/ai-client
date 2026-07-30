/**
 * Permission bridge — park SDK canUseTool until Renderer responds via protocol.
 * One permissionId may complete exactly once; session stop/close rejects pending.
 */

import type { EmitFn, LogFn } from './eventNormalizer.ts';

export interface PermissionDecision {
  allow: boolean;
}

export interface PermissionResultAllow {
  behavior: 'allow';
  updatedInput?: Record<string, unknown>;
  toolUseID?: string;
}

export interface PermissionResultDeny {
  behavior: 'deny';
  message: string;
  interrupt?: boolean;
  toolUseID?: string;
}

export type PermissionResult = PermissionResultAllow | PermissionResultDeny;

interface PendingEntry {
  sessionId: string;
  permissionId: string;
  toolName: string;
  settle: (result: PermissionResult) => void;
  abortHandler: () => void;
  signal: AbortSignal;
}

let permSeq = 0;

function nextPermissionId(toolUseId?: string): string {
  if (toolUseId && toolUseId.length > 0) return toolUseId;
  permSeq += 1;
  return `perm-${Date.now()}-${permSeq}`;
}

export class PermissionBridge {
  private pending = new Map<string, PendingEntry>();
  private readonly emit: EmitFn;
  private readonly log: LogFn;

  constructor(emit: EmitFn, log: LogFn = () => undefined) {
    this.emit = emit;
    this.log = log;
  }

  /**
   * SDK canUseTool handler — emits permission.requested and waits for respond.
   */
  createCanUseTool(sessionId: string): (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      toolUseID: string;
      title?: string;
      displayName?: string;
      description?: string;
      decisionReason?: string;
      requestId?: string;
    }
  ) => Promise<PermissionResult> {
    return (toolName, input, options) => {
      return this.request({
        sessionId,
        toolName,
        input,
        signal: options.signal,
        toolUseId: options.toolUseID,
        description: options.description ?? options.title ?? options.displayName,
      });
    };
  }

  request(input: {
    sessionId: string;
    toolName: string;
    input: Record<string, unknown>;
    signal: AbortSignal;
    toolUseId?: string;
    description?: string;
  }): Promise<PermissionResult> {
    const permissionId = nextPermissionId(input.toolUseId);

    if (input.signal.aborted) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'Session aborted before permission prompt',
        interrupt: true,
        toolUseID: permissionId,
      });
    }

    if (this.pending.has(permissionId)) {
      this.log('duplicate permissionId, denying:', permissionId);
      return Promise.resolve({
        behavior: 'deny',
        message: 'Duplicate permission request',
        toolUseID: permissionId,
      });
    }

    return new Promise<PermissionResult>((resolve) => {
      let settled = false;
      const settle = (result: PermissionResult) => {
        if (settled) return;
        settled = true;
        const entry = this.pending.get(permissionId);
        if (entry) {
          entry.signal.removeEventListener('abort', entry.abortHandler);
          this.pending.delete(permissionId);
        }
        this.emit({
          type: 'permission.resolved',
          sessionId: input.sessionId,
          payload: { permissionId, allow: result.behavior === 'allow' },
        });
        // Resume running unless abort already took over, and only once this
        // session has no other permission parked — settling card A while B
        // is still pending must not announce 'running' out from under B.
        if (!input.signal.aborted && !this.hasPending(input.sessionId)) {
          this.emit({
            type: 'session.status',
            sessionId: input.sessionId,
            payload: { status: 'running' },
          });
        }
        resolve(result);
      };

      const abortHandler = () => {
        settle({
          behavior: 'deny',
          message: 'Session stopped while waiting for permission',
          interrupt: true,
          toolUseID: permissionId,
        });
      };

      this.pending.set(permissionId, {
        sessionId: input.sessionId,
        permissionId,
        toolName: input.toolName,
        settle,
        abortHandler,
        signal: input.signal,
      });
      input.signal.addEventListener('abort', abortHandler, { once: true });

      this.emit({
        type: 'permission.requested',
        sessionId: input.sessionId,
        payload: {
          permissionId,
          toolName: input.toolName,
          description: input.description,
          input: input.input,
        },
      });
      this.emit({
        type: 'session.status',
        sessionId: input.sessionId,
        payload: { status: 'waiting_permission' },
      });
    });
  }

  /** Apply Renderer decision. Returns false if unknown / already settled. */
  respond(input: { sessionId: string; permissionId: string; allow: boolean }): boolean {
    const entry = this.pending.get(input.permissionId);
    if (!entry) {
      this.log('permission.respond: no pending', input.permissionId);
      return false;
    }
    if (entry.sessionId !== input.sessionId) {
      this.log('permission.respond: session mismatch', input);
      return false;
    }
    if (input.allow) {
      entry.settle({
        behavior: 'allow',
        toolUseID: input.permissionId,
      });
    } else {
      entry.settle({
        behavior: 'deny',
        message: 'User denied permission',
        toolUseID: input.permissionId,
      });
    }
    return true;
  }

  /** Reject all pending prompts for a session (stop / close). */
  rejectSession(sessionId: string, message = 'Session closed'): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.sessionId !== sessionId) continue;
      entry.settle({
        behavior: 'deny',
        message,
        interrupt: true,
        toolUseID: entry.permissionId,
      });
    }
  }

  /** Reject everything (Host shutdown). */
  rejectAll(message = 'Host shutting down'): void {
    for (const entry of [...this.pending.values()]) {
      entry.settle({
        behavior: 'deny',
        message,
        interrupt: true,
        toolUseID: entry.permissionId,
      });
    }
  }

  hasPending(sessionId?: string): boolean {
    if (!sessionId) return this.pending.size > 0;
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }
}
