// Moved from src/runtime/plugins/permissions/index.ts (dsh-rebase P1-6a)

import type { PermissionAskReason } from '../types/runtimeEvents.ts';
import {
  type LegacyPermissionTier,
  type PermissionGear,
  type RuntimeMode,
  type RuntimePermissionSettings,
  resolveRuntimePermission,
} from '../types/runtimePermission.ts';
import {
  AUTO_REVIEW_MAX_CONSECUTIVE_DENIALS,
  AUTO_REVIEW_MAX_TOTAL_DENIALS,
  type AutoReviewFailure,
  type AutoReviewVerdict,
} from './autoReview/types.ts';
import { isDangerousShellCommand } from './dangerousCommands.ts';
import { PermissionError } from './errors.ts';
import {
  containsPath,
  encodeGrants,
  grantCovers,
  grantKeyOf,
  grantsFor,
  type PermissionGrant,
  type PersistedGrants,
} from './grants.ts';
import { pathPolicy } from './pathPolicy.ts';
import { policyAction, type RuntimePermissionPolicy } from './policy.ts';
import { isShellTool } from './shellTools.ts';

export { isShellTool };

export const PERMISSION_TIMEOUT_MS = 120_000;
/**
 * The abort reason the gate's own deadline uses.
 *
 * The deadline is enforced by aborting the same signal a cancel aborts, so
 * without a reason on it "you ran out of time" and "you pressed stop" arrive as
 * the identical event — and the card reported the countdown running out as
 * `aborted`, or the renderer wrote it down as a denial the user made
 * (permissions-08, rpc-projector-18). Compared by value, not identity: the
 * signal crosses `AbortSignal.any`, which forwards the reason as given.
 */
export const PERMISSION_TIMEOUT_REASON = 'permission_timed_out';
export type PermissionAction = 'allow' | 'ask' | 'deny';
export interface ToolPermissionRequest {
  tool: string;
  toolCallId: string;
  path: string;
  command?: string;
  /**
   * What the tool is about to write, for the approval card to show verbatim.
   *
   * The decision a person is being asked to make is about CONTENT — "write
   * these bytes into that file" — and the card that showed only the tool name,
   * the matched rule and a serialized argument object gave them none of it.
   * Optional because most tools have nothing to preview: a read or a glob is
   * fully described by its path.
   */
  preview?: { label: string; text: string };
  paths?: readonly string[];
  commands?: readonly string[];
  unresolvedPaths?: boolean;
  /**
   * Decision 191: the entries of `paths` a shell command reaches only through
   * the environment (`BashAnalysis.parameterPaths`). Full auto reads them as
   * parameters: they never make the command ask for being outside the workspace.
   */
  parameterPaths?: readonly string[];
  exploration?: boolean;
  /**
   * dsh-rebase P1-6d: a shell command no session grant may cover — it carries
   * code the analysis could not read (a script block, `Invoke-Expression`, a
   * variable). "Allow for session" on its card remembers nothing.
   */
  ungrantable?: boolean;
  /**
   * T002. The policy surface to match this call's rules against, when `tool`
   * itself is not that vocabulary's surface name. `mcp__<server>__<tool>` is
   * one tool per server-tool pair, but the ecosystem's policy schema writes
   * MCP rules under a single `mcp` surface — so the MCP bridge passes `'mcp'`
   * here while `tool` stays the specific name (grants, scopes and
   * `isToolAllowed` still need to key on the specific tool). Defaults to
   * `tool`, which is correct for every built-in.
   */
  policySurface?: string;
  /**
   * T002. The value matched against `policySurface`'s patterns, when it is
   * not `path` (or `command`/`commands` for bash). An MCP call matches on
   * `server:tool`, the shape the ecosystem's example configs already use; a
   * skill call matches on the skill's NAME, not its file path, because a
   * policy author writes `"skill": {"librarian": "allow"}` against the name
   * the model sees, never the path on disk. Defaults to `path`.
   */
  policyValue?: string;
  /**
   * T002. This path was not chosen by the model — it was resolved from a
   * catalog the host already scanned and trusts (skills, currently). Skips
   * the workspace-boundary `ask` a path outside cwd would otherwise get,
   * because there is no argument here that reaches an arbitrary path for a
   * user to be asked about. An explicit `deny` — bundled, global, project —
   * still blocks it; this only removes the unconditional `ask`.
   */
  trustedPath?: boolean;
  /**
   * P5-2-3. Which delegate made this call, when a delegate made it.
   *
   * The approval card has to say so. "Allow bash `rm -rf build`?" is a very
   * different question depending on whether the agent you are talking to asked
   * it or a subagent you delegated to twenty seconds ago did, and without this
   * the two cards are identical. It is also what lets a cancel or a denial stay
   * with the delegation it belongs to instead of crossing into another.
   */
  delegation?: { delegationId: string; agentName: string };
  /**
   * dsh-rebase P1-6b: an ask the DSH host raised itself (`approval/request`:
   * a sandbox escalation, or a third-party plugin's own question). DSH acts
   * on one answer for one call, so the card offers allow / deny only and
   * nothing is remembered for the session. `sandbox` marks an escalation:
   * the card says the call asks for wider sandbox permissions.
   */
  hostAsk?: { sandbox: boolean };
  /**
   * dsh-rebase P1-10d: a plugin tool whose review classified it as a file
   * write of `path` (an allowlisted plugin's `word_create`, say). `accept-edits`
   * allows it inside the workspace exactly as it allows `write` and `edit`;
   * `tool` keeps the plugin's own name for the card, grants and scopes.
   */
  fileWrite?: boolean;
  /**
   * dsh-rebase decision 190: a request to a URL the model chose (`web_fetch`).
   * Its subject is `policyValue`, the host: the tool's policy rules decide
   * on it, and a session grant remembers it. `path` is only the session's
   * workspace, so no file rule asks about it. Plan mode lets it through, as
   * it does reads: fetching a page changes nothing in the workspace.
   */
  network?: boolean;
}
/**
 * What a delegate's tool call resolves under.
 *
 * `gear` absent means inherit the session's — the default, and the only shape
 * an `inherit` definition produces.
 */
export interface DelegateCallScope {
  gear?: PermissionGear;
  delegation?: { delegationId: string; agentName: string };
}
export interface PermissionScope {
  root: string;
  tools: readonly string[];
  action: PermissionAction;
}
/**
 * Where a card sits in the gate's approval queue, at the moment it is shown.
 *
 * Only ever produced for a request that actually reaches `approve`; the gate
 * serializes those (see `acquirePrompt`), so exactly one slot is live at a time
 * and the numbers describe one burst of tool calls rather than the session.
 */
export interface PermissionQueueSlot {
  /**
   * 1-based, counting only the cards this burst has already put on screen.
   * Resets once the queue drains, so a lone request is always `1`.
   */
  position: number;
  /**
   * `position` plus everything still queued behind it — i.e. how many requests
   * the gate knows about RIGHT NOW.
   *
   * A snapshot, never a promise: more calls from the same turn can arrive while
   * the user is still reading card 1, so a card that said "1 of 3" may be
   * followed by one that says "2 of 5". It never shrinks within a burst.
   */
  depth: number;
}
/**
 * dsh-rebase P1-6d: what the gate knows about why a card is up.
 *
 * `askReason: 'unresolved'` — the gear would have allowed this call, and asks
 * only because the analysis could not read part of it (a variable, a script
 * block, a program's own body) (decision 046); since decision 191 a shell
 * command no longer asks for it under `auto`, only under `ask` and
 * `accept-edits`. Decision 191 §6 adds `'dangerous'` (a command on the
 * dangerous list, asked every time) and `'outside_workspace'` (a path outside
 * the workspace under a gear that allows what stays inside). Absent when the
 * gear asks anyway, so the card never blames the command for a question the
 * posture would have asked regardless.
 */
export interface PermissionAskContext {
  askReason?: PermissionAskReason;
  /** Decision 192: the review model's reason, on a card raised after repeated review blocks. */
  reviewReason?: string;
}
export interface PermissionConfig {
  /** The workspace, canonicalized the way the host canonicalizes targets. */
  cwd: string;
  /**
   * dsh-rebase decision 134: other spellings of the same workspace (the one
   * the session was opened with: through a symlink, or an 8.3 short name on
   * Windows). A path under any of them is inside the workspace. A shell
   * operand reaches the gate by both its written and its canonical spelling,
   * and the written one is under the session's spelling, not the canonical
   * one; a link out of the workspace still asks, through the canonical
   * spelling. Policy rules are matched relative to `cwd` only.
   */
  cwdAliases?: readonly string[];
  mode?: RuntimeMode;
  gear?: PermissionGear;
  tier?: LegacyPermissionTier;
  allowedTools?: readonly string[];
  scopes?: readonly PermissionScope[];
  policy?: RuntimePermissionPolicy;
  projectTrusted?: boolean;
  /**
   * Session grants this gate starts with, read back off the transcript.
   *
   * A resumed conversation is the SAME session to the person who reopened it,
   * so the approvals they already gave still hold; a brand-new one starts
   * empty because nothing has been approved in it yet. Supplied by
   * `bootstrap`, which is the only place that has the session file open before
   * this plugin exists.
   */
  grants?: readonly PermissionGrant[];
  approve?: (
    request: ToolPermissionRequest,
    signal: AbortSignal,
    /**
     * Optional third argument so every existing approver stays assignable:
     * a two-parameter function is still a valid `approve`, it simply cannot
     * tell the user there is a line behind this card.
     */
    queue?: PermissionQueueSlot,
    /** dsh-rebase P1-6d: why the gate asks, when it can say; see `PermissionAskContext`. */
    context?: PermissionAskContext
  ) => Promise<'allow-once' | 'allow-session' | 'deny'>;
  /**
   * Answer a card that is already on screen with `allow`, because the question
   * it asks has stopped being a question — see `setGear`.
   *
   * The gate cannot do this itself: the promise `approve` returned belongs to
   * the approval UI, and resolving it behind that UI's back would leave the
   * card up forever with nothing left to answer it. So the retraction goes
   * through the same surface that raised it, which emits the resolution the
   * renderer needs to take the card down.
   *
   * Returns false when nothing was waiting on that id. Optional: an approver
   * with no way to retract simply keeps asking, which is the old behaviour.
   */
  autoAllow?: (toolCallId: string) => boolean;
  timeoutMs?: number;
  /**
   * Decision 192: under `auto`, a call that would ask goes here first. Absent
   * when no review model is configured, and every ask is a card as before.
   */
  review?: (
    request: ToolPermissionRequest,
    context: PermissionAskContext,
    signal: AbortSignal
  ) => Promise<AutoReviewVerdict>;
}
/**
 * How a gate resolved, in the vocabulary the timeline row already speaks.
 *
 * The deny arms are split rather than collapsed into one `error`, because the
 * transcript row derived from them is the only place a refusal explains itself:
 * "a rule forbade this" and "you said no" and "the turn was cancelled while the
 * dialog was open" produce the same missing tool result and are otherwise
 * indistinguishable after the modal is gone.
 */
export type PermissionDecisionSource =
  | 'policy'
  | 'session-grant'
  | 'allow-once'
  | 'allow-session'
  | 'policy-deny'
  | 'user-denied'
  /** Nobody answered before the gate's own deadline; split from `cancelled`
   * because the audit row is the only place that difference survives. */
  | 'timed-out'
  | 'cancelled'
  | 'error'
  /** Decision 192: the review model allowed it, refused it, or could not decide. */
  | 'review-allowed'
  | 'review-denied'
  | 'review-failed';

/**
 * One observation about a gate, for observers that record rather than decide.
 *
 * Two phases because the transcript needs both halves: `prompt` says a question
 * was raised (the row that sits there while the modal is up), `decision` says
 * how it ended. A gate that never prompts — every `policy` allow — emits only
 * the second, and that record is the ONLY evidence the call was gated at all
 * rather than simply unchecked.
 */
export type PermissionActivityRecord =
  | { phase: 'prompt'; request: ToolPermissionRequest; mode: RuntimeMode; gear: PermissionGear }
  /** Decision 192: the call went to the review model; a `decision` follows. */
  | { phase: 'review'; request: ToolPermissionRequest; mode: RuntimeMode; gear: PermissionGear }
  | {
      phase: 'decision';
      request: ToolPermissionRequest;
      decision: 'allow' | 'deny';
      source: PermissionDecisionSource;
      mode: RuntimeMode;
      gear: PermissionGear;
      /** `review-denied`: the review model's reason. */
      reviewReason?: string;
      /** `review-failed`: what kept the review from deciding. */
      reviewFailure?: AutoReviewFailure;
    };

/** The gate's API; the 1.0.x runtime publishes it as `RuntimePermissionsService`. */
export interface PermissionGateService {
  /**
   * Watch gates resolve. Read-only by contract: a listener never decides,
   * delays or vetoes anything, and its exceptions are swallowed so a broken
   * observer cannot take the permission system down with it.
   */
  onActivity(listener: (record: PermissionActivityRecord) => void): () => void;
  authorize(request: ToolPermissionRequest, signal?: AbortSignal): Promise<void>;
  evaluate(request: ToolPermissionRequest): PermissionAction;
  isToolAllowed(name: string): boolean;
  configure(settings: Partial<RuntimePermissionSettings>): void;
  /**
   * Move the gear, and nothing else, while the session keeps running.
   *
   * The counterpart to `configure`, which is a posture change: it forgets every
   * session grant and voids every request parked at the gate, so it can only be
   * applied between turns. Sliding the gear is a much smaller statement — "ask
   * me less from now on" — and the whole value of it is that it can be made at
   * the moment the user is looking at a card they do not want to answer.
   *
   * So this keeps the grants, keeps the epoch, and keeps the queue. Widening
   * (ask → accept-edits → auto → bypass) re-judges the requests that are still
   * waiting: the card on screen is settled as allowed and retracted if the new
   * gear would not have raised it, and each request still queued behind it is
   * re-evaluated when its turn comes rather than being asked as it was written
   * down. Narrowing changes nothing that is already waiting — a question
   * already asked stays asked, and an answer already given stays given.
   */
  setGear(gear: PermissionGear): void;
  /**
   * Resolve one tool call under a delegate's scope, and give back the undo.
   *
   * Scoped per `toolCallId` rather than by switching the session gear, because
   * delegates run concurrently: a global switch would leak one delegate's gear
   * into another delegate's call, and into the parent's.
   *
   * `gear` is absent for a delegate that inherits — it still registers, because
   * `delegation` is what puts the delegate's name on the approval card, and an
   * inheriting delegate's card must say who is asking just as much as an
   * overriding one's.
   */
  scopeToolCall(toolCallId: string, scope: DelegateCallScope): () => void;
  readonly mode: RuntimeMode;
  readonly gear: PermissionGear;
  /** Decision 192: whether `auto` asks go to a review model before a card. */
  readonly autoReview: boolean;
  readonly policy: RuntimePermissionPolicy | undefined;
  canTraverse(request: ToolPermissionRequest): boolean;
}

/**
 * The clock the approval deadline runs on.
 *
 * The default reads the global timers at CALL time rather than capturing them,
 * so fake timers installed after the gate was built still drive it.
 */
export interface PermissionTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const GLOBAL_TIMERS: PermissionTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

/** What a host plugs into a gate, beyond the settings in `PermissionConfig`. */
export interface PermissionGateHooks {
  /**
   * Write the whole grant set down so it outlives the process: a transcript
   * entry in the 1.0.x runtime, a sidecar file in the DSH host. Called after
   * every change, `configure`'s clearing included.
   *
   * Fire-and-forget, and it must not throw. The gate is answering a user right
   * now and storage that cannot be written must not turn their "Allow" into a
   * failed tool call — the cost of a lost write is that the grant does not
   * survive the next restart.
   */
  persistGrants?: (record: PersistedGrants) => void;
  /**
   * Build the error a refusal throws (always code `tool_denied`). Defaults to
   * `PermissionDenial`; the runtime supplies its own `RuntimeHostError` kind.
   */
  createDenial?: (source: PermissionDecisionSource, message: string) => Error;
  /** Defaults to the global timers; see `PermissionTimers`. */
  timers?: PermissionTimers;
}

/**
 * One request parked in the approval queue. See `acquirePrompt`.
 *
 * `wake` reports whether the hand-over landed, because handing the gate to a
 * request that already gave up would leave the gate held by nobody — the one
 * failure here that never recovers.
 */
interface PromptWaiter {
  settled: boolean;
  wake: () => boolean;
}

/**
 * The request whose card is on screen right now, if any.
 *
 * The gate serializes approvals, so there is at most one — but `check` cannot
 * reach into its own pending `approve` promise, so the record is what lets
 * `setGear` find the live question and retract it.
 */
interface LivePrompt {
  request: ToolPermissionRequest;
  /** Settled by the gear rather than by a person. See `setGear`. */
  autoAllowed: boolean;
}

/**
 * How far each gear opens, so two of them can be compared.
 *
 * Only the ORDER is meaningful. It is the order the menu shows and the order
 * the four gears widen in: every call `ask` waves through, `accept-edits` waves
 * through too, and so on up to `bypass`, which raises no card at all.
 */
const GEAR_WIDTH: Record<PermissionGear, number> = {
  ask: 0,
  'accept-edits': 1,
  auto: 2,
  bypass: 3,
};

/**
 * The approval gate: judgement, the one-card-at-a-time queue, the deadline,
 * session grants and the audit record. Host-neutral — a host constructs one per
 * session, wires `persistGrants` to its storage and calls `dispose` on teardown.
 */
export class PermissionGate implements PermissionGateService {
  private readonly config: PermissionConfig;
  private readonly hooks: PermissionGateHooks;
  private readonly timers: PermissionTimers;
  /**
   * Session grants by key, so a repeat approval replaces rather than piles up
   * and the matcher can still read each record's shape.
   */
  private readonly grants = new Map<string, PermissionGrant>();
  private readonly controller = new AbortController();
  private settings: RuntimePermissionSettings;
  /** Per-call delegate scopes, keyed by tool call id. See `scopeToolCall`. */
  private readonly scopedGears = new Map<string, DelegateCallScope>();
  private epoch = 0;
  private readonly listeners = new Set<(record: PermissionActivityRecord) => void>();
  /**
   * Requests queued for the approval gate, in arrival order (FIFO).
   *
   * A model that asks for five tools at once produces five gates at once, and
   * before this queue all five raised a card and all five started their own
   * 120-second deadline at the same instant — so cards four and five could
   * expire before the user had ever seen them. Now only the holder is on
   * screen; the rest wait here, having emitted nothing and started no clock.
   */
  private readonly waiting: PromptWaiter[] = [];
  /** Whether a request currently holds the approval gate. */
  private prompting = false;
  /** The card on screen, for `setGear` to retract. Null between cards. */
  private live: LivePrompt | null = null;
  /** Cards shown since the queue was last empty; see `PermissionQueueSlot`. */
  private served = 0;
  /** Decision 192 §3.4: review blocks, as Claude Code counts them. */
  private reviewDenials = { consecutive: 0, total: 0 };

  constructor(config: PermissionConfig, hooks: PermissionGateHooks = {}) {
    this.config = config;
    this.hooks = hooks;
    this.timers = hooks.timers ?? GLOBAL_TIMERS;
    this.settings = resolveRuntimePermission(config);
    for (const grant of config.grants ?? []) this.grants.set(grantKeyOf(grant), grant);
  }
  /**
   * Tear the gate down: wake every waiter with a cancellation and forget all
   * session state. The host calls it once, when the session goes away.
   */
  dispose(): void {
    this.controller.abort();
    this.grants.clear();
    this.scopedGears.clear();
    this.listeners.clear();
  }
  get policy(): RuntimePermissionPolicy | undefined {
    return this.config.policy;
  }
  get mode(): RuntimeMode {
    return this.settings.mode;
  }
  get gear(): PermissionGear {
    return this.settings.gear;
  }
  get autoReview(): boolean {
    return this.config.review !== undefined;
  }
  configure(settings: Partial<RuntimePermissionSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.epoch++;
    this.grants.clear();
    // Written down as well as forgotten. Clearing only the in-memory copy would
    // hand every grant straight back on the next open, so a posture change
    // would be undone by reopening the conversation.
    this.persistGrants();
  }
  setGear(gear: PermissionGear): void {
    const previous = this.settings.gear;
    if (gear === previous) return;
    this.settings = { ...this.settings, gear };
    // Narrowing leaves the queue alone on purpose: a request that is already
    // waiting was raised under a posture the user has since tightened, and the
    // tightening is about what comes next. Denying it here would refuse a call
    // on the user's behalf that they were in the middle of deciding.
    if (GEAR_WIDTH[gear] <= GEAR_WIDTH[previous]) return;
    const live = this.live;
    if (!live || live.autoAllowed) return;
    // Re-judged, not waved through: widening is not "allow whatever is on
    // screen". A recursive delete still asks under `auto`, and a delegate
    // running on its own scoped gear is not affected by the session's at all —
    // both fall out of `evaluate` for free.
    if (this.evaluate(live.request) !== 'allow') return;
    if (this.config.autoAllow?.(live.request.toolCallId) !== true) return;
    live.autoAllowed = true;
  }
  scopeToolCall(toolCallId: string, scope: DelegateCallScope): () => void {
    this.scopedGears.set(toolCallId, scope);
    return () => {
      this.scopedGears.delete(toolCallId);
    };
  }
  /** Stamp the delegate's identity onto the request observers and the approval
   * card see. Parent calls pass through untouched. */
  private attribute(request: ToolPermissionRequest): ToolPermissionRequest {
    const delegation = this.scopedGears.get(request.toolCallId)?.delegation;
    return delegation ? { ...request, delegation } : request;
  }
  /**
   * The gear this request resolves under.
   *
   * A scope can only change which of ask / accept-edits / auto / bypass
   * applies — and no definition may declare `bypass`, so in practice a scope
   * reaches it only by inheriting a session already set to it. Every
   * deny — policy, path, scope, plan mode — is decided BEFORE the gear is
   * consulted in `evaluate`, so a delegate declaring `auto` still cannot cross
   * a deny rule, reach outside the workspace, widen its tool set, or turn a
   * parent plan session into an agent one.
   */
  private gearFor(request: ToolPermissionRequest): PermissionGear {
    return this.scopedGears.get(request.toolCallId)?.gear ?? this.settings.gear;
  }
  isToolAllowed(name: string): boolean {
    return !this.config.allowedTools || this.config.allowedTools.includes(name);
  }
  /** Inside the workspace, by any of its spellings (`cwd`, `cwdAliases`). */
  private inWorkspace(path: string): boolean {
    return (
      containsPath(this.config.cwd, path) ||
      (this.config.cwdAliases ?? []).some((root) => containsPath(root, path))
    );
  }
  /**
   * Has the user already approved a call of this shape in this session?
   *
   * `grantCovers` answers the part a grant is ABOUT — this file, this command
   * prefix. The three checks after it are the parts a grant deliberately does
   * not answer, and they are re-made on every call:
   *
   *  - a bundled-secret path (`.env`, `~/.ssh/*`) still asks, because a rule
   *    about a file outranks an approval that happened to name it;
   *  - a policy rule that says `ask` for a path still asks, same reasoning;
   *  - a bash grant never reaches outside the workspace it was given in. A
   *    command prefix says nothing about which files the NEXT invocation of it
   *    will touch, so `npm test` approved in the project does not become
   *    permission to run something named `npm test` against `/etc`.
   *
   * A file grant does cover its own path even outside the workspace, because
   * there the user was shown, and approved, that exact file.
   */
  private granted(request: ToolPermissionRequest): boolean {
    if (this.grants.size === 0) return false;
    // Decision 191 §6: a dangerous command is confirmed every time.
    if (isDangerousShellRequest(request)) return false;
    if (!grantCovers(this.grants.values(), request)) return false;
    if (request.trustedPath) return true;
    const inspected = [request.path, ...(request.paths ?? [])];
    if (inspected.some((path) => pathPolicy(path) === 'ask')) return false;
    const policy = this.config.policy;
    if (
      policy &&
      inspected.some((path) => policyAction(policy, 'path', [path], this.config.cwd) === 'ask')
    )
      return false;
    if (isShellTool(request.tool) && inspected.some((path) => !this.inWorkspace(path)))
      return false;
    return true;
  }
  /** Write down what this approval covers, and keep it across restarts. */
  private remember(request: ToolPermissionRequest): void {
    // Decision 191 §6: its card offers no "for session"; an answer that says so
    // anyway is taken as "allow once".
    if (isDangerousShellRequest(request)) return;
    const grants = grantsFor(request);
    // Nothing to remember is a real outcome, not a failure: a command whose
    // program name the shell analysis could not read has no prefix worth
    // storing, so the approval simply behaves like "allow once".
    if (grants.length === 0) return;
    for (const grant of grants) this.grants.set(grantKeyOf(grant), grant);
    this.persistGrants();
  }
  /** Hand the current grant set to the host's storage; see `persistGrants` on the hooks. */
  private persistGrants(): void {
    this.hooks.persistGrants?.(encodeGrants(this.grants.values()));
  }
  evaluate(request: ToolPermissionRequest): PermissionAction {
    if (!this.isToolAllowed(request.tool)) return 'deny';
    const inspectedPaths = [request.path, ...(request.paths ?? [])];
    const policy = this.config.policy;
    // What the policy says about where the call lands (the path table, the
    // workspace boundary), apart from what it says about the tool itself: a
    // trusted path waives the former's `ask` below, never the latter's.
    const pathDecisions = policy
      ? [
          ...inspectedPaths.map((path) => policyAction(policy, 'path', [path], this.config.cwd)),
          ...inspectedPaths
            .filter((path) => !this.inWorkspace(path))
            .map((path) => policyAction(policy, 'external_directory', [path], this.config.cwd)),
        ]
      : [];
    const toolDecisions = policy
      ? (isShellTool(request.tool)
          ? [request.command ?? '', ...(request.commands ?? [])]
          : [request.policyValue ?? request.path]
        ).map((value) =>
          policyAction(
            policy,
            request.policySurface ?? defaultPolicySurface(request.tool),
            [value],
            this.config.cwd
          )
        )
      : [];
    const decisions = [...pathDecisions, ...toolDecisions];
    if (decisions.includes('deny')) return 'deny';
    const pathAction = pathPolicy(request.path);
    if (pathAction === 'deny') return 'deny';
    if ((request.paths ?? []).some((path) => pathPolicy(path) === 'deny')) return 'deny';
    if (
      this.mode === 'plan' &&
      // `skill` is registered with `read` access (`plugins/skills/index.ts`)
      // and is now gated through this same `evaluate`, so it has to stay
      // callable wherever it stays listed — a plan session that can see the
      // tool but has every call throw would be a contract the registration
      // does not keep. Decision 190: a network fetch reads too.
      (!(
        ['read', 'glob', 'grep', 'skill'].includes(request.tool) ||
        isShellTool(request.tool) ||
        request.network === true
      ) ||
        (isShellTool(request.tool) && !request.exploration))
    )
      return 'deny';
    const matches = (this.config.scopes ?? []).filter(
      (scope) =>
        (scope.tools.includes('*') || scope.tools.includes(request.tool)) &&
        [request.path, ...(request.paths ?? [])].some((path) => containsPath(scope.root, path))
    );
    if (matches.some((scope) => scope.action === 'deny')) return 'deny';
    const gear = this.gearFor(request);
    // `bypass` answers every ask, whatever the command. It sits AFTER every
    // deny above — policy, bundled secrets, deny scopes, plan mode, the tool
    // whitelist — so it can only turn an `ask` into an `allow`; it never buys
    // authority a denied call did not have.
    if (gear === 'bypass') return 'allow';
    // Decision 191 §6 (user, 2026-10-17): a dangerous command asks under every
    // other gear, every time. Before the gear, the allow scopes and the session
    // grants below, none of which may wave it through: `accept-edits` used to
    // run `rm -rf` in the workspace unasked while `auto` asked.
    if (isDangerousShellRequest(request)) return 'ask';
    // Decision 191: `auto` asks only for what `autoStillAsks` names; the rest
    // falls to the checks below, where a session grant for the call still
    // applies.
    if (gear === 'auto' && !this.autoStillAsks(request)) return 'allow';
    if (matches.some((scope) => scope.action === 'ask'))
      return this.granted(request) ? 'allow' : 'ask';
    if (
      inspectedPaths.every((path) =>
        matches.some((scope) => scope.action === 'allow' && containsPath(scope.root, path))
      )
    )
      return 'allow';
    // Before the unresolved-operand stop, and that ordering is the whole point
    // of the bash rule: `npm test $FLAGS` resolves no operands at all, and
    // asking about it again after the user has already allowed `npm test` is
    // precisely the loop this change exists to end. What the grant cannot buy
    // it — a path outside the workspace, a secret file — `granted` withholds.
    if (this.granted(request)) return 'allow';
    if (request.unresolvedPaths) return 'ask';
    // Decision 190: a network request's `path` is the workspace, not a file it
    // touches, so the file rules below have nothing to ask about. The tool's
    // own rule for the host decides, `'*': 'ask'` by default, and with no
    // policy at all it asks; the gears above already let it through under
    // auto and bypass.
    if (request.network === true) return policy && !toolDecisions.includes('ask') ? 'allow' : 'ask';
    // A trusted path skips straight past the workspace-boundary checks below:
    // every deny above (policy, bundled secrets, scope) has already had its
    // say, and what remains is only "this is outside cwd", which does not
    // apply to a path the model never supplied.
    if (
      !request.trustedPath &&
      (pathAction === 'ask' ||
        !this.inWorkspace(request.path) ||
        (request.paths ?? []).some((path) => !this.inWorkspace(path) || pathPolicy(path) === 'ask'))
    )
      return 'ask';
    if (
      !request.trustedPath &&
      policy &&
      inspectedPaths.some((path) => policyAction(policy, 'path', [path], this.config.cwd) === 'ask')
    )
      return 'ask';
    // dsh-rebase P1-4c2 (decision 112): a trusted path's path-table and
    // workspace-boundary `ask` (`~/.pilab/*`, `external_directory`) are the
    // ones waived above; it must not come back here, or a read of a file the
    // host wrote itself (a spill, an attachment) still raises a card. The
    // tool's own rule (`read: ask`) still asks.
    if (['read', 'grep', 'glob'].includes(request.tool))
      return (request.trustedPath ? toolDecisions : decisions).includes('ask') ? 'ask' : 'allow';
    if (
      gear === 'accept-edits' &&
      (['write', 'edit'].includes(request.tool) ||
        request.fileWrite === true ||
        isShellTool(request.tool))
    )
      return 'allow';
    return request.trustedPath ? 'allow' : 'ask';
  }
  /**
   * What full auto still stops to confirm (decision 191, claude-sdk-engine
   * ruling 27), after every deny has had its say and after the dangerous
   * commands, which ask under every gear (`evaluate`).
   *
   * Any call that names a path outside the workspace by spelling it out: a
   * shell command (an operand the analysis could not read, or reached only
   * through the environment, is a parameter and asks nothing) and, since
   * decision 191 §6, a file tool too (`read`, `write`, `edit`, `glob`, `grep`,
   * a plugin's file tools). Besides that a call asks, as before, only when
   * something in it could not be read: an opaque program (`run_code`) or one
   * of DSH's own asks.
   */
  private autoStillAsks(request: ToolPermissionRequest): boolean {
    if (request.hostAsk) return request.unresolvedPaths === true;
    if (!isShellTool(request.tool) && request.unresolvedPaths) return true;
    return this.namesOutsidePath(request, { parametersCount: false });
  }
  /**
   * A path outside the workspace (by any of its spellings) that is not a device
   * and not one the host produced itself (`trustedPath`). `parametersCount`
   * says whether a path reached only through the environment counts.
   */
  private namesOutsidePath(
    request: ToolPermissionRequest,
    { parametersCount }: { parametersCount: boolean }
  ): boolean {
    if (request.trustedPath) return false;
    const parameters = new Set(parametersCount ? [] : (request.parameterPaths ?? []));
    return [request.path, ...(request.paths ?? [])].some(
      (path) => !parameters.has(path) && !this.inWorkspace(path) && !isDevicePath(path)
    );
  }
  /**
   * Why a card is up, when the gate can say (see `PermissionAskContext`):
   *
   *  - `'dangerous'`: a dangerous command, which asks under every gear but
   *    `bypass` and is never remembered for the session (decision 191 §6);
   *  - `'unresolved'` (P1-6d): the gear would have allowed this call had the
   *    analysis been able to read all of it;
   *  - `'outside_workspace'` (decision 191 §6): under `auto` or `accept-edits`,
   *    which allow what stays in the workspace, the call names a path outside it.
   *
   * None for DSH's own asks, and none when `ask` would have asked anyway.
   */
  private askReasonFor(request: ToolPermissionRequest): PermissionAskReason | undefined {
    if (request.hostAsk) return undefined;
    if (isDangerousShellRequest(request)) return 'dangerous';
    if (
      request.unresolvedPaths &&
      this.evaluate({ ...request, unresolvedPaths: false }) === 'allow'
    )
      return 'unresolved';
    const gear = this.gearFor(request);
    if (
      (gear === 'auto' || gear === 'accept-edits') &&
      this.namesOutsidePath(request, { parametersCount: gear === 'accept-edits' })
    )
      return 'outside_workspace';
    return undefined;
  }
  canTraverse(request: ToolPermissionRequest): boolean {
    if (
      this.config.policy &&
      policyAction(this.config.policy, 'path', [request.path], this.config.cwd) === 'ask' &&
      !skipsApproval(this.gearFor(request))
    )
      return false;
    if (pathPolicy(request.path) === 'deny' || this.evaluate(request) === 'deny') return false;
    if (pathPolicy(request.path) === 'ask' && !skipsApproval(this.gearFor(request))) return false;
    return !(this.config.scopes ?? []).some(
      (scope) =>
        scope.action !== 'allow' &&
        (scope.tools.includes('*') || scope.tools.includes(request.tool)) &&
        [request.path, ...(request.paths ?? [])].some((path) => containsPath(scope.root, path))
    );
  }
  onActivity(listener: (record: PermissionActivityRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /**
   * Tell observers, without letting them affect the gate.
   *
   * Errors are contained here rather than at each call site: a listener throwing
   * inside `authorize` would surface as a denial, which is the one outcome an
   * observer must never be able to cause.
   */
  private notify(record: PermissionActivityRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // Read-only observer; a failure here is not the gate's problem.
      }
    }
  }
  async authorize(incoming: ToolPermissionRequest, signal?: AbortSignal): Promise<void> {
    const request = this.attribute(incoming);
    let source: PermissionDecisionSource;
    try {
      source = await this.check(request, signal);
    } catch (error) {
      const review = typeof error === 'object' && error ? REVIEW_DENIALS.get(error) : undefined;
      this.notify({
        phase: 'decision',
        request,
        decision: 'deny',
        source: denialSource(error) ?? 'error',
        mode: this.mode,
        // The gear the call actually resolved under, not the session's. An
        // audit line that named the session gear for a delegate call would
        // describe a decision nobody made.
        gear: this.gearFor(request),
        ...review,
      });
      throw error;
    }
    // Claude Code resets the consecutive count on any call auto mode lets through.
    if (this.gearFor(request) === 'auto') this.reviewDenials.consecutive = 0;
    this.notify({
      phase: 'decision',
      request,
      decision: 'allow',
      source,
      mode: this.mode,
      gear: this.gearFor(request),
    });
  }
  /**
   * A refusal that remembers why: built by the host's `createDenial` (or as a
   * `PermissionDenial`) and registered so `authorize` can report the reason
   * instead of flattening every path to `error`.
   */
  private denied(source: PermissionDecisionSource, message: string): Error {
    const error =
      this.hooks.createDenial?.(source, message) ?? new PermissionDenial(source, message);
    DENIAL_SOURCES.set(error, source);
    return error;
  }
  /**
   * Take the approval gate, or queue for it.
   *
   * Only requests that really have to ask a human come through here: `evaluate`
   * has already returned `allow` or `deny` for everything else and returned
   * before this line, so a turn's parallel reads are never serialized behind a
   * card.
   *
   * A queued request emits nothing and starts no timer, which is the whole
   * point — its deadline begins when it becomes the holder. It leaves the queue
   * early only by being aborted, and then it takes the same denial an
   * already-cancelled request gets at the top of `check`.
   */
  private acquirePrompt(signal: AbortSignal): Promise<void> {
    if (!this.prompting) {
      this.prompting = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: PromptWaiter = { settled: false, wake: () => false };
      const onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(this.denied('cancelled', 'permission request cancelled'));
      };
      waiter.wake = () => {
        if (waiter.settled) return false;
        waiter.settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve();
        return true;
      };
      this.waiting.push(waiter);
      // Covers dispose and turn cancellation alike: `signal` is the combination
      // of the caller's signal and this service's own, so tearing the graph
      // down wakes every waiter instead of stranding it behind a card that will
      // never be answered.
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  /**
   * Hand the gate to whoever is next, or park it.
   *
   * Direct hand-over rather than "clear the flag and let them race": `prompting`
   * stays true across the transfer, so a request arriving in this window queues
   * behind the waiter instead of barging in front of it. The loop is for a
   * waiter that gave up between the shift and the hand-over — skipping it costs
   * a shift, handing the gate to it would deadlock every request after it.
   */
  private releasePrompt(): void {
    for (;;) {
      const next = this.waiting.shift();
      if (!next) {
        this.prompting = false;
        // The burst is over, so the next card starts a fresh "1 of n".
        this.served = 0;
        return;
      }
      if (next.wake()) return;
    }
  }
  /**
   * Decision 192: ask the review model. Allowed goes through; a failure is a
   * refusal that does not count (`unavailable` is the ordinary card instead);
   * a block is a refusal that counts, until the count reaches Claude Code's
   * limits, when this one goes to the user's card with the reason on it
   * (`card`). Throws the refusals.
   */
  private async review(
    review: NonNullable<PermissionConfig['review']>,
    request: ToolPermissionRequest,
    signal: AbortSignal,
    epoch: number
  ): Promise<{ kind: 'allowed' } | { kind: 'card'; reason?: string }> {
    const askReason = this.askReasonFor(request);
    this.notify({ phase: 'review', request, mode: this.mode, gear: this.gearFor(request) });
    let verdict: AutoReviewVerdict;
    try {
      verdict = await review(request, askReason ? { askReason } : {}, signal);
    } catch (error) {
      verdict = {
        kind: 'failed',
        failure: 'error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (signal.aborted) throw this.denied('cancelled', 'permission request cancelled');
    if (epoch !== this.epoch) throw this.denied('cancelled', 'permission request expired');
    if (verdict.kind === 'allow') return { kind: 'allowed' };
    // No rules or no reachable review model: as if review were not configured.
    if (verdict.kind === 'failed' && verdict.failure === 'unavailable') return { kind: 'card' };
    if (verdict.kind === 'failed') {
      throw this.reviewDenial('review-failed', reviewFailureMessage(verdict.failure), {
        reviewFailure: verdict.failure,
      });
    }
    const counts = this.reviewDenials;
    counts.consecutive += 1;
    counts.total += 1;
    const totalReached = counts.total >= AUTO_REVIEW_MAX_TOTAL_DENIALS;
    if (totalReached || counts.consecutive >= AUTO_REVIEW_MAX_CONSECUTIVE_DENIALS) {
      if (totalReached) this.reviewDenials = { consecutive: 0, total: 0 };
      return { kind: 'card', reason: verdict.reason };
    }
    throw this.reviewDenial('review-denied', reviewBlockMessage(verdict.reason), {
      reviewReason: verdict.reason,
    });
  }
  private reviewDenial(
    source: 'review-denied' | 'review-failed',
    message: string,
    info: { reviewReason?: string; reviewFailure?: AutoReviewFailure }
  ): Error {
    const error = this.denied(source, message);
    REVIEW_DENIALS.set(error, info);
    return error;
  }
  private async check(
    request: ToolPermissionRequest,
    signal?: AbortSignal
  ): Promise<PermissionDecisionSource> {
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    if (combined.aborted) throw this.denied('cancelled', 'permission request cancelled');
    const action = this.evaluate(request);
    if (action === 'deny')
      throw this.denied('policy-deny', `access denied: ${request.tool} ${request.path}`);
    if (action === 'allow') return this.granted(request) ? 'session-grant' : 'policy';
    const approve = this.config.approve;
    if (!approve) throw this.denied('error', 'approval UI is not connected');
    const epoch = this.epoch;
    let reviewReason: string | undefined;
    if (this.config.review && this.gearFor(request) === 'auto') {
      const reviewed = await this.review(this.config.review, request, combined, epoch);
      if (reviewed.kind === 'allowed') return 'review-allowed';
      reviewReason = reviewed.reason;
    }
    const gearAtEntry = this.gearFor(request);
    // One card at a time, from here to the `finally` at the bottom. Everything
    // that announces the gate or counts against its deadline lives inside.
    await this.acquirePrompt(combined);
    const live: LivePrompt = { request, autoAllowed: false };
    try {
      // Re-read, because the wait above can be arbitrarily long: the turn may
      // have been stopped, the graph torn down, or the permission settings
      // changed while this request sat in line. Each of those is the same
      // refusal it would have been at the top of `check`, and taking it here
      // means no card is ever raised for a request nobody can act on.
      if (combined.aborted) throw this.denied('cancelled', 'permission request cancelled');
      if (epoch !== this.epoch) throw this.denied('cancelled', 'permission request expired');
      // The gear can widen while a request stands in line (`setGear`), and this
      // one was judged before it got here. Judging it again costs one call and
      // is the difference between "the user turned the asking off" and "the
      // user turned the asking off and was then asked four more times".
      if (this.gearFor(request) !== gearAtEntry && this.evaluate(request) === 'allow')
        return this.granted(request) ? 'session-grant' : 'policy';
      const queue: PermissionQueueSlot = {
        position: ++this.served,
        depth: this.served + this.waiting.length,
      };
      // Announced before the await, so the transcript can show the gate is open
      // for as long as the dialog actually is.
      this.notify({ phase: 'prompt', request, mode: this.mode, gear: this.gearFor(request) });
      const askReason = this.askReasonFor(request);
      const controller = new AbortController();
      const approvalSignal = AbortSignal.any([combined, controller.signal]);
      const timeout = this.timers.setTimeout(
        () => controller.abort(PERMISSION_TIMEOUT_REASON),
        this.config.timeoutMs ?? PERMISSION_TIMEOUT_MS
      );
      let abort: (() => void) | undefined;
      this.live = live;
      try {
        const cancelled = new Promise<'deny'>((resolve) => {
          abort = () => resolve('deny');
          approvalSignal.addEventListener('abort', abort, { once: true });
        });
        const context: PermissionAskContext = {
          ...(askReason ? { askReason } : {}),
          ...(reviewReason ? { reviewReason } : {}),
        };
        const decision = await Promise.race([
          Object.keys(context).length > 0
            ? approve(request, approvalSignal, queue, context)
            : approve(request, approvalSignal, queue),
          cancelled,
        ]);
        if (approvalSignal.aborted || epoch !== this.epoch)
          throw approvalSignal.reason === PERMISSION_TIMEOUT_REASON
            ? this.denied('timed-out', 'nobody answered the permission request in time')
            : this.denied('cancelled', 'permission request expired');
        // Retracted by a widened gear, so the audit line must not read as a
        // decision a person made: nobody answered this card, it stopped being
        // a question. Checked after the abort above, which still wins — the
        // same order a user's own answer races a stop in.
        if (live.autoAllowed) return 'policy';
        if (decision === 'deny') throw this.denied('user-denied', 'permission denied');
        if (decision === 'allow-session') {
          // A host's own ask grants its one call (`hostAsk`): nothing to remember.
          if (request.hostAsk) return 'allow-once';
          this.remember(request);
        }
        return decision;
      } finally {
        if (this.live === live) this.live = null;
        this.timers.clearTimeout(timeout);
        if (abort) approvalSignal.removeEventListener('abort', abort);
        controller.abort();
      }
    } finally {
      // Every exit releases: a decision, a denial, a cancel, an epoch bump, or
      // an approver that threw. Anything that skipped this would stop the queue
      // forever, which is worse than any single request failing.
      this.releasePrompt();
    }
  }
}
/**
 * A device a command writes to or reads from without touching a file
 * (`2>/dev/null`), outside every workspace and never worth a card. Git Bash on
 * Windows spells it `\dev\null`, which resolves to `C:\dev\null`.
 */
const DEVICE_PATH =
  /^(?:[A-Za-z]:)?[\\/]dev[\\/](?:null|zero|full|random|urandom|tty|stdin|stdout|stderr|fd[\\/]\d+)$/;
function isDevicePath(path: string): boolean {
  return DEVICE_PATH.test(path);
}
/**
 * A shell command on the dangerous list (`dangerousCommands.ts`): any delete,
 * a force push and the git commands that throw work away, disk formatting.
 * Decision 191 §6 (user, 2026-10-17): it asks under every gear but `bypass`,
 * every time, and its card offers no "for session". DSH's own asks
 * (`hostAsk`) are judged as before.
 */
export function isDangerousShellRequest(
  request: Pick<ToolPermissionRequest, 'tool' | 'command' | 'commands' | 'hostAsk'>
): boolean {
  if (!isShellTool(request.tool) || request.hostAsk) return false;
  const segments = request.commands?.length
    ? request.commands
    : request.command
      ? [request.command]
      : [];
  return segments.some(isDangerousShellCommand);
}
/**
 * Gears that answer an `ask` on the user's behalf rather than raising a card.
 *
 * Wherever `auto` waives a check, `bypass` waives it too — a traversal the
 * looser gear refused would be a card the user was promised they would never
 * see. Denies are not routed through here; they are decided before any gear.
 */
function skipsApproval(gear: PermissionGear): boolean {
  return gear === 'auto' || gear === 'bypass';
}
/**
 * The policy surface a tool's own rules are written under, when the request
 * names none (design shard 03 §2): both shells answer to `bash` — a user's
 * `"bash": {"git push*": "ask"}` holds on Windows' `pwsh` too, and the bundled
 * table has no `pwsh` surface to fall back to (dsh-rebase P1-6d).
 */
function defaultPolicySurface(tool: string): string {
  return isShellTool(tool) ? 'bash' : tool;
}
/**
 * The default refusal: code `tool_denied`, plus the reason. Hosts with their
 * own error type pass `createDenial` instead.
 */
export class PermissionDenial extends PermissionError {
  readonly source: PermissionDecisionSource;
  constructor(source: PermissionDecisionSource, message: string) {
    super('tool_denied', message);
    this.source = source;
  }
}
/** Every refusal any gate built, with its reason. Weak, so errors are still collected. */
const DENIAL_SOURCES = new WeakMap<object, PermissionDecisionSource>();
/** What a review refusal adds to its audit record. */
const REVIEW_DENIALS = new WeakMap<
  object,
  { reviewReason?: string; reviewFailure?: AutoReviewFailure }
>();
/** What the model reads when the review blocked its call (decision 192 §3.3). */
function reviewBlockMessage(reason: string): string {
  return `The automatic safety review did not allow this call${reason ? `: ${reason}` : '.'} It did not run. Do not retry it in another form. Continue with work that does not depend on it; if it is needed, ask the user to authorize it explicitly.`;
}
/** What the model reads when the review could not decide; Claude Code's guidance. */
function reviewFailureMessage(failure: AutoReviewFailure): string {
  if (failure === 'too_long') {
    return 'This call was not reviewed and did not run: the conversation is too long for the automatic safety review. This is not a judgment that the action is unsafe. Continue with other work, or ask the user to compact the conversation (/compact) and then issue it again.';
  }
  return `The automatic safety review could not be completed (${failure}), so this call did not run. This is not a judgment that the action is unsafe. You may issue the same call again as-is later; do not rework it to get around the review.`;
}
/**
 * Why a gate refused, when `error` is one of its refusals; `undefined` for
 * anything else (an approver that threw, a host fault). Works whichever
 * `createDenial` built the error.
 */
export function denialSource(error: unknown): PermissionDecisionSource | undefined {
  return typeof error === 'object' && error !== null ? DENIAL_SOURCES.get(error) : undefined;
}
