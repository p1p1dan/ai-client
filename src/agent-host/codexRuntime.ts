import { isSessionEffortLevel, type SessionEffortLevel } from '../shared/types/agentHost.ts';
import { type AgentWireName, CODEX_AGENT } from '../shared/types/agentWire.ts';
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  PermissionAutoReason,
  PermissionDecisionId,
  PermissionDetail,
  PermissionRequestKind,
  SessionPermissionPolicy,
} from '../shared/types/runtimeEvents.ts';
import type {
  HistoryMessage,
  HistoryReadError,
  HistoryReadErrorCode,
} from '../shared/types/sessionHistory.ts';
import { CODEX_MANAGED_API_KEY_ENV, resolveCodexCredentialMode } from './agentSupport.ts';
import {
  CODEX_INITIALIZE_TIMEOUT_MS,
  type CodexConnectFactory,
  type CodexConnection,
  CodexConnectionClosedError,
  CodexRpcError,
  spawnCodexConnection,
} from './codexConnection.ts';
import { readOfferedDecisions, toWireDecision } from './codexDecisions.ts';
import { reprojectCodexHistory } from './codexHistoryReader.ts';
import { ensureCodexHome } from './codexHome.ts';
import {
  type CodexEntryResolution,
  type CodexLaunchPlan,
  resolveCodexLaunch,
} from './codexNodeEntry.ts';
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
import type { HostSession, SessionRegistry } from './sessionRegistry.ts';

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
 * ## Resume (slice 5b)
 *
 * `resumeSession()` is `createSession()` with `thread/resume` in place of
 * `thread/start`: same launch, same isolated home, same connection, and the link
 * it opens STAYS as the session's live link — resume is "continue this thread",
 * not "read it once". The transcript comes from the resume result itself
 * (`codexHistoryReader.ts`), because that result is the only place codex hands
 * a thread's items back: `thread/read` answers with `turns:[]` and
 * `thread/items/list` is -32601 on 0.145.0 [实测].
 *
 * Two rules shape the order below and neither is cosmetic:
 *  - state + registry are bound BEFORE the first byte goes out (H11). The resume
 *    window is not quiet — MCP startup notifications and a `thread/status/changed`
 *    arrive between the request and its answer [实测 fixture lines 5-8] — and a
 *    server request arriving with no state is dropped without a reply.
 *  - every failure goes through `teardown()` FIRST and only then emits the
 *    degradation contract (H10): the process must be gone before the renderer is
 *    told the session is idle, or a failed resume leaks an app-server per retry.
 *
 * ## What this slice still does NOT do, on purpose
 *
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
 *
 * ONE constant, TWO carriers (H9). `buildThreadStartParams` puts it on the wire
 * for a new thread; `ensureCodexHome` writes the same two fields into the
 * isolated `config.toml`, because a RESUMED thread re-derives its posture from
 * that file and never from the parameters the thread was created with [实测].
 * Both carriers read this object, so there is still exactly one source — and
 * `codexHome.ts` takes it as an argument rather than importing it, which is what
 * keeps the dependency edge one-way.
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
  /** D48 §4.6 — sticky model override; absent unless the user chose one. */
  model?: string;
  /** D48 §4.6 — sticky reasoning effort; absent unless the user chose one. */
  effort?: SessionEffortLevel;
}

/**
 * `turn/start` parameters.
 *
 * `threadId` + `input` are the two REQUIRED fields of `TurnStartParams`
 * [实测 `fixtures/codex/codex-turn-schema.json`, generated by the binary's own
 * `codex app-server generate-json-schema`], and they are exactly the two the
 * probe sent [读码 `spikes/s1-codex-direct-probe.ts:383-386`].
 *
 * ## D48: `model` and `effort` are now sent, and what changed to allow it
 *
 * Both used to be accepted by `send()` and dropped here. The two reasons for
 * dropping them were retired by measurement, not by preference:
 *
 *  - `effort` was called "a per-model vocabulary we have never read". The
 *    gateway's vocabulary is now measured: `low|medium|high|xhigh|max`, matching
 *    `SessionEffortLevel` word for word, and an out-of-range value is an EXPLICIT
 *    error rather than a silent downgrade [实测 调查 04 探测 E/G]. `thread/start`
 *    carries no effort field at all, so this is the only place a Codex session's
 *    effort can be expressed.
 *  - `model` was called redundant because `thread/start` already pinned one.
 *    That is still true and is no longer a reason: the product requirement is
 *    that changing the model mid-conversation works on BOTH axes, and the
 *    official codex CLI's own `/model` does exactly this against the same
 *    app-server.
 *
 * ## The sticky semantics are the whole design, and they were measured
 *
 * An override here applies "for this turn AND SUBSEQUENT TURNS" — the schema says
 * so for twelve fields, and P1 proved it end to end: a thread started on
 * `gpt-5.6-sol`, one `turn/start` carrying `gpt-5.5`, and the NEXT turn (carrying
 * no override at all) still ran `gpt-5.5` in the rollout's own `turn_context`
 * [实测 06-probes §P1]. So there is no "just this turn" to choose; sending a model
 * REDEFINES the thread default, and the runtime's job is to make that the single
 * truth (`onThreadSettingsUpdated` writes the echoed value back onto the registry
 * entry, so `thread/start`'s initial value is never read as current again).
 *
 * ## What is still deliberately NOT sent, and why the reason inverted
 *
 * `approvalPolicy` / `sandboxPolicy` / `cwd` are sticky here too — P1 proved that
 * as well, by overriding `sandboxPolicy` and watching it persist. THAT IS WHY
 * THEY ARE EXCLUDED: the permission posture gets its own zero-turn channel
 * (`thread/settings/update`, S4), and a second writer reachable from the turn
 * loop would let a posture change ride along with a message. This is a negative
 * control, not a "not yet".
 *
 * Both optional fields are OMITTED rather than sent as `undefined` when there is
 * no explicit choice: codex accepts unknown fields SILENTLY (no error, no effect)
 * [实测 06-probes P1 严格性观察], so a malformed or meaningless key is never
 * reported back — the parameter object has to be right by construction.
 */
export function buildTurnStartParams(input: {
  threadId: string;
  text: string;
  model?: string;
  effort?: SessionEffortLevel;
}): CodexTurnStartParams {
  const model = input.model?.trim();
  // `text_elements` is optional (`default: []`) and describes UI spans we do not
  // produce; an empty array would claim we parsed the text and found none.
  return {
    threadId: input.threadId,
    input: [{ type: 'text', text: input.text }],
    ...(model ? { model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  };
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

/**
 * How often the idle sweeper looks, and how long a session may sit still before
 * it is reclaimed (slice 6 #8). Both numbers are codeg's
 * [读码 `idle_sweep.rs:13-64`], because the thing being managed is the same:
 * one ~296MiB platform binary per open chat, held for a conversation nobody is
 * having any more.
 *
 * The cadence is NOT the resolution of the timeout — a session crosses the
 * threshold at T and is reclaimed at the next tick, so up to one interval late.
 * Making them equal would be a false precision: the point is bounding the leak,
 * not reclaiming at a particular second.
 */
export const CODEX_SWEEP_INTERVAL_MS = 60_000;
const CODEX_DEFAULT_IDLE_TIMEOUT_SECS = 180;
export const CODEX_IDLE_TIMEOUT_ENV = 'AICLIENT_CODEX_IDLE_TIMEOUT_SECS';

/**
 * The idle threshold in ms, or `null` for "never sweep".
 *
 * Shaped after `claudeRuntime.resolveStallTimeoutMs` (the repo's own precedent
 * for a host-side env timeout) with codeg's disable convention on top:
 *
 *  - unset or EMPTY -> the default. The empty case is checked before `Number`
 *    on purpose: `Number('')` is `0`, so an env var that exists but says
 *    nothing would otherwise turn the sweeper OFF — the opposite of "not
 *    configured", and silently.
 *  - unparseable -> the default. A typo must not disable a memory guard.
 *  - `<= 0` -> disabled, matching codeg's `0` and swallowing negatives the same
 *    way (its `u64` parse rejects them outright; here they arrive as numbers, so
 *    they are decided rather than crashed on). A negative threshold read
 *    literally would make every session instantly eligible.
 *  - anything else -> seconds, fractions included (a 1.5s threshold is what the
 *    tests run on).
 */
export function resolveCodexIdleTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const raw = env[CODEX_IDLE_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return CODEX_DEFAULT_IDLE_TIMEOUT_SECS * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return CODEX_DEFAULT_IDLE_TIMEOUT_SECS * 1000;
  if (parsed <= 0) return null;
  return parsed * 1000;
}

/**
 * The whole revive chain's budget — spawn, handshake and `thread/resume`
 * together.
 *
 * It exists because the component deadlines do not add up to anything usable:
 * `initialize` alone may take 15s and `thread/resume` rides the default 60s
 * request timeout, i.e. a worst case of 75s, while the renderer abandons a send
 * at 45s [读码 `attachmentLimits.ts`]. Without this the user would watch a send
 * fail generically and the Host would keep working on it for another half
 * minute. 20s leaves room for a cold start of the platform binary and still
 * reports back well inside the renderer's own budget.
 */
export const CODEX_REVIVE_DEADLINE_MS = 20_000;

/**
 * The error code a failed revive reports, and it must NEVER be
 * `session_not_found`.
 *
 * That code has a meaning at the other end: on a direct send the renderer takes
 * it as "the Host lost this row", closes the session and creates a NEW one,
 * overwriting the persisted `runtimeIdentity` [读码 `ChatComposer.tsx:1523`,
 * `chatSessions.ts`]. Reusing it here would turn "we could not reopen your
 * thread" into "your thread is gone and here is a different one", silently —
 * the H9-shaped fail-safe of a revive would become the loudest possible data
 * loss. A code nobody special-cases fails the send visibly and leaves the
 * binding alone, which is the whole point.
 */
export const CODEX_REVIVE_FAILED_CODE = 'session_revive_failed';

/**
 * Exactly what the sweeper is allowed to know about a session. A view rather
 * than the state itself, so the decision below can be asked every question in
 * isolation — several of these conditions cannot be produced independently
 * through the runtime's own API (a session with no thread id has never had a
 * turn either), and a rule that can only be tested in combination is a rule
 * whose individual clauses are never actually verified.
 */
export interface CodexIdleView {
  /** Our only "this session is connected" mark. */
  threadId?: string;
  rolloutBacked: boolean;
  hasTurn: boolean;
  pendingCount: number;
  torndown: boolean;
  reviving: boolean;
  lastActivityAt: number;
}

/**
 * May this session be reclaimed? Every clause is a separate `return false`
 * because every clause is a separate way to destroy work:
 *
 *  - no `threadId`: a session mid-handshake has a process and a state but
 *    nothing to resume, so killing it aborts a create/resume the user is
 *    waiting on.
 *  - not rollout-backed: `thread/resume` cannot reopen a thread with no rollout
 *    file [实测], so reclaiming a zero-turn session would DELETE it rather than
 *    park it (registered as L8 — those are held until close).
 *  - a live turn, or anything parked in the pending table: the model is working,
 *    or it is waiting on an answer the user can still give. Either way the
 *    session is in use however quiet the link happens to be.
 *  - torn down or reviving: the state is already leaving, or already coming
 *    back. Both are belt and braces TODAY — a torn-down state has left the
 *    session map and a reviving one has no thread id yet — and are kept because
 *    that redundancy is a property of the current call sites, not of the rule.
 *  - inside the threshold: the actual question, asked last because it is the
 *    only one about time rather than about work in progress.
 */
export function isCodexIdleSweepable(view: CodexIdleView, now: number, timeoutMs: number): boolean {
  if (view.threadId == null) return false;
  if (!view.rolloutBacked) return false;
  if (view.hasTurn) return false;
  if (view.pendingCount > 0) return false;
  if (view.torndown || view.reviving) return false;
  return now - view.lastActivityAt >= timeoutMs;
}

/**
 * The `history_unsupported` message every degraded resume carries (slice 5a).
 *
 * Static on purpose: the payload already names the thread (`runtimeIdentity`)
 * and the workspace, so repeating either here would hand the banner two copies
 * of one fact. It states what did NOT happen and what is still true — the
 * thread itself is untouched [实测: a new process resumed it]. It must not
 * promise that sending works, because on this path nothing has been connected.
 */
export const CODEX_HISTORY_UNSUPPORTED_MESSAGE =
  'This build has no Codex history reader, so no earlier messages were replayed. ' +
  'The thread itself is untouched.';

/** Exactly the `session.history` fields a resume decides; the rest are context. */
export interface CodexHistoryPayload {
  messages: HistoryMessage[];
  truncated: boolean;
  omittedCount: number;
  error?: HistoryReadError;
}

/**
 * Who and where the three events are about. Kept in one object so no two of them
 * can be emitted with different ids.
 */
interface ResumeTarget {
  sessionId: string;
  requestId?: string;
  runtimeIdentity: string;
  workspacePath: string;
}

/**
 * An empty transcript that SAYS WHY. Every failure path builds its payload here,
 * so "a resume that could not replay" cannot accidentally become "a session that
 * had nothing in it" — the misreading the whole degradation contract exists to
 * prevent.
 */
export function degradedHistory(code: HistoryReadErrorCode, message: string): CodexHistoryPayload {
  return { messages: [], truncated: false, omittedCount: 0, error: { code, message } };
}

/**
 * The `default` branch shape for an agent with NO history reader (spec §1 5b.3).
 *
 * Codex no longer reaches it — this runtime has a reader, so its resume either
 * replays or reports a real failure code — but the shape is kept, exported and
 * pinned, because it is the contract every future reader-less agent degrades to,
 * and re-deriving it later from memory is how the "silent empty transcript"
 * regression comes back.
 */
export const CODEX_HISTORY_UNSUPPORTED: CodexHistoryPayload = degradedHistory(
  'history_unsupported',
  CODEX_HISTORY_UNSUPPORTED_MESSAGE
);

/**
 * H9 layer 2 failed. A distinct class, so the failure classifier cannot mistake
 * it for a transport error.
 */
class CodexResumePostureError extends Error {
  constructor(detail: string) {
    super(
      'the resumed thread reported a different permission posture than this build ' +
        `enforces — ${detail}`
    );
    this.name = 'CodexResumePostureError';
  }
}

/**
 * "This thread is not there any more" vs "the read failed".
 *
 * Matched on the message rather than on a numeric code: the one MEASURED
 * missing-thread error is `-32600 no rollout found for thread id <uuid>`
 * (G8b probe, 2026-08-15: a zero-turn thread has no rollout file, so resume
 * fails exactly like a deleted one), and -32600 is generic INVALID_REQUEST —
 * not a dedicated code. `no rollout` pins the measured wording; the other
 * alternatives cover the plausible wording family. Guessing wrong degrades to
 * a "read failed" banner instead of "nothing on disk" — both honest.
 */
const THREAD_MISSING_PATTERN = /not found|no rollout|no such|unknown thread|does not exist/i;

function classifyResumeFailure(err: unknown): HistoryReadErrorCode {
  if (err instanceof CodexRpcError && err.code !== JSONRPC_METHOD_NOT_FOUND) {
    if (THREAD_MISSING_PATTERN.test(err.message)) return 'jsonl_not_found';
  }
  // Spawn, handshake, timeout, a disposed link, and the H9 posture refusal all
  // land here: the thread may well be fine, we just could not read it.
  return 'read_failed';
}

/**
 * `thread/turns/list` -> the same payload a resume produces.
 *
 * The reader takes a `thread/resume` result and refuses this shape on purpose,
 * so the turns are lifted into the minimal wrapper it does accept
 * (`{thread:{turns}}`) — the reader itself is not touched.
 *
 * CURSORS, and this is the deviation that shape refuses over [实测
 * `codex-s5-u2a-report.json`: `threadTurnsList.raw.backwardsCursor` is NON-null
 * on a complete one-turn history]: `backwardsCursor` is an anchor, not evidence
 * of missing history, so applying the resume rule ("any non-null cursor means
 * truncated") to it would mark EVERY live read as truncated. Only `nextCursor`
 * is read here.
 */
function readTurnsListHistory(result: unknown, threadId: string): CodexHistoryPayload {
  const root: Record<string, unknown> = isRecord(result) ? result : {};
  const turns = Array.isArray(root.data) ? root.data : [];
  const read = reprojectCodexHistory({ thread: { turns } }, { threadId });
  return {
    messages: read.messages,
    truncated: read.truncated || (root.nextCursor ?? null) !== null,
    omittedCount: read.omittedCount,
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
/**
 * Where a posture echo can live.
 *
 * The result itself AND a `thread` wrapper, because the two results that carry
 * one disagree: the recorded `thread/start` fragment lost its parent
 * (`fixtures/codex/codex-thread-start-echo.partial.json`), while a `thread/resume`
 * result carries the posture at the TOP level, beside a `thread` object that does
 * not repeat it [实测]. One pair of readers therefore serves both call sites —
 * two readers would be two chances to look in the wrong place, and looking in the
 * wrong place reads as "not echoed", which the resume path treats as a failure.
 */
function echoRoots(echo: unknown): Record<string, unknown>[] {
  if (!isRecord(echo)) return [];
  const roots: Record<string, unknown>[] = [echo];
  if (isRecord(echo.thread)) roots.push(echo.thread);
  return roots;
}

/** First echoed `approvalPolicy` string across the roots, or `undefined`. */
function readEchoApprovalPolicy(roots: readonly Record<string, unknown>[]): string | undefined {
  for (const root of roots) {
    if (typeof root.approvalPolicy === 'string') return root.approvalPolicy;
  }
  return undefined;
}

/** The raw `sandbox` member — a bare tier string on some results, an object on others. */
function readEchoSandbox(roots: readonly Record<string, unknown>[]): unknown {
  for (const root of roots) {
    if (root.sandbox !== undefined) return root.sandbox;
  }
  return undefined;
}

/** The sandbox TIER out of either spelling; `undefined` when neither is present. */
function readEchoSandboxType(sandbox: unknown): string | undefined {
  if (typeof sandbox === 'string') return sandbox;
  if (isRecord(sandbox) && typeof sandbox.type === 'string') return sandbox.type;
  return undefined;
}

export function compareSandboxEcho(
  sent: CodexSessionPermissionPolicy,
  echo: unknown
): { verdict: SandboxEchoVerdict; detail?: string } {
  const roots = echoRoots(echo);
  if (roots.length === 0) {
    return { verdict: 'unverifiable', detail: 'thread/start result is not an object' };
  }

  const compared: string[] = [];
  const missing: string[] = [];
  const mismatches: string[] = [];

  const approval = readEchoApprovalPolicy(roots);
  if (approval !== undefined) {
    compared.push('approvalPolicy');
    if (token(approval) !== token(sent.approvalPolicy)) {
      mismatches.push(`approvalPolicy sent=${sent.approvalPolicy} echo=${approval}`);
    }
  } else {
    missing.push('approvalPolicy');
  }

  const sandbox = readEchoSandbox(roots);
  const sandboxType = readEchoSandboxType(sandbox);
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

/**
 * Said in every failure detail, because a reader who sees two dimensions checked
 * will assume the third one failed silently. It did not — it was never sent.
 */
const NETWORK_DIMENSION_UNVERIFIED =
  'network dimension unverified: thread/resume never echoes networkAccess [实测], ' +
  'so that dimension is carried by the isolated config.toml alone';

export interface ResumePostureVerdict {
  ok: boolean;
  /** Always populated: what was compared, or what failed and why. */
  detail: string;
}

/**
 * The RESUME arm of H9, and deliberately NOT `compareSandboxEcho`'s semantics.
 *
 * Both dimensions must be echoed AND match; missing is a failure, not an
 * "unverifiable" shrug. The asymmetry with the create path is the whole point
 * (H9): on create WE state the posture in `thread/start`, so the echo is a
 * cross-check of something we already control, and hard constraint 7 forbids
 * failing a turn over a verification step. On resume the posture's only source is
 * the isolated `config.toml`, so the echo is the ONLY evidence that the thread
 * came back under the posture this build promises — and a resume that silently
 * runs `dangerFullAccess` because the config write regressed is precisely the
 * failure a fail-safe check exists for. It runs before any transcript is emitted,
 * so nothing has been shown to the user when it refuses.
 *
 * `networkAccess` is NOT required: that key is absent from every recorded resume
 * result [实测], so requiring it would fail every resume forever.
 */
export function verifyResumePosture(
  sent: CodexSessionPermissionPolicy,
  echo: unknown
): ResumePostureVerdict {
  const roots = echoRoots(echo);
  const approval = readEchoApprovalPolicy(roots);
  const sandboxType = readEchoSandboxType(readEchoSandbox(roots));

  const problems: string[] = [];
  if (approval === undefined) problems.push('approvalPolicy was not echoed at all');
  else if (token(approval) !== token(sent.approvalPolicy)) {
    problems.push(`approvalPolicy expected=${sent.approvalPolicy} echo=${approval}`);
  }
  if (sandboxType === undefined) problems.push('sandbox.type was not echoed at all');
  else if (token(sandboxType) !== token(sent.sandboxMode)) {
    problems.push(`sandbox expected=${sent.sandboxMode} echo=${sandboxType}`);
  }

  if (problems.length > 0) {
    return { ok: false, detail: `${problems.join('; ')} — ${NETWORK_DIMENSION_UNVERIFIED}` };
  }
  return { ok: true, detail: `approvalPolicy=${String(approval)}, sandbox=${String(sandboxType)}` };
}

/**
 * H9 layer 2 as a STATEMENT: every path that reopens a thread refuses one whose
 * posture it cannot confirm, and the refusal is a throw so no caller can decide
 * to carry on with the verdict.
 *
 * Shared by the cold resume and the idle-revive because the check is the same
 * check — the thread is coming back under a posture whose only source is the
 * isolated `config.toml`, and a second inline copy is how one of the two ends up
 * logging a verdict it never acted on.
 *
 * Returns the detail for the caller's log line.
 */
function assertResumePosture(policy: CodexSessionPermissionPolicy, result: unknown): string {
  const posture = verifyResumePosture(policy, result);
  if (!posture.ok) throw new CodexResumePostureError(posture.detail);
  return posture.detail;
}

/**
 * The slice of a Node timer the Host uses. `unref` is not optional here even
 * though `NodeJS.Timeout.unref` is always present: it is the difference between
 * a Host that exits when Main closes it and one an interval pins open, so it is
 * a named part of the contract a test seam has to honour rather than a call
 * hidden inside the real implementation.
 */
export interface CodexTimerHandle {
  unref(): void;
  stop(): void;
}

export type CodexStartTimer = (fire: () => void, ms: number) => CodexTimerHandle;

const startRealInterval: CodexStartTimer = (fire, ms) => {
  const timer = setInterval(fire, ms);
  return {
    unref: () => {
      timer.unref?.();
    },
    stop: () => clearInterval(timer),
  };
};

const startRealTimeout: CodexStartTimer = (fire, ms) => {
  const timer = setTimeout(fire, ms);
  return {
    unref: () => {
      timer.unref?.();
    },
    stop: () => clearTimeout(timer),
  };
};

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
  /**
   * Test seam — the clock the idle sweeper reads. Every timestamp it compares
   * comes from here, so a fake clock moves "how long ago" without moving real
   * time (a 180s default is not something a unit test can wait out).
   */
  now?: () => number;
  /** Test seam — where the idle threshold is read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam — the sweeper's interval. */
  startInterval?: CodexStartTimer;
  /** Test seam — the revive chain's whole-chain deadline. */
  startTimeout?: CodexStartTimer;
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
  /**
   * m13 — the resume window holds the status mapper shut.
   *
   * `thread/resume` makes codex push a `thread/status/changed` of its own before
   * it answers [实测 fixture line 8], and projecting it would put a
   * `session.status` in front of `session.resumed`: the renderer takes the
   * closing status of a resume as the signal that the replay is complete, so an
   * early one ends the resume before its own history arrives. Cleared once the
   * three-event contract is out; never set on the create path, whose first
   * status is a legitimate reading of a thread we just started.
   *
   * The idle-revive sets it too and has to CLEAR IT ITSELF: that path emits no
   * contract at all, so `emitHistoryClose` — the one place it is released — never
   * runs. A revive that forgot would leave the session permanently unable to
   * project a status, i.e. silently frozen at whatever the renderer last saw.
   */
  statusGated: boolean;
  /**
   * When this session last moved a frame in either direction — the idle
   * sweeper's only input (slice 6 #8). Written by the connection's own activity
   * hook, so a reply the pending table wrote straight into the link counts too.
   *
   * Seeded at construction rather than at `0`: a session whose handshake is
   * still in flight has moved no frames through a runtime that is holding its
   * state, and a zero here would make it instantly older than any threshold.
   */
  lastActivityAt: number;
  /**
   * Is there a rollout file on disk for this thread — i.e. can it be resumed at
   * all?
   *
   * A zero-turn thread has NONE, and `thread/resume` answers
   * `-32600 no rollout found for thread id <uuid>` [实测 G8b probe]. Reclaiming
   * such a session would therefore not be a reclaim but a deletion: nothing
   * could ever reopen it. Set when a resume proved the file exists, or when a
   * turn completed on this link (a completed turn is a written turn).
   */
  rolloutBacked: boolean;
  /**
   * A revive is in flight on this state (slice 6 #8).
   *
   * It is both an admission gate and a sweep exemption. As a gate it is the only
   * thing that can stop `resumeSession`'s guard ③, whose `connection.alive` is
   * true from the moment the link is constructed — a sidebar resume landing
   * mid-revive would otherwise be answered by `thread/turns/list` on a
   * connection that has not finished `initialize`, let alone resumed the thread.
   */
  reviving: boolean;
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
 * D47 S4a (§2 S4a) — mirrored from `scripts/credential-env-keys.mjs`'s
 * `CREDENTIAL_ENV_PREFIX`, NOT imported from it (A 轨 M7 fallback plan): that
 * file lives in a separate npm package with its own `tsconfig.json`
 * (`src/agent-host/tsconfig.json`'s `include: ["**\/*.ts"]` does not reach
 * outside this directory, and the `.mjs` + hand-written `.d.mts` sibling it
 * ships for its OTHER two consumers does not resolve under
 * `typecheck:agent-host` either). This is a deliberate, DOCUMENTED duplicate
 * of one string, not a second design decision — the drift-prevention
 * assertion lives on the Main/shared side of this contract, which owns both
 * `scripts/` and the cross-source pin.
 */
const MANAGED_ENV_STRIP_PREFIX = 'ANTHROPIC_';

/**
 * Strip every `ANTHROPIC_`-prefixed var from a managed-mode spawn env.
 *
 * A whole-PREFIX strip, not an enumerated key list: `ANTHROPIC_FUTURE_SENTINEL`
 * (a name with no meaning today — `codexRuntime.test.ts`'s sentinel case) must
 * be stripped exactly like `ANTHROPIC_API_KEY`, because an implementation that
 * enumerates today's known keys is a false green against tomorrow's new one
 * (B 轨 M1-4).
 *
 * Scoped to the `ANTHROPIC_` prefix ONLY — not the exact-match half of
 * `credential-env-keys.mjs`'s list (`CLAUDE_CONFIG_DIR` etc.): those are
 * Claude-runtime-shaped keys with no codex meaning, and a managed codex
 * child's ONE credential is already named explicitly
 * (`AICLIENT_CODEX_API_KEY`, `config.toml`'s `env_key` indirection — E4).
 */
function stripCredentialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(MANAGED_ENV_STRIP_PREFIX)) continue;
    stripped[key] = value;
  }
  return stripped;
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

/**
 * The two card kinds an approval can become. Derived from the protocol union
 * rather than respelled, so a rename there fails here instead of drifting.
 */
type ApprovalCardKind = Extract<PermissionRequestKind, 'exec' | 'file_change'>;

/**
 * The approval kinds this build can put on screen, and the card kind each one
 * becomes.
 *
 * This map is the P2 guard as well as the projection table, deliberately: a
 * kind that is not in here is refused at the door (`unsupported`) instead of
 * being parked, and the SAME lookup decides whether a settle is projected back
 * as `permission.resolved`. One table means "we raised a card" and "we resolve
 * that card" can never disagree — the disagreement being a card that no drain
 * can ever take off screen.
 *
 * `approval_permissions` and `elicitation` are absent on purpose (spec §2.5):
 * parking them costs a hung turn (codex sits on `waitingOnApproval` with
 * nothing on screen until Stop), and both are rare — `item/permissions/
 * requestApproval` is unreachable on this build [实测 S2-a] and elicitation
 * needs an MCP server. A rare refusal beats a rare hang.
 */
const APPROVAL_CARD_KINDS = new Map<PendingKind, ApprovalCardKind>([
  ['approval_exec', 'exec'],
  ['approval_file_change', 'file_change'],
]);

/** Card header per approval kind. Not the wire method: this is what the user reads. */
const APPROVAL_TOOL_NAME: Readonly<Record<ApprovalCardKind, string>> = {
  exec: 'Run command',
  file_change: 'Apply patch',
};

/** A non-empty string field, or `undefined` — `null` is a declared value here, not an error. */
function readText(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * `additionalPermissions` -> a count and a boolean, never an expansion.
 *
 * `AdditionalPermissionProfile` is a recursive shape with ZERO captured
 * samples, and the generated snapshot keeps `AdditionalFileSystemPermissions`
 * as a bare `$ref` — so listing individual entries would be inventing a shape.
 * "There are extras, this many file-system ones, network or not" is enough for
 * the user to see this is not an ordinary exec, and every part of it is
 * readable without knowing the sub-shape: any array under `fileSystem` is a
 * list of file-system permissions whatever its key is called.
 */
function readExtraPermissions(
  value: unknown
): { fileSystemEntries: number; networkRequested: boolean } | undefined {
  if (!isRecord(value)) return undefined;
  // An object of nothing but nulls is codex saying "no extras", not "extras".
  if (!Object.values(value).some((entry) => entry !== null && entry !== undefined)) {
    return undefined;
  }
  let fileSystemEntries = 0;
  const fileSystem = isRecord(value.fileSystem) ? value.fileSystem : undefined;
  if (fileSystem) {
    for (const entry of Object.values(fileSystem)) {
      if (Array.isArray(entry)) fileSystemEntries += entry.length;
    }
  }
  const network = isRecord(value.network) ? value.network : undefined;
  return { fileSystemEntries, networkRequested: network?.enabled === true };
}

/**
 * The card body for a command approval.
 *
 * ALWAYS returns a detail, even an almost empty one. `command` is typed
 * `["string","null"]` by the contract — a command-less approval is a declared
 * shape (zsh-exec-bridge subcommands), not a malformed frame — so a body that
 * exists only when there is a command would render an empty box for exactly the
 * requests that need explaining most: a managed-network exit, or a command
 * asking for permissions on top of the session's posture.
 */
function buildExecDetail(params: unknown): PermissionDetail {
  const source = isRecord(params) ? params : undefined;
  const detail: Extract<PermissionDetail, { kind: 'exec' }> = { kind: 'exec' };
  const command = readText(source, 'command');
  if (command) detail.command = command;
  const cwd = readText(source, 'cwd');
  if (cwd) detail.cwd = cwd;
  const context = isRecord(source?.networkApprovalContext)
    ? source.networkApprovalContext
    : undefined;
  const host = readText(context, 'host');
  const protocol = readText(context, 'protocol');
  // Both or neither: half a context renders `undefined://host`.
  if (host && protocol) detail.network = { host, protocol };
  const extras = readExtraPermissions(source?.additionalPermissions);
  if (extras) detail.extraPermissions = extras;
  return detail;
}

/**
 * The card body for a patch approval: the diff cached by the normalizer plus
 * whatever the request itself adds.
 *
 * A missing `cached` is a degraded card, never a delayed one (hard constraint
 * 7): the patch rides an `item/started` that lands ~1ms earlier [实测], and
 * waiting for one that is not coming would hang the turn instead of showing an
 * imperfect card.
 *
 * `grantRoot` has to be here even when the patch is not. Allowing the patch
 * ALSO allows writes under that root for the rest of the session [契约], so a
 * card that drops it turns one Allow into a directory grant nobody was shown.
 */
function buildFileChangeDetail(
  cached: PermissionDetail | undefined,
  params: unknown
): PermissionDetail {
  const source = isRecord(params) ? params : undefined;
  const base = cached?.kind === 'file_change' ? cached : undefined;
  const grantRoot = readText(source, 'grantRoot');
  return {
    kind: 'file_change',
    // Copied out rather than passed through: the cached object is also the
    // source of the tool row's input, and one shared object is one mutation
    // away from two wrong renderings.
    changes: base ? [...base.changes] : [],
    ...(base?.omittedFileCount !== undefined ? { omittedFileCount: base.omittedFileCount } : {}),
    ...(grantRoot ? { grantRoot } : {}),
  };
}

/**
 * Why a pending entry left the table, in the protocol's vocabulary.
 *
 * `'forgotten'` (the server settled its own request) has no protocol word and
 * C10 forbids widening the enum for a Host-internal concept, so it degrades to
 * the nearest true one: the request was abandoned. The alternative — omitting
 * `autoReason` — would state that a human decided, which is the one thing this
 * field exists to stop the timeline from claiming. The real reason goes to the
 * log (spec L4).
 */
function toAutoReason(reason: Exclude<PendingSettleReason, 'answered'>): PermissionAutoReason {
  return reason === 'forgotten' ? 'aborted' : reason;
}

export class CodexRuntime {
  private readonly opts: CodexRuntimeOptions;
  private readonly log: LogFn;
  private readonly sessions = new Map<string, CodexSessionState>();
  private readonly now: () => number;
  private readonly startInterval: CodexStartTimer;
  private readonly startTimeout: CodexStartTimer;
  /** `null` = the sweeper is disabled for this process; see `resolveCodexIdleTimeoutMs`. */
  private readonly idleTimeoutMs: number | null;
  private sweeper: CodexTimerHandle | null = null;
  /**
   * Sessions THIS runtime reclaimed while they were idle, and the ONLY sessions
   * a send may quietly revive.
   *
   * The list is what keeps the revive path from becoming a general "reopen
   * anything" retry. A session whose state is missing for any other reason — a
   * crashed app-server, a cold resume that failed — is a session we have already
   * told the renderer about, and re-opening it behind the user's back would
   * replace an audible failure with a silent one. Those keep the existing
   * `session_not_found`, and `codexRuntime.test.ts` pins that they do.
   */
  private readonly sweptSessions = new Set<string>();

  constructor(opts: CodexRuntimeOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((...args) => console.error('[codex-runtime]', ...args));
    this.now = opts.now ?? (() => Date.now());
    this.startInterval = opts.startInterval ?? startRealInterval;
    this.startTimeout = opts.startTimeout ?? startRealTimeout;
    // Read ONCE. The alternative (per tick) would let the threshold change under
    // a session that is already being timed, and the host agent registry's
    // freeze rule holds here too: a process decides what it is doing at startup
    // and does not drift.
    this.idleTimeoutMs = resolveCodexIdleTimeoutMs(opts.env ?? process.env);
  }

  /**
   * Start the idle sweeper if it is not already running.
   *
   * Called from EVERY point that puts a session into the map — create, cold
   * resume and revive — and the plural matters: hanging it off `createSession`
   * alone leaves a process that only ever reopened history (app restarted, user
   * clicked an old session) with an app-server per session and nothing watching
   * them. Idempotent, so the call sites do not have to know about each other.
   */
  private ensureSweeper(): void {
    if (this.sweeper || this.idleTimeoutMs === null) return;
    this.sweeper = this.startInterval(() => this.sweepIdleSessions(), CODEX_SWEEP_INTERVAL_MS);
    // An interval that exists to free resources must never be the reason the
    // process itself cannot go away.
    this.sweeper.unref();
    this.log('codex idle sweeper started', {
      intervalMs: CODEX_SWEEP_INTERVAL_MS,
      idleTimeoutMs: this.idleTimeoutMs,
    });
  }

  /**
   * Nothing left to watch. Paired with `ensureSweeper` at every insertion point:
   * stopping without that pairing would leave a revived session unwatched
   * forever (a revive necessarily follows a sweep that emptied the map).
   */
  private stopSweeperIfIdle(): void {
    if (!this.sweeper || this.sessions.size > 0) return;
    this.sweeper.stop();
    this.sweeper = null;
  }

  /**
   * One pass over the live sessions. Nothing here emits: a reclaimed session is
   * a session the user can still open and keep talking to, so telling the
   * renderer about it would be reporting a failure that did not happen.
   */
  private sweepIdleSessions(): void {
    const timeoutMs = this.idleTimeoutMs;
    if (timeoutMs === null) return;
    const now = this.now();
    // Snapshot: reclaiming mutates the map we are walking.
    for (const state of [...this.sessions.values()]) {
      if (!this.isIdleSweepable(state, now, timeoutMs)) continue;
      this.reclaimIdleSession(state, now);
    }
    this.stopSweeperIfIdle();
  }

  /**
   * The live state read as the sweeper's view (see `isCodexIdleSweepable` for
   * the rule itself). Nothing is decided here — this is only the mapping, and it
   * is kept trivial because it is the one part the pure test cannot see: the
   * runtime-level sweep cases exercise every field below through the real API.
   */
  private isIdleSweepable(state: CodexSessionState, now: number, timeoutMs: number): boolean {
    return isCodexIdleSweepable(
      {
        threadId: state.threadId,
        rolloutBacked: state.rolloutBacked,
        hasTurn: state.turn !== null,
        pendingCount: state.pending.sizeFor(state.sessionId),
        torndown: state.torndown,
        reviving: state.reviving,
        lastActivityAt: state.lastActivityAt,
      },
      now,
      timeoutMs
    );
  }

  /**
   * Reclaim one idle session: kill the process, keep the binding.
   *
   * The `setStatus` is NOT redundant with the exit path, and this is the trap
   * the whole slice was reviewed for: `teardown` sets `torndown` first, and
   * `onExit` returns immediately on a torn-down state — so the `disconnected`
   * that a crash would write NEVER runs for a kill we asked for. Without the
   * line below the registry would keep reporting the last live status of a
   * session whose process is gone.
   *
   * `registry.delete` would be the obvious counterpart and is exactly wrong: the
   * row IS the resume handle. Deleting it turns the next send into
   * `session_not_found`, and the renderer answers that by making a brand-new
   * thread — the silent session swap this design exists to avoid.
   */
  private reclaimIdleSession(state: CodexSessionState, now: number): void {
    const { sessionId } = state;
    const idleMs = now - state.lastActivityAt;
    const pid = state.connection.pid;
    this.teardown(state, 'aborted', 'idle sweep');
    this.opts.registry.setStatus(sessionId, 'disconnected');
    this.sweptSessions.add(sessionId);
    this.log('codex idle session reclaimed', {
      sessionId,
      threadId: state.threadId,
      pid,
      idleMs,
      swept: this.sweptSessions.size,
    });
  }

  /**
   * The session moved a frame. Called by the connection layer for BOTH
   * directions — see `CodexConnectionHandlers.onActivity` for why it cannot be
   * done at this layer alone.
   *
   * Looks the state up rather than closing over it because the handlers are
   * wired before the state exists; frames that predate it (the very first
   * `initialize` write) simply find nothing, which is correct — the state's
   * `lastActivityAt` is seeded at construction.
   */
  private touchActivity(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) state.lastActivityAt = this.now();
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
    /**
     * D48 §4.6 — the session default, recorded on the registry entry and put on
     * every `turn/start` that does not override it. `thread/start` carries no
     * effort field at all [实测 codex schema], so the turn is its only carrier.
     */
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

    const opened = this.openConnection({ sessionId, workspacePath, why: 'session.create' });
    if (!opened.ok) {
      // One stage, one code: a missing codex.js is `agent_unsupported` (nothing
      // is wrong with the request, this machine simply has no codex), the other
      // two are `session_create_failed`.
      this.fail(
        opened.stage === 'entry' ? 'agent_unsupported' : 'session_create_failed',
        `session.create: ${opened.message}`,
        { sessionId, requestId }
      );
      return;
    }

    const state = opened.state;
    this.sessions.set(sessionId, state);
    this.ensureSweeper();

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
      effort: isSessionEffortLevel(input.effort) ? input.effort : undefined,
    });
    this.log('codex session starting', {
      sessionId,
      pid: state.connection.pid,
      source: opened.plan.source,
      codexJsPath: opened.plan.codexJsPath,
      homeDir: opened.homeDir,
    });

    void this.startThread(state, input);
  }

  /**
   * Resolve the entry point, materialise the isolated home, spawn one link and
   * build the session state around it — everything `createSession` and
   * `resumeSession` must do IDENTICALLY (spec B3: resume is create with a
   * different second request).
   *
   * It deliberately does NOT register anything: `this.sessions` and the registry
   * are written by the caller, because create and resume bind them differently
   * (`registry.create` vs `registry.resume`) and the ORDER of those two writes
   * against the first I/O is a hard constraint on the resume side alone (H11).
   *
   * Failures come back as a stage + a message instead of an emitted error: the
   * same spawn failure is a `host.error` on the create path and a
   * `session.history{read_failed}` on the resume path (H10), and a helper that
   * emitted would force one of them to be wrong.
   */
  private openConnection(input: {
    sessionId: string;
    workspacePath: string;
    why: string;
  }):
    | { ok: true; state: CodexSessionState; homeDir: string; plan: CodexLaunchPlan }
    | { ok: false; stage: 'entry' | 'home' | 'spawn'; message: string } {
    const { sessionId, workspacePath } = input;
    const resolution = (this.opts.resolveLaunch ?? resolveCodexLaunch)();
    if (!resolution.ok) {
      // The inspected paths describe the USER'S machine layout, so they go to
      // the Host log and never into an event that reaches the UI.
      this.log('codex entry unresolved', {
        sessionId,
        why: input.why,
        inspected: resolution.inspected,
      });
      return { ok: false, stage: 'entry', message: resolution.message };
    }

    let homeDir: string;
    try {
      const home = (this.opts.ensureHome ?? ensureCodexHome)({
        homeDir: this.opts.codexHomeDir,
        // H9 layer 1: the SAME object `buildThreadStartParams` sends. A resumed
        // thread re-derives its posture from this file, so the constant has to
        // reach the disk as well as the wire.
        permission: CODEX_PERMISSION_DEFAULT,
        // D47 S4a: the SAME env object the spawn-env build below reads (one of
        // `resolveCodexCredentialMode`'s four readers, §1) — so a mode decided
        // for the home cannot disagree with the mode decided for the env a few
        // lines later in this same call.
        env: this.opts.env,
        log: (...args: unknown[]) => this.log('[codex-home]', ...args),
      });
      homeDir = home.homeDir;
    } catch (err) {
      return {
        ok: false,
        stage: 'home',
        message: `could not prepare the isolated CODEX_HOME: ${errorMessage(err)}`,
      };
    }

    // The other half of the isolation. `codexHome.ts` wrote a deny-by-default
    // projection into `homeDir`; this is what makes codex READ that directory
    // instead of `~/.codex`. Without it every drop in the projection is undone
    // and the session silently inherits `developer_instructions` and
    // `danger-full-access`.
    //
    // FALLBACK: the rest of the environment is inherited whole, deliberately,
    // and this branch is UNCHANGED by D47 S4a (spec: "fallback 全继承现状").
    // NOTE for whoever revisits this: once a Claude session has run,
    // `ensureRuntime()` has copied `~/.claude/settings.json`'s env (including
    // `ANTHROPIC_AUTH_TOKEN`) onto this process, so those variables reach the
    // codex child too. Filtering them looks tempting and is NOT done here,
    // because a user whose codex `model_providers.<id>.env_key` names one of
    // them would lose authentication with a confusing error — the projection
    // keeps `env_key`, so that configuration is reachable. Registered as an open
    // question rather than settled by guess.
    //
    // MANAGED (D47 S4a, §2 S4a): the credential landscape is the opposite —
    // Main already told us exactly which one key codex needs
    // (`AICLIENT_CODEX_API_KEY`, injected onto AND read off this SAME opts.env
    // / process.env by `resolveCodexCredentialMode`) — so inherited credential
    // shaped vars are a LIABILITY here, not a reachability feature: an
    // `ANTHROPIC_*` var surviving onto a managed codex child could shadow the
    // one credential `config.toml`'s `env_key` indirection actually names.
    const credentialMode = resolveCodexCredentialMode(this.opts.env ?? process.env);
    const env: NodeJS.ProcessEnv =
      credentialMode.mode === 'fallback'
        ? { ...process.env, CODEX_HOME: homeDir }
        : {
            ...stripCredentialEnv(this.opts.env ?? process.env),
            CODEX_HOME: homeDir,
            ...(credentialMode.mode === 'managed'
              ? { [CODEX_MANAGED_API_KEY_ENV]: credentialMode.apiKey }
              : {}),
          };

    const connect = this.opts.connect ?? spawnCodexConnection;
    // The exit handler has to name the state this connection belongs to, and the
    // state cannot exist before the connection it holds — hence the holder,
    // filled in below. Routing that handler on the sessionId instead (as every
    // other handler safely does, because a disposed link routes nothing) would
    // let a process that is still dying tear down the session's NEXT
    // connection: `dispose()` returns before the child does, and the revive path
    // reopens the same sessionId immediately.
    const owner: { state?: CodexSessionState } = {};
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
          onExit: (info) => {
            if (owner.state) this.onExit(owner.state, info);
          },
          onActivity: () => this.touchActivity(sessionId),
        },
      });
    } catch (err) {
      return { ok: false, stage: 'spawn', message: errorMessage(err) };
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
        this.projectSettled(entry, reason);
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
      statusGated: false,
      lastActivityAt: this.now(),
      // Not known yet on either path: a created thread has no turn on disk, and
      // a resumed one has not been answered. Both are set where they are proved.
      rolloutBacked: false,
      reviving: false,
    };
    owner.state = state;

    return { ok: true, homeDir, plan: resolution.plan, state };
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

    // D48 §4.6 defence ② — also ABOVE the `if (!turn)` drop, and for a stricter
    // reason than the frame above: a settings change is legal while the thread is
    // idle (`thread/settings/update` is zero-turn [实测 06-probes §P3]), so the
    // frame that carries the new model routinely arrives with no turn open at
    // all. Read below the drop, the write-back would work only for changes made
    // inside a turn — i.e. exactly the half that does not need it.
    if (n.method === CODEX_METHOD.threadSettingsUpdated) {
      this.onThreadSettingsUpdated(state, n.params);
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
      // A completed turn is a turn on disk, and a thread with a turn on disk has
      // a rollout file — which is the only thing that makes it resumable, and
      // therefore the only thing that makes it safe to reclaim when idle. Set
      // AFTER the ownership check: another thread's completion proves nothing
      // about ours.
      state.rolloutBacked = true;
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
    if (state.statusGated) {
      // m13. Dropped whole, registry write included: the registry still reads
      // `idle` from `registry.resume`, which is exactly what the contract's own
      // closing `session.status` reports, so suppressing both keeps the two in
      // agreement. Codex re-sends this frame on every real state change, so
      // nothing is lost — and no turn can be running inside this window (`send`
      // refuses a session whose thread id is not known yet).
      this.log('codex status suppressed inside the resume window', {
        sessionId: state.sessionId,
      });
      return;
    }
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
   * D48 §4.6 defence ② — the ONE writer of a Codex session's model/effort
   * default after `thread/start`.
   *
   * ## Why the echo, and never the request
   *
   * Sending `model` on `turn/start` redefines the thread default, so the value
   * `thread/start` was given stops being current the moment a user changes it.
   * Two truths for one fact is the defect A-track raised against sending model at
   * all; this method is the answer to it — the registry entry converges on
   * whatever codex says the thread settings ARE, so nothing downstream (an idle
   * revive, a later turn that omits the field) can read the stale initial value.
   *
   * The value written is the one in THIS FRAME, never the one we asked for. That
   * distinction is measurable rather than theoretical: `turn/start`'s response
   * carries no model, `turn/started` and `turn/completed` carry none either, and
   * `thread/read`'s `Thread` has no settings at all — `thread/settings/updated`
   * is the only echo there is [实测 06-probes §0.4]. And what comes back is not
   * guaranteed to be what went out (a provider-side fallback can substitute
   * one), so "write what we sent" would record a model the thread is not running.
   *
   * A frame that never arrives therefore writes NOTHING: the request may have
   * failed, or the server may have ignored a field it did not recognise (unknown
   * fields are accepted silently [实测 06-probes P1 严格性观察]). Leaving the old
   * value in place is the fail-closed reading of both.
   */
  private onThreadSettingsUpdated(state: CodexSessionState, params: unknown): void {
    if (!belongsToThread(state.threadId, params)) {
      this.log('WARN codex thread settings for a foreign thread, ignored', {
        sessionId: state.sessionId,
        expected: state.threadId,
      });
      return;
    }
    const settings = isRecord(params) ? params.threadSettings : undefined;
    if (!isRecord(settings)) {
      this.log('codex thread settings frame had no settings object', {
        sessionId: state.sessionId,
      });
      return;
    }

    const session = this.opts.registry.get(state.sessionId);
    if (!session) return;

    const model = typeof settings.model === 'string' ? settings.model.trim() : '';
    // A settings frame is a FULL snapshot of the thread (13 fields [实测 P3]), so
    // an absent/blank model means codex reports none — not "unchanged". Still,
    // only a usable value is written: blanking the default would make the next
    // turn silently fall back to the provider default.
    if (model) session.model = model;
    if (isSessionEffortLevel(settings.effort)) session.effort = settings.effort;
    this.log('codex thread settings applied', {
      sessionId: state.sessionId,
      model: session.model,
      effort: session.effort,
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
      // No longer question-only: slice 4 gave approvals the same posture (P1,
      // in the approval branch below), plus one reason of their own — the diff
      // cache lives on the TURN's normalizer, so with no turn there is nothing
      // to correlate a patch against. The two guards have to stay in step: a
      // refusal here and a registration there would mean codex can revive a
      // stopped session through whichever door was left open.
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

    // The approval bridge (slice 4). Both guards run BEFORE `register()`: an
    // entry registered and then refused would leave a card on screen for a
    // request that has already been answered.
    //
    // P1 — no turn is running. Same argument as the question bridge's G1
    // (`stop()` neither tears the session down nor deletes it, and the real
    // effect of `turn/interrupt` is [未测], so codex can keep asking after the
    // user pressed Stop), plus one that is specific to approvals: the diff
    // cache lives on the TURN's normalizer, so with no turn there is nothing to
    // correlate a patch against and the card could not be rendered anyway.
    if (!state.turn) {
      this.refuseServerRequest(state, req.id, kind, 'aborted', 'no turn is running');
      return;
    }
    // P2 — a kind we cannot put on screen. See `APPROVAL_CARD_KINDS`.
    const permissionKind = APPROVAL_CARD_KINDS.get(kind);
    if (!permissionKind) {
      this.refuseServerRequest(state, req.id, kind, 'unsupported', 'no card for this kind');
      return;
    }
    // There is deliberately no third guard for a missing diff: a card without
    // one is degraded, a turn waiting for one is broken (hard constraint 7).

    const permissionId = this.correlationIdFor(sessionId, req.id);
    const registered = state.pending.register({
      requestId: req.id,
      sessionId,
      kind,
      method: req.method,
      params: req.params,
      correlationId: permissionId,
      createdAt: Date.now(),
    });
    if (!registered) return;

    const offered = readOfferedDecisions(kind, req.params);
    const params = isRecord(req.params) ? req.params : undefined;
    const reason = readText(params, 'reason');
    const detail =
      permissionKind === 'exec'
        ? buildExecDetail(req.params)
        : buildFileChangeDetail(
            state.turn.normalizer.getFileChangeDetail(readText(params, 'itemId') ?? ''),
            req.params
          );

    this.opts.emit({
      type: 'permission.requested',
      sessionId,
      payload: {
        permissionId,
        toolName: APPROVAL_TOOL_NAME[permissionKind],
        kind: permissionKind,
        // The protocol's own key for the agent's justification. `description` is
        // the Claude arm of the same card and reading one while writing the
        // other loses every Codex reason, silently.
        ...(reason ? { reason } : {}),
        decisions: offered.decisions,
        // A `0` would read as a deliberate statement that something was dropped.
        ...(offered.omitted > 0 ? { omittedDecisionCount: offered.omitted } : {}),
        detail,
        // No `input`: that field is a Claude tool's arguments, and there is no
        // counterpart here. No `session.status` either — C10 rule 3 gives the
        // waiting state exactly one writer, and codex does send
        // `waitingOnApproval` itself [实测].
      },
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

  /**
   * Takes the STATE, not the sessionId: this handler is the one that can fire
   * after the connection was disposed, so it must answer "did MY session die"
   * rather than "is there a session under this id" — the two differ for exactly
   * as long as a killed child takes to exit, which is the window a revive opens
   * a fresh link in. `torndown` is what makes it a no-op for every kill we asked
   * for (teardown sets it before anything else), including close, dispose and
   * the idle sweep.
   */
  private onExit(
    state: CodexSessionState,
    info: { code: number | null; signal: string | null }
  ): void {
    if (state.torndown) return;
    const { sessionId } = state;
    this.log('codex process exited', { sessionId, code: info.code, signal: info.signal });
    const error = `codex app-server exited (code=${String(info.code)}, signal=${String(info.signal)})`;
    // An open turn is closed FIRST, and it carries the terminal event. Doing it
    // the other way round (session.failed here, turn closed by teardown) would
    // report the same death twice and leave the assistant bubble streaming in
    // between. Exactly one `session.failed` leaves this method either way.
    const hadTurn = state.turn !== null;
    if (hadTurn) this.finishTurn(state, 'failed', error);
    // A death INSIDE the resume window is already going to be reported: the
    // link's teardown rejects the in-flight `initialize`/`thread/resume`, and
    // that rejection ends in the degradation contract with a real error code.
    // Emitting `session.failed` on top would tell the renderer the session
    // crashed AND then that it resumed idle, in that order — one death, two
    // reports, and the second one contradicting the first.
    const resuming = state.statusGated;
    // Arbitration doc §2.3 O-d: the process is gone but the cards are still on
    // screen. `{}` — no session filter — because this table belongs to the
    // connection that just died; every entry in it is now unanswerable.
    this.teardown(state, 'aborted', 'process exited', {});
    this.opts.registry.setStatus(sessionId, 'disconnected');
    if (!hadTurn && !resuming) {
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
    // An approval still parked belongs to a turn that no longer exists, and the
    // renderer clears its permission QUEUE on every terminal event — so the
    // entry loses its queue slot while `block.resolved` stays false, i.e. the
    // card spins until the session is closed. The reverse (clearing without
    // replying) is the hang this table exists to prevent, so both halves happen
    // here. Usually a no-op: the teardown paths drain first, because after
    // `dispose()` there is no stdin left to write the refusals to.
    //
    // APPROVALS ONLY, and that is a deliberate DEVIATION from the spec, recorded
    // here rather than silently: §2.6 prescribes `drain({sessionId}, 'aborted')`
    // — the whole table for this session. It is narrowed to the approval kinds
    // because the renderer's terminal branches discard `pendingPermissions` and
    // nothing else, so a question parked here is NOT stranded — its dock
    // survives — and auto-rejecting one the user can still answer would be new
    // harm, not the fix. Slice 3 shipped that question posture deliberately;
    // this stays scoped to the defect §2.6 actually names.
    this.drainPending(state, 'aborted', `turn ${outcome}`, {
      sessionId: state.sessionId,
      kinds: [...APPROVAL_CARD_KINDS.keys()],
    });
    if (!opts.terminalAlreadyEmitted) turn.normalizer.closeTurn(outcome, error);
  }

  /**
   * Settle every pending request of this session with a fail-safe refusal, and
   * say so once in the log.
   *
   * One helper rather than four call sites, so that "every drain is audible"
   * cannot be true of three of them: the count and the reason are the only
   * evidence that a card left the screen because we answered for it.
   */
  private drainPending(
    state: CodexSessionState,
    reason: 'session_closed' | 'aborted',
    why: string,
    filter: { sessionId?: string; kinds?: readonly PendingKind[] } = {
      sessionId: state.sessionId,
    }
  ): PendingServerRequest[] {
    const drained = state.pending.drain(filter, reason);
    if (drained.length > 0) {
      this.log('codex pending drained', {
        sessionId: state.sessionId,
        count: drained.length,
        reason,
        why,
      });
    }
    return drained;
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
    this.drainPending(state, reason, disposeReason, filter);
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
    this.drainPending(state, 'aborted', 'stop');
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
    // Off the revive list with the row: the binding a revive would reopen is
    // being deleted one line below, so a send arriving afterwards is a genuine
    // `session_not_found` and must read as one.
    this.sweptSessions.delete(input.sessionId);
    this.stopSweeperIfIdle();
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
    this.sweptSessions.clear();
    if (this.sweeper) {
      this.sweeper.stop();
      this.sweeper = null;
    }
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
    let state = this.sessions.get(sessionId);
    const session = this.opts.registry.get(sessionId);
    // The idle sweeper took this session's process while the user was away, and
    // this send is them coming back. Reopening the thread is the whole reason
    // the sweep keeps the registry row (see `reclaimIdleSession`); it happens
    // before any of the checks below, so a revived session is then treated as
    // the ordinary live session it now is.
    const handle = state ? null : this.reviveHandleFor(sessionId, session);
    if (handle) {
      state = await this.reviveSweptSession(sessionId, handle, requestId);
      // Every failure has already been reported as `session_revive_failed`.
      if (!state) return;
    }
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

    // D48 §4.6 — per-turn choice wins, otherwise the session default carried on
    // the registry entry. That default is whatever the LAST accepted override
    // was (`onThreadSettingsUpdated` re-pins it), so a session that changed model
    // mid-conversation keeps the new one across an idle-sweep revive, where the
    // reopened thread is addressed by `thread/resume` and carries no model at all.
    const model =
      typeof input.model === 'string' && input.model.trim() ? input.model.trim() : session.model;
    const effort =
      (isSessionEffortLevel(input.effort) ? input.effort : undefined) ?? session.effort;
    const params = buildTurnStartParams({ threadId: state.threadId, text, model, effort });
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

  /**
   * May this missing session be revived, and with which thread?
   *
   * THREE conditions, and the first is the one that keeps this narrow: the
   * session must be on the sweep list. "State is missing" has other causes — a
   * crashed app-server, a cold resume that failed — and each of those was
   * already reported to the user; reopening one silently would replace a failure
   * they saw with a recovery they cannot audit. Only a session WE took away, for
   * a reason that was never their business, gets put back.
   *
   * The other two are the binding itself: a row that is not this runtime's, or
   * that has no thread handle, has nothing to reopen. Both fall through to
   * `session_not_found`, which is what they were before this path existed.
   */
  private reviveHandleFor(sessionId: string, session: HostSession | undefined): string | null {
    if (!session || !this.sweptSessions.has(sessionId)) return null;
    if (session.agent !== CODEX_AGENT) return null;
    return session.runtimeIdentity ?? null;
  }

  /**
   * Put a swept session back: spawn, handshake, `thread/resume`, and hand the
   * caller a state it can send on. QUIET — no `session.resumed`, no
   * `session.history`, no status. The renderer never learned the session went
   * away, so telling it the session came back would replay a transcript it is
   * already showing and reset a chat the user is in the middle of.
   *
   * The state is inserted BEFORE the first byte goes out, exactly as the cold
   * resume does and for the same reason (H11): the window is not quiet, and a
   * server request arriving with no state is dropped without a reply — parking
   * codex on an answer that never comes. `reviving` and `statusGated` are set on
   * it before it is reachable, so no second command and no status frame can slip
   * into the gap.
   *
   * Returns nothing on every failure, having already reported it.
   */
  private async reviveSweptSession(
    sessionId: string,
    threadId: string,
    requestId?: string
  ): Promise<CodexSessionState | undefined> {
    const session = this.opts.registry.get(sessionId);
    if (!session) return undefined;

    const opened = this.openConnection({
      sessionId,
      workspacePath: session.workspacePath,
      why: 'session.revive',
    });
    if (!opened.ok) {
      // Nothing was started, so there is nothing to tear down — and the session
      // stays ON the list: a machine that could not spawn codex this second may
      // well manage it next time, and dropping it would silently downgrade every
      // later send to the renderer's new-thread fallback.
      this.failRevive(sessionId, requestId, `could not start codex — ${opened.message}`);
      return undefined;
    }

    const state = opened.state;
    state.reviving = true;
    state.statusGated = true;
    this.sessions.set(sessionId, state);
    // The sweep that produced this session may have emptied the map and stopped
    // the sweeper; a revived session has to be watched again like any other.
    this.ensureSweeper();
    this.log('codex reviving a swept session', {
      sessionId,
      threadId,
      pid: state.connection.pid,
    });

    try {
      await this.withDeadline(
        this.reopenThread(state, threadId),
        CODEX_REVIVE_DEADLINE_MS,
        `revive of ${sessionId}`
      );
    } catch (err) {
      const message = errorMessage(err);
      this.log('codex revive failed', { sessionId, threadId, error: message });
      // Teardown FIRST (H10 order): the process must be gone before the renderer
      // is told the send failed, or a user retrying leaks one app-server per
      // attempt.
      this.teardown(state, 'session_closed', `revive failed: ${message}`);
      this.opts.registry.setStatus(sessionId, 'disconnected');
      if (classifyResumeFailure(err) === 'jsonl_not_found') {
        // The rollout is genuinely gone — deleted behind our back, or never
        // written. No retry can succeed, so the session leaves the list and
        // converges back to the pre-existing `session_not_found` semantics,
        // renderer fallback included. Every OTHER failure stays on the list:
        // spawn, handshake and timeout are all things that pass.
        this.sweptSessions.delete(sessionId);
      }
      this.failRevive(sessionId, requestId, message);
      return undefined;
    }

    state.threadId = threadId;
    state.rolloutBacked = true;
    state.reviving = false;
    // O3, and it has exactly one clear point on this path: `emitHistoryClose`
    // opens the gate for a cold resume, and nothing on a quiet revive ever calls
    // it. Left set, this session would drop every `thread/status/changed` for
    // the rest of its life — a session that can send but can never look busy.
    state.statusGated = false;
    this.sweptSessions.delete(sessionId);
    this.log('codex session revived', { sessionId, threadId, pid: state.connection.pid });
    return state;
  }

  /**
   * The revive's own I/O: handshake, then `thread/resume` with EXACTLY one key,
   * then H9 layer 2.
   *
   * Deliberately the same three steps in the same order as `resumeColdThread`,
   * sharing `assertResumePosture` rather than re-checking inline — the posture
   * of a reopened thread comes from the isolated `config.toml` on both paths, so
   * one of them verifying more weakly than the other would mean a session's
   * safety depended on how it happened to be reopened.
   */
  private async reopenThread(state: CodexSessionState, threadId: string): Promise<void> {
    const init = await state.connection.request(
      CODEX_METHOD.initialize,
      buildInitializeParams(this.opts.appVersion),
      CODEX_INITIALIZE_TIMEOUT_MS
    );
    this.checkHomeEcho(state.sessionId, init);
    state.connection.notify(CODEX_METHOD.initialized, {});
    const result = await state.connection.request(CODEX_METHOD.threadResume, { threadId });
    const detail = assertResumePosture(state.policy, result);
    this.log('codex revive posture verified', { sessionId: state.sessionId, detail });
  }

  /**
   * A budget for the WHOLE chain rather than for each of its steps — see
   * `CODEX_REVIVE_DEADLINE_MS` for why the per-request deadlines cannot serve.
   *
   * `Promise.race` attaches a handler to both sides, so the loser's rejection is
   * always handled: the work rejecting after the deadline won (the teardown
   * kills the link, which rejects everything outstanding) is the normal case,
   * and an unhandled rejection there would take the Host down.
   */
  private async withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    let expire = (): void => {
      /* replaced synchronously by the executor below */
    };
    const deadline = new Promise<never>((_resolve, reject) => {
      expire = () => reject(new Error(`${what} timed out after ${ms}ms`));
    });
    const timer = this.startTimeout(() => expire(), ms);
    timer.unref();
    try {
      return await Promise.race([work, deadline]);
    } finally {
      timer.stop();
    }
  }

  /**
   * The one place a revive failure reaches the user, and the one place the code
   * is spelled. See `CODEX_REVIVE_FAILED_CODE` for why it is not
   * `session_not_found`: the renderer answers that code by building a NEW thread
   * over this one's binding.
   */
  private failRevive(sessionId: string, requestId: string | undefined, why: string): void {
    this.fail(
      CODEX_REVIVE_FAILED_CODE,
      `session.send: this Codex session was reclaimed while it was idle and could not be ` +
        `reopened — ${why}`,
      { sessionId, requestId }
    );
  }

  /**
   * Resume a Codex session (slice 5b: replay the thread and keep the link).
   *
   * The renderer waits for three events after a resume, in order, and treats
   * anything else as a resume that never finished. So every ACCEPTED resume
   * emits all three — `session.resumed`, `session.history`, `session.status` —
   * whether it replayed the thread or failed trying, and a failure says WHY in
   * `session.history.error` (H10: a failed resume ends in `session.history{error}`,
   * never in a `host.error`).
   *
   * Two guards run BEFORE any of that, because they are not failed resumes but
   * refusals to take the session at all — the two documented exceptions to H10:
   *
   *  - a session with a live turn: it is already usable, and painting a history
   *    error banner over a running conversation would be false. Mirrors
   *    `claudeRuntime.resumeSession` (CP4 F-1), down to the `session_busy` code
   *    the renderer's bounded retry keys on.
   *  - a session another runtime owns: `registry.resume` deliberately does NOT
   *    merge `agent`, so "resuming" it here would emit `session.resumed{codex}`
   *    for a row that still routes every send to the other runtime.
   *
   * The third guard is not a refusal but a fork: a session whose app-server is
   * still alive is READ over that same link (`thread/turns/list`) instead of
   * being resumed a second time — see `resumeOverLiveConnection`.
   */
  resumeSession(input: {
    sessionId: string;
    workspacePath: string;
    runtimeIdentity: string;
    model?: string;
    /** D48 §4.6 — the session default a resumed thread's turns inherit. */
    effort?: unknown;
    requestId?: string;
  }): void {
    const { sessionId, requestId } = input;
    const state = this.sessions.get(sessionId);
    const session = this.opts.registry.get(sessionId);

    // Guard ⓪ — a revive is already reopening this thread. FIRST, because it is
    // the only guard that can catch it: no turn is running (guard ①), the agent
    // matches (guard ②), and guard ③'s `connection.alive` is true from the
    // moment the link is constructed — so without this the sidebar's resume
    // would be answered with `thread/turns/list` over a connection that has not
    // even finished `initialize`. `session_busy` because it IS transient: the
    // revive settles within its own deadline.
    if (state?.reviving === true) {
      this.fail('session_busy', `Cannot resume while this session is reconnecting: ${sessionId}`, {
        sessionId,
        requestId,
      });
      return;
    }

    // Guard ①. Both readings, because they fail apart: `state.turn` is our own
    // admission record (the one `send` gates on) and `running` is the registry's,
    // written by the turn lifecycle — a session mid-handshake has the second
    // without the first.
    if (state?.turn != null || session?.running === true) {
      this.fail('session_busy', `Cannot resume while a turn is running: ${sessionId}`, {
        sessionId,
        requestId,
      });
      return;
    }

    // Guard ②. Checked against the REGISTRY, not against our own session map:
    // the map only knows sessions this runtime started, so a Claude-owned row
    // would sail past it and be re-emitted as a Codex session.
    if (session && session.agent !== CODEX_AGENT) {
      this.fail(
        'agent_conflict',
        `session.resume: ${sessionId} is bound to ${session.agent} and cannot be resumed as ` +
          `${CODEX_AGENT} — a session's agent is fixed for its life`,
        { sessionId, requestId }
      );
      return;
    }

    // Guard ③: a session whose app-server is still alive keeps it. Reusing the
    // connection (rather than spawning a second one for the same thread) is what
    // stops a resume from leaking a process — and the live link's own thread is
    // the truth about what this session is, so its ids win over the caller's
    // stale index row.
    const live = state && !state.torndown && state.connection.alive ? state : undefined;
    if (live) {
      void this.resumeOverLiveConnection(live, input);
      return;
    }

    void this.resumeColdThread(input);
  }

  /**
   * Resume a thread nothing in this process is holding: launch, handshake,
   * `thread/resume`, replay.
   *
   * The order of the first four statements is H11 and is the whole reason this
   * is not "spawn, initialize, resume, then register": the resume window is NOT
   * quiet. Between the request and its answer codex pushes MCP startup
   * notifications, a `thread/status/changed` and a token-usage frame
   * [实测 `codex-s5-thread-resume.jsonl` lines 5-8], and it may send a server
   * REQUEST (an elicitation from a starting MCP server) — which
   * `onServerRequest` drops without a reply when `this.sessions` has no entry,
   * parking codex on an answer that never comes.
   */
  private async resumeColdThread(input: {
    sessionId: string;
    workspacePath: string;
    runtimeIdentity: string;
    model?: string;
    effort?: unknown;
    requestId?: string;
  }): Promise<void> {
    const { sessionId, requestId, workspacePath } = input;
    // The caller's handle IS the thread id: there is no live link whose own
    // thread could contradict it, and it is what the index row persisted.
    const threadId = input.runtimeIdentity;

    // The quiet reclaim is over the moment the user reopens the session
    // themselves: from here on the outcome is reported to them through the
    // three-event contract, so a failure must not leave the id on the revive
    // list. It would otherwise send the NEXT message off to spawn a second
    // codex behind a banner the user is already reading.
    this.sweptSessions.delete(sessionId);

    const opened = this.openConnection({ sessionId, workspacePath, why: 'session.resume' });
    if (!opened.ok) {
      // Nothing was started, so there is nothing to tear down — but the row is
      // still BOUND (G1 negative control ①): the renderer's next send has to
      // reach this runtime and be refused audibly, not be handed to Claude.
      this.bindResumedRow({
        sessionId,
        workspacePath,
        runtimeIdentity: threadId,
        model: input.model,
        effort: input.effort,
      });
      this.finishResume(
        { sessionId, requestId, runtimeIdentity: threadId, workspacePath },
        degradedHistory(
          'read_failed',
          `session.resume: could not start codex to read this thread — ${opened.message}`
        )
      );
      return;
    }

    const state = opened.state;
    // m13: the mapper is shut BEFORE the state is reachable, so a status frame
    // cannot beat `session.resumed` out of the door.
    state.statusGated = true;
    this.sessions.set(sessionId, state);
    // The second mount point, and the one a restarted app hits first: a process
    // whose only sessions came from the history list would otherwise never start
    // a sweeper at all.
    this.ensureSweeper();
    this.bindResumedRow({
      sessionId,
      workspacePath,
      runtimeIdentity: threadId,
      model: input.model,
      effort: input.effort,
    });
    this.log('codex resume starting', {
      sessionId,
      threadId,
      pid: state.connection.pid,
      source: opened.plan.source,
      homeDir: opened.homeDir,
    });

    try {
      const init = await state.connection.request(
        CODEX_METHOD.initialize,
        buildInitializeParams(this.opts.appVersion),
        CODEX_INITIALIZE_TIMEOUT_MS
      );
      this.checkHomeEcho(sessionId, init);
      state.connection.notify(CODEX_METHOD.initialized, {});

      // EXACTLY one key. `thread/resume` takes overrides (cwd, model, posture)
      // that would each become a second source for something the thread already
      // decided — and the posture in particular must come back from the isolated
      // config.toml, or the H9 check below would be verifying our own echo.
      const result = await state.connection.request(CODEX_METHOD.threadResume, { threadId });

      // H9 layer 2, fail-safe. BEFORE the transcript is emitted and before the
      // thread id is adopted: a posture we cannot confirm means the session must
      // not become sendable at all.
      const detail = assertResumePosture(state.policy, result);
      this.log('codex resume posture verified', { sessionId, detail });

      // Adopted only now, and this is what makes the resumed session a LIVE one:
      // `send` gates on `state.threadId`, so the next `turn/start` addresses the
      // thread we just resumed instead of waiting for a `thread/start` that this
      // path never issues.
      state.threadId = threadId;
      // An answered `thread/resume` IS the proof that the rollout file exists —
      // the only proof there is, short of reading the user's disk.
      state.rolloutBacked = true;

      const read = reprojectCodexHistory(result, { threadId });
      this.log('codex resume replayed', {
        sessionId,
        threadId,
        truncated: read.truncated,
        omittedCount: read.omittedCount,
        stats: read.stats,
      });
      this.finishResume({ sessionId, requestId, runtimeIdentity: threadId, workspacePath }, read);
    } catch (err) {
      const message = errorMessage(err);
      this.log('codex resume failed', { sessionId, threadId, error: message });
      // Teardown FIRST (H11): drain the pending table, interrupt nothing, kill
      // the process, drop the state. Emitting the degradation while the link was
      // still up would leave one app-server per failed resume alive until the
      // app quits, and the renderer would be told the session is idle while a
      // process it cannot address is still running.
      this.teardown(state, 'session_closed', `resume failed: ${message}`);
      this.finishResume(
        { sessionId, requestId, runtimeIdentity: threadId, workspacePath },
        degradedHistory(classifyResumeFailure(err), `session.resume: ${message}`)
      );
    }
  }

  /**
   * Guard ③ — the session is already talking to a codex; read its history back
   * over that same link.
   *
   * `thread/turns/list`, never `thread/resume`: resuming a thread that is loaded
   * in this very process would be asking the app-server to re-enter a session it
   * is already running, whose side effects are [未测]. The list method returns
   * the same items [实测 `codex-s5-u2a-report.json`: `threadTurnsList.items`
   * matches `threadResume.items`] and has no side effect at all.
   *
   * Nothing here can fail the SESSION: the link is up and the thread is usable,
   * so a failed read degrades to `session.history{read_failed}` and the session
   * stays exactly as it was. Tearing it down (as the cold path does) would take
   * a working session away from the user because a transcript could not be read
   * — the H9 echo check is skipped for the same reason, and because
   * `thread/turns/list` echoes no posture at all.
   */
  private async resumeOverLiveConnection(
    state: CodexSessionState,
    input: {
      sessionId: string;
      runtimeIdentity: string;
      model?: string;
      effort?: unknown;
      requestId?: string;
    }
  ): Promise<void> {
    const { sessionId, requestId } = input;
    // The live link's own ids win over the caller's stale index row: they name
    // the thread this connection can actually address.
    const runtimeIdentity = state.threadId ?? input.runtimeIdentity;
    const workspacePath = state.workspacePath;
    this.log('codex resume reusing the live connection', {
      sessionId,
      threadId: state.threadId,
      requestedIdentity: input.runtimeIdentity,
    });

    const entry = this.bindResumedRow({
      sessionId,
      workspacePath,
      runtimeIdentity,
      model: input.model,
      effort: input.effort,
    });
    // Emitted before the read, unlike the cold path: this session is already
    // resumed in every sense the renderer cares about (bound, connected,
    // sendable), so making the user wait for a round trip to learn that would
    // only widen the window in which the UI shows a half-resumed row.
    this.emitResumed({ sessionId, requestId, agent: entry.agent, runtimeIdentity });

    let history: CodexHistoryPayload;
    try {
      const result = await state.connection.request(CODEX_METHOD.threadTurnsList, {
        threadId: runtimeIdentity,
      });
      history = readTurnsListHistory(result, runtimeIdentity);
      this.log('codex resume read the live thread', {
        sessionId,
        threadId: runtimeIdentity,
        messages: history.messages.length,
        truncated: history.truncated,
      });
    } catch (err) {
      history = degradedHistory(
        'read_failed',
        `session.resume: this session is still connected, but its earlier messages ` +
          `could not be read back: ${errorMessage(err)}`
      );
    }
    // Closed while we were reading. The close path already emitted
    // `disconnected`; a history + idle behind it would resurrect a dead row.
    if (!this.opts.registry.get(sessionId) || state.torndown) {
      this.log('codex resume: session vanished while reading the live thread', { sessionId });
      return;
    }
    this.emitHistoryClose({ sessionId, requestId, runtimeIdentity, workspacePath }, history);
  }

  /**
   * Bind the row to this runtime. Called before the first byte of I/O on every
   * resume path (H11): `index.ts` routes send/stop/close on
   * `registry.get(sessionId).agent`, so a command arriving mid-resume would go
   * to the Claude runtime if the entry were written afterwards.
   *
   * D48 §4.6: `effort` IS carried now, and for the reason it used to be dropped
   * inverted — the Codex axis has a measured effort parameter on `turn/start`, so
   * a resumed row that forgot its session default would silently downgrade every
   * later turn to the model default.
   */
  private bindResumedRow(input: {
    sessionId: string;
    workspacePath: string;
    runtimeIdentity: string;
    model?: string;
    effort?: unknown;
  }) {
    return this.opts.registry.resume({
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      runtimeIdentity: input.runtimeIdentity,
      agent: CODEX_AGENT,
      model: input.model,
      effort: isSessionEffortLevel(input.effort) ? input.effort : undefined,
    });
  }

  /** The whole three-event contract, for the paths that emit it in one go. */
  private finishResume(target: ResumeTarget, history: CodexHistoryPayload): void {
    // A close that landed while we were resuming already emitted `disconnected`;
    // three more events behind it would put the row back on screen as idle.
    if (!this.opts.registry.get(target.sessionId)) {
      this.log('codex resume: session vanished before the contract was emitted', {
        sessionId: target.sessionId,
      });
      return;
    }
    const agent = this.opts.registry.get(target.sessionId)?.agent ?? CODEX_AGENT;
    this.emitResumed({ ...target, agent });
    this.emitHistoryClose(target, history);
  }

  /**
   * `session.resumed`. Split from the history pair because guard ③ emits it a
   * round trip earlier, and one spelling of the event beats two.
   */
  private emitResumed(input: {
    sessionId: string;
    requestId?: string;
    runtimeIdentity: string;
    agent: AgentWireName;
  }): void {
    this.opts.emit({
      type: 'session.resumed',
      sessionId: input.sessionId,
      requestId: input.requestId,
      payload: {
        // Off the registry entry, so the event and the binding cannot disagree.
        agent: input.agent,
        runtimeIdentity: input.runtimeIdentity,
        // No `permissionPolicy`: the posture on a resumed thread is re-derived
        // from the isolated config.toml, and the echo that proves it is checked
        // (H9) rather than advertised — reporting the constant here would state
        // a posture instead of the verified one.
      },
    });
  }

  /** `session.history` (full payload) followed by the closing idle status. */
  private emitHistoryClose(target: ResumeTarget, history: CodexHistoryPayload): void {
    this.opts.emit({
      type: 'session.history',
      sessionId: target.sessionId,
      // Threaded through all three events: the renderer pairs a replay with the
      // resume that asked for it by `requestId`, and an unpaired one is dropped.
      requestId: target.requestId,
      payload: {
        runtimeIdentity: target.runtimeIdentity,
        workspacePath: target.workspacePath,
        agent: CODEX_AGENT,
        messages: history.messages,
        truncated: history.truncated,
        omittedCount: history.omittedCount,
        ...(history.error ? { error: history.error } : {}),
        // No `parseStats`: nothing was parsed off disk. Zeros there would report
        // a file that was read and found empty.
      },
    });
    // Emitted here rather than left to the status mapper (which is gated until
    // `session.resumed` anyway): this idle is the CONTRACT's closing event, the
    // one the renderer waits for to end the replay, and it deliberately does not
    // write the registry — same shape as the Claude arm.
    this.opts.emit({
      type: 'session.status',
      sessionId: target.sessionId,
      requestId: target.requestId,
      payload: { status: 'idle' },
    });
    // The gate opens only now, with the whole contract out (m13). Everything
    // above is synchronous, so nothing can slip between the three emits — but
    // releasing at `session.resumed` would leave the two later events racing a
    // status frame that is already queued on the link.
    const state = this.sessions.get(target.sessionId);
    if (state) state.statusGated = false;
  }

  /**
   * Answer a parked approval with the user's decision.
   *
   * `allow` is DERIVED from the decision rather than trusted alongside it: the
   * two arrive together over IPC and, once a decision that this build cannot map
   * has been downgraded to a deny, an echoed `allow` would paint an approved
   * card over a frame that said `decline`.
   */
  respondPermission(input: {
    sessionId: string;
    permissionId?: string;
    allow?: boolean;
    decision?: PermissionDecisionId;
    requestId?: string;
  }): void {
    const { sessionId, permissionId } = input;
    const state = this.sessions.get(sessionId);
    if (!state || !permissionId) {
      this.fail('invalid_payload', 'permission.respond: unknown session or missing permissionId', {
        sessionId,
        requestId: input.requestId,
      });
      return;
    }

    // Scanned, not parsed: `sessionId` may contain ':', so splitting the
    // correlation id is a parser waiting to be wrong (same rule as
    // `respondQuestion`). The table holds a handful of entries at most.
    const entry = state.pending
      .list()
      .find((candidate) => candidate.correlationId === permissionId);

    if (!entry) {
      // NOT a host.error, and deliberately NOT the Claude echo either. A
      // non-fatal host.error is invisible in the renderer, so the card would be
      // left unanswerable; and echoing `input.allow` — which is what the Claude
      // bridge does for its own desync recovery — would draw an "Allowed" card
      // for a request that no longer exists and granted nothing. The honest
      // convergence is the one a drain would have emitted.
      this.log('codex permission.respond: no pending entry, re-resolving', {
        sessionId,
        permissionId,
      });
      this.opts.emit({
        type: 'permission.resolved',
        sessionId,
        payload: { permissionId, allow: false, autoReason: 'aborted' },
      });
      return;
    }

    if (!APPROVAL_CARD_KINDS.has(entry.kind) || entry.sessionId !== sessionId) {
      // A shape error rather than a race: the id addressed something that is not
      // an approval, or belongs to another session. Nothing to converge.
      this.fail(
        'invalid_payload',
        `permission.respond: ${permissionId} is not this session's approval`,
        { sessionId, requestId: input.requestId }
      );
      return;
    }

    const requested: PermissionDecisionId = input.decision ?? (input.allow ? 'allow' : 'deny');
    const wire = toWireDecision(entry.kind, requested);
    // Fail-safe: a decision this build cannot express becomes a plain deny, on
    // the wire AND on the card. `deny` always maps for the live dialects, which
    // `codexDecisions.test.ts` pins.
    const effective: PermissionDecisionId = wire === null ? 'deny' : requested;
    if (wire === null) {
      this.log('WARN codex permission.respond: unmappable decision, denied instead', {
        sessionId,
        permissionId,
        kind: entry.kind,
        decision: requested,
      });
    }
    const body = wire ?? toWireDecision(entry.kind, 'deny');
    state.pending.settle(entry.requestId, { reason: 'answered', result: { decision: body } });

    this.opts.emit({
      type: 'permission.resolved',
      sessionId,
      requestId: input.requestId,
      payload: {
        permissionId,
        allow: effective === 'allow' || effective === 'allow_session',
        decision: effective,
        // No `autoReason`: a human decided this one.
      },
    });

    if (effective === 'cancel') this.finishAfterCancel(state);
  }

  /**
   * Local clean-up after the user picked "Deny and stop".
   *
   * `cancel` means the server interrupts the turn immediately [契约], and doing
   * nothing locally has two bad endings: a later `turn/completed` whose status
   * is not `completed` is projected as `session.failed` (the user's own choice
   * painted as a crash), and if no `turn/completed` arrives at all our turn
   * record never clears and every later send is refused `session_busy`.
   *
   * So: the same closing sequence as `stop()`, minus the interrupt. The reply we
   * just wrote IS the interrupt; sending `turn/interrupt` on top would be
   * shouting at a turn that is already dying. The registered cost is symmetric
   * with Stop's: if the server did NOT interrupt, its later frames are dropped
   * with a log line.
   */
  private finishAfterCancel(state: CodexSessionState): void {
    this.drainPending(state, 'aborted', 'decision cancel');
    const session = this.opts.registry.get(state.sessionId);
    if (session) {
      // The registry's own last reading, never an invented `stopping` (C10 rule
      // 3), and BEFORE the terminal — behind it, a busy status would re-freeze
      // the renderer's send gate.
      this.opts.emit({
        type: 'session.status',
        sessionId: state.sessionId,
        payload: { status: session.status },
      });
    }
    this.finishTurn(state, 'stopped');
  }

  /**
   * Project the timeline event for a request that left the pending table
   * WITHOUT the user answering it: a drain (stop / close / process exit / turn
   * end) or the server resolving its own request.
   *
   * `'answered'` is excluded because `respondQuestion` / `respondPermission`
   * have already emitted the richer event (the answers; the decision). Emitting
   * again here would deliver a second resolution for the same id, and the store
   * applies the last one it sees — so answering would repaint the card as
   * "skipped" / "denied automatically".
   *
   * Kinds that never raised a card are skipped: they are refused at the door
   * (`APPROVAL_CARD_KINDS`), so resolving one would address an id the renderer
   * has never seen.
   */
  private projectSettled(entry: PendingServerRequest, reason: PendingSettleReason): void {
    if (reason === 'answered') return;
    if (entry.kind === 'question') {
      this.opts.emit({
        type: 'question.resolved',
        sessionId: entry.sessionId,
        payload: { questionId: entry.correlationId, outcome: 'rejected' },
      });
      return;
    }
    if (!APPROVAL_CARD_KINDS.has(entry.kind)) return;
    this.opts.emit({
      type: 'permission.resolved',
      sessionId: entry.sessionId,
      payload: {
        permissionId: entry.correlationId,
        // Nothing a drain can send is a grant, so this is false on every path.
        allow: false,
        autoReason: toAutoReason(reason),
      },
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
