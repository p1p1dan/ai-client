/**
 * Chat / Runtime IPC — Renderer ↔ Main ↔ Agent Host.
 * Forwards Host Runtime Events to all BrowserWindows.
 */

import { stat } from 'node:fs/promises';
import { IPC_CHANNELS } from '@shared/types';
import type { SessionEffortLevel } from '@shared/types/agentHost';
import { PI_AGENT, resolveAgentWireName } from '@shared/types/agentWire';
import type { ExtensionUiResponse, RuntimeEvent } from '@shared/types/runtimeEvents';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import {
  isSessionPermissionTier,
  type SessionPermissionTier,
} from '@shared/types/sessionPermissionTier';
import { BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron';
import { scratchWorkspaceService } from '../services/agent-host/ScratchWorkspaceService';
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

/**
 * Was this indexed Pi session ever actually written?
 *
 * A row can name a JSONL that has never existed: Pi reserves the filename when
 * a session is created and writes it only when the first assistant message
 * lands, and builds before that was understood indexed the reservation. Such a
 * row has no `piLeaf` either — a leaf checkpoint is only committed once a turn
 * has ended — and that pair is what separates "Pi never wrote this" from "the
 * user deleted a real transcript", which keeps its leaf and must still fail
 * loudly rather than be quietly replaced with an empty session.
 */
async function isUnwrittenPiSession(row: SessionIndexEntry): Promise<boolean> {
  if (!row.runtimeIdentity || row.piLeaf) return false;
  try {
    return !(await stat(row.runtimeIdentity)).isFile();
  } catch {
    return true;
  }
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

async function assertPiCompatibleIndexRow(sessionId: string): Promise<void> {
  const row = await sessionIndexService.get(sessionId);
  if (row && resolveAgentWireName(row.agent) !== PI_AGENT) {
    throw new Error(`pi_session_agent_mismatch: Session ${sessionId} is not indexed as Pi`);
  }
}

/**
 * Q17 — hand the session's JSONL back from terminal mode to the GUI.
 *
 * Deliberately kills the terminal rather than negotiating with it: the Pi CLI
 * offers no flush-and-hand-over handshake, so "stop the other writer" is the
 * only guarantee available. Best-effort by design — a send must not fail
 * because a terminal that may not even exist could not be reaped.
 */
async function releaseTuiOwnership(sessionId: string): Promise<void> {
  try {
    const row = await sessionIndexService.get(sessionId);
    const sessionFile = row?.runtimeIdentity;
    if (!sessionFile) return;
    const { releaseSessionForHostPrompt } = await import('./piTui');
    await releaseSessionForHostPrompt(sessionFile);
  } catch (error) {
    console.warn('[chat] Failed to release Pi TUI ownership before send:', error);
  }
}

async function requireIndexedPiSession(
  sessionId: string
): Promise<SessionIndexEntry & { runtimeIdentity: string }> {
  const row = await sessionIndexService.get(sessionId);
  if (!row?.runtimeIdentity) {
    throw new Error(`pi_session_not_found: No indexed Pi session file for ${sessionId}`);
  }
  if (resolveAgentWireName(row.agent) !== PI_AGENT) {
    throw new Error(`pi_session_agent_mismatch: Session ${sessionId} is not indexed as Pi`);
  }
  return row as SessionIndexEntry & { runtimeIdentity: string };
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
      await assertPiCompatibleIndexRow(payload.sessionId);
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
        // U05-c: Main decides the posture from the path it allocated itself —
        // the renderer never gets to declare a session trusted or untrusted.
        ...(scratchWorkspaceService.isScratchPath(payload.workspacePath) ? { unbound: true } : {}),
      });
      return { requestId };
    }
  );

  /**
   * U05-a — hand an unbound chat its isolated working directory.
   *
   * Called on the first send and on the first Pi TUI open, never when the chat
   * row is created: a chat the user never actually uses must not put a
   * directory on disk (same rule `chat:registerSession` follows for workers).
   * Idempotent, so both callers can ask without coordinating.
   */
  ipcMain.handle(
    IPC_CHANNELS.CHAT_ENSURE_SCRATCH_WORKSPACE,
    async (_e, payload: { sessionId: string }): Promise<{ path: string }> => {
      return { path: await scratchWorkspaceService.ensure(payload.sessionId) };
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
        await assertPiCompatibleIndexRow(payload.sessionId);
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
      const row = await sessionIndexService.get(payload.sessionId);
      if (!row?.runtimeIdentity) {
        throw new Error(
          `pi_session_not_found: No indexed Pi session file for ${payload.sessionId}`
        );
      }
      if (resolveAgentWireName(row.agent) !== PI_AGENT) {
        throw new Error(
          `pi_session_agent_mismatch: Session ${payload.sessionId} is not indexed as a Pi session`
        );
      }
      if (row.runtimeIdentity !== payload.runtimeIdentity) {
        throw new Error(
          'pi_session_identity_mismatch: Indexed Pi session file does not match the resume request'
        );
      }
      if (row.workspacePath !== payload.workspacePath) {
        throw new Error(
          'pi_session_workspace_mismatch: Indexed workspace does not match the resume request'
        );
      }
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      // U05-a: an unbound chat's directory was wiped when the app last quit,
      // so recreate it (empty) at the exact path the index still names before
      // anything tries to spawn Pi in it.
      const unbound = scratchWorkspaceService.isScratchPath(payload.workspacePath);
      if (unbound) {
        await scratchWorkspaceService.adopt(payload.sessionId, payload.workspacePath);
      }
      if (await isUnwrittenPiSession(row)) {
        // Repair, not resume: there is no file to reopen and nothing was ever
        // persisted, so drop the phantom identity and give the chat a real Pi
        // session. Without this the row stays unopenable for good — resume can
        // only ever fail on it, and the UI tells the user to abandon a chat
        // that never lost anything.
        assertAgentSpawnAllowed();
        await sessionIndexService.clearUnwrittenRuntimeIdentity(
          payload.sessionId,
          row.runtimeIdentity
        );
        const repaired = await workerManager.createSession({
          sessionId: payload.sessionId,
          workspacePath: payload.workspacePath,
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.effort ? { effort: payload.effort } : {}),
          ownerWebContentsId,
          ...(unbound ? { unbound: true } : {}),
        });
        return { requestId: repaired };
      }
      const requestId = await workerManager.resumeSession({
        sessionId: payload.sessionId,
        sessionFile: payload.runtimeIdentity,
        workspacePath: payload.workspacePath,
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.effort ? { effort: payload.effort } : {}),
        ...(row.piLeaf ? { leafCheckpoint: row.piLeaf } : {}),
        ownerWebContentsId,
        ...(unbound ? { unbound: true } : {}),
      });
      return { requestId };
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
      // Q17 — a warm Pi terminal on this session must stop before the worker
      // writes the same JSONL. Terminals on other sessions are untouched.
      await releaseTuiOwnership(payload.sessionId);
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

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SET_PERMISSION_TIER,
    async (
      e,
      payload: { sessionId: string; tier: SessionPermissionTier }
    ): Promise<{ requestId: string }> => {
      if (!isSessionPermissionTier(payload.tier)) {
        throw new Error(`Invalid permission tier: ${String(payload.tier)}`);
      }
      claimSessionForSender(e, payload.sessionId);
      const requestId = await workerManager.setPermissionTier(payload.sessionId, payload.tier);
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
      const result = await sessionIndexService.setArchived(payload.sessionId, payload.archived);
      // U05-a "session destroyed" cleanup: archiving is how this product
      // retires a chat, so it is where an unbound chat's throwaway directory
      // goes away. Un-archiving re-creates it empty through the resume path.
      if (result && payload.archived) {
        await scratchWorkspaceService.release(payload.sessionId);
      }
      return result;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_GET_SESSION_TREE,
    async (
      e,
      payload: { sessionId: string; requestSequence: number }
    ): Promise<Awaited<ReturnType<typeof workerManager.getSessionTree>>> => {
      const row = await requireIndexedPiSession(payload.sessionId);
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      const result = await workerManager.getSessionTree({
        sessionId: payload.sessionId,
        requestSequence: payload.requestSequence,
        ownerWebContentsId,
      });
      if (result.snapshot.sessionFile !== row.runtimeIdentity) {
        throw new Error(
          'pi_session_identity_mismatch: Tree slot does not match the indexed session'
        );
      }
      return result;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_REWIND_SESSION,
    async (
      e,
      payload: { sessionId: string; entryId: string; confirmed: boolean }
    ): Promise<Awaited<ReturnType<typeof workerManager.rewindSession>>> => {
      await requireIndexedPiSession(payload.sessionId);
      if (payload.confirmed !== true) {
        throw new Error('rewind_confirmation_required: Rewind requires explicit confirmation');
      }
      return workerManager.rewindSession({
        sessionId: payload.sessionId,
        entryId: payload.entryId,
        confirmed: true,
        ownerWebContentsId: claimSessionForSender(e, payload.sessionId),
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_FORK_SESSION,
    async (
      e,
      payload: { sessionId: string; entryId: string }
    ): Promise<Awaited<ReturnType<typeof workerManager.forkSession>>> => {
      const row = await requireIndexedPiSession(payload.sessionId);
      return workerManager.forkSession({
        sourceSessionId: payload.sessionId,
        entryId: payload.entryId,
        sourceTitle: row.title,
        ...(row.model ? { model: row.model } : {}),
        ownerWebContentsId: claimSessionForSender(e, payload.sessionId),
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_LOAD_HISTORY_PAGE,
    async (
      e,
      payload: { sessionId: string; offset: number; limit?: number }
    ): Promise<{ requestId: string }> => {
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      const requestId = await workerManager.loadHistoryPage({
        ...payload,
        ownerWebContentsId,
      });
      return { requestId };
    }
  );
}
