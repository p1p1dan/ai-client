import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DshModelPlan } from '../../../shared/dshModelPlan/types.ts';
import {
  DSH_CONFIGURE_TIMEOUT_MS,
  DSH_CREDENTIAL_TIMEOUT_MS,
  isDshHostConfigure,
} from '../../../shared/types/dshHostProtocol.ts';
import { CREDENTIAL_TIMEOUT_MS } from '../credentialRelay.ts';
import {
  CONFIGURE_TIMEOUT_MS,
  emptyHostModelPlan,
  isConfigureMessage,
  llmPiAiProviders,
  modelPlanOverlays,
  publicModelPlan,
  readConfigure,
  routeDiagnostics,
} from '../hostModelPlan.ts';

/**
 * dsh-rebase P1-5a (decision 033) — what host.ts does with Main's `configure`:
 * validate it, inject the two overlays (every model sized, decision 077 rule
 * 2), keep the nonce to itself, and report the routes DSH did not take.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
/** The P1-5a golden: the shipped catalog snapshot, translated. */
const GOLDEN = JSON.parse(
  readFileSync(
    join(REPO, 'src/main/services/piModelConfig/__tests__/fixtures/dshModelPlan.snapshot.json'),
    'utf8'
  )
) as DshModelPlan;

const configureOf = (plan: DshModelPlan, extra: Record<string, unknown> = {}) => ({
  host: 'configure',
  nonce: 'nonce-1',
  revision: plan.revision,
  routes: plan.routes,
  defaultModel: plan.defaultModel,
  index: plan.index,
  refs: plan.refs,
  ...extra,
});

describe('readConfigure', () => {
  it('accepts what the protocol guard accepts, and keeps the nonce', () => {
    const message = configureOf(GOLDEN);
    expect(isDshHostConfigure(message)).toBe(true);
    const read = readConfigure(message);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.plan.nonce).toBe('nonce-1');
      expect(read.plan.revision).toBe(GOLDEN.revision);
      expect(Object.keys(read.plan.routes)).toEqual(['claude', 'gpt', 'grok', 'china']);
    }
  });

  it('refuses a message without a nonce, revision, refs or a default on its routes', () => {
    for (const [extra, reason] of [
      [{ nonce: '' }, 'no nonce'],
      [{ revision: undefined }, 'no revision'],
      [{ refs: { A: 7 } }, 'malformed refs'],
      [{ defaultModel: { provider: 'nowhere', model: 'x' } }, 'the default model names no route'],
      [{ routes: { claude: { api: 'anthropic-messages' } } }, 'has no model list'],
    ] as const) {
      const read = readConfigure(configureOf(GOLDEN, extra));
      expect(read.ok, reason).toBe(false);
      if (!read.ok) expect(read.reason).toContain(reason);
    }
  });

  it('accepts an empty plan with its placeholder default', () => {
    const empty = emptyHostModelPlan();
    expect(readConfigure({ ...empty, host: 'configure', nonce: 'n' }).ok).toBe(true);
    expect(isConfigureMessage({ host: 'configure' })).toBe(true);
    expect(isConfigureMessage({ host: 'ping' })).toBe(false);
  });
});

describe('modelPlanOverlays (decision 033; decision 077 rule 2)', () => {
  it('replaces llm-pi-ai and agent-default-model, and nothing else', () => {
    const overlays = modelPlanOverlays(GOLDEN);
    expect(overlays.map((overlay) => overlay.id)).toEqual(['llm-pi-ai', 'agent-default-model']);
    expect(overlays[1]?.config).toEqual(GOLDEN.defaultModel);
    expect(Object.keys((overlays[0]?.config as { providers: object }).providers)).toEqual(
      Object.keys(GOLDEN.routes)
    );
  });

  it('sizes every model: its own values, else the route defaults and text input', () => {
    const plan = {
      routes: {
        openai: {
          ...GOLDEN.routes.gpt,
          models: [
            { id: 'bare', reasoningEfforts: false as const },
            {
              id: 'sized',
              contextWindow: 5,
              maxTokens: 6,
              input: ['text', 'image'] as Array<'text' | 'image'>,
              reasoningEfforts: false as const,
            },
          ],
        },
      },
    } as unknown as DshModelPlan;
    const [bare, sized] = llmPiAiProviders(plan).openai?.models ?? [];
    expect(bare).toMatchObject({ contextWindow: 128_000, maxTokens: 8192, input: ['text'] });
    expect(sized).toMatchObject({ contextWindow: 5, maxTokens: 6, input: ['text', 'image'] });
    // The plan itself is left as Main sent it.
    expect(plan.routes.openai?.models[0]).not.toHaveProperty('contextWindow');
  });

  it('holds no key and no nonce: only reference names', () => {
    const text = JSON.stringify(modelPlanOverlays(GOLDEN));
    expect(text).not.toContain('nonce');
    for (const route of Object.values(GOLDEN.routes)) expect(text).toContain(route.apiKeyEnv);
  });
});

describe('publicModelPlan', () => {
  it('drops the nonce and keeps the rest', () => {
    const read = readConfigure(configureOf(GOLDEN));
    if (!read.ok) throw new Error(read.reason);
    const shown = publicModelPlan(read.plan);
    expect(shown).not.toHaveProperty('nonce');
    expect(shown.index).toEqual(GOLDEN.index);
  });
});

describe('routeDiagnostics (the drift gate)', () => {
  it('is empty when every route is registered without an error', () => {
    const directory = [
      ...Object.keys(GOLDEN.routes).map((provider) => ({ provider })),
      { provider: 'openai', error: 'a catalog route this plan does not use' },
    ];
    expect(routeDiagnostics(GOLDEN, directory)).toEqual([]);
  });

  it('names a route never registered, and a route registered with an error', () => {
    expect(
      routeDiagnostics(GOLDEN, [
        { provider: 'claude' },
        { provider: 'gpt', error: 'compat key not offered' },
        { provider: 'grok', error: '' },
      ])
    ).toEqual([
      { provider: 'gpt', error: 'compat key not offered' },
      { provider: 'china', error: 'not registered by llm-pi-ai' },
    ]);
    expect(routeDiagnostics(GOLDEN, undefined)).toHaveLength(4);
  });
});

describe('restated protocol constants', () => {
  it('match src/shared/types/dshHostProtocol.ts', () => {
    expect(CONFIGURE_TIMEOUT_MS).toBe(DSH_CONFIGURE_TIMEOUT_MS);
    expect(CREDENTIAL_TIMEOUT_MS).toBe(DSH_CREDENTIAL_TIMEOUT_MS);
  });
});
