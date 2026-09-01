/**
 * Chat / Runtime IPC — Renderer ↔ Main ↔ Agent Host.
 * Forwards Host Runtime Events to all BrowserWindows.
 */

import { isModelAllowedForAgent } from '@shared/models/familyWhitelist';
import { IPC_CHANNELS } from '@shared/types';
import type { AgentHostDriver, SessionEffortLevel } from '@shared/types/agentHost';
import { type AgentWireName, PI_AGENT, resolveAgentWireName } from '@shared/types/agentWire';
import type {
  ExtensionUiResponse,
  PermissionDecisionId,
  PermissionUpdateEffective,
  RuntimeEvent,
  SessionPermissionPreference,
} from '@shared/types/runtimeEvents';
import type { HistorySessionSummary } from '@shared/types/sessionHistory';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron';
import { workerManager } from '../services/agent-host/WorkerManager';
import { assertAgentSpawnAllowed } from '../services/auth/spawnGate';
import { ExtensionUiRouter } from '../services/chat/extensionUiRouting';
import { sessionIndexService } from '../services/chat/SessionIndexService';

/**
 * D48 §4.3/§4.6-1 (B18) — the cross-agent model guard, and the reason it lives
 * in Main rather than in the Agent Host.
 *
 * The Host child process holds neither a model catalog nor a gateway URL
 * [实测 `hostEnv.ts`: all eight injected keys enumerated, none of them a base
 * URL], so a check written there could only ever compare a string against
 * nothing — a guard that always passes, which is worse than no guard because it
 * reads like one. Main is the last place with enough context, so the refusal
 * happens BEFORE WorkerManager dispatches a turn to any slot.
 *
 * ## Why ownership and not catalog membership
 *
 * §4.4-6 requires a stored selection the family whitelist filtered out
 * (`gpt-5.5`, `claude-opus-4-6`) to keep working on the session that chose it. A
 * membership test would reject exactly those and reset the user to `Automatic` —
 * the silent model swap R11 exists to prevent, arriving through a different
 * door. So the guard refuses only what it can PROVE belongs to the other runtime
 * (`resolveModelAgentOwner`), and lets everything it cannot classify through.
 *
 * Thrown as `code: message` for the same reason `assertAgentSpawnAllowed` does:
 * only `.message` survives `ipcRenderer.invoke`.
 */
function assertModelMatchesAgent(agent: AgentWireName | null, model: unknown): void {
  if (agent === null) return;
  if (typeof model !== 'string' || model.trim().length === 0) return;
  if (isModelAllowedForAgent(agent, model.trim())) return;
  throw new Error(
    `model_agent_mismatch: model "${model.trim()}" belongs to another agent and cannot run on ` +
      `${agent} — pick a model from this agent's catalog`
  );
}

/**
 * Which runtime a `chat:send` is going to reach.
 *
 * `null` (not "assume Claude Code") when the row is missing or carries a slug
 * this build does not know: guessing would let the guard refuse a model that is
 * perfectly valid for the agent it is actually going to. An unresolvable binding
 * is a reason to stand down, not a reason to invent one.
 */
async function resolveSessionAgentForDispatch(sessionId: string): Promise<AgentWireName | null> {
  const entry = await sessionIndexService.get(sessionId);
  if (!entry) return null;
  return resolveAgentWireName(entry.agent);
}

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

  ipcMain.handle(IPC_CHANNELS.CHAT_ENSURE_HOST, async (_e, _driver?: AgentHostDriver) => {
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
        /** T-20 reasoning effort; Host drops unknown levels (normalizeEffort). */
        effort?: SessionEffortLevel;
        /**
         * S2 (b): which runtime the renderer asked for. Main only relays it —
         * it neither validates nor defaults it. The index row is authoritative
         * only once the Host echoes the running agent back on `session.created`
         * (see SessionIndexService.applyRuntimeEvent), which is why recording
         * the requested value here is safe even if the Host cannot honour it.
         */
        agent?: AgentWireName;
        /**
         * D48 S3 §5.5 — the "Chat agent defaults" template the renderer read at
         * the moment of this send. A CANDIDATE, not the decision: a session that
         * already captured a posture keeps it (see
         * `resolveSessionPermissionPreference`). Absent = the runtime constant,
         * which is every pre-D48 caller and every unhydrated first send (C15).
         */
        permissionPreference?: SessionPermissionPreference;
      }
    ): Promise<{ requestId: string }> => {
      // D47 S5 §3 — agent-session-only spawn gate. `attach`/resume-of-an-
      // existing-connection and plain terminal sessions are never gated
      // (SessionManager.create's own kind==='agent' check is the sibling
      // enforcement point for the PTY-agent path).
      assertAgentSpawnAllowed();
      // T29-c is Pi-only. The old agent field remains on the preload contract
      // until T31 removes the picker, but it no longer selects an execution
      // runtime or permission dialect.
      assertModelMatchesAgent(PI_AGENT, payload.model);
      // The window that created the chat owns it, for Extension UI routing.
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      // One resolved value into BOTH the snapshot and the wire: the row and the
      // running session cannot disagree about what was asked for.
      const resolved = { ...payload, agent: PI_AGENT, permissionPreference: undefined };
      await sessionIndexService.recordCreated(resolved);
      const requestId = await workerManager.createSession({ ...resolved, ownerWebContentsId });
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
        /**
         * S2 (b): the renderer's binding for a session that has never started
         * a Host — this is the only chance the index gets to learn it before
         * `mergeSessionIndex` would materialize the missing field as Claude
         * Code and make the change permanent. Relayed, not validated:
         * `recordCreated` keeps the persisted value when it is absent.
         */
        agent?: AgentWireName;
      }
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
      e,
      payload: {
        sessionId: string;
        runtimeIdentity: string;
        workspacePath: string;
        model?: string;
        /** T-20 reasoning effort; Host drops unknown levels (normalizeEffort). */
        effort?: SessionEffortLevel;
        /** S2 (b): which runtime resumes it; pairs with `runtimeIdentity`. */
        agent?: AgentWireName;
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
      // B18 — a send carries no binding of its own, so the row decides. This is
      // the load-bearing arm: a per-turn model override is the ONE payload that can carry
      // a model the session was never created with.
      assertModelMatchesAgent(
        await resolveSessionAgentForDispatch(payload.sessionId),
        payload.model
      );
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
   * D48 S4 §6.3 — change the posture of a session that is already running.
   *
   * Four things happen here and the ORDER is the design:
   *
   *  1. The session's binding comes off the INDEX ROW, never off the payload.
   *     A posture is agent-shaped (`permissionMode` vs `approvalPolicy` +
   *     `sandboxMode`), so letting the caller name the agent would let it pick
   *     which arm gets validated — the same reason `chat:send`'s model guard
   *     reads the row (B18).
   *  2. The tier is validated and matched against that binding, exactly as
   *     create/resume do (C10). Refused, never coerced.
   *  3. R18 — a dangerous tier without an explicit confirmation is refused HERE,
   *     before the Host is contacted at all. The renderer's dialog is a UX
   *     affordance; this is the boundary that makes "we never expand privilege
   *     silently" true for any caller, including one that bypassed the dialog.
   *  4. Only after the Host CONFIRMS (a correlated `session.permissionUpdated`;
   *     any failure rejects) is the session snapshot rewritten (D10). A failed
   *     change must leave the row byte-identical, or the next resume would
   *     replay a posture the session never ran under.
   *
   * What it deliberately does NOT do: touch the `ChatAgentDefaults` template
   * (D11). A one-off change to one chat must not become the default for every
   * chat created afterwards — that is the silent-privilege-expansion path R18
   * names, and this handler has no import that could reach app settings.
   */
  ipcMain.handle(
    IPC_CHANNELS.CHAT_UPDATE_PERMISSION,
    async (
      _e,
      payload: {
        sessionId: string;
        permissionPreference: SessionPermissionPreference;
        /** R18: the second confirmation for a dangerous tier actually happened. */
        dangerousConfirmed?: boolean;
      }
    ): Promise<{
      requestId: string;
      preference: SessionPermissionPreference;
      effective: PermissionUpdateEffective;
    }> => {
      void payload.permissionPreference;
      void payload.dangerousConfirmed;
      throw new Error(
        `pi_permission_update_not_implemented: session ${payload.sessionId} uses the Pi permission extension`
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_RESPOND_PERMISSION,
    async (
      _e,
      payload: {
        sessionId: string;
        permissionId: string;
        allow: boolean;
        /** S2 (c): the richer button, when the renderer had one. */
        decision?: PermissionDecisionId;
      }
    ): Promise<{ requestId: string }> => {
      void payload;
      throw new Error(
        'pi_permission_response_unsupported: Pi approvals use Extension UI responses'
      );
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
      void payload;
      throw new Error('pi_question_response_unsupported: Pi questions use Extension UI responses');
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
