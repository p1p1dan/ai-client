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
/**
 * The environment `$NAME` header values expand from. Decision 171 removed the
 * one reference the catalog writers added (F08's `$AICLIENT_PI_USER_AGENT`);
 * kept here, set, so a writer that brought it back would show up in the plan.
 */
const ENV = { AICLIENT_PI_USER_AGENT: 'f08-reference-must-not-come-back/0' };

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
    // Decision 171 (GW-5): no User-Agent of the catalog is left to drop, and
    // every route relays the app's default (no version given here).
    expect(JSON.stringify(plan.dropped)).not.toContain('User-Agent');
    for (const route of Object.values(plan.routes)) {
      expect(route.headers).toEqual({ 'X-Aiclient-User-Agent': 'claude-cli-pilab' });
    }

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

  it('MP-05 plans the model settings panel through the real assembly (decision 168)', () => {
    const { plan } = assemble([
      userService('anthropic-messages', {
        models: ['claude-opus-5-5', 'claude-haiku-4-5'],
        modelMeta: {
          // The prefill a fresh selection gets: Low / Medium / High / Max.
          'claude-opus-5-5': {
            name: 'Opus 5.5',
            reasoning: true,
            adaptiveThinking: true,
            efforts: ['low', 'medium', 'high', 'max'],
          },
          'claude-haiku-4-5': {
            reasoning: true,
            adaptiveThinking: false,
            efforts: ['minimal', 'low', 'high'],
          },
        },
      }),
      userService('openai-completions', {
        models: ['deepseek-v4-pro', 'qwen3-local'],
        modelMeta: {
          'deepseek-v4-pro': {
            reasoning: true,
            compatPreset: 'deepseek',
            efforts: ['minimal', 'high', 'max'],
          },
          'qwen3-local': { reasoning: true, compatPreset: 'qwen-chat-template' },
        },
      }),
    ]);
    const anthropic = plan.routes['u-anthropic-messages'];
    expect(anthropic?.models).toEqual([
      {
        id: 'claude-opus-5-5',
        name: 'Opus 5.5',
        reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
        compat: { forceAdaptiveThinking: true },
      },
      {
        id: 'claude-haiku-4-5',
        reasoningEfforts: { minimal: 'minimal', low: 'low', high: 'high' },
      },
    ]);
    expect(plan.index['u-anthropic-messages/claude-opus-5-5']?.efforts).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ]);
    const completions = plan.routes['u-openai-completions'];
    expect(completions?.models).toEqual([
      {
        id: 'deepseek-v4-pro',
        reasoningEfforts: { minimal: 'minimal', high: 'high', max: 'max' },
        compat: {
          thinkingFormat: 'deepseek',
          supportsDeveloperRole: false,
          supportsStore: false,
          supportsReasoningEffort: true,
          maxTokensField: 'max_tokens',
          requiresReasoningContentOnAssistantMessages: true,
        },
      },
      {
        id: 'qwen3-local',
        reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
        compat: {
          thinkingFormat: 'qwen-chat-template',
          supportsDeveloperRole: false,
          supportsStore: false,
          supportsReasoningEffort: false,
          maxTokensField: 'max_tokens',
          requiresReasoningContentOnAssistantMessages: false,
        },
      },
    ]);
    expect(plan.index['u-openai-completions/deepseek-v4-pro']?.efforts).toEqual([
      'minimal',
      'high',
      'max',
    ]);
    // Nothing the rows carry is refused or unset; off is never declared.
    const fieldDrops = plan.dropped.flatMap((drop) =>
      drop.kind === 'field' && drop.providerId.startsWith('u-') ? [drop.reason] : []
    );
    expect(fieldDrops).not.toContain('compat_not_offered');
    expect(fieldDrops).not.toContain('compat_unset');
    expect(fieldDrops).not.toContain('adaptive_thinking_forced');
    for (const route of [anthropic, completions]) {
      for (const model of route?.models ?? []) {
        expect(model.reasoningEfforts && 'off' in model.reasoningEfforts).toBe(false);
      }
    }
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
    // Decision 159 adds the GW-16 mode line and decision 171 the User-Agent
    // line, once per revision as well.
    const leftOut = log.mock.calls.filter(
      ([first]) => first === '[dsh-model-plan] left out of the plan'
    );
    expect(leftOut).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(3);
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
        .filter((first): first is string => String(first).startsWith('[dsh-plan] cache_control'));
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

describe('User-Agent over the shipped catalog (decision 171, GitHub issue #7)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-model-plan-ua-'));
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
      userProviders: () => [userService('openai-completions')],
      managedCredentialsEnabled: () => true,
    }).buildNativeModelCatalog({ inheritedApiKey: CANARY, inheritedBaseUrl: LOGIN_BASE_URL });
  }
  const relayed = (plan: ReturnType<typeof resolveDshModelPlanWith>) =>
    new Set(Object.values(plan.routes).map((route) => route.headers?.['X-Aiclient-User-Agent']));

  it('relays one value on every route, company and user alike, beside X-Pilab-Client', () => {
    const native = nativeCatalog();
    const plan = resolveDshModelPlanWith({
      native,
      env: ENV,
      settings: {},
      clientVersion: '1.1.0-dsh.8',
    });
    expect(Object.keys(plan.routes)).toEqual([
      'claude',
      'gpt',
      'grok',
      'china',
      'u-openai-completions',
    ]);
    expect(relayed(plan)).toEqual(new Set(['claude-cli-pilab/1.1.0-dsh.8']));
    for (const route of Object.values(plan.routes)) {
      expect(route.headers?.['X-Pilab-Client']).toBe('1.1.0-dsh.8');
    }
    const custom = resolveDshModelPlanWith({
      native,
      env: ENV,
      settings: { userAgentMode: 'custom', userAgentCustom: 'pilab-gw/2' },
      clientVersion: '1.1.0-dsh.8',
    });
    expect(relayed(custom)).toEqual(new Set(['pilab-gw/2']));
    const engine = resolveDshModelPlanWith({
      native,
      env: ENV,
      settings: { userAgentMode: 'engine' },
      clientVersion: '1.1.0-dsh.8',
    });
    expect(relayed(engine)).toEqual(new Set([undefined]));
    expect(new Set([plan.revision, custom.revision, engine.revision]).size).toBe(3);
  });

  it('falls back on a bad custom value, and the log says so once per revision', () => {
    const native = nativeCatalog();
    const log = vi.fn();
    const bad = resolveDshModelPlanWith({
      native,
      env: ENV,
      settings: { userAgentMode: 'custom', userAgentCustom: 'pilab\tgw/2' },
      clientVersion: '1.1.0',
      log,
    });
    expect(relayed(bad)).toEqual(new Set(['claude-cli-pilab/1.1.0']));
    const lines = log.mock.calls.map(([first]) => String(first));
    expect(lines.filter((line) => line.startsWith('[dsh-plan] user agent'))).toEqual([
      `[dsh-plan] user agent: custom value unusable (invalid_character), sending the default (claude-cli-pilab/1.1.0), plan ${bad.revision.slice(0, 12)}`,
    ]);
    const leftOut = JSON.stringify(
      log.mock.calls.find(([first]) => first === '[dsh-model-plan] left out of the plan')
    );
    expect(leftOut).toContain('setting userAgent: invalid_user_agent (invalid_character)');
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
