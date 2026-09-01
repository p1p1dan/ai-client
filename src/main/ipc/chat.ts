/**
 * Chat / Runtime IPC — Renderer ↔ Main ↔ Agent Host.
 * Forwards Host Runtime Events to all BrowserWindows.
 */

import { IPC_CHANNELS } from '@shared/types';
import type { SessionEffortLevel } from '@shared/types/agentHost';
import { PI_AGENT } from '@shared/types/agentWire';
import type { ExtensionUiResponse, RuntimeEvent } from '@shared/types/runtimeEvents';
import type { HistorySessionSummary } from '@shared/types/sessionHistory';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron';
import { workerManager } from '../services/agent-host/WorkerManager';
import { assertAgentSpawnAllowed } from '../services/auth/spawnGate';
import { ExtensionUiRouter } from '../services/chat/extensionUiRouting';
import { sessionIndexService } from '../services/chat/SessionIndexService';

/**
 * Which window drove which session — see `extensionUiRouting.ts` for why a
 * blocking dialog must not be broadcast.
 */
const extensionUiRouter = new ExtensionUiRouter({
  isWindowAlive: (webContentsId) =>
    BrowserWindow.getAllWindows().some(
      (win) => !win.isDestroyed() && win.webContents.id === webContentsId
    ),
});

/** The window that sent this IPC call, when it still exists. */
const windowCleanupAttached = new Set<number>();

function ownerIdFor(event: IpcMainInvokeEvent | undefined): number | undefined {
  const webContentsId = event?.sender?.id;
  return typeof webContentsId === 'number' ? webContentsId : undefined;
}

function claimSessionForSender(
  event: IpcMainInvokeEvent | undefined,
  sessionId: string | undefined
): number | undefined {
  // A call with no identifiable sender claims nothing rather than throwing:
  // routing is an optimisation over broadcast, and no handler may fail a
  // session create because it could not work out which window asked.
  const webContentsId = ownerIdFor(event);
  if (!sessionId || webContentsId === undefined) return webContentsId;
  extensionUiRouter.claimSession(sessionId, webContentsId);
  workerManager.claimSession(sessionId, webContentsId);
  if (!windowCleanupAttached.has(webContentsId) && typeof event?.sender?.once === 'function') {
    windowCleanupAttached.add(webContentsId);
    event.sender.once('destroyed', () => {
      windowCleanupAttached.delete(webContentsId);
      extensionUiRouter.releaseWindow(webContentsId);
      workerManager.releaseWindow(webContentsId);
    });
  }
  return webContentsId;
}

function broadcastRuntimeEvent(event: RuntimeEvent): void {
  // `undefined` = every window, which is the rule for everything except a
  // blocking Extension UI dialog. Narrowing the whole stream would break a
  // second window that legitimately mirrors the same session.
  const targets = extensionUiRouter.targetsFor(event);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (targets && !targets.includes(win.webContents.id)) continue;
    try {
      win.webContents.send(IPC_CHANNELS.CHAT_RUNTIME_EVENT, event);
    } catch {
      // Window may be closing mid-send
    }
  }
}

let eventBridgeAttached = false;

function ensureEventBridge(): void {
  if (eventBridgeAttached) return;
  eventBridgeAttached = true;
  workerManager.onEvent(broadcastRuntimeEvent);
  workerManager.onEvent((event) => sessionIndexService.handleRuntimeEvent(event));
}

export function registerChatHandlers(): void {
  ensureEventBridge();

  ipcMain.handle(IPC_CHANNELS.CHAT_ENSURE_HOST, async () => {
    await workerManager.ensureReady();
    return workerManager.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_GET_HOST_STATUS, async () => {
    return workerManager.getStatus();
  });

  ipcMain.handle(
    IPC_CHANNELS.CHAT_CREATE_SESSION,
    async (
      e,
      payload: {
        sessionId: string;
        workspacePath: string;
        model?: string;
        /** T-20 reasoning effort; worker validates the Pi vocabulary. */
        effort?: SessionEffortLevel;
      }
    ): Promise<{ requestId: string }> => {
      // D47 S5 §3 — agent-session-only spawn gate. `attach`/resume-of-an-
      // existing-connection and plain terminal sessions are never gated
      // (SessionManager.create's own kind==='agent' check is the sibling
      // enforcement point for the PTY-agent path).
      assertAgentSpawnAllowed();
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      await sessionIndexService.recordCreated({
        sessionId: payload.sessionId,
        workspacePath: payload.workspacePath,
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.effort ? { effort: payload.effort } : {}),
        agent: PI_AGENT,
      });
      const requestId = await workerManager.createSession({
        sessionId: payload.sessionId,
        workspacePath: payload.workspacePath,
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.effort ? { effort: payload.effort } : {}),
        ownerWebContentsId,
      });
      return { requestId };
    }
  );

  /**
   * R5 D2 — index-only registration. Deliberately does NOT touch
   * WorkerManager: creating a chat in the sidebar must not spawn a utility
   * worker or runtime session before the user has typed anything.
   * `recordCreated` upserts (it preserves an existing entry's title /
   * runtimeIdentity / archived bit), so calling this ahead of the lazy
   * `CHAT_CREATE_SESSION` on first send is idempotent in either order.
   * Returns false instead of throwing — the caller treats indexing as
   * best-effort and must never fail a session creation over it.
   */
  ipcMain.handle(
    IPC_CHANNELS.CHAT_REGISTER_SESSION,
    async (
      _e,
      payload: {
        sessionId: string;
        workspacePath: string;
        model?: string;
      }
    ): Promise<boolean> => {
      try {
        await sessionIndexService.recordCreated({ ...payload, agent: PI_AGENT });
        return true;
      } catch (error) {
        console.warn('[chat] Failed to register session in the index:', error);
        return false;
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_RESUME_SESSION,
    async (
      e,
      payload: {
        sessionId: string;
        runtimeIdentity: string;
        workspacePath: string;
        model?: string;
        /** T-20 reasoning effort; worker validates the Pi vocabulary. */
        effort?: SessionEffortLevel;
      }
    ): Promise<{ requestId: string }> => {
      // Real Pi JSONL resume lands in T32. T29-c deliberately refuses rather
      // than routing the session back through the deleted singleton Pi host.
      claimSessionForSender(e, payload.sessionId);
      void payload.runtimeIdentity;
      throw new Error('pi_resume_not_implemented: Pi session resume lands in T32');
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SEND,
    async (
      e,
      payload: {
        sessionId: string;
        attemptId: string;
        text: string;
        attachments?: Array<{
          kind: 'image' | 'text';
          mediaType: string;
          data: string;
          name?: string;
        }>;
        /** T-20 per-turn override; falls back to the session default. */
        effort?: SessionEffortLevel;
        /** Round-2 P0: per-turn override; falls back to the session default. */
        model?: string;
      }
    ): Promise<{ requestId: string }> => {
      // Ownership follows the most recent driver: a session picked up in a
      // second window must show ITS approval prompts there, not in the first.
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      const requestId = await workerManager.send({ ...payload, ownerWebContentsId });
      return { requestId };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_STOP,
    async (e, payload: { sessionId: string }): Promise<{ requestId: string }> => {
      claimSessionForSender(e, payload.sessionId);
      const requestId = await workerManager.stop(payload.sessionId);
      return { requestId };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_CLOSE_SESSION,
    async (_e, payload: { sessionId: string }): Promise<{ requestId: string }> => {
      extensionUiRouter.releaseSession(payload.sessionId);
      workerManager.releaseSession(payload.sessionId);
      const requestId = await workerManager.closeSession(payload.sessionId);
      return { requestId };
    }
  );

  /**
   * T11 — the renderer's answer to one extension UI dialog.
   *
   * Main is a passthrough here, deliberately: it cannot validate the answer
   * because it does not know what the extension asked or what it will do with
   * the reply. The Host's bridge owns every check that matters (right bridge
   * instance, dialog still pending, fallback on a dismissal), and duplicating
   * half of them here would create a second place for them to drift.
   */
  ipcMain.handle(
    IPC_CHANNELS.CHAT_RESPOND_EXTENSION_UI,
    async (e, payload: ExtensionUiResponse): Promise<{ requestId: string }> => {
      const requestId = await workerManager.respondExtensionUi(payload, ownerIdFor(e));
      // Forget only after the authoritative slot acknowledges the response so
      // a transient failure can be retried by the same owner.
      extensionUiRouter.forgetRequest(payload.uiRequestId);
      return { requestId };
    }
  );

  ipcMain.handle(IPC_CHANNELS.CHAT_LIST_SESSIONS, async (): Promise<SessionIndexEntry[]> => {
    return sessionIndexService.list();
  });

  ipcMain.handle(
    IPC_CHANNELS.CHAT_RENAME_SESSION,
    async (_e, payload: { sessionId: string; title: string }): Promise<boolean> => {
      return sessionIndexService.rename(payload.sessionId, payload.title);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_ARCHIVE_SESSION,
    async (_e, payload: { sessionId: string; archived: boolean }): Promise<boolean> => {
      return sessionIndexService.setArchived(payload.sessionId, payload.archived);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_LIST_HISTORY,
    async (_e, workspacePath: string): Promise<HistorySessionSummary[]> => {
      void workspacePath;
      return [];
    }
  );
}
