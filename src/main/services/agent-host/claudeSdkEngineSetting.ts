/**
 * Route B, S-1 (decision 1): Main's read of the renderer-owned switch "Claude
 * models use the official Agent SDK" (`claudeSdkEngineEnabled`, on by default).
 *
 * Read when a chat is created, so no watch: a flip only affects chats created
 * after it, and every existing chat keeps the engine it was created on.
 * Renderer-owned and persisted like the other model request settings, so it
 * comes through `readSettingsState` (`promptCacheSettings.ts` explains the unwrap).
 * A developer-mode setting: with developer mode off it reads as the default
 * (`@shared/developerMode`).
 */

import {
  CLAUDE_SDK_AUTO_COMPACT_PERCENT_SETTING_KEY,
  CLAUDE_SDK_DROP_EMPTY_SYSTEM_SETTING_KEY,
  CLAUDE_SDK_ENGINE_SETTING_KEY,
  resolveClaudeSdkAutoCompactPercent,
  resolveClaudeSdkDropEmptySystem,
  resolveClaudeSdkEngineEnabled,
} from '@shared/claudeSdkEngine';
import { applyDeveloperModeGate } from '@shared/developerMode';
import { readSettingsState } from '../../ipc/settings';

/** The switch as stored, or the default for an install that never touched it or out of developer mode. */
export function claudeSdkEngineEnabled(
  read: () => Record<string, unknown> = readSettingsState
): boolean {
  return resolveClaudeSdkEngineEnabled(
    applyDeveloperModeGate(read())[CLAUDE_SDK_ENGINE_SETTING_KEY]
  );
}

/**
 * User 2026-10-23: where an SDK chat compacts, in percent of its window. Read
 * when a chat's host starts, so a change reaches the next host that starts.
 * A developer-mode setting, like the switch above.
 */
export function claudeSdkAutoCompactPercent(
  read: () => Record<string, unknown> = readSettingsState
): number {
  return resolveClaudeSdkAutoCompactPercent(
    applyDeveloperModeGate(read())[CLAUDE_SDK_AUTO_COMPACT_PERCENT_SETTING_KEY]
  );
}

/** User 2026-10-23: whether the host drops empty `system` messages; read when a chat's host starts. */
export function claudeSdkDropEmptySystem(
  read: () => Record<string, unknown> = readSettingsState
): boolean {
  return resolveClaudeSdkDropEmptySystem(
    applyDeveloperModeGate(read())[CLAUDE_SDK_DROP_EMPTY_SYSTEM_SETTING_KEY]
  );
}
