import { describe, expect, it } from 'vitest';
import {
  CLAUDE_SDK_ENGINE_SETTING_KEY,
  CLAUDE_SDK_INHERITED_ENV,
  claudeSdkModelThinking,
  claudeSdkModelWindows,
  claudeSdkRouteFor,
  DEFAULT_CLAUDE_SDK_ENGINE_ENABLED,
  effectiveModelRef,
  parseClaudeSdkModelThinking,
  parseClaudeSdkModelWindows,
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
    // An Anthropic-compatible endpoint serving GLM: the SDK engine serves it.
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

  it('serves any model on an anthropic-messages route, a GLM behind a compatible endpoint too', () => {
    expect(claudeSdkRouteFor(plan, 'zai/glm-5')).toEqual({
      route: 'zai',
      providerId: 'zai',
      baseURL: 'https://glm.example/anthropic',
      model: 'glm-5',
    });
  });

  it('leaves other protocols and unknown refs to DSH', () => {
    // A Claude-named model behind an OpenAI-shaped endpoint: the protocol decides, not the name.
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

describe('claudeSdkModelWindows (catalog windows the CLI never reads, user 2026-10-18)', () => {
  const windowed = {
    routes: {
      claude: {
        ...route('anthropic-messages', 'https://gw.example', 'AICLIENT_KEY_CLAUDE'),
        models: [
          // The administrator holds a 1M Claude 5 model to 200k.
          { id: 'claude-opus-5-5', contextWindow: 200_000, reasoningEfforts: false },
          { id: 'claude-sonnet-5-5', contextWindow: 1_000_000, reasoningEfforts: false },
          { id: 'claude-opus-5', contextWindow: 1_050_000, reasoningEfforts: false },
          // No declared window: nothing to carry.
          { id: 'claude-haiku-5-5', reasoningEfforts: false },
          { id: 'glm-small', contextWindow: 64_000, reasoningEfforts: false },
        ],
      } as DshPlanRoute,
    },
  };

  it('carries every declared window as declared (the host decides what the CLI is told)', () => {
    expect(claudeSdkModelWindows(windowed, 'claude')).toEqual({
      'claude-opus-5-5': 200_000,
      'claude-sonnet-5-5': 1_000_000,
      'claude-opus-5': 1_050_000,
      'glm-small': 64_000,
    });
  });

  it('is empty for an unknown route, an inherited key, or no plan', () => {
    expect(claudeSdkModelWindows(windowed, 'zai')).toEqual({});
    expect(claudeSdkModelWindows(windowed, 'constructor')).toEqual({});
    expect(claudeSdkModelWindows(null, 'claude')).toEqual({});
  });

  it('round-trips through the launch variable and drops anything malformed', () => {
    const windows = claudeSdkModelWindows(windowed, 'claude');
    expect(parseClaudeSdkModelWindows(JSON.stringify(windows))).toEqual(windows);
    expect(parseClaudeSdkModelWindows(undefined)).toEqual({});
    expect(parseClaudeSdkModelWindows('not json')).toEqual({});
    expect(parseClaudeSdkModelWindows('[200000]')).toEqual({});
    expect(
      parseClaudeSdkModelWindows(
        JSON.stringify({
          a: 200_000.5,
          b: '200000',
          c: -5,
          d: 0,
          '': 200_000,
          e: 2_000_000,
        })
      )
    ).toEqual({ e: 2_000_000 });
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

describe('CLAUDE_SDK_INHERITED_ENV', () => {
  it('passes the trust store the DSH host gets, and never a credential or Claude variable', () => {
    expect(CLAUDE_SDK_INHERITED_ENV).toContain('NODE_EXTRA_CA_CERTS');
    expect(CLAUDE_SDK_INHERITED_ENV).toContain('NODE_USE_SYSTEM_CA');
    // README §11.2 #52: PowerShell's process query hung on GitHub's runners without it.
    expect(CLAUDE_SDK_INHERITED_ENV).toContain('PSMODULEPATH');
    for (const name of CLAUDE_SDK_INHERITED_ENV) {
      expect(name).toBe(name.toUpperCase());
      expect(name).not.toMatch(/^(ANTHROPIC|CLAUDE)_|KEY|TOKEN|SECRET|PASSWORD|NODE_OPTIONS/);
    }
  });
});

describe('[PILAB-R2-THINK] claudeSdkModelThinking (how each model thinks, as the catalog says)', () => {
  const routes = {
    routes: {
      claude: {
        ...route('anthropic-messages', 'https://gw.example', 'AICLIENT_KEY_CLAUDE'),
        models: [
          { id: 'plain', reasoningEfforts: false },
          { id: 'budget', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' } },
          {
            id: 'adaptive',
            reasoningEfforts: { low: 'low', high: 'high' },
            compat: { forceAdaptiveThinking: true },
          },
        ],
      } as DshPlanRoute,
      vendor: {
        ...route('anthropic-messages', 'https://vendor.example', 'AICLIENT_KEY_VENDOR'),
        // The provider declares it once for every model under it.
        compat: { forceAdaptiveThinking: true },
        models: [
          { id: 'inherits', reasoningEfforts: { high: 'high' } },
          {
            id: 'opts-out',
            reasoningEfforts: { high: 'high' },
            compat: { forceAdaptiveThinking: false },
          },
        ],
      } as DshPlanRoute,
    },
  };

  it('none without reasoning, adaptive when forced, budget otherwise', () => {
    expect(claudeSdkModelThinking(routes, 'claude')).toEqual({
      plain: 'none',
      budget: 'budget',
      adaptive: 'adaptive',
    });
  });

  it("a model's own switch wins over its provider's", () => {
    expect(claudeSdkModelThinking(routes, 'vendor')).toEqual({
      inherits: 'adaptive',
      'opts-out': 'budget',
    });
    expect(claudeSdkModelThinking(null, 'claude')).toEqual({});
  });

  it('round-trips through the launch variable and drops anything malformed', () => {
    const styles = claudeSdkModelThinking(routes, 'claude');
    expect(parseClaudeSdkModelThinking(JSON.stringify(styles))).toEqual(styles);
    expect(parseClaudeSdkModelThinking('not json')).toEqual({});
    expect(parseClaudeSdkModelThinking(JSON.stringify({ a: 'fast', b: 1, '': 'none' }))).toEqual(
      {}
    );
  });
});
