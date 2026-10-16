import { describe, expect, it } from 'vitest';
import {
  CLAUDE_SDK_ENGINE_SETTING_KEY,
  CLAUDE_SDK_INHERITED_ENV,
  claudeSdkRouteFor,
  DEFAULT_CLAUDE_SDK_ENGINE_ENABLED,
  effectiveModelRef,
  isClaudeFamilyModelId,
  resolveClaudeSdkEngineEnabled,
} from '../claudeSdkEngine';
import type { DshModelPlan, DshPlanRoute } from '../dshModelPlan/types';

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

const plan: Pick<DshModelPlan, 'index' | 'routes' | 'refs'> = {
  index: {
    'claude/claude-opus-5': { route: 'claude', model: 'claude-opus-5', efforts: [], image: true },
    'zai/glm-5': { route: 'zai', model: 'glm-5', efforts: [], image: false },
    'proxy/claude-sonnet-5': { route: 'proxy', model: 'claude-sonnet-5', efforts: [], image: true },
    'orphan/claude-haiku-5': { route: 'orphan', model: 'claude-haiku-5', efforts: [], image: true },
  },
  routes: {
    claude: route('anthropic-messages', 'https://gw.example', 'AICLIENT_KEY_CLAUDE'),
    // An Anthropic-compatible endpoint serving GLM: stays on DSH.
    zai: route('anthropic-messages', 'https://glm.example/anthropic', 'AICLIENT_KEY_ZAI'),
    // A Claude-named model behind an OpenAI-shaped endpoint: the CLI cannot speak it.
    proxy: route('openai-completions', 'https://proxy.example/v1', 'AICLIENT_KEY_PROXY'),
    orphan: route('anthropic-messages', 'https://orphan.example', 'AICLIENT_KEY_ORPHAN'),
  },
  refs: {
    AICLIENT_KEY_CLAUDE: 'claude',
    AICLIENT_KEY_ZAI: 'zai',
    AICLIENT_KEY_PROXY: 'proxy',
  },
};

describe('claudeSdkRouteFor', () => {
  it('serves a Claude model on an anthropic-messages route', () => {
    expect(claudeSdkRouteFor(plan, 'claude/claude-opus-5')).toEqual({
      route: 'claude',
      providerId: 'claude',
      baseURL: 'https://gw.example',
      model: 'claude-opus-5',
    });
  });

  it('leaves other models, other protocols and unknown refs to DSH', () => {
    expect(claudeSdkRouteFor(plan, 'zai/glm-5')).toBeNull();
    expect(claudeSdkRouteFor(plan, 'proxy/claude-sonnet-5')).toBeNull();
    expect(claudeSdkRouteFor(plan, 'claude/claude-unknown')).toBeNull();
    expect(claudeSdkRouteFor(plan, undefined)).toBeNull();
    expect(claudeSdkRouteFor(plan, '')).toBeNull();
  });

  it('refuses a route whose key owner is not named in the plan', () => {
    expect(claudeSdkRouteFor(plan, 'orphan/claude-haiku-5')).toBeNull();
  });

  it('does not read inherited properties as plan entries', () => {
    expect(claudeSdkRouteFor(plan, 'constructor')).toBeNull();
    expect(claudeSdkRouteFor(plan, '__proto__')).toBeNull();
  });
});

describe('effectiveModelRef', () => {
  it('keeps an explicit ref and falls back to the first indexed model', () => {
    expect(effectiveModelRef(plan, ' zai/glm-5 ')).toBe('zai/glm-5');
    expect(effectiveModelRef(plan, undefined)).toBe('claude/claude-opus-5');
    expect(effectiveModelRef({ index: {} }, null)).toBeUndefined();
  });
});

describe('the settings switch', () => {
  it('is on unless a real boolean says otherwise', () => {
    expect(CLAUDE_SDK_ENGINE_SETTING_KEY).toBe('claudeSdkEngineEnabled');
    expect(DEFAULT_CLAUDE_SDK_ENGINE_ENABLED).toBe(true);
    expect(resolveClaudeSdkEngineEnabled(undefined)).toBe(true);
    expect(resolveClaudeSdkEngineEnabled('false')).toBe(true);
    expect(resolveClaudeSdkEngineEnabled(false)).toBe(false);
    expect(resolveClaudeSdkEngineEnabled(true)).toBe(true);
  });
});

describe('isClaudeFamilyModelId', () => {
  it('matches the provider-side id prefix only', () => {
    expect(isClaudeFamilyModelId('claude-opus-5')).toBe(true);
    expect(isClaudeFamilyModelId('Claude-Sonnet-5')).toBe(true);
    expect(isClaudeFamilyModelId('glm-5')).toBe(false);
    expect(isClaudeFamilyModelId('my-claude-proxy')).toBe(false);
  });
});

describe('CLAUDE_SDK_INHERITED_ENV', () => {
  it('passes the trust store the DSH host gets, and never a credential or Claude variable', () => {
    expect(CLAUDE_SDK_INHERITED_ENV).toContain('NODE_EXTRA_CA_CERTS');
    expect(CLAUDE_SDK_INHERITED_ENV).toContain('NODE_USE_SYSTEM_CA');
    for (const name of CLAUDE_SDK_INHERITED_ENV) {
      expect(name).toBe(name.toUpperCase());
      expect(name).not.toMatch(/^(ANTHROPIC|CLAUDE)_|KEY|TOKEN|SECRET|PASSWORD|NODE_OPTIONS/);
    }
  });
});
