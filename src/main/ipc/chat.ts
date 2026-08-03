/**
 * Chat / Runtime IPC — Renderer ↔ Main ↔ Agent Host.
 * Forwards Host Runtime Events to all BrowserWindows.
 */

import { IPC_CHANNELS } from '@shared/types';
import type { AgentHostDriver, SessionEffortLevel } from '@shared/types/agentHost';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import type { HistorySessionSummary } from '@shared/types/sessionHistory';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { BrowserWindow, ipcMain } from 'electron';
import { agentHostManager } from '../services/agent-host/AgentHostManager';
import { sessionIndexService } from '../services/chat/SessionIndexService';

function broadcastRuntimeEvent(event: RuntimeEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
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
  agentHostManager.onEvent(broadcastRuntimeEvent);
  agentHostManager.onEvent((event) => sessionIndexService.handleRuntimeEvent(event));
}

export function registerChatHandlers(): void {
  ensureEventBridge();

  ipcMain.handle(IPC_CHANNELS.CHAT_ENSURE_HOST, async (_e, driver?: AgentHostDriver) => {
    await agentHostManager.ensureStarted(driver);
    return agentHostManager.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_GET_HOST_STATUS, async () => {
    return agentHostManager.getStatus();
  });

  ipcMain.handle(
    IPC_CHANNELS.CHAT_CREATE_SESSION,
    async (
      _e,
      payload: {
        sessionId: string;
        workspacePath: string;
        model?: string;
        /** T-20 reasoning effort; Host drops unknown levels (normalizeEffort). */
        effort?: SessionEffortLevel;
      }
    ): Promise<{ requestId: string }> => {
      await sessionIndexService.recordCreated(payload);
      const requestId = await agentHostManager.createSession(payload);
      return { requestId };
    }
  );

  /**
   * R5 D2 — index-only registration. Deliberately does NOT touch
   * `agentHostManager`: creating a chat in the sidebar must not spawn the
   * Host process or a runtime session before the user has typed anything.
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
      payload: { sessionId: string; workspacePath: string; model?: string }
    ): Promise<boolean> => {
      try {
        await sessionIndexService.recordCreated(payload);
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
      _e,
      payload: {
        sessionId: string;
        runtimeIdentity: string;
        workspacePath: string;
        model?: string;
        /** T-20 reasoning effort; Host drops unknown levels (normalizeEffort). */
        effort?: SessionEffortLevel;
      }
    ): Promise<{ requestId: string }> => {
      await sessionIndexService.recordResumed(payload);
      const requestId = await agentHostManager.resumeSession(payload);
      return { requestId };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SEND,
    async (
      _e,
      payload: {
        sessionId: string;
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
      const requestId = await agentHostManager.sendMessage(payload);
      return { requestId };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_STOP,
    async (_e, payload: { sessionId: string }): Promise<{ requestId: string }> => {
      const requestId = await agentHostManager.stopSession(payload);
      return { requestId };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_CLOSE_SESSION,
    async (_e, payload: { sessionId: string }): Promise<{ requestId: string }> => {
      const requestId = await agentHostManager.closeSession(payload);
      return { requestId };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_RESPOND_PERMISSION,
    async (
      _e,
      payload: { sessionId: string; permissionId: string; allow: boolean }
    ): Promise<{ requestId: string }> => {
      const requestId = await agentHostManager.respondPermission(payload);
      return { requestId };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_RESPOND_QUESTION,
    async (
      _e,
      payload: {
        sessionId: string;
        questionId: string;
        answers?: Record<string, string>;
        response?: string;
        cancel?: boolean;
      }
    ): Promise<{ requestId: string }> => {
      const requestId = await agentHostManager.respondQuestion(payload);
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
      return agentHostManager.listHistory(workspacePath);
    }
  );
}
