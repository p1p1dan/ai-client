/**
 * The two prompt-cache TTLs, read off the settings page's own store.
 *
 * Both are renderer-owned settings, so they live one level down in the persist
 * wrapper and have to come through `readStringSetting` — the same unwrap
 * `defaultTemporaryPath` needs, and the same trap: read off the settings FILE's
 * top level they are `undefined` on every machine.
 *
 * A value the user never touched is reported as ABSENT rather than as the
 * default. Absent is what keeps the bootstrap payload byte-identical to a
 * pre-TTL build's, which is what `sameBootstrap` compares; the defaults are
 * applied once, in the worker, where the runtime is actually built.
 */

import {
  isPromptCacheTtl,
  PROMPT_CACHE_TTL_SETTING_KEY,
  type PromptCacheTtl,
  SUBAGENT_PROMPT_CACHE_TTL_SETTING_KEY,
} from '@shared/types/promptCacheTtl';
import { readStringSetting } from '../../ipc/settings';

export interface PromptCacheTtlSettings {
  promptCacheTtl?: PromptCacheTtl;
  subagentPromptCacheTtl?: PromptCacheTtl;
}

export function promptCacheTtlSettings(
  read: (key: string) => string = readStringSetting
): PromptCacheTtlSettings {
  const main = read(PROMPT_CACHE_TTL_SETTING_KEY);
  const subagent = read(SUBAGENT_PROMPT_CACHE_TTL_SETTING_KEY);
  return {
    ...(isPromptCacheTtl(main) ? { promptCacheTtl: main } : {}),
    ...(isPromptCacheTtl(subagent) ? { subagentPromptCacheTtl: subagent } : {}),
  };
}
