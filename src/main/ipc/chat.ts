/**
 * Chat / Runtime IPC — Renderer ↔ Main ↔ Agent Host.
 * Forwards Host Runtime Events to all BrowserWindows.
 */

import { join, resolve } from 'node:path';
import { isModelAllowedForAgent } from '@shared/models/familyWhitelist';
import { IPC_CHANNELS } from '@shared/types';
import type { AgentHostDriver, SessionEffortLevel } from '@shared/types/agentHost';
import { type AgentWireName, resolveAgentWireName } from '@shared/types/agentWire';
import type { PermissionDecisionId, RuntimeEvent } from '@shared/types/runtimeEvents';
import type { HistorySessionSummary } from '@shared/types/sessionHistory';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { app, BrowserWindow, ipcMain } from 'electron';
import { agentHostManager } from '../services/agent-host/AgentHostManager';
import { resolveManagedCredentialsEnabled } from '../services/auth/AuthStateService';
import { ensureWorkspaceTrusted, getManagedClaudeHomeDir } from '../services/auth/claudeHome';
import { assertAgentSpawnAllowed } from '../services/auth/spawnGate';
import { sessionIndexService } from '../services/chat/SessionIndexService';
import { isRemoteVirtualPath } from '../services/remote/RemotePath';

/**
 * D47 S2a trust call matrix (spec §1) — entries ①②: `CHAT_CREATE_SESSION`
 * and `CHAT_RESUME_SESSION` await this BEFORE `recordCreated`/`createSession`
 * (or the resume equivalents). flag off, or a remote virtual path (I8), is a
 * no-op — trust marking only applies to the managed local `.claude.json`.
 */
async function ensureWorkspaceTrustedForChat(workspacePath: string | undefined): Promise<void> {
  if (!resolveManagedCredentialsEnabled()) return;
  if (!workspacePath || isRemoteVirtualPath(workspacePath)) return;
  const claudeHomeDir = getManagedClaudeHomeDir(app.getPath('userData'));
  const claudeJsonPath = join(claudeHomeDir, '.claude.json');
  await ensureWorkspaceTrusted(claudeJsonPath, resolve(workspacePath));
}

/**
 * D48 §4.3/§4.6-1 (B18) — the cross-agent model guard, and the reason it lives
 * in Main rather than in the Agent Host.
 *
 * The Host child process holds neither a model catalog nor a gateway URL
 * [实测 `hostEnv.ts`: all eight injected keys enumerated, none of them a base
 * URL], so a check written there could only ever compare a string against
 * nothing — a guard that always passes, which is worse than no guard because it
 * reads like one. Main is the last place with enough context, so the refusal
 * happens BEFORE `agentHostManager` is called and therefore before any
 * `turn/start` frame exists.
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
        /**
         * S2 (b): which runtime the renderer asked for. Main only relays it —
         * it neither validates nor defaults it. The index row is authoritative
         * only once the Host echoes the running agent back on `session.created`
         * (see SessionIndexService.applyRuntimeEvent), which is why recording
         * the requested value here is safe even if the Host cannot honour it.
         */
        agent?: AgentWireName;
      }
    ): Promise<{ requestId: string }> => {
      // D47 S5 §3 — agent-session-only spawn gate. `attach`/resume-of-an-
      // existing-connection and plain terminal sessions are never gated
      // (SessionManager.create's own kind==='agent' check is the sibling
      // enforcement point for the PTY-agent path).
      assertAgentSpawnAllowed();
      // B18 — before `recordCreated`, so a refused create leaves no index row
      // claiming a model the session could never have run.
      assertModelMatchesAgent(resolveAgentWireName(payload.agent), payload.model);
      await ensureWorkspaceTrustedForChat(payload.workspacePath);
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
      _e,
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
      // D47 S5 §3 — same gate as CHAT_CREATE_SESSION. Resuming a session that
      // already ran is still a fresh Agent Host spawn from Main's point of
      // view (a new `session.resume` command, possibly a new Host process) —
      // it is NOT the `attach` exemption (attach reconnects to an ALREADY
      // running in-process session, no new credentials touched).
      assertAgentSpawnAllowed();
      // B18 — the resume payload names the binding explicitly (it pairs with
      // `runtimeIdentity`), so the guard reads it rather than the index row.
      assertModelMatchesAgent(resolveAgentWireName(payload.agent), payload.model);
      await ensureWorkspaceTrustedForChat(payload.workspacePath);
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
      // B18 — a send carries no binding of its own, so the row decides. This is
      // the load-bearing arm: a per-turn model override is the ONE payload that can carry
      // a model the session was never created with.
      assertModelMatchesAgent(
        await resolveSessionAgentForDispatch(payload.sessionId),
        payload.model
      );
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
      payload: {
        sessionId: string;
        permissionId: string;
        allow: boolean;
        /** S2 (c): the richer button, when the renderer had one. */
        decision?: PermissionDecisionId;
      }
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
