import { parsePiModelRef } from '../shared/piModelConfig.ts';
import type { SessionEffortLevel } from '../shared/types/agentHost.ts';
import type { RuntimeEvent } from '../shared/types/runtimeEvents.ts';
import type { PortableExtensionUiBridge } from './extensionUiBridge.ts';
import { createPermissionActivityObserver } from './permissionActivity.ts';
import {
  decidePermissionPlugin,
  type PermissionPluginDecision,
  verifyPermissionExtensionLoaded,
} from './permissionPlugin.ts';
import {
  assertPiSessionFileIdentity,
  preflightPiSessionFile,
  samePiSessionPath,
} from './piSessionPreflight.ts';
import { PiWorkerSessionError } from './piWorkerErrors.ts';

export interface PiSettingsManager {
  getGlobalSettings?: () => { packages?: unknown };
  getProjectSettings?: () => { packages?: unknown };
  [key: string]: unknown;
}

export interface PiModel {
  provider: string;
  id: string;
  name?: string;
}

export interface PiLoadedExtensions {
  extensions?: Array<{ path?: unknown; resolvedPath?: unknown }>;
  errors?: Array<{ path?: unknown; error?: unknown }>;
}

export interface PiServices {
  modelRuntime: { getModel: (provider: string, id: string) => PiModel | undefined };
  resourceLoader?: { getExtensions?: () => PiLoadedExtensions };
  diagnostics?: unknown[];
  cwd: string;
  agentDir: string;
  [key: string]: unknown;
}

export interface PiSessionManager {
  getBranch?: () => unknown[];
  getCwd?: () => string;
  getSessionFile?: () => string | undefined;
  getSessionId?: () => string;
  [key: string]: unknown;
}

export interface PiExtensionBindings {
  uiContext?: unknown;
  mode?: 'rpc' | 'tui';
  onError?: (error: unknown) => void;
}

export type PiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface PiSession {
  bindExtensions?: (bindings: PiExtensionBindings) => Promise<void>;
  prompt?: (
    text: string,
    options?: { images?: Array<{ type: 'image'; data: string; mimeType: string }> }
  ) => Promise<void>;
  subscribe?: (callback: (event: { type: string; [key: string]: unknown }) => void) => () => void;
  abort: () => Promise<void>;
  abortCompaction?: () => void;
  abortBranchSummary?: () => void;
  abortBash?: () => void;
  clearQueue?: () => unknown;
  dispose?: () => void;
  sessionId: string;
  sessionFile?: string;
  model?: PiModel;
  thinkingLevel?: PiThinkingLevel;
  setModel?: (model: PiModel, options?: { persist?: boolean }) => Promise<void>;
  setThinkingLevel?: (level: PiThinkingLevel, options?: { persist?: boolean }) => void;
  [key: string]: unknown;
}

export interface PiRuntimeHandle {
  session: PiSession;
  services: PiServices;
  setBeforeSessionInvalidate?: (fn: () => void) => void;
  dispose?: () => Promise<void>;
  [key: string]: unknown;
}

export type PiRuntimeFactory = (ctx: {
  cwd: string;
  agentDir: string;
  sessionManager: PiSessionManager;
  sessionStartEvent?: unknown;
  projectTrustContext?: unknown;
}) => Promise<Record<string, unknown> & { services: PiServices; diagnostics: unknown[] }>;

export interface PiSdkModule {
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
    create: (cwd: string, sessionDir?: string) => PiSessionManager;
    open: (sessionFile: string, sessionDir?: string, cwd?: string) => PiSessionManager;
    continueRecent: (cwd: string, sessionDir?: string) => PiSessionManager;
    inMemory: (cwd?: string) => PiSessionManager;
  };
  SettingsManager: {
    create: (
      cwd: string,
      agentDir?: string,
      opts?: { projectTrusted?: boolean }
    ) => PiSettingsManager;
  };
}

type PermissionActivityPayload = Extract<RuntimeEvent, { type: 'permission.activity' }>['payload'];

export class PermissionGateUnavailableError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PermissionGateUnavailableError';
    this.code = code;
  }
}

export interface BootstrapPiAgentSessionOptions {
  sdk: PiSdkModule;
  cwd: string;
  projectTrusted: boolean;
  extensionUi: PortableExtensionUiBridge;
  sessionFile?: string;
  model?: string;
  effort?: SessionEffortLevel;
  decidePermissionGate?: (packages: unknown[]) => PermissionPluginDecision;
  onPermissionActivity?: (payload: PermissionActivityPayload) => void;
  log?: (...args: unknown[]) => void;
}

export interface BootstrapPiAgentSessionResult {
  handle: PiRuntimeHandle;
  sessionManager: PiSessionManager;
  agentDir: string;
  projectTrusted: boolean;
  permissionGate: 'bundled' | 'user_configured';
}

function configuredPackages(settings: { packages?: unknown } | undefined): unknown[] {
  return Array.isArray(settings?.packages) ? settings.packages : [];
}

async function disposeHandle(handle: PiRuntimeHandle): Promise<void> {
  if (handle.dispose) await handle.dispose().catch(() => undefined);
  else handle.session.dispose?.();
}

async function bindExtensionUi(
  extensionUi: PortableExtensionUiBridge,
  handle: PiRuntimeHandle,
  log: (...args: unknown[]) => void
): Promise<void> {
  if (typeof handle.session.bindExtensions !== 'function') {
    throw new PermissionGateUnavailableError(
      'extension_bind_unsupported',
      'Tool approval is unavailable: this Pi SDK build cannot bind an approval UI'
    );
  }
  try {
    await handle.session.bindExtensions({
      uiContext: extensionUi.uiContext,
      mode: 'rpc',
      onError: (error) => log('Pi extension error:', error),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PermissionGateUnavailableError(
      'extension_bind_failed',
      `Tool approval is unavailable: binding the approval UI failed — ${message}`
    );
  }
}

/**
 * Create exactly one Pi AgentSession runtime for a utility worker.
 *
 * The SDK resolves models.json and auth.json from the selected agentDir while
 * SettingsManager applies the Main-owned project-trust decision. Tool execution
 * stays fail-closed: the runtime is not returned unless the permission extension
 * loaded and its portable approval UI was bound.
 */
export async function bootstrapPiAgentSession(
  options: BootstrapPiAgentSessionOptions
): Promise<BootstrapPiAgentSessionResult> {
  const log = options.log ?? (() => undefined);
  const agentDir = options.sdk.getAgentDir();
  if (!agentDir.trim()) throw new Error('Pi SDK returned an empty agentDir');

  const sessionHeader = options.sessionFile
    ? await preflightPiSessionFile(options.sessionFile, options.cwd)
    : null;
  if (options.sessionFile && sessionHeader) {
    await assertPiSessionFileIdentity(options.sessionFile, sessionHeader.fileIdentity);
  }
  let sessionManager: PiSessionManager;
  try {
    // Do not pass a cwd override on resume: first let Pi retain the exact header
    // workspace, then validate it below. An override would hide cross-cwd drift.
    sessionManager = options.sessionFile
      ? options.sdk.SessionManager.open(options.sessionFile)
      : options.sdk.SessionManager.create(options.cwd);
  } catch (error) {
    throw new PiWorkerSessionError(
      'WORKER_SESSION_FILE_CORRUPT',
      `Failed to open Pi session ${options.sessionFile ?? ''}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (options.sessionFile) {
    if (sessionHeader) {
      await assertPiSessionFileIdentity(options.sessionFile, sessionHeader.fileIdentity);
    }
    const openedFile = sessionManager.getSessionFile?.() ?? options.sessionFile;
    const openedCwd = sessionManager.getCwd?.() ?? sessionHeader?.cwd;
    const openedSessionId = sessionManager.getSessionId?.() ?? sessionHeader?.sessionId;
    if (!samePiSessionPath(openedFile, options.sessionFile)) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_IDENTITY_MISMATCH',
        `Pi opened ${openedFile}, expected exact session file ${options.sessionFile}`
      );
    }
    if (!openedCwd || !samePiSessionPath(openedCwd, options.cwd)) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_CWD_MISMATCH',
        `Pi session workspace mismatch: expected ${options.cwd}, opened ${openedCwd ?? 'unknown'}`
      );
    }
    if (sessionHeader && openedSessionId && openedSessionId !== sessionHeader.sessionId) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_IDENTITY_MISMATCH',
        `Pi session id mismatch: header ${sessionHeader.sessionId}, opened ${openedSessionId}`
      );
    }
  }
  let gate: PermissionPluginDecision | undefined;
  let gateVerified = false;

  const createRuntime: PiRuntimeFactory = async ({
    cwd,
    sessionManager: runtimeSessionManager,
  }) => {
    const settingsManager = options.sdk.SettingsManager.create(cwd, agentDir, {
      projectTrusted: options.projectTrusted,
    });
    const packages = [
      ...configuredPackages(settingsManager.getGlobalSettings?.()),
      ...configuredPackages(settingsManager.getProjectSettings?.()),
    ];
    gate = (options.decidePermissionGate ?? decidePermissionPlugin)(packages);
    if (!gate.gated) {
      throw new PermissionGateUnavailableError(
        'permission_plugin_missing',
        `Tool approval is unavailable: ${gate.detail ?? 'the permission system could not be loaded'}`
      );
    }

    const activityObserver = createPermissionActivityObserver({
      log,
      onActivity: (payload) => options.onPermissionActivity?.(payload),
    });
    const services = await options.sdk.createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: {
        ...(gate.additionalExtensionPaths.length > 0
          ? { additionalExtensionPaths: gate.additionalExtensionPaths }
          : {}),
        extensionFactories: [
          { name: 'aiclient-permission-activity', factory: activityObserver, hidden: true },
        ],
      },
    });

    const loadedExtensions = services.resourceLoader?.getExtensions?.();
    if (!loadedExtensions) {
      throw new PermissionGateUnavailableError(
        'permission_plugin_verification_unsupported',
        'Tool approval is unavailable: this Pi SDK build cannot verify loaded extensions'
      );
    }
    const verification = verifyPermissionExtensionLoaded(
      loadedExtensions,
      gate.additionalExtensionPaths
    );
    if (!verification.ok) {
      throw new PermissionGateUnavailableError(
        'permission_plugin_load_failed',
        `Tool approval is unavailable: ${verification.detail ?? 'the permission extension did not load'}`
      );
    }
    gateVerified = true;

    let model: PiModel | undefined;
    if (options.model) {
      const ref = parsePiModelRef(options.model);
      if (!ref) {
        throw new Error(`Invalid Pi model reference: ${options.model}. Expected provider/model`);
      }
      model = services.modelRuntime.getModel(ref.provider, ref.modelId);
      if (!model) throw new Error(`Pi model not found: ${options.model}`);
    }

    return {
      ...(await options.sdk.createAgentSessionFromServices({
        services,
        sessionManager: runtimeSessionManager,
        ...(model ? { model } : {}),
        ...(options.effort ? { thinkingLevel: options.effort } : {}),
      })),
      services,
      diagnostics: services.diagnostics ?? [],
    };
  };

  const handle = await options.sdk.createAgentSessionRuntime(createRuntime, {
    cwd: options.cwd,
    agentDir,
    sessionManager,
  });

  if (!gate?.gated || !gateVerified) {
    await disposeHandle(handle);
    throw new PermissionGateUnavailableError(
      'permission_plugin_load_failed',
      'Tool approval is unavailable: the permission gate was not verified during bootstrap'
    );
  }

  handle.setBeforeSessionInvalidate?.(() => options.extensionUi.reload());
  try {
    await bindExtensionUi(options.extensionUi, handle, log);
  } catch (error) {
    await disposeHandle(handle);
    throw error;
  }

  if (gate.reason === 'missing') {
    await disposeHandle(handle);
    throw new PermissionGateUnavailableError(
      'permission_plugin_missing',
      'Tool approval is unavailable: the permission system could not be loaded'
    );
  }
  log(`permission plugin: ${gate.reason}`);
  return {
    handle,
    sessionManager,
    agentDir,
    projectTrusted: options.projectTrusted,
    permissionGate: gate.reason,
  };
}
