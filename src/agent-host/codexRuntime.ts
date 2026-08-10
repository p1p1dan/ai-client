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
  CodexConnectionClosedError,
  spawnCodexConnection,
} from './codexConnection.ts';
import { ensureCodexHome } from './codexHome.ts';
import { type CodexEntryResolution, resolveCodexLaunch } from './codexNodeEntry.ts';
import { CodexNormalizer } from './codexNormalizer.ts';
import {
  defaultReplyFor,
  kindOfServerMethod,
  type PendingKind,
  type PendingServerRequest,
  PendingServerRequestTable,
  type PendingSettleReason,
} from './codexPending.ts';
import { readAutoResolutionMs, toCodexAnswerBody, toQuestionItems } from './codexQuestionBridge.ts';
import { readThreadStatus } from './codexStatus.ts';
import { CODEX_METHOD, idKey, JSONRPC_METHOD_NOT_FOUND, type JsonRpcId } from './codexWire.ts';
import type { EmitFn, LogFn } from './eventNormalizer.ts';
import type { SessionRegistry } from './sessionRegistry.ts';

/**
 * Codex Runtime Adapter — the shell that owns one `codex app-server` link per
 * session and turns its notifications into AiClient Runtime Events.
 *
 * ## The turn loop (slice 2c)
 *
 * `send()` opens a turn: one `CodexNormalizer` per turn, then `turn/start`.
 * Everything the turn produces arrives as NOTIFICATIONS, not as the response —
 * so the turn's terminal event comes from `turn/completed`, never from the
 * promise. `stop()` drains the pending server requests and then interrupts.
 *
 * The admission gate for a new send is `state.turn`, our OWN record — NOT the
 * projected `session.status`. Status here is a pure projection of
 * `thread/status/changed` (C10 rule 3), which can lag the wire or, if codex
 * dies, never arrive; gating on it would either admit a second concurrent turn
 * or refuse forever.
 *
 * ## What this slice still does NOT do, on purpose
 *
 *  - `resumeSession()` refuses. It needs history replay: Claude's contract is
 *    `session.resumed -> session.history -> session.status(idle)`, and a Codex
 *    resume that emitted only `session.resumed` would leave the renderer on a
 *    blank transcript with no error. `history_unsupported` belongs to slice 5a
 *    (arbitration doc §2.3 O-a). It means a Codex session cannot yet be resumed
 *    after a restart — a known, registered limitation.
 *  - `send()` refuses ATTACHMENTS (see `send`), because no measured frame shows
 *    how codex wants them.
 *  - The question / approval bridges (slices 3 and 4) still leave every server
 *    request parked in the pending table. That table is now reachable for real:
 *    a turn runs, so codex can ask. Every teardown path drains it.
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

/** One `UserInput` of the `TextUserInput` variant — the only one we can build. */
export interface CodexTextInput {
  type: 'text';
  text: string;
}

export interface CodexTurnStartParams {
  threadId: string;
  input: CodexTextInput[];
}

/**
 * `turn/start` parameters.
 *
 * `threadId` + `input` are the two REQUIRED fields of `TurnStartParams`
 * [实测 `fixtures/codex/codex-turn-schema.json`, generated by the binary's own
 * `codex app-server generate-json-schema`], and they are exactly the two the
 * probe sent [读码 `spikes/s1-codex-direct-probe.ts:383-386`]. Nothing else is
 * added, although the schema offers plenty:
 *
 *  - `approvalPolicy` / `sandboxPolicy` / `cwd` exist here too, and the schema
 *    says each override applies "for this turn AND SUBSEQUENT TURNS". Sending
 *    them would give the posture a second source that silently outlives the turn
 *    that set it; `thread/start` stays the only place it is decided.
 *  - `effort` is "a non-empty reasoning effort value advertised by the model",
 *    i.e. a per-model vocabulary we have never read out of `model/list`. Mapping
 *    our five `SessionEffortLevel` words onto it blind would fail turns on any
 *    model advertising a different set, so per-turn effort is accepted by
 *    `send()` and dropped, deliberately.
 *  - `model` is a sticky override too, and the session already pinned its model
 *    at `thread/start`.
 */
export function buildTurnStartParams(input: {
  threadId: string;
  text: string;
}): CodexTurnStartParams {
  // `text_elements` is optional (`default: []`) and describes UI spans we do not
  // produce; an empty array would claim we parsed the text and found none.
  return { threadId: input.threadId, input: [{ type: 'text', text: input.text }] };
}

export interface CodexTurnInterruptParams {
  threadId: string;
  turnId: string;
}

/**
 * `turn/interrupt` parameters.
 *
 * BOTH ids are required [实测 `codex-turn-schema.json`: `TurnInterruptParams`
 * requires `threadId` and `turnId`, and has no other property]. This is the
 * reason `stop()` refuses to send the frame at all when the turn id is not known
 * yet: a one-id interrupt is a schema error, i.e. an interrupt that never
 * interrupts while our log claims we sent one.
 */
export function buildTurnInterruptParams(input: {
  threadId: string;
  turnId: string;
}): CodexTurnInterruptParams {
  return { threadId: input.threadId, turnId: input.turnId };
}

/**
 * Deadline for the `turn/start` REQUEST — not for the turn.
 *
 * The turn's real terminal is the `turn/completed` NOTIFICATION; this promise is
 * only the ack. Whether codex answers it at turn start or at turn end is [未测]
 * (`TurnStartResponse` carries the whole `Turn`, which would be legal either
 * way), so the deadline is set long enough that the slow reading cannot fail a
 * healthy long turn. It remains a real backstop: if codex never answers at all,
 * the session frees itself instead of staying busy forever.
 */
export const CODEX_TURN_START_TIMEOUT_MS = 30 * 60_000;

/**
 * Deadline for `turn/interrupt`. Short: the answer is an empty object
 * (`TurnInterruptResponse` has no fields), and Stop never waits on it — the
 * result is logged, never acted on.
 */
export const CODEX_TURN_INTERRUPT_TIMEOUT_MS = 15_000;

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

/**
 * One in-flight turn. Its lifetime is exactly "between `send()` and the single
 * terminal event", and it is what `send()` gates on.
 */
interface CodexTurnState {
  /** The `session.send` request id, for correlating the refusal paths. */
  requestId?: string;
  /** Fresh per turn: nothing from turn N can address a block of turn N+1. */
  normalizer: CodexNormalizer;
  /**
   * Learned from `turn/start`'s result, or from the notification stream —
   * whichever arrives first. Without it no interrupt can be addressed.
   */
  turnId?: string;
}

interface CodexSessionState {
  sessionId: string;
  workspacePath: string;
  policy: CodexSessionPermissionPolicy;
  connection: CodexConnection;
  pending: PendingServerRequestTable;
  threadId?: string;
  /** The one turn this session may have in flight, or `null`. */
  turn: CodexTurnState | null;
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

/**
 * The turn id inside a `turn/start` result.
 *
 * `{turn: {id}}` is the declared shape [实测 `TurnStartResponse` -> `Turn.id`];
 * the flat `turnId` spelling is accepted as well, exactly as `readThreadId`
 * accepts both of the thread spellings, because reading it wrong costs us the
 * ability to interrupt.
 */
function readTurnStartId(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const turn = result.turn;
  if (isRecord(turn) && typeof turn.id === 'string' && turn.id.length > 0) return turn.id;
  if (typeof result.turnId === 'string' && result.turnId.length > 0) return result.turnId;
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Does this frame belong to the session's own thread (C12)?
 *
 * An ABSENT `threadId` is accepted, matching `CodexNormalizer.acceptsThread`:
 * `item/started` for a `plan` item carries only `item` [实测], and dropping
 * those would lose real content over a missing key. The two readings must agree
 * — a frame the normalizer renders but this predicate rejects (or the reverse)
 * is a frame whose turn is half-owned.
 */
/**
 * `ServerRequestResolvedNotification.requestId`
 * [实测 codex-question-schema.json: `required: [requestId, threadId]`].
 * `null` = not a usable id, which we drop rather than guess at.
 */
function readRequestId(params: unknown): JsonRpcId | null {
  if (!isRecord(params)) return null;
  const id = params.requestId;
  return typeof id === 'number' || typeof id === 'string' ? id : null;
}

function belongsToThread(expected: string | undefined, params: unknown): boolean {
  if (!expected) return true;
  const threadId = isRecord(params) ? params.threadId : undefined;
  return typeof threadId !== 'string' || threadId === expected;
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
      onSettled: (entry, reason) => {
        this.log('codex pending settled', {
          sessionId: entry.sessionId,
          id: idKey(entry.requestId),
          kind: entry.kind,
          reason,
        });
        this.projectSettledQuestion(entry, reason);
      },
    });

    const state: CodexSessionState = {
      sessionId,
      workspacePath,
      policy: CODEX_PERMISSION_DEFAULT,
      connection,
      pending,
      turn: null,
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

  /**
   * Route one notification: status to the mapper, everything else to the turn.
   *
   * `thread/status/changed` is intercepted BEFORE the normalizer sees it. It is
   * also in the normalizer's own ignore table, so this is belt and braces on the
   * one rule that must not bend (C10 rule 3: one status writer).
   */
  private onNotification(sessionId: string, n: { method: string; params: unknown }): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (n.method === CODEX_METHOD.statusChanged) {
      this.onStatusChanged(state, n.params);
      return;
    }

    // Handled at the SAME level as the status frame, and the placement is
    // load-bearing: it must be above the `if (!turn)` drop below. The only case
    // where this notification does real work is the server settling its own
    // request (auto-resolution, an interrupted turn, a withdrawn ask), and
    // those cluster exactly where a turn is ending or already gone. Written
    // down next to `ingest()` — the natural-looking spot — it would be dropped
    // in precisely the situations it exists for.
    if (n.method === CODEX_METHOD.serverRequestResolved) {
      this.onServerRequestResolved(state, n.params);
      return;
    }

    const turn = state.turn;
    if (!turn) {
      // Outside a turn there is no normalizer to own the frame. Dropped and
      // logged rather than fed to a synthesized turn, which would open an
      // assistant bubble nobody asked for. The known cost is a trailing
      // `thread/tokenUsage/updated` that lands after `turn/completed` (whether
      // codex sends one there is [未测]) — losing a usage refresh is cheaper
      // than resurrecting a finished turn.
      this.log('codex notification outside a turn, dropped', { sessionId, method: n.method });
      return;
    }

    // The id is learned here as well as from the `turn/start` result: the
    // notification stream reliably beats the response, and `stop()` cannot
    // address an interrupt without it.
    if (!turn.turnId) {
      const seen = turn.normalizer.currentTurnId();
      if (seen) turn.turnId = seen;
    }

    turn.normalizer.ingest(n.method, n.params);

    if (!turn.turnId) {
      const seen = turn.normalizer.currentTurnId();
      if (seen) turn.turnId = seen;
    }

    if (n.method === CODEX_METHOD.turnCompleted) {
      if (!belongsToThread(state.threadId, n.params)) {
        // C12 again, and the reason it is checked HERE rather than left to the
        // normalizer: the normalizer DROPPED this frame, so it emitted nothing
        // for it. Retiring our turn on it would assert `terminalAlreadyEmitted`
        // about an event that never happened — no terminal AND no turn record,
        // which is strictly worse than either alone: the assistant message
        // streams forever, the renderer holds the session busy, and our own
        // `turn/completed` is later discarded as "outside a turn".
        this.log('WARN codex turn/completed for a foreign thread, ignored', {
          sessionId,
          expected: state.threadId,
        });
        return;
      }
      // The normalizer already emitted this turn's terminal event from the
      // frame's own `turn.status`, so the runtime only retires the record — a second
      // terminal here would double-report every turn.
      this.finishTurn(state, 'completed', undefined, { terminalAlreadyEmitted: true });
    }
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

  /**
   * The server settled its own request. Drop the entry WITHOUT replying — see
   * `codexPending`'s "ONE exception". Replying after this notification would be
   * a response to a request nobody is waiting on any more.
   *
   * Every request we answer ourselves is followed by one of these, and by then
   * `settle()` has already removed the entry, so the common outcome here is a
   * no-op. The case worth the code is the other one: the server resolving on
   * its own (`autoResolutionMs`, an interrupted turn, a withdrawn ask), which
   * would otherwise leave the entry parked — card pending forever, and a later
   * drain writing a frame for an id the server has forgotten.
   */
  private onServerRequestResolved(state: CodexSessionState, params: unknown): void {
    if (!belongsToThread(state.threadId, params)) {
      this.log('WARN codex serverRequest/resolved for a foreign thread, ignored', {
        sessionId: state.sessionId,
        expected: state.threadId,
      });
      return;
    }
    const requestId = readRequestId(params);
    if (requestId === null) {
      // `requestId` is required by the contract, so this is a codex we do not
      // know. Guessing which entry was meant could drop the wrong card.
      this.log('WARN codex serverRequest/resolved carried no usable requestId', {
        sessionId: state.sessionId,
      });
      return;
    }
    state.pending.forget(requestId);
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

    if (kind === 'question') {
      // G1 — no turn is running. `stop()` neither tears the session down nor
      // deletes it, and `turn/interrupt` is best effort whose real effect is
      // [未测], so codex can keep asking after the user pressed Stop.
      // Registering one of those would put a card on screen for a turn nobody
      // is waiting on and, through the renderer's own `question.requested`
      // reducer, drag the session back into the busy state it just left.
      //
      // Question-only on purpose. The same argument does not transfer to
      // approvals yet: they raise no card in this slice, so a parked approval
      // is invisible until a drain answers it, and turning that into an
      // immediate refusal would decide slice 4's failure posture here. Left as
      // slice 2c shipped it, and registered for slice 4.
      if (!state.turn) {
        this.refuseServerRequest(state, req.id, kind, 'aborted', 'no turn is running');
        return;
      }

      const reading = toQuestionItems(req.params);
      // G2 — nothing renderable. A zero-question card cannot be answered, so it
      // would hang the turn; and registering it just to settle it immediately
      // would emit a `question.resolved` for a card that was never requested,
      // which the store turns into "clear the question dock" — taking a
      // DIFFERENT session's live card off screen.
      if (reading.items.length === 0) {
        this.refuseServerRequest(
          state,
          req.id,
          kind,
          'unsupported',
          reading.dropped > 0
            ? `all ${reading.dropped} question(s) were unreadable`
            : 'the request carried no questions'
        );
        return;
      }
      if (
        state.pending.register({
          requestId: req.id,
          sessionId,
          kind,
          method: req.method,
          params: req.params,
          correlationId: this.correlationIdFor(sessionId, req.id),
          createdAt: Date.now(),
        })
      ) {
        const autoResolutionMs = readAutoResolutionMs(req.params);
        this.opts.emit({
          type: 'question.requested',
          sessionId,
          payload: {
            questionId: this.correlationIdFor(sessionId, req.id),
            questions: reading.items,
            ...(autoResolutionMs !== undefined ? { autoResolutionMs } : {}),
          },
        });
        // No `session.status` here. C10 rule 3: the waiting state is derived
        // only from `thread/status/changed`, and codex does send
        // `activeFlags:["waitingOnUserInput"]` around every question
        // [实测 codex-question-turn-status.jsonl].
        if (reading.dropped > 0) {
          this.log('WARN codex question had unreadable entries', {
            sessionId,
            id: idKey(req.id),
            dropped: reading.dropped,
          });
        }
      }
      return;
    }

    const registered = state.pending.register({
      requestId: req.id,
      sessionId,
      kind,
      method: req.method,
      params: req.params,
      correlationId: this.correlationIdFor(sessionId, req.id),
      createdAt: Date.now(),
    });
    if (!registered) return;
    // Approvals are left PENDING on purpose: the approval bridge is slice 4,
    // and every teardown path drains the table with a fail-safe refusal, so
    // nothing is left unanswered. A parked entry means codex is blocked on
    // `waitingOnApproval` until a bridge or a drain answers it.
    this.log('codex server request registered; no bridge in this slice', {
      sessionId,
      id: idKey(req.id),
      kind,
    });
  }

  /**
   * Answer a server request we are deliberately not registering.
   *
   * The body comes from the pending table's own refusal lookup rather than a
   * literal here, so the two "never registered" paths cannot drift away from
   * what a drain would have sent. Nothing is registered, so nothing is settled
   * and no `question.resolved` is emitted — there is no card to resolve.
   */
  private refuseServerRequest(
    state: CodexSessionState,
    requestId: JsonRpcId,
    kind: PendingKind,
    reason: 'aborted' | 'unsupported',
    why: string
  ): void {
    this.log('codex server request refused without registering', {
      sessionId: state.sessionId,
      id: idKey(requestId),
      kind,
      reason,
      why,
    });
    state.connection.reply(requestId, defaultReplyFor(kind, reason));
  }

  /** `question.respond` addresses this; the wire id alone would collide across sessions. */
  private correlationIdFor(sessionId: string, requestId: JsonRpcId): string {
    return `codex:${sessionId}:${idKey(requestId)}`;
  }

  private onExit(sessionId: string, info: { code: number | null; signal: string | null }): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.torndown) return;
    this.log('codex process exited', { sessionId, code: info.code, signal: info.signal });
    const error = `codex app-server exited (code=${String(info.code)}, signal=${String(info.signal)})`;
    // An open turn is closed FIRST, and it carries the terminal event. Doing it
    // the other way round (session.failed here, turn closed by teardown) would
    // report the same death twice and leave the assistant bubble streaming in
    // between. Exactly one `session.failed` leaves this method either way.
    const hadTurn = state.turn !== null;
    if (hadTurn) this.finishTurn(state, 'failed', error);
    // Arbitration doc §2.3 O-d: the process is gone but the cards are still on
    // screen. `{}` — no session filter — because this table belongs to the
    // connection that just died; every entry in it is now unanswerable.
    this.teardown(state, 'aborted', 'process exited', {});
    this.opts.registry.setStatus(sessionId, 'disconnected');
    if (!hadTurn) {
      this.opts.emit({ type: 'session.failed', sessionId, payload: { error } });
    }
  }

  /**
   * Retire the in-flight turn and let the session accept a new send.
   *
   * `terminalAlreadyEmitted` is for the one path where the wire already told the
   * renderer how the turn ended (`turn/completed` -> the normalizer emitted
   * `session.completed` / `session.failed` from the frame's own status). Every
   * other path has to synthesize the terminal, or the assistant message and the
   * thinking block stay open on screen forever.
   *
   * The record is cleared BEFORE the terminal is emitted, so a handler that
   * re-enters (an emit that stops the session, say) sees no turn and cannot
   * close the same one twice.
   */
  private finishTurn(
    state: CodexSessionState,
    outcome: 'completed' | 'failed' | 'stopped',
    error?: string,
    opts: { terminalAlreadyEmitted?: boolean } = {}
  ): void {
    const turn = state.turn;
    if (!turn) return;
    state.turn = null;
    const session = this.opts.registry.get(state.sessionId);
    if (session) session.running = false;
    this.log('codex turn ended', {
      sessionId: state.sessionId,
      turnId: turn.turnId,
      outcome,
      stats: turn.normalizer.stats(),
    });
    if (!opts.terminalAlreadyEmitted) turn.normalizer.closeTurn(outcome, error);
  }

  /**
   * Ask codex to abandon the running turn. Best effort, never awaited.
   *
   * ## Why the caller drains the pending table FIRST
   *
   * A turn that is waiting on an approval or a question is waiting on US: codex
   * has a server request outstanding and its turn task is parked on our reply.
   * Interrupting first would put the interrupt behind that parked task — we
   * would be asking a process to stop doing something it has stopped doing
   * pending our answer. Draining first writes the fail-safe refusals (`cancel` /
   * `decline` / empty answers — no drain body can ever be read as consent),
   * which unblocks the turn loop so the interrupt is actually processed. The
   * window this opens is one event-loop tick during which codex may resume: the
   * interrupt is written immediately after, and anything started inside it dies
   * with the turn.
   *
   * Sending nothing at all is the honest outcome when the turn id is unknown
   * (see `buildTurnInterruptParams`) or the link is already gone; the caller
   * still closes the turn locally, so Stop always frees the session.
   */
  private interruptTurn(state: CodexSessionState, why: string): void {
    const turn = state.turn;
    if (!turn) return;
    const turnId = turn.turnId ?? turn.normalizer.currentTurnId() ?? undefined;
    if (!state.connection.alive) {
      this.log('codex turn/interrupt skipped: connection already gone', {
        sessionId: state.sessionId,
        why,
      });
      return;
    }
    if (!state.threadId || !turnId) {
      // The turn exists but has not named itself yet (no frame back from
      // `turn/start`). A malformed interrupt would be refused with -32602 and
      // would leave a log line claiming we asked codex to stop when we did not.
      this.log('WARN codex turn/interrupt skipped: turn id unknown', {
        sessionId: state.sessionId,
        why,
      });
      return;
    }
    this.log('codex turn/interrupt', { sessionId: state.sessionId, turnId, why });
    void state.connection
      .request(
        CODEX_METHOD.turnInterrupt,
        buildTurnInterruptParams({ threadId: state.threadId, turnId }),
        CODEX_TURN_INTERRUPT_TIMEOUT_MS
      )
      .then(() => this.log('codex turn/interrupt acknowledged', { sessionId: state.sessionId }))
      .catch((err: unknown) => {
        // Logged, never surfaced: Stop has already freed the session locally, so
        // a failed interrupt must not turn into an error the user has to read.
        // An unhandled rejection here would take the whole Host down.
        //
        // A teardown interrupt is EXPECTED to end this way: `dispose()` kills
        // the process one line after we wrote the frame, and rejects everything
        // outstanding. Calling that a WARN would put a scary line in the log on
        // every ordinary session close.
        const expected = err instanceof CodexConnectionClosedError;
        this.log(
          expected
            ? 'codex turn/interrupt unanswered (link closed)'
            : 'WARN codex turn/interrupt failed',
          { sessionId: state.sessionId, error: errorMessage(err) }
        );
      });
  }

  /**
   * Drain, THEN interrupt, THEN dispose. Each step is ordered against the next:
   *
   *  - drain before interrupt, because a turn parked on an approval never reads
   *    the interrupt (see `interruptTurn`);
   *  - both before `dispose()`, because dispose kills the process and after that
   *    there is no stdin to write any of those frames to — every pending
   *    question and approval would be dropped without an answer, which is
   *    precisely the "cleared the table but never replied" failure the pending
   *    table exists to prevent.
   *
   * Any turn still open when this returns is closed as `stopped`. Callers that
   * know a better outcome (the exit path knows the turn FAILED) close it before
   * calling in; this is the backstop that makes "no teardown leaves a turn
   * streaming" true for every path, including ones added later.
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
    this.interruptTurn(state, disposeReason);
    state.connection.dispose(disposeReason);
    this.sessions.delete(state.sessionId);
    this.finishTurn(state, 'stopped');
  }

  /**
   * Stop = settle everything codex is waiting on, interrupt the turn, free the
   * session. All three, in that order — see `interruptTurn` for why the drain
   * comes first, and note that the two halves fail differently: an interrupt
   * without a drain does not reach a parked turn, and a drain without an
   * interrupt leaves the model working after the user pressed Stop.
   *
   * The turn is then closed LOCALLY rather than waiting for codex to confirm it.
   * Whether an interrupted turn reports back at all is [未测]
   * (`TurnStatus` does have an `interrupted` member, so it probably does), and
   * "Stop leaves the session unable to send until a frame we are not sure is
   * coming arrives" is the worse failure. The cost is that late frames from the
   * abandoned turn are dropped with a log line.
   *
   * No status is invented here. The echo below reports the registry's own last
   * reading, exactly as in slice 2a — `stopping` would be a second, derived
   * status source, which C10 rule 3 forbids. Codex's own `thread/status/changed`
   * converges the session a moment later.
   *
   * That echo goes out BEFORE the terminal, and the order is load-bearing. The
   * registry's last reading during a live turn is `running` or
   * `waiting_permission`; `session.stopped` is what puts the renderer back to
   * idle. Echoing behind it therefore re-applies a busy status the turn no
   * longer justifies, and the renderer's own send gate
   * (`chatSessions.isBusyStatus`) refuses the next message outright — leaving
   * Stop unable to free the session until a frame arrives that this method has
   * just finished explaining it will not wait for.
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
    this.interruptTurn(state, 'stop');
    this.opts.emit({
      type: 'session.status',
      sessionId: input.sessionId,
      requestId: input.requestId,
      payload: { status: session.status },
    });
    this.finishTurn(state, 'stopped');
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
   * Run one turn.
   *
   * The signature mirrors the Claude runtime's (async, same fields) so that
   * `index.ts` dispatches to either through ONE call site: two call sites would
   * be two places deciding which runtime owns a session, and they would drift.
   *
   * ## What this method deliberately does NOT emit
   *
   *  - No user echo. Codex sends the prompt back as an `item/started`
   *    `userMessage` [实测 fixture frame 1] and the normalizer renders THAT, so
   *    a local echo would draw the message twice. The visible consequence is
   *    that the echo lands one round trip later than on the Claude path.
   *  - No `session.status`. The status a turn produces is codex's own
   *    `thread/status/changed` (the fixture's very first frame), and C10 rule 3
   *    gives it exactly one writer. A `running` emitted here would race that
   *    frame and could overwrite a `waiting_permission` that had already landed.
   *
   * The `await` returns when `turn/start` is answered, NOT when the turn ends;
   * `index.ts` calls this fire-and-forget either way.
   */
  async send(input: {
    sessionId: string;
    text?: string;
    attachments?: unknown;
    effort?: unknown;
    model?: unknown;
    requestId?: string;
  }): Promise<void> {
    const { sessionId, requestId } = input;
    const state = this.sessions.get(sessionId);
    const session = this.opts.registry.get(sessionId);
    if (!state || !session) {
      this.fail('session_not_found', `Unknown session: ${sessionId}`, { sessionId, requestId });
      return;
    }
    if (state.turn) {
      // Same code the Claude runtime uses, because the renderer's bounded
      // send-retry keys on this exact string; a Codex-only spelling would turn a
      // transient collision into a dropped message.
      this.fail('session_busy', 'Session already has an active turn', { sessionId, requestId });
      return;
    }
    if (!state.threadId) {
      // The handshake is still in flight. `session_busy` (not a hard failure)
      // because this resolves on its own within a round trip, which is exactly
      // the case the renderer's retry exists for.
      this.fail('session_busy', 'session.send: the Codex thread is still starting', {
        sessionId,
        requestId,
      });
      return;
    }

    const attachments = Array.isArray(input.attachments) ? input.attachments : [];
    if (attachments.length > 0) {
      // Refused whole rather than sent without them. `UserInput` does have
      // `image` / `localImage` / `audio` variants [实测 codex-turn-schema.json],
      // but they take a `url` or an absolute `path` while our attachments are
      // inline base64 with a media type — the translation (data: URL? spool to a
      // temp file?) has no measured frame behind it. Dropping them silently
      // would be worse than refusing: the user would watch the model answer
      // confidently about an image it never received.
      this.fail(
        'not_implemented',
        'session.send: the Codex runtime cannot carry attachments yet — codex takes ' +
          'image input by url or path, and how to hand it inline data is not settled. ' +
          'Send the text on its own, or use the Claude agent for this message.',
        { sessionId, requestId }
      );
      return;
    }

    const text = typeof input.text === 'string' ? input.text : '';
    if (text.trim().length === 0) {
      this.fail('invalid_payload', 'session.send requires text for a Codex turn', {
        sessionId,
        requestId,
      });
      return;
    }

    const turn: CodexTurnState = {
      requestId,
      // One per turn, pinned to this thread so a frame from another thread
      // cannot be projected onto this session (C12).
      normalizer: new CodexNormalizer({
        sessionId,
        emit: this.opts.emit,
        log: (...args: unknown[]) => this.log('[codex-normalizer]', ...args),
        threadId: state.threadId,
      }),
    };
    // Installed BEFORE the request is written: the first notifications of the
    // turn can arrive before the response does, and a normalizer installed
    // afterwards would miss them.
    state.turn = turn;
    session.running = true;

    const params = buildTurnStartParams({ threadId: state.threadId, text });
    try {
      const result = await state.connection.request(
        CODEX_METHOD.turnStart,
        params,
        CODEX_TURN_START_TIMEOUT_MS
      );
      if (state.turn !== turn) {
        // Stop, close or an exit retired this turn while we waited. Whatever
        // came back describes a turn nobody is listening for any more.
        this.log('codex turn/start answered a turn that had already ended', { sessionId });
        return;
      }
      const turnId = readTurnStartId(result);
      if (turnId) turn.turnId = turnId;
    } catch (err) {
      const message = errorMessage(err);
      if (state.turn !== turn) {
        // The teardown paths already emitted this turn's terminal (and the
        // connection rejects every outstanding promise as it closes, which is
        // how we usually get here). Reporting again would fail a session that
        // has already been told what happened — or worse, a NEWER turn.
        this.log('codex turn/start failed after the turn ended', { sessionId, error: message });
        return;
      }
      this.log('codex turn/start failed', { sessionId, error: message });
      // `session.failed` IS the correlated failure for this send: the renderer
      // folds this session's `session.failed` into the pending send's error.
      // A second `host.error` would double-report one failure.
      this.finishTurn(state, 'failed', `session.send: ${message}`);
    }
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

  /**
   * Project the timeline event for a question that left the pending table
   * WITHOUT the user answering it: a drain (stop / close / process exit) or the
   * server resolving its own request.
   *
   * `'answered'` is excluded because `respondQuestion` has already emitted the
   * richer event (with the answers, and with `cancelled` vs `answered`
   * distinguished). Emitting again here would deliver a second
   * `question.resolved` for the same id, and the store applies the last one it
   * sees — so answering a question would repaint the card as "Questions
   * skipped".
   *
   * Non-question kinds are the approval bridge's business (slice 4).
   */
  private projectSettledQuestion(entry: PendingServerRequest, reason: PendingSettleReason): void {
    if (entry.kind !== 'question' || reason === 'answered') return;
    this.opts.emit({
      type: 'question.resolved',
      sessionId: entry.sessionId,
      payload: { questionId: entry.correlationId, outcome: 'rejected' },
    });
  }

  /**
   * Answer a parked `item/tool/requestUserInput`.
   *
   * The questions are re-derived from the entry's untouched wire params rather
   * than cached at request time: one function, one reading, so the keys we
   * answer with cannot drift from the keys we asked with.
   */
  respondQuestion(input: {
    sessionId: string;
    questionId?: string;
    answers?: Record<string, string>;
    response?: string;
    cancel?: boolean;
    requestId?: string;
  }): void {
    const { sessionId, questionId } = input;
    const state = this.sessions.get(sessionId);
    if (!state || !questionId) {
      this.fail('invalid_payload', 'question.respond: unknown session or missing questionId', {
        sessionId,
        requestId: input.requestId,
      });
      return;
    }

    // Scanned, not parsed back into an id: `sessionId` may contain ':', so
    // splitting the correlation id is a parser waiting to be wrong. The table
    // holds a handful of entries at most.
    const entry = state.pending.list().find((candidate) => candidate.correlationId === questionId);

    if (!entry) {
      // NOT a host.error. A non-fatal `host.error` is invisible in the renderer
      // (`hostStatus.ts` returns the previous state for it and the chat store
      // has no branch at all), and this is exactly the race where the user
      // needs feedback: the server auto-resolved or the turn was interrupted
      // while the card was still on screen, and the click landed after the
      // entry was gone. Re-emitting the resolution is idempotent and clears the
      // dock, so the UI converges instead of freezing on a card that can never
      // be answered.
      this.log('codex question.respond: no pending entry, re-resolving', {
        sessionId,
        questionId,
      });
      this.opts.emit({
        type: 'question.resolved',
        sessionId,
        payload: { questionId, outcome: 'rejected' },
      });
      return;
    }

    if (entry.kind !== 'question' || entry.sessionId !== sessionId) {
      // A real shape error rather than a race: the id addressed something that
      // is not a question, or belongs to another session. Nothing to converge.
      this.fail(
        'invalid_payload',
        `question.respond: ${questionId} is not this session's question`,
        {
          sessionId,
          requestId: input.requestId,
        }
      );
      return;
    }

    const { items } = toQuestionItems(entry.params);
    const { body, unmatched, responseIgnored } = toCodexAnswerBody(items, input);
    if (unmatched > 0) {
      this.log('WARN codex question.respond had unanswered questions', {
        sessionId,
        questionId,
        unmatched,
      });
    }
    if (responseIgnored) {
      // Folding one free-text response into several questions would tell the
      // model it answered things it was never asked.
      this.log('WARN codex question.respond dropped a free-text response', {
        sessionId,
        questionId,
        questions: items.length,
      });
    }

    state.pending.settle(entry.requestId, { reason: 'answered', result: body });

    const answers =
      input.answers && Object.keys(input.answers).length > 0 ? input.answers : undefined;
    const response =
      typeof input.response === 'string' && input.response.length > 0 ? input.response : undefined;
    this.opts.emit({
      type: 'question.resolved',
      sessionId,
      requestId: input.requestId,
      payload: {
        questionId,
        outcome: input.cancel === true ? 'cancelled' : 'answered',
        ...(input.cancel === true
          ? {}
          : { ...(answers ? { answers } : {}), ...(response ? { response } : {}) }),
      },
    });
  }
}
