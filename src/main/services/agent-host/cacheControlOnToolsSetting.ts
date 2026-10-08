/**
 * GW-16 temporary switch (dsh-rebase decisions 149 rule 19, 159): Main's read
 * of "Cache breakpoint on tool definitions", and the watch that makes a
 * change reach the host before the next turn.
 *
 * Renderer-owned and persisted like the prompt-cache TTL, so it comes through
 * `readSettingsState` (`promptCacheSettings.ts` explains the unwrap). Unlike
 * the TTL, a change is not left for the next host start: the watch rebuilds
 * the model plan as soon as the renderer's save is queued, the new revision is
 * announced, and `WorkerManager.reconcileModelPlan` restarts the host once no
 * session is working, so the next turn runs on the new plan.
 *
 * Remove this file with the switch (decision 159 lists the rest).
 */

import {
  CACHE_CONTROL_ON_TOOLS_SETTING_KEY,
  resolveCacheControlOnTools,
} from '@shared/types/cacheControlOnTools';
import { readSettingsState } from '../../ipc/settings';

export interface CacheControlOnToolsSettings {
  cacheControlOnTools?: boolean;
}

/** The stored choice, or nothing for an install that never touched it. */
export function cacheControlOnToolsSettings(
  read: () => Record<string, unknown> = readSettingsState
): CacheControlOnToolsSettings {
  const raw = read()[CACHE_CONTROL_ON_TOOLS_SETTING_KEY];
  return typeof raw === 'boolean' ? { cacheControlOnTools: raw } : {};
}

export interface CacheControlOnToolsWatchDeps {
  /** Subscribes to every renderer settings save Main receives. */
  onSettingsWrite: (listener: () => void) => () => void;
  /** Rebuilds and announces the model plan (`resolveDshModelPlan`). */
  rebuild: () => void;
  read?: () => Record<string, unknown>;
  log?: (...args: unknown[]) => void;
}

/**
 * Rebuilds the model plan when the switch flips. Every other settings save
 * (the renderer writes the whole store on any change) is ignored.
 */
export function watchCacheControlOnTools(deps: CacheControlOnToolsWatchDeps): () => void {
  const effective = () =>
    resolveCacheControlOnTools(cacheControlOnToolsSettings(deps.read).cacheControlOnTools);
  let last = effective();
  return deps.onSettingsWrite(() => {
    const now = effective();
    if (now === last) return;
    last = now;
    deps.log?.(`[dsh-plan] cache_control on tools switched ${now ? 'on' : 'off'}; new plan`);
    try {
      deps.rebuild();
    } catch (error) {
      deps.log?.('[dsh-plan] the model plan could not be rebuilt after the switch', error);
    }
  });
}
