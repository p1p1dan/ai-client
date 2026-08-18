/**
 * Claude Runtime Adapter — Agent SDK (default) over pinned Cometix cli.js.
 * Emits AiClient Runtime Events via EventNormalizer; no Electron deps.
 */

import {
  type AgentHostDriver,
  isSessionEffortLevel,
  type SessionAttachment,
  type SessionEffortLevel,
} from '../shared/types/agentHost.ts';
import { CLAUDE_CODE_AGENT, CLAUDE_CODE_AGENT_ARM } from '../shared/types/agentWire.ts';
import {
  claudePermissionPreference,
  DANGEROUS_PERMISSION_MODE,
  type SessionLivenessNote,
  type SessionPermissionMode,
  type SessionPermissionPolicy,
  type SessionPermissionPreference,
  type SessionRuntimeStatus,
} from '../shared/types/runtimeEvents.ts';
import { type EmitFn, EventNormalizer, type LogFn } from './eventNormalizer.ts';
import { type HistoryReadResult, readSessionHistory } from './historyReader.ts';
import { PermissionBridge } from './permissionBridge.ts';
import { QuestionBridge, type QuestionRespondInput } from './questionBridge.ts';
import type { HostSession, SessionRegistry } from './sessionRegistry.ts';
import { STDERR_FORWARD_MAX_LINES_PER_TURN, sanitizeStderrLine } from './stderrRedaction.ts';
import { TtftWatchdog } from './ttftWatchdog.ts';

export interface ClaudeRuntimeOptions {
  driver: AgentHostDriver;
  cliPath: string;
  /** Merged process + ~/.claude/settings.json env for SDK child. */
  env: NodeJS.ProcessEnv;
  emit: EmitFn;
  log?: LogFn;
  registry: SessionRegistry;
  /** Test seam — replaces the lazily imported Agent SDK query(). */
  queryFn?: SdkQueryFn;
}

type SdkQueryFn = (params: {
  prompt: string | AsyncIterable<Record<string, unknown>>;
  options?: Record<string, unknown>;
}) => AsyncIterable<unknown> & { close?: () => void };

/**
 * C-13: attachments ride as content blocks inside a single-message stream
 * (query() accepts AsyncIterable<SDKUserMessage>; plain sends keep the
 * string prompt path untouched). Shapes verified by c13-attachment-probe.
 */
function buildPromptWithAttachments(
  text: string,
  attachments: SessionAttachment[]
): AsyncIterable<Record<string, unknown>> {
  const content: Record<string, unknown>[] = [];
  if (text) content.push({ type: 'text', text });
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mediaType,
          data: attachment.data,
        },
      });
    } else {
      content.push({
        type: 'document',
        source: {
          type: 'text',
          media_type: attachment.mediaType || 'text/plain',
          data: attachment.data,
        },
        ...(attachment.name ? { title: attachment.name } : {}),
      });
    }
  }
  return (async function* oneUserMessage() {
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
  })();
}

/**
 * C-14 stall watchdog default: a turn whose SDK stream produces no events at
 * all for this long is aborted with an explicit session.failed (invalid model
 * and gateway hangs otherwise leave the UI in `running` forever). Waiting on
 * a permission/question prompt or an in-flight local tool never counts as a
 * stall. 0 (or negative) disables the watchdog.
 */
const DEFAULT_STALL_TIMEOUT_MS = 195_000;

function resolveStallTimeoutMs(): number {
  const raw = process.env.AICLIENT_HOST_STALL_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_STALL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_STALL_TIMEOUT_MS;
  return parsed;
}

/**
 * a4 (2026-07-30 net-visibility batch): one-shot "time to first productive
 * event" budget — deliberately far shorter than DEFAULT_STALL_TIMEOUT_MS
 * (195s) above. The two are two segments of ONE turn lifeline: this budget
 * watches the gap before the first sign of life, the stall budget watches the
 * gaps after it. See ttftWatchdog.ts for why this is a separate mechanism
 * rather than just a shorter stall timeout.
 *
 * F2 (2026-08-18 watchdog redesign): the old note here required this to stay
 * BELOW the renderer's 45s send budget so the Host would win a race against
 * the Composer's generic "no progress" fallback. That invariant is REVERSED:
 * the renderer no longer renders a verdict at all, its budget became a 300s
 * SILENCE ceiling that sits ABOVE the stall budget, and the Host — the only
 * side holding the evidence and the only side that can actually abort — is
 * now structurally guaranteed to speak first. Nothing on this side needs to
 * beat a renderer deadline any more.
 * <= 0 disables it (mirrors resolveStallTimeoutMs's convention).
 */
const DEFAULT_TTFT_TIMEOUT_MS = 32_000;

/**
 * F2 (2026-08-18) §2.4: the ONLY event types that count as model progress —
 * they satisfy the TTFT watchdog and re-arm the stall watchdog. Module scope
 * (was a per-send local) so the vocabulary can be pinned by a test as a set,
 * because membership here is a judgement and not a list: `system` events are
 * control-plane, and an invalid model puts the CLI into an endless `api_retry`
 * loop that streams them forever. Admit `system` and a hang re-arms its own
 * watchdog — the C-14 detector stops detecting.
 *
 * FROZEN: not one member is to be added. `claudeRuntimePartialStall.test.ts`
 * and [E-5] in `claudeRuntimeOptions.test.ts` both go red on any edit, and
 * that red is correct.
 */
export const PRODUCTIVE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'assistant',
  'user',
  'result',
  'tool_progress',
  'stream_event',
]);

/**
 * F2 (2026-08-18) §2.5: read one `api_retry` field off the RAW SDK event
 * (snake_case, e.g. `max_retries`). A missing field is `null` — "no evidence"
 * — and NEVER `0`.
 *
 * This is load-bearing, not defensive style. The NORMALIZED wire payload
 * bottoms both fields out to `0` (`eventNormalizer.ts`:
 * `typeof msg.attempt === 'number' ? msg.attempt : 0`). An abort gate reading
 * that projection instead would compute `0 >= 0` on a retry frame that simply
 * omitted the fields, and kill the turn on its FIRST retry — worse than the
 * behavior this batch exists to fix. `session.status.payload.retry` serves
 * display and diagnostics only; the gate keys here.
 */
function readRawRetryField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveTtftTimeoutMs(): number {
  const raw = process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_TTFT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TTFT_TIMEOUT_MS;
  return parsed;
}

/**
 * F10 (round-2 review fix): once the turn's terminal `result` event lands,
 * how much longer the SDK stream is allowed to keep draining (CLI transcript
 * flush, subprocess teardown) before the `finally` teardown forces it. Caps
 * the "queue admits a new send while the old one tidies up" window so a slow
 * or hung teardown can never block indefinitely.
 *
 * R8 (round-2 iteration-2 review): env-overridable — same pattern as
 * `resolveStallTimeoutMs`/`resolveTtftTimeoutMs` above — so the deadline
 * branch (a stream that hangs past the cap after `result`) is exercisable
 * under `pnpm vitest` without a real 2s wait.
 */
/**
 * T-34 feature flag (standard #6: ship behind a flag, run both positions).
 *
 * `'0'` is QUIET, not legacy. In both positions the normalizer segregates
 * subagent traffic out of the main `tool.started`/`tool.completed` stream —
 * that half is the fix for a shipped defect (subagent tool calls rendering as
 * the main agent's) and must not be switchable back on. What the flag governs
 * is whether the segregated facts are FORWARDED as `subagent.activity` and
 * whether the SDK is asked to include subagent text/thinking at all.
 *
 * Read per send (not at module load) so a test can flip it between turns,
 * mirroring `resolveStallTimeoutMs`'s own convention.
 */
export function resolveSubagentActivityEnabled(): boolean {
  const raw = process.env.AICLIENT_HOST_SUBAGENT_ACTIVITY;
  if (raw === undefined || raw === '') return true;
  return raw !== '0';
}

/**
 * F2 (2026-08-18) §9.2 — QUIET bit for the watchdog liveness note, shaped
 * deliberately like `resolveSubagentActivityEnabled` above.
 *
 * `'0'` stops EMITTING a diagnostic frame nobody is consuming; it does not
 * restore any previous judgement, because there is no previous judgement to
 * restore — the decision to abort or not is taken on the same evidence in both
 * positions. This is a test seam and an ops knob (wire-snapshot determinism is
 * its main real use), NOT a product rollout gate.
 *
 * Read per send, so a test can flip it between turns.
 */
export function resolveLivenessNoteEnabled(): boolean {
  const raw = process.env.AICLIENT_HOST_LIVENESS_NOTE;
  if (raw === undefined || raw === '') return true;
  return raw !== '0';
}

/**
 * Partial-messages feature flag (D33③: default ON), 片 1a.
 *
 * `includePartialMessages` makes the CLI forward the raw Anthropic stream
 * (`message_start` / `content_block_*` / `message_delta`) as `stream_event`
 * SDK messages — the source for character-level text, live thinking, and the
 * turn's in-flight token counter. The spike confirmed the pinned CLI+SDK pair
 * honours it (44~106 `stream_event` per turn against a control-position zero).
 *
 * `'0'` is the ROLLBACK position and it is a real one: with the option absent
 * the normalizer's partial gate never opens (it decides on observed fact, not
 * on this flag), so the Host emits exactly the pre-batch event stream —
 * pinned by `__tests__/eventNormalizerGolden.test.ts`.
 *
 * Read per send, mirroring `resolveSubagentActivityEnabled` above.
 */
export function resolveHostPartialMessagesEnabled(): boolean {
  const raw = process.env.AICLIENT_HOST_PARTIAL_MESSAGES;
  if (raw === undefined || raw === '') return true;
  return raw !== '0';
}

const DEFAULT_DRAIN_AFTER_RESULT_MS = 2_000;

function resolveDrainAfterResultMs(): number {
  const raw = process.env.AICLIENT_HOST_DRAIN_AFTER_RESULT_MS;
  if (raw === undefined || raw === '') return DEFAULT_DRAIN_AFTER_RESULT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_DRAIN_AFTER_RESULT_MS;
  return parsed;
}

/**
 * #8 (2026-07-27): thinking config sent to query().
 *
 * `display` is the load-bearing field. On Opus 4.8/4.7, Sonnet 5 and Fable 5 it
 * defaults to `omitted`, which streams thinking blocks whose text is an empty
 * string — that, not any broken code link, is why T-04's thinking card had
 * nothing to render. `summarized` puts real text on the wire.
 *
 * Evidence — spikes/c16-thinking-shape-probe.ts on the CCH gateway,
 * model claude-opus-4-8[1m], cometix 2.1.212 / SDK 0.3.218:
 *   {type:'adaptive'}                        → 1 thinking block, text length 0
 *   {type:'adaptive', display:'summarized'}  → 1 thinking block, text length 408
 * The summarized runs also emit system/thinking_tokens events (8–9 per turn)
 * that the bare-adaptive runs never produced.
 *
 * `adaptive` (not the previous `{type:'enabled', budgetTokens}`) is the shape
 * current models actually document: the fixed-budget form is deprecated on
 * Opus 4.6/Sonnet 4.6 and removed on Opus 4.8/4.7, Sonnet 5 and Fable 5, so it
 * is a latent 400 the moment the gateway stops tolerating it. NOTE: the same
 * probe found the old shape still returns 200 on this gateway today, so it was
 * NOT the cause of the C-14 "400 thinking 格式无效" transient — that stays open.
 */
const THINKING_CONFIG = { type: 'adaptive', display: 'summarized' } as const;

/**
 * T-14 (Codex precedent T-20, optional-field addition): the DEFAULT permission
 * mode a session runs with. Interactive prompts via `canUseTool` (Permission
 * timeline cards), never an SDK bypass.
 *
 * D48 S3: it is no longer the only source — `session.create` / `session.resume`
 * may carry a `permissionPreference`, which this constant backstops. What did
 * NOT change is the rule this constant's old header existed to enforce: it
 * feeds THREE places at once — the query() `permissionMode` option, the
 * `session.created` payload and the `session.resumed` payload — and all three
 * must read the SAME value, or the Context surface reports a posture the SDK
 * never received (06-probes P2, direction 2). So none of the three reads this
 * constant directly any more: they all go through
 * `sessionPermissionMode(session)` below, which is the one place the fallback
 * happens.
 *
 * Never a dangerous tier: this value IS the fallback arm for a missing,
 * malformed or mis-addressed preference, and §5.4-4 forbids a dangerous default
 * (asserted, C13).
 */
export const CHAT_PERMISSION_MODE: SessionPermissionMode = 'default';

/**
 * Preference (a request, possibly absent or for the wrong agent) → the mode
 * this Host will actually run.
 *
 * The arm check is not paranoia: `SessionPermissionPreference` is a
 * discriminated union and the Codex arm has no `permissionMode` at all, so
 * without it a Codex-shaped preference that slipped through would put
 * `undefined` into the query options — which the SDK reads as "no mode was
 * requested" rather than as an error.
 */
export function resolveClaudePermissionMode(
  preference: SessionPermissionPreference | undefined
): SessionPermissionMode {
  return (
    claudePermissionPreference(preference, CLAUDE_CODE_AGENT)?.permissionMode ??
    CHAT_PERMISSION_MODE
  );
}

/**
 * The single reader the three consumption points share. Exported so the
 * four-place assertion (C11) can compare the registry's own value against what
 * went out on the wire, rather than comparing two literals to each other.
 */
export function sessionPermissionMode(session: HostSession | undefined): SessionPermissionMode {
  return resolveClaudePermissionMode(session?.permissionPreference);
}

/**
 * D48 S4 — the same value as a `SessionPermissionPolicy`, for the facts echo
 * (`session.settingsEcho`) this axis emits per turn.
 *
 * `CLAUDE_CODE_AGENT_ARM`, not `CLAUDE_CODE_AGENT`: this field is the
 * discriminant of a union typed with literals, and the ordinary constant is the
 * wider `AgentWireName`, which cannot narrow it. Writing the literal here
 * instead is what the value-position scan in `agentWireStatic.test.ts` bans —
 * the name has one home, and the narrow spelling lives there too. The two are
 * pinned equal by assertion so they cannot drift.
 */
export function claudePermissionPolicy(mode: SessionPermissionMode): SessionPermissionPolicy {
  return { agent: CLAUDE_CODE_AGENT_ARM, permissionMode: mode };
}

/**
 * SDK 0.3.218 refuses `permissionMode:'bypassPermissions'` unless this key is
 * ALSO set [实测 sdk.d.ts:1729, 06-probes P2(b)]. It is spread in (not set to
 * `false`) for the other four tiers, so "we never asked to skip permissions" is
 * an absent key rather than a value the SDK has to interpret — and the negative
 * half is asserted with `in`, because a build that sent it everywhere would
 * silently widen every session (C16).
 */
export function dangerousSkipPermissionsOption(
  mode: SessionPermissionMode
): { allowDangerouslySkipPermissions: true } | Record<string, never> {
  return mode === DANGEROUS_PERMISSION_MODE ? { allowDangerouslySkipPermissions: true } : {};
}

/**
 * Guard the protocol boundary: `effort` arrives as untrusted JSON from Main, and
 * an unknown value would be forwarded verbatim into query() and rejected by the
 * API. Drop it instead so the turn still runs at the model default.
 *
 * The vocabulary itself moved to `shared/types/agentHost.ts` in D48, because the
 * Codex axis needs the same judgement for `turn/start.effort` and two copies of
 * a five-word table is two chances to disagree.
 */
export function normalizeEffort(value: unknown): SessionEffortLevel | undefined {
  return isSessionEffortLevel(value) ? value : undefined;
}

/**
 * F8 (round-2 review fix): status to report alongside a compensating
 * `permission.resolved` (respondPermission's `!ok` branch) — the renderer
 * must converge on the ACTUAL current state, not stay pinned on
 * `waiting_permission` just because that used to be true.
 *
 * R14 (round-2 iteration-2 review): `HostSession` itself structurally cannot
 * represent `waiting_permission`/`waiting_question` — neither
 * `PermissionBridge` nor `QuestionBridge` ever writes into the registry, they
 * only `emit()` that status directly — so reading `session.status` alone
 * would report `'running'` (or whatever the registry's own field last held)
 * even while the renderer is, in fact, correctly parked waiting on a
 * DIFFERENT pending prompt on this same session (the desync this
 * compensation path exists to recover from does not imply every OTHER
 * prompt has also gone stale). `pending` — read from the live bridges at the
 * call site — is checked first so it wins even while `session.running` is
 * also true (a turn stays `running` host-side while `canUseTool` awaits the
 * user; that does not make the renderer's own "waiting" state wrong).
 * A missing session (e.g. Host restarted, registry is fresh) reports `idle`.
 */
export function resolveCompensationStatus(
  session: HostSession | undefined,
  pending?: { permission?: boolean; question?: boolean }
): SessionRuntimeStatus {
  if (!session) return 'idle';
  if (pending?.permission) return 'waiting_permission';
  if (pending?.question) return 'waiting_question';
  if (session.running) return 'running';
  return session.status === 'waiting_permission' || session.status === 'waiting_question'
    ? 'idle'
    : session.status;
}

export class ClaudeRuntime {
  private queryFn: SdkQueryFn | null = null;
  private readonly log: LogFn;
  private readonly opts: ClaudeRuntimeOptions;
  private readonly permissions: PermissionBridge;
  private readonly questions: QuestionBridge;

  constructor(opts: ClaudeRuntimeOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((...args) => console.error('[claude-runtime]', ...args));
    // S8 (round-2 iteration-3 review): each bridge's own `settle()` must see
    // whether the OTHER bridge still holds a pending prompt for the same
    // session (parallel tool_use can park a permission AND a question at
    // once) — wired here since ClaudeRuntime is the only place that
    // constructs both. Safe despite the apparent forward reference: neither
    // closure is INVOKED until a real request settles, well after both
    // fields below have been assigned.
    this.permissions = new PermissionBridge(opts.emit, this.log, (sessionId) =>
      this.questions.hasPending(sessionId)
    );
    this.questions = new QuestionBridge(opts.emit, this.log, (sessionId) =>
      this.permissions.hasPending(sessionId)
    );
  }

  get driver(): AgentHostDriver {
    return this.opts.driver;
  }

  /** Lazy-load Agent SDK query export. */
  private async ensureSdk(): Promise<SdkQueryFn> {
    if (this.opts.driver !== 'agent-sdk') {
      throw new Error(`Driver ${this.opts.driver} not implemented in Phase 2 slice 1`);
    }
    if (this.opts.queryFn) return this.opts.queryFn;
    if (this.queryFn) return this.queryFn;
    const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
      query?: SdkQueryFn;
      default?: { query?: SdkQueryFn };
    };
    const fn = sdk.query ?? sdk.default?.query;
    if (!fn) throw new Error('claude-agent-sdk has no query() export');
    this.queryFn = fn;
    return fn;
  }

  createSession(input: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    /** Untrusted at this boundary (raw NDJSON payload) — normalized below. */
    effort?: unknown;
    /**
     * D48 S3 §5.5 — the requested posture. Untrusted at this boundary, and
     * absent for every caller that predates the field (= today's constant).
     */
    permissionPreference?: unknown;
    requestId?: string;
  }): void {
    const session = this.opts.registry.create({
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      // S2 (b): the runtime states which agent it is. Main must not infer the
      // binding from which adapter it happened to call — that inference breaks
      // the moment a second runtime exists, and the wrong value would then be
      // persisted into `session-index.json`, where it outlives the mistake.
      agent: CLAUDE_CODE_AGENT,
      model: input.model,
      effort: normalizeEffort(input.effort),
      permissionPreference: claudePermissionPreference(
        input.permissionPreference,
        CLAUDE_CODE_AGENT
      ),
    });
    this.opts.emit({
      type: 'session.created',
      sessionId: session.sessionId,
      requestId: input.requestId,
      // A brand-new Claude session has no runtimeIdentity yet (the SDK issues
      // it on the first turn), so `agent` is the ONLY field this event carries
      // for the index to write — see SessionIndexService.applyRuntimeEvent.
      // Consumption point 2 of 3 (06-probes P2): the same reader as the query
      // options, so what the surface shows is what the SDK was handed.
      payload: { agent: session.agent, permissionMode: sessionPermissionMode(session) },
    });
    this.opts.emit({
      type: 'session.status',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { status: 'idle' },
    });
  }

  resumeSession(input: {
    sessionId: string;
    workspacePath: string;
    runtimeIdentity: string;
    model?: string;
    /** Untrusted at this boundary (raw NDJSON payload) — normalized below. */
    effort?: unknown;
    /** D48 S3 §5.5 — the posture recorded in the session snapshot. */
    permissionPreference?: unknown;
    requestId?: string;
  }): void {
    // CP4 F-1: resuming a session with an active turn would orphan its
    // abort/running state — reject instead of re-registering.
    const current = this.opts.registry.get(input.sessionId);
    if (current?.running) {
      this.opts.emit({
        type: 'host.error',
        sessionId: input.sessionId,
        requestId: input.requestId,
        payload: {
          code: 'session_busy',
          message: `Cannot resume while a turn is running: ${input.sessionId}`,
          fatal: false,
        },
      });
      return;
    }
    const session = this.opts.registry.resume({
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      runtimeIdentity: input.runtimeIdentity,
      agent: CLAUDE_CODE_AGENT,
      model: input.model,
      effort: normalizeEffort(input.effort),
      permissionPreference: claudePermissionPreference(
        input.permissionPreference,
        CLAUDE_CODE_AGENT
      ),
    });
    this.opts.emit({
      type: 'session.resumed',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: {
        agent: session.agent,
        runtimeIdentity: session.runtimeIdentity,
        // Consumption point 3 of 3 — same reader, same value.
        permissionMode: sessionPermissionMode(session),
      },
    });
    // Per-session order contract: resumed → session.history → status idle.
    // The JSONL read runs detached so the command loop stays responsive.
    void this.replayHistory(input);
  }

  private async replayHistory(input: {
    sessionId: string;
    workspacePath: string;
    runtimeIdentity: string;
    requestId?: string;
  }): Promise<void> {
    let result: HistoryReadResult;
    try {
      result = await readSessionHistory({
        workspacePath: input.workspacePath,
        runtimeIdentity: input.runtimeIdentity,
      });
    } catch (err) {
      // readSessionHistory is contract-bound to not throw; belt and braces.
      result = {
        messages: [],
        truncated: false,
        omittedCount: 0,
        parseStats: { totalLines: 0, controlLines: 0, badLines: 0 },
        error: {
          code: 'read_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    // Session may have been closed while reading — drop silently.
    if (!this.opts.registry.get(input.sessionId)) return;
    if (result.error) {
      this.log(
        `history read for ${input.sessionId}: ${result.error.code} — ${result.error.message}`
      );
    }
    this.opts.emit({
      type: 'session.history',
      sessionId: input.sessionId,
      requestId: input.requestId,
      payload: {
        runtimeIdentity: input.runtimeIdentity,
        workspacePath: input.workspacePath,
        messages: result.messages,
        truncated: result.truncated,
        omittedCount: result.omittedCount,
        ...(result.error ? { error: result.error } : {}),
        parseStats: result.parseStats,
      },
    });
    this.opts.emit({
      type: 'session.status',
      sessionId: input.sessionId,
      requestId: input.requestId,
      payload: { status: 'idle' },
    });
  }

  async send(input: {
    sessionId: string;
    text: string;
    attachments?: SessionAttachment[];
    /**
     * Per-turn statement, not an override with a fallback: omitted means the
     * composer's Default state and the key is dropped from query() (F3).
     * Untrusted at this boundary (raw NDJSON payload) — normalized below.
     */
    effort?: unknown;
    /**
     * Per-turn statement — omitted means Automatic and the key is dropped
     * from query() (F3); the renderer re-states an explicit pick every send.
     * Backward compatible: AGENT_HOST_PROTOCOL_VERSION stays 1, an old Host
     * ignores this field from a new Renderer.
     * Untrusted at this boundary (raw NDJSON payload) — normalized below.
     */
    model?: unknown;
    requestId?: string;
  }): Promise<void> {
    const session = this.opts.registry.get(input.sessionId);
    if (!session) {
      this.opts.emit({
        type: 'host.error',
        requestId: input.requestId,
        payload: {
          code: 'session_not_found',
          message: `Unknown session: ${input.sessionId}`,
          fatal: false,
        },
      });
      return;
    }
    if (session.running) {
      this.opts.emit({
        type: 'host.error',
        sessionId: session.sessionId,
        requestId: input.requestId,
        payload: {
          code: 'session_busy',
          message: 'Session already has an active turn',
          fatal: false,
        },
      });
      return;
    }

    if (this.opts.driver === 'stream-json') {
      this.opts.emit({
        type: 'host.error',
        sessionId: session.sessionId,
        requestId: input.requestId,
        payload: {
          code: 'not_implemented',
          message: 'stream-json driver adapter lands after agent-sdk vertical slice',
          fatal: false,
        },
      });
      return;
    }

    const queryFn = await this.ensureSdk();
    // Per-turn only (F3, 2026-08-17 inspection): an omitted model/effort IS
    // the composer's Automatic/Default state, not "no opinion". The renderer
    // re-states an explicit pick on every send (resolveResumeModel / T-20
    // toWireEffort), so falling back to the registry entry here — or re-pinning
    // onto it, as the pre-F3 code did — resurrects a choice the composer
    // already cleared: the trigger shows "Automatic" while the wire silently
    // re-sends the old pin until the Host process restarts. `session.model`/
    // `session.effort` remain the create/resume record for status surfaces;
    // they no longer feed the query.
    const effort = normalizeEffort(input.effort);
    const model =
      typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined;
    // Read ONCE per turn, off the registry entry, so the option below and any
    // later reader of this turn agree. There is still no per-send override:
    // S4's mid-session change writes the registry entry (`updatePermission`)
    // instead of adding a second parameter here, which is what makes "the tier
    // applies from the next turn" true by construction rather than by care.
    const permissionMode = sessionPermissionMode(session);
    const abort = new AbortController();
    session.abort = abort;
    session.running = true;
    session.status = 'starting';
    this.opts.registry.setStatus(session.sessionId, 'starting');

    const subagentActivityEnabled = resolveSubagentActivityEnabled();
    // 1a: the normalizer deliberately does NOT receive this flag — it decides
    // whether to dedup from the observed arrival of `stream_event`, so a
    // gateway that ignores the option degrades into today's behavior on its
    // own instead of leaving the Host in a half-configured state.
    const partialMessagesEnabled = resolveHostPartialMessagesEnabled();
    const normalizer = new EventNormalizer(
      session.sessionId,
      this.opts.emit,
      this.log,
      subagentActivityEnabled
    );
    // Round-2 P0: forward the turn's attachments so the echoed user message
    // carries their metadata — previously dropped here, before any event
    // was ever emitted (see eventNormalizer.beginTurn's attachments param).
    normalizer.beginTurn(input.text, input.attachments, input.requestId);

    this.opts.emit({
      type: 'session.status',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { status: 'running' },
    });
    session.status = 'running';

    // Match Phase 0 spike: pass absolute Node path (runtime accepts it; types list names only).
    const executablePath = process.execPath;
    const mergedEnv: NodeJS.ProcessEnv = {
      ...this.opts.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'aiclient-agent-host/0.0.1',
    };

    // AskUserQuestion parks on the question bridge (interactive answer card);
    // every other tool keeps the permission bridge flow.
    const permissionHandler = this.permissions.createCanUseTool(session.sessionId);
    const canUseTool: typeof permissionHandler = (toolName, input, options) => {
      if (toolName === 'AskUserQuestion') {
        return this.questions.request({
          sessionId: session.sessionId,
          input,
          signal: options.signal,
          toolUseId: options.toolUseID,
        });
      }
      return permissionHandler(toolName, input, options);
    };

    // C-14 stall watchdog: abort a turn whose stream goes fully silent.
    // Silence is legitimate while a user prompt is parked (permission /
    // question) or a local tool run is in flight — those re-arm instead.
    const stallTimeoutMs = resolveStallTimeoutMs();
    const drainAfterResultMs = resolveDrainAfterResultMs();
    let stalled = false;
    let stallTimer: NodeJS.Timeout | null = null;
    const onStall = () => {
      // S6 (round-2 iteration-3 review): mirrors `ttftWatchdog`'s own
      // `onTimeout` guard below — a user Stop (or any other abort) may
      // already be unwinding when this timer fires (the stall timer is only
      // cleared in the `finally` block once the query loop fully exits, so a
      // slow-to-unwind stream can outlive an abort that already landed).
      // Without this, an already-stopped turn gets relabeled `stalled` and
      // reported as a stall FAILURE instead of an honest `session.stopped`.
      if (abort.signal.aborted) return;
      if (
        this.permissions.hasPending(session.sessionId) ||
        this.questions.hasPending(session.sessionId) ||
        normalizer.hasOpenTools()
      ) {
        armStallTimer();
        return;
      }
      stalled = true;
      this.log(
        `stall watchdog: no stream events for ${stallTimeoutMs}ms on ${session.sessionId} — aborting turn`
      );
      abort.abort();
    };
    const armStallTimer = () => {
      if (stallTimeoutMs <= 0) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(onStall, stallTimeoutMs);
    };
    // a4: one-shot watchdog for the gap between queryFn() returning and the
    // turn's FIRST productive event — much shorter than the stall watchdog
    // above (see DEFAULT_TTFT_TIMEOUT_MS doc). Fires the SAME `stalled` path
    // below (explicit session.failed via emitFailed), but with its own
    // message so "never started" is distinguishable from "stalled mid-turn".
    //
    // F1 (round-2 review fix): a bare timeout is not evidence of a transport
    // failure — the SDK can legitimately spend the whole budget on a single
    // adaptive-thinking response with no incremental `stream_event`s (none
    // are requested), or park on canUseTool/AskUserQuestion before anything
    // "productive" has happened yet. Firing unconditionally there kills a
    // healthy turn and, worse, Retry resends the exact same slow prompt into
    // the exact same timeout (a deterministic failure loop). `onTimeout`
    // below mirrors the stall watchdog's own pending/open-tool guard, and
    // additionally requires positive evidence before committing to abort.
    //
    // F2 (2026-08-18) §3.2/§3.3: that evidence is now exactly two shapes, and
    // an expired window that matches neither ENDS the TTFT phase instead of
    // re-arming forever:
    //   - the SDK's own retry budget is exhausted (`attempt >= maxRetries` off
    //     the RAW event — a single `api_retry` is NOT evidence; it used to be,
    //     and it killed turns that would have succeeded on attempt 2);
    //   - total silence, not even `system/init`, for TWO windows (one window
    //     is not enough: a cold start — first `npx` fetch, slow disk, AV scan
    //     — can legitimately push the child's first frame past one budget).
    const ttftTimeoutMs = resolveTtftTimeoutMs();
    const livenessNoteEnabled = resolveLivenessNoteEnabled();
    let sawAnySdkEvent = false;
    /**
     * Most recent `api_retry` frame's raw fields — `null` means "that frame
     * did not say", which is never treated as a number (§2.5 / readRawRetryField).
     */
    let lastRetryAttempt: number | null = null;
    let lastRetryMaxRetries: number | null = null;
    /** How many TTFT windows have expired this turn (§3.3's second window). */
    let ttftWindowsElapsed = 0;
    /**
     * F2 §3.4: one watchdog window elapsed and the watchdog DECLINED to abort.
     * Optional field on `session.status`, so every consumer that already
     * switches on that type gets it without a new case and the protocol
     * version stays 1.
     *
     * The status carried is the session's CURRENT one rather than a hardcoded
     * 'running': `PermissionBridge`/`QuestionBridge` emit
     * `waiting_permission`/`waiting_question` WITHOUT ever writing
     * `HostSession.status` (see `resolveCompensationStatus`'s R14 note), so a
     * bare 'running' here would knock the renderer out of a parked state that
     * is still entirely correct — precisely the desync that helper exists to
     * repair.
     */
    const emitLivenessNote = (note: SessionLivenessNote) => {
      if (!livenessNoteEnabled) return;
      this.opts.emit({
        type: 'session.status',
        sessionId: session.sessionId,
        requestId: input.requestId,
        payload: {
          status: resolveCompensationStatus(session, {
            permission: this.permissions.hasPending(session.sessionId),
            question: this.questions.hasPending(session.sessionId),
          }),
          liveness: note,
        },
      });
    };
    const ttftWatchdog = new TtftWatchdog({
      timeoutMs: ttftTimeoutMs,
      onTimeout: () => {
        ttftWindowsElapsed += 1;
        // F14 minor m12: a Stop click (or the stall watchdog) may have
        // already aborted this turn in the same tick this timer fires — do
        // not relabel an already-stopped turn as a TTFT failure by setting
        // `stalled`. The main loop's own `abort.signal.aborted` check tears
        // the turn down correctly either way.
        //
        // R7 (round-2 iteration-2 review): the wrapper already set
        // `firedFlag = true` before calling this — reset it here so a LATER
        // stall-watchdog failure on this same (already-aborting) turn is not
        // mislabeled with the TTFT message via `stallErrorMessage()`'s
        // `hasFired` branch.
        if (abort.signal.aborted) {
          ttftWatchdog.resetFired();
          return;
        }
        // Branch B — an interactive pause is a LEGAL silence, not missing
        // evidence: the turn is parked on the USER (or on a local tool run),
        // which is the one thing a timeout must never punish. Split into two
        // checks, not one `||`, so the note names the branch that actually ran
        // instead of guessing a reason after the fact. Re-arms, and pointedly
        // does NOT degrade: later windows must still be able to speak.
        if (
          this.permissions.hasPending(session.sessionId) ||
          this.questions.hasPending(session.sessionId)
        ) {
          emitLivenessNote({
            source: 'ttft',
            budgetMs: ttftTimeoutMs,
            reason: 'awaiting_user',
            degraded: false,
          });
          ttftWatchdog.rearm();
          return;
        }
        if (normalizer.hasOpenTools()) {
          emitLivenessNote({
            source: 'ttft',
            budgetMs: ttftTimeoutMs,
            reason: 'tool_running',
            degraded: false,
          });
          ttftWatchdog.rearm();
          return;
        }
        // R9 (round-2 iteration-2 review) — RE-FRAMED by F2 (2026-08-18) §3.1,
        // because "the Host is fully defeated here" was an over-statement:
        //
        // A turn that emits `system/init` (sawAnySdkEvent becomes true) and
        // then goes silent forever with no exhausted retry is DELIBERATELY
        // handed to the 195s stall watchdog (DEFAULT_STALL_TIMEOUT_MS): its
        // shape is indistinguishable, by design, from a healthy long-running
        // turn, and the stall watchdog is the observer whose budget matches
        // that ambiguity. What used to fail here was the old cross-process
        // invariant ("TTFT always beats the renderer's 45s budget"), not the
        // Host: with the renderer's ceiling raised above the stall budget, the
        // stall watchdog still speaks first, and it speaks with evidence.
        //
        // So this branch does not need a third evidence signal (both blind
        // tracks agreed, and stderr substring sniffing is a trap this repo has
        // already been burned by — F12's note in ChatComposer). It needs to
        // STOP: one diagnostic frame, then the TTFT table closes for good via
        // markDegraded(), which also clears `hasFired` so the eventual stall
        // failure is reported in the stall's own words rather than claiming
        // "no first response within 32000ms" 195 seconds in (§0.5 finding 4).
        const sdkRetriesExhausted =
          lastRetryAttempt !== null &&
          lastRetryMaxRetries !== null &&
          lastRetryAttempt >= lastRetryMaxRetries;
        const deadSpawnConfirmed = !sawAnySdkEvent && ttftWindowsElapsed >= 2;
        if (!(sdkRetriesExhausted || deadSpawnConfirmed)) {
          // Branch C — evidence does not support blaming transport.
          // The one exception to "stop watching": total silence in the FIRST
          // window buys a second one (a cold-starting child, not a dead one).
          const secondWindowOwed = !sawAnySdkEvent;
          emitLivenessNote({
            source: 'ttft',
            budgetMs: ttftTimeoutMs,
            reason: 'insufficient_evidence',
            degraded: !secondWindowOwed,
          });
          if (secondWindowOwed) {
            ttftWatchdog.rearm();
          } else {
            ttftWatchdog.markDegraded();
          }
          return;
        }
        // Branch D — evidence landed.
        stalled = true;
        this.log(
          `TTFT watchdog: no first productive event within ${ttftTimeoutMs}ms on ${session.sessionId} — aborting turn`
        );
        abort.abort();
      },
    });
    const stallErrorMessage = () =>
      ttftWatchdog.hasFired
        ? `Host TTFT watchdog: no first response within ${ttftTimeoutMs}ms after send ` +
          '(no assistant/tool progress at all — likely a transport-layer retry ' +
          "loop (check the Host log's [cli-stderr] lines) or a spawn/auth " +
          'failure; tune via AICLIENT_HOST_TTFT_TIMEOUT_MS, 0 disables)'
        : `Host stall watchdog: no model progress for ${stallTimeoutMs}ms ` +
          '(model/gateway hang or endless retry — check model name and gateway ' +
          'health; tune via AICLIENT_HOST_STALL_TIMEOUT_MS, 0 disables)';
    const prompt = input.attachments?.length
      ? buildPromptWithAttachments(input.text, input.attachments)
      : input.text;

    // T-35: forward CLI stderr to the renderer (`session.stderr`), redacted
    // and clamped host-side (the Main bridge is a content-agnostic passthrough
    // — nothing downstream gets a second chance at a secret) and capped per
    // turn so a looping CLI cannot flood IPC. The raw line still goes to the
    // Host log in the callback below: the log stays the complete record, the
    // UI gets the sanitized excerpt.
    let stderrForwardedCount = 0;
    const forwardStderrLine = (line: string) => {
      if (stderrForwardedCount >= STDERR_FORWARD_MAX_LINES_PER_TURN) return;
      stderrForwardedCount += 1;
      const capped = stderrForwardedCount === STDERR_FORWARD_MAX_LINES_PER_TURN;
      this.opts.emit({
        type: 'session.stderr',
        sessionId: session.sessionId,
        requestId: input.requestId,
        payload: {
          line: capped
            ? `[cli-stderr capped at ${STDERR_FORWARD_MAX_LINES_PER_TURN} lines this turn — full output in the Host log]`
            : sanitizeStderrLine(line),
        },
      });
    };

    let stream: (AsyncIterable<unknown> & { close?: () => void }) | null = null;
    try {
      stream = queryFn({
        prompt,
        options: {
          cwd: session.workspacePath,
          pathToClaudeCodeExecutable: this.opts.cliPath,
          executable: executablePath,
          // Expose built-in Claude Code tools so Permission/Tool cards can fire.
          // Do NOT set bare allowedTools — that auto-approves and shadows canUseTool.
          tools: { type: 'preset', preset: 'claude_code' },
          // Isolate from filesystem permission.allow rules that would shadow canUseTool.
          // Credentials still come from options.env (loaded from settings.json).
          settingSources: [],
          // #8: adaptive thinking with visible summaries. `display:'summarized'`
          // is required — the default `omitted` streams empty thinking text.
          // See THINKING_CONFIG above for the probe evidence.
          thinking: THINKING_CONFIG,
          // Consumption point 1 of 3 — the one that actually reaches the SDK.
          // Same reader as the session.created/session.resumed payloads
          // (`sessionPermissionMode`), so the reported posture and the sent one
          // cannot drift (06-probes P2, direction 2).
          permissionMode,
          // Required by the SDK for `bypassPermissions` and forbidden for the
          // other four — absent, not `false`, in the safe positions.
          ...dangerousSkipPermissionsOption(permissionMode),
          canUseTool,
          env: mergedEnv,
          abortController: abort,
          // a2: the SDK only forwards the CLI child's stderr when `stderr` is
          // explicitly passed (or DEBUG_CLAUDE_AGENT_SDK is set) — otherwise
          // it is tail-buffered internally (2048 chars) and dropped. Without
          // this the CLI's own self-diagnosis (e.g. "No conversation found
          // with session ID: …") never reached Host logs. See investigation
          // report §1.4.
          stderr: (line: string) => {
            this.log('[cli-stderr]', line);
            forwardStderrLine(line);
          },
          // T-34: subagent tool_use/tool_result/prompt-echo already arrive in
          // default mode; this option adds the subagent's own text AND
          // thinking blocks (sdk.d.ts: "Forward subagent text and thinking
          // blocks … By default, only tool_use/tool_result blocks"). Absent
          // when the flag is off, so the quiet position also stops paying for
          // messages nothing will render.
          ...(subagentActivityEnabled ? { forwardSubagentText: true } : {}),
          // 1a: raw Anthropic stream events (`stream_event`) — see
          // resolveHostPartialMessagesEnabled. Absent (not `false`) in the
          // rollback position, matching the forwardSubagentText precedent
          // above: the off position stops PAYING for traffic nothing consumes.
          ...(partialMessagesEnabled ? { includePartialMessages: true } : {}),
          ...(model ? { model } : {}),
          // Top-level option (NOT output_config.effort) — SDK 0.3.218 sdk.d.ts
          // Options.effort, confirmed clean by c16 probe scenario D.
          ...(effort ? { effort } : {}),
          ...(session.runtimeIdentity ? { resume: session.runtimeIdentity } : {}),
        },
      });

      // Consumption point 4 (D48 S4 §6.3 / D7) — and the one that makes the
      // other three reportable AFTER the session was opened.
      //
      // `session.created` / `session.resumed` also carry this value, but they
      // fire exactly once per Host session: `decideSendPreamble` returns
      // `direct` for anything already host-bound, so within a single app run a
      // tier changed mid-conversation would never reach the surface again — the
      // Composer chip and the Context row would state the tier the session was
      // OPENED with, forever, while it ran under another one. Under-reporting
      // the posture in force is the one direction this control must not be wrong
      // in (§9.2), so the axis gets an echo of its own.
      //
      // Emitted HERE, after `queryFn` returned, because that is the moment the
      // tier stopped being a request: the SDK is holding these options for this
      // turn. Before the call it would be a prediction (`queryFn` can throw);
      // inside `updatePermission` it would be an ACK dressed as a fact, which is
      // what `session.permissionUpdated` already is and this deliberately is not.
      this.opts.emit({
        type: 'session.settingsEcho',
        sessionId: session.sessionId,
        requestId: input.requestId,
        payload: { permissionPolicy: claudePermissionPolicy(permissionMode) },
      });

      armStallTimer();
      ttftWatchdog.arm();
      // F10 (round-2 review fix): a bare `break` on the terminal `result`
      // event used to tear the SDK generator down immediately
      // (`return()`), which can race the CLI child's own end-of-turn
      // transcript flush — the exact write `--resume`/history reads depend
      // on. `session.running` now clears the INSTANT `result` lands (that
      // alone is the actual fix for the queue-release admission-window
      // race this used to chase via `break`) but the stream keeps draining
      // — up to DRAIN_AFTER_RESULT_MS — so the CLI gets a real chance to
      // finish on its own before teardown forces the issue. Manual
      // iteration (not `for await`) so the post-result phase can be capped
      // with a deadline; behavior before a `result` event is unchanged.
      const iterator = stream[Symbol.asyncIterator]();
      let drainDeadline: number | null = null;
      for (;;) {
        if (abort.signal.aborted) break;
        let step: IteratorResult<unknown>;
        if (drainDeadline !== null) {
          const remainingMs = drainDeadline - Date.now();
          if (remainingMs <= 0) break;
          const DRAIN_TIMEOUT = Symbol('ttft-drain-timeout');
          const raced = await Promise.race([
            iterator.next(),
            new Promise<typeof DRAIN_TIMEOUT>((resolve) =>
              setTimeout(() => resolve(DRAIN_TIMEOUT), remainingMs)
            ),
          ]);
          if (raced === DRAIN_TIMEOUT) break;
          step = raced as IteratorResult<unknown>;
        } else {
          step = await iterator.next();
        }
        if (step.done) break;
        const event = step.value;
        const eventType = String((event as { type?: string })?.type ?? '');
        sawAnySdkEvent = true;
        if (eventType === 'system' && (event as { subtype?: string })?.subtype === 'api_retry') {
          // F2 §2.5: keep the MOST RECENT frame's raw numbers. The evidence
          // gate wants "the SDK itself has given up", which only these two
          // fields can say; a frame that omits them says nothing, and saying
          // nothing must not decay into `0`.
          const rawRetry = event as { attempt?: unknown; max_retries?: unknown };
          lastRetryAttempt = readRawRetryField(rawRetry.attempt);
          lastRetryMaxRetries = readRawRetryField(rawRetry.max_retries);
        }
        if (PRODUCTIVE_EVENT_TYPES.has(eventType)) {
          armStallTimer();
          ttftWatchdog.markProductive();
        }
        const runtimeId = normalizer.ingest(event, input.requestId);
        if (runtimeId && runtimeId !== session.runtimeIdentity) {
          // First discovery (initial send) or a defensive fork cover — without
          // this event Main's session index never learns the resume identity.
          session.runtimeIdentity = runtimeId;
          this.opts.emit({
            type: 'session.updated',
            sessionId: session.sessionId,
            requestId: input.requestId,
            payload: { runtimeIdentity: runtimeId },
          });
        }
        if (eventType === 'result' && drainDeadline === null) {
          // Admission-window fix: unblock the NEXT queued send right away
          // instead of waiting for the stream to fully close below.
          session.running = false;
          drainDeadline = Date.now() + drainAfterResultMs;
        }
      }

      // F10: once `session.running` clears at `result`, a NEW send() for
      // this same session is free to start (that is the whole point) and
      // may finish taking over `session.abort` before THIS invocation's
      // drain loop above exits. `stillOwnsTurn` guards every remaining
      // mutation of shared session state so a slow drain can never stomp a
      // newer turn's status/pending prompts on its way out.
      const stillOwnsTurn = session.abort === abort;
      if (abort.signal.aborted) {
        const rejectReason = stalled ? 'Host stall watchdog fired' : 'Session stopped';
        if (stillOwnsTurn) {
          this.permissions.rejectSession(session.sessionId, rejectReason);
          this.questions.rejectSession(session.sessionId, rejectReason);
        }
        if (stalled) {
          normalizer.emitFailed(stallErrorMessage(), input.requestId);
          if (stillOwnsTurn) {
            session.status = 'failed';
            this.opts.registry.setStatus(session.sessionId, 'failed');
          }
        } else {
          normalizer.emitStopped(input.requestId);
          if (stillOwnsTurn) {
            session.status = 'idle';
            this.opts.registry.setStatus(session.sessionId, 'idle');
          }
        }
      } else if (
        stillOwnsTurn &&
        (session.status === 'running' ||
          session.status === 'waiting_permission' ||
          session.status === 'waiting_question')
      ) {
        // The SDK stream can end without a result event (gateway hang /
        // dropped stream). finishTurn emits synthetic terminals so the UI
        // leaves `running`; it is a no-op when a result already emitted them.
        const outcome = normalizer.finishTurn(input.requestId);
        if (outcome !== 'already') {
          this.permissions.rejectSession(session.sessionId, 'Stream ended');
          this.questions.rejectSession(session.sessionId, 'Stream ended');
          this.log(`stream ended without result event — synthetic terminal: ${outcome}`);
        }
        const status = outcome === 'failed' ? 'failed' : 'idle';
        session.status = status;
        this.opts.registry.setStatus(session.sessionId, status);
      }
    } catch (err) {
      const stillOwnsTurn = session.abort === abort;
      if (stillOwnsTurn) {
        this.permissions.rejectSession(session.sessionId, 'Query failed');
        this.questions.rejectSession(session.sessionId, 'Query failed');
      }
      if (abort.signal.aborted) {
        if (stalled) {
          // The SDK often surfaces our watchdog abort as a thrown AbortError —
          // keep the explicit failed terminal instead of a silent "stopped".
          normalizer.emitFailed(stallErrorMessage(), input.requestId);
          if (stillOwnsTurn) {
            session.status = 'failed';
            this.opts.registry.setStatus(session.sessionId, 'failed');
          }
        } else {
          normalizer.emitStopped(input.requestId);
          if (stillOwnsTurn) {
            session.status = 'idle';
            this.opts.registry.setStatus(session.sessionId, 'idle');
          }
        }
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.log('query failed:', message);
        // R5 (round-2 iteration-2 review): gate the WHOLE branch — including
        // the emits, not just the registry writes — behind `stillOwnsTurn`,
        // matching the post-loop `else if` path's own style. F10's
        // post-result drain window means this catch can run for a turn that
        // has already been superseded by a newer, admitted send() on the
        // same session (e.g. the CLI child rethrows its exit error AFTER a
        // `result` already cleared `session.running`); reporting that stale
        // failure against the session would falsely fail the NEW turn that
        // now owns it.
        if (stillOwnsTurn) {
          this.opts.emit({
            type: 'session.failed',
            sessionId: session.sessionId,
            requestId: input.requestId,
            payload: { error: message },
          });
          this.opts.emit({
            type: 'session.status',
            sessionId: session.sessionId,
            requestId: input.requestId,
            payload: { status: 'failed' },
          });
          session.status = 'failed';
          this.opts.registry.setStatus(session.sessionId, 'failed');
        } else {
          this.log(
            `post-result drain error for a turn that no longer owns session ${session.sessionId} — logged, not reported: ${message}`
          );
        }
      }
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      ttftWatchdog.dispose();
      // F10: only clear fields that still belong to THIS invocation — once
      // the post-result drain admits a new send() for the same session, that
      // new turn owns `running`/`abort` now, and this stale invocation must
      // not tear either down out from under it.
      if (session.abort === abort) {
        session.running = false;
        session.abort = undefined;
      }
      try {
        stream?.close?.();
      } catch {
        // ignore
      }
    }
  }

  respondPermission(input: {
    sessionId: string;
    permissionId: string;
    allow: boolean;
    requestId?: string;
  }): void {
    const ok = this.permissions.respond({
      sessionId: input.sessionId,
      permissionId: input.permissionId,
      allow: input.allow,
    });
    if (!ok) {
      this.opts.emit({
        type: 'host.error',
        sessionId: input.sessionId,
        requestId: input.requestId,
        payload: {
          code: 'permission_not_pending',
          message: `No pending permission: ${input.permissionId}`,
          fatal: false,
        },
      });
      // Round-2 P0 FIX 2 (permission flow hardening): PermissionBridge.respond
      // only emits permission.resolved on the path where it actually found
      // and settled a pending entry — a desynced id (renderer/Host queue
      // drifted apart, e.g. after a Host restart) leaves the store's
      // pendingPermissions head permanently parked with no way to dequeue.
      // Emitting the resolved event here too lets chatSessions.ts's own
      // `permission.resolved` handler dequeue and unlock the head even
      // though the Host never had this id parked.
      //
      // F7 (round-2 review fix): echo `input.allow` — the value the user
      // actually clicked — instead of hardcoding `false`. Nothing here was
      // actually granted on the Host side (there was no pending entry to
      // grant), but the renderer's card must reflect what the USER chose,
      // not a synthesized "Denied" the user never picked; hardcoding false
      // used to flip an approved card to Denied whenever this branch fired
      // for an `allow:true` response (e.g. a stale double-click/redelivery).
      this.opts.emit({
        type: 'permission.resolved',
        sessionId: input.sessionId,
        payload: { permissionId: input.permissionId, allow: input.allow },
      });
      // F8 (round-2 review fix): the compensating resolved event above only
      // dequeues the CARD — it does not converge `session.status`. Without
      // this, a session left on `waiting_permission` by the desync this
      // branch exists to recover from stays pinned there forever (no more
      // SDK events are coming for an id the Host never had parked), and the
      // renderer is stuck reading the session as permanently busy with no
      // card to show for it. Report the registry's actual current state
      // instead of guessing.
      this.opts.emit({
        type: 'session.status',
        sessionId: input.sessionId,
        requestId: input.requestId,
        payload: {
          // R14: read the live bridges too — a DIFFERENT permission/question
          // can still be genuinely parked on this same session even though
          // THIS id was not (see resolveCompensationStatus's doc comment).
          status: resolveCompensationStatus(this.opts.registry.get(input.sessionId), {
            permission: this.permissions.hasPending(input.sessionId),
            question: this.questions.hasPending(input.sessionId),
          }),
        },
      });
    }
  }

  respondQuestion(input: QuestionRespondInput & { requestId?: string }): void {
    const { requestId, ...respondInput } = input;
    const ok = this.questions.respond(respondInput);
    if (!ok) {
      this.opts.emit({
        type: 'host.error',
        sessionId: input.sessionId,
        requestId,
        payload: {
          code: 'question_not_pending',
          message: `No pending question: ${input.questionId}`,
          fatal: false,
        },
      });
    }
  }

  /**
   * D48 S4 §6.1 — change this session's permission tier mid-conversation.
   *
   * ## Why this is three lines of state and no protocol work at all
   *
   * Every send opens a NEW `query()` (`ensureSdk` caches the function, not a
   * session; the stream is built inside `send()` and closed in its `finally`,
   * and continuity across turns is `options.resume`) and `permissionMode` is a
   * `query()` option [实测 06-probes P2]. So the tier is re-read from the
   * session on every turn already — writing it here IS the channel. The
   * alternative the SDK offers, `Query.setPermissionMode()`, is documented
   * "Only available in streaming input mode" and our prompt is a plain string
   * for any turn without attachments, so it would fail on the common path.
   *
   * ## What it deliberately does NOT do
   *
   * It does not touch an in-flight turn. That `query()`'s options were fixed
   * when the stream was built, and rebuilding it would restart a turn the user
   * is watching in order to apply a setting that costs nothing to apply one turn
   * later — so the runtime REFUSES while a turn is running rather than
   * pretending, and the reply says `next_turn` rather than `immediately` (D2,
   * D8). Single-tool approvals keep flowing through `canUseTool` untouched:
   * approving one call and choosing a tier are different decisions and neither
   * implements the other.
   *
   * The Host-side idle check is not a duplicate of the UI's — the control being
   * disabled is a courtesy, this is the boundary.
   */
  updatePermission(input: {
    sessionId: string;
    /** Untrusted at this boundary; the arm is re-checked here as well as upstream. */
    permissionPreference?: unknown;
    requestId?: string;
  }): void {
    const session = this.opts.registry.get(input.sessionId);
    if (!session) {
      this.opts.emit({
        type: 'host.error',
        sessionId: input.sessionId,
        requestId: input.requestId,
        payload: {
          code: 'session_not_found',
          message: `Unknown session: ${input.sessionId}`,
          fatal: false,
        },
      });
      return;
    }
    const preference = claudePermissionPreference(input.permissionPreference, CLAUDE_CODE_AGENT);
    if (!preference) {
      // Refused, never degraded to the constant: `resolveClaudePermissionMode`
      // degrades because its callers are asking "what does this session run
      // under", and the safe answer to that is the constant. Here the caller is
      // asking to CHANGE the tier, and quietly changing it to something else is
      // how a user ends up believing they restricted a session they did not.
      this.opts.emit({
        type: 'host.error',
        sessionId: input.sessionId,
        requestId: input.requestId,
        payload: {
          code: 'invalid_payload',
          message:
            'session.updatePermission: this is not a Claude permission preference — a mid-session ' +
            'change is refused rather than degraded to the default tier',
          fatal: false,
        },
      });
      return;
    }
    if (session.running || session.abort) {
      // Same reading `stop()` uses: `abort` outlives `running` through the
      // post-result drain, and a tier written during that window would land on a
      // session the SDK is still streaming.
      this.opts.emit({
        type: 'host.error',
        sessionId: input.sessionId,
        requestId: input.requestId,
        payload: {
          code: 'session_busy',
          message:
            'session.updatePermission: a turn is running — the permission tier is fixed for the ' +
            'turn that is already in flight, and this request is refused rather than queued',
          fatal: false,
        },
      });
      return;
    }

    session.permissionPreference = preference;
    // The ACK, and only the ACK: no facts event is synthesized here. Those
    // carry what the Host HANDED the SDK, and nothing has been handed to it yet
    // — the next send is what makes this real, and it says so itself with a
    // `session.settingsEcho` built from the same `sessionPermissionMode` reader
    // (D1/D7). A fact emitted here would be this method confirming its own
    // request.
    this.opts.emit({
      type: 'session.permissionUpdated',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { preference, effective: 'next_turn' },
    });
  }

  stop(input: { sessionId: string; requestId?: string }): void {
    const session = this.opts.registry.get(input.sessionId);
    if (!session) {
      this.opts.emit({
        type: 'host.error',
        requestId: input.requestId,
        payload: {
          code: 'session_not_found',
          message: `Unknown session: ${input.sessionId}`,
          fatal: false,
        },
      });
      return;
    }
    this.permissions.rejectSession(session.sessionId, 'Session stopped');
    this.questions.rejectSession(session.sessionId, 'Session stopped');
    // R6 (round-2 iteration-2 review): `session.abort` alone — NOT
    // `session.running` — decides whether there is a live turn to abort.
    // F10's post-result drain clears `running` the INSTANT the terminal
    // `result` event lands, while `session.abort` (and the stream itself)
    // stays alive for up to `DRAIN_AFTER_RESULT_MS` more. The old
    // `!session.running || !session.abort` check treated that whole drain
    // window as "nothing running" and echoed back `session.status`, which
    // is still the stale `'running'` value (only corrected AFTER the drain
    // loop exits) — pinning the renderer busy with no way to recover short
    // of a second Stop click. Checking `session.abort` alone still early-
    // returns once a turn has FULLY ended (the `finally` clears `abort`),
    // and, during the drain, falls through to the abort() call below exactly
    // like an ordinary running turn — the generic post-loop/aborted-branch
    // handling already emits an honest `session.stopped` + `idle` for it.
    if (!session.abort) {
      this.opts.emit({
        type: 'session.status',
        sessionId: session.sessionId,
        requestId: input.requestId,
        payload: { status: session.status },
      });
      return;
    }
    session.status = 'stopping';
    this.opts.registry.setStatus(session.sessionId, 'stopping');
    this.opts.emit({
      type: 'session.status',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { status: 'stopping' },
    });
    session.abort.abort();
  }

  close(input: { sessionId: string; requestId?: string }): void {
    this.permissions.rejectSession(input.sessionId, 'Session closed');
    this.questions.rejectSession(input.sessionId, 'Session closed');
    const session = this.opts.registry.get(input.sessionId);
    if (session?.running && session.abort) {
      session.abort.abort();
    }
    this.opts.registry.delete(input.sessionId);
    this.opts.emit({
      type: 'session.status',
      sessionId: input.sessionId,
      requestId: input.requestId,
      payload: { status: 'disconnected' },
    });
  }

  /** Host shutdown — fail-closed on any hanging permission or question. */
  dispose(): void {
    this.permissions.rejectAll('Host shutting down');
    this.questions.rejectAll('Host shutting down');
  }
}
