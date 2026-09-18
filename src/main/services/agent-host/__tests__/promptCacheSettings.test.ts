/**
 * The Main-side read of the two prompt cache TTLs.
 *
 * Lives on the Main side for the same reason `nativeSubagentSettings.test.ts`
 * does: `src/runtime` is its own npm package and a test there importing this
 * file would drag `src/main` into the runtime type-check gate.
 *
 * The property under test is the one that is easy to get wrong in both
 * directions: an untouched install must report ABSENCE (so the bootstrap
 * payload stays identical to a pre-TTL build's and the worker applies the
 * shipped defaults), and a stored value that is not one of the two accepted
 * spellings must be treated as absence rather than passed through to a provider
 * that would silently resolve it to its own default.
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

  it('reads each value independently', () => {
    expect(
      promptCacheTtlSettings(reader({ promptCacheTtl: '1h', subagentPromptCacheTtl: '5m' }))
    ).toEqual({ promptCacheTtl: '1h', subagentPromptCacheTtl: '5m' });
    expect(
      promptCacheTtlSettings(reader({ promptCacheTtl: '5m', subagentPromptCacheTtl: '1h' }))
    ).toEqual({ promptCacheTtl: '5m', subagentPromptCacheTtl: '1h' });
  });

  it('keeps a valid value when its sibling is missing', () => {
    expect(promptCacheTtlSettings(reader({ subagentPromptCacheTtl: '1h' }))).toEqual({
      subagentPromptCacheTtl: '1h',
    });
  });

  it('drops a value that is not one of the two spellings', () => {
    expect(
      promptCacheTtlSettings(reader({ promptCacheTtl: '1 hour', subagentPromptCacheTtl: 'long' }))
    ).toEqual({});
  });
});
