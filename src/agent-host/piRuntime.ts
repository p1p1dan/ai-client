/**
 * Pi Runtime Adapter — @earendil-works/pi-coding-agent SDK.
 * Emits AiClient Runtime Events; no Electron deps.
 *
 * ## One runtime per session, not one per process
 *
 * This product is a WORKTREE manager: two chats are routinely two different
 * checkouts of the same repo. A single shared pi session handle would run
 * `/repo-b`'s tools inside `/repo-a`, let the permission plugin judge paths
 * against the wrong root, and cross the two chats' events, approvals and aborts.
 * So everything that can belong to one session does: the pi runtime handle, the
 * event subscription, the AbortController, the streaming projection state, and
 * the Extension UI bridge all live in a per-session record ({@link PiSessionState})
 * keyed by our own `sessionId`.
 *
 * ## Tools do not run without a permission gate
 *
 * `ensureState` REFUSES to build a runtime whose tool calls would be ungated —
 * see {@link PermissionGateUnavailableError}. That is a deliberate trade: a
 * session that will not start is visible and diagnosable, whereas a session that
 * starts with no gate looks exactly like a session where nothing needed
 * approval.
 */

import { PI_PROJECT_TRUST_ENV, parsePiModelRef } from '../shared/piModelConfig.ts';
import type { SessionAttachment, SessionEffortLevel } from '../shared/types/agentHost.ts';
import { PI_AGENT } from '../shared/types/agentWire.ts';
import type {
  ExtensionUiCancelReason,
  ExtensionUiResponse,
  RuntimeEventDraft,
} from '../shared/types/runtimeEvents.ts';
import type { EmitFn, LogFn } from './eventNormalizer.ts';
import {
  createPortableExtensionUiBridge,
  type PortableExtensionUiBridge,
} from './extensionUiBridge.ts';
import { createPermissionActivityObserver } from './permissionActivity.ts';
import {
  decidePermissionPlugin,
  type PermissionPluginDecision,
  verifyPermissionExtensionLoaded,
} from './permissionPlugin.ts';
import type { HostSession, SessionRegistry } from './sessionRegistry.ts';

// ─── pi SDK type projections (lazy-imported, ESM-only) ───

interface PiSdkModule {
  createAgentSessionServices: (opts: Record<string, unknown>) => Promise<PiServices>;
  createAgentSessionFromServices: (
    opts: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  createAgentSessionRuntime: (
    factory: PiRuntimeFactory,
    opts: Record<string, unknown>
  ) => Promise<PiRuntimeHandle>;
  getAgentDir: () => string;
  SessionManager: {
    create: (cwd: string, sessionDir: string) => PiSessionMgr;
    open: (sessionFile: string, sessionDir: string, cwd: string) => PiSessionMgr;
    continueRecent: (cwd: string, sessionDir: string) => PiSessionMgr;
    inMemory: (cwd: string) => PiSessionMgr;
  };
  SettingsManager: {
    create: (cwd: string, agentDir: string, opts: { projectTrusted: boolean }) => PiSettingsManager;
  };
}

/**
 * The slice of pi's `SettingsManager` this Host reads: the user's configured
 * extension packages, so the bundled permission plugin is not loaded twice
 * (T08-a). Both getters are optional — an SDK build without them must degrade
 * to "we cannot tell", never crash the Host.
 */
interface PiSettingsManager {
  getGlobalSettings?: () => { packages?: unknown };
  getProjectSettings?: () => { packages?: unknown };
  [key: string]: unknown;
}

interface PiModel {
  provider: string;
  id: string;
  name?: string;
}

/** pi's `LoadExtensionsResult`, narrowed to what the permission check reads. */
interface PiLoadedExtensions {
  extensions?: Array<{ path?: unknown; resolvedPath?: unknown }>;
  errors?: Array<{ path?: unknown; error?: unknown }>;
}

interface PiServices {
  modelRuntime: { getModel: (provider: string, id: string) => PiModel | undefined };
  /** Optional: an SDK build without it degrades to "we cannot verify the load". */
  resourceLoader?: { getExtensions?: () => PiLoadedExtensions };
  diagnostics?: unknown[];
  cwd: string;
  agentDir: string;
  [key: string]: unknown;
}

interface PiSessionMgr {
  [key: string]: unknown;
}

type PiRuntimeFactory = (ctx: {
  cwd: string;
  sessionManager: PiSessionMgr;
  sessionStartEvent?: unknown;
}) => Promise<Record<string, unknown> & { services: PiServices; diagnostics: unknown[] }>;

/**
 * T11 — the SDK's Extension UI injection point (`ExtensionBindings`).
 *
 * `mode: 'rpc'` means "not a TUI", NOT "run the SDK in a subprocess". We hold
 * the session object in-process (`createAgentSessionRuntime` below); the word is
 * the SDK's for "the UI lives somewhere that answers over a wire", which for us
 * is the renderer at the far end of the MessagePort.
 *
 * Optional because it is projected off a lazily-imported ESM module: an SDK
 * build without it is a build whose extensions cannot ask the user anything,
 * which for a permission plugin means it cannot gate — see `bindExtensionUi`.
 */
interface PiExtensionBindings {
  uiContext?: unknown;
  mode?: 'rpc' | 'tui';
  onError?: (error: unknown) => void;
}

/** pi's `ImageContent` (`@earendil-works/pi-ai`) — the only attachment slot `prompt()` has. */
interface PiImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

interface PiPromptOptions {
  images?: PiImageContent[];
}

/** pi's `ThinkingLevel`; our `SessionEffortLevel` is a subset of it. */
type PiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface PiSession {
  prompt: (text: string, opts?: PiPromptOptions) => Promise<void>;
  subscribe: (callback: (event: PiAgentEvent) => void) => () => void;
  bindExtensions?: (bindings: PiExtensionBindings) => Promise<void>;
  abort: () => Promise<void>;
  abortCompaction?: () => void;
  abortBranchSummary?: () => void;
  abortBash?: () => void;
  clearQueue?: () => void;
  sessionId: string;
  sessionFile?: string;
  model?: PiModel;
  setModel: (model: PiModel, options?: { persist?: boolean }) => Promise<void>;
  /** Optional: absent on an SDK build that predates per-session thinking levels. */
  setThinkingLevel?: (level: PiThinkingLevel, options?: { persist?: boolean }) => void;
  [key: string]: unknown;
}

interface PiRuntimeHandle {
  session: PiSession;
  services: PiServices;
  setBeforeSessionInvalidate?: (fn: () => void) => void;
  [key: string]: unknown;
}

export interface PiAgentEvent {
  type: string;
  [key: string]: unknown;
}

// ─── errors ───

/**
 * No permission gate could be established for this session, so no session was
 * created.
 *
 * Thrown rather than reported: every caller of `ensureState` is on the path to
 * running tool calls, and there is no correct way to continue. `code` travels
 * onto the `host.error` the user sees, so "the plugin is missing" and "the
 * plugin loaded but could not be bound to a UI" stay distinguishable.
 */
export class PermissionGateUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PermissionGateUnavailableError';
    this.code = code;
  }
}

// ─── PiAgentRuntime class ───

export interface PiAgentRuntimeOptions {
  emit: EmitFn;
  log?: LogFn;
  registry: SessionRegistry;
  /** Test seam; production lazy-imports the ESM-only Pi SDK. */
  loadSdk?: () => Promise<unknown>;
  /**
   * Test seam over the gate decision.
   *
   * Production reads the bundle beside the Host entry, which a unit test cannot
   * take away — and "there is no permission plugin" is exactly the state that
   * most needs a test. Injecting the decision is the only way to write one
   * without deleting files out of the developer's checkout.
   */
  decidePermissionGate?: (packages: unknown[]) => PermissionPluginDecision;
}

interface TurnState {
  assistantMessageId: string | null;
  textBlockId: string | null;
  thinkingBlockId: string | null;
  textSnapshot: string;
  thinkingSnapshot: string;
  thinkingStarted: boolean;
  /**
   * T12-c: `thinking.completed` has been emitted for the open thinking block.
   *
   * pi has no "thinking ended" event — thinking is just content blocks that
   * stop growing — so the Host has to decide the boundary and say so. Without
   * it `reduceTurnTiming` only ever sees `thinking.started`, `durationMs`
   * stays null, and every thought on the pi backend renders as a bare
   * `Thought` with no duration.
   */
  thinkingCompleted: boolean;
  /**
   * pi ended the assistant message this container was opened for, so the next
   * PROSE (or thinking) belongs to a new one. Tools deliberately keep using the
   * open container — see `openProseMessage`.
   */
  proseClosed: boolean;
}

function newTurnState(): TurnState {
  return {
    assistantMessageId: null,
    textBlockId: null,
    thinkingBlockId: null,
    textSnapshot: '',
    thinkingSnapshot: '',
    thinkingStarted: false,
    thinkingCompleted: false,
    proseClosed: false,
  };
}

/**
 * Everything one AiClient session owns inside this Host.
 *
 * Created before the pi runtime exists (the bridge must be answerable while
 * extensions bind, and `stop()` must be able to abort a send that is still
 * building its handle), so `handle` is nullable for exactly that window.
 */
interface PiSessionState {
  readonly sessionId: string;
  /** The checkout this session's tools run in. A change means a NEW runtime. */
  readonly workspacePath: string;
  readonly extensionUi: PortableExtensionUiBridge;
  handle: PiRuntimeHandle | null;
  /** In-flight `createAgentSessionRuntime`, so two sends never build two runtimes. */
  building: Promise<PiRuntimeHandle> | null;
  unsubscribe: (() => void) | null;
  abortController: AbortController | null;
  turn: TurnState;
  /**
   * Monotonic suffix for assistant message ids, session-scoped rather than
   * turn-scoped so ids stay unique across `agent_start` boundaries too.
   *
   * `Date.now()` alone is not enough: pi closes one assistant message and opens
   * the next within the same millisecond routinely (prose ends, a tool starts),
   * and two messages sharing an id silently collapse back into one — which is
   * the exact defect `closeAssistantMessage` exists to fix, reintroduced one
   * layer down and invisible to any test that does not run a real clock.
   */
  assistantSeq: number;
}

export class PiAgentRuntime {
  private sdk: PiSdkModule | null = null;
  private readonly states = new Map<string, PiSessionState>();
  private readonly log: LogFn;
  private readonly opts: PiAgentRuntimeOptions;

  constructor(opts: PiAgentRuntimeOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((...args) => console.error('[pi-runtime]', ...args));
  }

  /**
   * The one typed door to the wire.
   *
   * `EmitFn` takes an open record, which is how `isError` and `errorMessage`
   * once reached the renderer under names no consumer reads. Everything this
   * class emits goes through here instead, so a payload that is not a
   * `RuntimeEvent` fails to compile.
   */
  private emit(event: RuntimeEventDraft): void {
    this.opts.emit(event);
  }

  /**
   * Route one renderer answer to its parked dialog. `false` = it settled
   * nothing: wrong bridge instance, already answered, or already timed out.
   * All three are ordinary races, so the caller reports rather than throws.
   *
   * The `runtimeId` search is what makes this session-safe: every session has
   * its own bridge, and an answer can only settle a dialog on the bridge that
   * asked. An answer aimed at a session that has since been rebuilt matches
   * nothing.
   */
  respondExtensionUi(response: ExtensionUiResponse): boolean {
    for (const state of this.states.values()) {
      if (state.extensionUi.runtimeId === response.runtimeId) {
        return state.extensionUi.respond(response);
      }
    }
    return false;
  }

  /**
   * May a repository's own `.pi/` scope contribute to this session?
   *
   * T08-c (D-Q9 decision 4). The managed route answers `'0'`: we promise that
   * build works and answer for what it permits, so a repo the user cloned must
   * not be able to ship a `.pi/extensions/pi-permission-system/config.json`
   * that turns the gate off. The local route answers `'1'`: that machine is
   * theirs, and what their own checkouts configure is their call.
   *
   * Defaults to trusted when the key is ABSENT, which is only an old Main
   * build — the same posture that shipped before this decision, so a version
   * skew changes nothing rather than silently tightening. Any value other than
   * the two words is read as `'0'`: a garbled env var must fail toward the
   * safer side, not toward the historical one.
   */
  private projectTrusted(): boolean {
    const raw = process.env[PI_PROJECT_TRUST_ENV];
    if (raw === undefined) return true;
    return raw.trim() === '1';
  }

  private async ensureSdk(): Promise<PiSdkModule> {
    if (this.sdk) return this.sdk;
    const mod = this.opts.loadSdk
      ? await this.opts.loadSdk()
      : await import('@earendil-works/pi-coding-agent');
    this.sdk = mod as PiSdkModule;
    return this.sdk;
  }

  /**
   * The per-session record, created on demand.
   *
   * A session whose `workspacePath` changed gets a fresh record and a fresh
   * runtime: the old one is bound to the old checkout, and reusing it is the
   * cross-worktree bug this class is organized to prevent.
   */
  private getOrCreateState(session: HostSession): PiSessionState {
    const existing = this.states.get(session.sessionId);
    if (existing) {
      if (existing.workspacePath === session.workspacePath) return existing;
      this.log(
        `session ${session.sessionId} moved from ${existing.workspacePath} to ${session.workspacePath}; rebuilding its runtime`
      );
      this.teardownState(existing, 'session_replaced');
      this.states.delete(session.sessionId);
    }
    const sessionId = session.sessionId;
    const state: PiSessionState = {
      sessionId,
      workspacePath: session.workspacePath,
      // Built before the handle: extensions emit UI calls during bind, i.e.
      // before any pi session object exists to hang a bridge off.
      extensionUi: createPortableExtensionUiBridge({
        onRequest: (request) => {
          this.emit({
            type: 'extensionUi.request',
            sessionId,
            payload: {
              runtimeId: request.runtimeId,
              uiRequestId: request.uiRequestId,
              method: request.method,
              args: request.args,
              ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
            },
          });
        },
        onCancel: (cancel) => {
          this.emit({
            type: 'extensionUi.cancelled',
            sessionId,
            payload: {
              runtimeId: cancel.runtimeId,
              uiRequestIds: cancel.uiRequestIds,
              reason: cancel.reason,
            },
          });
        },
      }),
      handle: null,
      building: null,
      unsubscribe: null,
      abortController: null,
      turn: newTurnState(),
      assistantSeq: 0,
    };
    this.states.set(sessionId, state);
    return state;
  }

  /**
   * Build (or reuse) this session's pi runtime.
   *
   * Throws {@link PermissionGateUnavailableError} rather than returning a
   * runtime whose tools would run unattended.
   */
  private async ensureHandle(state: PiSessionState): Promise<PiRuntimeHandle> {
    if (state.handle) return state.handle;
    if (state.building) return state.building;
    const building = this.buildHandle(state);
    state.building = building;
    try {
      const handle = await building;
      state.handle = handle;
      return handle;
    } finally {
      state.building = null;
    }
  }

  private async buildHandle(state: PiSessionState): Promise<PiRuntimeHandle> {
    const sdk = await this.ensureSdk();
    const agentDir = sdk.getAgentDir();
    const sessionDir = `${agentDir}/sessions`;
    const sessionManager = sdk.SessionManager.create(state.workspacePath, sessionDir);

    // Assigned by the factory below, read after the runtime resolves. Belt and
    // braces: the factory throws when the gate is unavailable, and this second
    // read catches an SDK that swallowed the throw.
    let gate: PermissionPluginDecision | undefined;
    let gateVerification: { ok: boolean; detail?: string } | undefined;

    const createRuntime: PiRuntimeFactory = async ({ cwd, sessionManager: sm }) => {
      const settingsManager = sdk.SettingsManager.create(cwd, agentDir, {
        projectTrusted: this.projectTrusted(),
      });
      // T08-a: load the bundled permission plugin unless the user's own pi
      // config is CONFIRMED to load it — two copies would prompt twice per tool
      // call, and an unconfirmed skip would leave no gate at all.
      const configured = [
        ...readConfiguredPackages(settingsManager.getGlobalSettings?.()),
        ...readConfiguredPackages(settingsManager.getProjectSettings?.()),
      ];
      const decision = (this.opts.decidePermissionGate ?? decidePermissionPlugin)(configured);
      gate = decision;
      if (!decision.gated) {
        throw new PermissionGateUnavailableError(
          'permission_plugin_missing',
          `Tool approval is unavailable: ${decision.detail ?? 'the permission system could not be loaded'}`
        );
      }
      this.log(`permission plugin: ${decision.reason}`);
      // T08-b: watch the plugin's broadcasts so the timeline records what was
      // gated — including the `policy_allow` decisions that never raise a
      // dialog, which are otherwise indistinguishable from no gate at all.
      const activityObserver = createPermissionActivityObserver({
        log: this.log,
        onActivity: (payload) => {
          this.emit({ type: 'permission.activity', sessionId: state.sessionId, payload });
        },
      });

      const services = await sdk.createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        resourceLoaderOptions: {
          ...(decision.additionalExtensionPaths.length > 0
            ? { additionalExtensionPaths: decision.additionalExtensionPaths }
            : {}),
          extensionFactories: [
            { name: 'aiclient-permission-activity', factory: activityObserver, hidden: true },
          ],
        },
      });
      // The extension list is the only place a load FAILURE shows up: pi
      // collects the error and keeps going, so a plugin that threw on import
      // looks identical to one that is quietly allowing everything.
      gateVerification = verifyPermissionExtensionLoaded(
        services.resourceLoader?.getExtensions?.(),
        decision.additionalExtensionPaths
      );
      if (!gateVerification.ok) {
        throw new PermissionGateUnavailableError(
          'permission_plugin_load_failed',
          `Tool approval is unavailable: ${gateVerification.detail ?? 'the permission extension did not load'}`
        );
      }
      return {
        ...(await sdk.createAgentSessionFromServices({ services, sessionManager: sm })),
        services,
        diagnostics: services.diagnostics ?? [],
      };
    };

    const handle = await sdk.createAgentSessionRuntime(createRuntime, {
      cwd: state.workspacePath,
      agentDir,
      sessionManager,
    });

    if (!gate?.gated) {
      throw new PermissionGateUnavailableError(
        'permission_plugin_missing',
        `Tool approval is unavailable: ${gate?.detail ?? 'the permission system could not be loaded'}`
      );
    }
    if (gateVerification && !gateVerification.ok) {
      throw new PermissionGateUnavailableError(
        'permission_plugin_load_failed',
        `Tool approval is unavailable: ${gateVerification.detail ?? 'the permission extension did not load'}`
      );
    }

    // The session object is replaced on reload / fork / switch, and the
    // extensions bound to the OLD one are gone with it. Draining here — before
    // the swap, which is what this SDK hook is for — is what stops an extension
    // from awaiting a dialog whose owner no longer exists.
    handle.setBeforeSessionInvalidate?.(() => {
      state.extensionUi.reload();
    });

    await this.bindExtensionUi(state, handle);
    return handle;
  }

  /**
   * Hand the portable UI context to the SDK.
   *
   * FAIL-CLOSED, and this is the change that makes the gate real: the permission
   * plugin asks through `ui.select`, so a session with no extension UI is a
   * session whose gate cannot ask anything. Starting it anyway would leave the
   * plugin to fall back on its own, in a mode nobody here has measured, while
   * the user sees a chat that looks completely normal.
   */
  private async bindExtensionUi(state: PiSessionState, handle: PiRuntimeHandle): Promise<void> {
    if (typeof handle.session.bindExtensions !== 'function') {
      throw new PermissionGateUnavailableError(
        'extension_bind_unsupported',
        'Tool approval is unavailable: this pi SDK build cannot bind an approval UI (no bindExtensions)'
      );
    }
    try {
      await handle.session.bindExtensions({
        uiContext: state.extensionUi.uiContext,
        mode: 'rpc',
        onError: (error) => {
          const detail = error instanceof Error ? error.message : String(error);
          this.log(`extension error in session ${state.sessionId}: ${detail}`);
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PermissionGateUnavailableError(
        'extension_bind_failed',
        `Tool approval is unavailable: binding the approval UI failed — ${message}`
      );
    }
  }

  private bindEvents(state: PiSessionState, requestId?: string): void {
    const session = state.handle?.session;
    if (!session) return;
    state.unsubscribe?.();
    state.unsubscribe = session.subscribe((event: PiAgentEvent) => {
      this.projectEvent(state, event, requestId);
    });
  }

  private async applySelectedModel(
    handle: PiRuntimeHandle,
    session: HostSession,
    requestedModel: string | undefined
  ): Promise<void> {
    const selected = requestedModel?.trim() || session.model?.trim();
    if (!selected) return;
    const ref = parsePiModelRef(selected);
    if (!ref) {
      throw new Error(`Invalid Pi model reference: ${selected}. Expected provider/model`);
    }
    const model = handle.services.modelRuntime.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error(`Pi model not found: ${selected}`);
    if (
      handle.session.model?.provider !== ref.provider ||
      handle.session.model?.id !== ref.modelId
    ) {
      await handle.session.setModel(model, { persist: false });
    }
    session.model = selected;
  }

  /**
   * Apply this turn's reasoning effort.
   *
   * Our five effort words are a subset of pi's `ThinkingLevel`, so the mapping
   * is the identity — but the CALL is not optional: `effort` was accepted on the
   * wire and never applied, which is a request the user made and the Host
   * silently ignored. An SDK build with no `setThinkingLevel` says so instead.
   */
  private applyEffort(
    handle: PiRuntimeHandle,
    session: HostSession,
    requestedEffort: SessionEffortLevel | undefined
  ): void {
    const effort = requestedEffort ?? session.effort;
    if (!effort) return;
    if (typeof handle.session.setThinkingLevel !== 'function') {
      throw new Error(
        `This pi SDK build cannot apply a reasoning effort ("${effort}"): AgentSession.setThinkingLevel is unavailable`
      );
    }
    handle.session.setThinkingLevel(effort, { persist: false });
    session.effort = effort;
  }

  /**
   * pi ended an assistant message: the NEXT prose belongs to a new container,
   * the tools that follow do not.
   *
   * Why a flag and not an immediate reset. One `agent_start` brackets many pi
   * turns (the SDK's `turn_end` carries a `turnIndex`), so a tool-using answer
   * is `prose -> tool -> prose` across SEPARATE assistant messages. Two
   * different things go wrong at that boundary, and they pull in opposite
   * directions:
   *
   *  - Reusing one container for the whole run made `appendTextBlock`
   *    concatenate every prose chunk into the FIRST text block: the second
   *    paragraph was glued onto the first with no separator and rendered ahead
   *    of the tool row that had actually preceded it.
   *  - Resetting the container outright fixes that but splits a sequential
   *    tool run — `grep`, then `grep`, then `read`, each its own pi turn —
   *    into one tool group per tool, because `groupTimeline` groups within a
   *    message and each tool would land in a different one.
   *
   * Closing only the PROSE stream satisfies both: `openProseMessage` rolls the
   * container when text or thinking arrives, while `ensureAssistant` (the tool
   * path) keeps using the open one. So `prose -> t1 -> t2 -> prose` becomes
   * `[prose, t1, t2]` + `[prose]` — right order, tools still one group.
   *
   * The renderer's ordering contract (T-05 D-5, "block order, position
   * unchanged") was intact the whole time; it was never being handed the order.
   */
  private closeProseStream(state: PiSessionState, requestId?: string): void {
    const turn = state.turn;
    // Before the flags reset: a message that thought and then ended without
    // ever writing prose (it went straight to a tool call) still has to close
    // its thought, or that block's duration never resolves.
    this.completeThinking(state, requestId);
    turn.proseClosed = true;
    turn.textSnapshot = '';
    turn.thinkingSnapshot = '';
  }

  /**
   * T12-c: say when a thought ended.
   *
   * pi has no "thinking ended" event — thinking is content blocks that simply
   * stop growing — so the Host has to pick the boundary. Two things end a
   * thought, and both are here:
   *
   *  - the model starts ANSWERING (`emitTextDelta`), which is the true end of
   *    thinking and the tighter of the two measurements; or
   *  - the message ends first (`closeProseStream`), which covers a turn that
   *    thought and then went straight to a tool call.
   *
   * Idempotent via `thinkingCompleted`, because both paths can fire for the
   * same block and a second `thinking.completed` would overwrite `durationMs`
   * with the LATER timestamp — quietly inflating every thought that was
   * followed by prose.
   */
  private completeThinking(state: PiSessionState, requestId?: string): void {
    const turn = state.turn;
    if (!turn.thinkingStarted || turn.thinkingCompleted) return;
    const messageId = turn.assistantMessageId;
    const blockId = turn.thinkingBlockId;
    if (!messageId || !blockId) return;
    turn.thinkingCompleted = true;
    this.emit({
      type: 'thinking.completed',
      sessionId: state.sessionId,
      requestId,
      payload: { messageId, blockId },
    });
  }

  /**
   * Open the container the next prose/thinking delta belongs to, rolling to a
   * fresh one if pi has ended the message the current container was opened for.
   *
   * Only the prose path calls this. `tool_execution_*` calls `ensureAssistant`
   * directly and therefore never rolls — that is the whole point (see
   * `closeProseStream`).
   */
  private openProseMessage(state: PiSessionState, requestId?: string): string {
    const turn = state.turn;
    if (turn.proseClosed) {
      turn.proseClosed = false;
      turn.assistantMessageId = null;
      turn.textBlockId = null;
      turn.thinkingBlockId = null;
      turn.thinkingStarted = false;
      turn.thinkingCompleted = false;
    }
    return this.ensureAssistant(state, requestId);
  }

  private ensureAssistant(state: PiSessionState, requestId?: string): string {
    const turn = state.turn;
    if (!turn.assistantMessageId) {
      state.assistantSeq += 1;
      turn.assistantMessageId = `asst-${state.sessionId}-${Date.now()}-${state.assistantSeq}`;
      turn.textBlockId = `${turn.assistantMessageId}-text`;
      turn.thinkingBlockId = `${turn.assistantMessageId}-thinking`;
      turn.textSnapshot = '';
      turn.thinkingSnapshot = '';
      turn.thinkingStarted = false;
      turn.thinkingCompleted = false;

      const model = state.handle?.session?.model;
      this.emit({
        type: 'message.started',
        sessionId: state.sessionId,
        requestId,
        payload: {
          messageId: turn.assistantMessageId,
          role: 'assistant',
          ...(model ? { model: `${model.provider}/${model.id}` } : {}),
        },
      });
    }
    return turn.assistantMessageId;
  }

  private emitTextDelta(state: PiSessionState, text: string, requestId?: string): void {
    if (!text) return;
    // BEFORE `openProseMessage`, which may roll to a fresh container and take
    // the thinking block's id with it: the thought that just ended belongs to
    // the container that is still open right now.
    this.completeThinking(state, requestId);
    const messageId = this.openProseMessage(state, requestId);
    this.emit({
      type: 'message.delta',
      sessionId: state.sessionId,
      requestId,
      payload: { messageId, blockId: state.turn.textBlockId ?? `${messageId}-text`, text },
    });
  }

  private emitThinkingDelta(state: PiSessionState, text: string, requestId?: string): void {
    if (!text) return;
    const messageId = this.openProseMessage(state, requestId);
    const blockId = state.turn.thinkingBlockId ?? `${messageId}-thinking`;
    if (!state.turn.thinkingStarted) {
      state.turn.thinkingStarted = true;
      this.emit({
        type: 'thinking.started',
        sessionId: state.sessionId,
        requestId,
        payload: { messageId, blockId },
      });
    }
    this.emit({
      type: 'thinking.delta',
      sessionId: state.sessionId,
      requestId,
      payload: { messageId, blockId, text },
    });
  }

  private projectEvent(state: PiSessionState, event: PiAgentEvent, requestId?: string): void {
    const sessionId = state.sessionId;

    switch (event.type) {
      case 'agent_start':
        state.turn = newTurnState();
        this.emit({
          type: 'session.status',
          sessionId,
          requestId,
          payload: { status: 'running' },
        });
        break;

      case 'agent_settled':
        this.emit({
          type: 'session.completed',
          sessionId,
          requestId,
          payload: {},
        });
        this.emit({
          type: 'session.status',
          sessionId,
          requestId,
          payload: { status: 'idle' },
        });
        break;

      case 'message_start': {
        const msg = event.message as { role?: string; content?: unknown } | undefined;
        if (msg?.role === 'user') {
          const userMsgId = `user-${sessionId}-${Date.now()}`;
          const userBlockId = `${userMsgId}-text`;
          this.emit({
            type: 'message.started',
            sessionId,
            requestId,
            payload: { messageId: userMsgId, role: 'user' },
          });
          const text = extractTextContent(msg.content) ?? '';
          if (text) {
            this.emit({
              type: 'message.delta',
              sessionId,
              requestId,
              payload: { messageId: userMsgId, blockId: userBlockId, text },
            });
          }
          this.emit({
            type: 'message.completed',
            sessionId,
            requestId,
            payload: { messageId: userMsgId },
          });
        } else if (msg?.role === 'assistant') {
          this.ensureAssistant(state, requestId);
        }
        break;
      }

      case 'message_update': {
        const msg = event.message as
          | {
              role?: string;
              content?: Array<{ type: string; text?: string; thinking?: string }> | string;
            }
          | undefined;
        const ame = event.assistantMessageEvent as
          | { type?: string; delta?: string; content?: string }
          | undefined;

        if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
          const fullText = msg.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text || '')
            .join('');
          if (fullText.length > state.turn.textSnapshot.length) {
            const chunk = fullText.slice(state.turn.textSnapshot.length);
            state.turn.textSnapshot = fullText;
            this.emitTextDelta(state, chunk, requestId);
          }

          const fullThinking = msg.content
            .filter((c) => c.type === 'thinking')
            .map((c) => c.thinking || '')
            .join('');
          if (fullThinking.length > state.turn.thinkingSnapshot.length) {
            const chunk = fullThinking.slice(state.turn.thinkingSnapshot.length);
            state.turn.thinkingSnapshot = fullThinking;
            this.emitThinkingDelta(state, chunk, requestId);
          }
        } else if (ame) {
          if (ame.type === 'text_delta' && typeof ame.delta === 'string' && ame.delta) {
            state.turn.textSnapshot += ame.delta;
            this.emitTextDelta(state, ame.delta, requestId);
          } else if (ame.type === 'text_end' && typeof ame.content === 'string' && ame.content) {
            if (ame.content.length > state.turn.textSnapshot.length) {
              const chunk = ame.content.slice(state.turn.textSnapshot.length);
              state.turn.textSnapshot = ame.content;
              this.emitTextDelta(state, chunk, requestId);
            }
          } else if (ame.type === 'thinking_delta' && typeof ame.delta === 'string' && ame.delta) {
            state.turn.thinkingSnapshot += ame.delta;
            this.emitThinkingDelta(state, ame.delta, requestId);
          } else if (
            ame.type === 'thinking_end' &&
            typeof ame.content === 'string' &&
            ame.content
          ) {
            if (ame.content.length > state.turn.thinkingSnapshot.length) {
              const chunk = ame.content.slice(state.turn.thinkingSnapshot.length);
              state.turn.thinkingSnapshot = ame.content;
              this.emitThinkingDelta(state, chunk, requestId);
            }
          }
        }
        break;
      }

      case 'message_end': {
        const msg = event.message as
          | { role?: string; stopReason?: string; errorMessage?: string }
          | undefined;
        if (msg?.role !== 'assistant') break;

        // `proseClosed` already true = pi ended a message this container never
        // opened for (a tool-only turn between two prose turns). The container
        // was completed at ITS OWN message_end; completing it again would stamp
        // a second `completedAt` on a message that has not changed since.
        const messageId = state.turn.proseClosed ? null : state.turn.assistantMessageId;
        if (
          msg.stopReason === 'stop' ||
          msg.stopReason === 'length' ||
          msg.stopReason === 'toolUse'
        ) {
          if (messageId) {
            // No `reason` field: the contract's payload is `{ messageId }`, no
            // other runtime sends one, and no consumer reads one. An extra key
            // on the wire is a field somebody later assumes is load-bearing.
            this.emit({
              type: 'message.completed',
              sessionId,
              requestId,
              payload: { messageId },
            });
          }
        } else if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
          this.emit({
            type: 'session.failed',
            sessionId,
            requestId,
            payload: {
              error: msg.errorMessage ?? `Model response ${msg.stopReason}`,
            },
          });
        }
        this.closeProseStream(state, requestId);
        break;
      }

      case 'tool_execution_start': {
        const messageId = this.ensureAssistant(state, requestId);
        this.emit({
          type: 'tool.started',
          sessionId,
          requestId,
          payload: {
            messageId,
            toolCallId: String(event.toolCallId ?? ''),
            name: String(event.toolName ?? ''),
            input: event.args ?? {},
          },
        });
        break;
      }

      case 'tool_execution_end': {
        // `isError` is pi's word; `ok` is the protocol's. Emitting pi's put a
        // failed tool on screen as a success with its error text in the output
        // slot, because no renderer reads `isError`.
        const failed = event.isError === true;
        const output = readToolOutput(event.result);
        const messageId = state.turn.assistantMessageId ?? this.ensureAssistant(state, requestId);
        this.emit({
          type: 'tool.completed',
          sessionId,
          requestId,
          payload: {
            messageId,
            toolCallId: String(event.toolCallId ?? ''),
            ok: !failed,
            output,
            // Only on a failure, and never empty: the renderer shows this string
            // as the reason, and an empty one reads as "failed, no idea why".
            ...(failed ? { error: output || 'Tool call failed' } : {}),
          },
        });
        break;
      }

      case 'auto_retry_start':
        this.emit({
          type: 'session.status',
          sessionId,
          requestId,
          payload: {
            status: 'running',
            retry: {
              attempt: numberOr(event.attempt, 0),
              maxRetries: numberOr(event.maxAttempts, 0),
              delayMs: numberOr(event.delayMs, 0),
              // Contract names: `error` is the label, `errorStatus` the HTTP
              // status when there is one. pi sends `errorMessage`, which the
              // retry banner and context surface both read past.
              error: stringOr(event.errorMessage, ''),
              errorStatus: stringOrNull(event.errorStatus),
            },
          },
        });
        break;

      default:
        break;
    }
  }

  createSession(input: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    effort?: SessionEffortLevel;
    requestId?: string;
  }): void {
    const session = this.opts.registry.create({
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      agent: PI_AGENT,
      model: input.model,
      effort: input.effort,
    });
    this.emit({
      type: 'session.created',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { agent: PI_AGENT },
    });
    this.emit({
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
    effort?: SessionEffortLevel;
    requestId?: string;
  }): void {
    const current = this.opts.registry.get(input.sessionId);
    if (current?.running) {
      this.emit({
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
      agent: PI_AGENT,
      model: input.model,
      effort: input.effort,
    });
    this.emit({
      type: 'session.resumed',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: {
        agent: PI_AGENT,
        runtimeIdentity: session.runtimeIdentity,
      },
    });
    this.emit({
      type: 'session.status',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { status: 'idle' },
    });
  }

  async send(input: {
    sessionId: string;
    text: string;
    attachments?: SessionAttachment[];
    model?: string;
    effort?: SessionEffortLevel;
    requestId?: string;
  }): Promise<void> {
    const session = this.opts.registry.get(input.sessionId);
    if (!session) {
      this.emit({
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
      this.emit({
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

    const state = this.getOrCreateState(session);
    session.running = true;
    session.status = 'running';
    this.opts.registry.setStatus(session.sessionId, 'running');
    state.abortController = new AbortController();

    this.emit({
      type: 'session.status',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { status: 'running' },
    });

    try {
      // Built before the runtime: an attachment this Host cannot deliver must
      // fail the send, not be dropped somewhere the user cannot see.
      const { text, options } = buildPrompt(input.text, input.attachments);
      const handle = await this.ensureHandle(state);
      await this.applySelectedModel(handle, session, input.model);
      this.applyEffort(handle, session, input.effort);
      this.bindEvents(state, input.requestId);

      if (handle.session.sessionFile && !session.runtimeIdentity) {
        session.runtimeIdentity = handle.session.sessionFile;
      }

      await handle.session.prompt(text, options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof PermissionGateUnavailableError) {
        // Fatal by design. A non-fatal `host.error` is dropped by the renderer's
        // host-status reducer, and this is precisely the failure a user must not
        // be able to miss: without a gate, tool calls would run unattended.
        this.log(`permission gate unavailable for ${session.sessionId}: ${message}`);
        this.emit({
          type: 'host.error',
          sessionId: session.sessionId,
          requestId: input.requestId,
          payload: { code: err.code, message, fatal: true },
        });
        this.emit({
          type: 'session.failed',
          sessionId: session.sessionId,
          requestId: input.requestId,
          payload: { error: message },
        });
      } else if (state.abortController?.signal.aborted) {
        this.emit({
          type: 'session.stopped',
          sessionId: session.sessionId,
          requestId: input.requestId,
          payload: {},
        });
      } else {
        this.log(`send failed for ${session.sessionId}: ${message}`);
        this.emit({
          type: 'session.failed',
          sessionId: session.sessionId,
          requestId: input.requestId,
          payload: { error: message },
        });
      }
    } finally {
      session.running = false;
      session.status = 'idle';
      this.opts.registry.setStatus(session.sessionId, 'idle');
      state.abortController = null;
      this.emit({
        type: 'session.status',
        sessionId: session.sessionId,
        requestId: input.requestId,
        payload: { status: 'idle' },
      });
    }
  }

  /**
   * Stop ONE session.
   *
   * Cancelling the parked dialogs is not cleanup, it is the stop: an extension
   * blocked inside `ui.select` holds the turn open, and `session.abort()` does
   * not reach it. Draining first settles that Promise with the dialog's recorded
   * fallback (a dismissed permission prompt is a denial), so the turn can
   * actually unwind instead of waiting out a timeout that may not exist.
   */
  stop(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    const session = this.opts.registry.get(sessionId);
    if (!session?.running) return;

    state.extensionUi.cancelAll('aborted');
    state.abortController?.abort();

    const piSession = state.handle?.session;
    if (piSession) {
      try {
        piSession.abortCompaction?.();
        piSession.abortBranchSummary?.();
        piSession.abortBash?.();
      } catch {
        /* best-effort */
      }
      void piSession.abort().catch(() => undefined);
    }
  }

  closeSession(sessionId: string, _requestId?: string): void {
    const state = this.states.get(sessionId);
    if (state) {
      this.teardownState(state, 'session_closed');
      this.states.delete(sessionId);
    }
    this.opts.registry.delete(sessionId);
  }

  /**
   * Drop one session's runtime. Touches nothing that belongs to another
   * session — a close of A must leave B streaming.
   */
  private teardownState(state: PiSessionState, reason: ExtensionUiCancelReason): void {
    state.unsubscribe?.();
    state.unsubscribe = null;
    state.abortController?.abort();
    state.abortController = null;
    // The dialogs parked for this session can never be answered now — its UI is
    // gone. Draining them lets any extension still awaiting one finish with its
    // fallback instead of hanging until the Host exits.
    state.extensionUi.cancelAll(reason);
    state.extensionUi.dispose();
    // Aborting the pi session is part of the teardown, not a nicety: closing a
    // session while its turn is in flight otherwise leaves that turn running
    // inside a runtime nothing is listening to any more.
    const piSession = state.handle?.session;
    if (piSession) void piSession.abort().catch(() => undefined);
    state.handle = null;
    state.building = null;
  }

  async dispose(): Promise<void> {
    for (const state of this.states.values()) {
      this.teardownState(state, 'host_shutdown');
    }
    this.states.clear();
    this.sdk = null;
  }

  /** Diagnostics / tests: how many sessions hold a live runtime record. */
  activeSessionCount(): number {
    return this.states.size;
  }
}

/** `settings.packages` when the SDK build exposes it; `[]` when it does not. */
function readConfiguredPackages(settings: { packages?: unknown } | undefined): unknown[] {
  return Array.isArray(settings?.packages) ? settings.packages : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** `null` is the contract's "no HTTP status", which is the common transport case. */
function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** pi's tool result → the string the timeline shows. */
function readToolOutput(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'content' in result) {
    const content = (result as { content: unknown }).content;
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
  if (result === undefined) return '';
  return JSON.stringify(result);
}

/**
 * Turn one send into pi's `prompt(text, options)` arguments.
 *
 * pi has exactly one attachment slot — `options.images`, an `ImageContent[]`.
 * Text attachments have no slot, so they are appended to the prompt as labelled
 * blocks: that is where a text document's content belongs in a message with no
 * document type, and it is visible to both the model and the transcript. What
 * must NOT happen is the third option, which is what happened before: accepting
 * the attachment on the wire and sending a prompt without it.
 *
 * An attachment kind this Host has no mapping for throws, so the send fails with
 * a message naming it rather than quietly losing it.
 */
export function buildPrompt(
  text: string,
  attachments: SessionAttachment[] | undefined
): { text: string; options?: PiPromptOptions } {
  if (!attachments || attachments.length === 0) return { text };
  const images: PiImageContent[] = [];
  const documents: string[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      images.push({
        type: 'image',
        data: attachment.data,
        mimeType: attachment.mediaType || 'image/png',
      });
    } else if (attachment.kind === 'text') {
      const title = attachment.name ?? 'attachment';
      documents.push(`--- ${title} ---\n${attachment.data}`);
    } else {
      throw new Error(
        `Unsupported attachment kind for the pi backend: ${String((attachment as { kind: unknown }).kind)}`
      );
    }
  }
  const promptText =
    documents.length > 0 ? [text, ...documents].filter(Boolean).join('\n\n') : text;
  return {
    text: promptText,
    ...(images.length > 0 ? { options: { images } } : {}),
  };
}

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part !== null && 'type' in part) {
        const typed = part as { type: string; text?: string };
        if (typed.type === 'text' && typed.text) return typed.text;
      }
    }
  }
  return undefined;
}
