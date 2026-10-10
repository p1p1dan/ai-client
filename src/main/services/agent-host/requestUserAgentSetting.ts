/**
 * dsh-rebase decision 171 (GitHub issue #7): Main's read of the request
 * User-Agent setting, and the watch that makes a change reach the host before
 * the next turn.
 *
 * Renderer-owned and persisted like the prompt-cache TTL, so it comes through
 * `readSettingsState` (`promptCacheSettings.ts` explains the unwrap). Like the
 * GW-16 switch (decision 159), a change is not left for the next host start:
 * the watch rebuilds the model plan as soon as the renderer's save is queued
 * and the User-Agent it means is different; the new revision is announced, and
 * `WorkerManager.reconcileModelPlan` restarts the host once no session is
 * working, so the next turn sends the new value.
 */

import type { DshRouteSettingsInput } from '@shared/dshModelPlan';
import {
  isRequestUserAgentMode,
  REQUEST_USER_AGENT_CUSTOM_SETTING_KEY,
  REQUEST_USER_AGENT_MODE_SETTING_KEY,
  type ResolvedRequestUserAgent,
  resolveRequestUserAgent,
} from '@shared/types/requestUserAgent';
import { readSettingsState } from '../../ipc/settings';

export type RequestUserAgentSettings = Pick<
  DshRouteSettingsInput,
  'userAgentMode' | 'userAgentCustom'
>;

/**
 * The stored choice, as the plan takes it: a mode only when it is one of the
 * three, the custom text whenever it is text (the plan checks it and falls
 * back with a diagnostic, so a bad value is reported rather than dropped
 * here). Nothing for an install that never touched it.
 */
export function requestUserAgentSettings(
  read: () => Record<string, unknown> = readSettingsState
): RequestUserAgentSettings {
  const state = read();
  const mode = state[REQUEST_USER_AGENT_MODE_SETTING_KEY];
  const custom = state[REQUEST_USER_AGENT_CUSTOM_SETTING_KEY];
  return {
    ...(isRequestUserAgentMode(mode) ? { userAgentMode: mode } : {}),
    ...(typeof custom === 'string' ? { userAgentCustom: custom } : {}),
  };
}

/**
 * The User-Agent Main's own provider requests send (the model list, which is
 * also the connection test): the plan's value, or `undefined` in `engine`
 * mode, which keeps Electron's default — Main cannot know the one DSH builds.
 */
export function resolveMainRequestUserAgent(
  appVersion: string,
  read: () => Record<string, unknown> = readSettingsState
): ResolvedRequestUserAgent {
  const settings = requestUserAgentSettings(read);
  return resolveRequestUserAgent(
    { mode: settings.userAgentMode, custom: settings.userAgentCustom },
    appVersion
  );
}

export interface RequestUserAgentWatchDeps {
  /** Subscribes to every renderer settings save Main receives. */
  onSettingsWrite: (listener: () => void) => () => void;
  /** Rebuilds and announces the model plan (`resolveDshModelPlan`). */
  rebuild: () => void;
  /** The version the plan's default is built from (`app.getVersion()`). */
  appVersion: () => string;
  read?: () => Record<string, unknown>;
  log?: (...args: unknown[]) => void;
}

/**
 * Rebuilds the model plan when the User-Agent the settings mean changes. Every
 * other settings save is ignored, and so is a change that resolves to the same
 * value (a custom text kept while another mode is chosen, a bad custom value
 * that falls back to the default the plan already has).
 */
export function watchRequestUserAgent(deps: RequestUserAgentWatchDeps): () => void {
  const effective = () => resolveMainRequestUserAgent(deps.appVersion(), deps.read).userAgent;
  let last = effective();
  return deps.onSettingsWrite(() => {
    const now = effective();
    if (now === last) return;
    last = now;
    deps.log?.(
      `[dsh-plan] user agent changed to ${now === undefined ? 'the engine default' : now}; new plan`
    );
    try {
      deps.rebuild();
    } catch (error) {
      deps.log?.('[dsh-plan] the model plan could not be rebuilt after the change', error);
    }
  });
}
