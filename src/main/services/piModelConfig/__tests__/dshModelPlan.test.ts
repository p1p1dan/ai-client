import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDshPlanToCatalog, keyRefFor } from '@shared/dshModelPlan';
import { USER_PROVIDER_APIS } from '@shared/userProviders';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProvider } from '../../auth/CredentialVault';
import { validatePiManagedModelsConfig } from '../configValidation';
import { onDshModelPlanBuilt, providerKeyPresence, resolveDshModelPlanWith } from '../dshModelPlan';
import { PiModelConfigService } from '../PiModelConfigService';

/**
 * dsh-rebase P1-5a — the model plan built from Main's REAL in-memory assembly
 * (`buildNativeModelCatalog`: `toPiModelsJson` for the managed half, the user
 * services appended), as `readPiModelCatalog` / `resolveDshModelPlan` do.
 *
 * MP-01 pins the plan for the shipped catalog snapshot as a golden. Re-record
 * at closeout only:
 *   AICLIENT_UPDATE_FIXTURES=1 pnpm vitest run src/main/services/piModelConfig/__tests__/dshModelPlan.test.ts
 *   pnpm exec biome format --write src/main/services/piModelConfig/__tests__/fixtures
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../..');
const GOLDEN = join(HERE, 'fixtures', 'dshModelPlan.snapshot.json');
const UPDATE = Boolean(process.env.AICLIENT_UPDATE_FIXTURES);

const LOGIN_BASE_URL = 'https://gateway.example.test/v1';
const CANARY = 'sk-canary-p15a-7d1e';
const ENV = { AICLIENT_PI_USER_AGENT: 'claude-cli-pilab/0.0.0-test' };

const shippedSnapshot = () =>
  validatePiManagedModelsConfig(
    JSON.parse(readFileSync(join(REPO, 'resources/model-catalog/snapshot.json'), 'utf8')),
    { credentialsAllowed: false }
  );

function userService(api: string, extra: Partial<UserProvider> = {}): UserProvider {
  return {
    id: `00000000-0000-4000-8000-${api.length.toString().padStart(12, '0')}`,
    name: `U ${api}`,
    baseUrl: 'https://user.example.test/v1',
    api,
    apiKey: CANARY,
    models: ['u1'],
    enabled: true,
    createdAt: '2026-09-27T00:00:00.000Z',
    ...extra,
  };
}

describe('the DSH model plan over Main’s catalog assembly', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-model-plan-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function service(userProviders: UserProvider[] = []): PiModelConfigService {
    return new PiModelConfigService({
      agentDir: dir,
      fetchFn: async () => ({ ok: false, status: 500, text: async () => '' }),
      now: () => 1234,
      readBundledCatalog: shippedSnapshot,
      userProviders: () => userProviders,
      managedCredentialsEnabled: () => true,
    });
  }

  function assemble(userProviders: UserProvider[] = []) {
    const built = service(userProviders);
    const native = built.buildNativeModelCatalog({
      inheritedApiKey: CANARY,
      inheritedBaseUrl: LOGIN_BASE_URL,
    });
    const plan = resolveDshModelPlanWith({ native, env: ENV, settings: {} });
    return { built, native, plan };
  }

  it('MP-01 turns the shipped snapshot into 4 routes and 10 models, as the golden says', () => {
    const { plan } = assemble();
    expect(Object.keys(plan.routes)).toEqual(['claude', 'gpt', 'grok', 'china']);
    expect(Object.keys(plan.index)).toHaveLength(10);
    // ARD D15: anthropic at the service root, openai under /v1.
    expect(plan.routes.claude?.baseURL).toBe('https://gateway.example.test');
    for (const route of ['gpt', 'grok', 'china']) {
      expect(plan.routes[route]?.baseURL).toBe(LOGIN_BASE_URL);
    }
    expect(plan.routes.claude?.apiKeyEnv).toBe(keyRefFor('claude'));
    expect(Object.values(plan.refs)).toEqual(['claude', 'gpt', 'grok', 'china']);
    expect(plan.defaultModel).toEqual({ provider: 'claude', model: 'claude-sonnet-5' });
    expect(plan.dropped.filter((drop) => drop.kind === 'model')).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(CANARY);
    expect(JSON.stringify(plan)).not.toContain(ENV.AICLIENT_PI_USER_AGENT);

    if (UPDATE) {
      mkdirSync(path.dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(plan, null, 2)}\n`);
    }
    expect(plan).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });

  it('MP-05 drops seven of the ten user protocols through the real assembly', () => {
    const { plan } = assemble(USER_PROVIDER_APIS.map((api) => userService(api)));
    const userRoutes = Object.entries(plan.routes)
      .filter(([key]) => key.startsWith('u-'))
      .map(([key, route]) => [key, route.api]);
    expect(userRoutes).toEqual([
      ['u-openai-completions', 'openai-completions'],
      ['u-openai-responses', 'openai-responses'],
      ['u-anthropic-messages', 'anthropic-messages'],
    ]);
    const dropped = plan.dropped.filter((drop) => drop.kind === 'model');
    expect(dropped).toHaveLength(7);
    expect(new Set(dropped.map((drop) => drop.reason))).toEqual(new Set(['unsupported_api']));
    expect(JSON.stringify(plan)).not.toContain(CANARY);
  });

  it('MP-05 gives user metadata reasoning:true the three levels and the route defaults', () => {
    const { plan } = assemble([
      userService('openai-completions', {
        models: ['think', 'sized'],
        modelMeta: { think: { reasoning: true }, sized: { contextWindow: 32000, maxTokens: 4096 } },
      }),
    ]);
    const route = plan.routes['u-openai-completions'];
    expect(route).toMatchObject({ defaultContextWindow: 128000, defaultMaxTokens: 8192 });
    expect(route?.models).toEqual([
      { id: 'think', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' } },
      { id: 'sized', contextWindow: 32000, maxTokens: 4096, reasoningEfforts: false },
    ]);
  });

  it('MP-05 plans a user row with the adaptive thinking switch as forced, with no advisory (decision 165)', () => {
    const { plan } = assemble([
      userService('anthropic-messages', {
        models: ['claude-opus-5-5', 'claude-sonnet-4-5'],
        modelMeta: {
          'claude-opus-5-5': { reasoning: true, adaptiveThinking: true },
          'claude-sonnet-4-5': { reasoning: true },
        },
      }),
    ]);
    const route = plan.routes['u-anthropic-messages'];
    expect(route?.models).toEqual([
      {
        id: 'claude-opus-5-5',
        reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
        compat: { forceAdaptiveThinking: true },
      },
      {
        id: 'claude-sonnet-4-5',
        reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
      },
    ]);
    expect(plan.index['u-anthropic-messages/claude-opus-5-5']?.efforts).toEqual([
      'low',
      'medium',
      'high',
    ]);
    const advisories = plan.dropped.flatMap((drop) =>
      drop.kind === 'field' && drop.providerId === 'u-anthropic-messages' && drop.modelId
        ? [`${drop.modelId}: ${drop.reason}`]
        : []
    );
    // The switched-on row is not undeclared; the row without it still is.
    expect(advisories).toEqual(['claude-sonnet-4-5: adaptive_thinking_undeclared']);
  });

  it('drops a user service with no key, and only that one', () => {
    const { plan } = assemble([userService('openai-completions', { apiKey: '' })]);
    expect(plan.routes['u-openai-completions']).toBeUndefined();
    expect(plan.dropped).toContainEqual({
      kind: 'model',
      providerId: 'u-openai-completions',
      modelId: 'u1',
      reason: 'no_api_key',
    });
    expect(Object.keys(plan.routes)).toEqual(['claude', 'gpt', 'grok', 'china']);
  });

  it('MN-01 the menu lists what the plan routes, in catalog order, and counts the rest', () => {
    const { built, native, plan } = assemble([
      userService('google-generative-ai', { name: 'Gem', models: ['g1', 'g2'] }),
      userService('openai-responses', { name: 'Own', models: ['o1'] }),
    ]);
    const menu = applyDshPlanToCatalog(built.readCatalog('local', native), plan);
    expect(menu.models.map((model) => model.id)).toEqual(Object.keys(plan.index));
    expect(menu.models).toHaveLength(11);
    expect(menu.models.at(-1)?.id).toBe('own/o1');
    expect(menu.unavailable).toEqual([
      { label: 'g1', reason: 'unsupported_api' },
      { label: 'g2', reason: 'unsupported_api' },
    ]);
    const china = menu.models.find((model) => model.id === 'china/glm-5.2');
    expect(china?.efforts).toEqual(['low', 'medium', 'high', 'max']);
    expect(JSON.stringify(menu)).not.toContain(CANARY);
  });

  it('builds an empty plan, and an empty menu, when no catalog could be assembled', () => {
    const plan = resolveDshModelPlanWith({ native: undefined, env: ENV, settings: {} });
    expect(plan.routes).toEqual({});
    expect(plan.defaultModel).toEqual({ provider: 'aiclient-none', model: 'none' });
    const menu = applyDshPlanToCatalog(
      {
        models: [{ id: 'claude/claude-sonnet-5', label: 'Claude Sonnet 5' }],
        source: 'local',
        stale: false,
        fetchedAt: 1,
      },
      plan
    );
    expect(menu.models).toEqual([]);
    expect(menu.unavailable).toEqual([{ label: 'Claude Sonnet 5', reason: 'not_in_plan' }]);
  });

  it('logs what it left out once per revision, with ids and reasons only', () => {
    const log = vi.fn();
    const native = service([userService('pi-messages')]).buildNativeModelCatalog({
      inheritedApiKey: CANARY,
      inheritedBaseUrl: LOGIN_BASE_URL,
    });
    resolveDshModelPlanWith({ native, env: ENV, settings: { promptCacheTtl: '5m' }, log });
    resolveDshModelPlanWith({ native, env: ENV, settings: { promptCacheTtl: '5m' }, log });
    // Decision 159 adds the GW-16 mode line, once per revision as well.
    const leftOut = log.mock.calls.filter(
      ([first]) => first === '[dsh-model-plan] left out of the plan'
    );
    expect(leftOut).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(leftOut);
    expect(logged).toContain('u-pi-messages/u1: unsupported_api (pi-messages)');
    expect(logged).toContain('compat.supportsToolReferences: compat_not_offered');
    // Decision 146 (GW-4): the shipped catalog's Grok row reserves its whole window.
    expect(logged).toContain('grok/grok-4.6 maxTokens: max_tokens_clamped (500000 -> 125000)');
    expect(logged).not.toContain(CANARY);
  });
});

describe('GW-16 cache_control on tools over the shipped catalog (decision 159)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-model-plan-gw16-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function nativeCatalog() {
    return new PiModelConfigService({
      agentDir: dir,
      fetchFn: async () => ({ ok: false, status: 500, text: async () => '' }),
      now: () => 1234,
      readBundledCatalog: shippedSnapshot,
      userProviders: () => [userService('anthropic-messages')],
      managedCredentialsEnabled: () => true,
    }).buildNativeModelCatalog({ inheritedApiKey: CANARY, inheritedBaseUrl: LOGIN_BASE_URL });
  }

  it('says false on the claude route and the user anthropic service by default; on restores the old plan', () => {
    const native = nativeCatalog();
    const off = resolveDshModelPlanWith({ native, env: ENV, settings: {} });
    const on = resolveDshModelPlanWith({
      native,
      env: ENV,
      settings: { cacheControlOnTools: true },
    });
    expect(off.routes.claude?.compat).toEqual({
      forceAdaptiveThinking: true,
      supportsCacheControlOnTools: false,
    });
    expect(off.routes['u-anthropic-messages']?.compat).toEqual({
      supportsCacheControlOnTools: false,
    });
    expect(on.routes.claude?.compat).toEqual({ forceAdaptiveThinking: true });
    expect(on.routes['u-anthropic-messages']?.compat).toBeUndefined();
    // The other protocols plan the same either way.
    for (const route of ['gpt', 'grok', 'china']) {
      expect(off.routes[route]).toEqual(on.routes[route]);
    }
    expect(off.revision).not.toBe(on.revision);
  });

  it('announces the flipped plan to the host side and logs the mode once per revision', () => {
    const native = nativeCatalog();
    const log = vi.fn();
    const announced: string[] = [];
    const stop = onDshModelPlanBuilt((plan) => announced.push(plan.revision));
    try {
      const off = resolveDshModelPlanWith({ native, env: ENV, settings: {}, log });
      resolveDshModelPlanWith({ native, env: ENV, settings: {}, log });
      const on = resolveDshModelPlanWith({
        native,
        env: ENV,
        settings: { cacheControlOnTools: true },
        log,
      });
      // `WorkerManager.reconcileModelPlan` gets every revision, the new one last.
      expect(announced).toEqual([off.revision, off.revision, on.revision]);
      const modes = log.mock.calls
        .map(([first]) => first)
        .filter((first): first is string => String(first).startsWith('[dsh-plan]'));
      expect(modes).toEqual([
        `[dsh-plan] cache_control on tools: off (2 breakpoints max), plan ${off.revision.slice(0, 12)}`,
        `[dsh-plan] cache_control on tools: on (3 breakpoints max), plan ${on.revision.slice(0, 12)}`,
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(CANARY);
    } finally {
      stop();
    }
  });
});

describe('providerKeyPresence', () => {
  it('answers yes/no per provider and nothing else', () => {
    expect(
      providerKeyPresence({
        a: { type: 'api_key', key: CANARY },
        b: { type: 'api_key', key: '' },
        c: { type: 'api_key', key: '   ' },
        d: {},
        e: null,
      })
    ).toEqual({ a: true, b: false, c: false, d: false, e: false });
    expect(providerKeyPresence(undefined)).toEqual({});
  });
});
