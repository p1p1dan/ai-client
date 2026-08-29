/**
 * Chat / Runtime IPC — Renderer ↔ Main ↔ Agent Host.
 * Forwards Host Runtime Events to all BrowserWindows.
 */

import { resolve } from 'node:path';
import { isModelAllowedForAgent } from '@shared/models/familyWhitelist';
import { IPC_CHANNELS } from '@shared/types';
import type { AgentHostDriver, SessionEffortLevel } from '@shared/types/agentHost';
import {
  type AgentWireName,
  CLAUDE_CODE_AGENT,
  CODEX_AGENT,
  resolveAgentWireName,
} from '@shared/types/agentWire';
import type {
  ExtensionUiResponse,
  PermissionDecisionId,
  PermissionUpdateEffective,
  RuntimeEvent,
  SessionPermissionPreference,
} from '@shared/types/runtimeEvents';
import {
  permissionChangeNeedsConfirmation,
  readSessionPermissionPreference,
} from '@shared/types/runtimeEvents';
import type { HistorySessionSummary } from '@shared/types/sessionHistory';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { BrowserWindow, ipcMain } from 'electron';
import { agentHostManager } from '../services/agent-host/AgentHostManager';
import { ensureWorkspaceTrusted, getEffectiveClaudeJsonPath } from '../services/auth/claudeHome';
import { resolveManagedCredentialsEnabled } from '../services/auth/credentialMode';
import { assertAgentSpawnAllowed } from '../services/auth/spawnGate';
import { sessionIndexService } from '../services/chat/SessionIndexService';
import { isRemoteVirtualPath } from '../services/remote/RemotePath';

/**
 * Trust call matrix entries ①②: `CHAT_CREATE_SESSION` and
 * `CHAT_RESUME_SESSION` await this BEFORE `recordCreated`/`createSession`
 * (or the resume equivalents). Flag off, or a remote virtual path (I8), is a
 * no-op.
 *
 * D60 changed WHICH `.claude.json` this marks: the managed home's is gone, so
 * it is now the user's own. That is a merge of one `projects[<path>]` entry
 * into their file — the same entry Claude Code writes itself when a user
 * accepts its trust dialog — not a rewrite of anything they own.
 */
async function ensureWorkspaceTrustedForChat(workspacePath: string | undefined): Promise<void> {
  if (!resolveManagedCredentialsEnabled()) return;
  if (!workspacePath || isRemoteVirtualPath(workspacePath)) return;
  await ensureWorkspaceTrusted(getEffectiveClaudeJsonPath(), resolve(workspacePath));
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
 * D48 S3 §5.5 — Main is the session snapshot's keeper, so it is also the one
 * place that decides which posture a create/resume actually carries.
 *
 * Three rules, in this order:
 *
 *  1. A row that already holds a posture WINS over anything the renderer sends.
 *     `chat:createSession` runs again every time the Host registry entry was
 *     dropped (restart, crash, unbind), and by then the global template may say
 *     something else — re-capturing it would let a Settings edit retune an
 *     existing chat through the back door, which is precisely what §5.5-2 says
 *     resume must never do. Resume passes no candidate at all for the same
 *     reason: it REPLAYS, it does not re-derive.
 *  2. Otherwise the renderer's template is taken, but only after being
 *     validated: it arrives as raw IPC JSON, and the value decides what a
 *     session may do unattended.
 *
 *     "Otherwise" covers a case worth naming, because the §5.4 copy ("existing
 *     sessions keep the posture captured when they were first sent") does not
 *     describe it: a row that EXISTS but never captured a posture. There are
 *     two ways to get one — a chat that predates D48, and a first send that
 *     happened before the settings store had hydrated (C15) — and both of them
 *     take today's template on the next `chat:createSession`. That is
 *     deliberate rather than overlooked, and the alternative was measured: the
 *     only in-band signal that would separate "old row" from "brand-new row" is
 *     the row's own existence, and `chat:registerSession` (R5 D2) writes a row
 *     for every chat the moment it appears in the sidebar — long before its
 *     first send. Refusing the candidate whenever a row exists would therefore
 *     refuse it for EVERY session, i.e. delete the S3 write side. The residual
 *     exposure is bounded to postureless rows and is pinned by the timing
 *     assertion in `chatPermissionPreferenceGuard.test.ts` (§5.5-5): once a row
 *     has a posture, no template can move it.
 *  3. A posture addressed to a DIFFERENT agent than the session is refused
 *     outright, before `recordCreated` — a row claiming a posture the session
 *     could never have run is the same class of lie B18 refuses for `model`.
 *     The Host refuses it a second time at dispatch (§5.7-C10); this one is
 *     what keeps the refusal ahead of the persisted row.
 *
 * Thrown as `code: message`, same as `assertModelMatchesAgent` — only
 * `.message` survives `ipcRenderer.invoke`.
 */
async function resolveSessionPermissionPreference(input: {
  sessionId: string;
  agent: AgentWireName | null;
  candidate?: unknown;
}): Promise<SessionPermissionPreference | undefined> {
  const entry = await sessionIndexService.get(input.sessionId);
  const captured = entry?.permissionPreference;
  if (captured) {
    // Re-validated even though we wrote it: this came back off disk.
    const parsed = readSessionPermissionPreference(captured, PREFERENCE_AGENTS);
    if (parsed && (input.agent === null || parsed.agent === input.agent)) return parsed;
    // A snapshot that no longer matches its own row (hand-edited file, a build
    // that changed a binding) degrades to the runtime constant rather than to
    // the current template — "we do not know" must not become "use today's".
    return undefined;
  }
  if (input.candidate === undefined || input.candidate === null) return undefined;
  const parsed = readSessionPermissionPreference(input.candidate, PREFERENCE_AGENTS);
  if (!parsed) {
    throw new Error(
      'invalid_permission_preference: the requested permission posture is not a shape this build ' +
        'accepts (networkAccess is reported by the runtime and is never a request field)'
    );
  }
  if (input.agent !== null && parsed.agent !== input.agent) {
    throw new Error(
      `permission_agent_mismatch: a ${parsed.agent} permission posture cannot be applied to a ` +
        `${input.agent} session — a session's posture and its agent are one decision`
    );
  }
  return parsed;
}

const PREFERENCE_AGENTS = { claudeCode: CLAUDE_CODE_AGENT, codex: CODEX_AGENT } as const;

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
      const requestedAgent = resolveAgentWireName(payload.agent);
      // B18 — before `recordCreated`, so a refused create leaves no index row
      // claiming a model the session could never have run.
      assertModelMatchesAgent(requestedAgent, payload.model);
      // Same "before the row exists" rule, for the posture (C10).
      const permissionPreference = await resolveSessionPermissionPreference({
        sessionId: payload.sessionId,
        agent: requestedAgent,
        candidate: payload.permissionPreference,
      });
      await ensureWorkspaceTrustedForChat(payload.workspacePath);
      // One resolved value into BOTH the snapshot and the wire: the row and the
      // running session cannot disagree about what was asked for.
      const resolved = { ...payload, permissionPreference };
      await sessionIndexService.recordCreated(resolved);
      const requestId = await agentHostManager.createSession(resolved);
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
      // D48 S3 §5.5-2 / C9 — the posture comes off the SESSION SNAPSHOT and
      // from nowhere else. No candidate is passed, so there is no code path by
      // which a resume could pick up a template edited after this chat started:
      // the renderer is not even given the chance to send one.
      const permissionPreference = await resolveSessionPermissionPreference({
        sessionId: payload.sessionId,
        agent: resolveAgentWireName(payload.agent),
      });
      await ensureWorkspaceTrustedForChat(payload.workspacePath);
      await sessionIndexService.recordResumed(payload);
      const requestId = await agentHostManager.resumeSession({
        ...payload,
        permissionPreference,
      });
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
      const agent = await resolveSessionAgentForDispatch(payload.sessionId);
      if (agent === null) {
        // Unlike `chat:send`'s guard, an unresolvable binding is fatal here.
        // Send can stand down and let the Host route the message; this command
        // would have to pick which half of the preference union to validate,
        // and picking wrong means validating nothing.
        throw new Error(
          `session_binding_unknown: no indexed agent for session ${payload.sessionId} — a ` +
            'permission change needs to know which runtime it is addressed to'
        );
      }
      const parsed = readSessionPermissionPreference(
        payload.permissionPreference,
        PREFERENCE_AGENTS
      );
      if (!parsed) {
        throw new Error(
          'invalid_permission_preference: the requested permission posture is not a shape this ' +
            'build accepts (networkAccess is reported by the runtime and is never a request field)'
        );
      }
      if (parsed.agent !== agent) {
        throw new Error(
          `permission_agent_mismatch: a ${parsed.agent} permission posture cannot be applied to a ` +
            `${agent} session — a session's posture and its agent are one decision`
        );
      }
      if (permissionChangeNeedsConfirmation(parsed, payload.dangerousConfirmed)) {
        throw new Error(
          'dangerous_tier_unconfirmed: this tier removes a safety boundary and was not confirmed ' +
            '— it is never applied on the strength of the request alone'
        );
      }
      const event = await agentHostManager.updateSessionPermission({
        sessionId: payload.sessionId,
        permissionPreference: parsed,
        ...(payload.dangerousConfirmed === true ? { dangerousConfirmed: true } : {}),
      });
      // Confirmed. The snapshot is the value every later resume replays, so it
      // is written from the event's own echo rather than from what we sent —
      // one truth, and it is the runtime's.
      await sessionIndexService.setPermissionPreference(
        payload.sessionId,
        event.payload.preference
      );
      return {
        requestId: event.requestId ?? '',
        preference: event.payload.preference,
        effective: event.payload.effective,
      };
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
    async (_e, payload: ExtensionUiResponse): Promise<{ requestId: string }> => {
      const requestId = await agentHostManager.respondExtensionUi(payload);
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
