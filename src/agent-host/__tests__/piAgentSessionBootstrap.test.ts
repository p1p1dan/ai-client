import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

function harness(
  options: {
    bindExtensions?: boolean;
    loadedPermission?: boolean;
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
              extensions:
                options.loadedPermission === false
                  ? [{ path: '/other/extension.ts' }]
                  : [{ path: '/bundle/pi-permission-system/src/index.ts' }],
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
      })
    ).rejects.toMatchObject({ code: 'extension_bind_unsupported' });
    expect(h.calls.runtimeDispose).toHaveBeenCalledTimes(1);
  });
});

function modelShape() {
  return { provider: 'pilab', id: 'company-model' };
}
