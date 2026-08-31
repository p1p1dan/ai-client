/**
 * A stand-in for the Pi SDK, shaped by what `PiWorkerSession` calls.
 *
 * Two things it deliberately models rather than stubs away, because both are
 * where the interesting failures live:
 *
 *  - **Sessions are per-cwd.** `createAgentSessionRuntime` builds a NEW fake
 *    session each time, and every session records the cwd it was built for. A
 *    test can then assert that `/repo-b`'s prompt did not land on `/repo-a`'s
 *    session, which is the multi-worktree bug the runtime is organized around.
 *  - **The permission gate is a real gate.** `bindExtensions` and the extension
 *    list are present by default and can each be switched off, so "the plugin
 *    could not be loaded" and "the approval UI could not be bound" are states a
 *    test can create instead of describe.
 */

import type { RuntimeEvent } from '../../../shared/types/runtimeEvents.ts';

export interface StubPiEvent {
  type: string;
  [key: string]: unknown;
}

export interface StubPiSession {
  sessionId: string;
  cwd: string;
  model?: { provider: string; id: string; name?: string };
  sessionFile: string;
  thinkingLevels: string[];
  prompts: Array<{ text: string; options?: { images?: unknown[] } }>;
  aborted: boolean;
  disposed: boolean;
  queueCleared: boolean;
  compactionAborted: boolean;
  branchSummaryAborted: boolean;
  bashAborted: boolean;
  boundUiContext: unknown;
  /** Push one pi event into whatever the runtime subscribed with. */
  emit(event: StubPiEvent): void;
  prompt(text: string, options?: { images?: unknown[] }): Promise<void>;
  subscribe(cb: (event: StubPiEvent) => void): () => void;
  bindExtensions?(bindings: { uiContext?: unknown; mode?: string }): Promise<void>;
  clearQueue(): { steering: unknown[]; followUp: unknown[] };
  abortCompaction(): void;
  abortBranchSummary(): void;
  abortBash(): void;
  abort(): Promise<void>;
  dispose(): void;
  setModel(model: { provider: string; id: string; name?: string }): Promise<void>;
  setThinkingLevel?(level: string): void;
}

export interface PiSdkStubOptions {
  /** `provider/id` → model object; a miss makes model selection fail. */
  models?: Map<string, { provider: string; id: string; name?: string }>;
  /** Simulate an SDK build with no `bindExtensions`. */
  noBindExtensions?: boolean;
  /** Simulate `bindExtensions` throwing. */
  bindThrows?: string;
  /** What `resourceLoader.getExtensions()` reports; `null` = no resourceLoader. */
  loadedExtensions?: {
    extensions?: Array<{ path?: string; resolvedPath?: string }>;
    errors?: Array<{ path?: string; error?: string }>;
  } | null;
  /** `settings.packages` the fake SettingsManager reports. */
  configuredPackages?: unknown[];
  /** Hold `prompt()` open until the test resolves it. */
  manualPrompt?: boolean;
  /** Reject prompt immediately with this message. */
  promptError?: string;
  /** Reject abort with this message. */
  abortError?: string;
}

export interface PiSdkStub {
  sdk: Record<string, unknown>;
  sessions: StubPiSession[];
  /** Every `SettingsManager.create` call, so the trust decision is observable. */
  settingsManagerCalls: Array<{ cwd: string; agentDir: string; projectTrusted: boolean }>;
  /** The most recent session built for this cwd. */
  sessionFor(cwd: string): StubPiSession | undefined;
  /** Resolve a pending `prompt()` (only with `manualPrompt`). */
  finishPrompt(cwd: string): void;
  /** `additionalExtensionPaths` seen by each `createAgentSessionServices` call. */
  injectedPaths: string[][];
}

export function createPiSdkStub(options: PiSdkStubOptions = {}): PiSdkStub {
  const sessions: StubPiSession[] = [];
  const injectedPaths: string[][] = [];
  const settingsManagerCalls: PiSdkStub['settingsManagerCalls'] = [];
  const pendingPrompts = new Map<string, () => void>();
  const models =
    options.models ??
    new Map([
      ['glm/glm-5', { provider: 'glm', id: 'glm-5', name: 'GLM 5' }],
      ['dan/deepseek-v4', { provider: 'dan', id: 'deepseek-v4', name: 'DeepSeek V4' }],
    ]);

  function makeSession(cwd: string): StubPiSession {
    let listener: ((event: StubPiEvent) => void) | undefined;
    const session: StubPiSession = {
      sessionId: `pi-${cwd}`,
      cwd,
      sessionFile: `${cwd}/session.jsonl`,
      thinkingLevels: [],
      prompts: [],
      aborted: false,
      disposed: false,
      queueCleared: false,
      compactionAborted: false,
      branchSummaryAborted: false,
      bashAborted: false,
      boundUiContext: undefined,
      emit(event) {
        listener?.(event);
      },
      async prompt(text, promptOptions) {
        session.prompts.push({ text, ...(promptOptions ? { options: promptOptions } : {}) });
        if (options.promptError) throw new Error(options.promptError);
        if (!options.manualPrompt) return;
        await new Promise<void>((resolve) => pendingPrompts.set(cwd, resolve));
      },
      subscribe(cb) {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      clearQueue() {
        session.queueCleared = true;
        return { steering: [], followUp: [] };
      },
      abortCompaction() {
        session.compactionAborted = true;
      },
      abortBranchSummary() {
        session.branchSummaryAborted = true;
      },
      abortBash() {
        session.bashAborted = true;
      },
      async abort() {
        session.aborted = true;
        if (options.abortError) throw new Error(options.abortError);
        pendingPrompts.get(cwd)?.();
        pendingPrompts.delete(cwd);
      },
      dispose() {
        session.disposed = true;
      },
      async setModel(model) {
        session.model = model;
      },
      setThinkingLevel(level) {
        session.thinkingLevels.push(level);
      },
    };
    if (!options.noBindExtensions) {
      session.bindExtensions = async (bindings) => {
        if (options.bindThrows) throw new Error(options.bindThrows);
        session.boundUiContext = bindings.uiContext;
      };
    }
    sessions.push(session);
    return session;
  }

  const defaultExtensions = {
    extensions: [{ path: '/bundle/pi-permission-system/src/index.ts' }],
  };

  const sdk = {
    getAgentDir: () => '/tmp/pi-agent',
    SessionManager: {
      create: (cwd: string) => ({ cwd }),
      open: () => ({}),
      continueRecent: () => ({}),
      inMemory: () => ({}),
    },
    SettingsManager: {
      create: (cwd: string, agentDir: string, opts: { projectTrusted: boolean }) => {
        settingsManagerCalls.push({ cwd, agentDir, projectTrusted: opts.projectTrusted });
        return {
          getGlobalSettings: () => ({ packages: options.configuredPackages ?? [] }),
          getProjectSettings: () => ({ packages: [] }),
        };
      },
    },
    createAgentSessionServices: async (opts: Record<string, unknown>) => {
      const loaderOptions = (opts.resourceLoaderOptions ?? {}) as {
        additionalExtensionPaths?: string[];
      };
      injectedPaths.push(loaderOptions.additionalExtensionPaths ?? []);
      const loaded =
        options.loadedExtensions === undefined ? defaultExtensions : options.loadedExtensions;
      return {
        cwd: String(opts.cwd),
        agentDir: '/tmp/pi-agent',
        diagnostics: [],
        modelRuntime: {
          getModel: (provider: string, id: string) => models.get(`${provider}/${id}`),
        },
        ...(loaded === null ? {} : { resourceLoader: { getExtensions: () => loaded } }),
      };
    },
    createAgentSessionFromServices: async (opts: Record<string, unknown>) => {
      const services = opts.services as { cwd: string };
      return { session: makeSession(services.cwd) };
    },
    createAgentSessionRuntime: async (
      factory: (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
      opts: Record<string, unknown>
    ) => factory({ cwd: opts.cwd, sessionManager: opts.sessionManager }),
  };

  return {
    sdk,
    sessions,
    settingsManagerCalls,
    sessionFor: (cwd) => [...sessions].reverse().find((session) => session.cwd === cwd),
    finishPrompt: (cwd) => {
      pendingPrompts.get(cwd)?.();
      pendingPrompts.delete(cwd);
    },
    injectedPaths,
  };
}

/** Events with just enough shape for assertions, without re-stating the union. */
export type CapturedEvent = Partial<RuntimeEvent> & {
  type: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
};
