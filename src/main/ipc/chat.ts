import {
  isRuntimePermissionSettings,
  type RuntimePermissionSettings,
} from '@shared/types/runtimePermission';

/**
 * Chat / Runtime IPC — Renderer ↔ Main ↔ Agent Host.
 * Forwards Host Runtime Events to all BrowserWindows.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_SDK_STUB_SUFFIX } from '@shared/claudeSdkEngine';
import { CONTROLLED_CHAT_CHANNELS } from '@shared/plugins/chatChannels';
import { IPC_CHANNELS } from '@shared/types';
import type { SessionEffortLevel } from '@shared/types/agentHost';
import {
  type AgentWireName,
  DSH_AGENT,
  PI_AGENT,
  resolveAgentWireName,
} from '@shared/types/agentWire';
import type { SentAttachmentReadRequest, SentAttachmentReadResult } from '@shared/types/ipc';
import {
  LEGACY_MIGRATION_REQUIRED,
  type LegacyMigrationSummary,
} from '@shared/types/legacyMigration';
import type { PermissionDecisionId, RuntimeEvent } from '@shared/types/runtimeEvents';
import type { SessionHistoryPage } from '@shared/types/sessionHistory';
import type { SessionIndexEntry, SessionIndexListEntry } from '@shared/types/sessionIndex';
import {
  isSessionPermissionTier,
  type SessionPermissionTier,
} from '@shared/types/sessionPermissionTier';
import {
  type ChatCompactSessionResult,
  WORKER_COMPACT_CANCELLED,
  type WorkerCapabilityInventory,
  type WorkerCommandsResult,
  type WorkerInterjectWithdrawResult,
  type WorkerStopScope,
} from '@shared/types/workerRpc';
import { app, BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron';
import {
  ClaudeSdkCommandCatalog,
  runClaudeSdkCatalogHost,
} from '../services/agent-host/claudeSdkCatalog';
import { CLAUDE_SDK_HOME_DIR_NAME } from '../services/agent-host/claudeSdkEngine';
import { currentDshSkillHomes, resolveDshHome } from '../services/agent-host/DshHostProcess';
import { dshHostSupervisor } from '../services/agent-host/DshHostSupervisor';
import { createDshHostPrewarm, prewarmDshHost } from '../services/agent-host/dshHostPrewarm';
import {
  composerSlashCommands,
  listDshSkillsFromDisk,
} from '../services/agent-host/dshSkillCatalog';
import { scratchWorkspaceService } from '../services/agent-host/ScratchWorkspaceService';
import { adoptTempWorkspace } from '../services/agent-host/TempWorkspaceService';
import {
  locateTranscript,
  type TranscriptLocation,
} from '../services/agent-host/transcriptLocation';
import { WorkerManagerError, workerManager } from '../services/agent-host/WorkerManager';
import { sameWorkerDirectory } from '../services/agent-host/workerSessionKey';
import { getAppStateRoot } from '../services/appStatePaths';
import { assertAgentSpawnAllowed } from '../services/auth/spawnGate';
import type { ChatCaller } from '../services/chat/chatCaller';
import { legacyMigrationService } from '../services/chat/LegacyMigrationService';
import { sessionIndexService } from '../services/chat/SessionIndexService';
import {
  readSessionReplayPage,
  SESSION_REPLAY_UNAVAILABLE,
} from '../services/chat/SessionReplayReader';
import { sessionControl } from '../services/chat/sessionControl';
import { usableWorkspace } from '../services/legacyAssets/detectLegacyAssets';
import { readSentImage } from './sentAttachmentRead';

/** Owners whose release-on-gone listener is already attached. */
const ownerCleanupAttached = new Set<number>();

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

/** The window behind an IPC call, as a chat caller. */
function callerForIpc(event: IpcMainInvokeEvent | undefined): ChatCaller {
  const sender = event?.sender;
  const ownerId = typeof sender?.id === 'number' ? sender.id : undefined;
  if (ownerId === undefined || typeof sender?.once !== 'function') return { ownerId };
  return {
    ownerId,
    onGone: (listener) => {
      sender.once('destroyed', listener);
    },
  };
}

function claimSessionForSender(
  caller: ChatCaller,
  sessionId: string | undefined
): number | undefined {
  // A call with no identifiable sender claims nothing rather than throwing:
  // routing is an optimisation over broadcast, and no handler may fail a
  // session create because it could not work out which window asked.
  const { ownerId } = caller;
  if (!sessionId || ownerId === undefined) return ownerId;
  workerManager.claimSession(sessionId, ownerId);
  if (!ownerCleanupAttached.has(ownerId) && caller.onGone) {
    ownerCleanupAttached.add(ownerId);
    caller.onGone(() => {
      ownerCleanupAttached.delete(ownerId);
      workerManager.releaseWindow(ownerId);
    });
  }
  return ownerId;
}

/**
 * Issue #25: every chat handler takes a `ChatCaller` instead of the IPC event
 * and is kept in this table as well as registered with `ipcMain`, so the
 * remote gateway runs the very same code for a caller that is not a window.
 */
type ChatHandler = (caller: ChatCaller, ...args: unknown[]) => unknown;
const chatHandlers = new Map<string, ChatHandler>();

/**
 * Plugin-system §4: a call that changes a conversation runs only for the
 * session's controller. Checked here, once, for windows and plugin clients
 * alike; every controlled call (`CONTROLLED_CHAT_CHANNELS`) names its
 * session as `payload.sessionId`.
 */
function assertSessionControl(caller: ChatCaller, payload: unknown): void {
  const sessionId = (payload as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof sessionId !== 'string') return;
  sessionControl.assertMayChange(sessionId, caller.ownerId);
}

function handle<TArgs extends unknown[], TResult>(
  channel: string,
  rawHandler: (caller: ChatCaller, ...args: TArgs) => TResult
): void {
  // A refused call rejects like any other failure, never throws synchronously.
  const handler = CONTROLLED_CHAT_CHANNELS.has(channel)
    ? async (caller: ChatCaller, ...args: TArgs): Promise<unknown> => {
        assertSessionControl(caller, args[0]);
        return rawHandler(caller, ...args);
      }
    : rawHandler;
  // The payload types are the renderer's promise; the gateway validates its own.
  chatHandlers.set(channel, handler as unknown as ChatHandler);
  ipcMain.handle(channel, (event, ...args) =>
    (handler as (caller: ChatCaller, ...args: TArgs) => unknown)(
      callerForIpc(event),
      ...(args as TArgs)
    )
  );
}

/** Run a registered chat handler for a caller that is not an IPC sender. */
export async function invokeChatHandler(
  channel: string,
  caller: ChatCaller,
  args: unknown[]
): Promise<unknown> {
  const handler = chatHandlers.get(channel);
  if (!handler) throw new Error(`chat_handler_unknown: No chat handler for ${channel}`);
  return handler(caller, ...args);
}

const runtimeEventListeners = new Set<(event: RuntimeEvent) => void>();

/**
 * Every runtime event the windows receive, in the same order — including the
 * replay pages this file emits itself, which never pass through the
 * WorkerManager. Returns the unsubscribe.
 */
export function onChatRuntimeEvent(listener: (event: RuntimeEvent) => void): () => void {
  runtimeEventListeners.add(listener);
  return () => {
    runtimeEventListeners.delete(listener);
  };
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
  for (const listener of runtimeEventListeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn('[chat] A runtime event listener threw:', error);
    }
  }
}

let eventBridgeAttached = false;

function ensureEventBridge(): void {
  if (eventBridgeAttached) return;
  eventBridgeAttached = true;
  workerManager.onEvent(broadcastRuntimeEvent);
  workerManager.onEvent((event) => sessionIndexService.handleRuntimeEvent(event));
  sessionControl.onChange((change) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(IPC_CHANNELS.CHAT_SESSION_CONTROL_CHANGED, change);
      } catch {
        // Window may be closing mid-send
      }
    }
  });
}

function agentMismatch(sessionId: string): Error {
  return new Error(
    `pi_session_agent_mismatch: Session ${sessionId} is not indexed as a chat engine this build runs`
  );
}

/**
 * dsh-rebase decision 050 (P1-9d) — a session the retired native engine wrote,
 * asked for by anything but a resume. It stays readable (the main-process
 * replay still decodes it), and its first resume migrates it to DSH; a fork,
 * a rewind, a compaction or the tree waits for that: the renderer resumes the
 * chat, then asks again. Decision 005's read-only refusal ends here.
 */
function legacyMigrationRequired(sessionId: string): Error {
  return new Error(
    `${LEGACY_MIGRATION_REQUIRED}: Session ${sessionId} was written by the previous chat engine; resume it first, which moves it to the current engine`
  );
}

/**
 * Refuse to create a session over a row this build may not run.
 *
 * An unknown binding is somebody else's session. A `pi` row that names a
 * transcript is a legacy session, continued by resuming it (which migrates it,
 * decision 050), never overwritten by a create; a `pi` row with no identity
 * never ran, so it simply becomes a DSH session.
 *
 * Hands back the row it read (D15), so a caller can tell "this row existed
 * before I touched it" from "I am the one who just wrote it" without a second
 * read — the difference between a shell this handler owns and somebody else's
 * persisted session.
 */
async function assertCreatableIndexRow(sessionId: string): Promise<SessionIndexEntry | undefined> {
  const row = await sessionIndexService.get(sessionId);
  if (!row) return row;
  const agent = resolveAgentWireName(row.agent);
  if (agent === null) throw agentMismatch(sessionId);
  if (agent === PI_AGENT && row.runtimeIdentity) throw legacyMigrationRequired(sessionId);
  return row;
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
 *
 * dsh-rebase decision 176: every handler whose call needs a running
 * conversation (`/compact`, the goal bar, the tree, a rewind or fork, the jobs
 * and subagents windows, an older history page) re-throws through this too.
 * The renderer starts a conversation that is not running the way a send does
 * when it reads `session_not_found`, and says the rest in words.
 */
function withWorkerErrorCode(error: unknown): unknown {
  return error instanceof WorkerManagerError ? new Error(`${error.code}: ${error.message}`) : error;
}

/** DA-4: the worker's answer to a `/compact` the user cut short (`WorkerSlotError.remoteCode`). */
function isCompactCancelledByUser(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { remoteCode?: unknown }).remoteCode === WORKER_COMPACT_CANCELLED
  );
}

/**
 * dsh-rebase decision 030 (P1-4a): a DSH session's preview page, read by the
 * shared host without opening the session — no worker slot, no lock, no
 * write; a host is started for it if none is up. Every failure (no host to
 * be had, a missing or foreign stub, a log that will not read) is the one
 * code the renderer answers by falling back to a resume.
 */
async function readDshReplayPage(
  sessionId: string,
  stubFile: string,
  range: { offset?: number; limit?: number }
): Promise<SessionHistoryPage> {
  try {
    return await dshHostSupervisor.readPage({
      stubFile,
      logicalSessionId: sessionId,
      ...(range.offset !== undefined ? { offset: range.offset } : {}),
      ...(range.limit !== undefined ? { limit: range.limit } : {}),
    });
  } catch (error) {
    throw new Error(
      `${SESSION_REPLAY_UNAVAILABLE}: Session ${sessionId} could not be read through the DSH host: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/** A row with a durable identity and a binding this build understands, live or legacy. */
async function requireIndexedSession(sessionId: string): Promise<{
  row: SessionIndexEntry & { runtimeIdentity: string };
  agent: AgentWireName;
}> {
  const row = await sessionIndexService.get(sessionId);
  if (!row?.runtimeIdentity) {
    throw new Error(`pi_session_not_found: No indexed session file for ${sessionId}`);
  }
  const agent = resolveAgentWireName(row.agent);
  if (agent === null) throw agentMismatch(sessionId);
  return { row: row as SessionIndexEntry & { runtimeIdentity: string }, agent };
}

/**
 * An indexed session a worker may act on: the live engine only. A legacy row
 * is migrated by its resume first (decision 050), so this asks for one.
 */
async function requireLiveSession(
  sessionId: string
): Promise<SessionIndexEntry & { runtimeIdentity: string }> {
  const { row, agent } = await requireIndexedSession(sessionId);
  if (agent !== DSH_AGENT) throw legacyMigrationRequired(sessionId);
  return row;
}

/**
 * The identity a resume request names is the row's, or — once the chat was
 * migrated (P1-9d) — the legacy file it was migrated from: a renderer that
 * listed the chat before its migration still holds that path, and the row it
 * resumes is the DSH one either way.
 */
function namesIndexedIdentity(
  row: SessionIndexEntry & { runtimeIdentity: string },
  agent: AgentWireName,
  requested: string
): boolean {
  return (
    row.runtimeIdentity === requested ||
    (agent === DSH_AGENT && row.migratedFrom?.runtimeIdentity === requested)
  );
}

/**
 * Decision 121: the posture a migrated chat's first resume comes up on when
 * the renderer names none — the last one its file recorded, as 1.0.x applied
 * `{...file, ...payload}`. Dropped when it is not a valid posture: the default
 * then asks about everything.
 */
function legacyPosture(
  migration: Omit<LegacyMigrationSummary, 'legacyPermissionsApplied'> | undefined,
  payload: { tier?: unknown; permissions?: unknown }
): RuntimePermissionSettings | undefined {
  if (!migration || payload.tier !== undefined || payload.permissions !== undefined)
    return undefined;
  return isRuntimePermissionSettings(migration.legacyPermissions)
    ? migration.legacyPermissions
    : undefined;
}

export function registerChatHandlers(): void {
  ensureEventBridge();

  // S-6 feedback 11c: the DSH host starts with the chat surface, not on the first send.
  // Once per app run: every send calls `chat:ensureHost` too (see `createDshHostPrewarm`).
  const dshPrewarmDeps = {
    assertSpawnAllowed: assertAgentSpawnAllowed,
    ensureHost: () => dshHostSupervisor.ensureHost(),
    log: (message: string, error?: unknown) => console.warn(`[chat] ${message}`, error),
  };
  const prewarmDshHostOnce = createDshHostPrewarm(dshPrewarmDeps);

  // S-6 feedback 11c (user, 2026-10-17): and again while the user types in a DSH
  // chat, for a host that stopped after 10 idle minutes. A running host answers at once.
  handle(IPC_CHANNELS.CHAT_WARM_DSH_HOST, () => {
    prewarmDshHost(dshPrewarmDeps);
  });

  handle(IPC_CHANNELS.CHAT_ENSURE_HOST, async () => {
    await workerManager.ensureReady();
    prewarmDshHostOnce();
    return workerManager.getStatus();
  });

  /**
   * Issue #25: one history page for a plugin client, returned rather than
   * broadcast (the windows never see it), and readable while a turn runs. A
   * running chat answers from its engine; a DSH chat with no slot from the
   * host's preview read; an Agent SDK chat with no slot has to be resumed.
   */
  handle(
    IPC_CHANNELS.CHAT_PEEK_HISTORY,
    async (
      _caller,
      payload: { sessionId: string; offset?: number; limit?: number }
    ): Promise<
      SessionHistoryPage & { runtimeIdentity: string; workspacePath: string; live: boolean }
    > => {
      const { row, agent } = await requireIndexedSession(payload.sessionId);
      const live = await workerManager.peekHistory(payload).catch((error: unknown) => {
        throw withWorkerErrorCode(error);
      });
      if (live) {
        return {
          ...live.page,
          runtimeIdentity: live.sessionFile,
          workspacePath: live.workspacePath,
          live: true,
        };
      }
      if (agent !== DSH_AGENT || row.runtimeIdentity.endsWith(CLAUDE_SDK_STUB_SUFFIX)) {
        throw new Error(
          `${SESSION_REPLAY_UNAVAILABLE}: Session ${payload.sessionId} is read by resuming it`
        );
      }
      const page = await readDshReplayPage(payload.sessionId, row.runtimeIdentity, payload);
      return {
        ...page,
        runtimeIdentity: row.runtimeIdentity,
        workspacePath: row.workspacePath,
        live: false,
      };
    }
  );

  handle(IPC_CHANNELS.CHAT_GET_SESSION_CONTROLS, () => sessionControl.list());

  // The desktop's 「接管」. A window is always the desktop, so no owner check.
  handle(IPC_CHANNELS.CHAT_TAKE_OVER_SESSION, (_caller, payload: { sessionId: string }) => {
    if (typeof payload?.sessionId !== 'string') throw new Error('Invalid session id');
    sessionControl.acquireForDesktop(payload.sessionId);
  });

  handle(IPC_CHANNELS.CHAT_GET_HOST_STATUS, async () => {
    return workerManager.getStatus();
  });

  // Route B S-6 feedback 7: the Context panel's "Conversation record" row.
  handle(
    IPC_CHANNELS.CHAT_LOCATE_TRANSCRIPT,
    async (_event, stubFile: unknown): Promise<TranscriptLocation | null> => {
      if (typeof stubFile !== 'string') return null;
      const appStateRoot = getAppStateRoot();
      return locateTranscript(stubFile, {
        dshHome: resolveDshHome({ isPackaged: app.isPackaged, appStateRoot }),
        claudeSdkConfigDir: path.join(appStateRoot, CLAUDE_SDK_HOME_DIR_NAME),
      });
    }
  );

  // Issue #26 item 6: a sent image's bytes for the bubble's thumbnail and
  // preview. Read-only, by store reference only, for a chat this index holds
  // (`sentAttachmentRead.ts` carries the path guard and its test).
  handle(
    IPC_CHANNELS.CHAT_READ_SENT_ATTACHMENT,
    async (_caller, payload: SentAttachmentReadRequest): Promise<SentAttachmentReadResult> => {
      const row =
        typeof payload?.sessionId === 'string'
          ? await sessionIndexService.get(payload.sessionId)
          : null;
      if (!row) return { ok: false, reason: 'not-found' };
      const dshHome = resolveDshHome({
        isPackaged: app.isPackaged,
        appStateRoot: getAppStateRoot(),
      });
      return readSentImage(dshHome, payload.attachmentId, {
        size: async (file) => {
          const facts = await stat(file);
          return facts.isFile() ? facts.size : null;
        },
        read: async (file) => new Uint8Array(await readFile(file)),
      });
    }
  );

  handle(
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
      const indexedBefore = await assertCreatableIndexRow(payload.sessionId);
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
        agent: DSH_AGENT,
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
        // With its code, like resume and send: the renderer names the cause
        // from it (`claude_sdk_credentials_unavailable`, `dsh_host_unavailable`).
        throw withWorkerErrorCode(error);
      }
    }
  );

  /**
   * U05-a — hand an unbound chat its isolated working directory.
   *
   * Called on the first send, never when the chat row is created: a chat the
   * user never actually uses must not put a directory on disk (same rule
   * `chat:registerSession` follows for workers). Idempotent, so a repeated ask
   * gets the same directory.
   */
  handle(
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
  handle(
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
        await assertCreatableIndexRow(payload.sessionId);
        await sessionIndexService.recordCreated({
          ...payload,
          agent: DSH_AGENT,
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

  handle(
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
    ): Promise<{ requestId: string; migration?: LegacyMigrationSummary }> => {
      const indexed = await requireIndexedSession(payload.sessionId);
      let { row } = indexed;
      if (!namesIndexedIdentity(row, indexed.agent, payload.runtimeIdentity)) {
        throw new Error(
          'pi_session_identity_mismatch: Indexed session file does not match the resume request'
        );
      }
      // GitHub issue #1 (decision 163): one directory reaches here in more than
      // one spelling (`E:\x` from the registered project, `E:/x` from git's
      // worktree list, the normalized form `commitResumed` writes back), so
      // compare directory identity, not the string. A different directory
      // still fails, with the same text (`historyError.ts` maps it to the
      // non-retryable workspace card).
      if (!sameWorkerDirectory(row.workspacePath, payload.workspacePath)) {
        throw new Error(
          'pi_session_workspace_mismatch: Indexed workspace does not match the resume request'
        );
      }
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      // The index row is the authoritative cwd; the renderer's path is only a
      // claim, validated above. Everything below (scratch adoption, the legacy
      // migration's cwd, the worker spawn) uses the row's own spelling.
      //
      // U05-a: an unbound chat's directory was wiped when the app last quit,
      // so recreate it (empty) at the exact path the index still names before
      // anything tries to spawn Pi in it.
      let workspacePath = row.workspacePath;
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
      // Decision 050: the first continue of a legacy chat migrates it, into
      // the workspace this resume uses (the DSH session's cwd is fixed). A
      // failure rejects with `legacy_migration_failed:<stage>/<code>` and
      // leaves the row `pi` and its preview as they were.
      //
      // dsh-rebase P1-7e (problem 28, decision 139): every legacy row, with or
      // without `piLeaf`. A row whose file is gone used to be "repaired" into
      // a new, empty session when it had no leaf, on the theory that 1.0.x
      // had only reserved the name. Rows from before `piLeaf` existed break
      // that theory — their transcript was real — and the repair answered a
      // resume with a create the renderer never waits for, so the message was
      // lost too. Such a row now fails like one with a leaf:
      // `read/source_missing`, the card that says the file is gone.
      const prepared = await legacyMigrationService.prepareResume(row, workspacePath);
      row = prepared.row;
      const posture = legacyPosture(prepared.migration, payload);
      // Decision 176: with its code, like the operations that follow a start
      // (`session_not_ready` while Main reopens it after an engine restart,
      // `dsh_host_unavailable` for the engine card).
      const requestId = await workerManager
        .resumeSession({
          sessionId: payload.sessionId,
          // The row's own identity: after a migration, the stub, whatever the
          // renderer still held.
          sessionFile: row.runtimeIdentity,
          workspacePath,
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.effort ? { effort: payload.effort } : {}),
          ...spawnTier(payload.tier),
          ...spawnPermissions(payload.permissions ?? posture),
          ...spawnForceTakeover(payload.forceTakeover),
          ownerWebContentsId,
          ...(unbound ? { unbound: true } : {}),
        })
        .catch((error: unknown) => {
          throw withWorkerErrorCode(error);
        });
      return prepared.migration
        ? {
            requestId,
            migration: { ...prepared.migration, legacyPermissionsApplied: posture !== undefined },
          }
        : { requestId };
    }
  );

  handle(
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
      try {
        const requestId = await workerManager.send({ ...payload, ownerWebContentsId });
        return { requestId };
      } catch (error) {
        throw withWorkerErrorCode(error);
      }
    }
  );

  handle(
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
      // Same preamble as CHAT_SEND: ownership follows the most recent driver.
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
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

  handle(
    IPC_CHANNELS.CHAT_STOP,
    async (
      e,
      payload: { sessionId: string; scope?: WorkerStopScope }
    ): Promise<{ requestId: string }> => {
      claimSessionForSender(e, payload.sessionId);
      // Decision 201: anything but an explicit `turn` is the Stop button's `all`.
      const scope = payload.scope === 'turn' ? 'turn' : 'all';
      const requestId = await workerManager.stop(payload.sessionId, scope);
      return { requestId };
    }
  );

  handle(
    IPC_CHANNELS.CHAT_INTERJECT,
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
        /** Decision 201: "Send now" on an engine that delivers without a Stop. */
        sendNow?: boolean;
      }
    ): Promise<{ interjected: boolean; turnActive?: boolean }> => {
      // Same claim CHAT_STOP makes above. It is NOT an ownership check — any
      // window may interject any session id it names. It routes this
      // session's events (approval cards included) to the window that sent
      // the message, so the turn it joins reports back to the window the user
      // is looking at (dsh-rebase decision 093: the message is steered into
      // the running turn).
      claimSessionForSender(e, payload.sessionId);
      try {
        return await workerManager.interject(payload.sessionId, {
          attemptId: payload.attemptId,
          text: payload.text,
          ...(payload.attachments ? { attachments: payload.attachments } : {}),
          ...(payload.sendNow === true ? { sendNow: true } : {}),
        });
      } catch (error) {
        throw withWorkerErrorCode(error);
      }
    }
  );

  handle(
    IPC_CHANNELS.CHAT_WITHDRAW_INTERJECTION,
    async (
      _e,
      payload: { sessionId: string; attemptId: string }
    ): Promise<WorkerInterjectWithdrawResult> => {
      // No `claimSessionForSender`: a withdrawal starts nothing and emits
      // nothing, so there is no event stream to route to this window.
      try {
        return await workerManager.withdrawInterjection(payload.sessionId, payload.attemptId);
      } catch (error) {
        throw withWorkerErrorCode(error);
      }
    }
  );

  handle(
    IPC_CHANNELS.CHAT_CLOSE_SESSION,
    async (_e, payload: { sessionId: string }): Promise<{ requestId: string }> => {
      workerManager.releaseSession(payload.sessionId);
      const requestId = await workerManager.closeSession(payload.sessionId);
      return { requestId };
    }
  );

  handle(
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
  handle(
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

  handle(
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

  handle(
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

  // P1-9d (decision 051): the legacy rows migrated chats came from stay in the
  // index for a rollback, not in the sidebar, unless 1.0.x wrote to them since.
  handle(IPC_CHANNELS.CHAT_LIST_SESSIONS, async (): Promise<SessionIndexListEntry[]> => {
    return sessionIndexService.listForDisplay();
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
  handle(
    IPC_CHANNELS.CHAT_LIST_SESSION_CAPABILITIES,
    async (_e, payload: { sessionId: string }): Promise<WorkerCapabilityInventory | null> => {
      return workerManager.getSessionCapabilities(payload.sessionId);
    }
  );

  handle(
    IPC_CHANNELS.CHAT_RENAME_SESSION,
    async (_e, payload: { sessionId: string; title: string }): Promise<boolean> => {
      return sessionIndexService.rename(payload.sessionId, payload.title);
    }
  );

  handle(
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
   * Decision 194 Q1: the Agent SDK CLI's list for a folder no SDK chat runs in, kept per
   * folder. A listing starts a process, so only once the spawn gate allows an agent.
   */
  const claudeSdkCommandCatalog = new ClaudeSdkCommandCatalog({
    run: (input) => {
      assertAgentSpawnAllowed();
      return runClaudeSdkCatalogHost(input, (message) => console.warn(message));
    },
    log: (message, error) => console.warn(message, error),
  });

  /**
   * R02-b — the composer's command menu.
   *
   * No `requireLiveSession` and no `claimSessionForSender`, unlike every
   * neighbour here. This is a read that happens while the user types, including
   * on the home page where no session exists yet, and it does not act on a
   * session — so gating it on one would turn the ordinary case into an error
   * the renderer has to translate back into "no commands".
   *
   * Decision 175: `workspacePath` is the folder the menu is for (the home
   * page's draft target, or the chat's own). With no worker of that workspace
   * up, its skills are read from disk by DSH's rules (`composerSlashCommands`).
   * Only a local absolute path is read; anything else lists the user's skills.
   * Decision 194: `engine` is the chat's (or the next send's); with no worker
   * up, the DSH host lists a DSH menu, plugin skills included, before the disk.
   */
  handle(
    IPC_CHANNELS.CHAT_GET_SLASH_COMMANDS,
    async (
      _e,
      payload: { sessionId?: string; workspacePath?: string; engine?: unknown } = {}
    ): Promise<WorkerCommandsResult> =>
      composerSlashCommands(
        {
          ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
          workspacePath: usableWorkspace(payload.workspacePath),
          engine: payload.engine === 'claude-sdk' ? 'claude-sdk' : 'dsh',
        },
        {
          workers: workerManager,
          dshHost: dshHostSupervisor,
          sdkCatalog: claudeSdkCommandCatalog,
          listSkills: (workspacePath) =>
            listDshSkillsFromDisk(workspacePath, currentDshSkillHomes()),
          log: (message, error) => console.warn(message, error),
        }
      )
  );

  /**
   * dsh-rebase decision 180, after the 2026-10-11 acceptance (DA-4): a
   * `/compact` the user cancelled (Esc, Stop) is answered `{compacted: false,
   * cancelled: true}` and logged at info. Rejected, Electron logged it at
   * error level like a failure.
   */
  handle(
    IPC_CHANNELS.CHAT_COMPACT_SESSION,
    async (
      e,
      payload: { sessionId: string; instructions?: string }
    ): Promise<ChatCompactSessionResult> => {
      await requireLiveSession(payload.sessionId);
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      try {
        return await workerManager.compactSession({
          sessionId: payload.sessionId,
          ...(payload.instructions ? { instructions: payload.instructions } : {}),
          ownerWebContentsId,
        });
      } catch (error) {
        if (isCompactCancelledByUser(error)) {
          console.info(`[chat] /compact of ${payload.sessionId} was cancelled by the user`);
          return { compacted: false, cancelled: true };
        }
        throw withWorkerErrorCode(error);
      }
    }
  );

  /**
   * dsh-rebase decision 180 — Esc or Stop on a running `/compact`. Claimed
   * like Stop (it routes nothing, the session's events already go to the
   * window that asked); answered `cancelled: false` when no compaction of it
   * is with the worker.
   */
  handle(
    IPC_CHANNELS.CHAT_CANCEL_COMPACT,
    async (e, payload: { sessionId: string }): Promise<{ cancelled: boolean }> => {
      claimSessionForSender(e, payload.sessionId);
      return workerManager.cancelCompact(payload.sessionId);
    }
  );

  /**
   * dsh-rebase P1-7a — the goal bar's buttons. A mutation of a live session,
   * so it is claimed for the sender like `/compact`; unlike `/compact` it is
   * not refused mid-turn (the worker and `WorkerManager.runSessionCommand`
   * say why).
   */
  handle(
    IPC_CHANNELS.CHAT_RUN_SESSION_COMMAND,
    async (
      e,
      payload: { sessionId: string; line: string }
    ): Promise<Awaited<ReturnType<typeof workerManager.runSessionCommand>>> => {
      await requireLiveSession(payload.sessionId);
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      try {
        return await workerManager.runSessionCommand({
          sessionId: payload.sessionId,
          line: payload.line,
          ownerWebContentsId,
        });
      } catch (error) {
        throw withWorkerErrorCode(error);
      }
    }
  );

  /**
   * dsh-rebase P1-7a — the panels' rehydration. A read, asked for every chat
   * the renderer shows, so like the command menu above it neither requires a
   * live session nor claims one: a chat with no running slot answers no
   * panels.
   */
  handle(
    IPC_CHANNELS.CHAT_GET_SESSION_PANELS,
    async (
      _e,
      payload: { sessionId: string }
    ): Promise<Awaited<ReturnType<typeof workerManager.getSessionPanels>>> =>
      workerManager.getSessionPanels({ sessionId: payload.sessionId })
  );

  /**
   * dsh-rebase P1-7b — the jobs window's stop. A mutation of a live session,
   * claimed for the sender like the goal bar's commands; not refused
   * mid-turn (a background job is what runs beside a turn).
   */
  handle(
    IPC_CHANNELS.CHAT_KILL_SESSION_JOB,
    async (
      e,
      payload: { sessionId: string; jobId: string }
    ): Promise<Awaited<ReturnType<typeof workerManager.killSessionJob>>> => {
      await requireLiveSession(payload.sessionId);
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      try {
        return await workerManager.killSessionJob({
          sessionId: payload.sessionId,
          jobId: payload.jobId,
          ownerWebContentsId,
        });
      } catch (error) {
        throw withWorkerErrorCode(error);
      }
    }
  );

  /**
   * dsh-rebase P1-7b — one job's output for the jobs window. A read, like the
   * panels' rehydration: no claim, and a chat with no running slot answers
   * `null` (its jobs went with its host).
   */
  handle(
    IPC_CHANNELS.CHAT_READ_SESSION_JOB,
    async (
      _e,
      payload: { sessionId: string; jobId: string; from?: number; maxBytes?: number }
    ): Promise<Awaited<ReturnType<typeof workerManager.readSessionJob>>> =>
      workerManager.readSessionJob({
        sessionId: payload.sessionId,
        jobId: payload.jobId,
        ...(payload.from !== undefined ? { from: payload.from } : {}),
        ...(payload.maxBytes !== undefined ? { maxBytes: payload.maxBytes } : {}),
      })
  );

  /**
   * Layout 5f (ui-cohesion ruling L6) — one side question about the
   * conversation so far. A read: nothing is claimed and nothing is written.
   */
  handle(
    IPC_CHANNELS.CHAT_ASK_SIDE_QUESTION,
    async (
      _e,
      payload: {
        sessionId: string;
        questionId: string;
        question: string;
        history?: Array<{ question: string; answer: string }>;
      }
    ): Promise<Awaited<ReturnType<typeof workerManager.askSideQuestion>>> => {
      await requireLiveSession(payload.sessionId);
      try {
        return await workerManager.askSideQuestion({
          sessionId: payload.sessionId,
          questionId: payload.questionId,
          question: payload.question,
          ...(payload.history?.length ? { history: payload.history } : {}),
        });
      } catch (error) {
        throw withWorkerErrorCode(error);
      }
    }
  );

  handle(
    IPC_CHANNELS.CHAT_CANCEL_SIDE_QUESTION,
    async (
      _e,
      payload: { sessionId: string; questionId: string }
    ): Promise<Awaited<ReturnType<typeof workerManager.cancelSideQuestion>>> =>
      workerManager.cancelSideQuestion({
        sessionId: payload.sessionId,
        questionId: payload.questionId,
      })
  );

  /**
   * Decision 203 — one subagent's own conversation, read-only (its
   * sub-conversation page). A read of a live session: nothing is claimed.
   */
  handle(
    IPC_CHANNELS.CHAT_SUBAGENT_HISTORY,
    async (
      _e,
      payload: { sessionId: string; childId: string }
    ): Promise<Awaited<ReturnType<typeof workerManager.subagentHistory>>> => {
      await requireLiveSession(payload.sessionId);
      try {
        return await workerManager.subagentHistory({
          sessionId: payload.sessionId,
          childId: payload.childId,
        });
      } catch (error) {
        throw withWorkerErrorCode(error);
      }
    }
  );

  /**
   * Decision 203 — move one running foreground call of the turn to the
   * background (the Claude engine's Ctrl+B). Claimed for the sender.
   */
  handle(
    IPC_CHANNELS.CHAT_BACKGROUND_TOOL,
    async (
      e,
      payload: { sessionId: string; toolCallId: string }
    ): Promise<Awaited<ReturnType<typeof workerManager.backgroundTool>>> => {
      await requireLiveSession(payload.sessionId);
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      try {
        return await workerManager.backgroundTool({
          sessionId: payload.sessionId,
          toolCallId: payload.toolCallId,
          ownerWebContentsId,
        });
      } catch (error) {
        throw withWorkerErrorCode(error);
      }
    }
  );

  /**
   * dsh-rebase P1-7b — interrupt one continuable subagent's current run, as
   * its human parent. A mutation of a live session, claimed for the sender.
   */
  handle(
    IPC_CHANNELS.CHAT_INTERRUPT_SUBAGENT,
    async (
      e,
      payload: { sessionId: string; childId: string }
    ): Promise<Awaited<ReturnType<typeof workerManager.interruptSubagent>>> => {
      await requireLiveSession(payload.sessionId);
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      try {
        return await workerManager.interruptSubagent({
          sessionId: payload.sessionId,
          childId: payload.childId,
          ownerWebContentsId,
        });
      } catch (error) {
        throw withWorkerErrorCode(error);
      }
    }
  );

  handle(
    IPC_CHANNELS.CHAT_GET_SESSION_TREE,
    async (
      e,
      payload: { sessionId: string; requestSequence: number }
    ): Promise<Awaited<ReturnType<typeof workerManager.getSessionTree>>> => {
      const row = await requireLiveSession(payload.sessionId);
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      const result = await workerManager
        .getSessionTree({
          sessionId: payload.sessionId,
          requestSequence: payload.requestSequence,
          ownerWebContentsId,
        })
        .catch((error: unknown) => {
          throw withWorkerErrorCode(error);
        });
      if (result.snapshot.sessionFile !== row.runtimeIdentity) {
        throw new Error(
          'pi_session_identity_mismatch: Tree slot does not match the indexed session'
        );
      }
      return result;
    }
  );

  handle(
    IPC_CHANNELS.CHAT_REWIND_SESSION,
    async (
      e,
      payload: { sessionId: string; entryId: string; confirmed: boolean }
    ): Promise<Awaited<ReturnType<typeof workerManager.rewindSession>>> => {
      await requireLiveSession(payload.sessionId);
      if (payload.confirmed !== true) {
        throw new Error('rewind_confirmation_required: Rewind requires explicit confirmation');
      }
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      try {
        return await workerManager.rewindSession({
          sessionId: payload.sessionId,
          entryId: payload.entryId,
          confirmed: true,
          ownerWebContentsId,
        });
      } catch (error) {
        throw withWorkerErrorCode(error);
      }
    }
  );

  handle(
    IPC_CHANNELS.CHAT_FORK_SESSION,
    async (
      e,
      payload: { sessionId: string; entryId: string }
    ): Promise<Awaited<ReturnType<typeof workerManager.forkSession>>> => {
      const row = await requireLiveSession(payload.sessionId);
      try {
        return await workerManager.forkSession({
          sourceSessionId: payload.sessionId,
          entryId: payload.entryId,
          sourceTitle: row.title,
          ...(row.model ? { model: row.model } : {}),
          ownerWebContentsId: claimSessionForSender(e, payload.sessionId),
        });
      } catch (error) {
        throw withWorkerErrorCode(error);
      }
    }
  );

  handle(
    IPC_CHANNELS.CHAT_LOAD_HISTORY_PAGE,
    async (
      e,
      payload: { sessionId: string; offset: number; limit?: number }
    ): Promise<{ requestId: string }> => {
      const ownerWebContentsId = claimSessionForSender(e, payload.sessionId);
      try {
        const requestId = await workerManager.loadHistoryPage({
          ...payload,
          ownerWebContentsId,
        });
        return { requestId };
      } catch (error) {
        throw withWorkerErrorCode(error);
      }
    }
  );

  handle(
    IPC_CHANNELS.CHAT_READ_SESSION_PAGE,
    async (
      _e,
      payload: { sessionId: string; offset?: number; limit?: number }
    ): Promise<{ requestId: string }> => {
      const { row, agent } = await requireIndexedSession(payload.sessionId);
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
      // Decision 197: an Agent SDK chat's transcript is the CLI's own, read by
      // that chat's host once it runs. The DSH host refuses its stub
      // (`session_invalid`) and may have to boot just to say so, so the answer
      // is the refusal the renderer already meets with a resume.
      if (row.runtimeIdentity.endsWith(CLAUDE_SDK_STUB_SUFFIX)) {
        throw new Error(
          `${SESSION_REPLAY_UNAVAILABLE}: Session ${payload.sessionId} runs on the Claude Agent SDK engine; its history is read by resuming it`
        );
      }
      // No `claimSessionForSender` on purpose: claiming marks a worker slot as
      // foreground, and this path has no slot to mark. Reading history must
      // never be the reason a session is treated as held by a window.
      // A DSH log is read by the host (decision 030); `SessionReplayReader`
      // decodes the legacy pi format only, which keeps pre-switch sessions
      // viewable (decision 005).
      const page =
        agent === DSH_AGENT
          ? await readDshReplayPage(payload.sessionId, row.runtimeIdentity, payload)
          : await readSessionReplayPage({
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
          agent,
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
