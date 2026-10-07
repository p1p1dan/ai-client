import { describe, expect, it } from 'vitest';
import { DSH_PROTOCOLS } from '../dshModelPlan/tables';
import {
  isSupportedUserProviderApi,
  isUserProviderApi,
  PROVIDER_PRESETS,
  SUPPORTED_USER_PROVIDER_APIS,
  USER_PROVIDER_APIS,
} from '../userProviders';

/**
 * P1-5d (decision 036 rule 2, decision 148) — the settings page must narrow
 * to the same three protocols the model menu's "N models unavailable" footer
 * already filters by (`dshModelPlan/build.ts`'s `isProtocol`, checked against
 * this same `DSH_PROTOCOLS` table). A copy of "three" living in two places
 * would drift the moment DSH's own route table changes; a shared reference
 * cannot.
 */
describe('SUPPORTED_USER_PROVIDER_APIS', () => {
  it('is the exact same table dshModelPlan/build.ts checks, not a copy of it', () => {
    expect(SUPPORTED_USER_PROVIDER_APIS).toBe(DSH_PROTOCOLS);
  });

  it('is openai-completions, openai-responses and anthropic-messages, in that order', () => {
    expect(SUPPORTED_USER_PROVIDER_APIS).toEqual([
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
    ]);
  });

  it('is a subset of USER_PROVIDER_APIS — storage keeps accepting all ten', () => {
    for (const api of SUPPORTED_USER_PROVIDER_APIS) {
      expect(USER_PROVIDER_APIS).toContain(api);
    }
    // The other seven round-trip through storage unharmed; narrowing is a UI
    // concern, not a change to what `isUserProviderApi` accepts.
    for (const api of USER_PROVIDER_APIS) {
      expect(isUserProviderApi(api)).toBe(true);
    }
  });
});

describe('isSupportedUserProviderApi', () => {
  it('accepts the three the DSH route speaks', () => {
    expect(isSupportedUserProviderApi('openai-completions')).toBe(true);
    expect(isSupportedUserProviderApi('openai-responses')).toBe(true);
    expect(isSupportedUserProviderApi('anthropic-messages')).toBe(true);
  });

  it('rejects the seven DSH cannot route (decision 036)', () => {
    const unsupported = USER_PROVIDER_APIS.filter((api) => !isSupportedUserProviderApi(api));
    expect(unsupported).toEqual([
      'openai-codex-responses',
      'azure-openai-responses',
      'google-generative-ai',
      'google-vertex',
      'bedrock-converse-stream',
      'mistral-conversations',
      'pi-messages',
    ]);
  });
});

/**
 * The preset list a new service's "Service" picker offers is filtered by the
 * dialog, not by this module — see `ProviderSetupDialog.tsx`'s
 * `SELECTABLE_PRESETS`. What belongs here is the fact the filter relies on:
 * exactly the Google and Mistral entries use an API style DSH cannot route.
 */
describe('PROVIDER_PRESETS vs the DSH-supported protocols', () => {
  it('has exactly two presets (google, mistral) outside the three DSH speaks', () => {
    const unsupported = PROVIDER_PRESETS.filter(
      (preset) => !isSupportedUserProviderApi(preset.api)
    );
    expect(unsupported.map((preset) => preset.id)).toEqual(['google', 'mistral']);
  });
});
