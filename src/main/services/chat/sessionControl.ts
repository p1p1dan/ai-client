import { SESSION_CONTROLLED_ELSEWHERE } from '@shared/plugins/chatChannels';
import type { SessionControlChange, SessionController } from '@shared/types/sessionControl';

/**
 * Who may change each conversation (plugin-system README §4).
 *
 * The desktop controls every session until a plugin's client takes one over;
 * from then on only that client may change it, until the desktop takes it back
 * or the client goes away. Callers are told apart by owner id: a window's is
 * its webContents id (positive), a plugin client's is negative
 * (`allocateRemoteOwnerId`), and a call with no owner counts as the desktop.
 *
 * Process-local on purpose: a restart ends every client connection, so every
 * session starts on the desktop again.
 */
export class SessionControlRegistry {
  private readonly clients = new Map<string, Extract<SessionController, { kind: 'client' }>>();
  private readonly listeners = new Set<(change: SessionControlChange) => void>();

  get(sessionId: string): SessionController {
    return this.clients.get(sessionId) ?? { kind: 'desktop' };
  }

  /** Every session a client currently controls. */
  list(): SessionControlChange[] {
    return [...this.clients].map(([sessionId, controller]) => ({ sessionId, controller }));
  }

  acquireForDesktop(sessionId: string): void {
    if (!this.clients.delete(sessionId)) return;
    this.emit(sessionId, { kind: 'desktop' });
  }

  acquireForClient(
    sessionId: string,
    client: { ownerId: number; pluginId: string; label: string }
  ): void {
    if (client.ownerId >= 0) throw new Error('A plugin client owner id is negative');
    const current = this.clients.get(sessionId);
    if (current?.ownerId === client.ownerId && current.label === client.label) return;
    const controller = { kind: 'client' as const, ...client };
    this.clients.set(sessionId, controller);
    this.emit(sessionId, controller);
  }

  /** A client went away: every session it held goes back to the desktop. */
  releaseOwner(ownerId: number): void {
    for (const [sessionId, controller] of [...this.clients]) {
      if (controller.ownerId !== ownerId) continue;
      this.clients.delete(sessionId);
      this.emit(sessionId, { kind: 'desktop' });
    }
  }

  /** Throws `session_controlled_elsewhere` unless `ownerId` may change `sessionId`. */
  assertMayChange(sessionId: string, ownerId: number | undefined): void {
    const controller = this.get(sessionId);
    const isClient = ownerId !== undefined && ownerId < 0;
    if (controller.kind === 'desktop') {
      if (!isClient) return;
      throw new Error(
        `${SESSION_CONTROLLED_ELSEWHERE}: Session ${sessionId} is in use on the desktop; take it over first`
      );
    }
    if (ownerId === controller.ownerId) return;
    throw new Error(
      `${SESSION_CONTROLLED_ELSEWHERE}: Session ${sessionId} is in use on ${controller.label}; take it over first`
    );
  }

  onChange(listener: (change: SessionControlChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(sessionId: string, controller: SessionController): void {
    for (const listener of this.listeners) {
      try {
        listener({ sessionId, controller });
      } catch (error) {
        console.warn('[sessionControl] A listener threw:', error);
      }
    }
  }
}

export const sessionControl = new SessionControlRegistry();
