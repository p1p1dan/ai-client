import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BundledFeaturePluginResolution } from '../bundledFeaturePlugins.ts';
import { createPortableExtensionUiBridge } from '../extensionUiBridge.ts';
import type { PermissionPluginDecision } from '../permissionPlugin.ts';
import {
  bootstrapPiAgentSession,
  PermissionGateUnavailableError,
  type PiSdkModule,
} from '../piAgentSessionBootstrap.ts';

const BUNDLED_GATE: PermissionPluginDecision = {
  additionalExtensionPaths: ['/bundle/pi-permission-system'],
  reason: 'bundled',
  gated: true,
};

/**
 * R03 — every pre-existing case injects this so it keeps asserting on the
 * permission gate alone. Without the seam these tests would read the REAL
 * `src/agent-host/node_modules`, and their expectations would depend on which
 * packages a developer happens to have installed.
 */
const NO_FEATURE_PLUGINS: BundledFeaturePluginResolution = { paths: [], skipped: [] };

function harness(
  options: {
    bindExtensions?: boolean;
    loadedPermission?: boolean;
    /** R03 — exact paths pi reports as loaded, overriding `loadedPermission`. */
    loadedPaths?: string[];
    verificationAvailable?: boolean;
    gate?: PermissionPluginDecision;
    sessionFile?: string;
  } = {}
) {
  const calls = {
    sessionManager: vi.fn(),
    sessionManagerOpen: vi.fn(),
    settingsManager: vi.fn(),
    services: vi.fn(),
    sessionFromServices: vi.fn(),
    runtime: vi.fn(),
    runtimeDispose: vi.fn(async () => undefined),
    sessionDispose: vi.fn(),
  };
  const session = {
    sessionId: 'pi-session-1',
    sessionFile: options.sessionFile ?? '/managed/pi-agent/sessions/session-1.jsonl',
    model: undefined as { provider: string; id: string } | undefined,
    bindExtensions:
      options.bindExtensions === false ? undefined : vi.fn(async (_bindings: unknown) => undefined),
    abort: vi.fn(async () => undefined),
    dispose: calls.sessionDispose,
  };
  const model = { provider: 'pilab', id: 'company-model', name: 'Company Model' };
  const services = {
    cwd: '/repo',
    agentDir: '/managed/pi-agent',
    diagnostics: [],
    modelRuntime: {
      getModel: vi.fn((provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined
      ),
    },
    ...(options.verificationAvailable === false
      ? {}
      : {
          resourceLoader: {
            getExtensions: () => ({
              extensions: (
                options.loadedPaths ??
                (options.loadedPermission === false
                  ? ['/other/extension.ts']
                  : ['/bundle/pi-permission-system/src/index.ts'])
              ).map((path) => ({ path })),
            }),
          },
        }),
  };
  const sdk: PiSdkModule = {
    getAgentDir: () => '/managed/pi-agent',
    SessionManager: {
      create: (cwd, sessionDir) => {
        calls.sessionManager(cwd, sessionDir);
        return { cwd, sessionDir };
      },
      open: (sessionFile, sessionDir, cwd) => {
        calls.sessionManagerOpen(sessionFile, sessionDir, cwd);
        return {
          getBranch: () => [],
          getCwd: () => '/repo',
          getSessionFile: () => sessionFile,
          getSessionId: () => 'pi-session-1',
        };
      },
      continueRecent: () => ({}),
      inMemory: () => ({}),
    },
    SettingsManager: {
      create: (cwd, agentDir, settingsOptions) => {
        calls.settingsManager(cwd, agentDir, settingsOptions);
        return {
          getGlobalSettings: () => ({ packages: [] }),
          getProjectSettings: () => ({ packages: [] }),
        };
      },
    },
    createAgentSessionServices: async (serviceOptions) => {
      calls.services(serviceOptions);
      return services;
    },
    createAgentSessionFromServices: async (sessionOptions) => {
      calls.sessionFromServices(sessionOptions);
      const selected = sessionOptions.model as { provider: string; id: string } | undefined;
      session.model = selected;
      return { session };
    },
    createAgentSessionRuntime: async (factory, runtimeOptions) => {
      calls.runtime(runtimeOptions);
      const created = await factory({
        cwd: String(runtimeOptions.cwd),
        agentDir: String(runtimeOptions.agentDir),
        sessionManager: runtimeOptions.sessionManager as Record<string, unknown>,
      });
      return {
        ...created,
        session,
        services,
        dispose: calls.runtimeDispose,
      };
    },
  };
  return {
    calls,
    sdk,
    services,
    session,
    gate: options.gate ?? BUNDLED_GATE,
    extensionUi: createPortableExtensionUiBridge({ onRequest: () => undefined }),
  };
}

describe('bootstrapPiAgentSession', () => {
  it('loads auth/models from the managed agentDir and applies trust, model, effort, and permission', async () => {
    const h = harness();
    const result = await bootstrapPiAgentSession({
      sdk: h.sdk,
      cwd: '/repo',
      projectTrusted: false,
      extensionUi: h.extensionUi,
      model: 'pilab/company-model',
      effort: 'high',
      decidePermissionGate: () => h.gate,
      resolveFeaturePlugins: () => NO_FEATURE_PLUGINS,
    });

    expect(h.calls.sessionManager).toHaveBeenCalledWith('/repo', undefined);
    expect(h.calls.settingsManager).toHaveBeenCalledWith('/repo', '/managed/pi-agent', {
      projectTrusted: false,
    });
    expect(h.calls.services).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo',
        agentDir: '/managed/pi-agent',
        resourceLoaderOptions: expect.objectContaining({
          additionalExtensionPaths: ['/bundle/pi-permission-system'],
        }),
      })
    );
    expect(h.services.modelRuntime.getModel).toHaveBeenCalledWith('pilab', 'company-model');
    expect(h.calls.sessionFromServices).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining(modelShape()),
        thinkingLevel: 'high',
      })
    );
    expect(h.session.bindExtensions).toHaveBeenCalledWith(expect.objectContaining({ mode: 'rpc' }));
    expect(result).toMatchObject({
      agentDir: '/managed/pi-agent',
      projectTrusted: false,
      permissionGate: 'bundled',
    });
  });

  it('reopens an exact durable session file for a replacement worker generation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiclient-bootstrap-'));
    const sessionFile = join(dir, 'session.jsonl');
    await writeFile(sessionFile, '{"type":"session","id":"pi-session-1","cwd":"/repo"}\n', 'utf8');
    const h = harness({ sessionFile });
    try {
      await bootstrapPiAgentSession({
        sdk: h.sdk,
        cwd: '/repo',
        sessionFile,
        projectTrusted: false,
        extensionUi: h.extensionUi,
        decidePermissionGate: () => h.gate,
        resolveFeaturePlugins: () => NO_FEATURE_PLUGINS,
      });

      expect(h.calls.sessionManager).not.toHaveBeenCalled();
      expect(h.calls.sessionManagerOpen).toHaveBeenCalledWith(sessionFile, undefined, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps native model defaults when no model was requested', async () => {
    const h = harness();
    await bootstrapPiAgentSession({
      sdk: h.sdk,
      cwd: '/repo',
      projectTrusted: true,
      extensionUi: h.extensionUi,
      decidePermissionGate: () => h.gate,
      resolveFeaturePlugins: () => NO_FEATURE_PLUGINS,
    });

    expect(h.services.modelRuntime.getModel).not.toHaveBeenCalled();
    expect(h.calls.sessionFromServices.mock.calls[0][0]).not.toHaveProperty('model');
    expect(h.calls.settingsManager).toHaveBeenCalledWith('/repo', '/managed/pi-agent', {
      projectTrusted: true,
    });
  });

  it('fails closed before creating an AgentSession when the permission plugin is missing', async () => {
    const h = harness({
      gate: {
        additionalExtensionPaths: [],
        reason: 'missing',
        gated: false,
        detail: 'bundle missing',
      },
    });

    await expect(
      bootstrapPiAgentSession({
        sdk: h.sdk,
        cwd: '/repo',
        projectTrusted: false,
        extensionUi: h.extensionUi,
        decidePermissionGate: () => h.gate,
        resolveFeaturePlugins: () => NO_FEATURE_PLUGINS,
      })
    ).rejects.toMatchObject({
      name: 'PermissionGateUnavailableError',
      code: 'permission_plugin_missing',
    });
    expect(h.calls.sessionFromServices).not.toHaveBeenCalled();
  });

  it('fails closed when the SDK cannot verify loaded extensions', async () => {
    const h = harness({ verificationAvailable: false });
    await expect(
      bootstrapPiAgentSession({
        sdk: h.sdk,
        cwd: '/repo',
        projectTrusted: false,
        extensionUi: h.extensionUi,
        decidePermissionGate: () => h.gate,
        resolveFeaturePlugins: () => NO_FEATURE_PLUGINS,
      })
    ).rejects.toMatchObject({ code: 'permission_plugin_verification_unsupported' });
    expect(h.calls.sessionFromServices).not.toHaveBeenCalled();
  });

  it('fails closed when the permission extension did not load', async () => {
    const h = harness({ loadedPermission: false });
    await expect(
      bootstrapPiAgentSession({
        sdk: h.sdk,
        cwd: '/repo',
        projectTrusted: false,
        extensionUi: h.extensionUi,
        decidePermissionGate: () => h.gate,
        resolveFeaturePlugins: () => NO_FEATURE_PLUGINS,
      })
    ).rejects.toBeInstanceOf(PermissionGateUnavailableError);
    expect(h.calls.sessionFromServices).not.toHaveBeenCalled();
  });

  it('disposes a partially-created runtime when approval UI binding is unsupported', async () => {
    const h = harness({ bindExtensions: false });
    await expect(
      bootstrapPiAgentSession({
        sdk: h.sdk,
        cwd: '/repo',
        projectTrusted: false,
        extensionUi: h.extensionUi,
        decidePermissionGate: () => h.gate,
        resolveFeaturePlugins: () => NO_FEATURE_PLUGINS,
      })
    ).rejects.toMatchObject({ code: 'extension_bind_unsupported' });
    expect(h.calls.runtimeDispose).toHaveBeenCalledTimes(1);
  });
});

function modelShape() {
  return { provider: 'pilab', id: 'company-model' };
}

/**
 * R01 — the user's own skills and templates reach the resource loader.
 *
 * Real directories, because the module drops paths that do not exist and a stub
 * would let a wrong one through.
 */
describe('bootstrapPiAgentSession — borrowed user resources', () => {
  const temporaries: string[] = [];

  async function userAgentDir(subdirs: string[]): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), 'bootstrap-borrow-'));
    temporaries.push(base);
    for (const dir of subdirs) await mkdir(join(base, dir), { recursive: true });
    return base;
  }

  async function loaderOptions(borrowResourcesFrom?: string) {
    const h = harness();
    await bootstrapPiAgentSession({
      sdk: h.sdk,
      cwd: '/repo',
      projectTrusted: false,
      extensionUi: h.extensionUi,
      decidePermissionGate: () => h.gate,
      resolveFeaturePlugins: () => NO_FEATURE_PLUGINS,
      ...(borrowResourcesFrom ? { borrowResourcesFrom } : {}),
    });
    const call = h.calls.services.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    return (call.resourceLoaderOptions ?? {}) as Record<string, unknown>;
  }

  afterEach(async () => {
    for (const dir of temporaries.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('loads global instructions and appends the default skill home without replacing existing prompts', async () => {
    const source = await userAgentDir([]);
    await writeFile(join(source, 'AGENTS.md'), 'Global guidance');
    const options = await loaderOptions(source);
    const override = options.agentsFilesOverride as (base: {
      agentsFiles: Array<{ path: string; content: string }>;
    }) => { agentsFiles: Array<{ path: string; content: string }> };
    expect(override({ agentsFiles: [] }).agentsFiles).toEqual([
      { path: join(source, 'AGENTS.md'), content: 'Global guidance' },
    ]);
    const append = options.appendSystemPromptOverride as (base: string[]) => string[];
    expect(append(['Existing append'])[0]).toBe('Existing append');
    expect(append([])[0]).toContain('.agents');
    expect(options.additionalExtensionPaths).toEqual(['/bundle/pi-permission-system']);
  });

  it('adds the user’s skills and prompts directories', async () => {
    const source = await userAgentDir(['skills', 'prompts']);
    const options = await loaderOptions(source);
    expect(options.additionalSkillPaths).toEqual([join(source, 'skills')]);
    expect(options.additionalPromptTemplatePaths).toEqual([join(source, 'prompts')]);
  });

  it('never routes borrowed paths into additionalExtensionPaths', async () => {
    // Load-bearing. Skills and templates are text that enters the context; an
    // extension is code, and the user's own copy of the permission system would
    // collide with the patched one this app ships.
    const source = await userAgentDir(['skills']);
    const options = await loaderOptions(source);
    expect(options.additionalExtensionPaths).toEqual(['/bundle/pi-permission-system']);
  });

  it('omits both fields entirely when nothing is borrowed', async () => {
    // Passing empty arrays would read as "borrowing, found nothing", which is a
    // different claim from "not borrowing".
    const options = await loaderOptions();
    expect(options).not.toHaveProperty('additionalSkillPaths');
    expect(options).not.toHaveProperty('additionalPromptTemplatePaths');
  });
});

/**
 * R03 — the bundled feature extensions reach pi, without ever being able to
 * stand in for the permission system.
 */
describe('bootstrapPiAgentSession — bundled feature extensions', () => {
  const FEATURE: BundledFeaturePluginResolution = {
    paths: ['/bundle/rpiv-ask-user-question', '/bundle/pi-subagents'],
    skipped: [],
  };

  async function servicesCall(
    features: BundledFeaturePluginResolution,
    harnessOptions: Parameters<typeof harness>[0] = {}
  ) {
    const h = harness(harnessOptions);
    await bootstrapPiAgentSession({
      sdk: h.sdk,
      cwd: '/repo',
      projectTrusted: false,
      extensionUi: h.extensionUi,
      decidePermissionGate: () => h.gate,
      resolveFeaturePlugins: () => features,
    });
    return (h.calls.services.mock.calls.at(-1)?.[0] as Record<string, unknown>)
      .resourceLoaderOptions as Record<string, unknown>;
  }

  it('appends them after the permission gate’s own path', async () => {
    // Order is not cosmetic: the gate's path stays first so a reader of the
    // Host log can tell the security injection from the feature ones.
    expect((await servicesCall(FEATURE)).additionalExtensionPaths).toEqual([
      '/bundle/pi-permission-system',
      '/bundle/rpiv-ask-user-question',
      '/bundle/pi-subagents',
    ]);
  });

  it('refuses the session when only a feature extension loaded', async () => {
    // THE fail-open trap. `verifyPermissionExtensionLoaded` accepts any path
    // under an injected root as proof the approval gate is running, so if the
    // feature paths were passed to it as well, this session — which loaded a
    // subagent extension and no permission system — would start and report
    // itself healthy.
    await expect(
      servicesCall(FEATURE, { loadedPaths: ['/bundle/pi-subagents/src/index.ts'] })
    ).rejects.toThrow(PermissionGateUnavailableError);
  });

  it('starts normally when a feature extension is missing', async () => {
    // Opposite posture from the permission system: one feature is gone, and
    // everything else is exactly as safe as it was.
    const skipped = {
      paths: [],
      skipped: [
        { package: '@gotgenes/pi-subagents', reason: 'not_present' as const, detail: 'no dir' },
      ],
    };
    const logged: unknown[][] = [];
    const h = harness();
    const result = await bootstrapPiAgentSession({
      sdk: h.sdk,
      cwd: '/repo',
      projectTrusted: false,
      extensionUi: h.extensionUi,
      decidePermissionGate: () => h.gate,
      resolveFeaturePlugins: () => skipped,
      log: (...args) => logged.push(args),
    });
    expect(result.permissionGate).toBe('bundled');
    // Silence here would make "the feature never appeared" undiagnosable.
    expect(logged.flat().join(' ')).toContain('@gotgenes/pi-subagents');
  });
});
