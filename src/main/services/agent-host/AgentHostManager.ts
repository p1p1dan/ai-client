import { statSync } from 'node:fs';
import path from 'node:path';
import { COMETIX_PIN } from '@shared/agentHost/cometixPin';
import { bundledNodeRuntimeBinaryFor } from '@shared/agentHost/nodeRuntimePin';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  type AgentHostCommand,
  type AgentHostDriver,
  DEFAULT_AGENT_HOST_DRIVER,
  type PermissionRespondCommand,
  type QuestionRespondCommand,
  type SessionCloseCommand,
  type SessionCreateCommand,
  type SessionListHistoryCommand,
  type SessionResumeCommand,
  type SessionSendCommand,
  type SessionStopCommand,
  type SessionUpdatePermissionCommand,
} from '@shared/types/agentHost';
import type {
  HostReadyEvent,
  RuntimeEvent,
  RuntimeEventType,
  SessionHistoryListedEvent,
  SessionPermissionUpdatedEvent,
  SessionRuntimeStatus,
  SessionStatusEvent,
  SessionTerminalEvent,
} from '@shared/types/runtimeEvents';
import type { HistorySessionSummary } from '@shared/types/sessionHistory';
import { app } from 'electron';
import log from '../../utils/logger';
import { getCredentialVault } from '../auth';
import { resolveManagedCredentialsEnabled } from '../auth/credentialMode';
import { getDevCredentialSeed } from '../auth/managedCredentialsStartup';
import { AgentHostProcess } from './AgentHostProcess';
import { buildAgentHostEnv, CODEX_JS_PATH_ENV_KEY, deriveBundledCodexJsPath } from './hostEnv';
import { drainStderrLines, flushStderrPending, pushRecentStderr } from './hostStderr';
import { resolveNode24Runtime } from './NodeRuntimeResolver';

/**
 * F2 S5 (2026-08-18 watchdog redesign, spec §6.2) — the four
 * `SessionRuntimeStatus` values that mean "this session has nothing in
 * flight right now." Any OTHER status (`starting`, `running`,
 * `waiting_permission`, `waiting_question`, `stopping`) means a Host crash at
 * that instant would silently orphan the session — see `openSessions` below.
 */
const CLOSED_SESSION_STATUSES: ReadonlySet<SessionRuntimeStatus> = new Set([
  'idle',
  'failed',
  'completed',
  'disconnected',
]);

/**
 * D47 S3b §1 / S0' (D60) — the Codex managed-credentials `buildAgentHostEnv`
 * inputs, resolved from the managed-credentials flag + a FRESH vault snapshot
 * (never cached across Host restarts, so a login/logout that happened while the
 * Host was down is picked up the next time `ensureStarted()` spawns a new one —
 * this is what the I5 epoch barrier below exists to make possible). Flag off
 * returns every field `undefined` — `hostEnv.ts`'s "继承污染防御" contract needs
 * that to kill any stray inherited value, not merely omit the key.
 *
 * S0' replaced the third field. It used to be `codexHomeManagedDir`, the
 * app-owned directory Main generated a `config.toml` into; it is now
 * `codexBaseUrl`, the same value that `config.toml` used to carry as
 * `base_url`. The Host assembles the provider table as `-c` overrides at spawn
 * time (`codexConfigOverrides.ts`), so the fact travels as a value instead of
 * as a file — and the user's `~/.codex` is theirs again.
 *
 * Both halves or neither: the Host's own resolver refuses a base URL without a
 * key and a key without a base URL, because half a credential is not a degraded
 * credential but a differently-wrong one. Nothing here re-implements that
 * check; it just supplies whatever the vault held.
 */
export function resolveCodexManagedHostEnv(): {
  codexManaged: string | undefined;
  codexApiKey: string | undefined;
  codexBaseUrl: string | undefined;
} {
  if (!resolveManagedCredentialsEnabled()) {
    return { codexManaged: undefined, codexApiKey: undefined, codexBaseUrl: undefined };
  }
  const vaultResult = getCredentialVault().read();
  // Optional-chained for the same reason the Claude arm is: an older vault
  // document may have no `codex` arm at all, and that must read as "no managed
  // credential" rather than throwing inside a spawn.
  const codex = vaultResult.status === 'ok' ? vaultResult.doc.payload.codex : undefined;
  return { codexManaged: '1', codexApiKey: codex?.apiKey, codexBaseUrl: codex?.baseUrl };
}

/**
 * S0' (D60) — the Claude half of the same idea, and the REPLACEMENT for what
 * `CLAUDE_CONFIG_DIR` redirection used to buy.
 *
 * Before D60 the vault's Claude credential reached the Host by being written
 * into `<userData>/claude-home/settings.json`, which only worked because Main
 * had pointed `CLAUDE_CONFIG_DIR` at that directory — and pointing it there is
 * exactly what made the user's own `~/.claude` (CLAUDE.md, commands/, skills/,
 * plugins/) invisible. Handing the credential over as env removes the reason
 * to control the directory at all.
 *
 * Same freshness contract as `resolveCodexManagedHostEnv`: resolved per spawn,
 * never cached on the manager, so a login/logout that happened while the Host
 * was down is picked up by the next spawn.
 *
 * Flag off returns both `undefined` — `hostEnv.ts`'s contamination defense
 * needs the keys PRESENT and undefined to kill a stray inherited value, not
 * merely omitted.
 */
export function resolveClaudeManagedHostEnv(): {
  claudeBaseUrl: string | undefined;
  claudeAuthToken: string | undefined;
} {
  if (!resolveManagedCredentialsEnabled()) {
    return { claudeBaseUrl: undefined, claudeAuthToken: undefined };
  }
  const vaultResult = getCredentialVault().read();
  if (vaultResult.status === 'ok') {
    // Optional-chained for the same reason as `SessionManager`'s twin: an
    // older vault document has no `claude` arm, and a missing arm must read
    // as "no managed credential", not as a crash during Host spawn.
    const baseUrl = vaultResult.doc.payload.claude?.baseUrl;
    const authToken = vaultResult.doc.payload.claude?.authToken;
    if (baseUrl && authToken) {
      return { claudeBaseUrl: baseUrl, claudeAuthToken: authToken };
    }
  }
  // Dev fallback (A-track M9): a dev machine whose vault is still `absent`
  // would otherwise spawn a Host with no credentials at all. Packaged builds
  // never have a seed — `activateManagedCredentials` only captures one when
  // `app.isPackaged` is false.
  //
  // Every OTHER non-`ok` status falls through to the same `undefined` pair,
  // and that is deliberate rather than an oversight: the Host then reads the
  // user's own settings.json, exactly as it did before managed mode existed.
  // A `locked` keyring at boot is a TEMPORARY state, not "no credentials"
  // (the same B1 reasoning `regenerateFromVault` follows for codex).
  const seed = getDevCredentialSeed();
  if (seed && (vaultResult.status === 'absent' || vaultResult.status === 'cleared')) {
    return { claudeBaseUrl: seed.baseUrl, claudeAuthToken: seed.authToken };
  }
  return { claudeBaseUrl: undefined, claudeAuthToken: undefined };
}

export type AgentHostState = 'stopped' | 'starting' | 'ready' | 'error';

/** S7 (round-2 iteration-3 review): the desensitized settings diagnostics `host.ready` carries — same shape as `HostReadyEvent['payload']['settings']`, normalized to drop `undefined` (only `null`/present). */
export type AgentHostSettingsInfo = NonNullable<HostReadyEvent['payload']['settings']>;

/** S3 slice 6 (A5): same "capture off the live `host.ready` event" shape as {@link AgentHostSettingsInfo}, for `capabilities` (notably `capabilities.agents`, the HostAgentRegistry's wire form). */
export type AgentHostCapabilitiesInfo = NonNullable<HostReadyEvent['payload']['capabilities']>;

let requestSeq = 0;

function nextRequestId(prefix: string): string {
  requestSeq += 1;
  return `${prefix}-${Date.now()}-${requestSeq}`;
}

/**
 * Owns the single Agent Host child process lifecycle for the Electron Main process.
 */
export class AgentHostManager {
  private process: AgentHostProcess | null = null;
  private state: AgentHostState = 'stopped';
  private driver: AgentHostDriver = DEFAULT_AGENT_HOST_DRIVER;
  private readyPromise: Promise<void> | null = null;
  // D47 S3b I5 epoch barrier: set for the duration of `shutdown()` (including
  // the underlying `proc.stop()` await), so a `create` request racing a
  // login/logout-triggered shutdown waits for the OLD Host to fully land
  // before `ensureStarted()` decides whether to spawn a NEW one — otherwise a
  // new Host could spawn (and read a fresh vault snapshot) while the old
  // process is still mid-teardown, or a caller could keep talking to a Host
  // that's about to disappear.
  private shutdownPromise: Promise<void> | null = null;
  private eventHandlers = new Set<(event: RuntimeEvent) => void>();
  // S7 (round-2 iteration-3 review): captured off the live `host.ready` event
  // in `attachProcessHandlers` below — `null` until the Host has reported it
  // at least once this process lifetime (never yet ready, or reported no
  // diagnostics).
  private settings: AgentHostSettingsInfo | null = null;
  // S3 slice 6 (A5): same capture-off-`host.ready` pattern as `settings` above —
  // `null` until this process lifetime has seen at least one `host.ready`.
  private capabilities: AgentHostCapabilitiesInfo | null = null;
  // F2 S5 (2026-08-18, spec §6.2) — the open-session ledger the Host-exit
  // broadcast scopes itself to. Maintained off the SAME event stream every
  // RuntimeEvent already flows through (`attachProcessHandlers`'s 'event'
  // listener) — no new pipeline. Entry: `session.created` / `session.resumed`,
  // and any `session.status` NOT in `CLOSED_SESSION_STATUSES` (this is what
  // covers a session's second and later turns, not just its first). Exit:
  // `session.status` IN `CLOSED_SESSION_STATUSES` — `disconnected` already
  // covers an explicit `session.close` (both runtimes emit it from their own
  // `close()`), so explicit close needs no separate handling here.
  private readonly openSessions = new Set<string>();
  // F2 S5 — monotonic seq for Main-synthesized events. By the time the
  // Host-exit broadcast runs, the Host process (and its own seq counter,
  // owned by `src/agent-host/index.ts`) is gone, so Main stamps its own.
  // Downstream consumers never enforce strict seq continuity — it is an
  // out-of-order hint, not audited that precisely — so a Main-local counter
  // is a legitimate encoding for these synthetic events.
  private syntheticEventSeq = 0;

  getStatus(): {
    state: AgentHostState;
    pid?: number;
    driver: AgentHostDriver;
    cometixVersion: string;
    // S7: additive — a late-mounting consumer (e.g. `useHostStatus.ts`'s
    // prime/poll, which only otherwise learns `settings` from a LIVE
    // `host.ready` event) can now read the Host's already-reported default
    // instead of reading `undefined` forever.
    settings: AgentHostSettingsInfo | null;
    // S3 slice 6 (A5): additive, same reasoning as `settings` — carries
    // `capabilities.agents` (the HostAgentRegistry's wire form) to a consumer
    // that mounts after the live `host.ready` already fired.
    capabilities: AgentHostCapabilitiesInfo | null;
  } {
    return {
      state: this.state,
      pid: this.process?.pid,
      driver: this.driver,
      cometixVersion: COMETIX_PIN.version,
      settings: this.settings,
      capabilities: this.capabilities,
    };
  }

  onEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async ensureStarted(driver?: AgentHostDriver): Promise<void> {
    if (driver) this.driver = driver;
    // I5 epoch barrier (D47 S3b): a shutdown in flight must fully land before
    // this method looks at `state`/`process` at all — those fields are
    // updated (to 'stopped'/null) synchronously at the START of `shutdown()`,
    // before the actual `proc.stop()` teardown has finished, so reading them
    // early would let a new Host spawn while the old one is still exiting.
    if (this.shutdownPromise) {
      await this.shutdownPromise;
    }
    if (this.state === 'ready' && this.process?.isRunning) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = this.startInternal();
    try {
      await this.readyPromise;
    } finally {
      this.readyPromise = null;
    }
  }

  /** Send a protocol command; Host must already be ready. */
  send(command: AgentHostCommand): void {
    if (!this.process?.isRunning) {
      throw new Error('Agent Host is not running');
    }
    this.process.send(command);
  }

  /** Ensure Host is up, then send. */
  async sendReady(command: AgentHostCommand): Promise<void> {
    await this.ensureStarted();
    this.send(command);
  }

  async createSession(
    payload: SessionCreateCommand['payload'],
    requestId = nextRequestId('create')
  ): Promise<string> {
    await this.sendReady({
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId,
      type: 'session.create',
      payload,
    });
    return requestId;
  }

  async resumeSession(
    payload: SessionResumeCommand['payload'],
    requestId = nextRequestId('resume')
  ): Promise<string> {
    await this.sendReady({
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId,
      type: 'session.resume',
      payload,
    });
    return requestId;
  }

  async sendMessage(
    payload: SessionSendCommand['payload'],
    requestId = nextRequestId('send')
  ): Promise<string> {
    await this.sendReady({
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId,
      type: 'session.send',
      payload,
    });
    return requestId;
  }

  async stopSession(
    payload: SessionStopCommand['payload'],
    requestId = nextRequestId('stop')
  ): Promise<string> {
    await this.sendReady({
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId,
      type: 'session.stop',
      payload,
    });
    return requestId;
  }

  async closeSession(
    payload: SessionCloseCommand['payload'],
    requestId = nextRequestId('close')
  ): Promise<string> {
    await this.sendReady({
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId,
      type: 'session.close',
      payload,
    });
    return requestId;
  }

  /**
   * D48 S4 §6 — mid-session posture change, and the ONE session command that
   * waits for its own answer.
   *
   * Every other session command is fire-and-forget because its outcome reaches
   * the renderer as events on the session's own stream. This one has a decision
   * hanging off it in Main: the session snapshot may only be rewritten if the
   * change actually landed (D10), and "landed" is a correlated
   * `session.permissionUpdated` — a correlated `host.error` (bad tier, busy
   * turn, an old Host answering `not_implemented`) has to leave the snapshot
   * byte-identical. Waiting here is what makes that decision possible at all.
   */
  async updateSessionPermission(
    payload: SessionUpdatePermissionCommand['payload'],
    requestId = nextRequestId('perm-update')
  ): Promise<SessionPermissionUpdatedEvent> {
    const command: SessionUpdatePermissionCommand = {
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId,
      type: 'session.updatePermission',
      payload,
    };
    return (await this.requestAndWait(
      command,
      'session.permissionUpdated'
    )) as SessionPermissionUpdatedEvent;
  }

  async respondPermission(
    payload: PermissionRespondCommand['payload'],
    requestId = nextRequestId('perm')
  ): Promise<string> {
    await this.sendReady({
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId,
      type: 'permission.respond',
      payload,
    });
    return requestId;
  }

  async respondQuestion(
    payload: QuestionRespondCommand['payload'],
    requestId = nextRequestId('question')
  ): Promise<string> {
    await this.sendReady({
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId,
      type: 'question.respond',
      payload,
    });
    return requestId;
  }

  /** List CC session history summaries for a workspace (C-06). */
  async listHistory(workspacePath: string): Promise<HistorySessionSummary[]> {
    const command: SessionListHistoryCommand = {
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId: nextRequestId('listHistory'),
      type: 'session.listHistory',
      payload: { workspacePath },
    };
    const event = (await this.requestAndWait(
      command,
      'session.historyListed'
    )) as SessionHistoryListedEvent;
    if (event.payload.error) {
      throw new Error(`${event.payload.error.code}: ${event.payload.error.message}`);
    }
    return event.payload.sessions;
  }

  /**
   * Send a command and wait for the correlated response event (matched by
   * requestId + eventType), or a correlated host.error, or Host exit, or timeout.
   *
   * This is deliberately NOT the "timeout but still alive → resolve" philosophy of
   * waitForReady (startup readiness is inherently racy and best-effort). A query
   * command must always get an answer: if the Host process dies mid-wait we reject
   * immediately rather than let the caller hang until the timeout fires, and an
   * old Host that doesn't understand the command replies with a correlated
   * host.error (code: 'not_implemented'), which also rejects.
   */
  private requestAndWait(
    command: AgentHostCommand,
    eventType: RuntimeEventType,
    timeoutMs = 10_000
  ): Promise<RuntimeEvent> {
    return new Promise<RuntimeEvent>((resolve, reject) => {
      void (async () => {
        try {
          await this.ensureStarted();
        } catch (error) {
          reject(error as Error);
          return;
        }

        const proc = this.process;
        if (!proc?.isRunning) {
          reject(new Error('Agent Host is not running'));
          return;
        }

        const cleanup = () => {
          clearTimeout(timer);
          proc.off('event', onEvent);
          proc.off('exit', onExit);
        };

        const onEvent = (event: RuntimeEvent) => {
          if (event.requestId !== command.requestId) return;
          if (event.type === eventType) {
            cleanup();
            resolve(event);
            return;
          }
          if (event.type === 'host.error') {
            cleanup();
            reject(new Error(`${event.payload.code}: ${event.payload.message}`));
          }
        };
        const onExit = () => {
          cleanup();
          reject(new Error('Agent Host exited while waiting for a response'));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for ${eventType}`));
        }, timeoutMs);

        proc.on('event', onEvent);
        proc.on('exit', onExit);

        try {
          this.send(command);
        } catch (error) {
          cleanup();
          reject(error as Error);
        }
      })();
    });
  }

  async shutdown(): Promise<void> {
    // Concurrent shutdown() calls share the same in-flight promise rather
    // than racing two `proc.stop()` calls against each other (D47 S3b I5).
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    const task = this.shutdownInternal();
    this.shutdownPromise = task;
    try {
      await task;
    } finally {
      if (this.shutdownPromise === task) {
        this.shutdownPromise = null;
      }
    }
  }

  private async shutdownInternal(): Promise<void> {
    const proc = this.process;
    this.process = null;
    this.state = 'stopped';
    if (proc) {
      await proc.stop();
    }
  }

  /**
   * Wire every channel the Host process can speak on.
   *
   * Extracted from `startInternal()` so the wiring is reachable from tests —
   * `startInternal()` spawns a real process and cannot run under vitest.
   *
   * `stderr` and `error` were both unhandled before 2026-07-28. That made
   * Host-side failures invisible (nothing reached main.log, so a bad `cwd`
   * surfaced only as a generic "Session failed" in the UI), and an unhandled
   * `error` event on an EventEmitter throws — a spawn failure would have taken
   * the Main process down instead of degrading to an error state.
   */
  private attachProcessHandlers(proc: AgentHostProcess): void {
    proc.on('event', (event: RuntimeEvent) => {
      this.trackOpenSession(event);
      for (const handler of this.eventHandlers) {
        handler(event);
      }
      if (event.type === 'host.ready') {
        this.state = 'ready';
        // S7: normalize `undefined` (field absent — an old Host build) to
        // `null` too, so `settings` always reads as "known: none" rather
        // than silently keeping a PRIOR ready event's diagnostics around.
        this.settings = (event as HostReadyEvent).payload.settings ?? null;
        // S3 slice 6 (A5): same normalization for `capabilities` — an old Host
        // build that never sends the field must not leave a PRIOR ready
        // event's capabilities (e.g. a stale `agents` list) looking current.
        this.capabilities = (event as HostReadyEvent).payload.capabilities ?? null;
      }
      if (
        event.type === 'host.error' &&
        (event as { payload?: { fatal?: boolean } }).payload?.fatal
      ) {
        this.state = 'error';
      }
    });

    let stderrPending = '';
    let recentStderr: string[] = [];
    // F2 S5 — scoped to THIS process's lifecycle, like `stderrPending` /
    // `recentStderr` above: a fresh Host spawn (a fresh `attachProcessHandlers`
    // call) gets a fresh flag. Prevents a double broadcast when 'error' fires
    // first (a spawn-level failure) and Node then also emits 'exit' for the
    // same failure.
    let hostExitBroadcastSent = false;

    /**
     * F2 S5 §6.2 — the ONE broadcast for a non-clean Host death, scoped to
     * whatever `openSessions` says is still open at that instant.
     * `session.status(disconnected)` first (an existing `SessionRuntimeStatus`
     * member, zero protocol addition), then `session.failed` — the ONLY
     * judgment-carrying red-card entry per §6.1, which is what lets the
     * renderer's existing `isSessionFailedForSend` channel pick this up with
     * no new wiring on that side either. Dispatched through
     * `dispatchSyntheticEvent`, i.e. the same `this.eventHandlers` set every
     * real Host event already flows through — `chat.ts`'s
     * `broadcastRuntimeEvent` and `SessionIndexService.handleRuntimeEvent`
     * both see it exactly as if the (now-dead) Host had sent it.
     */
    const broadcastHostExit = (message: string) => {
      if (hostExitBroadcastSent) return;
      hostExitBroadcastSent = true;
      const sessionIds = [...this.openSessions];
      this.openSessions.clear();
      for (const sessionId of sessionIds) {
        this.dispatchSyntheticEvent({
          type: 'session.status',
          sessionId,
          seq: this.nextSyntheticSeq(),
          timestamp: Date.now(),
          payload: { status: 'disconnected' },
        } satisfies SessionStatusEvent);
        this.dispatchSyntheticEvent({
          type: 'session.failed',
          sessionId,
          seq: this.nextSyntheticSeq(),
          timestamp: Date.now(),
          payload: { error: message },
        } satisfies SessionTerminalEvent);
      }
    };

    /**
     * Replay the buffered tail at `error` level. File logging ships at 'error'
     * only unless the user enables it, so a failure must escalate its own
     * context or the log stays empty exactly when it is needed.
     */
    const dumpRecentStderr = (reason: string) => {
      if (recentStderr.length === 0) return;
      log.error(`[agent-host] recent stderr (${reason}), ${recentStderr.length} line(s):`);
      for (const line of recentStderr) {
        log.error(`[agent-host:stderr] ${line}`);
      }
    };

    proc.on('stderr', (chunk: string) => {
      const drained = drainStderrLines(stderrPending, chunk);
      stderrPending = drained.pending;
      recentStderr = pushRecentStderr(recentStderr, drained.lines);
      for (const line of drained.lines) {
        log.info(`[agent-host:stderr] ${line}`);
      }
    });

    proc.on('error', (err: Error) => {
      // Spawn-level failure (bad nodeExecPath, missing entry file, EACCES).
      // The Host never came up, so no host.error event will ever arrive.
      log.error('[agent-host] process error', err);
      dumpRecentStderr('process error');
      if (this.process === proc) {
        this.state = 'error';
      }
      // F2 S5: a spawn-level 'error' has no code/signal — it is never our own
      // clean shutdown() path — and may or may not be followed by 'exit'
      // (Node's behavior here is platform-dependent). Broadcast unconditionally
      // so "error with no exit" (§6.2) is still covered; `hostExitBroadcastSent`
      // dedups against a following 'exit' for the same failure.
      broadcastHostExit(`Agent Host process error: ${err.message}`);
    });

    proc.on('exit', (payload?: { code: number | null; signal: string | null }) => {
      const trailing = flushStderrPending(stderrPending);
      recentStderr = pushRecentStderr(recentStderr, trailing);
      for (const line of trailing) {
        log.info(`[agent-host:stderr] ${line}`);
      }
      stderrPending = '';

      const code = payload?.code ?? null;
      const signal = payload?.signal ?? null;
      // code 0 / SIGTERM is our own shutdown() path — not worth an error dump.
      const clean = code === 0 || signal === 'SIGTERM';
      if (clean) {
        log.info(`[agent-host] exited code=${code} signal=${signal}`);
      } else {
        log.error(`[agent-host] exited code=${code} signal=${signal}`);
        dumpRecentStderr('unexpected exit');
        // F2 S5 §6.2: a non-clean exit means every session this process still
        // considered open just lost its Host without a verdict — broadcast so
        // none of them are left showing 'running' forever (the S3 queue-hold
        // gap this slice is the strong-order prerequisite for).
        broadcastHostExit(`Agent Host exited (code=${code} signal=${signal})`);
      }
      recentStderr = [];

      if (this.process === proc) {
        this.process = null;
        this.state = 'stopped';
      }
    });
  }

  /**
   * F2 S5 (2026-08-18, spec §6.2) — keeps `openSessions` current off the SAME
   * event stream every RuntimeEvent already flows through; no new listener.
   */
  private trackOpenSession(event: RuntimeEvent): void {
    const sessionId = event.sessionId;
    if (!sessionId) return;
    if (event.type === 'session.created' || event.type === 'session.resumed') {
      this.openSessions.add(sessionId);
      return;
    }
    if (event.type === 'session.status') {
      const status = (event as SessionStatusEvent).payload.status;
      if (CLOSED_SESSION_STATUSES.has(status)) {
        this.openSessions.delete(sessionId);
      } else {
        this.openSessions.add(sessionId);
      }
    }
  }

  private nextSyntheticSeq(): number {
    this.syntheticEventSeq += 1;
    return this.syntheticEventSeq;
  }

  /**
   * F2 S5 — dispatch a Main-synthesized RuntimeEvent through the same
   * forwarding point real Host events go through (`this.eventHandlers`).
   * Zero new IPC channel: `chat.ts`'s `broadcastRuntimeEvent` and
   * `SessionIndexService.handleRuntimeEvent` are both already subscribed.
   */
  private dispatchSyntheticEvent(event: RuntimeEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  private async startInternal(): Promise<void> {
    this.state = 'starting';
    const resolved = await resolveNode24Runtime({
      bundledPath: getBundledNodeRuntimePath(),
    });
    if (!resolved.ok || !resolved.runtime) {
      this.state = 'error';
      throw new Error(resolved.error ?? 'Node 24 not found');
    }

    const hostEntryPath = resolveHostEntryPath();
    const useStripTypes = hostEntryPath.endsWith('.ts');
    const codexJsPath = resolveCodexJsPathForEnv(hostEntryPath);
    // D47 S3b §1 — resolved fresh on every spawn (never cached on `this`), so
    // a Host that (re)starts after a login/logout regenerate always reads the
    // CURRENT vault snapshot instead of whatever was true the last time a
    // Host came up (the I5 epoch barrier on `ensureStarted`/`shutdown` above
    // is what makes "always fresh at spawn time" actually hold).
    const codexManagedEnv = resolveCodexManagedHostEnv();
    // S0' (D60): same per-spawn freshness rule as the Codex resolver above.
    const claudeManagedEnv = resolveClaudeManagedHostEnv();
    const proc = new AgentHostProcess({
      nodeExecPath: resolved.runtime.execPath,
      hostEntryPath,
      nodeArgs: useStripTypes ? ['--experimental-strip-types'] : [],
      env: buildAgentHostEnv({
        driver: this.driver,
        cometixVersion: COMETIX_PIN.version,
        nodeExecPath: resolved.runtime.execPath,
        appVersion: app.getVersion(),
        codexManaged: codexManagedEnv.codexManaged,
        codexApiKey: codexManagedEnv.codexApiKey,
        codexBaseUrl: codexManagedEnv.codexBaseUrl,
        codexJsPath,
        claudeBaseUrl: claudeManagedEnv.claudeBaseUrl,
        claudeAuthToken: claudeManagedEnv.claudeAuthToken,
      }),
    });

    this.attachProcessHandlers(proc);

    this.process = proc;
    await proc.start();

    proc.send({
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId: `init-${Date.now()}`,
      type: 'host.initialize',
      payload: { driver: this.driver },
    });

    await waitForReady(proc, 15000);
    this.state = 'ready';
  }
}

/**
 * Packaged builds ship a pinned Node runtime under resources/node-runtime
 * (C-15/D17, multi-platform since D36) — preferred over machine Node
 * discovery. Dev returns undefined so development behavior is unchanged.
 *
 * Gated on NODE_RUNTIME_PINS rather than on Windows: every platform we bundle
 * a runtime for gets one returned, and platforms without a pin (mac today)
 * return undefined so the resolver is never handed a candidate that cannot
 * exist. The previous "Windows-only on purpose" note is obsolete — the chain
 * is win-x64 + linux-x64 as of D36.
 *
 * NOTE FOR REVERTS: this function is the single switch that decides whether an
 * already-installed Linux user's Agent Host keeps using their machine Node or
 * moves to the bundled 24.18.0. That is a runtime replacement, not a pure
 * addition (packaging spec §5.4 risk register).
 *
 * The rollback is THIS FUNCTION, not a commit revert. `b8cfe15` isolated the
 * switch, but a later formatting pass (`485decc`) rewrote test files that
 * commit had added, so `git revert b8cfe15` no longer applies cleanly —
 * verified 2026-08-20 by reverse-applying the patch, which fails on
 * scripts/__tests__/node-runtime-pin.test.mjs. Reverting it would also drop the
 * three-table consistency tests, which have nothing to do with this switch.
 *
 * To put Linux back on machine Node: gate this function to win32 again
 * (`if (process.platform !== 'win32') return undefined;`) and leave everything
 * else in place.
 */
export function getBundledNodeRuntimePath(): string | undefined {
  if (!app.isPackaged) return undefined;
  const binaryName = bundledNodeRuntimeBinaryFor(process.platform, process.arch);
  if (!binaryName) return undefined;
  return path.join(process.resourcesPath, 'node-runtime', binaryName);
}

/**
 * `statSync().isFile()` rather than `existsSync()`: a same-named directory or a
 * zero-byte leftover must count as unusable. Feeding a non-file path into the
 * env would push the failure from "diagnosable in Main" out to "the Host
 * explodes at spawn time" (packaging spec §4.2, B-8).
 */
function isUsableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * The three injection criteria (packaging spec §4.2), in order:
 *
 * 1. A non-empty user-set `AICLIENT_CODEX_JS_PATH` wins — we omit the key so
 *    their value passes through untouched. This escape hatch is only reachable
 *    when the app is launched from a terminal or the variable is set at system
 *    level; Dock/desktop launches do not inherit a login shell (改判 ③).
 * 2. Otherwise inject the bundled path when it is a real, non-empty file.
 * 3. Otherwise omit the key, leaving the Host's candidate rules 2/3/4 to find a
 *    user-global install — the pre-existing behaviour on mac and on any build
 *    without a bundled codex.
 */
export function resolveCodexJsPathForEnv(hostEntryPath: string): string | undefined {
  const userOverride = process.env[CODEX_JS_PATH_ENV_KEY]?.trim();
  if (userOverride) return undefined;
  const bundled = deriveBundledCodexJsPath(hostEntryPath);
  return isUsableFile(bundled) ? bundled : undefined;
}

/**
 * Where the Host artifact lives — the one source of truth, exported because
 * `ClaudeRuntimeChecker` derives the bundled Claude runtime's path from it too.
 */
export function resolveHostEntryPath(): string {
  // Packaged: prebuilt JS under resources/agent-host.
  // Dev: TypeScript entry via Node 24 --experimental-strip-types.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'agent-host', 'index.js');
  }
  return path.join(app.getAppPath(), 'src', 'agent-host', 'index.ts');
}

function waitForReady(proc: AgentHostProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      if (proc.isRunning) resolve();
      else reject(new Error('Agent Host failed to become ready'));
    }, timeoutMs);

    const onEvent = (event: RuntimeEvent) => {
      if (event.type === 'host.ready') {
        cleanup();
        resolve();
      }
      if (event.type === 'host.error') {
        const fatal = (event as { payload?: { fatal?: boolean } }).payload?.fatal;
        if (fatal) {
          cleanup();
          reject(new Error(String((event as { payload?: { message?: string } }).payload?.message)));
        }
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error('Agent Host exited before ready'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      proc.off('event', onEvent);
      proc.off('exit', onExit);
    };
    proc.on('event', onEvent);
    proc.on('exit', onExit);
  });
}

/** Singleton used by IPC + app cleanup. */
export const agentHostManager = new AgentHostManager();
