import { resolve as resolvePath } from 'node:path';
import {
  IPC_CHANNELS,
  type SessionAttachOptions,
  type SessionAttachResult,
  type SessionCreateOptions,
  type SessionDataEvent,
  type SessionDescriptor,
  type SessionExitEvent,
  type SessionOpenResult,
  type SessionRuntimeState,
  type SessionStateEvent,
} from '@shared/types';
import { BrowserWindow, type WebContents } from 'electron';
import { getCredentialVault } from '../auth';
import { ensureWorkspaceTrusted, getEffectiveClaudeJsonPath } from '../auth/claudeHome';
import { resolveManagedCredentialsEnabled } from '../auth/credentialMode';
import { assertAgentSpawnAllowed } from '../auth/spawnGate';
import { resolveManagedPiPtyEnv } from '../piModelConfig';
import { remoteConnectionManager } from '../remote/RemoteConnectionManager';
import { isRemoteVirtualPath, parseRemoteVirtualPath } from '../remote/RemotePath';
import { PtyManager } from '../terminal/PtyManager';

interface ManagedSessionRecord extends SessionDescriptor {
  attachedWindowIds: Set<number>;
  connectionId?: string;
  runtimeState?: SessionRuntimeState;
  replayBuffer?: string;
  streamState?: 'buffering' | 'attaching' | 'live';
  pendingExit?: SessionExitEvent;
}

const MAX_SESSION_REPLAY_CHARS = 65_536;

/**
 * S0' (D60) — why there is no Codex twin of `withManagedClaudeEnv` below.
 *
 * There used to be one. A local terminal PTY got `CODEX_HOME` pointed at the
 * app-owned `<userData>/codex-home` plus `AICLIENT_CODEX_API_KEY`, so a user
 * typing `codex` in our terminal reached the company gateway. Both halves were
 * needed together: the key only authenticated because the `config.toml` in that
 * directory named it via `env_key`.
 *
 * D60 removed the directory, and the pair cannot be split. The key alone means
 * nothing to a user's own `~/.codex` (their provider names some other variable,
 * or none), and there is no environment variable that can point codex at a
 * different `base_url` — the provider table only exists in config.
 *
 * So a terminal `codex` now runs on the user's own configuration. That is the
 * correct default under D60 and it is also a BEHAVIOUR CHANGE for anyone who
 * relied on the terminal inheriting the gateway; registered as an open question
 * on the `unified-credentials` plan rather than papered over here.
 *
 * The asymmetry with Claude is not an oversight: `ANTHROPIC_BASE_URL` /
 * `ANTHROPIC_AUTH_TOKEN` are names the Claude CLI reads directly, so the Claude
 * credential needs no file and no directory. Codex has no equivalent pair.
 */

/**
 * S0' (D60) — the Claude credential for a local terminal PTY.
 *
 * A user who types `claude` in our terminal is running the real CLI, which
 * authenticates from `ANTHROPIC_*` env or from their own settings.json. Before
 * D60 they got ours by inheriting the redirected `CLAUDE_CONFIG_DIR` — which
 * also handed them our stripped-down home instead of their own commands,
 * skills and CLAUDE.md. Now they get the credential and keep their home.
 *
 * Unlike the Codex twin above these keys are `ANTHROPIC_*`, the names the CLI
 * actually reads; there is no indirection to point at a private name here.
 * They are spread LAST so Main's values win over a renderer-supplied
 * same-named key, matching the Codex "合并向" rule.
 *
 * `null` (flag off) returns the SAME `options` reference — not even a shallow
 * copy, so a user's own shell `ANTHROPIC_AUTH_TOKEN` stays exactly as they
 * set it ("this slice didn't touch that key" ≠ "the key doesn't exist").
 * Both halves must be present for the same reason `claudeSettings.ts` requires
 * both: a base URL paired with someone else's token is a cross-account
 * request.
 */
function withManagedClaudeEnv(options: SessionCreateOptions): SessionCreateOptions {
  if (!resolveManagedCredentialsEnabled()) {
    return options;
  }
  const vaultResult = getCredentialVault().read();
  if (vaultResult.status !== 'ok') {
    return options;
  }
  // Optional-chained, not destructured: `payload.claude` is absent in older
  // vault documents (and in any fixture written before the arm existed), and
  // a missing arm must degrade to "no managed credential" exactly like an
  // empty one — never throw inside a session create.
  const baseUrl = vaultResult.doc.payload.claude?.baseUrl;
  const authToken = vaultResult.doc.payload.claude?.authToken;
  if (!baseUrl || !authToken) {
    return options;
  }
  return {
    ...options,
    env: {
      ...options.env,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: authToken,
    },
  };
}

/** Q8: agent PTYs inherit the managed Pi directory, whose auth.json carries the company key. */
function withManagedPiEnv(options: SessionCreateOptions): SessionCreateOptions {
  if (options.kind !== 'agent' || !resolveManagedCredentialsEnabled()) return options;
  return {
    ...options,
    env: {
      ...options.env,
      ...resolveManagedPiPtyEnv(),
    },
  };
}

function getWindowId(target: BrowserWindow | WebContents | number): number {
  if (typeof target === 'number') {
    return target;
  }

  if (target instanceof BrowserWindow) {
    return target.id;
  }

  const window = BrowserWindow.fromWebContents(target);
  if (!window) {
    throw new Error('Window not found for session');
  }
  return window.id;
}

function now(): number {
  return Date.now();
}

export class SessionManager {
  readonly localPtyManager = new PtyManager();

  private readonly sessions = new Map<string, ManagedSessionRecord>();
  private readonly remoteSubscriptions = new Map<
    string,
    {
      offData: () => void;
      offExit: () => void;
    }
  >();
  private readonly remoteSubscriptionPromises = new Map<string, Promise<void>>();
  private readonly remoteSubscriptionVersions = new Map<string, number>();
  private readonly remoteDisconnectSubscriptions = new Map<string, () => void>();
  private readonly remoteStatusSubscriptions = new Map<string, () => void>();
  private readonly remoteRecoveryPromises = new Map<string, Promise<void>>();

  async create(
    target: BrowserWindow | WebContents | number,
    options: SessionCreateOptions = {}
  ): Promise<SessionOpenResult> {
    // D47 S5 §3 — agent-session-only spawn gate: only the `kind === 'agent'`
    // arm (the PTY-based AgentTerminal path — `useXterm`'s `kind:'agent'`)
    // is gated; plain terminal sessions must keep working even while
    // credentials are invalid (git, shells, etc. don't depend on the
    // managed key). `attach` (below) is a separate method, never gated —
    // reconnecting to an already-running session touches no credentials.
    if (options.kind === 'agent') {
      assertAgentSpawnAllowed();
    }
    const windowId = getWindowId(target);
    if (options.cwd && isRemoteVirtualPath(options.cwd)) {
      return this.createRemote(windowId, options);
    }
    // D47 S2a trust call matrix entry ③ — the common local-session throat
    // for both the legacy Terminal IPC and the newer generic Session IPC.
    // Remote paths never reach here (already routed to createRemote above,
    // I8 no-op).
    await this.ensureWorkspaceTrustedForLocalCreate(options.cwd);
    return this.createLocal(windowId, options);
  }

  private async ensureWorkspaceTrustedForLocalCreate(cwd: string | undefined): Promise<void> {
    if (!resolveManagedCredentialsEnabled()) return;
    if (!cwd) return;
    // D60: the user's own `.claude.json`, merged — see the chat.ts twin.
    await ensureWorkspaceTrusted(getEffectiveClaudeJsonPath(), resolvePath(cwd));
  }

  async attach(
    target: BrowserWindow | WebContents | number,
    options: SessionAttachOptions
  ): Promise<SessionAttachResult> {
    const windowId = getWindowId(target);
    const existing = this.sessions.get(options.sessionId);
    if (existing?.backend === 'local') {
      existing.attachedWindowIds.add(windowId);
      const replay = existing.replayBuffer || undefined;
      if (existing.streamState === 'buffering') {
        existing.streamState = 'attaching';
        this.activateLocalStreamAfterAttach(existing.sessionId, existing.replayBuffer?.length ?? 0);
      }
      return {
        session: this.toDescriptor(existing),
        replay,
      };
    }

    if (existing?.backend === 'remote' && existing.connectionId) {
      existing.attachedWindowIds.add(windowId);
      const status = remoteConnectionManager.getStatus(existing.connectionId);
      if (!status.connected) {
        const runtimeState = status.recoverable ? 'reconnecting' : 'dead';
        this.setSessionRuntimeState(existing.sessionId, runtimeState);
        this.emitState(
          {
            sessionId: existing.sessionId,
            state: existing.runtimeState ?? runtimeState,
          },
          new Set([windowId])
        );
        return {
          session: this.toDescriptor(existing),
          replay: existing.replayBuffer || undefined,
        };
      }

      try {
        await this.ensureRemoteSubscriptions(existing.connectionId);
        const result = await remoteConnectionManager.call<SessionAttachResult>(
          existing.connectionId,
          'session:attach',
          {
            sessionId: options.sessionId,
          }
        );
        const record = this.registerRemoteSession(windowId, existing.connectionId, result.session);
        this.setSessionRuntimeState(record.sessionId, 'live');
        record.replayBuffer = result.replay ?? '';
        return {
          session: this.toDescriptor(record),
          replay: result.replay,
        };
      } catch (error) {
        const nextStatus = remoteConnectionManager.getStatus(existing.connectionId);
        if (!nextStatus.connected) {
          const runtimeState = nextStatus.recoverable ? 'reconnecting' : 'dead';
          this.setSessionRuntimeState(existing.sessionId, runtimeState);
          this.emitState(
            {
              sessionId: existing.sessionId,
              state: existing.runtimeState ?? runtimeState,
            },
            new Set([windowId])
          );
          return {
            session: this.toDescriptor(existing),
            replay: existing.replayBuffer || undefined,
          };
        }
        throw error;
      }
    }

    if (!options.cwd || !isRemoteVirtualPath(options.cwd)) {
      throw new Error(`Session not found: ${options.sessionId}`);
    }

    const { connectionId } = parseRemoteVirtualPath(options.cwd);
    await this.ensureRemoteSubscriptions(connectionId);
    const result = await remoteConnectionManager.call<SessionAttachResult>(
      connectionId,
      'session:attach',
      {
        sessionId: options.sessionId,
      }
    );
    const record = this.registerRemoteSession(windowId, connectionId, result.session);
    this.setSessionRuntimeState(record.sessionId, 'live');
    record.replayBuffer = result.replay ?? '';
    return {
      session: this.toDescriptor(record),
      replay: result.replay,
    };
  }

  list(target: BrowserWindow | WebContents | number): SessionDescriptor[] {
    const windowId = getWindowId(target);
    return [...this.sessions.values()]
      .filter((session) => session.attachedWindowIds.has(windowId))
      .map((session) => this.toDescriptor(session));
  }

  async detach(target: BrowserWindow | WebContents | number, sessionId: string): Promise<void> {
    const windowId = getWindowId(target);
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.attachedWindowIds.delete(windowId);
    if (session.backend === 'remote' && session.connectionId) {
      await this.ensureRemoteSubscriptions(session.connectionId);
      await remoteConnectionManager
        .call(session.connectionId, 'session:detach', { sessionId })
        .catch(() => {});
      if (session.attachedWindowIds.size === 0) {
        this.sessions.delete(sessionId);
      }
      return;
    }

    if (session.attachedWindowIds.size > 0) {
      return;
    }

    if (session.persistOnDisconnect) {
      session.streamState = 'buffering';
      return;
    }

    this.localPtyManager.destroy(sessionId);
    this.sessions.delete(sessionId);
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.backend === 'remote' && session.connectionId) {
      const attachedWindowIds = new Set(session.attachedWindowIds);
      await this.ensureRemoteSubscriptions(session.connectionId);
      await remoteConnectionManager
        .call(session.connectionId, 'session:kill', { sessionId })
        .catch(() => {});
      this.sessions.delete(sessionId);
      this.emitState(
        {
          sessionId,
          state: 'dead',
        },
        attachedWindowIds
      );
      this.emitExit(
        {
          sessionId,
          exitCode: 0,
        },
        attachedWindowIds
      );
      return;
    }

    const attachedWindowIds = new Set(session.attachedWindowIds);
    this.localPtyManager.destroy(sessionId);
    this.sessions.delete(sessionId);
    this.emitExit(
      {
        sessionId,
        exitCode: 0,
      },
      attachedWindowIds
    );
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.backend === 'remote' && session.connectionId) {
      if (session.runtimeState && session.runtimeState !== 'live') {
        return;
      }
      const { connectionId } = session;
      void this.ensureRemoteSubscriptions(connectionId)
        .then(() =>
          remoteConnectionManager.call(connectionId, 'session:write', { sessionId, data })
        )
        .catch(() => {
          this.setSessionRuntimeState(sessionId, 'reconnecting');
        });
      return;
    }

    this.localPtyManager.write(sessionId, data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.backend === 'remote' && session.connectionId) {
      if (session.runtimeState && session.runtimeState !== 'live') {
        return;
      }
      const { connectionId } = session;
      void this.ensureRemoteSubscriptions(connectionId)
        .then(() =>
          remoteConnectionManager.call(connectionId, 'session:resize', {
            sessionId,
            cols,
            rows,
          })
        )
        .catch(() => {
          this.setSessionRuntimeState(sessionId, 'reconnecting');
        });
      return;
    }

    this.localPtyManager.resize(sessionId, cols, rows);
  }

  async getActivity(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    if (session.backend === 'remote' && session.connectionId) {
      await this.ensureRemoteSubscriptions(session.connectionId);
      return remoteConnectionManager
        .call<boolean>(session.connectionId, 'session:getActivity', { sessionId })
        .catch(() => false);
    }

    return this.localPtyManager.getProcessActivity(sessionId);
  }

  async detachWindowSessions(windowId: number): Promise<void> {
    const ids = [...this.sessions.values()]
      .filter((session) => session.attachedWindowIds.has(windowId))
      .map((session) => session.sessionId);

    await Promise.allSettled(ids.map((sessionId) => this.detach(windowId, sessionId)));
  }

  async killByWorkdir(workdir: string): Promise<void> {
    const caseInsensitivePaths = process.platform === 'win32' || process.platform === 'darwin';
    const normalizeForComparison = (value: string) => {
      const normalized = value.replace(/\\/g, '/');
      return caseInsensitivePaths ? normalized.toLowerCase() : normalized;
    };

    const normalized = normalizeForComparison(workdir);
    const matches = [...this.sessions.values()].filter((session) => {
      const sessionCwd = normalizeForComparison(session.cwd);
      return sessionCwd === normalized || sessionCwd.startsWith(`${normalized}/`);
    });

    await Promise.allSettled(matches.map((session) => this.kill(session.sessionId)));
  }

  destroyAllLocal(): void {
    this.localPtyManager.destroyAll();
  }

  async destroyAllLocalAndWait(): Promise<void> {
    await this.localPtyManager.destroyAllAndWait();
  }

  private createLocal(windowId: number, options: SessionCreateOptions): SessionOpenResult {
    const kind = options.kind ?? 'terminal';
    const cwd = options.cwd || process.env.HOME || process.env.USERPROFILE || '/';
    const sessionId = this.localPtyManager.allocateId();
    const record: ManagedSessionRecord = {
      sessionId,
      backend: 'local',
      kind,
      cwd,
      persistOnDisconnect: Boolean(options.persistOnDisconnect),
      createdAt: now(),
      metadata: options.metadata,
      attachedWindowIds: new Set([windowId]),
      replayBuffer: '',
      streamState: 'buffering',
    };
    this.sessions.set(sessionId, record);

    try {
      this.localPtyManager.create(
        // A no-op (the SAME object reference, not even a shallow copy) when the
        // managed-credentials flag is off. The Codex injector that used to be
        // composed here retired with S0'/D60 — see the note above
        // `withManagedClaudeEnv` for why it has no replacement.
        withManagedPiEnv(withManagedClaudeEnv(options)),
        (data) => this.handleLocalData(sessionId, data),
        (exitCode, signal) => {
          this.handleLocalExit(sessionId, exitCode, signal);
        },
        sessionId
      );
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }

    return {
      session: this.toDescriptor(record),
    };
  }

  private async createRemote(
    windowId: number,
    options: SessionCreateOptions
  ): Promise<SessionOpenResult> {
    const { connectionId, remotePath } = parseRemoteVirtualPath(options.cwd!);
    await this.ensureRemoteSubscriptions(connectionId);
    const result = await remoteConnectionManager.call<SessionOpenResult>(
      connectionId,
      'session:createAndAttach',
      {
        options: {
          ...options,
          cwd: remotePath,
          spawnCwd: undefined,
          shellConfig: options.shellConfig,
          shell: options.shell,
          persistOnDisconnect: options.persistOnDisconnect ?? true,
        },
      }
    );
    const record = this.registerRemoteSession(windowId, connectionId, result.session);
    record.replayBuffer = result.replay ?? '';
    return {
      session: this.toDescriptor(record),
      replay: result.replay,
    };
  }

  private registerRemoteSession(
    windowId: number,
    connectionId: string,
    descriptor: SessionDescriptor
  ): ManagedSessionRecord {
    const existing = this.sessions.get(descriptor.sessionId);
    if (existing) {
      existing.attachedWindowIds.add(windowId);
      existing.connectionId = connectionId;
      existing.cwd = descriptor.cwd;
      existing.kind = descriptor.kind;
      existing.persistOnDisconnect = descriptor.persistOnDisconnect;
      existing.metadata = descriptor.metadata;
      existing.runtimeState = existing.runtimeState ?? 'live';
      return existing;
    }

    const record: ManagedSessionRecord = {
      ...descriptor,
      backend: 'remote',
      connectionId,
      runtimeState: 'live',
      attachedWindowIds: new Set([windowId]),
    };
    this.sessions.set(record.sessionId, record);
    return record;
  }

  private handleLocalExit(sessionId: string, exitCode: number, signal?: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const event: SessionExitEvent = {
      sessionId,
      exitCode,
      signal,
    };

    if (session.backend === 'local' && session.streamState !== 'live') {
      session.pendingExit = event;
      return;
    }

    const attachedWindowIds = new Set(session.attachedWindowIds);
    this.sessions.delete(sessionId);
    this.emitExit(event, attachedWindowIds);
  }

  private handleLocalData(sessionId: string, data: string): void {
    if (!data) {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session || session.backend !== 'local') {
      return;
    }

    this.appendReplayBuffer(session, data);

    if (session.streamState === 'live') {
      this.emitData(sessionId, data, new Set(session.attachedWindowIds));
    }
  }

  private activateLocalStreamAfterAttach(sessionId: string, replayCursor: number): void {
    setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (!session || session.backend !== 'local' || session.streamState !== 'attaching') {
        return;
      }

      if (session.attachedWindowIds.size === 0) {
        session.streamState = 'buffering';
        return;
      }

      session.streamState = 'live';
      const replayBuffer = session.replayBuffer || '';
      const delta = replayBuffer.slice(replayCursor);
      if (delta) {
        this.emitData(sessionId, delta, new Set(session.attachedWindowIds));
      }

      if (session.pendingExit) {
        const pendingExit = session.pendingExit;
        const attachedWindowIds = new Set(session.attachedWindowIds);
        this.sessions.delete(sessionId);
        this.emitExit(pendingExit, attachedWindowIds);
      }
    }, 0);
  }

  private async ensureRemoteSubscriptions(connectionId: string): Promise<void> {
    this.ensureRemoteLifecycleSubscriptions(connectionId);
    if (this.remoteSubscriptions.has(connectionId)) {
      return;
    }

    const pending = this.remoteSubscriptionPromises.get(connectionId);
    if (pending) {
      await pending;
      return;
    }

    const subscriptionPromise = (async () => {
      const version = this.remoteSubscriptionVersions.get(connectionId) ?? 0;
      const offData = await remoteConnectionManager.addEventListener(
        connectionId,
        'remote:session:data',
        (payload) => {
          const event = payload as SessionDataEvent;
          const session = this.sessions.get(event.sessionId);
          if (session?.backend === 'remote') {
            this.appendReplayBuffer(session, event.data);
          }
          this.emitData(event.sessionId, event.data);
        }
      );

      let offExit: (() => void) | null = null;
      try {
        offExit = await remoteConnectionManager.addEventListener(
          connectionId,
          'remote:session:exit',
          (payload) => {
            const event = payload as SessionExitEvent;
            const session = this.sessions.get(event.sessionId);
            const attachedWindowIds = session
              ? new Set(session.attachedWindowIds)
              : new Set<number>();
            this.sessions.delete(event.sessionId);
            this.emitState(
              {
                sessionId: event.sessionId,
                state: 'dead',
              },
              attachedWindowIds
            );
            this.emitExit(event, attachedWindowIds);
          }
        );
      } catch (error) {
        try {
          offData();
        } catch {
          // Ignore
        }
        throw error;
      }

      if (
        (this.remoteSubscriptionVersions.get(connectionId) ?? 0) !== version ||
        this.remoteSubscriptions.has(connectionId) ||
        !remoteConnectionManager.getStatus(connectionId).connected
      ) {
        try {
          offData();
        } catch {
          // Ignore
        }
        try {
          offExit();
        } catch {
          // Ignore
        }
        return;
      }

      this.remoteSubscriptions.set(connectionId, {
        offData,
        offExit,
      });
    })().finally(() => {
      if (this.remoteSubscriptionPromises.get(connectionId) === subscriptionPromise) {
        this.remoteSubscriptionPromises.delete(connectionId);
      }
    });

    this.remoteSubscriptionPromises.set(connectionId, subscriptionPromise);
    await subscriptionPromise;
  }

  private async handleRemoteStatusChange(
    connectionId: string,
    status: { connected: boolean; phase?: string; recoverable?: boolean }
  ): Promise<void> {
    const previous = this.remoteRecoveryPromises.get(connectionId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.processRemoteStatusChange(connectionId, status))
      .catch((error) => {
        console.warn('[session] Failed to recover remote sessions:', error);
      })
      .finally(() => {
        if (this.remoteRecoveryPromises.get(connectionId) === current) {
          this.remoteRecoveryPromises.delete(connectionId);
        }
      });
    this.remoteRecoveryPromises.set(connectionId, current);
    await current;
  }

  private async processRemoteStatusChange(
    connectionId: string,
    status: { connected: boolean; phase?: string; recoverable?: boolean }
  ): Promise<void> {
    const sessions = [...this.sessions.values()].filter(
      (session) => session.backend === 'remote' && session.connectionId === connectionId
    );
    if (sessions.length === 0) {
      return;
    }

    if (status.connected) {
      await this.ensureRemoteSubscriptions(connectionId);
      const remoteSessions = await remoteConnectionManager
        .call<SessionDescriptor[]>(connectionId, 'session:list', {})
        .then((items) => new Map(items.map((item) => [item.sessionId, item])))
        .catch(() => null);
      if (!remoteSessions) {
        for (const session of sessions) {
          this.setSessionRuntimeState(session.sessionId, 'reconnecting');
        }
        return;
      }
      await Promise.allSettled(
        sessions.map(async (session) => {
          if (this.sessions.get(session.sessionId) !== session) {
            return;
          }
          const remoteSession = remoteSessions.get(session.sessionId);
          if (remoteSession) {
            try {
              const restored = await remoteConnectionManager.call<SessionAttachResult>(
                connectionId,
                'session:resume',
                {
                  sessionId: session.sessionId,
                }
              );
              if (this.sessions.get(session.sessionId) !== session) {
                return;
              }
              const mergedDescriptor = restored.session ?? remoteSession;
              session.connectionId = connectionId;
              session.cwd = mergedDescriptor.cwd;
              session.kind = mergedDescriptor.kind;
              session.persistOnDisconnect = mergedDescriptor.persistOnDisconnect;
              session.metadata = mergedDescriptor.metadata;
              const replay = restored.replay ?? '';
              const delta = this.getReplayDelta(session.replayBuffer, replay);
              session.replayBuffer = replay;
              if (delta) {
                this.emitData(session.sessionId, delta, new Set(session.attachedWindowIds));
              }
              this.setSessionRuntimeState(session.sessionId, 'live');
              return;
            } catch {
              if (this.sessions.get(session.sessionId) !== session) {
                return;
              }
              if (!remoteConnectionManager.getStatus(connectionId).connected) {
                this.setSessionRuntimeState(session.sessionId, 'reconnecting');
                return;
              }
            }
          }
          this.markRemoteSessionDead(session);
        })
      );
      return;
    }

    const nextState: SessionRuntimeState = status.recoverable ? 'reconnecting' : 'dead';
    for (const session of sessions) {
      if (this.sessions.get(session.sessionId) !== session) {
        continue;
      }
      if (nextState === 'dead') {
        this.markRemoteSessionDead(session);
        continue;
      }
      this.setSessionRuntimeState(session.sessionId, nextState);
    }
  }

  private ensureRemoteLifecycleSubscriptions(connectionId: string): void {
    if (!this.remoteDisconnectSubscriptions.has(connectionId)) {
      const offDisconnect = remoteConnectionManager.onDidDisconnect(connectionId, () => {
        this.cleanupRemoteSubscription(connectionId);
      });
      this.remoteDisconnectSubscriptions.set(connectionId, offDisconnect);
    }

    if (!this.remoteStatusSubscriptions.has(connectionId)) {
      const offStatus = remoteConnectionManager.onDidStatusChange(connectionId, (status) => {
        void this.handleRemoteStatusChange(connectionId, status);
      });
      this.remoteStatusSubscriptions.set(connectionId, offStatus);
    }
  }

  private cleanupRemoteSubscription(connectionId: string): void {
    this.remoteSubscriptionVersions.set(
      connectionId,
      (this.remoteSubscriptionVersions.get(connectionId) ?? 0) + 1
    );
    const subscription = this.remoteSubscriptions.get(connectionId);
    this.remoteSubscriptions.delete(connectionId);
    if (!subscription) {
      return;
    }

    try {
      subscription.offData();
    } catch (error) {
      console.warn('[session] Failed to dispose remote data listener:', error);
    }

    try {
      subscription.offExit();
    } catch (error) {
      console.warn('[session] Failed to dispose remote exit listener:', error);
    }
  }

  private appendReplayBuffer(session: ManagedSessionRecord, data: string): void {
    if (!data) {
      return;
    }

    const replay = `${session.replayBuffer || ''}${data}`;
    session.replayBuffer = replay.slice(-MAX_SESSION_REPLAY_CHARS);
  }

  private getReplayDelta(previousReplay: string | undefined, nextReplay: string): string {
    if (!nextReplay) {
      return '';
    }

    if (!previousReplay) {
      return nextReplay;
    }

    const overlap = this.getReplayOverlap(previousReplay, nextReplay);
    return nextReplay.slice(overlap);
  }

  private getReplayOverlap(previousReplay: string, nextReplay: string): number {
    const previousTail = previousReplay.slice(-nextReplay.length);
    if (previousTail.length === 0 || nextReplay.length === 0) {
      return 0;
    }

    const prefixTable = new Array<number>(nextReplay.length).fill(0);
    for (let index = 1, matched = 0; index < nextReplay.length; ) {
      if (nextReplay[index] === nextReplay[matched]) {
        matched += 1;
        prefixTable[index] = matched;
        index += 1;
        continue;
      }

      if (matched > 0) {
        matched = prefixTable[matched - 1] ?? 0;
        continue;
      }

      prefixTable[index] = 0;
      index += 1;
    }

    let matched = 0;
    for (let index = 0; index < previousTail.length; index += 1) {
      const char = previousTail[index];
      while (matched > 0 && nextReplay[matched] !== char) {
        matched = prefixTable[matched - 1] ?? 0;
      }
      if (nextReplay[matched] !== char) {
        continue;
      }

      matched += 1;
      if (matched === nextReplay.length && index < previousTail.length - 1) {
        matched = prefixTable[matched - 1] ?? 0;
      }
    }

    return matched;
  }

  private markRemoteSessionDead(session: ManagedSessionRecord): void {
    if (this.sessions.get(session.sessionId) !== session) {
      return;
    }

    const attachedWindowIds = new Set(session.attachedWindowIds);
    this.sessions.delete(session.sessionId);
    this.emitState(
      {
        sessionId: session.sessionId,
        state: 'dead',
      },
      attachedWindowIds
    );
    this.emitExit(
      {
        sessionId: session.sessionId,
        exitCode: 1,
      },
      attachedWindowIds
    );
  }

  private setSessionRuntimeState(sessionId: string, state: SessionRuntimeState): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.backend !== 'remote') {
      return;
    }
    if (session.runtimeState === state) {
      return;
    }
    session.runtimeState = state;
    this.emitState({ sessionId, state });
  }

  private emitData(sessionId: string, data: string, windowIds?: Set<number>): void {
    if (!data) {
      return;
    }

    this.emitToWindows(
      windowIds ?? this.sessions.get(sessionId)?.attachedWindowIds,
      'session:data',
      {
        sessionId,
        data,
      }
    );
  }

  private emitExit(event: SessionExitEvent, windowIds?: Set<number>): void {
    this.emitToWindows(windowIds, 'session:exit', event);
  }

  private emitState(event: SessionStateEvent, windowIds?: Set<number>): void {
    this.emitToWindows(
      windowIds ?? this.sessions.get(event.sessionId)?.attachedWindowIds,
      'session:state',
      event
    );
  }

  private emitToWindows(
    windowIds: Set<number> | undefined,
    channel: 'session:data' | 'session:exit' | 'session:state',
    payload: SessionDataEvent | SessionExitEvent | SessionStateEvent
  ): void {
    if (!windowIds || windowIds.size === 0) {
      return;
    }

    for (const windowId of windowIds) {
      const window = BrowserWindow.fromId(windowId);
      if (!window || window.isDestroyed()) {
        continue;
      }
      const resolvedChannel =
        channel === 'session:data'
          ? IPC_CHANNELS.SESSION_DATA
          : channel === 'session:exit'
            ? IPC_CHANNELS.SESSION_EXIT
            : IPC_CHANNELS.SESSION_STATE;
      if (window.webContents.isDestroyed()) {
        continue;
      }
      try {
        window.webContents.send(resolvedChannel, payload);
      } catch (error) {
        console.warn('[session] Failed to emit session event to window:', error);
      }
    }
  }

  private toDescriptor(session: ManagedSessionRecord): SessionDescriptor {
    return {
      sessionId: session.sessionId,
      backend: session.backend,
      kind: session.kind,
      cwd: session.cwd,
      persistOnDisconnect: session.persistOnDisconnect,
      createdAt: session.createdAt,
      metadata: session.metadata,
    };
  }
}

export const sessionManager = new SessionManager();
