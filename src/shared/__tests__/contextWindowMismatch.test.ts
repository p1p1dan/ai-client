import { describe, expect, it } from 'vitest';
import {
  CONTEXT_WINDOW_NOTICE_KEY,
  contextWindowNotice,
  serviceContextLimit,
} from '../contextWindowMismatch';
import { zhTranslations } from '../i18n';

describe('serviceContextLimit (user 2026-10-18)', () => {
  it.each([
    [
      'Anthropic',
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 213462 tokens > 200000 maximum"}}',
      { limit: 200_000, requested: 213_462 },
    ],
    [
      'the Agent SDK CLI',
      'Prompt is too long — the request is ~250000 tokens (limit 200000) but this conversation is only ~2553 tokens',
      { limit: 200_000, requested: 250_000 },
    ],
    [
      'Anthropic, input plus max_tokens',
      'input length and `max_tokens` exceed context limit: 180000 + 64000 > 200000, decrease input length or `max_tokens` and try again',
      { limit: 200_000 },
    ],
    [
      'OpenAI',
      "This model's maximum context length is 272,000 tokens. However, your messages resulted in 300,512 tokens.",
      { limit: 272_000, requested: 300_512 },
    ],
    [
      'an OpenAI-compatible proxy',
      "Input length (265330) exceeds model's maximum context length (262144).",
      { limit: 262_144, requested: 265_330 },
    ],
    [
      'LiteLLM',
      "Requested token count exceeds the model's maximum context length of 131072 tokens",
      { limit: 131_072 },
    ],
    [
      'Google',
      'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)',
      { limit: 1_048_575, requested: 1_196_265 },
    ],
    [
      'xAI',
      "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
      { limit: 131_072, requested: 537_812 },
    ],
    [
      'Together AI',
      "The input (300000 tokens) is longer than the model's context length (262144 tokens).",
      { limit: 262_144, requested: 300_000 },
    ],
    ['DashScope', 'Range of input length should be [1, 129024]', { limit: 129_024 }],
  ])('reads %s', (_service, text, expected) => {
    expect(serviceContextLimit(text)).toEqual(expected);
  });

  it('reads nothing from a refusal without a number, or from other failures', () => {
    expect(
      serviceContextLimit('Your input exceeds the context window of this model')
    ).toBeUndefined();
    expect(serviceContextLimit('429 rate limit exceeded')).toBeUndefined();
    expect(serviceContextLimit('')).toBeUndefined();
    // A "limit" too small to be a window.
    expect(serviceContextLimit('prompt is too long: 900 tokens > 512 maximum')).toBeUndefined();
  });
});

describe('contextWindowNotice', () => {
  const refusal = 'prompt is too long: 213462 tokens > 200000 maximum';

  it('asks for the window to be corrected when the service takes less than the setting', () => {
    const notice = contextWindowNotice({
      errorText: refusal,
      configured: 1_000_000,
      model: 'claude/claude-opus-5-5',
    });
    expect(notice).toEqual({
      key: CONTEXT_WINDOW_NOTICE_KEY,
      params: { model: 'claude-opus-5-5', limit: '200,000', configured: '1,000,000' },
      text: 'The service accepts at most 200,000 tokens for claude-opus-5-5, less than the 1,000,000 it is set to. Ask your administrator to correct this model’s context window, or fix it in the service settings if you added the service yourself.',
      limit: 200_000,
      configured: 1_000_000,
    });
  });

  it('says nothing for a model set to what the service takes, or with no setting known', () => {
    expect(
      contextWindowNotice({ errorText: refusal, configured: 200_000, model: 'm' })
    ).toBeUndefined();
    expect(
      contextWindowNotice({ errorText: refusal, configured: 150_000, model: 'm' })
    ).toBeUndefined();
    expect(
      contextWindowNotice({ errorText: refusal, configured: undefined, model: 'm' })
    ).toBeUndefined();
    expect(
      contextWindowNotice({
        errorText: 'exceeds the context window',
        configured: 1_000_000,
        model: 'm',
      })
    ).toBeUndefined();
  });

  it('has a Chinese translation with the same placeholders', () => {
    const zh = zhTranslations[CONTEXT_WINDOW_NOTICE_KEY];
    expect(zh).toBeDefined();
    for (const name of ['{{model}}', '{{limit}}', '{{configured}}']) expect(zh).toContain(name);
  });
});
