import { isExtensionUiDialogMethod } from '@shared/types/runtimeEvents';

/**
 * Which window owns a blocking Extension UI request — T11 / audit item 8.
 *
 * ## The problem this exists for
 *
 * Runtime Events are broadcast to every `BrowserWindow`. For a stream of text
 * that is harmless: a window showing a different session drops the event on the
 * floor. For an `extensionUi.request` it is not, because that dialog is a
 * QUESTION the Host is blocked on. Broadcast, two windows both show the
 * permission prompt for a session only one of them is looking at, and both
 * race to answer it — the second answer is refused, so whoever pressed second
 * watches their click do nothing, and neither knows which of them decided.
 *
 * ## What ownership means here
 *
 * The window that most recently drove the session: the one whose renderer sent
 * `session.create` / `session.resume` / `session.send`. That is the window with
 * the chat on screen, and it is the only claim available — Main does not
 * otherwise know which window is showing what.
 *
 * ## Why cancellations are routed by remembered target, not recomputed
 *
 * `extensionUi.cancelled` must reach exactly the windows that were shown the
 * request. Recomputing ownership at cancel time would get it wrong precisely
 * when it matters: a session whose owner has since changed (or gone) would
 * leave the original window holding a modal that can never be answered. So the
 * request's target is recorded and the cancellation follows it.
 *
 * Pure and Electron-free — `chat.ts` maps window ids to `webContents`.
 */

/** `undefined` = no ownership known; the caller broadcasts. */
export type ExtensionUiTargets = number[] | undefined;

interface RoutableEvent {
  type: string;
  sessionId?: string;
  payload?: unknown;
}

export interface ExtensionUiRouterOptions {
  /** Windows that still exist. Ownership by a closed window is not ownership. */
  isWindowAlive: (webContentsId: number) => boolean;
}

export class ExtensionUiRouter {
  private readonly sessionOwner = new Map<string, number>();
  /** `uiRequestId` → the window it was sent to; absent value = it was broadcast. */
  private readonly requestTarget = new Map<string, number | 'broadcast'>();
  private readonly isWindowAlive: (webContentsId: number) => boolean;

  constructor(options: ExtensionUiRouterOptions) {
    this.isWindowAlive = options.isWindowAlive;
  }

  /** The renderer at `webContentsId` just drove this session. */
  claimSession(sessionId: string, webContentsId: number): void {
    if (!sessionId) return;
    this.sessionOwner.set(sessionId, webContentsId);
  }

  releaseSession(sessionId: string): void {
    this.sessionOwner.delete(sessionId);
  }

  /** A window closed: it owns nothing, and its parked requests go back to broadcast. */
  releaseWindow(webContentsId: number): void {
    for (const [sessionId, owner] of [...this.sessionOwner]) {
      if (owner === webContentsId) this.sessionOwner.delete(sessionId);
    }
    for (const [uiRequestId, target] of [...this.requestTarget]) {
      if (target === webContentsId) this.requestTarget.delete(uiRequestId);
    }
  }

  ownerOf(sessionId: string): number | undefined {
    const owner = this.sessionOwner.get(sessionId);
    if (owner === undefined) return undefined;
    if (!this.isWindowAlive(owner)) {
      this.sessionOwner.delete(sessionId);
      return undefined;
    }
    return owner;
  }

  /**
   * Where one event goes. `undefined` means "everywhere". Ordinary runtime
   * events still broadcast, while Extension UI display state follows the same
   * session owner as its dialog WITHOUT entering requestTarget. That avoids one
   * notify becoming a toast in the owner plus duplicate OS notifications in
   * every unfocused mirror window.
   */
  targetsFor(event: RoutableEvent): ExtensionUiTargets {
    if (event.type === 'extensionUi.request') {
      // T10: notify/status/widget/unsupported are fire-and-forget. They follow
      // the session owner so one notify has one delivery surface, but never
      // enter requestTarget — no renderer answers them, and remembering them
      // would leak one entry per call for the life of Main.
      const method = readString(event.payload, 'method');
      const owner = event.sessionId ? this.ownerOf(event.sessionId) : undefined;
      if (!isExtensionUiDialogMethod(method)) {
        return owner === undefined ? undefined : [owner];
      }

      const uiRequestId = readString(event.payload, 'uiRequestId');
      if (uiRequestId) this.requestTarget.set(uiRequestId, owner ?? 'broadcast');
      // No sessionId at all is an extension asking during INIT: it belongs to no
      // chat, so every window is as correct as any other.
      return owner === undefined ? undefined : [owner];
    }
    if (event.type === 'extensionUi.cancelled') {
      const ids = readStringArray(event.payload, 'uiRequestIds');
      if (ids.length === 0) return undefined;
      const targets = new Set<number>();
      let broadcast = false;
      for (const id of ids) {
        const target = this.requestTarget.get(id);
        this.requestTarget.delete(id);
        // Unknown is treated as broadcast on purpose: a cancellation that fails
        // to arrive leaves a dead modal on screen, which is worse than one
        // extra window receiving an id it never had.
        if (target === undefined || target === 'broadcast') broadcast = true;
        else if (this.isWindowAlive(target)) targets.add(target);
      }
      if (broadcast || targets.size === 0) return undefined;
      return [...targets];
    }
    return undefined;
  }

  /**
   * The renderer answered this dialog, so its routing entry is spent.
   *
   * A dialog settles one of two ways: the Host cancels it (handled above) or
   * the user answers it (here). Without this second call the map would keep an
   * entry for every prompt ever shown, for the life of the process.
   */
  forgetRequest(uiRequestId: string): void {
    this.requestTarget.delete(uiRequestId);
  }

  /** Diagnostics / tests. */
  pendingRequestCount(): number {
    return this.requestTarget.size;
  }
}

function readString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : undefined;
}

function readStringArray(payload: unknown, key: string): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
