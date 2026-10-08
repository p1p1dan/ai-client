import { describe, expect, it } from 'vitest';
import {
  CACHE_CONTROL_ON_TOOLS_SETTING_KEY,
  DEFAULT_CACHE_CONTROL_ON_TOOLS,
  describeCacheControlOnTools,
  resolveCacheControlOnTools,
} from '../types/cacheControlOnTools';

/**
 * GW-16 temporary switch (dsh-rebase decisions 149 rule 19, 159): the setting
 * key, its default and the mode line Main logs.
 */
describe('cache_control on tools setting', () => {
  it('is off by default under its own key', () => {
    expect(CACHE_CONTROL_ON_TOOLS_SETTING_KEY).toBe('experimentalCacheControlOnTools');
    expect(DEFAULT_CACHE_CONTROL_ON_TOOLS).toBe(false);
    expect(resolveCacheControlOnTools(undefined)).toBe(false);
  });

  it('takes a stored boolean and nothing else', () => {
    expect(resolveCacheControlOnTools(true)).toBe(true);
    expect(resolveCacheControlOnTools(false)).toBe(false);
    for (const value of ['true', 1, null, {}])
      expect(resolveCacheControlOnTools(value)).toBe(false);
  });

  it('states the mode and its breakpoint ceiling, nothing more', () => {
    expect(describeCacheControlOnTools(false)).toBe(
      'cache_control on tools: off (2 breakpoints max)'
    );
    expect(describeCacheControlOnTools(true)).toBe(
      'cache_control on tools: on (3 breakpoints max)'
    );
  });
});
