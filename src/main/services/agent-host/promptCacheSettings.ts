/**
 * The main conversation's prompt-cache TTL, read off the settings page's own
 * store for the DSH model plan (decision 040).
 *
 * A renderer-owned setting, so it lives one level down in the persist wrapper
 * and has to come through `readStringSetting` — the same unwrap
 * `defaultTemporaryPath` needs, and the same trap: read off the settings
 * FILE's top level it is `undefined` on every machine.
 *
 * A value the user never touched is reported as ABSENT rather than as the
 * default; the default is applied once, where the plan is built.
 *
 * dsh-rebase P1-12 step 1 (decision 123 rule 14): the delegate's TTL is no
 * longer read. Nothing consumed it once the native worker went.
 */

import {
  isPromptCacheTtl,
  PROMPT_CACHE_TTL_SETTING_KEY,
  type PromptCacheTtl,
} from '@shared/types/promptCacheTtl';
import { readStringSetting } from '../../ipc/settings';

export interface PromptCacheTtlSettings {
  promptCacheTtl?: PromptCacheTtl;
}

export function promptCacheTtlSettings(
  read: (key: string) => string = readStringSetting
): PromptCacheTtlSettings {
  const main = read(PROMPT_CACHE_TTL_SETTING_KEY);
  return isPromptCacheTtl(main) ? { promptCacheTtl: main } : {};
}
