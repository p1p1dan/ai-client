import { CODEX_AGENT } from '../shared/types/agentWire.ts';
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  SessionPermissionPolicy,
} from '../shared/types/runtimeEvents.ts';
import {
  CODEX_INITIALIZE_TIMEOUT_MS,
  type CodexConnectFactory,
  type CodexConnection,
  spawnCodexConnection,
} from './codexConnection.ts';
import { ensureCodexHome } from './codexHome.ts';
import { type CodexEntryResolution, resolveCodexLaunch } from './codexNodeEntry.ts';
import { kindOfServerMethod, PendingServerRequestTable } from './codexPending.ts';
import { readThreadStatus } from './codexStatus.ts';
import { CODEX_METHOD, idKey, JSONRPC_METHOD_NOT_FOUND, type JsonRpcId } from './codexWire.ts';
import type { EmitFn, LogFn } from './eventNormalizer.ts';
import type { SessionRegistry } from './sessionRegistry.ts';

/**
 * Codex Runtime Adapter — the shell that owns one `codex app-server` link per
 * session and turns its notifications into AiClient Runtime Events.
 *
 * ## What this slice does NOT do, on purpose
 *
 * `send()` and `resumeSession()` refuse with a non-fatal `host.error`. Both are
 * bounded, deliberate holes, not oversights:
 *
 *  - `send` needs the Codex event normalizer (item/* -> message/tool/thinking
 *    events), which belongs to a later slice. Half a normalizer would emit
 *    partial turns that look like corruption.
 *  - `resume` needs history replay. Claude's contract is
 *    `session.resumed -> session.history -> session.status(idle)`; a Codex
 *    resume that emitted only `session.resumed` would leave the renderer on a
 *    blank transcript with no error, and `history_unsupported` belongs to slice
 *    5a (arbitration doc §2.3 O-a). Refusing is the honest degradation, and it
 *    means a Codex session created during this slice cannot be resumed after a
 *    restart — a known, registered limitation.
 *
 * What IS live: the launch plan, the isolated CODEX_HOME, the handshake, the
 * `thread/start` posture, the single status mapper, the pending server-request
 * table and every teardown path.
 *
 * ## One connection per session
 *
 * `thread/start` gives us one thread and C12 fixed "our session ≡ one codex
 * thread". Each session therefore owns its own process, its own outbound id
 * space and its own pending table — matching `codexPending.ts`'s "this table is
 * PER CONNECTION". The cost is real (one node + one ~296MiB platform binary per
 * open Codex chat) and is registered rather than hidden; sharing one app-server
 * across sessions would need threadId-keyed routing on every inbound frame and
 * is a change to make deliberately, not by drift.
 */

/** The Codex arm of the per-agent permission posture (`runtimeEvents.ts`). */
export type CodexSessionPermissionPolicy = Extract<SessionPermissionPolicy, { agent: 'codex' }>;

/**
 * The posture every Codex session runs with (U4).
 *
 * `on-request` + `workspace-write`: the model asks when it wants to escalate,
 * and writes are confined to the workspace. This is NEVER read from
 * `~/.codex/config.toml` — that file says `danger-full-access` on the developer
 * machine, and inheriting it would silently switch off every approval prompt.
 * `codexHome.ts` drops `approval_policy` / `sandbox_mode` from the projection
 * for the same reason; this constant is the only source.
 *
 * ## `networkAccess` is NOT ours to send — read this before "fixing" it
 *
 * `thread/start` takes `sandbox` as a STRING. `networkAccess` appears only in
 * the RESULT, as a sub-field of the expanded sandbox object
 * (`{"type":"readOnly","networkAccess":false}` [实测]) — it is the server's
 * default for the sandbox tier we asked for, not a parameter. The value here
 * therefore RECORDS what we believe that default is (so the surface can show a
 * complete posture); it is not, and must not become, a request field. Whether
 * the request side even accepts an object-shaped sandbox is [未测] (arbitration
 * doc §5 U-c), so `buildThreadStartParams` deliberately sends the string and
 * `compareSandboxEcho` checks the echo afterwards.
 */
export const CODEX_PERMISSION_DEFAULT: CodexSessionPermissionPolicy = {
  // Literal, not `CODEX_AGENT`: this field is the discriminant of
  // `SessionPermissionPolicy`, whose type is the literal `'codex'` rather than
  // the wider `AgentWireName`. The test pins it equal to `CODEX_AGENT` so the
  // two cannot drift (the repo-wide literal scan cannot cover `'codex'` — the
  // terminal axis owns that same spelling; arbitration doc §2.3 O-e).
  agent: 'codex',
  approvalPolicy: 'on-request',
  sandboxMode: 'workspace-write',
  networkAccess: false,
};

/**
 * Our identity TO OPENAI. codex folds `clientInfo.name` into the User-Agent it
 * sends upstream [实测: probe reported `s1-codex-direct-probe` and the server
 * echoed `s1-codex-direct-probe/0.145.0 (…)`], so this is a product name, not a
 * protocol slug — reusing an `AgentWireName` value here would publish an
 * internal wire constant to a third party and weld two unrelated tables
 * together.
 */
export const CODEX_CLIENT_NAME = 'jyw-ai-client';

/**
 * Companion display title. There is NO local evidence about whether `title` is
 * sent upstream (arbitration doc §2.2 C-g) — `name` has a recorded User-Agent,
 * `title` has nothing — so it is treated as if it were: a fixed product name,
 * never a workspace path, a session name or anything else derived from what the
 * user is working on.
 */
export const CODEX_CLIENT_TITLE: string = 'AiClient';

/**
 * Fallback for a missing `AICLIENT_APP_VERSION`. Unlike the isolated-home path
 * (which has NO fallback, because guessing it would seed credentials somewhere
 * nobody looks), a version is a label on a User-Agent: a placeholder that reads
 * as "we do not know" is better than blocking a session over it.
 */
const UNKNOWN_APP_VERSION = '0.0.0-unknown';

export interface CodexInitializeParams {
  clientInfo: { name: string; title: string; version: string };
  capabilities: { experimentalApi: boolean; requestAttestation: boolean };
}

/**
 * The one handshake shape we have ever seen accepted [实测
 * fixtures/codex/codex-handshake.jsonl], with the probe's identity swapped for
 * ours. The capability flags are copied verbatim rather than trimmed: we do not
 * know which of them the server keys off.
 */
export function buildInitializeParams(appVersion: string): CodexInitializeParams {
  const version = appVersion.trim();
  return {
    clientInfo: {
      name: CODEX_CLIENT_NAME,
      title: CODEX_CLIENT_TITLE,
      version: version.length > 0 ? version : UNKNOWN_APP_VERSION,
    },
    capabilities: { experimentalApi: true, requestAttestation: false },
  };
}

export interface CodexThreadStartParams {
  cwd: string;
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
  model?: string;
}

/**
 * `thread/start` parameters — the ONLY place the posture reaches the wire.
 *
 * `sandbox` carries the mode STRING and nothing else: no `networkAccess`, no
 * object form (see `CODEX_PERMISSION_DEFAULT`). `model` is omitted rather than
 * sent as `undefined` when the session has none, so the server's own default
 * applies.
 */
export function buildThreadStartParams(input: {
  cwd: string;
  model?: string;
  policy?: CodexSessionPermissionPolicy;
}): CodexThreadStartParams {
  const policy = input.policy ?? CODEX_PERMISSION_DEFAULT;
  const model = input.model?.trim();
  return {
    cwd: input.cwd,
    approvalPolicy: policy.approvalPolicy,
    sandbox: policy.sandboxMode,
    ...(model ? { model } : {}),
  };
}

/** `'unverifiable'` is NOT `'match'`: it means we learned nothing, not that we agree. */
export type SandboxEchoVerdict = 'match' | 'mismatch' | 'unverifiable';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Spelling-insensitive comparison token. The request side spells the sandbox
 * `read-only` and the echo spells it `readOnly` [实测]; the other two tiers have
 * never been observed in echo form at all. Comparing normalized tokens keeps
 * this honest about the tiers we HAVE seen without inventing camel-case spellings
 * for the ones we have not — inventing them would produce confident WARNs about
 * a mismatch that never happened.
 */
function token(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Check what the server said it applied against what we asked for.
 *
 * Advisory ONLY. The caller logs a WARN and continues: hard constraint 7 forbids
 * failing a turn over a verification step, and this one runs against a result
 * shape that is only partly measured. A mismatch means the surface is about to
 * report a posture the session is not running under — worth shouting about,
 * never worth killing the session over.
 *
 * `echo` is the whole `thread/start` result; the recorded fragment
 * (`fixtures/codex/codex-thread-start-echo.partial.json`) does not record its
 * parent, so a `thread` wrapper is accepted too rather than guessed against.
 */
export function compareSandboxEcho(
  sent: CodexSessionPermissionPolicy,
  echo: unknown
): { verdict: SandboxEchoVerdict; detail?: string } {
  const roots: Record<string, unknown>[] = [];
  if (isRecord(echo)) {
    roots.push(echo);
    if (isRecord(echo.thread)) roots.push(echo.thread);
  }
  if (roots.length === 0) {
    return { verdict: 'unverifiable', detail: 'thread/start result is not an object' };
  }

  const compared: string[] = [];
  const missing: string[] = [];
  const mismatches: string[] = [];

  const approval = roots.map((root) => root.approvalPolicy).find((v) => typeof v === 'string');
  if (typeof approval === 'string') {
    compared.push('approvalPolicy');
    if (token(approval) !== token(sent.approvalPolicy)) {
      mismatches.push(`approvalPolicy sent=${sent.approvalPolicy} echo=${approval}`);
    }
  } else {
    missing.push('approvalPolicy');
  }

  const sandbox = roots.map((root) => root.sandbox).find((v) => v !== undefined);
  const sandboxType =
    typeof sandbox === 'string'
      ? sandbox
      : isRecord(sandbox) && typeof sandbox.type === 'string'
        ? sandbox.type
        : undefined;
  if (sandboxType !== undefined) {
    compared.push('sandbox');
    if (token(sandboxType) !== token(sent.sandboxMode)) {
      mismatches.push(`sandbox sent=${sent.sandboxMode} echo=${sandboxType}`);
    }
  } else {
    missing.push('sandbox');
  }

  const network = isRecord(sandbox) ? sandbox.networkAccess : undefined;
  if (typeof network === 'boolean') {
    compared.push('networkAccess');
    if (network !== sent.networkAccess) {
      // Worth naming precisely: this dimension is a SERVER DEFAULT we merely
      // record, so a mismatch means our record is stale — not that a request
      // field was dropped. Anyone reading the WARN would otherwise go hunting
      // for a bug on the request side, where the field does not exist.
      mismatches.push(
        `networkAccess recorded=${String(sent.networkAccess)} echo=${String(network)} ` +
          '(server default, never sent by us)'
      );
    }
  } else {
    missing.push('networkAccess');
  }

  const suffix = missing.length > 0 ? `; not echoed: ${missing.join(', ')}` : '';
  if (mismatches.length > 0) {
    return { verdict: 'mismatch', detail: `${mismatches.join('; ')}${suffix}` };
  }
  if (compared.length === 0) {
    // Nothing comparable came back. Reporting `match` here would turn "we could
    // not check" into "we checked and agreed", which is the one reading this
    // function must never produce.
    return { verdict: 'unverifiable', detail: `no comparable field in the result${suffix}` };
  }
  return { verdict: 'match', detail: `compared: ${compared.join(', ')}${suffix}` };
}

export interface CodexRuntimeOptions {
  emit: EmitFn;
  log?: LogFn;
  registry: SessionRegistry;
  /** `<userData>/codex-home`, injected by Main. The Host never guesses it. */
  codexHomeDir: string;
  /** Reported to OpenAI inside the User-Agent via `clientInfo.version`. */
  appVersion: string;
  /** Test seam — replaces the real `child_process` spawn. */
  connect?: CodexConnectFactory;
  /** Test seam — replaces the fs probes of the entry-point resolver. */
  resolveLaunch?: () => CodexEntryResolution;
  /** Test seam — replaces the isolated-home seeding. */
  ensureHome?: typeof ensureCodexHome;
}

interface CodexSessionState {
  sessionId: string;
  workspacePath: string;
  policy: CodexSessionPermissionPolicy;
  connection: CodexConnection;
  pending: PendingServerRequestTable;
  threadId?: string;
  /** Set by `teardown` so exit / close / dispose cannot drain the same table twice. */
  torndown: boolean;
}

/** `thread/start`'s result shape is [读码] from the probe, which read both spellings. */
function readThreadId(result: unknown): string | null {
  if (!isRecord(result)) return null;
  if (typeof result.threadId === 'string' && result.threadId.length > 0) return result.threadId;
  const thread = result.thread;
  if (isRecord(thread) && typeof thread.id === 'string' && thread.id.length > 0) return thread.id;
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class CodexRuntime {
  private readonly opts: CodexRuntimeOptions;
  private readonly log: LogFn;
  private readonly sessions = new Map<string, CodexSessionState>();

  constructor(opts: CodexRuntimeOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((...args) => console.error('[codex-runtime]', ...args));
  }

  /**
   * Non-fatal, correlated BOTH ways — same shape as `index.ts`'s
   * `rejectUnsupportedAgent`: `requestId` is what the renderer strict-matches on
   * to fail the pending command, `sessionId` is what scopes the message to this
   * session's Composer. Dropping either leaves a spinner running somewhere.
   */
  private fail(
    code: string,
    message: string,
    ctx: { sessionId?: string; requestId?: string }
  ): void {
    this.opts.emit({
      type: 'host.error',
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      requestId: ctx.requestId,
      payload: { code, message, fatal: false },
    });
  }

  createSession(input: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    /** Accepted for command-shape parity; Codex has no measured effort parameter. */
    effort?: unknown;
    requestId?: string;
  }): void {
    const { sessionId, workspacePath, requestId } = input;
    if (this.sessions.has(sessionId) || this.opts.registry.get(sessionId)) {
      this.fail('session_create_failed', `Session already exists: ${sessionId}`, {
        sessionId,
        requestId,
      });
      return;
    }

    const resolution = (this.opts.resolveLaunch ?? resolveCodexLaunch)();
    if (!resolution.ok) {
      // The inspected paths describe the USER'S machine layout, so they go to
      // the Host log and never into an event that reaches the UI.
      this.log('codex entry unresolved', { sessionId, inspected: resolution.inspected });
      this.fail('agent_unsupported', `session.create: ${resolution.message}`, {
        sessionId,
        requestId,
      });
      return;
    }

    let homeDir: string;
    try {
      const home = (this.opts.ensureHome ?? ensureCodexHome)({
        homeDir: this.opts.codexHomeDir,
        log: (...args: unknown[]) => this.log('[codex-home]', ...args),
      });
      homeDir = home.homeDir;
    } catch (err) {
      this.fail(
        'session_create_failed',
        `session.create: could not prepare the isolated CODEX_HOME: ${errorMessage(err)}`,
        { sessionId, requestId }
      );
      return;
    }

    // The other half of the isolation. `codexHome.ts` wrote a deny-by-default
    // projection into `homeDir`; this is what makes codex READ that directory
    // instead of `~/.codex`. Without it every drop in the projection is undone
    // and the session silently inherits `developer_instructions` and
    // `danger-full-access`.
    //
    // The rest of the environment is inherited whole, deliberately. NOTE for
    // whoever revisits this: once a Claude session has run, `ensureRuntime()`
    // has copied `~/.claude/settings.json`'s env (including
    // `ANTHROPIC_AUTH_TOKEN`) onto this process, so those variables reach the
    // codex child too. Filtering them looks tempting and is NOT done here,
    // because a user whose codex `model_providers.<id>.env_key` names one of
    // them would lose authentication with a confusing error — the projection
    // keeps `env_key`, so that configuration is reachable. Registered as an open
    // question rather than settled by guess.
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: homeDir };

    const connect = this.opts.connect ?? spawnCodexConnection;
    let connection: CodexConnection;
    try {
      connection = connect({
        plan: resolution.plan,
        env,
        cwd: workspacePath,
        handlers: {
          onServerRequest: (req) => this.onServerRequest(sessionId, req),
          onNotification: (n) => this.onNotification(sessionId, n),
          // Host log only. Codex stderr is prose, and forwarding it as
          // `session.stderr` needs the per-turn cap + redaction that
          // `claudeRuntime` applies around a turn — there are no turns here yet.
          onStderr: (line) => this.log('[codex-stderr]', sessionId, line),
          onExit: (info) => this.onExit(sessionId, info),
        },
      });
    } catch (err) {
      this.fail('session_create_failed', `session.create: ${errorMessage(err)}`, {
        sessionId,
        requestId,
      });
      return;
    }

    const pending = new PendingServerRequestTable({
      reply: (id, result) => connection.reply(id, result),
      log: (msg) => this.log(msg),
      onSettled: (entry, reason) =>
        this.log('codex pending settled', {
          sessionId: entry.sessionId,
          id: idKey(entry.requestId),
          kind: entry.kind,
          reason,
        }),
    });

    const state: CodexSessionState = {
      sessionId,
      workspacePath,
      policy: CODEX_PERMISSION_DEFAULT,
      connection,
      pending,
      torndown: false,
    };
    this.sessions.set(sessionId, state);

    // Registered SYNCHRONOUSLY, before the handshake round trip, so that
    // `index.ts` can dispatch a close/stop that arrives while we are still
    // starting: it routes on `registry.get(sessionId).agent`, and an entry that
    // appeared only after `thread/start` returned would send those commands to
    // the Claude runtime instead.
    this.opts.registry.create({
      sessionId,
      workspacePath,
      agent: CODEX_AGENT,
      model: input.model,
    });
    this.log('codex session starting', {
      sessionId,
      pid: connection.pid,
      source: resolution.plan.source,
      codexJsPath: resolution.plan.codexJsPath,
      homeDir,
    });

    void this.startThread(state, input);
  }

  /**
   * `initialize` -> `initialized` -> `thread/start`, then the session exists.
   *
   * `session.created` is emitted at the END, unlike the Claude runtime's (which
   * has nothing to contact yet): the thread id IS the resume handle, so waiting
   * one round trip lets the event carry `runtimeIdentity` instead of leaving
   * Main to learn it later.
   */
  private async startThread(
    state: CodexSessionState,
    input: { model?: string; requestId?: string }
  ): Promise<void> {
    const { sessionId } = state;
    try {
      const init = await state.connection.request(
        CODEX_METHOD.initialize,
        buildInitializeParams(this.opts.appVersion),
        CODEX_INITIALIZE_TIMEOUT_MS
      );
      this.checkHomeEcho(sessionId, init);
      state.connection.notify(CODEX_METHOD.initialized, {});

      const params = buildThreadStartParams({
        cwd: state.workspacePath,
        model: input.model,
        policy: state.policy,
      });
      const result = await state.connection.request(CODEX_METHOD.threadStart, params);

      const threadId = readThreadId(result);
      if (!threadId) {
        // Without it we can never address a turn on this thread, so a session
        // that "started" would be dead on arrival — fail loudly instead.
        throw new Error('thread/start returned no thread id');
      }
      state.threadId = threadId;

      const echo = compareSandboxEcho(state.policy, result);
      // WARN, never fatal (hard constraint 7). A mismatch means the posture we
      // are about to report is not the one the session runs under.
      this.log(
        echo.verdict === 'mismatch' ? 'WARN codex sandbox echo mismatch' : 'codex sandbox echo',
        { sessionId, verdict: echo.verdict, detail: echo.detail }
      );

      const session = this.opts.registry.get(sessionId);
      if (!session || state.torndown) {
        // Closed while we were starting. The close path already drained and
        // disposed; emitting `session.created` now would resurrect a dead row.
        this.log('codex session vanished during start', { sessionId });
        return;
      }
      session.runtimeIdentity = threadId;

      this.opts.emit({
        type: 'session.created',
        sessionId,
        requestId: input.requestId,
        payload: {
          // Straight off the registry entry, so the event and the entry cannot
          // report different bindings.
          agent: session.agent,
          runtimeIdentity: threadId,
          // The SAME object that produced the `thread/start` params above.
          permissionPolicy: state.policy,
        },
      });
      this.opts.emit({
        type: 'session.status',
        sessionId,
        requestId: input.requestId,
        payload: { status: 'idle' },
      });
    } catch (err) {
      if (state.torndown) return;
      this.log('codex session start failed', { sessionId, error: errorMessage(err) });
      this.teardown(state, 'session_closed', `start failed: ${errorMessage(err)}`);
      this.opts.registry.delete(sessionId);
      this.fail('session_create_failed', `session.create: ${errorMessage(err)}`, {
        sessionId,
        requestId: input.requestId,
      });
    }
  }

  /**
   * Did codex actually adopt the isolated home? Log-only: the answer changes
   * nothing we can do at this point, but "codex read ~/.codex after all" is the
   * single most useful line in a report about a session that inherited
   * `developer_instructions`.
   */
  private checkHomeEcho(sessionId: string, initResult: unknown): void {
    const reported = isRecord(initResult) ? initResult.codexHome : undefined;
    if (typeof reported !== 'string') return;
    const strip = (p: string): string => p.replace(/[\\/]+$/, '');
    if (strip(reported) !== strip(this.opts.codexHomeDir)) {
      this.log('WARN codex reported a different CODEX_HOME than we injected', {
        sessionId,
        reported,
        expected: this.opts.codexHomeDir,
      });
    }
  }

  private onNotification(sessionId: string, n: { method: string; params: unknown }): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (n.method === CODEX_METHOD.statusChanged) {
      this.onStatusChanged(state, n.params);
      return;
    }
    // Everything else (item/*, turn/*, account/*) belongs to the event
    // normalizer, which no slice has landed yet — see the module header.
    this.log('codex notification not consumed in this slice', { sessionId, method: n.method });
  }

  /**
   * THE one place `session.status` is written for Codex (S2 C10 rule 3). The
   * question bridge and the approval bridge must never emit it: this
   * notification is the server's own full snapshot, so deriving the state
   * anywhere else immediately creates a second, laggier truth.
   */
  private onStatusChanged(state: CodexSessionState, params: unknown): void {
    const threadId = isRecord(params) ? params.threadId : undefined;
    if (typeof threadId === 'string' && state.threadId && threadId !== state.threadId) {
      // One session ≡ one thread (C12, and `thread/fork` is banned this round).
      // A status for another thread cannot be projected onto this session.
      this.log('WARN codex status for a foreign thread, ignored', {
        sessionId: state.sessionId,
        threadId,
        expected: state.threadId,
      });
      return;
    }

    const reading = readThreadStatus(params);
    if (reading.unknownFlags.length > 0) {
      // A codex upgrade will add flags. Never thrown on, never silently
      // dropped — the WARN is how we find out a new state bit exists.
      this.log('WARN codex status carried unknown flags', {
        sessionId: state.sessionId,
        unknownFlags: reading.unknownFlags,
      });
    }
    if (reading.status === null) {
      this.log('codex status frame had no usable reading', {
        sessionId: state.sessionId,
        reason: reading.reason,
      });
      return;
    }
    this.opts.registry.setStatus(state.sessionId, reading.status);
    this.opts.emit({
      type: 'session.status',
      sessionId: state.sessionId,
      payload: { status: reading.status },
    });
  }

  private onServerRequest(
    sessionId: string,
    req: { id: JsonRpcId; method: string; params: unknown }
  ): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const kind = kindOfServerMethod(req.method);
    if (!kind) {
      // An explicit error still ENDS the request, so the turn cannot hang. A
      // permissive `{}` might parse as "no opinion", which is the one reading
      // that could be mistaken for consent.
      state.connection.replyError(
        req.id,
        JSONRPC_METHOD_NOT_FOUND,
        `AiClient does not implement ${req.method}`
      );
      this.log('codex server request refused (unknown method)', { sessionId, method: req.method });
      return;
    }
    const registered = state.pending.register({
      requestId: req.id,
      sessionId,
      kind,
      method: req.method,
      params: req.params,
      correlationId: `codex:${sessionId}:${idKey(req.id)}`,
      createdAt: Date.now(),
    });
    if (!registered) return;
    // Left PENDING on purpose: the question bridge (slice 3) and the approval
    // bridge (slice 4) are what answer these, and every teardown path below
    // drains the table with a fail-safe refusal, so nothing can be left
    // unanswered. Unreachable in practice this slice — `send()` is refused, so
    // no turn runs and codex has nothing to ask about.
    this.log('codex server request registered; no bridge in this slice', {
      sessionId,
      id: idKey(req.id),
      kind,
    });
  }

  private onExit(sessionId: string, info: { code: number | null; signal: string | null }): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.torndown) return;
    this.log('codex process exited', { sessionId, code: info.code, signal: info.signal });
    // Arbitration doc §2.3 O-d: the process is gone but the cards are still on
    // screen. `{}` — no session filter — because this table belongs to the
    // connection that just died; every entry in it is now unanswerable.
    this.teardown(state, 'aborted', 'process exited', {});
    this.opts.registry.setStatus(sessionId, 'disconnected');
    this.opts.emit({
      type: 'session.failed',
      sessionId,
      payload: {
        error: `codex app-server exited (code=${String(info.code)}, signal=${String(info.signal)})`,
      },
    });
  }

  /**
   * Drain THEN dispose. The order is not stylistic: `dispose()` kills the
   * process, and after that there is no stdin to write the refusal frames to —
   * every pending question and approval would be dropped without an answer,
   * which is precisely the "cleared the table but never replied" failure the
   * pending table exists to prevent.
   */
  private teardown(
    state: CodexSessionState,
    reason: 'session_closed' | 'aborted',
    disposeReason: string,
    filter: { sessionId?: string } = { sessionId: state.sessionId }
  ): void {
    if (state.torndown) return;
    state.torndown = true;
    const drained = state.pending.drain(filter, reason);
    if (drained.length > 0) {
      this.log('codex pending drained', {
        sessionId: state.sessionId,
        count: drained.length,
        reason,
      });
    }
    state.connection.dispose(disposeReason);
    this.sessions.delete(state.sessionId);
  }

  /**
   * No turn can be interrupted in this slice — `send()` is refused, and the
   * spelling of codex's interrupt method is [未测] (arbitration doc §5 U-a), so
   * guessing one would launder a guess into shipped code. What Stop DOES do is
   * settle anything codex is waiting on, which is the half that can otherwise
   * leave a card on screen forever.
   */
  stop(input: { sessionId: string; requestId?: string }): void {
    const state = this.sessions.get(input.sessionId);
    const session = this.opts.registry.get(input.sessionId);
    if (!state || !session) {
      this.fail('session_not_found', `Unknown session: ${input.sessionId}`, {
        requestId: input.requestId,
      });
      return;
    }
    state.pending.drain({ sessionId: input.sessionId }, 'aborted');
    this.opts.emit({
      type: 'session.status',
      sessionId: input.sessionId,
      requestId: input.requestId,
      payload: { status: session.status },
    });
  }

  close(input: { sessionId: string; requestId?: string }): void {
    const state = this.sessions.get(input.sessionId);
    if (state) this.teardown(state, 'session_closed', 'session closed');
    this.opts.registry.delete(input.sessionId);
    this.opts.emit({
      type: 'session.status',
      sessionId: input.sessionId,
      requestId: input.requestId,
      payload: { status: 'disconnected' },
    });
  }

  /** Host shutdown: every session drained and every process killed. */
  dispose(): void {
    for (const state of [...this.sessions.values()]) {
      this.teardown(state, 'session_closed', 'host shutting down');
    }
    this.sessions.clear();
  }

  /**
   * Refused, on purpose — see the module header.
   *
   * The signature mirrors the Claude runtime's (async, same fields) so that
   * `index.ts` dispatches to either through ONE call site: two call sites would
   * be two places deciding which runtime owns a session, and they would drift.
   */
  async send(input: {
    sessionId: string;
    text?: string;
    attachments?: unknown;
    effort?: unknown;
    model?: unknown;
    requestId?: string;
  }): Promise<void> {
    this.fail(
      'not_implemented',
      'session.send: the Codex runtime cannot run a turn yet — its event ' +
        'normalizer lands in a later slice. The session, its isolated CODEX_HOME ' +
        'and its permission posture are real; only the turn loop is missing.',
      { sessionId: input.sessionId, requestId: input.requestId }
    );
  }

  /** Refused rather than half-implemented — see the module header (O-a). */
  resumeSession(input: {
    sessionId: string;
    workspacePath?: string;
    runtimeIdentity?: string;
    model?: string;
    effort?: unknown;
    requestId?: string;
  }): void {
    this.fail(
      'agent_unsupported',
      'session.resume: Codex session resume arrives in a later slice. Replaying a ' +
        'Codex transcript is not implemented, so resuming now would leave the ' +
        'conversation blank with no explanation.',
      { sessionId: input.sessionId, requestId: input.requestId }
    );
  }

  respondPermission(input: {
    sessionId: string;
    permissionId?: string;
    allow?: boolean;
    requestId?: string;
  }): void {
    this.fail(
      'not_implemented',
      'permission.respond: the Codex approval bridge lands in a later slice.',
      { sessionId: input.sessionId, requestId: input.requestId }
    );
  }

  respondQuestion(input: {
    sessionId: string;
    questionId?: string;
    answers?: Record<string, string>;
    response?: string;
    cancel?: boolean;
    requestId?: string;
  }): void {
    this.fail(
      'not_implemented',
      'question.respond: the Codex question bridge lands in a later slice.',
      { sessionId: input.sessionId, requestId: input.requestId }
    );
  }
}
