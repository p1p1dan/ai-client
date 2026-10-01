/**
 * The Main-side read of the main conversation's prompt cache TTL.
 *
 * The property under test is the one that is easy to get wrong in both
 * directions: an untouched install must report ABSENCE (so the model plan
 * applies the shipped default), and a stored value that is not one of the two
 * accepted spellings must be treated as absence rather than passed through to
 * a provider that would silently resolve it to its own default.
 */

import { describe, expect, it } from 'vitest';
import { promptCacheTtlSettings } from '../promptCacheSettings';

function reader(values: Record<string, string>): (key: string) => string {
  return (key) => values[key] ?? '';
}

describe('prompt cache TTL settings', () => {
  it('reports nothing for an install that never chose', () => {
    expect(promptCacheTtlSettings(reader({}))).toEqual({});
  });

  it('reads either spelling', () => {
    expect(promptCacheTtlSettings(reader({ promptCacheTtl: '1h' }))).toEqual({
      promptCacheTtl: '1h',
    });
    expect(promptCacheTtlSettings(reader({ promptCacheTtl: '5m' }))).toEqual({
      promptCacheTtl: '5m',
    });
  });

  /** dsh-rebase P1-12 step 1: the delegate's TTL has no reader any more. */
  it('ignores the retired delegate TTL', () => {
    expect(promptCacheTtlSettings(reader({ subagentPromptCacheTtl: '1h' }))).toEqual({});
    expect(
      promptCacheTtlSettings(reader({ promptCacheTtl: '5m', subagentPromptCacheTtl: '1h' }))
    ).toEqual({ promptCacheTtl: '5m' });
  });

  it('drops a value that is not one of the two spellings', () => {
    expect(promptCacheTtlSettings(reader({ promptCacheTtl: '1 hour' }))).toEqual({});
  });
});
