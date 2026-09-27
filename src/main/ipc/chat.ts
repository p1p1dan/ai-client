import {
  isRuntimePermissionSettings,
  type RuntimePermissionSettings,
} from '@shared/types/runtimePermission';
/**
 * Chat / Runtime IPC — Renderer ↔ Main ↔ Agent Host.
 * Forwards Host Runtime Events to all BrowserWindows.
 */

import { stat } from 'node:fs/promises';
import { IPC_CHANNELS } from '@shared/types';
import type { SessionEffortLevel } from '@shared/types/agentHost';
import { PI_AGENT, resolveAgentWireName } from '@shared/types/agentWire';
import type { PermissionDecisionId, RuntimeEvent } from '@shared/types/runtimeEvents';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import {
  isSessionPermissionTier,
  type SessionPermissionTier,
} from '@shared/types/sessionPermissionTier';
import type { WorkerCapabilityInventory } from '@shared/types/workerRpc';
import { BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron';
import { scratchWorkspaceService } from '../services/agent-host/ScratchWorkspaceService';
import { adoptTempWorkspace } from '../services/agent-host/TempWorkspaceService';
import { WorkerManagerError, workerManager } from '../services/agent-host/WorkerManager';
import { assertAgentSpawnAllowed } from '../services/auth/spawnGate';
import { sessionIndexService } from '../services/chat/SessionIndexService';
import { readSessionReplayPage } from '../services/chat/SessionReplayReader';

/** The window that sent this IPC call, when it still exists. */
const windowCleanupAttached = new Set<number>();

/**
 * Sequence numbers for the read-only replay events (T102).
 *
 * Its own counter rather than the WorkerManager's: a replay is not produced by
 * the host, so borrowing the host's sequence would let a page that no worker
 * emitted advance a number other events are ordered by. Nothing consumes `seq`
 * for ordering today (the renderer's event bus fans out in arrival order), so
 * what this has to be is monotonic within this process, which it is.
 */
let replaySequence = 0;
function nextReplaySequence(): number {
  replaySequence += 1;
  return replaySequence;
}

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
  workerManager.claimSession(sessionId, webContentsId);
  if (!windowCleanupAttached.has(webContentsId) && typeof event?.sender?.once === 'function') {
    windowCleanupAttached.add(webContentsId);
    event.sender.once('destroyed', () => {
      windowCleanupAttached.delete(webContentsId);
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
  // Every window. The one event that was ever narrowed to a single window was
  // the blocking Extension UI dialog, retired by decision 012; narrowing any of
  // what is left would break a second window that legitimately mirrors the same
  // session.
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
  workerManager.onEvent(broadcastRuntimeEvent);
  workerManager.onEvent((event) => sessionIndexService.handleRuntimeEvent(event));
}

/**
 * Refuse a session the index already binds to another agent.
 *
 * Hands back the row it read (D15), so a caller can tell "this row existed
 * before I touched it" from "I am the one who just wrote it" without a second
 * read — the difference between a shell this handler owns and somebody else's
 * persisted session.
 */
async function assertPiCompatibleIndexRow(
  sessionId: string
): Promise<SessionIndexEntry | undefined> {
  const row = await sessionIndexService.get(sessionId);
  if (row && resolveAgentWireName(row.agent) !== PI_AGENT) {
    throw new Error(`pi_session_agent_mismatch: Session ${sessionId} is not indexed as Pi`);
  }
  return row;
}

/**
 * Q17 — hand the session's JSONL back from terminal mode to the GUI.
 *
 * Deliberately kills the terminal rather than negotiating with it: the Pi CLI
 * offers no flush-and-hand-over handshake, so "stop the other writer" is the
 * only guarantee available. Best-effort by design — a write must not fail
 * because a terminal that may not even exist could not be reaped.
 *
 * Three steps, in this order. Release the terminal; refuse to continue if one
 * still holds the file (cutover-04 — the gate was written for this and then
 * never called); and re-read the file when a terminal has written it, because
 * killing the other writer says nothing about what it wrote. Skipping that last
 * step is what session-01 turned into a permanently unopenable session: the
 * worker kept the sequence it read before the terminal appended and wrote its
 * next row with a number the file could no longer justify.
 *
 * Every GUI path that appends to the JSONL calls this — send, compact, rewind.
 */
async function handOverFromTui(
  sessionId: string,
  ownerWebContentsId: number | undefined
): Promise<void> {
  let sessionFile: string | undefined;
  try {
    sessionFile = (await sessionIndexService.get(sessionId))?.runtimeIdentity;
  } catch (error) {
    console.warn('[chat] Failed to read the session row before a GUI write:', error);
    return;
  }
  if (!sessionFile) return;
  const { assertHostPromptAllowed, releaseSessionForHostPrompt } = await import('./piTui');
  let terminalWrote = false;
  try {
    terminalWrote = await releaseSessionForHostPrompt(sessionFile);
  } catch (error) {
    console.warn('[chat] Failed to release Pi TUI ownership before a GUI write:', error);
  }
  assertHostPromptAllowed(sessionFile);
  if (terminalWrote) await reloadSessionFromDisk(sessionId, ownerWebContentsId);
}

/**
 * Bring a live worker's in-memory session back in line with its file on disk.
 *
 * Only reachable when the Pi TUI has been driving the same JSONL: pi's
 * SessionManager caches the file at open, so the worker would otherwise keep
 * the pre-handover leaf and branch the next turn off it, leaving everything the
 * terminal wrote on an abandoned path.
 *
 * With no live worker there is nothing to correct — a later spawn reads the
 * file anyway — so this reports `false` rather than forcing one into existence.
 */
async function reloadSessionFromDisk(
  sessionId: string,
  ownerWebContentsId: number | undefined
): Promise<boolean> {
  const row = await sessionIndexService.get(sessionId);
  if (!row?.runtimeIdentity) return false;
  if (resolveAgentWireName(row.agent) !== PI_AGENT) return false;
  const { reloaded } = await workerManager.reloadSession({
    sessionId,
    sessionFile: row.runtimeIdentity,
    ...(ownerWebContentsId !== undefined ? { ownerWebContentsId } : {}),
  });
  return reloaded;
}

/**
 * U12 fix — validate a renderer-supplied spawn tier, or drop it.
 *
 * Dropped rather than rejected: the tier comes from a per-session preference
 * in the renderer's own storage, and a corrupted entry there must not make the
 * session impossible to start. Dropping is also the safe direction — the
 * worker then comes up on the default tier, which asks about everything, so a
 * bad value can never widen anything.
 */
function spawnPermissions(permissions: unknown): { permissions?: RuntimePermissionSettings } {
  if (permissions === undefined) return {};
  if (!isRuntimePermissionSettings(permissions))
    throw new Error('Invalid runtime permission settings');
  return { permissions };
}

function spawnTier(tier: unknown): { tier?: SessionPermissionTier } {
  if (tier === undefined) return {};
  if (!isSessionPermissionTier(tier)) {
    console.warn('[chat] Ignoring an invalid spawn permission tier:', tier);
    return {};
  }
  return { tier };
}

/**
 * concurrency-02 — validate the renderer's "open it anyway" request, or drop it.
 *
 * Literal `true` and nothing else. Every other value — `'yes'`, `1`, `false`,
 * an object — yields `{}`, so the resume proceeds on the default open that
 * REFUSES a held session. Dropping is the safe direction here in a way it is
 * not for a tier: the worst a dropped takeover costs is a refusal the user can
 * repeat, where an accidental one displaces a writer that may be alive.
 */
function spawnForceTakeover(value: unknown): { forceTakeover?: true } {
  return value === true ? { forceTakeover: true } : {};
}

/**
 * Carry a `WorkerManagerError`'s `code` across the IPC boundary.
 *
 * Electron serializes only `error.message` for an `invoke` rejection, so the
 * `code` field — the thing the renderer branches on — was dropped on the way
 * out. Nothing in Main emits a `host.error` runtime event either, so a send
 * refused by the WorkerManager reached the composer as opaque prose: its
 * `session_not_found` recovery and its bounded `session_busy` retry could
 * never fire, and the user ate one raw "Error invoking remote method" toast
 * per evicted session.
 *
 * Re-thrown in the `<code>: <message>` shape this file already uses for its
 * own `pi_session_*` errors, so both sides read the same convention.
 */
function withWorkerErrorCode(error: unknown): unknown {
  return error instanceof WorkerManagerError ? new Error(`${error.code}: ${error.message}`) : error;
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
        /** U12 fix — tier the worker must start on; validated below. */
        tier?: SessionPermissionTier;
        permissions?: RuntimePermissionSettings;
      }
    ): Promise<{ requestId: string }> => {
      // D47 S5 §3 — agent-session-only spawn gate. `attach`/resume-of-an-
      // existing-connection and plain terminal sessions are never gated
      // (SessionManager.create's own kind==='agent' check is the sibling
      // enforcement point for the PTY-agent path).
      assertAgentSpawnAllowed();
      const indexedBefore = await assertPiCompatibleIndexRow(payload.sessionId);
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      // U05-c: Main decides the posture from the path it allocated itself —
      // the renderer never gets to declare a session trusted or untrusted.
      // U13 records the same derived fact so the sidebar can still find this
      // chat after a restart, when nothing else knows the path is scratch.
      const unbound = scratchWorkspaceService.isScratchPath(payload.workspacePath);
      if (unbound) await scratchWorkspaceService.adopt(payload.sessionId, payload.workspacePath);
      // A temp workspace the user deleted by hand is app-created content, so
      // put it back at its recorded path instead of letting the spawn fail on a
      // missing cwd. No-op for every other workspace kind.
      else await adoptTempWorkspace(payload.workspacePath);
      await sessionIndexService.recordCreated({
        sessionId: payload.sessionId,
        workspacePath: payload.workspacePath,
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.effort ? { effort: payload.effort } : {}),
        agent: PI_AGENT,
        unbound,
      });
      try {
        const requestId = await workerManager.createSession({
          sessionId: payload.sessionId,
          workspacePath: payload.workspacePath,
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.effort ? { effort: payload.effort } : {}),
          ...spawnTier(payload.tier),
          ...spawnPermissions(payload.permissions),
          ownerWebContentsId,
          ...(unbound ? { unbound: true } : {}),
        });
        return { requestId };
      } catch (error) {
        // D15 (DEV-4): the row above is written BEFORE the spawn, because the
        // worker's own identity commit (`commitIdentityIfMaterialized` ->
        // `bindRuntimeIdentity`) refuses a session with no row, and the index's
        // runtime-event branches drop events for one. So the row cannot be
        // deferred — it has to be taken back when the spawn fails, or a worker
        // that never bootstrapped (a protocol mismatch, in the field run)
        // leaves a `title: ''` shell that comes back as "Session xxxxxx" in the
        // sidebar on the next start.
        //
        // Only when this call is the one that created it: a row that was
        // already there is somebody else's truth (a resumable session, a fork,
        // an archived row), and a failed spawn is no reason to delete it. The
        // service applies its own shape guard on top.
        if (!indexedBefore) {
          await sessionIndexService
            .removeUncommittedCreated(payload.sessionId, payload.workspacePath)
            .catch((cleanupError) => {
              // Never mask the spawn failure the user is waiting on.
              console.warn(
                '[chat] Failed to drop the index row of a failed session create:',
                cleanupError
              );
            });
        }
        throw error;
      }
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
      // U13: after a restart this process has no allocation for the session,
      // but its index row still names last run's directory. Allocating a fresh
      // uuid here would silently give the chat a SECOND cwd and rewrite the
      // indexed path, which resume then rejects as a workspace mismatch — so
      // re-take the recorded one instead (recreated empty; `adopt` refuses any
      // path outside the scratch root).
      if (!scratchWorkspaceService.pathFor(payload.sessionId)) {
        const row = await sessionIndexService.get(payload.sessionId);
        if (row?.workspacePath && scratchWorkspaceService.isScratchPath(row.workspacePath)) {
          return {
            path: await scratchWorkspaceService.adopt(payload.sessionId, row.workspacePath),
          };
        }
      }
      // Falling through is also the answer for a recorded path the scratch
      // service no longer owns — the temp base moved between runs (T040, after
      // main-aux-03). `adopt` refuses a foreign path by design, so the chat
      // gets a fresh directory under the CURRENT root; the resume handler above
      // re-homes the index row to match, and the chat stays unbound either way.
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
        await sessionIndexService.recordCreated({
          ...payload,
          agent: PI_AGENT,
          // Normally false here: this runs when the chat row is created, before
          // any scratch directory exists. Derived anyway so the two entry
          // points never disagree about what a path means.
          unbound: scratchWorkspaceService.isScratchPath(payload.workspacePath),
        });
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
        /** U12 fix — tier the worker must start on; validated below. */
        tier?: SessionPermissionTier;
        permissions?: RuntimePermissionSettings;
        /**
         * concurrency-02 — the user answered the "held by another writer"
         * refusal with "open it anyway". Validated below; only literal `true`
         * survives.
         */
        forceTakeover?: boolean;
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
      let workspacePath = payload.workspacePath;
      let unbound = scratchWorkspaceService.isScratchPath(workspacePath);
      if (unbound) {
        await scratchWorkspaceService.adopt(payload.sessionId, workspacePath);
      } else if (row.unbound) {
        // T040, after main-aux-03: the scratch service only recognises roots
        // THIS run resolved from the setting, so a user who changed the temp
        // path and restarted comes back with a row whose cwd is under the old
        // root — not recognised as scratch, and wiped from disk besides.
        // Re-home the chat under the CURRENT root instead of falling through:
        // the branch below would treat a leftover directory as a project the
        // user picked (trusted), or fail outright on a cwd that is gone.
        // `commitResumed` writes the new path back into the row, and `unbound`
        // stays on it because the row is rebuilt from `existing`.
        workspacePath = await scratchWorkspaceService.ensure(payload.sessionId);
        unbound = true;
      } else {
        // Same reason as the unbound branch above, for the other directory kind
        // this app creates and the user can delete underneath a live row.
        await adoptTempWorkspace(workspacePath);
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
        // concurrency-02: no `forceTakeover` here. This branch creates a brand
        // new session file, which no other writer can be holding.
        const repaired = await workerManager.createSession({
          sessionId: payload.sessionId,
          workspacePath,
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.effort ? { effort: payload.effort } : {}),
          ...spawnTier(payload.tier),
          ...spawnPermissions(payload.permissions),
          ownerWebContentsId,
          ...(unbound ? { unbound: true } : {}),
        });
        return { requestId: repaired };
      }
      const requestId = await workerManager.resumeSession({
        sessionId: payload.sessionId,
        sessionFile: payload.runtimeIdentity,
        workspacePath,
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.effort ? { effort: payload.effort } : {}),
        ...spawnTier(payload.tier),
        ...spawnPermissions(payload.permissions),
        ...spawnForceTakeover(payload.forceTakeover),
        ownerWebContentsId,
        ...(unbound ? { unbound: true } : {}),
      });
      return { requestId };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_RELOAD_SESSION,
    async (e, payload: { sessionId: string }): Promise<{ reloaded: boolean }> => {
      // Main resolves the session file from the index rather than taking one
      // from the renderer: the renderer-side resume path gates on a non-empty
      // workspace path, which an unbound (scratch) chat does not have, and that
      // chat needs the reload just as much as a bound one.
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      const reloaded = await reloadSessionFromDisk(payload.sessionId, ownerWebContentsId);
      return { reloaded };
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
      // Q17 — a warm Pi terminal on this session must stop, and whatever it
      // wrote must be read back, before the worker writes the same JSONL.
      // Terminals on other sessions are untouched.
      await handOverFromTui(payload.sessionId, ownerWebContentsId);
      try {
        const requestId = await workerManager.send({ ...payload, ownerWebContentsId });
        return { requestId };
      } catch (error) {
        throw withWorkerErrorCode(error);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_RETRY_LAST_TURN,
    async (
      e,
      payload: {
        sessionId: string;
        attemptId: string;
        effort?: SessionEffortLevel;
        model?: string;
      }
    ): Promise<{ requestId: string }> => {
      // Same preamble as CHAT_SEND: a retry is a turn, and the turn it re-runs
      // must be read from the file as a terminal on this session left it.
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      await handOverFromTui(payload.sessionId, ownerWebContentsId);
      try {
        const requestId = await workerManager.retryLastTurn({
          sessionId: payload.sessionId,
          attemptId: payload.attemptId,
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.effort ? { effort: payload.effort } : {}),
          ownerWebContentsId,
        });
        return { requestId };
      } catch (error) {
        throw withWorkerErrorCode(error);
      }
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
    IPC_CHANNELS.CHAT_INTERJECT,
    async (e, payload: { sessionId: string }): Promise<{ interjected: boolean }> => {
      // Same claim CHAT_STOP makes above. It is NOT an ownership check — any
      // window may interject any session id it names. It routes this
      // session's events (approval cards included) to the window that sent
      // the signal, so the turn it is about to end, and the queued message
      // that follows, report back to the window the user is looking at.
      claimSessionForSender(e, payload.sessionId);
      const interjected = await workerManager.interject(payload.sessionId);
      return { interjected };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_CLOSE_SESSION,
    async (_e, payload: { sessionId: string }): Promise<{ requestId: string }> => {
      workerManager.releaseSession(payload.sessionId);
      const requestId = await workerManager.closeSession(payload.sessionId);
      return { requestId };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_RESPOND_PERMISSION,
    async (
      _e,
      payload: { sessionId: string; permissionId: string; decision: PermissionDecisionId }
    ): Promise<{ handled: boolean }> => ({
      handled: await workerManager.respondPermission(payload),
    })
  );

  // F5. No `claimSessionForSender`, same as the permission answer above: a
  // question is parked inside one live turn and the worker is the authority on
  // whether its id is still waiting. Claiming here would make a second window
  // watching the same session unable to answer a card it can see.
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
    ): Promise<{ handled: boolean }> => ({
      handled: await workerManager.respondQuestion(payload),
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SET_PERMISSIONS,
    async (
      e,
      payload: { sessionId: string; permissions: RuntimePermissionSettings }
    ): Promise<{ requestId: string }> => {
      if (!isRuntimePermissionSettings(payload.permissions))
        throw new Error('Invalid runtime permission settings');
      claimSessionForSender(e, payload.sessionId);
      return {
        requestId: await workerManager.setPermissions(payload.sessionId, payload.permissions),
      };
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

  /**
   * T026 — what one session's own runtime brought up (MCP servers, skills,
   * sub-agents). Replaces the pi extension list, which has had no producer
   * since P6-5.
   *
   * Read-only and worker-free: it answers from the bootstrap result Main
   * already cached, so opening the panel cannot start a worker, cannot queue
   * behind a running turn, and returns `null` (not an empty inventory) when
   * nothing has reported for this session.
   */
  ipcMain.handle(
    IPC_CHANNELS.CHAT_LIST_SESSION_CAPABILITIES,
    async (_e, payload: { sessionId: string }): Promise<WorkerCapabilityInventory | null> => {
      return workerManager.getSessionCapabilities(payload.sessionId);
    }
  );

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
      //
      // The worker has to be gone BEFORE its cwd is removed — the app-exit
      // cleanup states that constraint in `ipc/workerManager.ts` and obeys it,
      // while this path used to delete the directory and leave the teardown to
      // a fire-and-forget `chat:closeSession` the renderer sends afterwards. A
      // turn still running then wrote into a directory that no longer existed
      // (POSIX) or kept the removal from succeeding at all (Windows, where the
      // failure is swallowed as best-effort cleanup). main-aux-02.
      if (result && payload.archived && scratchWorkspaceService.pathFor(payload.sessionId)) {
        // T066 (D14): the three steps this branch runs — archive, retire the
        // worker, delete the cwd — left no trace at all, so a directory that
        // was removed and a directory that was never reached looked identical
        // afterwards. One line per step; the removal itself reports from
        // `ScratchWorkspaceService.release`, which is the only place that knows
        // whether a directory was actually deleted or still shared.
        console.log(
          `[chat] Archiving temp session ${payload.sessionId}: retiring its worker before releasing its scratch directory.`
        );
        let workerRetired = true;
        try {
          await workerManager.closeSession(payload.sessionId);
          console.log(`[chat] Worker retired for archived session ${payload.sessionId}.`);
        } catch (error) {
          // Leave the directory to the app-exit and startup wipes instead:
          // removing it under a worker we could not confirm gone is the very
          // defect this ordering exists to prevent.
          workerRetired = false;
          console.warn(
            '[chat] Worker close failed while archiving; leaving its scratch directory for the exit/startup wipe instead:',
            error
          );
        }
        if (workerRetired) await scratchWorkspaceService.release(payload.sessionId);
      }
      return result;
    }
  );

  /**
   * R02-b — the composer's command menu.
   *
   * No `requireIndexedPiSession` and no `claimSessionForSender`, unlike every
   * neighbour here. This is a read that happens while the user types, including
   * on the start screen where no session exists yet, and it does not act on a
   * session — so gating it on one would turn the ordinary case into an error
   * the renderer has to translate back into "no commands".
   */
  ipcMain.handle(
    IPC_CHANNELS.CHAT_GET_SLASH_COMMANDS,
    async (
      _e,
      payload: { sessionId?: string } = {}
    ): Promise<Awaited<ReturnType<typeof workerManager.getSlashCommands>>> =>
      workerManager.getSlashCommands({
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      })
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_COMPACT_SESSION,
    async (
      e,
      payload: { sessionId: string; instructions?: string }
    ): Promise<Awaited<ReturnType<typeof workerManager.compactSession>>> => {
      await requireIndexedPiSession(payload.sessionId);
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      // session-01 — compaction appends to the JSONL just as a turn does, so it
      // needs the same handover. Without it a compaction written on top of what
      // a terminal appended is the write that makes the file unopenable.
      await handOverFromTui(payload.sessionId, ownerWebContentsId);
      return workerManager.compactSession({
        sessionId: payload.sessionId,
        ...(payload.instructions ? { instructions: payload.instructions } : {}),
        ownerWebContentsId,
      });
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
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      // session-01 — a rewind moves the branch by appending a lane row, which is
      // a write to the shared file and needs the same handover as a send.
      await handOverFromTui(payload.sessionId, ownerWebContentsId);
      return workerManager.rewindSession({
        sessionId: payload.sessionId,
        entryId: payload.entryId,
        confirmed: true,
        ownerWebContentsId,
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

  ipcMain.handle(
    IPC_CHANNELS.CHAT_READ_SESSION_PAGE,
    async (
      _e,
      payload: { sessionId: string; offset?: number; limit?: number }
    ): Promise<{ requestId: string }> => {
      const row = await requireIndexedPiSession(payload.sessionId);
      // A live worker owns the writer lock and holds the authoritative branch
      // in memory, so its file may legitimately lag. Refuse rather than answer
      // from a stale read; `worker_active` tells the renderer to ask the
      // worker instead. Every slot counts, whatever state it is in — a
      // starting or restarting worker owns the file just as much as a ready
      // one.
      if (
        workerManager.getSlotSnapshots().some((slot) => slot.logicalSessionId === payload.sessionId)
      ) {
        throw new Error(
          `worker_active: Session ${payload.sessionId} has a live worker; read its history from there`
        );
      }
      // No `claimSessionForSender` on purpose: claiming marks a worker slot as
      // foreground, and this path has no slot to mark. Reading history must
      // never be the reason a session is treated as held by a window.
      const page = await readSessionReplayPage({
        sessionFile: row.runtimeIdentity,
        ...(payload.offset !== undefined ? { offset: payload.offset } : {}),
        ...(payload.limit !== undefined ? { limit: payload.limit } : {}),
        ...(row.workspacePath ? { workspacePath: row.workspacePath } : {}),
      });
      const seq = nextReplaySequence();
      const requestId = `replay-${payload.sessionId}-${seq}`;
      broadcastRuntimeEvent({
        type: 'session.history',
        sessionId: payload.sessionId,
        requestId,
        seq,
        timestamp: Date.now(),
        payload: {
          runtimeIdentity: row.runtimeIdentity,
          workspacePath: row.workspacePath,
          agent: PI_AGENT,
          // `branch`, not `initial`: `initial` and `refresh` are the resume
          // modes, and the store rejects both unless a matching
          // `session.resumed` snapshot was taken first — which a preview must
          // never publish. `branch` means "the file is the authority now", and
          // that is precisely what this page is. `older` pages page.
          mode: payload.offset ? 'older' : 'branch',
          ...page,
          truncated: page.hasMore,
          omittedCount: Math.max(0, page.totalCount - page.offset - page.messages.length),
        },
      });
      return { requestId };
    }
  );
}
