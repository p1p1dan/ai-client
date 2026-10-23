import { describe, expect, it } from 'vitest';
import { isReviewRefusal } from '../autoReview/types.ts';

/** A review call's failure text: the service refusing the request, or the call failing. */
describe('isReviewRefusal', () => {
  it('knows the services’ refusals, as pi-ai words them', () => {
    for (const text of [
      "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs. To learn more, visit https://www.anthropic.com/legal/commercial-terms.",
      'The model refused to complete the request',
      'Provider stopped with: sensitive',
      'Provider finish_reason: content_filter',
      'Your request violates our usage policies.',
    ]) {
      expect(isReviewRefusal(text), text).toBe(true);
    }
  });

  it('leaves ordinary failures alone', () => {
    for (const text of [
      'HTTP 502',
      '429 rate limit exceeded',
      'fetch failed: ECONNRESET',
      'stream ended before the response completed',
      '401 invalid api key',
    ]) {
      expect(isReviewRefusal(text), text).toBe(false);
    }
  });
});
