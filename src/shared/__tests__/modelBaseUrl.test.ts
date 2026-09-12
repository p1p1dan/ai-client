import {
  deriveInheritedBaseUrl,
  derivesBaseUrl,
  serviceRoot,
  stripRedundantVersion,
} from '@shared/modelBaseUrl';
import { PROVIDER_PRESETS } from '@shared/userProviders';
import { describe, expect, it } from 'vitest';

/**
 * ARD D15. The gateway splits its endpoints by model family and answers a
 * wrong address with 503, not 404, so these are the assertions standing
 * between a mis-derived suffix and a failure that reads like an outage.
 */
describe('deriveInheritedBaseUrl', () => {
  const gateway = 'https://cch-jyw.pipidan.qzz.io/v1';

  it('drops the version segment for anthropic, whose SDK appends /v1/messages', () => {
    expect(deriveInheritedBaseUrl(gateway, 'anthropic-messages')).toBe(
      'https://cch-jyw.pipidan.qzz.io'
    );
  });

  it('keeps the version segment for the OpenAI shapes', () => {
    expect(deriveInheritedBaseUrl(gateway, 'openai-responses')).toBe(gateway);
    expect(deriveInheritedBaseUrl(gateway, 'openai-completions')).toBe(gateway);
  });

  it('adds the version segment when the inherited address has none', () => {
    expect(deriveInheritedBaseUrl('https://cch-jyw.pipidan.qzz.io', 'openai-completions')).toBe(
      gateway
    );
  });

  it('is idempotent, so a re-sync cannot walk the suffix', () => {
    for (const api of ['anthropic-messages', 'openai-responses', 'openai-completions']) {
      const once = deriveInheritedBaseUrl(gateway, api);
      expect(deriveInheritedBaseUrl(once, api)).toBe(once);
    }
  });

  it('leaves a protocol we have no evidence for exactly as inherited', () => {
    for (const api of [
      'google-generative-ai',
      'google-vertex',
      'bedrock-converse-stream',
      'mistral-conversations',
      'openai-codex-responses',
      'azure-openai-responses',
      'pi-messages',
    ]) {
      expect(derivesBaseUrl(api)).toBe(false);
      expect(deriveInheritedBaseUrl(gateway, api)).toBe(gateway);
    }
  });

  it('keeps an empty address empty rather than inventing a relative /v1', () => {
    expect(deriveInheritedBaseUrl('', 'openai-completions')).toBe('');
    expect(deriveInheritedBaseUrl('   ', 'anthropic-messages')).toBe('');
  });

  it('only strips the tail, not a /v1 inside the path', () => {
    expect(serviceRoot('https://gw.example/v1/tenant')).toBe('https://gw.example/v1/tenant');
    expect(serviceRoot('https://gw.example/api/v1/')).toBe('https://gw.example/api');
  });
});

describe('stripRedundantVersion', () => {
  it('corrects an Anthropic address that states a version the SDK adds itself', () => {
    expect(stripRedundantVersion('https://api.anthropic.com/v1', 'anthropic-messages')).toBe(
      'https://api.anthropic.com'
    );
  });

  it('never appends, because a typed OpenAI-shaped base may legitimately have no /v1', () => {
    // pi-ai's own table ships deepseek without one and z.ai with `/paas/v4`.
    expect(stripRedundantVersion('https://api.deepseek.com', 'openai-completions')).toBe(
      'https://api.deepseek.com'
    );
    expect(stripRedundantVersion('https://api.z.ai/api/coding/paas/v4', 'openai-completions')).toBe(
      'https://api.z.ai/api/coding/paas/v4'
    );
  });
});

describe('PROVIDER_PRESETS', () => {
  it('ships no anthropic preset carrying a version segment', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.api !== 'anthropic-messages') continue;
      expect(preset.baseUrl).toBe(stripRedundantVersion(preset.baseUrl, preset.api));
    }
  });
});
