import path from 'node:path';
import { COMETIX_PIN } from '@shared/agentHost/cometixPin';
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
} from '@shared/types/runtimeEvents';
import type { HistorySessionSummary } from '@shared/types/sessionHistory';
import { app } from 'electron';
import log from '../../utils/logger';
import { getCredentialVault } from '../auth';
import { resolveManagedCredentialsEnabled } from '../auth/AuthStateService';
import { AgentHostProcess } from './AgentHostProcess';
import { buildAgentHostEnv } from './hostEnv';
import { drainStderrLines, flushStderrPending, pushRecentStderr } from './hostStderr';
import { resolveNode24Runtime } from './NodeRuntimeResolver';

const CODEX_HOME_DIR_NAME = 'codex-home';

/**
 * D47 S3b §1 — the three Codex managed-credentials `buildAgentHostEnv` inputs,
 * resolved from the managed-credentials flag + a FRESH vault snapshot (never
 * cached across Host restarts, so a login/logout that happened while the Host
 * was down is picked up the next time `ensureStarted()` spawns a new one —
 * this is what the I5 epoch barrier below exists to make possible). Flag off
 * returns all three `undefined` — `hostEnv.ts`'s "继承污染防御" contract
 * needs that to kill any stray inherited value, not merely omit the key.
 */
export function resolveCodexManagedHostEnv(): {
  codexManaged: string | undefined;
  codexApiKey: string | undefined;
  codexHomeManagedDir: string | undefined;
} {
  if (!resolveManagedCredentialsEnabled()) {
    return { codexManaged: undefined, codexApiKey: undefined, codexHomeManagedDir: undefined };
  }
  const codexHomeManagedDir = path.join(app.getPath('userData'), CODEX_HOME_DIR_NAME);
  const vaultResult = getCredentialVault().read();
  const codexApiKey =
    vaultResult.status === 'ok' ? vaultResult.doc.payload.codex.apiKey : undefined;
  return { codexManaged: '1', codexApiKey, codexHomeManagedDir };
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
      }
      recentStderr = [];

      if (this.process === proc) {
        this.process = null;
        this.state = 'stopped';
      }
    });
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
    // D47 S3b §1 — resolved fresh on every spawn (never cached on `this`), so
    // a Host that (re)starts after a login/logout regenerate always reads the
    // CURRENT vault snapshot instead of whatever was true the last time a
    // Host came up (the I5 epoch barrier on `ensureStarted`/`shutdown` above
    // is what makes "always fresh at spawn time" actually hold).
    const codexManagedEnv = resolveCodexManagedHostEnv();
    const proc = new AgentHostProcess({
      nodeExecPath: resolved.runtime.execPath,
      hostEntryPath,
      nodeArgs: useStripTypes ? ['--experimental-strip-types'] : [],
      env: buildAgentHostEnv({
        driver: this.driver,
        cometixVersion: COMETIX_PIN.version,
        nodeExecPath: resolved.runtime.execPath,
        appVersion: app.getVersion(),
        codexHomeDir: path.join(app.getPath('userData'), CODEX_HOME_DIR_NAME),
        codexManaged: codexManagedEnv.codexManaged,
        codexApiKey: codexManagedEnv.codexApiKey,
        codexHomeManagedDir: codexManagedEnv.codexHomeManagedDir,
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
 * Packaged Windows builds ship a pinned node.exe under resources/node-runtime
 * (C-15/D17) — preferred over machine Node discovery. Dev returns undefined
 * so development behavior is unchanged.
 *
 * Windows-only on purpose: the whole chain is win-x64 (fetch-node-runtime.mjs
 * downloads the Windows zip, afterPack.mjs copies node.exe, verify-packaged-app
 * asserts it). On packaged macOS/Linux there is no bundled runtime to find, so
 * returning a path here only fed the resolver a candidate that could never
 * exist; those platforms fall back to machine Node discovery by design.
 */
export function getBundledNodeRuntimePath(): string | undefined {
  if (!app.isPackaged) return undefined;
  if (process.platform !== 'win32') return undefined;
  return path.join(process.resourcesPath, 'node-runtime', 'node.exe');
}

function resolveHostEntryPath(): string {
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
