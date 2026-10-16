import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DshModelPlan, DshPlanRoute } from '@shared/dshModelPlan/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_SDK_CREDENTIALS_UNAVAILABLE,
  CLAUDE_SDK_HOST_UNAVAILABLE,
  type ClaudeSdkPlanView,
  chooseNewChatEngine,
  claudeSdkCliCandidates,
  claudeSdkGatewayFingerprint,
  claudeSdkHostEntry,
  claudeSdkLaunchFor,
  claudeSdkRouteByName,
  claudeSdkStubModel,
  createClaudeSdkHostAvailability,
  currentClaudeSdkFingerprint,
  engineForSessionFile,
  openClaudeSdkTransport,
  resolveClaudeSdkLaunch,
} from '../claudeSdkEngine';
import { WorkerManagerError } from '../workerManagerError';

/**
 * Route B, S-1 (docs/plantree/plans/claude-sdk-engine/topics/s1-engine-selection.md
 * §3, Main): which engine a chat gets, what a reopened SDK chat starts on, the
 * gateway fingerprint, host availability, and the launch's refusals. Pure
 * functions with injected sources; no process is ever started here.
 */

const electron = vi.hoisted(() => ({ appPath: '' }));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => electron.appPath,
    getVersion: () => '0.0.0-test',
    getPath: () => tmpdir(),
  },
}));

function route(api: DshPlanRoute['api'], baseURL: string, apiKeyEnv: string): DshPlanRoute {
  return {
    api,
    baseURL,
    apiKeyEnv,
    defaultContextWindow: 200_000,
    defaultMaxTokens: 32_000,
    models: [],
  } as unknown as DshPlanRoute;
}

/** GLM on the OpenAI protocol first, so "automatic" lands on DSH unless a test reorders the index. */
const PLAN: Pick<DshModelPlan, 'index' | 'routes' | 'refs'> = {
  index: {
    'zai/glm-5': { route: 'zai', model: 'glm-5', efforts: [], image: false },
    'claude/claude-opus-5': { route: 'claude', model: 'claude-opus-5', efforts: [], image: true },
    'claude/claude-sonnet-5': {
      route: 'claude',
      model: 'claude-sonnet-5',
      efforts: [],
      image: true,
    },
    'other/claude-haiku-5': { route: 'other', model: 'claude-haiku-5', efforts: [], image: true },
    'proxy/claude-sonnet-5': { route: 'proxy', model: 'claude-sonnet-5', efforts: [], image: true },
    'zaia/glm-5': { route: 'zaia', model: 'glm-5', efforts: [], image: false },
  },
  routes: {
    zai: route('openai-completions', 'https://glm.example/v1', 'AICLIENT_KEY_ZAI'),
    zaia: route('anthropic-messages', 'https://glm.example/anthropic', 'AICLIENT_KEY_ZAIA'),
    claude: route('anthropic-messages', 'https://gw.example', 'AICLIENT_KEY_CLAUDE'),
    other: route('anthropic-messages', 'https://other.example', 'AICLIENT_KEY_OTHER'),
    proxy: route('openai-completions', 'https://proxy.example/v1', 'AICLIENT_KEY_PROXY'),
  },
  refs: {
    AICLIENT_KEY_ZAI: 'zai',
    AICLIENT_KEY_CLAUDE: 'claude',
    AICLIENT_KEY_OTHER: 'other',
    AICLIENT_KEY_PROXY: 'proxy',
    AICLIENT_KEY_ZAIA: 'zaia',
  },
};

/** The same plan with a Claude model first: "automatic" is a Claude chat. */
const CLAUDE_FIRST: ClaudeSdkPlanView = {
  ...PLAN,
  index: {
    'claude/claude-opus-5': PLAN.index['claude/claude-opus-5'],
    ...PLAN.index,
  } as ClaudeSdkPlanView['index'],
};

function source(
  overrides: Partial<{
    enabled: boolean;
    plan: ClaudeSdkPlanView | null | (() => ClaudeSdkPlanView | null);
    hostAvailable: boolean;
  }> = {}
) {
  const plan = overrides.plan === undefined ? PLAN : overrides.plan;
  return {
    enabled: vi.fn(() => overrides.enabled ?? true),
    plan: vi.fn(typeof plan === 'function' ? plan : () => plan),
    hostAvailable: vi.fn(() => overrides.hostAvailable ?? true),
  };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkerManagerError);
    expect((error as WorkerManagerError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('chooseNewChatEngine (decision 1)', () => {
  it('runs a Claude model on an anthropic-messages route on the SDK engine, with that model', () => {
    expect(chooseNewChatEngine('claude/claude-opus-5', source())).toEqual({
      engine: 'claude-sdk',
      model: 'claude/claude-opus-5',
      route: {
        route: 'claude',
        providerId: 'claude',
        baseURL: 'https://gw.example',
        model: 'claude-opus-5',
      },
    });
  });

  it('switch off: DSH, without reading the plan', () => {
    const off = source({ enabled: false });
    expect(chooseNewChatEngine('claude/claude-opus-5', off)).toEqual({ engine: 'dsh' });
    expect(off.plan).not.toHaveBeenCalled();
    expect(off.hostAvailable).not.toHaveBeenCalled();
  });

  it('no SDK host in this build: DSH', () => {
    expect(chooseNewChatEngine('claude/claude-opus-5', source({ hostAvailable: false }))).toEqual({
      engine: 'dsh',
    });
  });

  it('the protocol decides: any model on an Anthropic route runs on the SDK engine', () => {
    expect(chooseNewChatEngine('zaia/glm-5', source())).toMatchObject({
      engine: 'claude-sdk',
      model: 'zaia/glm-5',
      route: { route: 'zaia', providerId: 'zaia' },
    });
  });

  it('a model on another protocol, a Claude name behind OpenAI included, stays on DSH', () => {
    for (const model of ['zai/glm-5', 'proxy/claude-sonnet-5', 'claude/claude-unknown']) {
      const s = source();
      expect(chooseNewChatEngine(model, s), model).toEqual({ engine: 'dsh' });
      // Availability is only asked for a model the SDK would serve.
      expect(s.hostAvailable).not.toHaveBeenCalled();
    }
  });

  it('"automatic" follows the plan’s first model and hands it over explicitly', () => {
    expect(chooseNewChatEngine(undefined, source())).toEqual({ engine: 'dsh' });
    expect(chooseNewChatEngine(undefined, source({ plan: CLAUDE_FIRST }))).toMatchObject({
      engine: 'claude-sdk',
      model: 'claude/claude-opus-5',
    });
    expect(chooseNewChatEngine('  ', source({ plan: CLAUDE_FIRST }))).toMatchObject({
      engine: 'claude-sdk',
      model: 'claude/claude-opus-5',
    });
  });

  it('no plan to be had, or no source at all: DSH', () => {
    expect(chooseNewChatEngine('claude/claude-opus-5', source({ plan: null }))).toEqual({
      engine: 'dsh',
    });
    const throwing = source({
      plan: () => {
        throw new Error('keyring locked');
      },
    });
    expect(chooseNewChatEngine('claude/claude-opus-5', throwing)).toEqual({ engine: 'dsh' });
    expect(chooseNewChatEngine('claude/claude-opus-5', null)).toEqual({ engine: 'dsh' });
  });
});

describe('engineForSessionFile (decision 2)', () => {
  it('reads the engine off the stub suffix, nothing else', () => {
    expect(engineForSessionFile('/home/a/aiclient-sessions/x.ccsdk.json')).toBe('claude-sdk');
    expect(engineForSessionFile('/home/a/sessions/x.dsh.json')).toBe('dsh');
    expect(engineForSessionFile('/home/a/sessions/x.jsonl')).toBe('dsh');
    expect(engineForSessionFile(null)).toBe('dsh');
    expect(engineForSessionFile(undefined)).toBe('dsh');
  });
});

describe('the model a reopened SDK chat starts on (decision 2)', () => {
  const readStub = (stub: unknown) => vi.fn(async () => stub);

  it('reads the stub’s model, tolerating older and broken stubs', () => {
    expect(claudeSdkStubModel({ model: ' claude/claude-opus-5 ' })).toBe('claude/claude-opus-5');
    for (const stub of [undefined, null, 'x', {}, { model: '' }, { model: 3 }]) {
      expect(claudeSdkStubModel(stub)).toBeUndefined();
    }
  });

  it('the request’s model first, when the SDK serves it — the stub is not even read', async () => {
    const read = readStub({ model: 'claude/claude-sonnet-5' });
    await expect(
      resolveClaudeSdkLaunch({
        plan: PLAN,
        sessionFile: '/s/a.ccsdk.json',
        readStub: read,
        preferred: 'other/claude-haiku-5',
      })
    ).resolves.toMatchObject({ model: 'other/claude-haiku-5', route: { route: 'other' } });
    expect(read).not.toHaveBeenCalled();
  });

  it('then the stub’s model, when the request names one the SDK does not serve', async () => {
    const read = readStub({ model: 'claude/claude-sonnet-5' });
    await expect(
      resolveClaudeSdkLaunch({
        plan: PLAN,
        sessionFile: '/s/a.ccsdk.json',
        readStub: read,
        preferred: 'zai/glm-5',
      })
    ).resolves.toMatchObject({ model: 'claude/claude-sonnet-5', route: { route: 'claude' } });
    expect(read).toHaveBeenCalledWith('/s/a.ccsdk.json');
  });

  it('then the fallback, then the plan’s first SDK model, for a missing or older stub', async () => {
    const missing = vi.fn(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await expect(
      resolveClaudeSdkLaunch({
        plan: PLAN,
        sessionFile: '/s/a.ccsdk.json',
        readStub: missing,
        fallback: 'other/claude-haiku-5',
      })
    ).resolves.toMatchObject({ model: 'other/claude-haiku-5' });
    await expect(
      resolveClaudeSdkLaunch({ plan: PLAN, sessionFile: '/s/a.ccsdk.json', readStub: readStub({}) })
    ).resolves.toMatchObject({ model: 'claude/claude-opus-5', route: { route: 'claude' } });
    // A stub naming a model the plan no longer serves only skips its step.
    await expect(
      resolveClaudeSdkLaunch({
        plan: PLAN,
        sessionFile: '/s/a.ccsdk.json',
        readStub: readStub({ model: 'gone/claude-old' }),
      })
    ).resolves.toMatchObject({ model: 'claude/claude-opus-5' });
  });

  it('nothing the SDK serves, or no plan: claude_sdk_credentials_unavailable', async () => {
    const glmOnly: ClaudeSdkPlanView = {
      ...PLAN,
      index: { 'zai/glm-5': PLAN.index['zai/glm-5'] } as ClaudeSdkPlanView['index'],
    };
    for (const plan of [glmOnly, null]) {
      await expect(
        resolveClaudeSdkLaunch({
          plan,
          sessionFile: '/s/a.ccsdk.json',
          readStub: readStub({ model: 'claude/claude-opus-5' }),
          preferred: 'claude/claude-opus-5',
        })
      ).rejects.toMatchObject({ code: CLAUDE_SDK_CREDENTIALS_UNAVAILABLE });
    }
    expectCode(() => claudeSdkLaunchFor(null, []), CLAUDE_SDK_CREDENTIALS_UNAVAILABLE);
  });
});

describe('the gateway an SDK chat runs on (decisions 3, 4)', () => {
  it('finds a route the SDK can reach by its name', () => {
    expect(claudeSdkRouteByName(PLAN, 'claude')).toEqual({
      route: 'claude',
      providerId: 'claude',
      baseURL: 'https://gw.example',
    });
    expect(claudeSdkRouteByName(PLAN, 'proxy')).toBeNull();
    expect(claudeSdkRouteByName(PLAN, 'gone')).toBeNull();
    expect(claudeSdkRouteByName(PLAN, '__proto__')).toBeNull();
    expect(claudeSdkRouteByName({ ...PLAN, refs: {} }, 'claude')).toBeNull();
  });

  it('fingerprints route, address and key without carrying the key', () => {
    const gateway = { route: 'claude', baseURL: 'https://gw.example' };
    const print = claudeSdkGatewayFingerprint(gateway, 'sk-secret-1');
    expect(print).toBe(claudeSdkGatewayFingerprint(gateway, 'sk-secret-1'));
    expect(print).not.toContain('sk-secret-1');
    expect(print).not.toBe(claudeSdkGatewayFingerprint(gateway, 'sk-secret-2'));
    expect(print).not.toBe(
      claudeSdkGatewayFingerprint({ ...gateway, baseURL: 'https://gw2.example' }, 'sk-secret-1')
    );
    expect(print).not.toBe(
      claudeSdkGatewayFingerprint({ ...gateway, route: 'claude~2' }, 'sk-secret-1')
    );
  });

  it('reads the current fingerprint from the plan and the key now; none when either is gone', () => {
    const keys: Record<string, string> = { claude: 'sk-secret-1' };
    const now = { plan: () => PLAN, key: (id: string) => keys[id] };
    expect(currentClaudeSdkFingerprint(now, 'claude')).toBe(
      claudeSdkGatewayFingerprint({ route: 'claude', baseURL: 'https://gw.example' }, 'sk-secret-1')
    );
    expect(currentClaudeSdkFingerprint(now, 'other')).toBeNull();
    expect(currentClaudeSdkFingerprint({ ...now, plan: () => null }, 'claude')).toBeNull();
    expect(
      currentClaudeSdkFingerprint(
        {
          ...now,
          plan: () => {
            throw new Error('no catalog');
          },
        },
        'claude'
      )
    ).toBeNull();
  });
});

describe('host availability (decision 1)', () => {
  it('needs the host entry, its SDK package and the CLI binary, and logs a missing host once', () => {
    const present = new Set<string>();
    const log = vi.fn();
    const available = createClaudeSdkHostAvailability({
      appPath: () => '/app',
      exists: (file) => present.has(file),
      log,
      platform: 'win32',
      arch: 'x64',
      env: {},
    });
    expect(available()).toBe(false);
    expect(available()).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('new chats run on DSH');
    expect(log.mock.calls[0]?.[0]).not.toMatch(/Claude Code/);
    const entry = claudeSdkHostEntry('/app');
    present.add(entry);
    expect(available()).toBe(false);
    present.add(
      path.join(
        path.dirname(entry),
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk',
        'package.json'
      )
    );
    // No CLI binary yet: a host that would start and then fail every first turn.
    expect(available()).toBe(false);
    present.add(
      path.join(
        path.dirname(entry),
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk-win32-x64',
        'claude.exe'
      )
    );
    expect(available()).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('looks for the CLI where the SDK would start it', () => {
    const modules = path.join('/h', 'node_modules', '@anthropic-ai');
    expect(claudeSdkCliCandidates(modules, 'linux', 'arm64', {})).toEqual([
      path.join(modules, 'claude-agent-sdk-linux-arm64', 'claude'),
      path.join(modules, 'claude-agent-sdk-linux-arm64-musl', 'claude'),
    ]);
    expect(claudeSdkCliCandidates(modules, 'win32', 'x64', {})).toEqual([
      path.join(modules, 'claude-agent-sdk-win32-x64', 'claude.exe'),
    ]);
    // The dev override is the only place then.
    expect(
      claudeSdkCliCandidates(modules, 'win32', 'x64', {
        AICLIENT_CLAUDE_SDK_CLI: ' D:cliclaude.exe ',
      })
    ).toEqual(['D:cliclaude.exe']);
  });

  it('an app path that cannot be read is no host', () => {
    const available = createClaudeSdkHostAvailability({
      appPath: () => {
        throw new Error('no app');
      },
    });
    expect(available()).toBe(false);
  });
});

describe('openClaudeSdkTransport refusals (no process is started)', () => {
  let dir: string;
  const originalNode = process.env.AICLIENT_DSH_NODE;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'aiclient-claude-sdk-engine-'));
    electron.appPath = path.join(dir, 'app');
    mkdirSync(electron.appPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalNode === undefined) delete process.env.AICLIENT_DSH_NODE;
    else process.env.AICLIENT_DSH_NODE = originalNode;
  });

  it('a missing key or gateway is claude_sdk_credentials_unavailable', () => {
    for (const gateway of [
      { baseURL: 'https://gw.example', apiKey: '' },
      { baseURL: 'https://gw.example', apiKey: '   ' },
      { baseURL: '', apiKey: 'sk-secret-1' },
    ]) {
      expectCode(
        () => openClaudeSdkTransport({ generation: 1, cwd: dir, ...gateway }),
        CLAUDE_SDK_CREDENTIALS_UNAVAILABLE
      );
    }
  });

  it('no Node runtime, or no host entry: claude_sdk_host_unavailable', () => {
    delete process.env.AICLIENT_DSH_NODE;
    const input = { generation: 1, cwd: dir, baseURL: 'https://gw.example', apiKey: 'sk-1' };
    expectCode(() => openClaudeSdkTransport(input), CLAUDE_SDK_HOST_UNAVAILABLE);
    // A runtime and the DSH entry, but no SDK host entry.
    process.env.AICLIENT_DSH_NODE = process.execPath;
    mkdirSync(path.join(electron.appPath, 'src', 'dsh-host'), { recursive: true });
    writeFileSync(path.join(electron.appPath, 'src', 'dsh-host', 'host.ts'), '');
    try {
      openClaudeSdkTransport(input);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toMatchObject({ code: CLAUDE_SDK_HOST_UNAVAILABLE });
      expect((error as Error).message).toContain(claudeSdkHostEntry(electron.appPath));
      expect((error as Error).message).not.toContain('sk-1');
    }
  });

  it('a missing workspace keeps the code the renderer already knows', () => {
    expect(() =>
      openClaudeSdkTransport({
        generation: 1,
        cwd: path.join(dir, 'gone'),
        baseURL: 'https://gw.example',
        apiKey: 'sk-1',
      })
    ).toThrow(/^WORKER_WORKSPACE_MISSING: /);
  });
});
