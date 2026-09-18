import { homedir } from 'node:os';
import { isAbsolute, posix, relative, sep, win32 } from 'node:path';
import { type Context, Service } from 'cordis';
import { AICLIENT_DEFAULT_PERMISSION_POLICY } from '../../../agent-host/permissionPolicy.mjs';
import {
  type LegacyPermissionTier,
  type PermissionGear,
  type RuntimeMode,
  type RuntimePermissionSettings,
  resolveRuntimePermission,
} from '../../../shared/types/runtimePermission.ts';
import { HOST_IO_SERVICE } from '../../contracts.ts';
import { RuntimeHostError } from '../../host/errors.ts';
import { policyAction, type RuntimePermissionPolicy } from './policy.ts';
import { normalizeWindowsPathForm } from './windows-paths.ts';

export const PERMISSIONS_SERVICE = 'runtimePermissions';
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
  exploration?: boolean;
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
export interface PermissionConfig {
  cwd: string;
  mode?: RuntimeMode;
  gear?: PermissionGear;
  tier?: LegacyPermissionTier;
  allowedTools?: readonly string[];
  scopes?: readonly PermissionScope[];
  policy?: RuntimePermissionPolicy;
  projectTrusted?: boolean;
  approve?: (
    request: ToolPermissionRequest,
    signal: AbortSignal,
    /**
     * Optional third argument so every existing approver stays assignable:
     * a two-parameter function is still a valid `approve`, it simply cannot
     * tell the user there is a line behind this card.
     */
    queue?: PermissionQueueSlot
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
  | 'error';

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
  | {
      phase: 'decision';
      request: ToolPermissionRequest;
      decision: 'allow' | 'deny';
      source: PermissionDecisionSource;
      mode: RuntimeMode;
      gear: PermissionGear;
    };

export interface RuntimePermissionsService {
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
  readonly policy: RuntimePermissionPolicy | undefined;
  canTraverse(request: ToolPermissionRequest): boolean;
}

declare module 'cordis' {
  interface Context {
    runtimePermissions: RuntimePermissionsService;
  }
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

export class PermissionsPlugin extends Service implements RuntimePermissionsService {
  static inject = [HOST_IO_SERVICE];
  private readonly config: PermissionConfig;
  private readonly grants = new Set<string>();
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

  constructor(ctx: Context, config: PermissionConfig) {
    super(ctx, PERMISSIONS_SERVICE);
    this.config = config;
    this.settings = resolveRuntimePermission(config);
    ctx.effect(() => () => {
      this.controller.abort();
      this.grants.clear();
      this.scopedGears.clear();
      this.listeners.clear();
    });
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
  configure(settings: Partial<RuntimePermissionSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.epoch++;
    this.grants.clear();
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
    // screen". A bash call with an operand the analysis could not read still
    // asks under `auto`, and a delegate running on its own scoped gear is not
    // affected by the session's at all — both fall out of `evaluate` for free.
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
  evaluate(request: ToolPermissionRequest): PermissionAction {
    if (!this.isToolAllowed(request.tool)) return 'deny';
    const inspectedPaths = [request.path, ...(request.paths ?? [])];
    const policy = this.config.policy;
    const decisions = policy
      ? [
          ...inspectedPaths.map((path) => policyAction(policy, 'path', [path], this.config.cwd)),
          ...(request.tool === 'bash'
            ? [request.command ?? '', ...(request.commands ?? [])]
            : [request.policyValue ?? request.path]
          ).map((value) =>
            policyAction(policy, request.policySurface ?? request.tool, [value], this.config.cwd)
          ),
          ...inspectedPaths
            .filter((path) => !containsPath(this.config.cwd, path))
            .map((path) => policyAction(policy, 'external_directory', [path], this.config.cwd)),
        ]
      : [];
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
      // does not keep.
      (!['read', 'glob', 'grep', 'bash', 'skill'].includes(request.tool) ||
        (request.tool === 'bash' && !request.exploration))
    )
      return 'deny';
    const matches = (this.config.scopes ?? []).filter(
      (scope) =>
        (scope.tools.includes('*') || scope.tools.includes(request.tool)) &&
        [request.path, ...(request.paths ?? [])].some((path) => containsPath(scope.root, path))
    );
    if (matches.some((scope) => scope.action === 'deny')) return 'deny';
    const gear = this.gearFor(request);
    // `bypass` is the one gear that answers the unresolved-operand case too.
    // It sits AFTER every deny above — policy, bundled secrets, deny scopes,
    // plan mode, the tool whitelist — so it can only turn an `ask` into an
    // `allow`; it never buys authority a denied call did not have.
    if (gear === 'bypass') return 'allow';
    // An operand the shell analysis could not read has passed no path, scope or
    // deny judgement at all, so no gear may wave it through: `auto` has to fall
    // to the `unresolvedPaths` check below. A session grant for this exact
    // command still applies, which is why the check stays after `grants`.
    if (gear === 'auto' && !request.unresolvedPaths) return 'allow';
    if (matches.some((scope) => scope.action === 'ask'))
      return this.grants.has(grantKey(request)) ? 'allow' : 'ask';
    if (
      inspectedPaths.every((path) =>
        matches.some((scope) => scope.action === 'allow' && containsPath(scope.root, path))
      )
    )
      return 'allow';
    if (this.grants.has(grantKey(request))) return 'allow';
    if (request.unresolvedPaths) return 'ask';
    // A trusted path skips straight past the workspace-boundary checks below:
    // every deny above (policy, bundled secrets, scope) has already had its
    // say, and what remains is only "this is outside cwd", which does not
    // apply to a path the model never supplied.
    if (
      !request.trustedPath &&
      (pathAction === 'ask' ||
        !containsPath(this.config.cwd, request.path) ||
        (request.paths ?? []).some(
          (path) => !containsPath(this.config.cwd, path) || pathPolicy(path) === 'ask'
        ))
    )
      return 'ask';
    if (
      !request.trustedPath &&
      policy &&
      inspectedPaths.some((path) => policyAction(policy, 'path', [path], this.config.cwd) === 'ask')
    )
      return 'ask';
    if (['read', 'grep', 'glob'].includes(request.tool))
      return decisions.includes('ask') ? 'ask' : 'allow';
    if (gear === 'accept-edits' && ['write', 'edit', 'bash'].includes(request.tool)) return 'allow';
    return request.trustedPath ? 'allow' : 'ask';
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
      this.notify({
        phase: 'decision',
        request,
        decision: 'deny',
        source: error instanceof PermissionDenial ? error.source : 'error',
        mode: this.mode,
        // The gear the call actually resolved under, not the session's. An
        // audit line that named the session gear for a delegate call would
        // describe a decision nobody made.
        gear: this.gearFor(request),
      });
      throw error;
    }
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
        reject(denied('cancelled', 'permission request cancelled'));
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
  private async check(
    request: ToolPermissionRequest,
    signal?: AbortSignal
  ): Promise<PermissionDecisionSource> {
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    if (combined.aborted) throw denied('cancelled', 'permission request cancelled');
    const action = this.evaluate(request);
    if (action === 'deny')
      throw denied('policy-deny', `access denied: ${request.tool} ${request.path}`);
    if (action === 'allow') return this.grants.has(grantKey(request)) ? 'session-grant' : 'policy';
    const approve = this.config.approve;
    if (!approve) throw denied('error', 'approval UI is not connected');
    const epoch = this.epoch;
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
      if (combined.aborted) throw denied('cancelled', 'permission request cancelled');
      if (epoch !== this.epoch) throw denied('cancelled', 'permission request expired');
      const queue: PermissionQueueSlot = {
        position: ++this.served,
        depth: this.served + this.waiting.length,
      };
      // Announced before the await, so the transcript can show the gate is open
      // for as long as the dialog actually is.
      this.notify({ phase: 'prompt', request, mode: this.mode, gear: this.gearFor(request) });
      const controller = new AbortController();
      const approvalSignal = AbortSignal.any([combined, controller.signal]);
      const timeout = setTimeout(
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
        const decision = await Promise.race([approve(request, approvalSignal, queue), cancelled]);
        if (approvalSignal.aborted || epoch !== this.epoch)
          throw approvalSignal.reason === PERMISSION_TIMEOUT_REASON
            ? denied('timed-out', 'nobody answered the permission request in time')
            : denied('cancelled', 'permission request expired');
        // Retracted by a widened gear, so the audit line must not read as a
        // decision a person made: nobody answered this card, it stopped being
        // a question. Checked after the abort above, which still wins — the
        // same order a user's own answer races a stop in.
        if (live.autoAllowed) return 'policy';
        if (decision === 'deny') throw denied('user-denied', 'permission denied');
        if (decision === 'allow-session') this.grants.add(grantKey(request));
        return decision;
      } finally {
        if (this.live === live) this.live = null;
        clearTimeout(timeout);
        if (abort) approvalSignal.removeEventListener('abort', abort);
        controller.abort();
      }
    } finally {
      // Every exit releases: a decision, a denial, a cancel, an epoch bump, or
      // an approver that threw. Anything that skipped this would stop the queue
      // forever, which is worse than any single request failing.
      // Every exit releases: a decision, a denial, a cancel, an epoch bump, or
      // an approver that threw. Anything that skipped this would stop the queue
      // forever, which is worse than any single request failing.
      this.releasePrompt();
    }
  }
}
export function containsPath(root: string, path: string): boolean {
  const delta = relative(root, path);
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`));
}
function grantKey(request: ToolPermissionRequest): string {
  return JSON.stringify([request.tool, request.path, request.command ?? null, request.paths ?? []]);
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
 * A refusal that remembers why.
 *
 * Still a `tool_denied` `RuntimeHostError`, so every existing `errorCode`
 * check keeps working; the extra field exists only so `authorize` can report
 * the reason instead of flattening every path to `error`.
 */
class PermissionDenial extends RuntimeHostError {
  readonly source: PermissionDecisionSource;
  constructor(source: PermissionDecisionSource, message: string) {
    super('tool_denied', message);
    this.source = source;
  }
}
function denied(source: PermissionDecisionSource, message: string): PermissionDenial {
  return new PermissionDenial(source, message);
}

/**
 * Where the path rules are evaluated. Injectable so the Windows spelling rules
 * can be exercised on a Linux box: on a real host both fields already describe
 * the machine the runtime runs on (windows-01).
 */
export interface PathPolicyEnvironment {
  platform?: NodeJS.Platform;
  home?: string;
}

export function pathPolicy(
  path: string,
  environment: PathPolicyEnvironment = {}
): PermissionAction {
  const platform = environment.platform ?? process.platform;
  const windows = platform === 'win32';
  // The rules are written with the target platform's separators and home, so
  // the expansion has to use that platform's path algebra, not the build box's.
  const paths = windows ? win32 : posix;
  const home = environment.home ?? homedir();
  let action: PermissionAction = 'allow';
  // windows-01 — fold `/c/...`, `/cygdrive/c/...` and `\\?\C:\...` onto the
  // native spelling first, or a deny that names a directory is decided on a
  // string the rule cannot match.
  const normalized = normalizeWindowsPathForm(path, platform);
  const candidate = normalized.replaceAll('\\', '/');
  for (const [pattern, value] of Object.entries(
    AICLIENT_DEFAULT_PERMISSION_POLICY.permission.path
  )) {
    if (value !== 'allow' && value !== 'ask' && value !== 'deny') continue;
    const expanded = pattern.startsWith('~/')
      ? paths.resolve(home, pattern.slice(2)).replaceAll('\\', '/')
      : pattern;
    const expression = expanded
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    const regex = new RegExp(`^${expression}$`, windows ? 'i' : '');
    if (
      regex.test(candidate) ||
      (!expanded.includes('/') && regex.test(paths.basename(normalized)))
    )
      action = value;
  }
  return action;
}
